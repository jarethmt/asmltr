/* esp_olm — orchestration: public API + the lifecycle task.
 *
 * The task walks the connection state machine and keeps it alive:
 *   get-token (HTTP) -> open control ws -> register -> wg/connect brings up the tunnel ->
 *   stay connected (ws keepalive handled in olm_ws) -> on drop, backoff and start over.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */
#include "esp_olm.h"
#include "olm_priv.h"

#include <string.h>
#include <stdlib.h>
#include "esp_log.h"
#include "freertos/task.h"

static const char *TAG = "esp_olm";

static olm_ctx_t *s_ctx = NULL;   /* single-instance (one mesh identity per device) */

#define OLM_RECONNECT_MIN_MS 2000
#define OLM_RECONNECT_MAX_MS 30000

/* ---- helpers -------------------------------------------------------------- */

static char *dupstr(const char *s) { return s ? strdup(s) : NULL; }

void olm_set_state(olm_ctx_t *c, esp_olm_state_t st)
{
    if (c->state == st) return;
    c->state = st;
    ESP_LOGI(TAG, "state -> %d", (int)st);
    if (c->cfg.on_state) c->cfg.on_state(st, c->cfg.user_ctx);
}

/* Parse scheme://host[:port] from server_url into server_host + server_tls. */
static esp_err_t parse_server(olm_ctx_t *c)
{
    const char *u = c->cfg.server_url;
    if (!u || !*u) return ESP_ERR_INVALID_ARG;
    c->server_tls = (strncmp(u, "https://", 8) == 0);
    const char *host = strstr(u, "://");
    host = host ? host + 3 : u;
    size_t n = strcspn(host, "/");            /* host[:port] up to first '/' */
    if (n == 0 || n >= sizeof(c->server_host)) return ESP_ERR_INVALID_ARG;
    memcpy(c->server_host, host, n);
    c->server_host[n] = '\0';
    /* normalized base url (no trailing slash) */
    strlcpy(c->server_url, u, sizeof(c->server_url));
    size_t ul = strlen(c->server_url);
    while (ul && c->server_url[ul - 1] == '/') c->server_url[--ul] = '\0';
    return ESP_OK;
}

/* ---- lifecycle task ------------------------------------------------------- */

static void olm_task(void *arg)
{
    olm_ctx_t *c = (olm_ctx_t *)arg;
    int backoff = OLM_RECONNECT_MIN_MS;

    while (!c->stop) {
        c->registered = false;
        olm_set_state(c, ESP_OLM_CONNECTING);

        char token[512] = {0};
        esp_err_t err = olm_http_get_token(c, token, sizeof(token));
        if (err != ESP_OK || !token[0]) {
            ESP_LOGW(TAG, "get-token failed (%s); retry in %d ms", esp_err_to_name(err), backoff);
            goto backoff_wait;
        }

        err = olm_ws_connect(c, token, olm_proto_on_msg);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "ws connect failed (%s); retry in %d ms", esp_err_to_name(err), backoff);
            goto backoff_wait;
        }

        /* Connected to control plane; olm_proto will register + bring up WG as messages arrive.
         * Stay here while the ws is up; olm_ws runs its own keepalive + read pump. */
        backoff = OLM_RECONNECT_MIN_MS;   /* a successful connect resets backoff */
        while (!c->stop && olm_ws_is_up(c)) {
            vTaskDelay(pdMS_TO_TICKS(500));
        }

        ESP_LOGI(TAG, "control channel down; tearing down tunnel");
        olm_ws_disconnect(c);
        olm_wg_down(c);
        if (c->stop) break;
        olm_set_state(c, ESP_OLM_CONNECTING);

    backoff_wait:
        for (int waited = 0; waited < backoff && !c->stop; waited += 100)
            vTaskDelay(pdMS_TO_TICKS(100));
        backoff = backoff * 2;
        if (backoff > OLM_RECONNECT_MAX_MS) backoff = OLM_RECONNECT_MAX_MS;
    }

    olm_ws_disconnect(c);
    olm_wg_down(c);
    olm_set_state(c, ESP_OLM_DISCONNECTED);
    ESP_LOGI(TAG, "olm task exit");
    c->task = NULL;
    vTaskDelete(NULL);
}

/* ---- public API ----------------------------------------------------------- */

esp_err_t esp_olm_start(const esp_olm_config_t *cfg)
{
    if (s_ctx) return ESP_ERR_INVALID_STATE;
    if (!cfg || !cfg->server_url || !cfg->olm_id || !cfg->secret || !cfg->org_id)
        return ESP_ERR_INVALID_ARG;

    olm_ctx_t *c = calloc(1, sizeof(*c));
    if (!c) return ESP_ERR_NO_MEM;

    /* deep-copy the config strings we keep */
    c->cfg = *cfg;
    c->cfg.server_url         = dupstr(cfg->server_url);
    c->cfg.olm_id             = dupstr(cfg->olm_id);
    c->cfg.secret             = dupstr(cfg->secret);
    c->cfg.org_id             = dupstr(cfg->org_id);
    c->cfg.wg_private_key_b64 = dupstr(cfg->wg_private_key_b64);
    c->cfg.olm_version        = dupstr(cfg->olm_version ? cfg->olm_version : "1.10.1");
    c->cfg.olm_agent          = dupstr(cfg->olm_agent   ? cfg->olm_agent   : "esp-olm");
    c->cfg.ca_pem             = dupstr(cfg->ca_pem);

    esp_err_t err = parse_server(c);
    if (err != ESP_OK) { ESP_LOGE(TAG, "bad server_url"); goto fail; }

    err = olm_crypto_key_init(c->cfg.wg_private_key_b64, &c->keys);
    if (err != ESP_OK) { ESP_LOGE(TAG, "key init failed: %s", esp_err_to_name(err)); goto fail; }
    ESP_LOGI(TAG, "wg public key: %s", c->keys.pub_b64);

    c->state = ESP_OLM_DISCONNECTED;
    c->stop  = false;
    s_ctx = c;

    if (xTaskCreate(olm_task, "olm", 8192, c, 5, &c->task) != pdPASS) {
        ESP_LOGE(TAG, "task create failed");
        s_ctx = NULL;
        err = ESP_ERR_NO_MEM;
        goto fail;
    }
    return ESP_OK;

fail:
    free((void *)c->cfg.server_url);  free((void *)c->cfg.olm_id);
    free((void *)c->cfg.secret);      free((void *)c->cfg.org_id);
    free((void *)c->cfg.wg_private_key_b64);
    free((void *)c->cfg.olm_version); free((void *)c->cfg.olm_agent);
    free((void *)c->cfg.ca_pem);
    free(c);
    return err;
}

void esp_olm_stop(void)
{
    olm_ctx_t *c = s_ctx;
    if (!c) return;
    c->stop = true;
    /* wait for the task to exit (it NULLs c->task on the way out) */
    for (int i = 0; i < 100 && c->task; i++) vTaskDelay(pdMS_TO_TICKS(50));
    s_ctx = NULL;
    free((void *)c->cfg.server_url);  free((void *)c->cfg.olm_id);
    free((void *)c->cfg.secret);      free((void *)c->cfg.org_id);
    free((void *)c->cfg.wg_private_key_b64);
    free((void *)c->cfg.olm_version); free((void *)c->cfg.olm_agent);
    free((void *)c->cfg.ca_pem);
    free(c);
}

esp_olm_state_t esp_olm_get_state(void)   { return s_ctx ? s_ctx->state : ESP_OLM_DISCONNECTED; }
bool            esp_olm_is_connected(void){ return s_ctx && s_ctx->state == ESP_OLM_CONNECTED; }
const char     *esp_olm_tunnel_ip(void)   { return s_ctx ? s_ctx->tunnel_ip : ""; }
const char     *esp_olm_public_key(void)  { return s_ctx ? s_ctx->keys.pub_b64 : ""; }
