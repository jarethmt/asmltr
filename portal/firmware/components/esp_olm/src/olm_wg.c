/* esp_olm — WireGuard data plane over the vendored esp_wireguard's multi-peer wireguardif API.
 *
 * Brings up one lwIP netif (our overlay address) and programs one peer per site from the
 * `olm/wg/connect` payload (relay mode: each peer's endpoint is the exit-node relay). The netif
 * is NOT made default — encrypted WG/UDP still egresses the real STA; only overlay-subnet traffic
 * is routed here. SPDX: BSD-3-Clause
 */
#include "olm_priv.h"
#include <string.h>
#include <stdlib.h>
#include "esp_log.h"
#include "lwip/netif.h"
#include "lwip/netdb.h"
#include "lwip/ip_addr.h"
#include "lwip/ip.h"       /* ip_input (netif input fn) */
#include "lwip/inet.h"

#include "wireguardif.h"   /* vendored esp_wireguard (src/ exported) */

static const char *TAG = "olm_wg";

static struct netif  s_wg_netif;
static struct netif *s_netif = NULL;
static char          s_priv_b64[OLM_B64KEYLEN];           /* kept alive for netif lifetime     */
static struct { char pub[OLM_B64KEYLEN]; uint8_t idx; } s_peers[OLM_MAX_PEERS];
static int           s_npeers = 0;

/* prefix length -> IPv4 netmask (host order) */
static uint32_t prefix_to_mask(int prefix)
{
    if (prefix <= 0)  return 0;
    if (prefix >= 32) return 0xFFFFFFFFu;
    return 0xFFFFFFFFu << (32 - prefix);
}

/* "10.200.0.9/20" or "10.200.0.9" -> ip + netmask (netmask defaults to /20 for the mesh). */
static bool parse_ip_cidr(const char *s, ip4_addr_t *ip, ip4_addr_t *mask, int default_prefix)
{
    char tmp[48];
    strlcpy(tmp, s, sizeof(tmp));
    int prefix = default_prefix;
    char *slash = strchr(tmp, '/');
    if (slash) { *slash = '\0'; prefix = atoi(slash + 1); if (prefix <= 0 || prefix > 32) prefix = default_prefix; }
    if (!ip4addr_aton(tmp, ip)) return false;
    ip4_addr_set_u32(mask, lwip_htonl(prefix_to_mask(prefix)));
    return true;
}

/* Split "host:port" into host (out) and port (return). Port 0 if absent. */
static uint16_t split_host_port(const char *endpoint, char *host, size_t hostlen)
{
    strlcpy(host, endpoint, hostlen);
    char *colon = strrchr(host, ':');
    if (!colon) return 0;
    *colon = '\0';
    return (uint16_t)atoi(colon + 1);
}

/* Resolve a hostname/IP to an lwIP ip_addr_t (IPv4). */
static bool resolve_host(const char *host, ip_addr_t *out)
{
    struct addrinfo hints = { .ai_family = AF_INET, .ai_socktype = SOCK_DGRAM };
    struct addrinfo *res = NULL;
    if (getaddrinfo(host, NULL, &hints, &res) != 0 || !res) return false;
    bool ok = false;
    if (res->ai_family == AF_INET) {
        struct in_addr a = ((struct sockaddr_in *)res->ai_addr)->sin_addr;
        inet_addr_to_ip4addr(ip_2_ip4(out), &a);
        out->type = IPADDR_TYPE_V4;
        ok = true;
    }
    freeaddrinfo(res);
    return ok;
}

/* Add + connect a single peer. Returns ESP_OK on success. */
static esp_err_t add_one_peer(const olm_peer_t *p)
{
    if (!p->public_key[0] || !p->endpoint[0]) {
        ESP_LOGW(TAG, "peer site=%d missing key/endpoint; skip", p->site_id);
        return ESP_ERR_INVALID_ARG;
    }
    if (s_npeers >= OLM_MAX_PEERS) { ESP_LOGW(TAG, "peer table full"); return ESP_ERR_NO_MEM; }

    char host[OLM_ENDPOINT_LEN];
    uint16_t port = split_host_port(p->endpoint, host, sizeof(host));
    if (port == 0) port = 51820;

    ip_addr_t endpoint_ip;
    memset(&endpoint_ip, 0, sizeof(endpoint_ip));
    if (!resolve_host(host, &endpoint_ip)) {
        ESP_LOGW(TAG, "resolve '%s' failed; skip peer", host);
        return ESP_FAIL;
    }

    struct wireguardif_peer peer;
    wireguardif_peer_init(&peer);
    peer.public_key    = s_peers[s_npeers].pub;      /* stable storage */
    strlcpy(s_peers[s_npeers].pub, p->public_key, OLM_B64KEYLEN);
    peer.preshared_key = NULL;
    peer.keep_alive    = p->keepalive ? p->keepalive : 25;
    peer.endpoint_ip   = endpoint_ip;
    peer.endport_port  = port;

    /* allowed_ips[0] (primary). First CIDR routed to this peer. */
    ip4_addr_t aip, amask;
    const char *cidr = p->allowed_ips[0] ? p->allowed_ips : "0.0.0.0/0";
    if (!parse_ip_cidr(cidr, &aip, &amask, 32)) { ESP_LOGW(TAG, "bad allowed_ip '%s'", p->allowed_ips); return ESP_FAIL; }
    ip_addr_copy_from_ip4(peer.allowed_ip, aip);
    ip_addr_copy_from_ip4(peer.allowed_mask, amask);

    uint8_t idx = WIREGUARDIF_INVALID_INDEX;
    err_t e = wireguardif_add_peer(s_netif, &peer, &idx);
    if (e != ERR_OK || idx == WIREGUARDIF_INVALID_INDEX) {
        ESP_LOGE(TAG, "add_peer site=%d failed: %d", p->site_id, e);
        return ESP_FAIL;
    }
    s_peers[s_npeers].idx = idx;
    s_npeers++;
    if (wireguardif_connect(s_netif, idx) != ERR_OK)
        ESP_LOGW(TAG, "connect peer idx=%u returned error (will retry via keepalive)", idx);
    ESP_LOGI(TAG, "peer site=%d key=%.8s.. via %s:%u allowed=%s", p->site_id, p->public_key, host, port, cidr);
    return ESP_OK;
}

esp_err_t olm_wg_up(olm_ctx_t *c, const olm_connect_t *cfg)
{
    if (s_netif) olm_wg_down(c);

    ip4_addr_t ip, mask, gw;
    if (!parse_ip_cidr(cfg->tunnel_ip, &ip, &mask, 20)) {
        ESP_LOGE(TAG, "bad tunnel ip '%s'", cfg->tunnel_ip);
        return ESP_ERR_INVALID_ARG;
    }
    ip4_addr_set_zero(&gw);

    strlcpy(s_priv_b64, c->keys.priv_b64, sizeof(s_priv_b64));
    struct wireguardif_init_data wg = { .private_key = s_priv_b64, .listen_port = 0, .bind_netif = NULL };

    memset(&s_wg_netif, 0, sizeof(s_wg_netif));
    s_netif = netif_add(&s_wg_netif, &ip, &mask, &gw, &wg, &wireguardif_init, &ip_input);
    if (!s_netif) { ESP_LOGE(TAG, "netif_add failed"); return ESP_FAIL; }
    netif_set_up(s_netif);   /* NOT set_default: encrypted traffic egresses the STA */

    s_npeers = 0;
    int ok = 0;
    for (int i = 0; i < cfg->n_peers; i++)
        if (add_one_peer(&cfg->peers[i]) == ESP_OK) ok++;

    /* store our overlay ip (without CIDR) for status */
    strlcpy(c->tunnel_ip, cfg->tunnel_ip, sizeof(c->tunnel_ip));
    char *slash = strchr(c->tunnel_ip, '/'); if (slash) *slash = '\0';

    ESP_LOGI(TAG, "wg up: ip=%s peers=%d/%d", c->tunnel_ip, ok, cfg->n_peers);
    return (ok > 0 || cfg->n_peers == 0) ? ESP_OK : ESP_FAIL;
}

esp_err_t olm_wg_add_peer(olm_ctx_t *c, const olm_peer_t *p)
{
    (void)c;
    if (!s_netif) return ESP_ERR_INVALID_STATE;
    return add_one_peer(p);
}

esp_err_t olm_wg_remove_peer(olm_ctx_t *c, const char *pubkey_b64)
{
    (void)c;
    if (!s_netif) return ESP_ERR_INVALID_STATE;
    for (int i = 0; i < s_npeers; i++) {
        if (strcmp(s_peers[i].pub, pubkey_b64) == 0) {
            wireguardif_disconnect(s_netif, s_peers[i].idx);
            wireguardif_remove_peer(s_netif, s_peers[i].idx);
            /* compact */
            s_peers[i] = s_peers[--s_npeers];
            ESP_LOGI(TAG, "removed peer %.8s..", pubkey_b64);
            return ESP_OK;
        }
    }
    return ESP_ERR_NOT_FOUND;
}

void olm_wg_down(olm_ctx_t *c)
{
    if (!s_netif) return;
    for (int i = 0; i < s_npeers; i++) {
        wireguardif_disconnect(s_netif, s_peers[i].idx);
        wireguardif_remove_peer(s_netif, s_peers[i].idx);
    }
    s_npeers = 0;
    wireguardif_shutdown(s_netif);
    netif_remove(s_netif);
    wireguardif_fini(s_netif);
    s_netif = NULL;
    if (c) c->tunnel_ip[0] = '\0';
    ESP_LOGI(TAG, "wg down");
}
