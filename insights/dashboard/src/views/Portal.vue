<script setup>
// Portal — an in-app BLE scanner for asmltr Portal dongles. One library
// (@capacitor-community/bluetooth-le) drives BOTH a desktop browser (Web Bluetooth under the hood,
// Chrome/Edge only) and the native Capacitor app (platform auto-detected), so this single view is
// the discovery surface everywhere the dashboard runs.
//
// Discovery: scan → connect → read the dongle's identity (INFO) → register it as a device with a BLE
// transport. Control (docs/PORTAL-PROTOCOL.md): pair (write the instance's signing key as the trust
// anchor), then load a core-signed step-DSL module in chunks and run it, streaming STATUS back.
import { ref, computed, onBeforeUnmount, onMounted } from 'vue'
import { BleClient } from '@capacitor-community/bluetooth-le'
import { Capacitor } from '@capacitor/core'
import PageHeader from '@/components/PageHeader.vue'
import Spinner from '@/components/Spinner.vue'
import { devices, portal } from '@/services/api'

const inApp = Capacitor.isNativePlatform()
const bleModeLabel = inApp ? 'asmltr app · native Bluetooth' : 'browser · Web Bluetooth (Chrome/Edge)'

// In the asmltr app the dashboard is a REMOTELY-loaded page, where Capacitor plugins don't bridge — so
// in-app BLE goes through the app's own native bridge (window.AsmltrNative, the addJavascriptInterface
// that powers everything else here: scan/connect/read). On desktop AN is absent and we use Web
// Bluetooth via BleClient (Chrome/Edge only).
const AN = (typeof window !== 'undefined' && window.AsmltrNative && typeof window.AsmltrNative.bleStartScan === 'function') ? window.AsmltrNative : null
let blePoll = null

// --- The Portal dongle's GATT (exact — do not change) -------------------------------------------
const NAME_PREFIX = 'asmltr-portal-'
const SVC_UUID = '00657665-5f61-736d-6c74-72706f727401'
const INFO_UUID = '00657665-5f61-736d-6c74-72706f727402' // READ  — JSON identity string
const LOAD_UUID = '00657665-5f61-736d-6c74-72706f727403' // WRITE — stubbed
const RUN_UUID = '00657665-5f61-736d-6c74-72706f727404' // WRITE — stubbed
const STATUS_UUID = '00657665-5f61-736d-6c74-72706f727405' // NOTIFY — status lines
const PAIR_UUID = '00657665-5f61-736d-6c74-72706f727406' // WRITE — 32-byte trust anchor (TOFU)

const SCAN_MS = 8000

// --- state --------------------------------------------------------------------------------------
const scanning = ref(false)
const found = ref([])        // [{ deviceId, name, rssi }]
const selected = ref(null)   // the device we're connecting to / connected to
const connecting = ref(false)
const connected = ref(false)
const info = ref(null)       // parsed INFO JSON { kind, name, fw, trust }
const statusLines = ref([])  // incoming STATUS NOTIFY lines
const registeredId = ref('') // device id once registered (links to Fleet)
const modulesList = ref([])  // built-in module library from the core
const selectedModuleId = ref('')
const adopting = ref(false)  // register + pair in one action
const running = ref(false)
let notifTimer = null
const isPaired = computed(() => !!(info.value && info.value.trust === 'paired'))
const selectedDesc = computed(() => { const m = modulesList.value.find((x) => x.id === selectedModuleId.value); return m ? m.description : '' })
const adopted = computed(() => isPaired.value && !!registeredId.value) // in the Fleet AND trust-paired

const error = ref('')
const notice = ref('')
let scanTimer = null
let bleReady = false

const dongleName = computed(() => (info.value && info.value.name) || (selected.value && (selected.value.name || selected.value.deviceId)) || '')

function flash(msg) { notice.value = msg; setTimeout(() => { if (notice.value === msg) notice.value = '' }, 6000) }

// BLE is only truly available in Chrome/Edge (Web Bluetooth) or the native app. initialize() throws
// where it isn't — we surface a clear message rather than a silent dead button.
async function ensureBle() {
  if (bleReady) return
  // androidNeverForLocation pairs with the manifest's BLUETOOTH_SCAN neverForLocation flag — the
  // plugin then requests BLUETOOTH_SCAN (not location) the first time we scan.
  await BleClient.initialize({ androidNeverForLocation: true })
  // If the Bluetooth radio itself is off, scanning throws "unavailable" — prompt the user to enable it.
  try {
    const on = await BleClient.isEnabled()
    if (!on) { notice.value = 'Turning on Bluetooth…'; await BleClient.requestEnable() }
  } catch (_) { /* isEnabled/requestEnable unsupported on web — ignore */ }
  bleReady = true
}

function bleUnavailableMsg(e) {
  const m = (e && e.message) || String(e)
  // Show the REAL error (so failures are diagnosable) plus a context hint. On Android 12+ the scan
  // permission shows up as "Nearby devices" in app settings (NOT Location).
  const hint = inApp
    ? ' — in Android Settings → Apps → asmltr → Permissions, allow "Nearby devices", and make sure Bluetooth is ON.'
    : ' — use Chrome/Edge on desktop (Firefox/Safari lack Web Bluetooth), or the asmltr app.'
  return 'BLE: ' + m + hint
}

function upsertFound(d) {
  const i = found.value.findIndex((x) => x.deviceId === d.deviceId)
  if (i === -1) found.value.push(d)
  else found.value[i] = { ...found.value[i], ...d }
}

// Primary path: a timed scan that accumulates every advertiser exposing the Portal service.
async function startScan() {
  error.value = ''
  found.value = []
  if (AN) return startScanNative()
  try {
    await ensureBle()
  } catch (e) { error.value = bleUnavailableMsg(e); return }

  scanning.value = true
  try {
    await BleClient.requestLEScan({ services: [SVC_UUID] }, (result) => {
      const dev = result.device || {}
      upsertFound({
        deviceId: dev.deviceId,
        name: dev.name || result.localName || dev.deviceId,
        rssi: typeof result.rssi === 'number' ? result.rssi : null,
      })
    })
    scanTimer = setTimeout(stopScan, SCAN_MS)
  } catch (e) {
    scanning.value = false
    error.value = bleUnavailableMsg(e)
  }
}

// Native (in-app) scan: start via AsmltrNative, poll its results, keep the asmltr-portal-* advertisers.
function startScanNative() {
  const r = AN.bleStartScan()
  if (r !== 'ok') {
    error.value = r === 'bt-off' ? 'Turn on Bluetooth and scan again.'
      : r === 'no-permission' ? 'Allow "Nearby devices" for asmltr (Settings → Apps → asmltr → Permissions), then scan again.'
      : 'BLE scan could not start (' + r + ').'
    return
  }
  scanning.value = true
  const tick = () => {
    try {
      for (const d of JSON.parse(AN.bleResults() || '[]')) {
        if (!/^asmltr-portal-/i.test(d.name || '')) continue
        upsertFound({ deviceId: d.id, name: d.name, rssi: typeof d.rssi === 'number' ? d.rssi : null })
      }
    } catch (_) { /* transient */ }
  }
  blePoll = setInterval(tick, 1000)
  tick()
  scanTimer = setTimeout(stopScan, SCAN_MS)
}

async function stopScan() {
  if (scanTimer) { clearTimeout(scanTimer); scanTimer = null }
  if (blePoll) { clearInterval(blePoll); blePoll = null }
  if (!scanning.value) return
  scanning.value = false
  if (AN) { try { AN.bleStopScan() } catch (_) { /* ignore */ } return }
  try { await BleClient.stopLEScan() } catch { /* already stopped */ }
}

// Secondary path: the browser's own device picker. Handy on desktop where a system picker is nicer
// than a timed scan; on failure we just fall back to telling the user to use Scan.
async function pickViaBrowser() {
  error.value = ''
  try {
    await ensureBle()
    const dev = await BleClient.requestDevice({ services: [SVC_UUID] })
    upsertFound({ deviceId: dev.deviceId, name: dev.name || dev.deviceId, rssi: null })
    await connect(found.value.find((x) => x.deviceId === dev.deviceId))
  } catch (e) {
    // User-cancelled picker throws too — only surface real failures.
    if (!/cancel|dismiss|no device/i.test((e && e.message) || '')) error.value = bleUnavailableMsg(e)
  }
}

async function connect(d) {
  if (!d) return
  await stopScan()
  selected.value = d
  connecting.value = true
  connected.value = false
  info.value = null
  statusLines.value = []
  error.value = ''
  if (AN) { await connectNative(d); return }
  try {
    await ensureBle()
    await BleClient.connect(d.deviceId, onDisconnect)
    connected.value = true

    // Read INFO → UTF-8 → JSON. The characteristic returns a DataView.
    const view = await BleClient.read(d.deviceId, SVC_UUID, INFO_UUID)
    const text = new TextDecoder('utf-8').decode(view)
    try { info.value = JSON.parse(text) } catch { info.value = { _raw: text } }
    detectRegistered() // reflect prior adoption

    // STATUS is optional — subscribe best-effort, never let it fail the connect.
    try {
      await BleClient.startNotifications(d.deviceId, SVC_UUID, STATUS_UUID, (value) => {
        const line = new TextDecoder('utf-8').decode(value).trim()
        if (line) statusLines.value = [...statusLines.value.slice(-49), line]
      })
    } catch { /* NOTIFY not available on this unit */ }
  } catch (e) {
    error.value = bleUnavailableMsg(e)
    await disconnect()
  } finally {
    connecting.value = false
  }
}

// Native (in-app) connect: GATT connect + read INFO via AsmltrNative, polling for the result.
async function connectNative(d) {
  const r = AN.bleConnectAndRead(d.deviceId, SVC_UUID, INFO_UUID)
  if (r !== 'ok') { connecting.value = false; error.value = 'Connect failed (' + r + ').'; return }
  await new Promise((resolve) => {
    const poll = setInterval(() => {
      let res
      try { res = JSON.parse(AN.bleGattResult() || '{}') } catch { return }
      if (res.state === 'done') {
        clearInterval(poll); clearTimeout(to); connected.value = true; connecting.value = false
        try { info.value = JSON.parse(res.value) } catch { info.value = { _raw: res.value } }
        try { AN.bleSubscribe(SVC_UUID, STATUS_UUID) } catch (_) { /* best-effort */ }
        startNotifPoll()   // drain STATUS notifications (pair/run output) into the log
        detectRegistered() // reflect prior adoption
        resolve()
      } else if (res.state === 'error' || res.state === 'disconnected') {
        clearInterval(poll); clearTimeout(to); connecting.value = false; connected.value = false
        error.value = 'Connect: ' + (res.error || res.state); resolve()
      }
    }, 500)
    const to = setTimeout(() => { clearInterval(poll); if (connecting.value) { connecting.value = false; error.value = 'Connect timed out.' } resolve() }, 20000)
  })
}

function onDisconnect() {
  connected.value = false
  // Keep `selected`/`info` so the card still shows what we saw, but mark it offline.
}

async function disconnect() {
  stopNotifPoll()
  if (AN) { try { AN.bleDisconnect() } catch (_) { /* ignore */ } connected.value = false; return }
  const id = selected.value && selected.value.deviceId
  if (id) {
    try { await BleClient.stopNotifications(id, SVC_UUID, STATUS_UUID) } catch { /* ignore */ }
    try { await BleClient.disconnect(id) } catch { /* ignore */ }
  }
  connected.value = false
}

async function clearSelection() {
  await disconnect()
  selected.value = null
  info.value = null
  statusLines.value = []
  registeredId.value = ''
}

// Register (the Fleet side of adoption): create the device row, then attach a BLE transport. Both
// steps tolerate "already there" so re-adopting the same dongle lands gracefully. Returns the id.
async function registerInner() {
  const name = dongleName.value
  if (!name) throw new Error('no dongle name to register')
  let dev
  try {
    dev = await devices.create({ name, kind: 'appliance' })
  } catch (e) {
    // Likely a name collision — reuse the existing row rather than failing the whole flow.
    const list = (await devices.list()).devices || []
    const match = list.find((x) => x.name === name)
    if (!match) throw e
    dev = match
  }
  const id = dev.id
  try {
    await devices.addTransport(id, {
      transport: 'ble',
      address: name,
      params: { service_uuid: SVC_UUID, mac: selected.value.deviceId || null },
    })
  } catch (e) {
    if (!/exist|duplicate|already/i.test((e && e.message) || '')) throw e
  }
  registeredId.value = id
  return id
}

// If this dongle is already in the Fleet (adopted in a past session), reflect that so the UI shows
// the run surface instead of asking to adopt again.
async function detectRegistered() {
  try {
    const name = dongleName.value
    if (!name) return
    const match = ((await devices.list()).devices || []).find((x) => x.name === name)
    if (match) registeredId.value = match.id
  } catch (_) { /* core offline — fine */ }
}

// --- control plane: pair, then load + run signed modules (docs/PORTAL-PROTOCOL.md) -------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function b64ToBytes(b64) { const bin = atob(b64); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a }
function bytesToB64(bytes) { let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s) }

async function loadLibrary() {
  try { modulesList.value = (await portal.modules()).modules || [] ; if (!selectedModuleId.value && modulesList.value[0]) selectedModuleId.value = modulesList.value[0].id } catch (_) { /* core offline — leave empty */ }
}

function startNotifPoll() {
  if (!AN || notifTimer) return
  notifTimer = setInterval(() => {
    try { const arr = JSON.parse(AN.bleNotifications() || '[]'); for (const l of arr) if (l) statusLines.value = [...statusLines.value.slice(-49), l] } catch (_) { /* ignore */ }
  }, 400)
}
function stopNotifPoll() { if (notifTimer) { clearInterval(notifTimer); notifTimer = null } }

// Write a base64 value to one characteristic (native bridge or Web Bluetooth), awaiting completion.
async function writeChar(charUuid, base64Value) {
  if (AN) {
    const r = AN.bleWrite(SVC_UUID, charUuid, base64Value)
    if (r !== 'ok') throw new Error('bridge write: ' + r)
    for (let i = 0; i < 50; i++) {
      let st; try { st = JSON.parse(AN.bleWriteState() || '{}') } catch { st = {} }
      if (st.state === 'done') return
      if (st.state === 'error') throw new Error(st.error || 'write error')
      await sleep(80)
    }
    throw new Error('write timed out')
  }
  const bytes = b64ToBytes(base64Value)
  await BleClient.write(selected.value.deviceId, SVC_UUID, charUuid, new DataView(bytes.buffer))
}

async function rereadInfo() {
  if (AN) {
    const r = AN.bleReadChar(SVC_UUID, INFO_UUID)
    if (r !== 'ok') throw new Error('reread: ' + r)
    for (let i = 0; i < 50; i++) {
      let res; try { res = JSON.parse(AN.bleGattResult() || '{}') } catch { res = {} }
      if (res.state === 'done') { try { info.value = JSON.parse(res.value) } catch { info.value = { _raw: res.value } } return }
      if (res.state === 'error') throw new Error(res.error || 'read error')
      await sleep(80)
    }
    throw new Error('reread timed out')
  }
  const view = await BleClient.read(selected.value.deviceId, SVC_UUID, INFO_UUID)
  try { info.value = JSON.parse(new TextDecoder('utf-8').decode(view)) } catch { /* keep prior */ }
}

// Pair (TOFU, the dongle side of adoption): write the instance's signing pubkey to `pair`, re-read INFO.
async function pairInner() {
  const { pubkey_b64 } = await portal.signingKey()
  if (!pubkey_b64) throw new Error('core returned no signing key')
  await writeChar(PAIR_UUID, pubkey_b64)
  await sleep(350)
  await rereadInfo()
  if (!isPaired.value) throw new Error('the Portal still reports unpaired')
}

// Adopt = one intent, both sides: register it in your Fleet AND pair your signing key onto it.
async function adopt() {
  if (!selected.value) return
  adopting.value = true; error.value = ''
  try {
    await registerInner()                 // Fleet side (idempotent)
    if (!isPaired.value) await pairInner() // dongle side (idempotent for the same key)
    flash('Adopted — in your Fleet and trusted. Load a module below.')
  } catch (e) { error.value = 'Adopt failed: ' + (e.message || e) }
  finally { adopting.value = false }
}

// Reset trust: write 32 zero bytes to `pair` → the dongle forgets its anchor (back to unpaired).
async function unpair() {
  if (!selected.value) return
  adopting.value = true; error.value = ''
  try {
    await writeChar(PAIR_UUID, btoa(String.fromCharCode.apply(null, new Uint8Array(32))))
    await sleep(350)
    await rereadInfo()
    if (isPaired.value) throw new Error('the Portal still reports paired')
    flash('Trust reset — the Portal is unpaired again.')
  } catch (e) { error.value = 'Reset trust failed: ' + (e.message || e) }
  finally { adopting.value = false }
}

// Load a signed module in chunks, then trigger run; STATUS lines stream into the log.
async function loadChunks(bytes) {
  const mtu = (AN && AN.bleMtuSize) ? (AN.bleMtuSize() || 23) : 185
  const chunkData = Math.max(16, Math.min(180, mtu - 3 - 4)) // minus ATT overhead (3) + our 4-byte header
  let seq = 0
  for (let off = 0; off < bytes.length; off += chunkData) {
    const slice = bytes.subarray(off, Math.min(off + chunkData, bytes.length))
    const first = off === 0 ? 0x01 : 0x00
    const last = (off + chunkData >= bytes.length) ? 0x02 : 0x00
    const frame = new Uint8Array(4 + slice.length)
    frame[0] = first | last; frame[1] = 0; frame[2] = (seq >> 8) & 0xff; frame[3] = seq & 0xff
    frame.set(slice, 4)
    await writeChar(LOAD_UUID, bytesToB64(frame))
    seq++
  }
}

async function loadAndRun() {
  if (!selected.value) return
  const id = selectedModuleId.value || (modulesList.value[0] && modulesList.value[0].id)
  if (!id) { error.value = 'Pick a module first.'; return }
  running.value = true; error.value = ''; statusLines.value = []
  try {
    const signed = await portal.sign({ id })           // core signs the module with the instance key
    if (!signed.envelope_b64) throw new Error('core did not return a signed envelope')
    startNotifPoll()
    await loadChunks(b64ToBytes(signed.envelope_b64))  // push the signed envelope over `load`
    await writeChar(RUN_UUID, btoa('run'))             // trigger execution
    flash('Module sent — watch Status below.')
  } catch (e) { error.value = 'Load/Run failed: ' + (e.message || e) }
  finally { running.value = false }
}

onMounted(loadLibrary)
onBeforeUnmount(async () => { stopNotifPoll(); await stopScan(); await disconnect() })
</script>

<template>
  <div>
    <PageHeader title="Portal" subtitle="Discover asmltr Portal dongles over Bluetooth and register them as devices">
      <template #actions>
        <button class="glass glass-hover px-3 py-1.5 text-sm text-slate-300 disabled:opacity-40" :disabled="scanning" @click="startScan">
          <Spinner v-if="scanning" size="xs" class="mr-1" /><AppIcon v-else glyph="🌀" /> {{ scanning ? 'Scanning…' : 'Scan' }}
        </button>
        <button v-if="scanning" class="glass glass-hover px-3 py-1.5 text-sm text-slate-300" @click="stopScan">Stop</button>
        <button class="glass glass-hover px-3 py-1.5 text-sm text-slate-300" @click="pickViaBrowser">Pick via browser…</button>
      </template>
    </PageHeader>

    <div class="mb-4 flex flex-wrap items-center gap-2 text-[11px]">
      <span class="pill border border-white/10 bg-white/5 text-slate-400">{{ found.length }} found</span>
      <span v-if="connected" class="pill border border-emerald-400/30 bg-emerald-400/10 text-emerald-300">connected</span>
      <span class="pill border border-white/10 bg-white/5 text-slate-500">looks for service …727401</span>
      <span class="pill border" :class="inApp ? 'border-brand-violet/30 bg-brand-violet/10 text-violet-200' : 'border-white/10 bg-white/5 text-slate-400'">{{ bleModeLabel }}</span>
    </div>

    <!-- TEMP diagnostic (remove after we resolve the in-app BLE bridge) -->

    <p v-if="inApp" class="mb-3 text-[12px] leading-relaxed text-slate-500">
      Running inside the asmltr app — scanning over the device's <span class="text-slate-300">native Bluetooth</span>.
    </p>
    <p v-else class="mb-3 text-[12px] leading-relaxed text-slate-500">
      Desktop needs <span class="text-slate-300">Chrome</span> or <span class="text-slate-300">Edge</span> (Web Bluetooth) —
      Firefox and Safari aren't supported. On Android/iOS, open the asmltr app for native Bluetooth.
    </p>

    <p v-if="notice" class="glass mb-3 px-4 py-2 text-[13px] text-violet-200">{{ notice }}</p>
    <p v-if="error" class="mb-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-[13px] text-rose-300">{{ error }}</p>

    <!-- Discovered dongles -->
    <div v-if="found.length" class="mb-4 flex flex-col gap-2">
      <button
        v-for="d in found" :key="d.deviceId"
        class="glass glass-hover flex items-center gap-3 p-3 text-left"
        :class="selected && selected.deviceId === d.deviceId ? 'border border-violet-400/40' : ''"
        @click="connect(d)">
        <AppIcon glyph="🌀" class="text-base text-violet-300" />
        <div class="min-w-0">
          <div class="truncate text-sm font-semibold text-slate-100">{{ d.name }}</div>
          <div class="truncate text-[11px] text-slate-500">
            <span v-if="d.name && d.name.startsWith(NAME_PREFIX)">Portal dongle</span>
            <span v-else>BLE device</span>
            <span v-if="d.rssi != null"> · {{ d.rssi }} dBm</span>
          </div>
        </div>
        <span class="ml-auto text-[11px] text-violet-300">Connect</span>
      </button>
    </div>

    <div v-else-if="scanning" class="glass mb-4 flex items-center gap-3 p-6 text-[13px] text-slate-400">
      <Spinner size="sm" /> Scanning for Portal dongles…
    </div>

    <div v-else-if="!selected" class="glass mb-4 p-6 text-center text-[13px] text-slate-400">
      No dongles yet. Press <span class="text-slate-200">Scan</span> and power on a Portal nearby
      (it advertises as <code class="text-slate-300">{{ NAME_PREFIX }}…</code>).
    </div>

    <!-- The connected / selected dongle -->
    <article v-if="selected" class="glass p-4">
      <div class="mb-3 flex flex-wrap items-center gap-3">
        <span :class="connected ? 'bg-emerald-400' : connecting ? 'bg-amber-400' : 'bg-slate-600'" class="h-2 w-2 shrink-0 rounded-full" />
        <div class="min-w-0">
          <div class="truncate text-sm font-semibold text-slate-100">{{ dongleName }}</div>
          <div class="truncate text-[11px] text-slate-500">{{ selected.deviceId }}</div>
        </div>
        <div class="ml-auto flex flex-wrap items-center gap-2">
          <button class="px-2.5 py-1 text-xs text-slate-400 hover:text-slate-200" @click="clearSelection">Close</button>
        </div>
      </div>

      <div v-if="connecting" class="flex items-center gap-2 text-[13px] text-slate-400">
        <Spinner size="sm" /> Connecting and reading identity…
      </div>

      <!-- Identity from INFO -->
      <div v-else-if="info" class="grid grid-cols-2 gap-2 text-[12px] sm:grid-cols-4">
        <div class="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
          <div class="text-[10px] uppercase tracking-wide text-slate-500">kind</div>
          <div class="truncate text-slate-200">{{ info.kind || '—' }}</div>
        </div>
        <div class="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
          <div class="text-[10px] uppercase tracking-wide text-slate-500">name</div>
          <div class="truncate text-slate-200">{{ info.name || '—' }}</div>
        </div>
        <div class="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
          <div class="text-[10px] uppercase tracking-wide text-slate-500">firmware</div>
          <div class="truncate text-slate-200">{{ info.fw || '—' }}</div>
        </div>
        <div class="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
          <div class="text-[10px] uppercase tracking-wide text-slate-500">trust</div>
          <div class="truncate" :class="info.trust === 'paired' ? 'text-emerald-300' : 'text-amber-300'">{{ info.trust || 'unpaired' }}</div>
        </div>
        <div v-if="info._raw" class="col-span-2 rounded-lg border border-amber-400/20 bg-amber-400/5 px-3 py-2 sm:col-span-4">
          <div class="text-[10px] uppercase tracking-wide text-amber-300/80">INFO was not JSON</div>
          <code class="block break-all text-[11px] text-slate-300">{{ info._raw }}</code>
        </div>
      </div>

      <!-- Optional live STATUS -->
      <div v-if="statusLines.length" class="mt-3 border-t border-white/5 pt-3">
        <h4 class="mb-2 text-[11px] uppercase tracking-wide text-slate-500">Status</h4>
        <div class="max-h-40 overflow-auto rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-[11px] text-emerald-300">
          <div v-for="(l, i) in statusLines" :key="i" class="break-all">{{ l }}</div>
        </div>
      </div>

      <!-- Control plane: adopt (register + pair), then load + run signed modules (PORTAL-PROTOCOL.md) -->
      <div v-if="connected" class="mt-4 border-t border-white/5 pt-3">
        <h4 class="mb-2 text-[11px] uppercase tracking-wide text-slate-500">Control</h4>

        <!-- Not yet adopted: one action does both sides (Fleet row + trust anchor on the dongle) -->
        <div v-if="!adopted" class="rounded-lg border border-violet-400/20 bg-violet-400/[0.04] p-3">
          <p class="mb-2 text-[12px] leading-relaxed text-slate-300">
            <span class="font-semibold text-slate-100">Adopt this Portal</span> to use it. One step: it's added to
            your <span class="text-slate-100">Fleet</span>, and your instance's signing key is stored on the dongle
            so it will only ever run modules <span class="text-slate-100">you</span> signed — the line that keeps it
            a tool, not a BadUSB gadget.
          </p>
          <button class="glass glass-hover px-3 py-1.5 text-xs text-violet-200 disabled:opacity-40" :disabled="adopting" @click="adopt">
            <Spinner v-if="adopting" size="xs" class="mr-1" />Adopt this Portal
          </button>
        </div>

        <!-- Adopted: pick a signed module and load + run it -->
        <div v-else>
          <div class="mb-2 flex flex-wrap items-center gap-2 text-[11px]">
            <span class="pill border border-emerald-400/30 bg-emerald-400/10 text-emerald-300">adopted</span>
            <RouterLink to="/fleet" class="text-slate-400 underline hover:text-slate-200">Open in Fleet →</RouterLink>
            <button class="ml-auto text-slate-500 hover:text-amber-300 disabled:opacity-40" :disabled="adopting" @click="unpair">Reset trust</button>
          </div>
          <div v-if="modulesList.length" class="flex flex-wrap items-center gap-2">
            <select v-model="selectedModuleId" class="glass bg-transparent px-2.5 py-1 text-xs text-slate-200">
              <option v-for="m in modulesList" :key="m.id" :value="m.id" class="bg-slate-900 text-slate-200">{{ m.name }} · {{ m.steps }} steps</option>
            </select>
            <button class="glass glass-hover px-3 py-1.5 text-xs text-emerald-200 disabled:opacity-40" :disabled="running" @click="loadAndRun">
              <Spinner v-if="running" size="xs" class="mr-1" />Load &amp; Run
            </button>
            <span class="pill border border-emerald-400/20 bg-emerald-400/5 text-[10px] text-emerald-300/80">signed by your instance</span>
          </div>
          <p v-else class="text-[12px] text-slate-500">
            The core returned no module library — is asmltr core reachable? (<code class="text-slate-400">/v2/portal/modules</code>)
          </p>
          <p v-if="selectedDesc" class="mt-2 text-[11px] leading-relaxed text-slate-500">{{ selectedDesc }}</p>
        </div>
      </div>
    </article>
  </div>
</template>
