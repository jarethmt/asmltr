# Portal — BLE device provisioning from the app

A **Portal** is a small BLE dongle (ESP32-S3) that asmltr discovers, inspects, registers, and — in
time — drives, directly from the web GUI / app. It's how an asmltr instance reaches a physical device
to enrol or provision it without a cable to your laptop: you carry the controller (your phone, running
the asmltr app) and the dongle is reachable over Bluetooth LE.

Status today: **discover → connect → read identity → register** works end-to-end from the app. The
*control* side (writing to the dongle to load/run provisioning modules) is the next phase — see
[Roadmap](#roadmap) below.

## The one architecture decision that matters

The asmltr app is a thin native shell that loads the **dashboard remotely** (`www/index.html` does a
`location.replace` to your instance's dashboard URL). That remote page is **not** the Capacitor server
origin, so **Capacitor plugins do not bridge to it** — `Capacitor.isPluginAvailable('BluetoothLe')` is
`false` in the app even when the plugin is compiled in and registered. This is why the app already does
*all* of its native work through **`window.AsmltrNative`** — an `addJavascriptInterface` bridge that
*is* attached to every page the WebView loads, remote origin included.

So BLE follows the same rule:

| Where the dashboard runs | BLE path |
|---|---|
| **asmltr app** (Android/iOS webview) | **native `AsmltrNative` bridge** (`bleStartScan` / `bleConnectAndRead` / …) |
| **Desktop Chrome / Edge** | **Web Bluetooth** via `@capacitor-community/bluetooth-le` (`BleClient`) |
| Firefox / Safari | unsupported (no Web Bluetooth) |

`insights/dashboard/src/views/Portal.vue` picks the path at runtime: if `window.AsmltrNative.bleStartScan`
exists it uses the native bridge, otherwise `BleClient`. **Do not** reach for a Capacitor BLE plugin for
in-app features — it won't bridge to the remote dashboard. Add a native method to `NativeConfig`
(`mobile/native/java/NativeConfig.java`) and call it through `window.AsmltrNative`.

## The dongle's GATT

Advertises with the name prefix **`asmltr-portal-`** (e.g. `asmltr-portal-66DA`, the BT-MAC suffix).

| UUID | role |
|------|------|
| `00657665-5f61-736d-6c74-72706f727401` | **service** (in the scan response) |
| `…7402` | **INFO** — READ; a JSON identity string `{"kind":"asmltr-portal","name":…,"fw":…,"trust":…}` |
| `…7403` | **LOAD** — WRITE; push a signed module (stubbed) |
| `…7404` | **RUN** — WRITE; trigger a loaded/inline module (stubbed) |
| `…7405` | **STATUS** — NOTIFY; progress/output lines |

Firmware lives in the separate portal project (`asmltr-portal/firmware`). `LOAD`/`RUN` currently
acknowledge-only; the loader engine + trust-gate are the control phase.

## Native bridge (`AsmltrNative`) BLE surface

Added to `NativeConfig.java`, callable from the dashboard JS as `window.AsmltrNative.*`:

- `bleScanPermitted()` → whether `BLUETOOTH_SCAN` is granted.
- `bleStartScan()` → start an unfiltered LE scan; accumulate **named** advertisers. Returns `ok` /
  `bt-off` / `no-permission` / `no-adapter`. The dashboard filters results by the `asmltr-portal-` prefix.
- `bleResults()` → JSON array `[{id, name, rssi}]` (polled while scanning).
- `bleStopScan()`.
- `bleConnectAndRead(deviceId, serviceUuid, charUuid)` → GATT connect → discover → read one
  characteristic. Returns `ok` or an error string.
- `bleGattResult()` → JSON `{state, value, error}` where `state` ∈ `connecting|connected|reading|done|
  error|disconnected` (polled until `done`).
- `bleDisconnect()`.

Android needs the `BLUETOOTH_SCAN` (shown as **"Nearby devices"**, *not* Location) and
`BLUETOOTH_CONNECT` runtime permissions; `MainActivity` requests both on launch, and
`patch-android.js` declares `BLUETOOTH_SCAN` with `neverForLocation` in the manifest.

## The flow

1. **Scan** — Portal view starts a scan, lists `asmltr-portal-*` advertisers (name + RSSI).
2. **Connect** — GATT connect + read `INFO` → shows the dongle's identity (`kind / fw / trust`).
3. **Register** — files it in the device registry (`POST /v2/devices {kind:"appliance"}` +
   `/transports {transport:"ble", address, params}`); it then appears in **Fleet**. See
   [Device registry](DEVICE-REGISTRY.md).

`trust: unpaired` until a trust handshake is done — that's part of the control phase and the
[Cast / trust](CAST.md) model.

## Roadmap

- **Control (next):** native GATT **write** (`LOAD`/`RUN`) so the app can push a **signed** module and
  trigger it — the dongle then provisions the target it's plugged into. The firmware loader engine
  (declarative step-DSL → sandboxed WASM) + the signing/trust gate land here. Modules are signed by the
  asmltr identity (see `mesh/sshkey`) and only a paired, trusted principal may load/run — that gate is
  what keeps the Portal a tool and not a BadUSB gadget.
- **Discovery UI:** surfacing in-range dongles across any web-GUI device, not just the paired phone.
