# Mesh client (`esp_olm`)

A Portal is a **first-class node on the asmltr mesh**: its firmware speaks Pangolin's `olm` protocol
natively, so it reaches the asmltr server over WireGuard the same way any other mesh client does —
over its own Wi-Fi when a known network is configured, relayed through the paired phone otherwise.

This is implemented by [`esp_olm`](https://github.com/jarethmt/asmltr/tree/main/portal/firmware/components/esp_olm),
a from-scratch C/ESP-IDF implementation of the olm control protocol. The official olm client is Go and
the Pangolin CLI only ships for desktop OSes, so an embedded node needs its own implementation of the
wire protocol — which is exactly what `esp_olm` is.

## Why a native protocol client (not a bridge)

Pangolin's model is **sites** (which *host* services and are *reached by* clients) versus **clients**
(olm — which *reach* services). The only outbound-consumer primitive is olm, and olm is a stateful
daemon: a persistent control channel, periodic re-registration, dynamic peer updates, NAT holepunch.
A dumb static WireGuard peer can be a *reachable* node but cannot *initiate* to mesh services the way a
Portal must. So the Portal speaks olm for real.

## What it does

```
get-token (HTTPS)  ──▶  control websocket (WSS)  ──▶  register  ──▶  olm/wg/connect  ──▶  WireGuard tunnel
   POST /api/v1/           /api/v1/ws?token=..        olm/wg/         { tunnelIP,           (one peer per
   auth/olm/get-token      &clientType=olm            register        sites[] }             granted site)
```

1. **Token** — `POST /api/v1/auth/olm/get-token` with `{ olmId, secret, orgId }` → a session token.
2. **Control channel** — a WebSocket to `/api/v1/ws?token=…&clientType=olm`, carrying JSON
   `{type, data, configVersion}` messages (binary frames are gzip; fragments are reassembled).
3. **Register** — on connect, send `olm/wg/register { publicKey, relay: true, … }`. The dongle's
   X25519 keypair is generated on-device (or provisioned) and its public key is registered here.
4. **Bring-up** — the server replies `olm/wg/connect { tunnelIP, sites[] }`; the client configures a
   WireGuard interface at `tunnelIP` with one peer per granted site.
5. **Keepalive + live updates** — an app-level `olm/ping` holds the session; `olm/wg/peer/add|remove|
   update` reconfigure peers at runtime.

## Relay mode

The Portal registers with `relay: true`, so every peer is reached **through the exit node's public
relay endpoint** (hub-and-spoke) rather than by direct NAT holepunch. That is the right topology for a
fixed appliance, and it lets the firmware skip olm's entire holepunch/NAT-traversal subsystem. The
desktop-only surface — DNS proxy, subnet router, gateway mode, exit-node default-route, JIT DNS
connect, UAPI — is intentionally omitted too.

## Footprint

Built on the vendored
[`esp_wireguard`](https://github.com/jarethmt/asmltr/tree/main/portal/firmware/components/esp_wireguard)
(trombik's, BSD-3, with its headers exported for the multi-peer `wireguardif` API + base64 + refc
X25519). The whole mesh stack — olm + WireGuard + TLS + gzip — co-resides with BLE, USB, Wi-Fi, and the
display, and still leaves **~52% of the app partition free** on an ESP32-S3 (N16R8).

## Configuration

Nothing is hardcoded. The firmware reads its config from the NVS `portal` namespace:

| key | source |
|-----|--------|
| `olm_server`, `olm_id`, `olm_secret`, `olm_org` | minted by the core ([`provisionDongle`](index.md)) |
| `wifi_ssid`, `wifi_pass` | entered by the user in the app |

The app writes all of it to the dongle over the BLE **CFG** characteristic at provisioning time (see
[Control protocol](control-protocol.md)); the dongle persists it to NVS and joins the mesh. On boot,
if the config is present the dongle comes up as a mesh node; if not, it stays BLE/phone-only.

## Public API

```c
esp_err_t esp_olm_start(const esp_olm_config_t *cfg);  // spawns a managed task: token→ws→register→tunnel, with reconnect
void      esp_olm_stop(void);
bool      esp_olm_is_connected(void);
const char *esp_olm_tunnel_ip(void);   // overlay IP once connected
const char *esp_olm_public_key(void);  // this node's WG public key
```
