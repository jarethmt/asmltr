<script setup>
// Unified "manage session" pane, in a draggable + resizable floating window. One chat
// interface over every session type:
//  • web sessions (session_id `web:…`) — the BROWSER is the connector: the composer
//    streams a turn through the core (/v2/stream) and renders the reply live.
//  • channel sessions (discord/email/…) — compose = DIRECT the conversation (inject);
//    reply routes back to the origin channel.
//  • interactive `asmltr claude` (tmux) — compose = type into the pane (send-keys).
// The header title is inline-editable — a manual title locks against AI regeneration.
import { ref, computed, reactive, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { useCollectorStore } from '@/stores/collector'
import { api, control, webChat, parsePayload } from '@/services/api'
import { manager } from '@/services/manager'
import { useSpeech } from '@/composables/useSpeech'
import { statusMeta, displayStatus, fmtTime, fmtAge, fmtNum, truncate } from '@/lib/format'
import FloatingWindow from './FloatingWindow.vue'
import SurfaceBadge from './SurfaceBadge.vue'
import FileArtifacts from './FileArtifacts.vue'
import { eventRow } from '@/lib/transcript'
import { applySegment, preferLastBlock } from '@/lib/segment'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

// Render finished assistant replies as sanitized Markdown. A streaming turn stays plain
// text (partial tokens make half-open markdown flicker); the completed turn renders formatted.
marked.setOptions({ gfm: true, breaks: true })
function renderMarkdown(text) {
  return DOMPurify.sanitize(marked.parse(text || '', { async: false }))
}

const props = defineProps({
  session: { type: Object, required: true },
  now: { type: Number, default: () => Date.now() },
  mutable: { type: Object, default: null }, // { instanceId, channelId, label } if this session's channel can be muted
  channelState: { type: Boolean, default: undefined },
  channelBusy: { type: Boolean, default: false },
  // floating-window manager props (forwarded to FloatingWindow)
  z: { type: Number, default: 70 },
  focused: { type: Boolean, default: true },
  minimized: { type: Boolean, default: false },
  // special-mode hooks (the observer drives the SAME chat window through these):
  contextProvider: { type: Function, default: null }, // web sends → its return becomes system_prompt_extra
  accent: { type: String, default: '' },              // window accent color (styling)
  titleOverride: { type: String, default: '' }        // force the header title (skip AI-generated)
})
const emit = defineEmits(['close', 'toggle-channel', 'channel-toggled', 'minimize', 'focus'])

const store = useCollectorStore()
const key = computed(() => props.session.session_id)

// Live-merge the real collector row over the (possibly synthetic) session passed in, so the
// header shows live status / tokens / last-activity as the session runs — and a brand-new web
// session's placeholder timestamps get replaced the moment its first turn is recorded.
const sess = computed(() => {
  const real = store.sessions.find((s) => s.session_id === key.value)
  return real ? { ...props.session, ...real } : props.session
})
const st = computed(() => statusMeta(displayStatus(sess.value, props.now)))

const isWeb = computed(() => String(key.value || '').startsWith('web:'))
const isCli = computed(() => sess.value.multiplexer === 'tmux' || sess.value.multiplexer === 'screen')
const attachCmd = computed(() => {
  if (!isCli.value || !sess.value.tmux_target) return null
  return sess.value.multiplexer === 'screen' ? `screen -x ${sess.value.tmux_target}` : `tmux attach -t ${sess.value.tmux_target}`
})
// --- per-channel monitoring, self-contained so the toggle works from ANY opener (Live, Self, …) ---
// A connector advertises `mutable` (Discord: per-channel on/off). We resolve THIS session's channel
// from the instance roster and toggle it directly here — no reliance on the parent wiring it in.
const caps = ref({})       // instanceId -> mutable capability { label, … }
const chStates = ref({})   // channel_id -> enabled
const monBusy = ref(false)
async function loadMuteState() {
  try {
    const r = await manager.instances()
    const c = {}
    for (const i of (r.instances || [])) if (i.mutable) c[i.id] = i.mutable
    caps.value = c
    const next = {}
    for (const id of Object.keys(c)) { try { const cc = await manager.channels(id); for (const ch of (cc.channels || [])) next[ch.channel_id] = ch.enabled } catch (_) {} }
    chStates.value = next
  } catch (_) {}
}
onMounted(loadMuteState)
watch(key, loadMuteState)
// Resolve this session to its mutable unit: { instanceId, channelId, label } (a parent prop wins).
const myMutable = computed(() => {
  if (props.mutable) return props.mutable
  const parts = String(key.value || '').split(':')
  if (parts.length < 3) return null
  const cap = caps.value[parts[1]]
  if (!cap) return null
  for (const seg of parts.slice(2)) if (Object.prototype.hasOwnProperty.call(chStates.value, seg)) return { instanceId: parts[1], channelId: seg, label: cap.label || 'channel' }
  return null
})
const monitored = computed(() => {
  const m = myMutable.value
  if (m && Object.prototype.hasOwnProperty.call(chStates.value, m.channelId)) return chStates.value[m.channelId] !== false
  return props.channelState !== false
})
const monitorTip = computed(() => {
  const unit = myMutable.value?.label || 'channel'
  return monitored.value
    ? `Monitored — the assistant reads this ${unit} and can respond autonomously. Click to mute (it stops reading & replying here; no restart).`
    : `Muted — the assistant ignores this ${unit}. Click to resume monitoring it.`
})
async function toggleMonitor() {
  const m = myMutable.value
  if (!m || monBusy.value) return
  const cur = monitored.value
  monBusy.value = true
  try {
    await manager.setChannel(m.instanceId, { channel_id: m.channelId, enabled: !cur })
    chStates.value = { ...chStates.value, [m.channelId]: !cur }
    emit('channel-toggled', key.value) // let a parent (e.g. Live) resync its own card view
  } catch (_) {}
  finally { monBusy.value = false }
}

// One-click copy of the session id.
const copied = ref(false)
function copyId() {
  const id = key.value
  const done = () => { copied.value = true; setTimeout(() => (copied.value = false), 1200) }
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(id).then(done).catch(done)
  else { try { const t = document.createElement('textarea'); t.value = id; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); done() } catch (_) {} }
}

// --- delete / forget this session (two-click confirm) ---
// Removes it from tracking + purges its events, and clears the core's engine mapping so the NEXT
// inbound on this key (e.g. the next message in this Discord channel) starts a fresh session.
const confirmDelete = ref(false)
const deleting = ref(false)
let _confirmTimer = null
async function onDelete() {
  if (!confirmDelete.value) { // first click arms; auto-disarms after a few seconds
    confirmDelete.value = true
    clearTimeout(_confirmTimer); _confirmTimer = setTimeout(() => { confirmDelete.value = false }, 4000)
    return
  }
  clearTimeout(_confirmTimer)
  deleting.value = true
  try {
    const r = await control.forget(key.value)
    if (r && r.ok !== false) emit('close')
    else { notice.value = { ok: false, text: r?.error || 'Delete failed' }; confirmDelete.value = false }
  } catch (e) { notice.value = { ok: false, text: 'Delete failed: ' + (e.message || e) }; confirmDelete.value = false }
  finally { deleting.value = false }
}

// --- title (inline-editable, manual override locks against AI regeneration) ---
const localTitle = ref(null)   // optimistic manual title (before the collector round-trips)
const pendingTitle = ref(null) // manual title set before the session row exists yet → retry after 1st turn
const editingTitle = ref(false)
const titleDraft = ref('')
const displayTitle = computed(() => props.titleOverride || localTitle.value || sess.value.title || sess.value.identity || (isWeb.value ? 'Web session' : 'Conversation'))
const titleLocked = computed(() => localTitle.value != null || !!sess.value.title_locked)
function startEditTitle() { titleDraft.value = displayTitle.value === 'Web session' ? '' : displayTitle.value; editingTitle.value = true; nextTick(() => titleField.value?.focus()) }
const titleField = ref(null)
async function saveTitle() {
  const t = titleDraft.value.trim()
  editingTitle.value = false
  localTitle.value = t || null // '' → revert to AI (clears local override; server unlocks)
  try {
    const r = await control.setTitle(key.value, t)
    if (!r.ok) pendingTitle.value = t // session row not created yet → apply after the first turn
    else { pendingTitle.value = null; store.fetchSessions() }
  } catch (_) { pendingTitle.value = t }
}
function cancelEditTitle() { editingTitle.value = false }

// ---- history ----------------------------------------------------------------
const seeded = ref([])
const loading = ref(true)
const scrollBox = ref(null)
const bottomSentinel = ref(null)
const STICK_PX = 80
const stickToBottom = ref(true)
const streamTick = ref(0)
let pinning = false
let pinClear = 0
const scrollerUnbind = []

const maxSeededTs = computed(() => (seeded.value.length ? seeded.value[seeded.value.length - 1].ts : 0))
const cutoffTs = ref(null)
const history = computed(() => {
  const live = store.events.filter((e) => e.session_id === key.value && e.ts > maxSeededTs.value).slice().reverse()
  let all = [...seeded.value, ...live]
  if (cutoffTs.value != null) all = all.filter((e) => e.ts <= cutoffTs.value)
  return all
})
async function load() {
  loading.value = true
  try {
    const data = await api.events({ session: key.value, limit: 300 })
    seeded.value = (data.events || []).map((e) => ({ ...e, _payload: parsePayload(e.payload) })).reverse()
  } catch (e) { seeded.value = [] }
  finally { loading.value = false; stickToBottom.value = true; scrollToBottom(true) }
}
function nearBottom(el) {
  if (!el) return true
  return (el.scrollHeight - el.scrollTop - el.clientHeight) <= STICK_PX
}
function isScroller(el) {
  if (!el || el.nodeType !== 1) return false
  if (el === document.documentElement || el === document.body) return false
  const oy = getComputedStyle(el).overflowY
  return oy === 'auto' || oy === 'scroll' || oy === 'overlay'
}
function realScrollers(from) {
  const out = []
  let n = from
  while (n && n !== document.body) {
    if (isScroller(n)) out.push(n)
    n = n.parentElement
  }
  return out
}
function bindScrollerListeners() {
  while (scrollerUnbind.length) scrollerUnbind.pop()()
  const box = scrollBox.value
  if (!box) return
  // Pin + stick against the REAL overflow ancestors (window host / flex parent),
  // not only scrollBox — 29a0331 set scrollTop on an inner div that never overflowed.
  for (const el of realScrollers(box.parentElement)) {
    const h = () => { if (!pinning) stickToBottom.value = nearBottom(el) }
    el.addEventListener('scroll', h, { passive: true })
    scrollerUnbind.push(() => el.removeEventListener('scroll', h))
  }
}
function onTranscriptScroll(e) {
  if (pinning) return
  const el = (e && e.currentTarget) || scrollBox.value
  if (el) stickToBottom.value = nearBottom(el)
}
function pinNow() {
  const box = scrollBox.value
  const sent = bottomSentinel.value
  pinning = true
  clearTimeout(pinClear)
  const targets = new Set()
  if (box) {
    targets.add(box)
    for (const s of realScrollers(box)) targets.add(s)
  }
  if (sent) {
    for (const s of realScrollers(sent)) targets.add(s)
    try { sent.scrollIntoView({ block: 'end', inline: 'nearest', behavior: 'auto' }) } catch (_) {}
  }
  for (const el of targets) {
    try { el.scrollTop = el.scrollHeight } catch (_) {}
  }
  stickToBottom.value = true
  pinClear = setTimeout(() => { pinning = false }, 80)
}
function scrollToBottom(force = false) {
  nextTick(() => {
    if (!force && !stickToBottom.value) return
    pinNow()
    requestAnimationFrame(() => {
      if (force || stickToBottom.value) pinNow()
    })
  })
}
function bumpStream() {
  streamTick.value++
  scrollToBottom()
}
onMounted(() => { load(); nextTick(bindScrollerListeners) })
watch(key, () => { load(); nextTick(bindScrollerListeners) })

// ---- chat rows (events → transcript) ----------------------------------------
// eventRow (event → chat row) lives in @/lib/transcript so this chat and the Schedules last-run
// transcript render identically. Local turns (web streaming) are appended below.
const localTurns = ref([]) // web sessions: { user, reply, tools:[], streaming, error, ts }
const rows = computed(() => {
  const out = history.value.map(eventRow)
  for (const t of localTurns.value) {
    out.push({ kind: 'user', text: t.user, ts: t.ts })
    if (t.tools?.length) out.push({ kind: 'activity', icon: '🔧', label: `using ${t.tools.join(', ')}`, text: '', ts: t.ts + 1 })
    out.push({ kind: 'assistant', text: t.reply, streaming: t.streaming, error: t.error, ts: t.ts + 2 })
  }
  return out
})
watch(() => rows.value.length, () => scrollToBottom())
watch(streamTick, () => scrollToBottom())

const expanded = ref({})
function toggleExpand(i) { expanded.value = { ...expanded.value, [i]: !expanded.value[i] } }

// ---- composer ---------------------------------------------------------------
const draft = ref('')
const busy = ref(false)
const notice = ref(null)
const attached = ref([])
const uploading = ref([])   // [{ id, name, pct }]: one row per file in flight
let uploadSeq = 0
const fileInput = ref(null)
let streamCtrl = null

function pickFile() { fileInput.value?.click() }
// Each file gets its own progress row, so one failure in a multi-file pick no longer overwrites the
// outcome of the others (the old single `notice` write left you with only the last error).
async function onFile(ev) {
  const files = Array.from(ev.target.files || [])
  ev.target.value = ''
  const failed = []
  // Drop a stale banner from a PREVIOUS upload only. `notice` is shared with send/inject/stop/voice,
  // and an upload now runs long enough that clearing it wholesale would wipe a message the user is
  // still reading (stop a turn mid-upload and the upload's success would erase the confirmation).
  if (notice.value?.upload) notice.value = null
  for (const f of files) {
    const id = ++uploadSeq                     // stable key: progress updates replace the row object
    uploading.value = [...uploading.value, { id, name: f.name, pct: 0 }]
    try {
      const r = await webChat.upload(f, key.value, {
        onProgress: (p) => { uploading.value = uploading.value.map((u) => (u.id === id ? { ...u, pct: Math.round(p * 100) } : u)) }
      })
      if (r.ok) attached.value = [...attached.value, r.file]
      else failed.push(`${f.name}: the server did not confirm the upload`)   // never drop it silently
    } catch (e) {
      failed.push(`${f.name}: ${e.message}`)
    } finally {
      uploading.value = uploading.value.filter((u) => u.id !== id)
    }
  }
  if (failed.length) notice.value = { ok: false, upload: true, text: `upload failed: ${failed.join('; ')}` }
}
function removeAttachment(i) { attached.value = attached.value.filter((_, j) => j !== i) }

function webSend() {
  const text = draft.value.trim()
  if (!text && !attached.value.length) return
  if (cutoffTs.value == null) cutoffTs.value = Math.max(maxSeededTs.value, ...store.events.filter((e) => e.session_id === key.value).map((e) => e.ts), 0)
  const files = attached.value.slice()
  let body = text
  if (files.length) body += '\n\n' + files.map((f) => `[Attached file: ${f.name} → ${f.path}]`).join('\n')
  const turn = reactive({ user: text + (files.length ? `\n📎 ${files.map((f) => f.name).join(', ')}` : ''), reply: '', tools: [], streaming: true, error: null, ts: Date.now(), blockClosed: false })
  localTurns.value = [...localTurns.value, turn]
  stickToBottom.value = true
  scrollToBottom(true)
  draft.value = ''; attached.value = []; notice.value = null; busy.value = true
  streamCtrl = webChat.send(
    { conversation_key: key.value, text: body, attachments: files.map((f) => ({ type: f.kind === 'image' ? 'image' : 'file', path: f.path, name: f.name, media_type: f.mime })), working_dir: sess.value.working_dir || null, system_prompt_extra: props.contextProvider ? props.contextProvider() : null },
    {
      onDelta: (t) => {
        // Discord: a tool (or a completed narration block) closes the pending
        // draft. Later tokens are a new block — do not glue status + answer.
        if (turn.blockClosed) { turn.reply = t || ''; turn.blockClosed = false }
        else turn.reply += t
        bumpStream()
      },
      onTool: (name) => {
        if (name && !turn.tools.includes(name)) { turn.tools = [...turn.tools, name] }
        turn.blockClosed = true
        bumpStream()
      },
      onSegment: (t) => {
        turn.reply = applySegment(turn.blockClosed ? '' : turn.reply, t)
        turn.blockClosed = false
        bumpStream()
      },
      onDone: async (actions) => {
        turn.streaming = false; busy.value = false; streamCtrl = null; store.fetchSessions()
        bumpStream()
        if (ttsOn.value && turn.reply) speak(turn.reply).catch(() => {}) // read the reply aloud when TTS is on
        if (pendingTitle.value != null) { control.setTitle(key.value, pendingTitle.value).then((r) => { if (r.ok) pendingTitle.value = null }).catch(() => {}) }
        try {
          let lastText = ''
          const replyAct = (actions || []).find((a) => a && a.type === 'reply' && a.text)
          if (replyAct) lastText = replyAct.text
          if (!lastText) {
            const data = await api.events({ session: key.value, limit: 300 })
            let lastTs = -Infinity
            for (const e of data.events || []) {
              if (e.event_type !== 'outbound') continue
              const ts = e.ts ?? 0
              if (ts >= lastTs) {
                lastTs = ts
                const payload = parsePayload(e.payload) || {}
                lastText = payload.text || ''
              }
            }
          }
          // Last finished block wins. Do not keep a longer glued draft+answer
          // (live mash or stored mash) just because it has more characters.
          const next = preferLastBlock(lastText, turn.reply)
          if (next !== (turn.reply || '')) { turn.reply = next; bumpStream() }
        } catch (_) {}
      },
      onError: (err) => { turn.streaming = false; turn.error = err; busy.value = false; streamCtrl = null; bumpStream() }
    }
  )
}

async function doInject() {
  const text = draft.value.trim()
  if (!text) return
  busy.value = true; notice.value = null
  try {
    if (isCli.value) {
      await control.sendText(key.value, text); draft.value = ''
      notice.value = { ok: true, text: 'Typed into the session + pressed Enter.' }
    } else {
      const r = await control.inject(key.value, text)
      if (r.ok) { draft.value = ''; notice.value = { ok: true, text: `Directed — ${r.delivered ? 'reply sent to the channel' : (r.deliverErr ? `reply not delivered: ${r.deliverErr}` : 'no channel delivery')}.` } }
      else notice.value = { ok: false, text: r.error || 'inject failed' }
    }
  } catch (e) { notice.value = { ok: false, text: e.message } }
  finally { busy.value = false }
}

// ---- voice: read replies aloud (TTS) + dictate messages (STT), both via the configured models ----
const { speaking, speak, stopSpeaking, cancelRecording, live, listening, startLive, stopLive } = useSpeech()
const ttsOn = ref(false)
try { ttsOn.value = localStorage.getItem('asmltr:tts') === '1' } catch (_) {}
function toggleTts() {
  ttsOn.value = !ttsOn.value
  try { localStorage.setItem('asmltr:tts', ttsOn.value ? '1' : '0') } catch (_) {}
  if (!ttsOn.value) stopSpeaking()
}
// Mic = hands-free voice: streaming transcription with server-side VAD. Partial text fills the
// composer live; when the VAD detects you've stopped, the utterance auto-sends. Click again to stop.
async function toggleMic() {
  if (live.value) { stopLive(); return }
  await startLive({
    onPartial: (t) => { draft.value = t },
    onFinal: (t) => { draft.value = t; if (t.trim() && !busy.value) onSend() },
    onError: (msg) => { notice.value = { ok: false, text: 'voice: ' + msg } },
  })
}
// Manually (re)read a specific message aloud — the speaker button on assistant bubbles.
function readAloud(text) { speak(text).catch((e) => { notice.value = { ok: false, text: 'read-aloud failed: ' + e.message } }) }

function onSend() { return isWeb.value ? webSend() : doInject() }

async function onStop() {
  if (isWeb.value) {
    try { streamCtrl?.abort() } catch (_) {}
    try { await control.abort(key.value) } catch (_) {}
    const t = localTurns.value[localTurns.value.length - 1]
    if (t && t.streaming) { t.streaming = false; t.error = t.error || 'stopped' }
    busy.value = false; notice.value = { ok: true, text: 'Stopped the in-flight turn.' }
    return
  }
  busy.value = true; notice.value = null
  try {
    if (isCli.value) { await control.sendKey(key.value, 'Escape'); notice.value = { ok: true, text: 'Sent an interrupt (Escape) to the session.' } }
    else { const r = await control.abort(key.value); notice.value = { ok: !!r.ok, text: r.ok ? 'Stopped the in-flight turn (session still resumable).' : (r.error || 'nothing in flight') } }
  } catch (e) { notice.value = { ok: false, text: e.message } }
  finally { busy.value = false }
}

onBeforeUnmount(() => { try { streamCtrl?.abort() } catch (_) {} while (scrollerUnbind.length) scrollerUnbind.pop()(); clearTimeout(pinClear); stopSpeaking(); cancelRecording(); stopLive() })

const placeholder = computed(() => {
  if (isWeb.value) return 'Message this session… (Enter to send, Shift+Enter for a newline)'
  if (isCli.value) return 'Type a message to send into the terminal session (Enter)…'
  return 'Type a message to direct this conversation, then Send (reply goes back to the channel)…'
})
</script>

<template>
  <FloatingWindow :storage-key="'asmltr:win:' + key" :subtitle="key" :z="z" :focused="focused" :minimized="minimized" :accent="accent"
                  @close="$emit('close')" @minimize="$emit('minimize')" @focus="$emit('focus')">
    <!-- editable title -->
    <template #title>
      <div v-if="!editingTitle" class="flex min-w-0 items-center gap-1.5">
        <h2 class="truncate text-base font-bold tracking-tight"><span class="gradient-text">{{ displayTitle }}</span></h2>
        <span v-if="titleLocked" class="shrink-0 text-[10px] text-slate-500" title="Manual title — AI won't override it"><AppIcon glyph="🔒" /></span>
        <button
          type="button"
          class="shrink-0 rounded px-1 text-slate-500 hover:bg-white/10 hover:text-slate-200"
          title="Rename this session (overrides the AI-generated title)"
          @pointerdown.stop
          @click="startEditTitle"
        ><AppIcon glyph="✎" /></button>
      </div>
      <div v-else class="flex min-w-0 items-center gap-1.5" @pointerdown.stop>
        <input
          ref="titleField"
          v-model="titleDraft"
          type="text"
          placeholder="Session title (empty = back to AI)"
          class="min-w-0 flex-1 rounded-md border border-brand-violet/40 bg-white/[0.06] px-2 py-1 text-sm text-slate-100 outline-none focus:border-brand-violet/70"
          @keydown.enter.prevent="saveTitle"
          @keydown.esc.prevent="cancelEditTitle"
        />
        <button type="button" class="shrink-0 rounded bg-brand-gradient px-2 py-1 text-xs font-semibold text-white" @click="saveTitle">Save</button>
        <button type="button" class="shrink-0 rounded border border-white/10 bg-white/5 px-2 py-1 text-xs text-slate-400 hover:text-slate-200" @click="cancelEditTitle"><AppIcon glyph="✕" /></button>
      </div>
    </template>

    <!-- flex transcript pane: one bounded column so the window host cannot grow/clip (Titanic). -->
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
    <!-- meta strip -->
    <div class="mb-2 flex shrink-0 flex-wrap items-center gap-2 text-[11px]">
      <SurfaceBadge :surface="sess.surface" />
      <span v-if="sess.working_dir" class="pill border border-white/10 bg-white/5 font-mono text-slate-400" :title="'working dir: ' + sess.working_dir"><AppIcon glyph="📂" /> {{ truncate(sess.working_dir, 30) }}</span>
      <span v-if="sess.location" class="pill border border-white/10 bg-white/5 text-slate-300" :title="'origin: ' + sess.location"><AppIcon :name="['fas','comments']" /> {{ sess.location }}</span>
      <span v-if="sess.kind" class="pill border border-white/10 bg-white/5 text-slate-300">{{ sess.kind }}</span>
      <span class="flex items-center gap-1.5" :style="{ color: st.color }">
        <span class="h-2 w-2 rounded-full" :class="st.pulse ? 'animate-pulse-dot' : ''" :style="{ backgroundColor: st.color }"></span>
        {{ st.label }}
      </span>
      <span v-if="sess.tokens_total" class="pill border border-violet-400/30 bg-violet-400/10 text-violet-300">⟁ {{ fmtNum(sess.tokens_total) }} tok</span>
      <span v-if="sess.tool_count" class="pill border border-amber-400/30 bg-amber-400/10 text-amber-300"><AppIcon glyph="🛠" /> {{ fmtNum(sess.tool_count) }}</span>
      <span v-if="sess.last_activity_unix" class="text-slate-500">last {{ fmtAge(sess.last_activity_unix, now) }}</span>
      <button
        v-if="myMutable"
        type="button"
        :disabled="monBusy"
        :title="monitorTip"
        class="pill border transition-colors disabled:opacity-40"
        :class="monitored ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300 hover:bg-emerald-400/20' : 'border-white/10 bg-white/5 text-slate-400 hover:text-slate-200'"
        @click="toggleMonitor"
      ><template v-if="monBusy">…</template><template v-else><AppIcon :glyph="monitored ? '●' : '○'" /> {{ monitored ? 'monitored' : 'muted' }}</template></button>
      <button
        type="button"
        class="pill border border-white/10 bg-white/5 text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-200"
        :title="copied ? 'Copied!' : 'Copy session id'"
        @click="copyId"
      ><AppIcon :glyph="copied ? '✓' : '⧉'" /> {{ copied ? 'copied' : 'copy id' }}</button>
      <button
        type="button"
        :disabled="deleting"
        class="pill border transition-colors disabled:opacity-40"
        :class="confirmDelete ? 'border-red-400/50 bg-red-500/20 text-red-200' : 'border-white/10 bg-white/5 text-slate-500 hover:border-red-400/40 hover:text-red-300'"
        :title="confirmDelete ? 'Click again to permanently forget this session (the next message starts a fresh one)' : 'Delete this session — remove it from tracking and clear its history; the next inbound message starts a new session'"
        @click="onDelete"
      ><template v-if="deleting">…</template><template v-else-if="confirmDelete"><AppIcon glyph="✓" /> confirm delete</template><template v-else><AppIcon glyph="🗑" /> delete</template></button>
    </div>

    <!-- transcript (fills the window) -->
    <div ref="scrollBox" class="min-h-0 flex-1 space-y-2.5 overflow-y-auto rounded-xl border border-white/5 bg-black/20 p-3" @scroll.passive="onTranscriptScroll">
      <p v-if="loading" class="py-6 text-center text-sm text-slate-500">loading history…</p>
      <p v-else-if="!rows.length" class="py-8 text-center text-sm text-slate-500">
        {{ isWeb ? 'New session — send a message below to begin.' : 'No events recorded for this session yet.' }}
      </p>
      <template v-for="(r, i) in rows" :key="i">
        <div v-if="r.kind === 'user'" class="flex justify-end">
          <div class="max-w-[82%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm border border-brand-violet/30 bg-brand-violet/15 px-3 py-2 text-[13px] leading-snug text-violet-100">{{ r.text }}</div>
        </div>
        <div v-else-if="r.kind === 'assistant'" class="flex justify-start">
          <div class="max-w-[82%] whitespace-pre-wrap break-words rounded-2xl rounded-bl-sm border border-white/10 bg-white/[0.05] px-3 py-2 text-[13px] leading-snug"
               :class="r.error ? 'text-rose-300' : 'text-slate-100'">
            <span v-if="r.streaming">{{ r.text }}</span>
            <div v-else-if="r.text" class="asmltr-md whitespace-normal [&_p]:my-1 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_strong]:font-semibold [&_em]:italic [&_code]:rounded [&_code]:bg-black/30 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[12px] [&_pre]:my-1.5 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-black/40 [&_pre]:p-2 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-4 [&_li]:my-0.5 [&_a]:text-violet-300 [&_a]:underline [&_h1]:my-1 [&_h1]:font-semibold [&_h2]:my-1 [&_h2]:font-semibold [&_h3]:my-1 [&_h3]:font-semibold [&_blockquote]:border-l-2 [&_blockquote]:border-white/20 [&_blockquote]:pl-2 [&_blockquote]:text-slate-300" v-html="renderMarkdown(r.text)"></div>
            <span v-if="r.streaming" class="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse-dot rounded-sm bg-brand-violet/80 align-middle"></span>
            <span v-if="r.streaming && !r.text" class="text-slate-500">thinking…</span>
            <span v-if="r.error" class="block text-[11px] text-rose-400/80"><AppIcon glyph="⚠" /> {{ r.error }}</span>
            <button
              v-if="!r.streaming && !r.error && r.text"
              type="button" title="Read this reply aloud (configured voice)"
              class="mt-1 block text-[11px] text-slate-500 transition-colors hover:text-violet-300"
              @click="readAloud(r.text)"
            ><AppIcon glyph="🔊" /> {{ speaking ? 'speaking…' : 'read aloud' }}</button>
            <!-- auto-detected local files the agent created → click to download through asmltr -->
            <FileArtifacts v-if="r.text" :text="r.text" :streaming="!!r.streaming" />
          </div>
        </div>
        <div v-else class="flex items-start gap-1.5 pl-1 text-[11px] text-slate-500">
          <AppIcon :glyph="r.icon" class="shrink-0 select-none opacity-80" />
          <span class="shrink-0 font-semibold uppercase tracking-wide text-slate-500/90">{{ r.label }}</span>
          <span
            v-if="r.text"
            class="min-w-0 cursor-pointer break-words"
            :class="[r.mono ? 'font-mono' : '', r.err ? 'text-rose-400/80' : 'text-slate-500', expanded[i] ? 'whitespace-pre-wrap' : 'truncate']"
            :title="expanded[i] ? 'click to collapse' : 'click to expand'"
            @click="toggleExpand(i)"
          >{{ expanded[i] ? truncate(r.text, 6000) : truncate(r.text, 140) }}</span>
        </div>
      </template>
      <div ref="bottomSentinel" aria-hidden="true" class="h-px w-full shrink-0"></div>
    </div>
    </div>

    <template #footer>
      <div class="w-full">
        <div v-if="attachCmd" class="mb-2 flex items-center gap-2 text-[11px] text-slate-400">
          <span>Take over in your terminal (detach from the channel):</span>
          <code class="rounded bg-black/40 px-1.5 py-0.5 font-mono text-brand-violet/90">{{ attachCmd }}</code>
        </div>
        <div v-if="notice" class="mb-2 text-xs" :class="notice.ok ? 'text-emerald-300' : 'text-rose-300'">{{ notice.text }}</div>
        <div v-if="attached.length || uploading.length" class="mb-2 flex flex-wrap items-center gap-1.5">
          <span v-for="(a, i) in attached" :key="a.path" class="pill flex items-center gap-1 border border-white/10 bg-white/5 text-slate-300">
            <AppIcon glyph="📎" /> {{ truncate(a.name, 26) }}
            <button type="button" class="text-slate-500 hover:text-rose-300" title="remove" @click="removeAttachment(i)"><AppIcon glyph="✕" /></button>
          </span>
          <!-- one row per in-flight file, with the real byte-level percentage -->
          <span v-for="u in uploading" :key="u.id" class="pill flex items-center gap-1.5 border border-white/10 bg-white/5 text-slate-400">
            <span class="text-[11px]">{{ truncate(u.name, 22) }}</span>
            <span class="h-1 w-16 overflow-hidden rounded-full bg-white/10">
              <span class="block h-full bg-brand-violet/80 transition-[width] duration-150" :style="{ width: u.pct + '%' }" />
            </span>
            <span class="w-8 text-right font-mono text-[10px] text-slate-500">{{ u.pct }}%</span>
          </span>
        </div>
        <div class="flex items-end gap-2">
          <button
            type="button"
            :disabled="busy && !isWeb"
            :title="isCli ? 'Send an interrupt (Escape)' : 'Abort the in-flight turn — the session survives'"
            class="shrink-0 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs font-semibold text-rose-300 transition-colors hover:bg-rose-500/20 disabled:opacity-40"
            @click="onStop"
          ><template v-if="isCli">⎋ Interrupt</template><template v-else><AppIcon glyph="⏹" /> Stop</template></button>
          <button
            v-if="isWeb"
            type="button"
            :disabled="uploading.length > 0"
            title="Attach a file — saved to the shared upload area and referenced so the agent can read it"
            class="shrink-0 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-semibold text-slate-300 transition-colors hover:bg-white/10 disabled:opacity-40"
            @click="pickFile"
          ><AppIcon glyph="📎" /></button>
          <input ref="fileInput" type="file" multiple class="hidden" @change="onFile" />
          <!-- read replies aloud (TTS) — configured voice/model; web sessions render the reply locally -->
          <button
            v-if="isWeb"
            type="button"
            :title="ttsOn ? 'Reading replies aloud is ON — click to mute (voice/model from Settings)' : 'Read replies aloud with the configured voice'"
            class="shrink-0 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors"
            :class="ttsOn ? 'border-brand-violet/50 bg-brand-violet/15 text-violet-200' : 'border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/10'"
            @click="toggleTts"
          ><AppIcon :glyph="ttsOn ? '🔊' : '🔈'" /></button>
          <!-- hands-free voice (STT) — streaming transcription + server VAD → auto-sends when you pause -->
          <button
            type="button"
            :title="live ? 'Hands-free voice ON — speak; it auto-sends when you pause. Click to stop.' : 'Hands-free voice — stream + auto-send with the configured STT model'"
            class="shrink-0 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors"
            :class="live ? (listening ? 'border-emerald-500/60 bg-emerald-500/20 text-emerald-200 animate-pulse' : 'border-rose-500/50 bg-rose-500/15 text-rose-200') : 'border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/10'"
            @click="toggleMic"
          ><AppIcon :glyph="live ? (listening ? '🎙' : '🎧') : '🎙'" /></button>
          <textarea
            v-model="draft"
            rows="1"
            :placeholder="placeholder"
            class="min-h-[38px] flex-1 resize-y rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-slate-100 outline-none transition-colors placeholder:text-slate-600 focus:border-brand-violet/60 focus:bg-white/[0.06]"
            @keydown.enter.exact.prevent="onSend"
          ></textarea>
          <button
            type="button"
            :disabled="busy || (!draft.trim() && !attached.length)"
            class="shrink-0 rounded-lg bg-brand-gradient px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-brand-violet/30 transition-opacity disabled:opacity-40"
            @click="onSend"
          >{{ busy ? '…' : 'Send' }}</button>
        </div>
      </div>
    </template>
  </FloatingWindow>
</template>
