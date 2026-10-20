<script setup>
// Portal — an in-app BLE scanner for asmltr Portal dongles. One library
// (@capacitor-community/bluetooth-le) drives BOTH a desktop browser (Web Bluetooth under the hood,
// Chrome/Edge only) and the native Capacitor app (platform auto-detected), so this single view is
// the discovery surface everywhere the dashboard runs.
//
// v1 is the DISCOVERY milestone: scan → connect → read the dongle's identity (INFO) → register it as
// a device with a BLE transport. LOAD/RUN/module-management are deliberately left as "coming soon"
// placeholders — this ships discovery + register, nothing more.
import { ref, computed, onBeforeUnmount } from 'vue'
import { BleClient } from '@capacitor-community/bluetooth-le'
import PageHeader from '@/components/PageHeader.vue'
import Spinner from '@/components/Spinner.vue'
import { devices } from '@/services/api'

// --- The Portal dongle's GATT (exact — do not change) -------------------------------------------
const NAME_PREFIX = 'asmltr-portal-'
const SVC_UUID = '00657665-5f61-736d-6c74-72706f727401'
const INFO_UUID = '00657665-5f61-736d-6c74-72706f727402' // READ  — JSON identity string
const LOAD_UUID = '00657665-5f61-736d-6c74-72706f727403' // WRITE — stubbed
const RUN_UUID = '00657665-5f61-736d-6c74-72706f727404' // WRITE — stubbed
const STATUS_UUID = '00657665-5f61-736d-6c74-72706f727405' // NOTIFY — status lines

const SCAN_MS = 8000

// --- state --------------------------------------------------------------------------------------
const scanning = ref(false)
const found = ref([])        // [{ deviceId, name, rssi }]
const selected = ref(null)   // the device we're connecting to / connected to
const connecting = ref(false)
const connected = ref(false)
const info = ref(null)       // parsed INFO JSON { kind, name, fw, trust }
const statusLines = ref([])  // incoming STATUS NOTIFY lines
const registering = ref(false)
const registeredId = ref('') // device id once registered (links to Fleet)

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
  await BleClient.initialize()
  bleReady = true
}

function bleUnavailableMsg(e) {
  const m = (e && e.message) || String(e)
  if (/not .*(available|supported)|undefined|bluetooth/i.test(m)) {
    return 'Bluetooth is unavailable here. Use Chrome or Edge on desktop (Firefox/Safari have no Web Bluetooth), or open the asmltr app.'
  }
  return m
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

async function stopScan() {
  if (scanTimer) { clearTimeout(scanTimer); scanTimer = null }
  if (!scanning.value) return
  scanning.value = false
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
  try {
    await ensureBle()
    await BleClient.connect(d.deviceId, onDisconnect)
    connected.value = true

    // Read INFO → UTF-8 → JSON. The characteristic returns a DataView.
    const view = await BleClient.read(d.deviceId, SVC_UUID, INFO_UUID)
    const text = new TextDecoder('utf-8').decode(view)
    try { info.value = JSON.parse(text) } catch { info.value = { _raw: text } }

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

function onDisconnect() {
  connected.value = false
  // Keep `selected`/`info` so the card still shows what we saw, but mark it offline.
}

async function disconnect() {
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

// Register: create the device row, then attach a BLE transport. Both steps tolerate "already there"
// so a second Register on the same dongle lands gracefully instead of erroring.
async function register() {
  if (!selected.value) return
  const name = dongleName.value
  if (!name) { error.value = 'No dongle name to register.'; return }
  registering.value = true
  error.value = ''
  try {
    let dev
    let existed = false
    try {
      dev = await devices.create({ name, kind: 'appliance' })
    } catch (e) {
      // Likely a name collision — reuse the existing row rather than failing the whole flow.
      const list = (await devices.list()).devices || []
      const match = list.find((x) => x.name === name)
      if (!match) throw e
      dev = match
      existed = true
    }

    const id = dev.id
    try {
      await devices.addTransport(id, {
        transport: 'ble',
        address: name,
        params: { service_uuid: SVC_UUID, mac: selected.value.deviceId || null },
      })
    } catch (e) {
      // A duplicate BLE transport is fine — treat only unrelated errors as real.
      if (!/exist|duplicate|already/i.test((e && e.message) || '')) throw e
    }

    registeredId.value = id
    flash(existed ? `${name} was already registered — BLE transport ensured.` : `Registered ${name} in the Fleet.`)
  } catch (e) {
    error.value = e.message
  } finally {
    registering.value = false
  }
}

onBeforeUnmount(async () => { await stopScan(); await disconnect() })
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
    </div>

    <p class="mb-3 text-[12px] leading-relaxed text-slate-500">
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
          <button v-if="connected" class="glass glass-hover px-2.5 py-1 text-xs text-slate-300 disabled:opacity-40" :disabled="registering" @click="register">
            <Spinner v-if="registering" size="xs" class="mr-1" />Register
          </button>
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

      <p v-if="registeredId" class="mt-3 text-[13px] text-emerald-300">
        Registered. <RouterLink to="/fleet" class="underline hover:text-emerald-200">Open it in the Fleet →</RouterLink>
      </p>

      <!-- Optional live STATUS -->
      <div v-if="statusLines.length" class="mt-3 border-t border-white/5 pt-3">
        <h4 class="mb-2 text-[11px] uppercase tracking-wide text-slate-500">Status</h4>
        <div class="max-h-40 overflow-auto rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-[11px] text-emerald-300">
          <div v-for="(l, i) in statusLines" :key="i" class="break-all">{{ l }}</div>
        </div>
      </div>

      <!-- Module management — deliberately not wired in v1. -->
      <div class="mt-4 border-t border-white/5 pt-3">
        <h4 class="mb-2 text-[11px] uppercase tracking-wide text-slate-500">Modules</h4>
        <div class="flex flex-wrap items-center gap-2">
          <button class="glass px-2.5 py-1 text-xs text-slate-500" disabled title="Not wired yet">Load module</button>
          <button class="glass px-2.5 py-1 text-xs text-slate-500" disabled title="Not wired yet">Run module</button>
          <span class="pill border border-white/10 bg-white/5 text-[10px] text-slate-500">coming soon</span>
        </div>
      </div>
    </article>
  </div>
</template>
