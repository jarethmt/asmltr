/* esp_olm — internal shared types and module interfaces. Not a public header. */
#pragma once

#include "esp_olm.h"
#include <stdint.h>
#include <stddef.h>
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"

#define OLM_KEYLEN       32           /* raw X25519 key length                       */
#define OLM_B64KEYLEN    45           /* 32 bytes base64 == 44 chars + NUL           */
#define OLM_MAX_PEERS    8            /* exit node + sites we can hold at once        */
#define OLM_ENDPOINT_LEN 96           /* "host:port"                                 */
#define OLM_ALLOWED_LEN  160          /* comma-separated CIDR list                   */

/* A WireGuard keypair (raw + base64 forms). */
typedef struct {
    uint8_t priv[OLM_KEYLEN];
    uint8_t pub[OLM_KEYLEN];
    char    priv_b64[OLM_B64KEYLEN];
    char    pub_b64[OLM_B64KEYLEN];
} olm_keypair_t;

/* One peer to program into the WireGuard interface (exit node or a site). */
typedef struct {
    char     public_key[OLM_B64KEYLEN];
    char     endpoint[OLM_ENDPOINT_LEN];   /* resolved host:port (relay endpoint in relay mode) */
    char     allowed_ips[OLM_ALLOWED_LEN]; /* comma-separated CIDRs                              */
    int      site_id;                      /* -1 for the exit node                              */
    uint16_t keepalive;                    /* persistent-keepalive seconds (0 = default)         */
} olm_peer_t;

/* Parsed `olm/wg/connect` payload (the subset relay mode needs). */
typedef struct {
    char       tunnel_ip[48];      /* our overlay address, may carry /CIDR            */
    char       utility_subnet[48]; /* reserved for DNS proxy (unused in relay mode)   */
    olm_peer_t peers[OLM_MAX_PEERS];
    int        n_peers;
} olm_connect_t;

/* Forward decl of the one global context (defined in esp_olm.c). */
typedef struct olm_ctx olm_ctx_t;

/* ---- crypto (olm_crypto.c) ------------------------------------------------ */
esp_err_t olm_b64_encode(const uint8_t *in, size_t len, char *out, size_t outlen);
int       olm_b64_decode(const char *in, uint8_t *out, size_t outlen); /* bytes, or -1 */
/* Load the key from priv_b64 if non-empty, else from NVS, else generate+persist. */
esp_err_t olm_crypto_key_init(const char *priv_b64_or_null, olm_keypair_t *out);

/* ---- http (olm_http.c) ---------------------------------------------------- */
/* POST get-token; on success writes the session token (NUL-terminated) to token_out. */
esp_err_t olm_http_get_token(olm_ctx_t *c, char *token_out, size_t token_len);

/* ---- websocket (olm_ws.c) ------------------------------------------------- */
/* A decoded inbound control message: type string + raw JSON `data` object text.
 * The ws layer also emits one synthetic event, OLM_EVT_WS_CONNECTED, right after the
 * socket opens so the protocol layer can send its registration. */
#define OLM_EVT_WS_CONNECTED "@ws_connected"
typedef void (*olm_ws_msg_cb_t)(olm_ctx_t *c, const char *type, const char *data_json);
esp_err_t olm_ws_connect(olm_ctx_t *c, const char *token, olm_ws_msg_cb_t on_msg);
esp_err_t olm_ws_send(olm_ctx_t *c, const char *type, const char *data_json); /* sends {type,data} */
void      olm_ws_disconnect(olm_ctx_t *c);
bool      olm_ws_is_up(olm_ctx_t *c);

/* ---- protocol (olm_proto.c) ----------------------------------------------- */
/* The dispatcher passed to olm_ws_connect; drives register -> connect -> peers. */
void      olm_proto_on_msg(olm_ctx_t *c, const char *type, const char *data_json);
/* Send the registration message (called once the ws is up). */
esp_err_t olm_proto_register(olm_ctx_t *c);

/* ---- wireguard (olm_wg.c) ------------------------------------------------- */
esp_err_t olm_wg_up(olm_ctx_t *c, const olm_connect_t *cfg);
esp_err_t olm_wg_add_peer(olm_ctx_t *c, const olm_peer_t *p);
esp_err_t olm_wg_remove_peer(olm_ctx_t *c, const char *pubkey_b64);
void      olm_wg_down(olm_ctx_t *c);

/* ---- shared context ------------------------------------------------------- */
struct olm_ctx {
    esp_olm_config_t  cfg;          /* owned copy (strings duplicated)                */
    char              server_host[128];
    char              server_url[160];
    bool              server_tls;   /* https -> wss                                   */

    olm_keypair_t     keys;
    volatile esp_olm_state_t state;
    char              tunnel_ip[48];
    int               config_version;

    TaskHandle_t      task;
    EventGroupHandle_t events;
    volatile bool     stop;
    volatile bool     registered;

    void             *ws;           /* esp_websocket_client_handle_t (opaque here)    */
    void             *wg;           /* wireguardif/esp_wireguard state (opaque here)   */
};

/* set state + fire the on_state callback */
void olm_set_state(olm_ctx_t *c, esp_olm_state_t st);
