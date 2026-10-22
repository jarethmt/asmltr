/* esp_olm — token fetch: POST /api/v1/auth/olm/get-token { olmId, secret, userToken, orgId }.
 * SPDX-License-Identifier: BSD-3-Clause
 */
#include "olm_priv.h"
#include <string.h>
#include <stdlib.h>
#include "esp_log.h"
#include "esp_http_client.h"
#include "esp_crt_bundle.h"
#include "cJSON.h"

static const char *TAG = "olm_http";

/* Accumulate the response body into a growable buffer via the event handler. */
typedef struct { char *buf; int len; int cap; } resp_acc_t;

static esp_err_t http_evt(esp_http_client_event_t *evt)
{
    if (evt->event_id == HTTP_EVENT_ON_DATA && evt->data_len > 0) {
        resp_acc_t *a = (resp_acc_t *)evt->user_data;
        if (!a) return ESP_OK;
        int need = a->len + evt->data_len + 1;
        if (need > a->cap) {
            int ncap = a->cap ? a->cap : 512;
            while (ncap < need) ncap *= 2;
            if (ncap > 16384) { ESP_LOGW(TAG, "token response too large"); return ESP_FAIL; }
            char *nb = realloc(a->buf, ncap);
            if (!nb) return ESP_FAIL;
            a->buf = nb; a->cap = ncap;
        }
        memcpy(a->buf + a->len, evt->data, evt->data_len);
        a->len += evt->data_len;
        a->buf[a->len] = '\0';
    }
    return ESP_OK;
}

esp_err_t olm_http_get_token(olm_ctx_t *c, char *token_out, size_t token_len)
{
    char url[224];
    snprintf(url, sizeof(url), "%s/api/v1/auth/olm/get-token", c->server_url);

    cJSON *body = cJSON_CreateObject();
    cJSON_AddStringToObject(body, "olmId",     c->cfg.olm_id);
    cJSON_AddStringToObject(body, "secret",    c->cfg.secret);
    cJSON_AddStringToObject(body, "userToken", "");
    cJSON_AddStringToObject(body, "orgId",     c->cfg.org_id);
    char *body_str = cJSON_PrintUnformatted(body);
    cJSON_Delete(body);
    if (!body_str) return ESP_ERR_NO_MEM;

    resp_acc_t acc = {0};
    esp_http_client_config_t cfg = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .event_handler = http_evt,
        .user_data = &acc,
        .timeout_ms = 15000,
        .crt_bundle_attach = esp_crt_bundle_attach,
    };
    if (c->cfg.ca_pem && c->cfg.ca_pem[0]) {
        cfg.cert_pem = c->cfg.ca_pem;
        cfg.crt_bundle_attach = NULL;
    }
    if (c->cfg.skip_tls_verify) {
        ESP_LOGW(TAG, "skip_tls_verify requested — relying on cert bundle anyway (no insecure path)");
    }

    esp_http_client_handle_t cl = esp_http_client_init(&cfg);
    if (!cl) { free(body_str); return ESP_FAIL; }
    esp_http_client_set_header(cl, "Content-Type", "application/json");
    esp_http_client_set_header(cl, "X-CSRF-Token", "x-csrf-protection");
    esp_http_client_set_post_field(cl, body_str, strlen(body_str));

    esp_err_t err = esp_http_client_perform(cl);
    int status = esp_http_client_get_status_code(cl);
    esp_http_client_cleanup(cl);
    free(body_str);

    if (err != ESP_OK) {
        ESP_LOGW(TAG, "get-token request failed: %s", esp_err_to_name(err));
        free(acc.buf);
        return err;
    }
    if (status != 200) {
        ESP_LOGW(TAG, "get-token HTTP %d: %.*s", status, acc.len > 300 ? 300 : acc.len, acc.buf ? acc.buf : "");
        free(acc.buf);
        return (status == 401 || status == 403) ? ESP_ERR_INVALID_STATE : ESP_FAIL;
    }

    /* parse { success, data: { token, ... } } */
    esp_err_t out = ESP_FAIL;
    cJSON *root = cJSON_Parse(acc.buf ? acc.buf : "");
    if (root) {
        cJSON *data = cJSON_GetObjectItemCaseSensitive(root, "data");
        cJSON *tok  = data ? cJSON_GetObjectItemCaseSensitive(data, "token") : NULL;
        if (cJSON_IsString(tok) && tok->valuestring && tok->valuestring[0]) {
            strlcpy(token_out, tok->valuestring, token_len);
            out = ESP_OK;
        } else {
            ESP_LOGW(TAG, "get-token: no token in response");
        }
        cJSON_Delete(root);
    } else {
        ESP_LOGW(TAG, "get-token: unparseable response");
    }
    free(acc.buf);
    return out;
}
