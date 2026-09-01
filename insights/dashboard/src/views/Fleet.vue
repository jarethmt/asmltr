<script setup>
// Fleet — every machine the assistant can reach, online or not (docs/DEVICE-REGISTRY.md).
//
// Supersedes the old Remote Desktop view, which could only ever show hosts that happened to be
// connected to the signaling broker this second. A device here is a durable row: it exists while
// powered off, carries its transports, and shows exactly who may do what to it. Everything goes
// through the core API behind the dashboard's own session auth — no device token to paste, because
// this is the operator's view of the registry, not a peer proving it is a device.
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import PageHeader from '@/components/PageHeader.vue'
import Spinner from '@/components/Spinner.vue'
import RemoteScreen from '@/components/RemoteScreen.vue'
import RemoteTerminal from '@/components/RemoteTerminal.vue'
import { devices as api, rd } from '@/services/api'

const devices = ref([])
const sessions = ref([])
const loading = ref(false)
const error = ref('')
const notice = ref('')
const expanded = ref('')          // device id whose access panel is open
const grants = ref([])
const enrollCode = ref(null)      // { device_id, code, expires_at } — shown once
const busy = ref('')
const castTargets = ref([])
// The live screen panel. `control:false` is the WATCH case — joining a host someone else, usually
// the agent, is already driving. The host serves each viewer its own peer connection, so watching
// never interrupts the driver.
const viewing = ref(null)   // { hostId, name, control }
let timer = null

function openScreen(d, control) { viewing.value = { hostId: d.id, name: d.name, control: !!control } }
function watchSession(s) {
  const d = devices.value.find((x) => x.id === s.device_id)
  viewing.value = { hostId: s.device_id, name: (d && d.name) || s.device_id, control: false }
}
function canReachScreen(d) { return isOnline(d) && d.transports.some((t) => t.transport === 'rd' && t.enabled) }
function canShell(d) { return d.transports.some((t) => t.transport === 'ssh' && t.enabled) }

// A shell session, whether this operator opened it or the agent did. Watching an agent-owned session
// is the same subscription as owning one — the core fans one PTY out to every subscriber.
const terminal = ref(null)   // { sessionId, title, canType }
const meId = 'jarethmt'      // TODO: from the authenticated session once P2 serves identity to the GUI

async function openShell(d) {
  busy.value = 'shell:' + d.id
  try {
    const r = await fetch('/v2/device-shell', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: d.id, principal_id: meId, cols: 120, rows: 30, surface: 'dashboard' }),
    }).then((x) => x.json())
    if (r.error) throw new Error(r.error)
    terminal.value = { sessionId: r.id, title: d.name + ' — shell', canType: true }
    await refresh()
  } catch (e) { error.value = e.message } finally { busy.value = '' }
}
function watchShell(s) {
  const d = devices.value.find((x) => x.id === s.device_id)
  terminal.value = { sessionId: s.id, title: ((d && d.name) || s.device_id) + ' — watching', canType: false }
}

// Add-device form
const adding = ref(false)
const draft = ref({ name: '', kind: 'workstation', platform: '', owner_principal_id: '' })
// Grant form
const grantDraft = ref({ principal_id: '', capability: 'view', effect: 'allow' })

const KINDS = ['workstation', 'phone', 'sbc', 'appliance', 'printer', 'other']
const CAPS = ['view', 'control', 'shell', 'file', 'wake']

const onlineCount = computed(() => devices.value.filter(isOnline).length)
const liveSessions = computed(() => sessions.value.filter((s) => !s.ended_at))

// "Online" is a claim with a shelf life: transports stamp last_seen_at, so treat a stale stamp as
// offline rather than showing a powered-down machine as reachable.
function isOnline(d) { return !!d.last_seen_at && Date.now() - d.last_seen_at < 120000 }
function when(t) { return t ? new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'never' }
function sessionsFor(id) { return liveSessions.value.filter((s) => s.device_id === id) }

async function refresh() {
  loading.value = true
  try {
    devices.value = (await api.list()).devices || []
    sessions.value = (await api.sessions({})).sessions || []
    error.value = ''
    if (expanded.value) grants.value = (await api.grants(expanded.value)).grants || []
  } catch (e) { error.value = e.message } finally { loading.value = false }
}

function flash(msg) { notice.value = msg; setTimeout(() => (notice.value = ''), 6000) }
async function act(key, fn, msg) {
  busy.value = key
  try { const r = await fn(); if (msg) flash(typeof msg === 'function' ? msg(r) : msg); await refresh() }
  catch (e) { error.value = e.message } finally { busy.value = '' }
}

async function toggleAccess(id) {
  if (expanded.value === id) { expanded.value = ''; return }
  expanded.value = id
  grants.value = []
  try { grants.value = (await api.grants(id)).grants || [] } catch (e) { error.value = e.message }
}

const addDevice = () => act('add', async () => {
  const d = await api.create({ ...draft.value, platform: draft.value.platform || null, owner_principal_id: draft.value.owner_principal_id || null })
  adding.value = false
  draft.value = { name: '', kind: 'workstation', platform: '', owner_principal_id: '' }
  return d
}, (d) => `Added ${d.name}. Enroll it to issue its credential.`)

const enroll = (d) => act('enroll:' + d.id, async () => {
  const c = await api.enroll(d.id, 'rd')
  enrollCode.value = { ...c, device_id: d.id, name: d.name }
  return c
})

const revoke = (d) => {
  if (!confirm(`Revoke ${d.name}?\n\nThis kills its credential, all grants on it, and any live session. The machine must be enrolled again to come back.`)) return
  return act('revoke:' + d.id, () => api.revoke(d.id),
    (r) => `Revoked ${d.name} — ${r.transports_revoked} transport(s), ${r.grants_revoked || 0} grant(s), ${r.sessions_closed || 0} live session(s) closed.`)
}

const addGrant = (d) => act('grant', () => api.grant(d.id, { ...grantDraft.value, granted_by: 'dashboard' }), 'Grant added.')
  .then(async () => { grants.value = (await api.grants(d.id)).grants || []; grantDraft.value = { principal_id: '', capability: 'view', effect: 'allow' } })

const ungrant = (d, g) => act('ungrant:' + g.id, () => api.ungrant(g.id), 'Grant revoked.')
  .then(async () => { grants.value = (await api.grants(d.id)).grants || [] })

const kill = (s) => act('kill:' + s.id, () => api.kill(s.id), 'Session terminated.')

// Casting still goes through the broker (it holds the peer connections), so it keeps its own path.
const cast = (d) => act('cast:' + d.id, () => rd.cast('', d.id, false),
  (r) => (r.delivered ? `Cast ${d.name} to ${r.delivered} device(s).` : 'No connected device received it.'))

onMounted(async () => {
  await refresh()
  try { castTargets.value = (await rd.devices()).devices || [] } catch { /* optional */ }
  timer = setInterval(() => { if (document.visibilityState !== 'hidden') refresh() }, 8000)
})
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <div>
    <PageHeader title="Fleet" subtitle="Machines this assistant can reach — and who may touch them">
      <template #actions>
        <button class="glass glass-hover px-3 py-1.5 text-sm text-slate-300" @click="adding = !adding">
          <AppIcon glyph="+" /> Add device
        </button>
        <button class="glass glass-hover px-3 py-1.5 text-sm text-slate-300 disabled:opacity-40" :disabled="loading" @click="refresh">
          <Spinner v-if="loading" size="xs" class="mr-1" /><AppIcon v-else glyph="↻" /> Refresh
        </button>
      </template>
    </PageHeader>

    <div class="mb-4 flex flex-wrap items-center gap-2 text-[11px]">
      <span class="pill border border-white/10 bg-white/5 text-slate-400">{{ devices.length }} registered</span>
      <span class="pill border border-emerald-400/30 bg-emerald-400/10 text-emerald-300">{{ onlineCount }} online</span>
      <span v-if="liveSessions.length" class="pill border border-violet-400/30 bg-violet-400/10 text-violet-300">{{ liveSessions.length }} live session(s)</span>
      <span class="pill border border-white/10 bg-white/5 text-slate-500">default-deny · forbid always wins</span>
    </div>

    <!-- The credential is shown exactly once; the registry keeps only a hash of it. -->
    <div v-if="enrollCode" class="glass mb-4 border border-violet-400/30 p-4">
      <div class="mb-1 flex items-center justify-between">
        <h3 class="text-sm font-semibold text-violet-200">Enrollment code — {{ enrollCode.name }}</h3>
        <button class="text-xs text-slate-500 hover:text-slate-300" @click="enrollCode = null">dismiss</button>
      </div>
      <p class="mb-3 text-[13px] leading-relaxed text-slate-400">
        Single-use, expires {{ when(enrollCode.expires_at) }}. Run the host agent once with it; the issued
        credential goes to the vault, and this dashboard never sees it again.
      </p>
      <code class="block break-all rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-emerald-300">{{ enrollCode.code }}</code>
      <code class="mt-2 block break-all text-[11px] text-slate-500">host-remote-desktop.exe -broker &lt;broker-url&gt; -enroll {{ enrollCode.code }}</code>
    </div>

    <div v-if="adding" class="glass mb-4 flex flex-wrap items-end gap-3 p-4">
      <label class="text-[11px] uppercase tracking-wide text-slate-500">Name
        <input v-model="draft.name" placeholder="Workshop PC" class="mt-1 block rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-brand-violet/60" />
      </label>
      <label class="text-[11px] uppercase tracking-wide text-slate-500">Kind
        <select v-model="draft.kind" class="mt-1 block rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-sm text-slate-100 outline-none">
          <option v-for="k in KINDS" :key="k" :value="k">{{ k }}</option>
        </select>
      </label>
      <label class="text-[11px] uppercase tracking-wide text-slate-500">Platform
        <input v-model="draft.platform" placeholder="windows" class="mt-1 block w-28 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-sm text-slate-100 outline-none" />
      </label>
      <label class="text-[11px] uppercase tracking-wide text-slate-500">Owner (principal id)
        <input v-model="draft.owner_principal_id" placeholder="optional" class="mt-1 block rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-sm text-slate-100 outline-none" />
      </label>
      <button :disabled="!draft.name.trim() || busy === 'add'" class="rounded-lg bg-brand-gradient px-4 py-2 text-xs font-semibold text-white disabled:opacity-40" @click="addDevice">Add</button>
    </div>

    <div v-if="terminal" class="mb-4">
      <RemoteTerminal
        :key="terminal.sessionId"
        :session-id="terminal.sessionId" :title="terminal.title" :can-type="terminal.canType" :principal-id="meId"
        @closed="terminal = null"
      />
    </div>

    <div v-if="viewing" class="mb-4">
      <RemoteScreen
        :key="viewing.hostId + ':' + viewing.control"
        :host-id="viewing.hostId" :host-name="viewing.name" :want-control="viewing.control"
        @closed="viewing = null"
      />
    </div>

    <p v-if="notice" class="glass mb-3 px-4 py-2 text-[13px] text-violet-200">{{ notice }}</p>
    <p v-if="error" class="mb-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-[13px] text-rose-300">{{ error }}</p>

    <div v-if="devices.length" class="flex flex-col gap-3">
      <article v-for="d in devices" :key="d.id" class="glass p-4">
        <div class="flex flex-wrap items-center gap-3">
          <span :class="isOnline(d) ? 'bg-emerald-400' : 'bg-slate-600'" class="h-2 w-2 shrink-0 rounded-full" />
          <div class="min-w-0">
            <div class="truncate text-sm font-semibold text-slate-100">{{ d.name }}</div>
            <div class="text-[11px] text-slate-500">
              {{ d.kind }}<span v-if="d.platform">/{{ d.platform }}</span> · seen {{ when(d.last_seen_at) }}
              <span v-if="d.owner_principal_id"> · owner {{ d.owner_principal_id }}</span>
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-1">
            <span v-for="t in d.transports" :key="t.id"
              class="pill border text-[10px]"
              :class="!t.enabled ? 'border-rose-400/30 bg-rose-400/10 text-rose-300'
                : t.enrolled ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
                : 'border-amber-400/30 bg-amber-400/10 text-amber-300'">
              {{ t.transport }}<span v-if="!t.enabled"> revoked</span><span v-else-if="!t.enrolled"> pending</span>
            </span>
            <span v-if="!d.transports.length" class="pill border border-white/10 bg-white/5 text-[10px] text-slate-500">no transports</span>
          </div>

          <div class="ml-auto flex flex-wrap items-center gap-2">
            <button class="glass glass-hover px-2.5 py-1 text-xs text-slate-300" @click="toggleAccess(d.id)">
              {{ expanded === d.id ? 'Hide access' : 'Access' }}
            </button>
            <button class="glass glass-hover px-2.5 py-1 text-xs text-slate-300 disabled:opacity-40" :disabled="!canReachScreen(d)" @click="openScreen(d, false)">View</button>
            <button class="glass glass-hover px-2.5 py-1 text-xs text-violet-300 disabled:opacity-40" :disabled="!canReachScreen(d)" @click="openScreen(d, true)">Control</button>
            <button class="glass glass-hover px-2.5 py-1 text-xs text-emerald-300 disabled:opacity-40" :disabled="!canShell(d) || busy === 'shell:' + d.id" @click="openShell(d)">Shell</button>
            <button class="glass glass-hover px-2.5 py-1 text-xs text-slate-300 disabled:opacity-40" :disabled="busy === 'enroll:' + d.id" @click="enroll(d)">Enroll</button>
            <button class="glass glass-hover px-2.5 py-1 text-xs text-slate-300 disabled:opacity-40" :disabled="!isOnline(d) || busy === 'cast:' + d.id" @click="cast(d)">Cast</button>
            <button class="px-2.5 py-1 text-xs text-rose-400 hover:text-rose-300 disabled:opacity-40" :disabled="busy === 'revoke:' + d.id" @click="revoke(d)">Revoke</button>
          </div>
        </div>

        <div v-if="sessionsFor(d.id).length" class="mt-3 flex flex-col gap-1 border-t border-white/5 pt-3">
          <div v-for="s in sessionsFor(d.id)" :key="s.id" class="flex items-center gap-2 text-[12px]">
            <span class="pill border border-violet-400/30 bg-violet-400/10 text-[10px] text-violet-300">LIVE {{ s.capability }}</span>
            <span class="text-slate-400">{{ s.principal_id || 'unknown' }}</span>
            <span class="text-slate-600">since {{ when(s.started_at) }}</span>
            <button class="ml-auto text-xs text-violet-300 hover:text-violet-200"
              @click="s.transport === 'ssh' ? watchShell(s) : watchSession(s)">Watch</button>
            <button class="text-xs text-rose-400 hover:text-rose-300" :disabled="busy === 'kill:' + s.id" @click="kill(s)">Kill</button>
          </div>
        </div>

        <div v-if="expanded === d.id" class="mt-3 border-t border-white/5 pt-3">
          <h4 class="mb-2 text-[11px] uppercase tracking-wide text-slate-500">Who may touch this machine</h4>
          <p v-if="!grants.length" class="mb-3 text-[13px] text-slate-500">Nobody. With no grants, this device is invisible and unreachable to everyone.</p>
          <div v-for="g in grants" :key="g.id" class="mb-1 flex items-center gap-2 text-[12px]">
            <span class="pill border text-[10px]" :class="g.effect === 'forbid' ? 'border-rose-400/30 bg-rose-400/10 text-rose-300' : 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'">
              {{ g.effect === 'forbid' ? 'FORBID' : 'allow' }}
            </span>
            <span class="font-medium text-slate-200">{{ g.capability }}</span>
            <span class="text-slate-400">{{ g.principal_id }}</span>
            <span v-if="g.transport" class="text-slate-600">[{{ g.transport }}]</span>
            <span v-if="g.expires_at" class="text-slate-600">until {{ when(g.expires_at) }}</span>
            <span class="text-slate-600">· by {{ g.granted_by || '?' }}</span>
            <button class="ml-auto text-xs text-slate-500 hover:text-rose-300" @click="ungrant(d, g)">revoke</button>
          </div>

          <div class="mt-3 flex flex-wrap items-end gap-2">
            <input v-model="grantDraft.principal_id" placeholder="principal id" class="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-slate-100 outline-none focus:border-brand-violet/60" />
            <select v-model="grantDraft.capability" class="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-slate-100 outline-none">
              <option v-for="c in CAPS" :key="c" :value="c">{{ c }}</option>
            </select>
            <select v-model="grantDraft.effect" class="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-slate-100 outline-none">
              <option value="allow">allow</option>
              <option value="forbid">forbid</option>
            </select>
            <button :disabled="!grantDraft.principal_id.trim()" class="rounded-lg bg-brand-gradient px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40" @click="addGrant(d)">Grant</button>
          </div>
        </div>
      </article>
    </div>

    <div v-else-if="!loading" class="glass p-6 text-center text-[13px] text-slate-400">
      No devices registered yet. Add one, then enroll it to issue its credential.
    </div>
  </div>
</template>
