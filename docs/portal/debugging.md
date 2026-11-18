# Debugging the Portal mesh-drive chain

The phone-bypass drive path spans dongle firmware → WireGuard overlay → a Pangolin resource → newt →
the core's drive listener. This page is the reliable, repeatable way to see the **whole chain** so a
failure can be localised in one pass instead of blind power-cycling.

## The chain, end to end

```
Eve ──POST /v2/portal/<id>/exec──▶ core :3023  (shared portalDrive queue)
                                      │
dongle drive agent ──GET exec/next──▶ drive-only listener :3099 ◀─newt (eve-core site)◀─WG overlay◀─ dongle
          │  (engine_submit_exec → HID into the host)                 10.201.0.12:3099 ⇢ 127.0.0.1:3099
          └──POST /io (host CDC return)──────────────────────────────────────────────────────────────▶
```

## Observability (hardened 2026-10-24)

The dongle's UART console is **not** exposed over USB (TinyUSB owns the port for HID+CDC), so logs come
out over BLE. The weak point used to be that this was a live-only NOTIFY — connect late and the boot
logs were already gone. Now:

- **Firmware keeps a boot-to-now log ring in PSRAM** (`portal_log.c`, 256 lines) capturing every
  ESP_LOG line regardless of connection state.
- **On STATUS subscribe, the firmware REPLAYS the whole ring** (`portal_log_replay`, triggered in
  `ble.c`'s `BLE_GAP_EVENT_SUBSCRIBE`). So connecting the app's **Portal screen** at any time dumps the
  full history — bracketed by `=== log replay (boot->now) ===` / `=== end replay ===`.
- The app forwards STATUS lines to the core sink: **`GET /v2/portal/trace`** (ring of 800, on :3023).

> The trace relay only flows while the **foreground Portal screen** is connected (not the background
> relay). That's expected — it's a debug aid. For a clean capture: open the Portal screen, connect,
> wait for the replay, then read the sink.

## One-pass debug procedure

Run these from the asmltr host. Each step isolates one link; the first that's wrong is the fault.

### 0. Capture the dongle's own trace (do this first)
```bash
curl -s -X DELETE http://127.0.0.1:3023/v2/portal/trace      # clear
# → on the phone: open the Portal screen, connect to the dongle, wait ~10s for the replay
curl -s http://127.0.0.1:3023/v2/portal/trace | python3 -c 'import sys,json;[print(l) for l in json.load(sys.stdin)["lines"]]'
```
Look for, in order: `STA has IP` → `wg public key` / register → `connect: tunnelIP=… peers=N` →
`relay overlay route: 10.200.0.0/15 (via exit node)` → `peer site=-1 … allowed=10.200.0.0/15` →
`mesh drive agent: base=http://10.201.0.12:3099 id=…` → `drive agent polling …` → `drive agent alive: poll #…`.

The drive agent lines tell you the fault directly:
- `mesh drive NOT provisioned (drive_url='' …)` → the drive fields never reached NVS. Reprovision with
  the **current** dashboard (force-close the app first so it isn't serving a cached build).
- `GET: no response (ESP_ERR_HTTP_CONNECT…)` → the WG **route** to `10.201.0.12` is missing (see step 3).
- `GET: HTTP 401` → reached the listener but the **token** is wrong (NVS `drive_tok` vs `.env`).
- `drive agent alive: poll #N` with no errors → it's polling fine; push a command and watch `/io`.

### 1. Is the dongle on the mesh?
LED dot (top-right of the LCD): 🟢 green = on the mesh (direct) · 🟣 violet = Wi-Fi P2P · 🔵 blue = BLE ·
🔴 red = disconnected. Green is the prerequisite for the drive agent to poll.
```bash
# Pangolin's view (online = control-plane keepalive is live)
node -e 'require("./shared/loadenv");const{meshConfig,vaultKeys}=require("./mesh/config");const{PangolinClient}=require("./mesh/pangolin");const v=require("./shared/vault");const g=async k=>{try{const s=await v.getSecret(k);return s&&s.value?s.value:null}catch(_){return null}};(async()=>{const c=meshConfig(),k=vaultKeys(c);const pg=new PangolinClient({apiBase:c.apiBase,email:await g(k.adminEmail),password:await g(k.adminPassword)});await pg.login();const cl=(await pg.listClients(c.org)).data;const d=(cl.clients||cl||[]).find(x=>/portal/.test(x.name));console.log("online:",d&&d.online)})()'
```

### 2. Is the drive agent actually polling the listener?
```bash
ss -tn | grep ':3099'         # an ESTABLISHED conn from newt = the agent is polling over the mesh
```
Nothing here while the dongle is green ⇒ a route or provisioning fault (see the agent log lines above).

### 3. Is the overlay route to the resource up?
```bash
journalctl -u newt-eve-mesh.service -n 20 --no-pager   # expect "Added target … 10.201.0.12/32 … 3099"
```
On the dongle side, the firmware must route the utility subnet through the exit node — the trace line
`relay overlay route: 10.200.0.0/15` (and `peer site=-1 … allowed=10.200.0.0/15`) confirms it. If the
connect shows `peers=0`, the server didn't hand the dongle an exit node and nothing is routable.

### 4. Is the listener healthy + the token right?
```bash
TOK=$(grep '^ASMLTR_PORTAL_DRIVE_TOKEN=' .env | cut -d= -f2)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3099/v2/portal/x/exec/next           # → 401
curl -s -H "Authorization: Bearer $TOK" http://127.0.0.1:3099/v2/portal/x/exec/next            # → {}
```

### 5. Fire a command (acceptance test)
```bash
ID=asmltr-portal-66da
KS='{GUI+r}{DELAY:700}firefox https://youtu.be/dQw4w9WgXcQ{ENTER}'
curl -s -X POST http://127.0.0.1:3023/v2/portal/$ID/exec -H 'Content-Type: application/json' \
  -d "{\"mode\":\"hid\",\"data\":\"$(printf '%s' "$KS" | base64 -w0)\"}"
```
Watch the trace for `exec over mesh: mode=hid len=…`; the host should act within a poll cycle.

## Where each log line is emitted
| Line | File |
|------|------|
| `STA has IP; starting mesh client` | `main/portal_olm.c` |
| `connect: tunnelIP=… peers=N` | `components/esp_olm/src/olm_proto.c` |
| `relay overlay route: …` · `wg up: …` · `peer site=…` | `components/esp_olm/src/olm_wg.c` |
| `mesh drive agent: base=…` · `drive agent polling/alive` · `GET: …` · `exec over mesh` | `main/portal_drive_mesh.c` |
| `=== log replay … ===` | `main/portal_log.c` |

## Provisioned NVS keys (namespace `portal`)
`olm_server, olm_id, olm_secret, olm_org, wifi_ssid, wifi_pass` + optional drive rail
`drive_url, drive_id, drive_tok`. Written by the dashboard's "Provision onto mesh" over BLE CFG char
`0x0B`; the firmware writes only keys it recognises (`main/ble.c` `CFG_KEYS`).
