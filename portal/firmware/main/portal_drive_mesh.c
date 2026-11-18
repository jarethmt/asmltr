/* asmltr Portal — mesh drive agent. See portal_drive_mesh.h.
 *
 * Two small tasks, both gated on the tunnel being up (esp_olm_is_connected):
 *   - exec poll: long-poll GET <base>/v2/portal/<id>/exec/next?wait=20, base64-decode the command,
 *     hand it to engine_submit_exec() (the exact path the BLE `exec` char uses).
 *   - io pump:   drain the host's CDC return bytes (fed via portal_drive_mesh_ioback) and POST them
 *     base64 to <base>/v2/portal/<id>/io every ~250 ms when non-empty.
 * Plain HTTP — the overlay is already encrypted by WireGuard. SPDX: BSD-3-Clause
 */
#include "portal_drive_mesh.h"
#include "engine.h"
#include "esp_olm.h"

#include <string.h>
#include <stdlib.h>
#include "esp_log.h"
#include "esp_http_client.h"
#include "esp_heap_caps.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/idf_additions.h"
#include "freertos/stream_buffer.h"
#include "mbedtls/base64.h"
#include "cJSON.h"

static const char *TAG = "portal_drive";

static char s_base[160];
static char s_id[48];
static char s_token[128];   /* Bearer for the drive-only endpoint */
static bool s_started = false;
static volatile bool s_route_mesh = false;  /* true = last exec came over mesh → route ioback to the POST */
static StreamBufferHandle_t s_io_stream = NULL;   /* host CDC-return bytes awaiting POST */
#define IO_STREAM_SZ 8192

/* --- tiny HTTP response accumulator ---------------------------------------- */
typedef struct { char *buf; int len; int cap; } resp_t;

static esp_err_t on_http_event(esp_http_client_event_t *evt)
{
    if (evt->event_id == HTTP_EVENT_ON_DATA && evt->user_data && evt->data_len > 0) {
        resp_t *r = (resp_t *)evt->user_data;
        if (r->len + evt->data_len + 1 > r->cap) {
            int ncap = (r->cap ? r->cap : 512);
            while (r->len + evt->data_len + 1 > ncap) ncap *= 2;
            char *n = realloc(r->buf, ncap);
            if (!n) return ESP_FAIL;
            r->buf = n; r->cap = ncap;
        }
        memcpy(r->buf + r->len, evt->data, evt->data_len);
        r->len += evt->data_len;
        r->buf[r->len] = '\0';
    }
    return ESP_OK;
}

/* GET url, returning a malloc'd NUL-terminated body (caller frees) or NULL. timeout_ms covers the
 * server-side long-poll. */
static char *http_get(const char *url, int timeout_ms)
{
    resp_t r = {0};
    esp_http_client_config_t cfg = {
        .url = url, .method = HTTP_METHOD_GET, .timeout_ms = timeout_ms,
        .event_handler = on_http_event, .user_data = &r,
    };
    esp_http_client_handle_t c = esp_http_client_init(&cfg);
    if (!c) { free(r.buf); return NULL; }
    if (s_token[0]) { char a[160]; snprintf(a, sizeof a, "Bearer %s", s_token); esp_http_client_set_header(c, "Authorization", a); }
    esp_err_t e = esp_http_client_perform(c);
    int status = esp_http_client_get_status_code(c);
    esp_http_client_cleanup(c);
    if (e != ESP_OK) {          /* no HTTP response at all → almost always a missing overlay ROUTE */
        ESP_LOGW(TAG, "GET: no response (%s) — check the WG route to the drive host", esp_err_to_name(e));
        free(r.buf); return NULL;
    }
    if (status != 200) {        /* reached the listener but it refused → auth/path problem */
        ESP_LOGW(TAG, "GET: HTTP %d (reached listener; check drive token/path)", status);
        free(r.buf); return NULL;
    }
    return r.buf;   /* may be NULL if empty body */
}

/* POST a JSON body to url. Returns true on 2xx. */
static bool http_post_json(const char *url, const char *body, int timeout_ms)
{
    esp_http_client_config_t cfg = { .url = url, .method = HTTP_METHOD_POST, .timeout_ms = timeout_ms };
    esp_http_client_handle_t c = esp_http_client_init(&cfg);
    if (!c) return false;
    esp_http_client_set_header(c, "Content-Type", "application/json");
    if (s_token[0]) { char a[160]; snprintf(a, sizeof a, "Bearer %s", s_token); esp_http_client_set_header(c, "Authorization", a); }
    esp_http_client_set_post_field(c, body, strlen(body));
    esp_err_t e = esp_http_client_perform(c);
    int status = esp_http_client_get_status_code(c);
    esp_http_client_cleanup(c);
    return e == ESP_OK && status >= 200 && status < 300;
}

/* --- exec poll task -------------------------------------------------------- */
static void exec_task(void *arg)
{
    (void)arg;
    char url[256];
    snprintf(url, sizeof url, "%s/v2/portal/%s/exec/next?wait=20", s_base, s_id);
    ESP_LOGI(TAG, "drive agent polling %s", url);
    int polls = 0, waited_mesh = 0;
    for (;;) {
        if (!esp_olm_is_connected()) {
            if (waited_mesh % 20 == 0) ESP_LOGI(TAG, "drive agent idle: waiting for mesh tunnel");
            waited_mesh++;
            vTaskDelay(pdMS_TO_TICKS(500)); continue;
        }
        waited_mesh = 0;
        if (polls % 10 == 0) ESP_LOGI(TAG, "drive agent alive: poll #%d -> %s", polls, s_base);
        polls++;
        char *body = http_get(url, 25000);               /* long-poll; ~20 s server hold */
        if (!body) { vTaskDelay(pdMS_TO_TICKS(1000)); continue; }   /* error/backoff */
        cJSON *root = cJSON_Parse(body);
        free(body);
        if (!root) { vTaskDelay(pdMS_TO_TICKS(200)); continue; }
        const cJSON *mode = cJSON_GetObjectItemCaseSensitive(root, "mode");
        const cJSON *data = cJSON_GetObjectItemCaseSensitive(root, "data");
        if (cJSON_IsString(data) && data->valuestring && data->valuestring[0]) {
            /* data is base64 of the raw payload (keystroke script for HID, bytes for CDC) */
            size_t b64n = strlen(data->valuestring);
            size_t need = (b64n / 4 + 1) * 3 + 1;
            uint8_t *out = malloc(need);
            if (out) {
                size_t olen = 0;
                if (mbedtls_base64_decode(out, need, &olen,
                        (const uint8_t *)data->valuestring, b64n) == 0 && olen > 0) {
                    uint8_t m = (cJSON_IsString(mode) && mode->valuestring &&
                                 strcmp(mode->valuestring, "cdc") == 0) ? 2 : 1;
                    ESP_LOGI(TAG, "exec over mesh: mode=%s len=%u",
                             m == 2 ? "cdc" : "hid", (unsigned)olen);
                    s_route_mesh = true;   /* host return for THIS command belongs to the mesh POST */
                    engine_submit_exec(m, out, (int)olen);
                }
                free(out);
            }
        }
        cJSON_Delete(root);
        /* loop straight back into the next long-poll */
    }
}

/* --- io pump task ---------------------------------------------------------- */
static void io_task(void *arg)
{
    (void)arg;
    char url[256];
    snprintf(url, sizeof url, "%s/v2/portal/%s/io", s_base, s_id);
    uint8_t raw[1024];
    for (;;) {
        if (!esp_olm_is_connected() || !s_io_stream) { vTaskDelay(pdMS_TO_TICKS(250)); continue; }
        size_t n = xStreamBufferReceive(s_io_stream, raw, sizeof raw, pdMS_TO_TICKS(250));
        if (n == 0) continue;
        size_t b64cap = (n / 3 + 1) * 4 + 8;
        char *b64 = malloc(b64cap);
        if (!b64) continue;
        size_t b64len = 0;
        if (mbedtls_base64_encode((uint8_t *)b64, b64cap, &b64len, raw, n) != 0) { free(b64); continue; }
        b64[b64len] = '\0';
        /* {"data":"<b64>"} */
        size_t jcap = b64len + 16;
        char *json = malloc(jcap);
        if (json) {
            snprintf(json, jcap, "{\"data\":\"%s\"}", b64);
            http_post_json(url, json, 8000);
            free(json);
        }
        free(b64);
    }
}

/* --- public ---------------------------------------------------------------- */
void portal_drive_mesh_start(const char *base_url, const char *id, const char *token)
{
    if (s_started) { ESP_LOGI(TAG, "mesh drive agent already running (base=%s id=%s)", s_base, s_id); return; }
    if (!base_url || !base_url[0] || !id || !id[0]) {
        ESP_LOGW(TAG, "mesh drive NOT provisioned (drive_url='%s' drive_id='%s') — agent idle; reprovision with the drive fields",
                 base_url ? base_url : "", id ? id : "");
        return;
    }
    strlcpy(s_base, base_url, sizeof s_base);
    /* strip a trailing slash so the path joins cleanly */
    size_t bl = strlen(s_base);
    while (bl && s_base[bl - 1] == '/') s_base[--bl] = '\0';
    strlcpy(s_id, id, sizeof s_id);
    strlcpy(s_token, token ? token : "", sizeof s_token);
    s_io_stream = xStreamBufferCreate(IO_STREAM_SZ, 1);
    s_started = true;
    ESP_LOGI(TAG, "mesh drive agent: base=%s id=%s", s_base, s_id);

    /* PSRAM-backed stacks: esp_http_client + cJSON want headroom the internal heap can't spare. */
    TaskHandle_t t = NULL;
    if (xTaskCreateWithCaps(exec_task, "drive-exec", 8192, NULL, 5, &t,
                            MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT) != pdPASS)
        xTaskCreate(exec_task, "drive-exec", 6144, NULL, 5, &t);
    if (xTaskCreateWithCaps(io_task, "drive-io", 6144, NULL, 5, &t,
                            MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT) != pdPASS)
        xTaskCreate(io_task, "drive-io", 4096, NULL, 5, &t);
}

bool portal_drive_mesh_active(void)
{
    return s_started && s_route_mesh && esp_olm_is_connected();
}

void portal_drive_mesh_yield(void) { s_route_mesh = false; }

void portal_drive_mesh_ioback(const uint8_t *data, int len)
{
    if (s_io_stream && data && len > 0) xStreamBufferSend(s_io_stream, data, len, 0);
}
