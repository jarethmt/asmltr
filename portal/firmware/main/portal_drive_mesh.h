/* asmltr Portal — mesh drive agent (phone-bypass transport, docs/portal/drive.md §2).
 *
 * When the dongle is a live mesh node, it can be the OTHER end of the generic-driver relay itself —
 * long-polling the core's exec queue over the WireGuard overlay and dispatching commands through the
 * SAME engine_submit_exec() path the BLE `exec` char uses. No phone in the loop. The relay
 * (core/src/portal/drive.js) is transport-agnostic by design, so this is a second rail, not a fork.
 *
 * Reachability of base_url is over the encrypted tunnel, so it's plain HTTP (no TLS). No-op until a
 * base_url+id are provisioned AND esp_olm reports the tunnel up.
 */
#pragma once
#include <stdbool.h>
#include <stdint.h>

/* Start the agent. base_url e.g. "http://10.201.0.9:3023", id = the relay :id the core pushes to.
 * Either NULL/empty → no-op. Safe to call once at boot; the task self-gates on the tunnel. */
void portal_drive_mesh_start(const char *base_url, const char *id, const char *token);

/* True while the agent is the live driver (tunnel up + provisioned). The ioback transport selector
 * routes the host's CDC return stream to the mesh POST when this is true (ahead of Wi-Fi/BLE). */
bool portal_drive_mesh_active(void);

/* Feed host-return (CDC) bytes to the agent for POST back to the core. Called from the ioback task. */
void portal_drive_mesh_ioback(const uint8_t *data, int len);

/* BLE calls this when a command arrives over BLE, so the host's return stream goes back over BLE/Wi-Fi
 * (not stolen by the mesh POST). The mesh agent reclaims the sink whenever IT submits a command. */
void portal_drive_mesh_yield(void);
