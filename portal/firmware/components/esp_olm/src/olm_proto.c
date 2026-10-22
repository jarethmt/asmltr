/* esp_olm — protocol layer: registration + the inbound control-message state machine.
 *
 * Flow: ws connects -> send olm/wg/register {publicKey, relay, ...} -> server replies
 * olm/wg/connect {tunnelIP, sites[]} -> bring up the WireGuard tunnel -> handle live
 * peer add/remove/update pushes. SPDX: BSD-3-Clause
 */
#include "olm_priv.h"
#include <string.h>
#include <stdlib.h>
#include "esp_log.h"
#include "esp_random.h"
#include "cJSON.h"

static const char *TAG = "olm_proto";

static void gen_chain_id(char *out, size_t n)
{
    static const char hex[] = "0123456789abcdef";
    size_t i = 0;
    for (; i + 1 < n && i < 16; i += 2) {
        uint8_t b = (uint8_t)esp_random();
        out[i]   = hex[b >> 4];
        out[i+1] = hex[b & 0xF];
    }
    out[i < n ? i : n - 1] = '\0';
}

esp_err_t olm_proto_register(olm_ctx_t *c)
{
    char chain[17];
    gen_chain_id(chain, sizeof(chain));

    cJSON *d = cJSON_CreateObject();
    cJSON_AddStringToObject(d, "publicKey",  c->keys.pub_b64);
    cJSON_AddBoolToObject(d,   "relay",      c->cfg.relay);
    cJSON_AddStringToObject(d, "olmVersion", c->cfg.olm_version);
    cJSON_AddStringToObject(d, "olmAgent",   c->cfg.olm_agent);
    cJSON_AddStringToObject(d, "orgId",      c->cfg.org_id);
    cJSON_AddStringToObject(d, "userToken",  "");
    cJSON_AddStringToObject(d, "chainId",    chain);
    char *s = cJSON_PrintUnformatted(d);
    cJSON_Delete(d);
    if (!s) return ESP_ERR_NO_MEM;

    esp_err_t err = olm_ws_send(c, "olm/wg/register", s);
    free(s);
    ESP_LOGI(TAG, "sent register (relay=%d, pub=%.8s..)", c->cfg.relay, c->keys.pub_b64);
    olm_set_state(c, ESP_OLM_REGISTERING);
    return err;
}

/* Parse one site/peer JSON object into an olm_peer_t. Relay mode prefers relayEndpoint. */
static bool parse_peer(const cJSON *site, olm_peer_t *p, bool relay)
{
    memset(p, 0, sizeof(*p));
    const cJSON *pk  = cJSON_GetObjectItemCaseSensitive(site, "publicKey");
    if (!cJSON_IsString(pk) || !pk->valuestring[0]) return false;
    strlcpy(p->public_key, pk->valuestring, sizeof(p->public_key));

    const cJSON *sid = cJSON_GetObjectItemCaseSensitive(site, "siteId");
    p->site_id = (sid && cJSON_IsNumber(sid)) ? sid->valueint : -1;

    const cJSON *relayEp = cJSON_GetObjectItemCaseSensitive(site, "relayEndpoint");
    const cJSON *dirEp   = cJSON_GetObjectItemCaseSensitive(site, "endpoint");
    const char *ep = NULL;
    if (relay && cJSON_IsString(relayEp) && relayEp->valuestring[0]) ep = relayEp->valuestring;
    else if (cJSON_IsString(dirEp) && dirEp->valuestring[0])         ep = dirEp->valuestring;
    else if (cJSON_IsString(relayEp) && relayEp->valuestring[0])     ep = relayEp->valuestring;
    if (!ep) return false;
    strlcpy(p->endpoint, ep, sizeof(p->endpoint));

    /* allowedIps[0]; fall back to serverIP/32 */
    const cJSON *aips = cJSON_GetObjectItemCaseSensitive(site, "allowedIps");
    if (cJSON_IsArray(aips) && cJSON_GetArraySize(aips) > 0) {
        const cJSON *a0 = cJSON_GetArrayItem(aips, 0);
        if (cJSON_IsString(a0)) strlcpy(p->allowed_ips, a0->valuestring, sizeof(p->allowed_ips));
    }
    if (!p->allowed_ips[0]) {
        const cJSON *sip = cJSON_GetObjectItemCaseSensitive(site, "serverIP");
        if (cJSON_IsString(sip) && sip->valuestring[0])
            snprintf(p->allowed_ips, sizeof(p->allowed_ips), "%s/32", sip->valuestring);
    }
    p->keepalive = 25;
    return p->allowed_ips[0] != '\0';
}

static void handle_connect(olm_ctx_t *c, const char *data_json)
{
    cJSON *data = cJSON_Parse(data_json);
    if (!data) { ESP_LOGW(TAG, "connect: bad data"); return; }

    olm_connect_t *cfg = calloc(1, sizeof(*cfg));
    if (!cfg) { cJSON_Delete(data); return; }

    const cJSON *tip = cJSON_GetObjectItemCaseSensitive(data, "tunnelIP");
    if (cJSON_IsString(tip)) strlcpy(cfg->tunnel_ip, tip->valuestring, sizeof(cfg->tunnel_ip));
    const cJSON *util = cJSON_GetObjectItemCaseSensitive(data, "utilitySubnet");
    if (cJSON_IsString(util)) strlcpy(cfg->utility_subnet, util->valuestring, sizeof(cfg->utility_subnet));

    const cJSON *sites = cJSON_GetObjectItemCaseSensitive(data, "sites");
    if (cJSON_IsArray(sites)) {
        const cJSON *site;
        cJSON_ArrayForEach(site, sites) {
            if (cfg->n_peers >= OLM_MAX_PEERS) { ESP_LOGW(TAG, "more sites than OLM_MAX_PEERS; truncating"); break; }
            if (parse_peer(site, &cfg->peers[cfg->n_peers], c->cfg.relay)) cfg->n_peers++;
        }
    }
    /* optional exit node as an additional peer */
    const cJSON *ex = cJSON_GetObjectItemCaseSensitive(data, "exitNode");
    if (cJSON_IsObject(ex) && cfg->n_peers < OLM_MAX_PEERS) {
        const cJSON *conn = cJSON_GetObjectItemCaseSensitive(ex, "connect");
        if (cJSON_IsBool(conn) && cJSON_IsTrue(conn)) {
            olm_peer_t *p = &cfg->peers[cfg->n_peers];
            memset(p, 0, sizeof(*p));
            const cJSON *pk  = cJSON_GetObjectItemCaseSensitive(ex, "publicKey");
            const cJSON *eph = cJSON_GetObjectItemCaseSensitive(ex, "endpoint");
            const cJSON *rp  = cJSON_GetObjectItemCaseSensitive(ex, "relayPort");
            const cJSON *sip = cJSON_GetObjectItemCaseSensitive(ex, "serverIP");
            if (cJSON_IsString(pk) && cJSON_IsString(eph)) {
                strlcpy(p->public_key, pk->valuestring, sizeof(p->public_key));
                int port = (rp && cJSON_IsNumber(rp)) ? rp->valueint : 21820;
                snprintf(p->endpoint, sizeof(p->endpoint), "%s:%d", eph->valuestring, port);
                if (cJSON_IsString(sip) && sip->valuestring[0])
                    snprintf(p->allowed_ips, sizeof(p->allowed_ips), "%s/32", sip->valuestring);
                p->site_id = -1; p->keepalive = 25;
                if (p->allowed_ips[0]) cfg->n_peers++;
            }
        }
    }
    cJSON_Delete(data);

    ESP_LOGI(TAG, "connect: tunnelIP=%s peers=%d", cfg->tunnel_ip, cfg->n_peers);
    if (olm_wg_up(c, cfg) == ESP_OK) {
        c->registered = true;
        olm_set_state(c, ESP_OLM_CONNECTED);
        if (c->cfg.on_state) { /* already fired via olm_set_state */ }
    } else {
        ESP_LOGE(TAG, "wg bring-up failed");
        olm_set_state(c, ESP_OLM_ERROR);
    }
    free(cfg);
}

static void handle_peer_add(olm_ctx_t *c, const char *data_json)
{
    cJSON *data = cJSON_Parse(data_json);
    if (!data) return;
    olm_peer_t p;
    if (parse_peer(data, &p, c->cfg.relay)) olm_wg_add_peer(c, &p);
    cJSON_Delete(data);
}

static void handle_peer_remove(olm_ctx_t *c, const char *data_json)
{
    cJSON *data = cJSON_Parse(data_json);
    if (!data) return;
    const cJSON *pk = cJSON_GetObjectItemCaseSensitive(data, "publicKey");
    if (cJSON_IsString(pk) && pk->valuestring[0]) olm_wg_remove_peer(c, pk->valuestring);
    cJSON_Delete(data);
}

static void handle_error(olm_ctx_t *c, const char *data_json, bool fatal)
{
    cJSON *data = cJSON_Parse(data_json);
    const char *code = "?", *msg = "";
    cJSON *cc = NULL, *mm = NULL;
    if (data) {
        cc = cJSON_GetObjectItemCaseSensitive(data, "code");
        mm = cJSON_GetObjectItemCaseSensitive(data, "message");
        if (cJSON_IsString(cc)) code = cc->valuestring;
        if (cJSON_IsString(mm)) msg  = mm->valuestring;
    }
    ESP_LOGE(TAG, "%s (code=%s): %s", fatal ? "terminate" : "olm error", code, msg);
    if (c->cfg.on_error) c->cfg.on_error(code, msg, c->cfg.user_ctx);
    if (fatal) olm_set_state(c, ESP_OLM_ERROR);
    if (data) cJSON_Delete(data);
}

void olm_proto_on_msg(olm_ctx_t *c, const char *type, const char *data_json)
{
    if (!type) return;
    if      (strcmp(type, OLM_EVT_WS_CONNECTED) == 0) { if (!c->registered) olm_proto_register(c); }
    else if (strcmp(type, "olm/wg/connect") == 0)     handle_connect(c, data_json);
    else if (strcmp(type, "olm/wg/peer/add") == 0)    handle_peer_add(c, data_json);
    else if (strcmp(type, "olm/wg/peer/remove") == 0) handle_peer_remove(c, data_json);
    else if (strcmp(type, "olm/wg/peer/update") == 0) { handle_peer_remove(c, data_json); handle_peer_add(c, data_json); }
    else if (strcmp(type, "olm/error") == 0)          handle_error(c, data_json, false);
    else if (strcmp(type, "olm/terminate") == 0)      handle_error(c, data_json, true);
    else ESP_LOGD(TAG, "unhandled msg type=%s", type);
}
