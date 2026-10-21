// portalRelay — the background auto-connect relay between the asmltr server and a paired Portal dongle
// (docs/PORTAL-DRIVE.md §2 + DESIGN §5). When the app is running and a PAIRED Portal is in range, it
// opportunistically connects over BLE and relays BOTH directions:
//
//   server → app:  { type: 'portal.exec', mode: 'hid'|'cdc', data: <base64> }  → write [mode][data] to `exec`
//   app → server:  { type: 'portal.io',   data: <base64> }                      ← drained from `ioback`
//   app → server:  { type: 'portal.present', paired, name, host_os }            ← presence / kill-switch probe
//
// Design constraints:
//  • NATIVE ONLY — in the app the dashboard is a remote page, so all BLE goes through window.AsmltrNative
//    (the addJavascriptInterface). Desktop browsers can't background-scan, so the relay is dormant there.
//  • BATTERY-CHEAP — no persistent connection and no tight polling. We connect ON DEMAND (when a
//    portal.exec arrives, or for a presence probe), capture ioback for a short window, then disconnect
//    after an idle timeout. The discovery scan is a short window on a long interval.
//  • YIELDS TO THE FOREGROUND — NativeConfig holds a SINGLE gatt, so while the Portal view owns the
//    connection (user driving manually) the relay pauses to avoid stomping it (pause()/resume()).
//
// The dongle-facing half below is complete and self-contained. The SERVER message channel (how the
// device-gateway delivers portal.exec to the app and where portal.io/portal.present go) is NOT owned
// here — the core team owns that transport. Wire it via setServerSink()/handleServerMessage() and the
// TODO(relay) markers. Until it's wired, the relay stays dormant (it has nothing to relay).

const SVC_UUID = '00657665-5f61-736d-6c74-72706f727401'
const INFO_UUID = '00657665-5f61-736d-6c74-72706f727402'   // READ   — JSON identity { kind,name,fw,trust,host_os? }
const EXEC_UUID = '00657665-5f61-736d-6c74-72706f727408'   // WRITE  — chunked [flags][rsvd][seqBE] → [u8 mode][data]
const IOBACK_UUID = '00657665-5f61-736d-6c74-72706f727409' // NOTIFY — host's CDC return stream
const NAME_PREFIX = 'asmltr-portal-'
const EXEC_MODE = { hid: 0x01, cdc: 0x02 }

const SCAN_MS = 4000          // short discovery window
const PRESENCE_INTERVAL = 5 * 60 * 1000 // opportunistic presence probe — long interval (battery)
const IOBACK_POLL_MS = 500    // only while connected during/after a drive
const IDLE_DISCONNECT_MS = 15000 // drop the link this long after the last activity

const AN = (typeof window !== 'undefined' && window.AsmltrNative && typeof window.AsmltrNative.bleStartScan === 'function')
  ? window.AsmltrNative : null

// --- small helpers (self-contained so this module doesn't depend on the Portal view) -------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function b64ToBytes(b64) { const bin = atob(b64); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a }
function bytesToB64(bytes) { let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s) }

// Same load-style framing as the Portal view's chunkWrite (docs/PORTAL-DRIVE.md §1) — the firmware
// reassembles [flags][rsvd][seqBE] across chunks, then splits the payload into [mode][data].
async function chunkWriteExec(payload) {
  const mtu = (AN && AN.bleMtuSize) ? (AN.bleMtuSize() || 23) : 185
  const chunkData = Math.max(16, Math.min(180, mtu - 3 - 4))
  let seq = 0
  for (let off = 0; off < payload.length; off += chunkData) {
    const slice = payload.subarray(off, Math.min(off + chunkData, payload.length))
    const first = off === 0 ? 0x01 : 0x00
    const last = (off + chunkData >= payload.length) ? 0x02 : 0x00
    const frame = new Uint8Array(4 + slice.length)
    frame[0] = first | last; frame[1] = 0; frame[2] = (seq >> 8) & 0xff; frame[3] = seq & 0xff
    frame.set(slice, 4)
    const r = AN.bleWrite(SVC_UUID, EXEC_UUID, bytesToB64(frame))
    if (r !== 'ok') throw new Error('exec write: ' + r)
    // wait for the write to ack before the next frame (write-with-response ordering)
    let done = false
    for (let i = 0; i < 50; i++) {
      let st; try { st = JSON.parse(AN.bleWriteState() || '{}') } catch { st = {} }
      if (st.state === 'done') { done = true; break }
      if (st.state === 'error') throw new Error(st.error || 'exec write error')
      await sleep(80)
    }
    if (!done) throw new Error('exec write timed out')
    seq++
  }
}

// --- relay state ---------------------------------------------------------------------------------
let running = false
let paused = false            // true while the Portal view owns the single native gatt
let serverSink = null         // (msg) => void — set by the app's device-gateway glue (TODO below)
let presenceTimer = null
let iobackTimer = null
let idleTimer = null
let connected = false
let busy = false              // a connect/relay op is in flight (serialize access to the one gatt)
let currentDeviceId = null
let currentInfo = null

function emit(msg) {
  // TODO(relay): wire to the server message channel. `serverSink` must push `msg` up to the asmltr
  // core over the device-gateway (the same transport that delivers portal.exec DOWN to this app).
  // The core team owns that channel; until setServerSink() is called this is a no-op and the relay's
  // app→server half is dark (the dongle-facing half still works for the in-app Portal console).
  if (typeof serverSink === 'function') { try { serverSink(msg) } catch (_) { /* ignore */ } }
}

// Short scan → return the first in-range asmltr-portal-* advertiser, or null.
async function scanForPortal() {
  if (!AN) return null
  if (AN.bleStartScan() !== 'ok') return null
  try {
    const deadline = Date.now() + SCAN_MS
    while (Date.now() < deadline) {
      try {
        for (const d of JSON.parse(AN.bleResults() || '[]')) {
          if (/^asmltr-portal-/i.test(d.name || '')) return { deviceId: d.id, name: d.name }
        }
      } catch (_) { /* transient */ }
      await sleep(600)
    }
  } finally { try { AN.bleStopScan() } catch (_) { /* ignore */ } }
  return null
}

// Connect + read INFO. Returns the parsed identity or throws. Leaves the gatt open on success.
async function connectAndReadInfo(deviceId) {
  if (AN.bleConnectAndRead(deviceId, SVC_UUID, INFO_UUID) !== 'ok') throw new Error('connect failed')
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    let res; try { res = JSON.parse(AN.bleGattResult() || '{}') } catch { res = {} }
    if (res.state === 'done') {
      connected = true; currentDeviceId = deviceId
      try { AN.bleSubscribeIo(SVC_UUID, IOBACK_UUID) } catch (_) { /* best-effort */ }
      startIobackPump()
      try { return JSON.parse(res.value) } catch { return { _raw: res.value } }
    }
    if (res.state === 'error' || res.state === 'disconnected') throw new Error('connect: ' + (res.error || res.state))
    await sleep(400)
  }
  throw new Error('connect timed out')
}

function startIobackPump() {
  if (iobackTimer) return
  iobackTimer = setInterval(() => {
    try {
      const arr = JSON.parse(AN.bleNotificationsIo() || '[]')
      for (const b64 of arr) if (b64) emit({ type: 'portal.io', data: b64 }) // already base64 — forward verbatim
    } catch (_) { /* ignore */ }
  }, IOBACK_POLL_MS)
}

function dropConnection() {
  if (iobackTimer) { clearInterval(iobackTimer); iobackTimer = null }
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
  try { if (AN) AN.bleDisconnect() } catch (_) { /* ignore */ }
  connected = false; currentDeviceId = null; currentInfo = null
}

function bumpIdle() {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => { dropConnection() }, IDLE_DISCONNECT_MS)
}

// Ensure we hold a connection to a PAIRED Portal (scan+connect if needed). Returns true if connected
// to a trusted dongle. Respects pause (foreground owns the gatt) and serializes with `busy`.
async function ensureConnectedPaired() {
  if (!AN || paused) return false
  if (connected) return true
  if (busy) return false
  busy = true
  try {
    const dev = await scanForPortal()
    if (!dev) return false
    currentInfo = await connectAndReadInfo(dev.deviceId)
    if (!currentInfo || currentInfo.trust !== 'paired') { dropConnection(); return false }
    return true
  } catch (_) {
    dropConnection(); return false
  } finally { busy = false }
}

// --- public surface ------------------------------------------------------------------------------

// Call when a message arrives from the server over the device-gateway (TODO: the app's gateway glue
// must route portal.* messages here). Handles portal.exec (drive the dongle) and portal.present probes.
export async function handleServerMessage(msg) {
  if (!msg || !running) return
  if (msg.type === 'portal.exec') {
    if (!(await ensureConnectedPaired())) { emit({ type: 'portal.io', data: '', error: 'no paired portal in range' }); return }
    try {
      const mode = EXEC_MODE[msg.mode] != null ? EXEC_MODE[msg.mode] : EXEC_MODE.hid
      const data = msg.data ? b64ToBytes(msg.data) : new Uint8Array(0)
      const payload = new Uint8Array(1 + data.length)
      payload[0] = mode; payload.set(data, 1)
      await chunkWriteExec(payload)
      bumpIdle() // keep the link briefly to capture the ioback response, then auto-disconnect
    } catch (e) { emit({ type: 'portal.io', data: '', error: String(e.message || e) }) }
  } else if (msg.type === 'portal.present') {
    const ok = await ensureConnectedPaired()
    emit({
      type: 'portal.present',
      paired: ok && !!(currentInfo && currentInfo.trust === 'paired'),
      name: (currentInfo && currentInfo.name) || null,
      host_os: (currentInfo && currentInfo.host_os) || null,
    })
    if (ok) bumpIdle()
  }
}

// The app's device-gateway glue sets this so app→server messages (portal.io/portal.present) get sent.
export function setServerSink(fn) { serverSink = typeof fn === 'function' ? fn : null }

// Pause/resume so the foreground Portal view can own the single native gatt without contention.
export function pausePortalRelay() { paused = true; if (connected) dropConnection() }
export function resumePortalRelay() { paused = false }

export function startPortalRelay() {
  if (running || !AN) return
  running = true
  // Opportunistic presence probe on a long interval — proves a paired Portal is around (and refreshes
  // the kill-switch presence) without holding a connection. Connects only to answer, then idles out.
  presenceTimer = setInterval(() => { handleServerMessage({ type: 'portal.present' }) }, PRESENCE_INTERVAL)
}

export function stopPortalRelay() {
  running = false
  if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null }
  dropConnection()
}

export const portalRelayActive = () => !!AN

// --- transport: the core poll-relay (core/src/portal/drive.js). Both ends poll; no device-gw push
// needed. Single-dongle channel id 'default' for now (multi-dongle will key by the portal name). ---
const RELAY_ID = 'default'
async function relayPost(path, body) {
  try { await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) } catch (_) { /* core offline */ }
}
setServerSink((msg) => {
  if (!msg || !msg.type) return
  if (msg.type === 'portal.io') relayPost(`/v2/portal/${RELAY_ID}/io`, { data: msg.data || '' })
  else if (msg.type === 'portal.present') relayPost(`/v2/portal/${RELAY_ID}/present`, { paired: msg.paired, name: msg.name, host_os: msg.host_os })
})
if (AN) {
  setInterval(async () => {
    if (paused) return
    try {
      const r = await fetch(`/v2/portal/${RELAY_ID}/exec/next`)
      const cmd = await r.json()
      if (cmd && cmd.data != null && cmd.mode) await handleServerMessage({ type: 'portal.exec', mode: cmd.mode, data: cmd.data })
    } catch (_) { /* core offline / idle */ }
  }, 1200)
}
