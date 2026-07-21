<script setup>
import { onMounted, onUnmounted, ref, computed, watch } from 'vue'
import { useCollectorStore } from '@/stores/collector'
import PageHeader from '@/components/PageHeader.vue'
import SessionCard from '@/components/SessionCard.vue'
import ModalShell from '@/components/ModalShell.vue'
import StatTile from '@/components/StatTile.vue'
import { fmtNum, surfaceMeta } from '@/lib/format'
import { manager } from '@/services/manager'
import { api } from '@/services/api'
import { useWindows } from '@/stores/windows'

const store = useCollectorStore()
const windows = useWindows()
const now = ref(Date.now())
let ticker = null

// --- new web session ---------------------------------------------------------
// Start a fresh session right from the browser: the dashboard acts as a connector
// (channel `assistant-web`). The working dir picks the "flavour" — /root gives a
// full root session, a project path gives a scoped one. First message spawns it server-side.
const newOpen = ref(false)
const newWorkdir = ref('')
const WORKDIR_PRESETS = [
  { label: 'Root', dir: '', hint: '/root — full access' },
  { label: 'asmltr', dir: '/root/projects/personal/asmltr', hint: 'this project' }
]
function openNew() { newWorkdir.value = ''; newOpen.value = true }
function startNew() {
  const uuid = (crypto?.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.floor(Math.random() * 1e6))
  const wd = newWorkdir.value.trim()
  windows.openSession({
    session_id: `web:${uuid}`,
    surface: 'assistant-web',
    kind: 'ephemeral',
    status: 'idle',
    identity: 'web · you',
    title: 'New web session',
    working_dir: wd || null,
    // timestamps are epoch-MILLIS everywhere in the UI (fmtAge expects ms). Once the first turn
    // is recorded, SessionDetail live-merges the real collector row over this placeholder.
    started_unix: Date.now(),
    last_activity_unix: Date.now(),
    tokens_total: 0,
    tool_count: 0
  })
  newOpen.value = false
}

// --- per-channel monitoring (capability-driven, not shape-parsed) ------------
// A connector advertises `mutable` (Discord: per-channel on/off). We load which instances
// support it + their channel roster, then a session is "mutable" iff its id references a
// channel_id in that roster — so voice/DM/system sessions correctly have no toggle, and we
// never hardcode a `discord:…:channel:…` shape.
const muteInstances = ref({})  // instanceId -> mutable capability { scope,label,… }
const channelStates = ref({})  // channel_id -> enabled
const channelBusy = ref({})
async function loadMuteState() {
  try {
    const r = await manager.instances()
    const caps = {}
    for (const i of (r.instances || [])) if (i.mutable) caps[i.id] = i.mutable
    muteInstances.value = caps
    const next = {}
    for (const id of Object.keys(caps)) {
      try { const c = await manager.channels(id); for (const ch of (c.channels || [])) next[ch.channel_id] = ch.enabled } catch (_) {}
    }
    channelStates.value = next
  } catch (_) {}
}
// Resolve a session to its mutable unit: { instanceId, channelId, label } or null.
function mutableChannel(sessionId) {
  const parts = String(sessionId || '').split(':')
  if (parts.length < 3) return null
  const instanceId = parts[1]
  const cap = muteInstances.value[instanceId]
  if (!cap) return null
  for (const seg of parts.slice(2)) {
    if (Object.prototype.hasOwnProperty.call(channelStates.value, seg)) return { instanceId, channelId: seg, label: cap.label || 'channel' }
  }
  return null
}
// Precompute per visible session so the template doesn't recompute 3×/card.
const mutableBySession = computed(() => {
  const m = {}
  for (const s of store.sessions) { const r = mutableChannel(s.session_id); if (r) m[s.session_id] = r }
  return m
})
async function toggleChannel(sessionId) {
  const d = mutableChannel(sessionId)
  if (!d) return
  const cur = channelStates.value[d.channelId] !== false
  channelBusy.value = { ...channelBusy.value, [d.channelId]: true }
  try {
    await manager.setChannel(d.instanceId, { channel_id: d.channelId, enabled: !cur })
    channelStates.value = { ...channelStates.value, [d.channelId]: !cur }
  } catch (_) {}
  finally { channelBusy.value = { ...channelBusy.value, [d.channelId]: false } }
}

// latest event per session (store.events is newest-first) → live card previews
const latestBySession = computed(() => {
  const map = {}
  for (const e of store.events) {
    if (e.session_id && !map[e.session_id]) map[e.session_id] = e
  }
  return map
})

// click a surface pill to filter the lists to that connector (click again to clear)
const surfaceFilter = ref(null)
function toggleSurface(s) { surfaceFilter.value = surfaceFilter.value === s ? null : s }

// content search: filter cards to sessions whose CONTENT (or metadata) matches a keyword.
const search = ref('')
const searchHits = ref({}) // session_id -> { hits, snippet } from the server-side content search
const searching = ref(false)
let searchTimer = null
watch(search, (q) => {
  clearTimeout(searchTimer)
  q = q.trim()
  if (q.length < 2) { searchHits.value = {}; searching.value = false; return }
  searching.value = true
  searchTimer = setTimeout(async () => {
    try { const r = await api.search(q); const m = {}; for (const s of (r.sessions || [])) m[s.session_id] = s; searchHits.value = m }
    catch (_) { searchHits.value = {} }
    finally { searching.value = false }
  }, 300)
})
const metaMatch = (s, q) => [s.title, s.location, s.identity, s.session_id, s.task].some((f) => f && String(f).toLowerCase().includes(q))
function matchFilter(s) {
  if (surfaceFilter.value && s.surface !== surfaceFilter.value) return false
  const q = search.value.trim().toLowerCase()
  if (q.length >= 2) return metaMatch(s, q) || !!searchHits.value[s.session_id]
  return true
}

const ephemeral = computed(() =>
  store.sessions.filter((s) => s.kind === 'ephemeral' && matchFilter(s)).sort(byActivity)
)
const persistent = computed(() =>
  store.sessions.filter((s) => s.kind === 'persistent' && matchFilter(s)).sort(byActivity)
)

function byActivity(a, b) {
  return (b.last_activity_unix || 0) - (a.last_activity_unix || 0)
}

const totalTokens = computed(() =>
  store.sessions.reduce((sum, s) => sum + (s.tokens_total || 0), 0)
)

const surfacesActive = computed(() => {
  const map = {}
  for (const s of store.sessions) map[s.surface] = (map[s.surface] || 0) + 1
  return Object.entries(map).sort((a, b) => b[1] - a[1])
})

let chanTimer = null
onMounted(() => {
  store.fetchSessions()
  store.fetchBrief()
  store.fetchEvents({ limit: 300 }) // seed the buffer so card previews render immediately
  loadMuteState()
  ticker = setInterval(() => (now.value = Date.now()), 1000)
  chanTimer = setInterval(loadMuteState, 15000) // refresh mute-capable instances + channel enabled/disabled state
})
onUnmounted(() => { clearInterval(ticker); clearInterval(chanTimer) })
</script>

<template>
  <div>
    <PageHeader title="Live" subtitle="Active sessions and persistent daemons across every surface">
      <template #actions>
        <div class="relative">
          <input
            v-model="search"
            type="search"
            placeholder="Search session contents…"
            class="w-56 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 pl-8 text-sm text-slate-100 outline-none transition-colors placeholder:text-slate-600 focus:border-brand-violet/60 focus:bg-white/[0.06] sm:w-72"
          />
          <span class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500"><AppIcon :glyph="searching ? '⏳' : '🔍'" /></span>
        </div>
        <button
          class="rounded-lg bg-brand-gradient px-3 py-1.5 text-sm font-semibold text-white shadow-lg shadow-brand-violet/30"
          title="Start a new session right here in the browser"
          @click="openNew"
        >
          ＋ New session
        </button>
        <button
          class="glass glass-hover px-3 py-1.5 text-sm text-slate-300"
          @click="store.fetchSessions()"
        >
          <AppIcon glyph="↻" /> Refresh
        </button>
      </template>
    </PageHeader>

    <!-- new web session: pick a working dir, then chat -->
    <ModalShell v-if="newOpen" title="New session" subtitle="Runs right here in the browser (channel: assistant-web)" @close="newOpen = false">
      <div class="space-y-4">
        <p class="text-sm text-slate-400">
          The dashboard acts as a connector — your messages stream through the core and the session
          shows up in Live like any other. Pick where it runs:
        </p>
        <div class="flex flex-wrap gap-2">
          <button
            v-for="p in WORKDIR_PRESETS"
            :key="p.label"
            type="button"
            class="rounded-lg border px-3 py-2 text-left text-xs transition-colors"
            :class="newWorkdir.trim() === p.dir ? 'border-brand-violet/60 bg-brand-violet/15 text-violet-200' : 'border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/10'"
            @click="newWorkdir = p.dir"
          >
            <div class="font-semibold">{{ p.label }}</div>
            <div class="font-mono text-[10px] text-slate-500">{{ p.hint }}</div>
          </button>
        </div>
        <label class="block">
          <span class="mb-1 block text-[11px] uppercase tracking-wide text-slate-500">Working directory (optional)</span>
          <input
            v-model="newWorkdir"
            type="text"
            placeholder="/root (default)"
            class="w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 font-mono text-sm text-slate-100 outline-none transition-colors placeholder:text-slate-600 focus:border-brand-violet/60 focus:bg-white/[0.06]"
          />
        </label>
      </div>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <button type="button" class="glass glass-hover px-4 py-2 text-sm text-slate-300" @click="newOpen = false">Cancel</button>
          <button type="button" class="rounded-lg bg-brand-gradient px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-brand-violet/30" @click="startNew">Start chatting →</button>
        </div>
      </template>
    </ModalShell>

    <!-- summary tiles -->
    <div class="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatTile label="Active sessions" :value="store.activeSessions.length" accent="#34D399" />
      <StatTile label="Persistent" :value="persistent.length" accent="#22D3EE" />
      <StatTile label="Tokens (live)" :value="fmtNum(totalTokens)" accent="#8B5CF6" />
      <StatTile
        label="Tokens · 24h"
        :value="fmtNum(store.brief?.tokens_24h || 0)"
        accent="#EC4899"
      />
    </div>

    <!-- surface distribution — click to filter by connector -->
    <div v-if="surfacesActive.length" class="mb-6 flex flex-wrap items-center gap-2">
      <button
        v-for="[surface, count] in surfacesActive"
        :key="surface"
        type="button"
        class="pill border transition-all"
        :class="surfaceFilter && surfaceFilter !== surface ? 'opacity-40 hover:opacity-70' : 'hover:brightness-125'"
        :style="{
          color: surfaceMeta(surface).color,
          borderColor: surfaceMeta(surface).color + (surfaceFilter === surface ? 'cc' : '40'),
          backgroundColor: surfaceMeta(surface).color + (surfaceFilter === surface ? '33' : '1a')
        }"
        :title="surfaceFilter === surface ? 'Click to clear filter' : 'Filter to ' + surfaceMeta(surface).label"
        @click="toggleSurface(surface)"
      >
        <AppIcon :glyph="surfaceMeta(surface).icon" /> {{ surfaceMeta(surface).label }} · {{ count }}
      </button>
      <button
        v-if="surfaceFilter"
        type="button"
        class="pill border border-white/15 bg-white/5 text-slate-400 hover:text-slate-200"
        @click="surfaceFilter = null"
      >
        <AppIcon glyph="✕" /> clear
      </button>
    </div>

    <!-- ephemeral -->
    <section class="mb-8">
      <h2 class="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-slate-400">
        <span class="h-2 w-2 rounded-full bg-emerald-400 animate-pulse-dot"></span>
        Ephemeral sessions
        <span class="text-slate-600">({{ ephemeral.length }})</span>
      </h2>
      <div
        v-if="ephemeral.length"
        class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
      >
        <SessionCard v-for="s in ephemeral" :key="s.session_id" :session="s" :now="now" :preview="latestBySession[s.session_id]" :mutable="mutableBySession[s.session_id]" :channel-state="channelStates[mutableBySession[s.session_id]?.channelId]" :channel-busy="channelBusy[mutableBySession[s.session_id]?.channelId]" :search-snippet="searchHits[s.session_id]?.snippet" @open="windows.openSession($event)" @toggle-channel="toggleChannel" />
      </div>
      <p v-else class="glass px-4 py-6 text-center text-sm text-slate-500">
        No ephemeral sessions right now.
      </p>
    </section>

    <!-- persistent -->
    <section>
      <h2 class="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-slate-400">
        <span class="h-2 w-2 rounded-full bg-cyan-400"></span>
        Persistent daemons
        <span class="text-slate-600">({{ persistent.length }})</span>
      </h2>
      <div
        v-if="persistent.length"
        class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
      >
        <SessionCard v-for="s in persistent" :key="s.session_id" :session="s" :now="now" :preview="latestBySession[s.session_id]" :mutable="mutableBySession[s.session_id]" :channel-state="channelStates[mutableBySession[s.session_id]?.channelId]" :channel-busy="channelBusy[mutableBySession[s.session_id]?.channelId]" :search-snippet="searchHits[s.session_id]?.snippet" @open="windows.openSession($event)" @toggle-channel="toggleChannel" />
      </div>
      <p v-else class="glass px-4 py-6 text-center text-sm text-slate-500">
        No persistent daemons registered.
      </p>
    </section>  </div>
</template>
