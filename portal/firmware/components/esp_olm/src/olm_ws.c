/* esp_olm — control websocket: esp_websocket_client transport, fragment reassembly, gzip
 * inflate for binary frames, JSON {type,data,configVersion} dispatch, and an app-level
 * `olm/ping` keepalive. The olm_task owns reconnect, so auto-reconnect is disabled here.
 * SPDX: BSD-3-Clause
 */
#include "olm_priv.h"
#include <string.h>
#include <stdlib.h>
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_crt_bundle.h"
#include "esp_websocket_client.h"
#include "cJSON.h"
#include "zlib.h"

static const char *TAG = "olm_ws";
#define OLM_PING_INTERVAL_US (15 * 1000000ULL)  /* app-level olm/ping cadence */

/* reassembly + dispatch state (single instance, matching the one olm_ctx) */
static esp_websocket_client_handle_t s_client = NULL;
static olm_ws_msg_cb_t s_on_msg = NULL;
static olm_ctx_t      *s_ctx = NULL;
static volatile bool   s_up = false;
static esp_timer_handle_t s_ping_timer = NULL;

static char   *s_acc = NULL;   /* reassembly buffer */
static int     s_acc_len = 0;
static int     s_acc_cap = 0;
static uint8_t s_acc_op = 0;

/* ---- gzip inflate (zlib, gzip window) ------------------------------------- */
static char *gunzip(const char *in, int inlen, int *outlen)
{
    z_stream zs; memset(&zs, 0, sizeof(zs));
    if (inflateInit2(&zs, 15 + 16) != Z_OK) return NULL;
    int cap = inlen * 4 + 256, len = 0;
    char *out = malloc(cap);
    if (!out) { inflateEnd(&zs); return NULL; }
    zs.next_in = (Bytef *)in; zs.avail_in = inlen;
    int ret;
    do {
        if (len == cap) { cap *= 2; char *n = realloc(out, cap); if (!n) { free(out); inflateEnd(&zs); return NULL; } out = n; }
        zs.next_out  = (Bytef *)(out + len);
        zs.avail_out = cap - len;
        ret = inflate(&zs, Z_NO_FLUSH);
        len = cap - zs.avail_out;
        if (ret != Z_OK && ret != Z_STREAM_END) { ESP_LOGW(TAG, "inflate err %d", ret); free(out); inflateEnd(&zs); return NULL; }
    } while (ret != Z_STREAM_END);
    inflateEnd(&zs);
    char *n = realloc(out, len + 1); if (n) out = n;
    out[len] = '\0';
    *outlen = len;
    return out;
}

/* ---- dispatch one complete JSON control message --------------------------- */
static void dispatch(const char *json, int len)
{
    (void)len;
    cJSON *root = cJSON_Parse(json);
    if (!root) { ESP_LOGW(TAG, "unparseable ws message"); return; }
    cJSON *type = cJSON_GetObjectItemCaseSensitive(root, "type");
    cJSON *cv   = cJSON_GetObjectItemCaseSensitive(root, "configVersion");
    if (cv && cJSON_IsNumber(cv) && s_ctx) s_ctx->config_version = cv->valueint;
    if (cJSON_IsString(type) && type->valuestring && s_on_msg) {
        cJSON *data = cJSON_GetObjectItemCaseSensitive(root, "data");
        char *data_str = data ? cJSON_PrintUnformatted(data) : NULL;
        s_on_msg(s_ctx, type->valuestring, data_str ? data_str : "{}");
        if (data_str) free(data_str);
    }
    cJSON_Delete(root);
}

/* ---- websocket event handler ---------------------------------------------- */
static void ws_event(void *args, esp_event_base_t base, int32_t id, void *event_data)
{
    (void)args; (void)base;
    esp_websocket_event_data_t *d = (esp_websocket_event_data_t *)event_data;

    switch (id) {
    case WEBSOCKET_EVENT_CONNECTED:
        ESP_LOGI(TAG, "ws connected");
        s_up = true;
        if (s_on_msg) s_on_msg(s_ctx, OLM_EVT_WS_CONNECTED, "{}");
        break;

    case WEBSOCKET_EVENT_DISCONNECTED:
    case WEBSOCKET_EVENT_CLOSED:
        ESP_LOGI(TAG, "ws closed/disconnected");
        s_up = false;
        break;

    case WEBSOCKET_EVENT_ERROR:
        ESP_LOGW(TAG, "ws error");
        break;

    case WEBSOCKET_EVENT_DATA: {
        if (!d || d->data_len < 0) break;
        /* opcodes: 0x1 text, 0x2 binary, 0x8 close, 0x9 ping, 0xA pong, 0x0 continuation */
        if (d->payload_offset == 0) {
            if (d->op_code == 0x8 || d->op_code == 0x9 || d->op_code == 0xA) break; /* control frames */
            s_acc_op = d->op_code;
            s_acc_len = 0;
            if (d->payload_len > s_acc_cap) {
                int ncap = d->payload_len + 1;
                char *n = realloc(s_acc, ncap);
                if (!n) { ESP_LOGE(TAG, "acc oom %d", ncap); break; }
                s_acc = n; s_acc_cap = ncap;
            }
        }
        if (s_acc_op == 0x8 || s_acc_op == 0x9 || s_acc_op == 0xA) break;
        if (d->data_len > 0 && s_acc && (s_acc_len + d->data_len) <= s_acc_cap) {
            memcpy(s_acc + s_acc_len, d->data_ptr, d->data_len);
            s_acc_len += d->data_len;
        }
        if (d->payload_offset + d->data_len >= d->payload_len && s_acc_len > 0) {
            if (s_acc_op == 0x2) {                 /* binary == gzip */
                int ol = 0;
                char *plain = gunzip(s_acc, s_acc_len, &ol);
                if (plain) { dispatch(plain, ol); free(plain); }
            } else {                               /* text */
                char save = 0; bool term = false;
                if (s_acc_len < s_acc_cap) { save = s_acc[s_acc_len]; s_acc[s_acc_len] = '\0'; term = true; }
                dispatch(s_acc, s_acc_len);
                if (term) s_acc[s_acc_len] = save;
            }
            s_acc_len = 0;
        }
        break;
    }
    default: break;
    }
}

/* ---- app-level keepalive -------------------------------------------------- */
static void ping_cb(void *arg)
{
    (void)arg;
    if (s_up && s_ctx) olm_ws_send(s_ctx, "olm/ping", "{}");
}

/* ---- public --------------------------------------------------------------- */
esp_err_t olm_ws_connect(olm_ctx_t *c, const char *token, olm_ws_msg_cb_t on_msg)
{
    s_ctx = c; s_on_msg = on_msg; s_up = false;

    /* wss://host/api/v1/ws?token=<t>&clientType=olm */
    int need = strlen(c->server_host) + strlen(token) + 64;
    char *uri = malloc(need);
    if (!uri) return ESP_ERR_NO_MEM;
    snprintf(uri, need, "%s://%s/api/v1/ws?token=%s&clientType=olm",
             c->server_tls ? "wss" : "ws", c->server_host, token);

    esp_websocket_client_config_t cfg = {
        .uri = uri,
        .disable_auto_reconnect = true,     /* olm_task owns reconnect + token refresh */
        .network_timeout_ms = 15000,
        .buffer_size = 4096,
        .task_stack = 6144,
    };
    if (c->server_tls) {
        if (c->cfg.ca_pem && c->cfg.ca_pem[0]) cfg.cert_pem = c->cfg.ca_pem;
        else cfg.crt_bundle_attach = esp_crt_bundle_attach;
    }

    s_client = esp_websocket_client_init(&cfg);
    free(uri);
    if (!s_client) return ESP_FAIL;
    c->ws = s_client;
    esp_websocket_register_events(s_client, WEBSOCKET_EVENT_ANY, ws_event, NULL);
    esp_err_t err = esp_websocket_client_start(s_client);
    if (err != ESP_OK) { esp_websocket_client_destroy(s_client); s_client = NULL; c->ws = NULL; return err; }

    if (!s_ping_timer) {
        esp_timer_create_args_t ta = { .callback = ping_cb, .name = "olm_ping" };
        esp_timer_create(&ta, &s_ping_timer);
    }
    esp_timer_start_periodic(s_ping_timer, OLM_PING_INTERVAL_US);
    return ESP_OK;
}

esp_err_t olm_ws_send(olm_ctx_t *c, const char *type, const char *data_json)
{
    if (!s_client || !s_up) return ESP_ERR_INVALID_STATE;
    int need = strlen(type) + strlen(data_json) + 64;
    char *msg = malloc(need);
    if (!msg) return ESP_ERR_NO_MEM;
    int n = snprintf(msg, need, "{\"type\":\"%s\",\"data\":%s,\"configVersion\":%d}",
                     type, data_json, c ? c->config_version : 0);
    int sent = esp_websocket_client_send_text(s_client, msg, n, pdMS_TO_TICKS(5000));
    free(msg);
    return (sent >= 0) ? ESP_OK : ESP_FAIL;
}

void olm_ws_disconnect(olm_ctx_t *c)
{
    if (s_ping_timer) esp_timer_stop(s_ping_timer);
    s_up = false;
    if (s_client) {
        esp_websocket_client_close(s_client, pdMS_TO_TICKS(2000));
        esp_websocket_client_destroy(s_client);
        s_client = NULL;
    }
    if (c) c->ws = NULL;
    free(s_acc); s_acc = NULL; s_acc_cap = s_acc_len = 0;
}

bool olm_ws_is_up(olm_ctx_t *c) { (void)c; return s_up && s_client; }
