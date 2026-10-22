/*
 * esp_olm — a native ESP-IDF client for the Pangolin `olm` mesh protocol.
 *
 * Pangolin (https://github.com/fosrl/pangolin) is a self-hostable overlay-mesh control plane.
 * Its machine client, `olm` (https://github.com/fosrl/olm), joins the mesh by:
 *   1. POST /api/v1/auth/olm/get-token  { olmId, secret, orgId } -> session token
 *   2. WSS  /api/v1/ws?token=..&clientType=olm   (JSON control channel; frames may be gzip)
 *   3. register its WireGuard public key (`olm/wg/register`)
 *   4. receive `olm/wg/connect` { tunnelIP, sites[], ... } and bring up a WireGuard tunnel
 *   5. keepalive (`olm/ping`) and react to live peer add/remove/update pushes
 *
 * This component speaks that protocol natively so a small device (e.g. an ESP32-S3) can be a
 * first-class mesh node — no Go `olm`/`pangolin` CLI, which only ships for desktop OSes.
 *
 * Scope: relay mode (hub-and-spoke through the exit node; no NAT holepunch) — the right topology
 * for a fixed appliance. Deferred vs. the Go client: DNS proxy, subnet router, gateway mode,
 * exit-node default-route, JIT DNS connect, UAPI. Requires an IP network (Wi-Fi STA) already up.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */
#pragma once

#include <stdbool.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Lifecycle state of the mesh client. */
typedef enum {
    ESP_OLM_DISCONNECTED = 0, /* not started, or torn down                        */
    ESP_OLM_CONNECTING,       /* fetching token / opening the control websocket   */
    ESP_OLM_REGISTERING,      /* websocket up; register sent; awaiting wg/connect  */
    ESP_OLM_CONNECTED,        /* tunnel up (wg/connect applied, peers configured)  */
    ESP_OLM_ERROR,            /* server sent olm/error or a fatal local error      */
} esp_olm_state_t;

typedef void (*esp_olm_state_cb_t)(esp_olm_state_t state, void *user_ctx);
typedef void (*esp_olm_error_cb_t)(const char *code, const char *message, void *user_ctx);

typedef struct {
    /* --- server + identity (required; wg_private_key_b64 optional) --- */
    const char *server_url;         /* origin, e.g. "https://mesh.example.com" (no trailing /) */
    const char *olm_id;             /* Pangolin olm client id                                  */
    const char *secret;             /* Pangolin olm client secret                              */
    const char *org_id;             /* org slug, e.g. "eve"                                    */
    const char *wg_private_key_b64; /* base64 X25519 private key; NULL/"" -> generate + persist */

    /* --- behavior (sane defaults when zero/NULL) --- */
    bool        relay;              /* request relay path (no holepunch). Recommended: true     */
    const char *olm_version;        /* reported version, default "1.10.1" (gates gzip etc.)     */
    const char *olm_agent;          /* reported agent, default "esp-olm"                        */
    bool        skip_tls_verify;    /* dev only: skip server cert verification                  */
    const char *ca_pem;             /* optional PEM CA bundle to pin; NULL -> IDF cert bundle   */

    /* --- callbacks (optional; invoked from the olm task) --- */
    esp_olm_state_cb_t on_state;
    esp_olm_error_cb_t on_error;
    void              *user_ctx;
} esp_olm_config_t;

/**
 * Start the client. Copies @p cfg (and the strings it points to). Spawns a managed task that
 * fetches a token, opens the control websocket, registers, brings up the WireGuard tunnel, and
 * keeps it alive with automatic reconnect/backoff. Idempotent-ish: returns ESP_ERR_INVALID_STATE
 * if already started. Network (STA) must already be connected.
 */
esp_err_t esp_olm_start(const esp_olm_config_t *cfg);

/** Stop the client, tear down the tunnel + control channel, and free resources. */
void esp_olm_stop(void);

/** Current lifecycle state. */
esp_olm_state_t esp_olm_get_state(void);

/** True iff the tunnel is up (state == ESP_OLM_CONNECTED). */
bool esp_olm_is_connected(void);

/** Overlay (tunnel) IP assigned by the server; "" until CONNECTED. */
const char *esp_olm_tunnel_ip(void);

/** This client's base64 WireGuard public key; "" until esp_olm_start() has run. */
const char *esp_olm_public_key(void);

#ifdef __cplusplus
}
#endif
