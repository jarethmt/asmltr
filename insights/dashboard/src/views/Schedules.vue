<script setup>
// Schedules — "cron with a GUI". Each job fires on a schedule and is either a PROMPT (a real managed
// turn through the core → no `claude -p` session leak) or a SHELL command/script (host cron parity).
// This is what powers the morning brief again + drives asmltr notify. Owner-only (2FA-gated) surface.
// The view: a list of jobs (schedule, next/last run, status, enable toggle, run-now, edit, delete) and
// an add/edit modal with a friendly time+weekday picker (advanced raw-cron field) + per-type payload.
import { onMounted, reactive, ref, computed, onBeforeUnmount } from 'vue'
import { schedulesApi } from '@/services/api'
import PageHeader from '@/components/PageHeader.vue'
import ModalShell from '@/components/ModalShell.vue'
import ChatTranscript from '@/components/ChatTranscript.vue'

const items = ref([])
const loading = ref(false)
const error = ref(null)
const busy = reactive({}) // id -> action in flight
const runResult = reactive({}) // id -> { ok, text }
const outOpen = reactive({}) // id -> last-run panel expanded?
function toggleOut(id) { outOpen[id] = !outOpen[id] }
// The collector session_id a prompt job runs under (mirrors scheduler.js: fresh → schedule:<id>).
function jobKey(job) { return (!job.session || job.session === 'new') ? `schedule:${job.id}` : job.session }

const TYPE_META = {
  prompt: { label: 'prompt', color: '#8B5CF6', icon: '🧠' },
  shell: { label: 'shell', color: '#22D3EE', icon: '⌘' }
}
const typeMeta = (t) => TYPE_META[t] || { label: t, color: '#94A3B8', icon: '•' }

const WEEKDAYS = [
  { n: 1, l: 'Mon' }, { n: 2, l: 'Tue' }, { n: 3, l: 'Wed' }, { n: 4, l: 'Thu' },
  { n: 5, l: 'Fri' }, { n: 6, l: 'Sat' }, { n: 0, l: 'Sun' }
]

function fmtWhen(ms) {
  if (!ms) return '—'
  const d = new Date(ms)
  const now = Date.now()
  const abs = d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const diff = ms - now
  const mins = Math.round(Math.abs(diff) / 60000)
  let rel
  if (mins < 1) rel = 'now'
  else if (mins < 60) rel = mins + 'm'
  else if (mins < 1440) rel = Math.round(mins / 60) + 'h'
  else rel = Math.round(mins / 1440) + 'd'
  return `${abs} (${diff >= 0 ? 'in ' : ''}${rel}${diff < 0 ? ' ago' : ''})`
}

// friendly summary of a stored schedule spec, for the list
function describeSchedule(job) {
  const s = job.schedule
  if (s && s.time) {
    const wd = (s.weekdays || s.days || [])
    const days = wd.length ? wd.map((n) => (WEEKDAYS.find((w) => w.n === Number(n)) || {}).l || n).join(' ') : 'every day'
    return `${s.time} · ${days}`
  }
  if (s && s.every_minutes) return `every ${s.every_minutes} min`
  return job.cron || (s && s.cron) || '—'
}

async function load() {
  loading.value = true; error.value = null
  try { items.value = (await schedulesApi.list()).jobs || [] }
  catch (e) { error.value = e.message }
  finally { loading.value = false }
}

async function onToggle(job) {
  busy[job.id] = 'toggle'
  try { await schedulesApi.update(job.id, { enabled: !job.enabled }); await load() }
  catch (e) { error.value = e.message }
  finally { busy[job.id] = '' }
}

async function onRun(job) {
  busy[job.id] = 'run'; delete runResult[job.id]
  try {
    const r = await schedulesApi.runNow(job.id)
    runResult[job.id] = { ok: r.ok, text: r.ok ? (String(r.output || '').slice(0, 200) || 'ok') : (r.error || r.output || 'failed') }
    await load()
  } catch (e) { runResult[job.id] = { ok: false, text: e.message } }
  finally { busy[job.id] = '' }
}

async function onDelete(job) {
  if (!window.confirm(`Delete schedule "${job.name}"?`)) return
  busy[job.id] = 'delete'
  try { await schedulesApi.remove(job.id); await load() }
  catch (e) { error.value = e.message }
  finally { busy[job.id] = '' }
}

// ── add / edit modal ──────────────────────────────────────────────────────────
const modalOpen = ref(false)
const editingId = ref(null)
const submitting = ref(false)
const formError = ref(null)
const form = reactive({
  name: '', type: 'prompt', enabled: true,
  mode: 'friendly',                 // 'friendly' | 'cron'
  time: '08:00', weekdays: [1, 2, 3, 4, 5], cron: '0 8 * * 1-5',
  // prompt payload
  prompt: '', engine: '', session: 'new',
  // shell payload
  command: '', script_path: '', cwd: '', timeout_s: 300
})

function resetForm() {
  Object.assign(form, {
    name: '', type: 'prompt', enabled: true, mode: 'friendly',
    time: '08:00', weekdays: [1, 2, 3, 4, 5], cron: '0 8 * * 1-5',
    prompt: '', engine: '', session: 'new', command: '', script_path: '', cwd: '', timeout_s: 300
  })
}

function openAdd() { editingId.value = null; resetForm(); formError.value = null; modalOpen.value = true }

function openEdit(job) {
  editingId.value = job.id; formError.value = null
  resetForm()
  form.name = job.name; form.type = job.type; form.enabled = job.enabled
  const s = job.schedule || {}
  if (s.time) { form.mode = 'friendly'; form.time = s.time; form.weekdays = (s.weekdays || s.days || []).map(Number) }
  else { form.mode = 'cron'; form.cron = job.cron || s.cron || '' }
  if (job.type === 'prompt') { form.prompt = job.prompt || ''; form.engine = job.engine || ''; form.session = job.session || 'new' }
  else { form.command = job.command || ''; form.script_path = job.script_path || ''; form.cwd = job.cwd || ''; form.timeout_s = job.timeout_s || 300 }
  modalOpen.value = true
}

function toggleWeekday(n) {
  const i = form.weekdays.indexOf(n)
  if (i >= 0) form.weekdays.splice(i, 1); else form.weekdays.push(n)
}

const canSubmit = computed(() => {
  if (!form.name.trim()) return false
  if (form.mode === 'cron' && !form.cron.trim()) return false
  if (form.type === 'prompt') return !!form.prompt.trim()
  return !!(form.command.trim() || form.script_path.trim())
})

function buildPayload() {
  const schedule = form.mode === 'cron'
    ? { cron: form.cron.trim() }
    : { time: form.time, weekdays: form.weekdays.slice().sort((a, b) => a - b) }
  const p = { name: form.name.trim(), type: form.type, enabled: form.enabled, schedule }
  if (form.type === 'prompt') { p.prompt = form.prompt; p.engine = form.engine || ''; p.session = form.session || 'new' }
  else { p.command = form.command; p.script_path = form.script_path; p.cwd = form.cwd; p.timeout_s = Number(form.timeout_s) || 300 }
  return p
}

async function onSubmit() {
  if (!canSubmit.value || submitting.value) return
  submitting.value = true; formError.value = null
  try {
    const payload = buildPayload()
    if (editingId.value) await schedulesApi.update(editingId.value, payload)
    else await schedulesApi.create(payload)
    modalOpen.value = false
    await load()
  } catch (e) { formError.value = e.message }
  finally { submitting.value = false }
}

let timer = null
onMounted(() => { load(); timer = setInterval(load, 30000) })
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <div>
    <PageHeader title="Schedules" subtitle="Cron with a GUI — prompt jobs (managed turns) + shell jobs. Times use the server's local clock.">
      <template #actions>
        <button class="glass glass-hover px-3 py-1.5 text-sm text-slate-300" @click="load"><AppIcon glyph="↻" /> Refresh</button>
        <button class="rounded-xl bg-brand-gradient px-3 py-1.5 text-sm font-semibold text-white shadow-lg shadow-brand-violet/30 transition-opacity hover:opacity-90" @click="openAdd">＋ New schedule</button>
      </template>
    </PageHeader>

    <p v-if="error" class="mb-4 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm text-rose-300">{{ error }}</p>


    <div v-if="items.length" class="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <div v-for="job in items" :key="job.id" class="glass glass-hover flex flex-col gap-3 p-4" :class="{ 'opacity-60': !job.enabled }">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <span class="pill border" :style="{ color: typeMeta(job.type).color, borderColor: typeMeta(job.type).color + '40', backgroundColor: typeMeta(job.type).color + '1a' }">{{ typeMeta(job.type).icon }} {{ typeMeta(job.type).label }}</span>
              <span class="truncate text-sm font-semibold text-slate-100" :title="job.name">{{ job.name }}</span>
            </div>
            <div class="mt-1 font-mono text-[12px] text-slate-400">{{ describeSchedule(job) }} <span class="text-slate-600">· {{ job.cron }}</span></div>
          </div>
          <!-- enable toggle -->
          <button type="button" class="shrink-0" :disabled="busy[job.id]" :title="job.enabled ? 'Enabled — click to pause' : 'Paused — click to enable'" @click="onToggle(job)">
            <span class="pill border" :class="job.enabled ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300' : 'border-white/10 bg-white/5 text-slate-500'">{{ job.enabled ? '● on' : '○ off' }}</span>
          </button>
        </div>

        <!-- run times -->
        <div class="grid grid-cols-2 gap-2 text-[11px]">
          <div><span class="text-slate-500">Next</span> <span class="text-slate-300">{{ job.enabled ? fmtWhen(job.next_run) : 'paused' }}</span></div>
          <div><span class="text-slate-500">Last</span>
            <span v-if="job.last_run" class="text-slate-300">{{ fmtWhen(job.last_run) }}</span>
            <span v-else class="text-slate-600">never</span>
            <span v-if="job.last_status" class="pill ml-1 border" :class="job.last_status === 'ok' ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300' : 'border-rose-500/30 bg-rose-500/10 text-rose-300'">{{ job.last_status }}</span>
          </div>
        </div>

        <!-- last run — collapsible. Prompt jobs render the full chat transcript (thinking + tools +
             reply, same as the Live session chat); shell jobs show raw stdout. -->
        <div v-if="job.last_run || job.last_output || job.last_error" class="rounded-lg border border-white/5 bg-black/20">
          <button type="button" class="flex w-full items-center justify-between px-2.5 py-1.5 text-[11px] text-slate-400 transition-colors hover:text-slate-200" @click="toggleOut(job.id)">
            <span>Last run output</span>
            <span class="text-slate-500">{{ outOpen[job.id] ? '▾ hide' : '▸ show' }}</span>
          </button>
          <div v-if="outOpen[job.id]" class="max-h-96 overflow-y-auto border-t border-white/5 p-2.5">
            <ChatTranscript
              v-if="job.type === 'prompt'"
              :session-id="jobKey(job)"
              empty-text="No transcript for this run — re-run to capture the full thinking + tool output."
            />
            <pre v-else class="whitespace-pre-wrap text-[11px] leading-relaxed text-slate-400">{{ job.last_error || job.last_output || '(no output)' }}</pre>
            <p v-if="job.last_error && job.type === 'prompt'" class="mt-2 rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-300"><AppIcon glyph="⚠" /> {{ job.last_error }}</p>
          </div>
        </div>

        <!-- actions -->
        <div class="mt-1 flex flex-wrap items-center gap-2 border-t border-white/5 pt-3">
          <button type="button" class="act" :disabled="busy[job.id]" @click="onRun(job)">
            <template v-if="busy[job.id] === 'run'">running…</template>
            <template v-else>▶ Run now</template>
          </button>
          <button type="button" class="act" :disabled="busy[job.id]" @click="openEdit(job)"><AppIcon glyph="✎" /> Edit</button>
          <span v-if="runResult[job.id]" class="pill border max-w-[18rem] truncate" :class="runResult[job.id].ok ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300' : 'border-rose-500/30 bg-rose-500/10 text-rose-300'" :title="runResult[job.id].text">{{ runResult[job.id].text }}</span>
          <button type="button" class="act-danger ml-auto" :disabled="busy[job.id]" @click="onDelete(job)"><AppIcon glyph="🗑" /> Delete</button>
        </div>
      </div>
    </div>

    <p v-else class="glass px-4 py-6 text-center text-sm text-slate-500">{{ loading ? 'Loading schedules…' : 'No schedules yet — create one above (e.g. an 08:00 weekday prompt that delivers your morning brief).' }}</p>

    <!-- add / edit modal -->
    <ModalShell v-if="modalOpen" :title="editingId ? 'Edit schedule' : 'New schedule'" subtitle="A prompt job runs a managed turn; a shell job runs a host command." wide @close="modalOpen = false">
      <form class="flex flex-col gap-4" @submit.prevent="onSubmit">
        <!-- name + type -->
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label class="mb-1 block text-sm font-medium text-slate-200">Name <span class="text-rose-400">*</span></label>
            <input v-model="form.name" type="text" class="field-input" placeholder="Morning brief" />
          </div>
          <div>
            <label class="mb-1 block text-sm font-medium text-slate-200">Type</label>
            <div class="flex gap-2">
              <button v-for="t in ['prompt', 'shell']" :key="t" type="button" class="flex-1 rounded-xl border px-3 py-2 text-sm font-medium transition-colors" :class="form.type === t ? 'border-brand-violet/60 bg-brand-violet/15 text-white' : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'" @click="form.type = t">{{ typeMeta(t).icon }} {{ typeMeta(t).label }}</button>
            </div>
          </div>
        </div>

        <!-- schedule -->
        <div>
          <div class="mb-1 flex items-center justify-between">
            <label class="text-sm font-medium text-slate-200">Schedule</label>
            <div class="flex gap-1 text-xs">
              <button type="button" class="tab" :class="form.mode === 'friendly' ? 'tab-on' : ''" @click="form.mode = 'friendly'">Simple</button>
              <button type="button" class="tab" :class="form.mode === 'cron' ? 'tab-on' : ''" @click="form.mode = 'cron'">Advanced (cron)</button>
            </div>
          </div>
          <div v-if="form.mode === 'friendly'" class="rounded-xl border border-white/10 bg-white/[0.03] p-3">
            <div class="flex items-center gap-3">
              <span class="text-sm text-slate-400">At</span>
              <input v-model="form.time" type="time" class="field-input w-32" />
            </div>
            <div class="mt-3 flex flex-wrap gap-1.5">
              <button v-for="w in WEEKDAYS" :key="w.n" type="button" class="rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors" :class="form.weekdays.includes(w.n) ? 'border-brand-violet/60 bg-brand-violet/15 text-white' : 'border-white/10 bg-white/5 text-slate-400 hover:bg-white/10'" @click="toggleWeekday(w.n)">{{ w.l }}</button>
            </div>
            <p class="mt-2 text-xs text-slate-500">{{ form.weekdays.length ? 'Runs on the selected days.' : 'No days selected = every day.' }}</p>
          </div>
          <div v-else>
            <input v-model="form.cron" type="text" class="field-input font-mono" placeholder="0 8 * * 1-5" />
            <p class="mt-1 text-xs text-slate-500">Standard 5-field cron: <span class="font-mono">minute hour day-of-month month day-of-week</span>. Server local time.</p>
          </div>
        </div>

        <!-- prompt payload -->
        <template v-if="form.type === 'prompt'">
          <div>
            <label class="mb-1 block text-sm font-medium text-slate-200">Prompt <span class="text-rose-400">*</span></label>
            <textarea v-model="form.prompt" rows="4" class="field-input" placeholder="Write a warm ~25-word wake-up for me and deliver it with asmltr notify (read-aloud)."></textarea>
            <p class="mt-1 text-xs text-slate-500">Runs as a real managed turn (full tools) — it can call <span class="font-mono">asmltr notify</span> to deliver a brief. No session leak.</p>
          </div>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label class="mb-1 block text-sm font-medium text-slate-200">Engine</label>
              <select v-model="form.engine" class="field-input">
                <option value="">Default engine</option>
                <option value="claude">claude</option>
                <option value="codex">codex</option>
                <option value="gemini">gemini</option>
                <option value="grok">grok</option>
              </select>
            </div>
            <div>
              <label class="mb-1 block text-sm font-medium text-slate-200">Session</label>
              <input v-model="form.session" type="text" class="field-input font-mono" placeholder="new" />
              <p class="mt-1 text-xs text-slate-500"><span class="font-mono">new</span> = fresh context each run; or a conversation_key to continue one.</p>
            </div>
          </div>
        </template>

        <!-- shell payload -->
        <template v-else>
          <div>
            <label class="mb-1 block text-sm font-medium text-slate-200">Command</label>
            <input v-model="form.command" type="text" class="field-input font-mono" placeholder="/root/scripts/notify-jareth 'Good morning'" />
          </div>
          <div>
            <label class="mb-1 block text-sm font-medium text-slate-200">…or script path</label>
            <input v-model="form.script_path" type="text" class="field-input font-mono" placeholder="/root/scripts/morning.py" />
          </div>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label class="mb-1 block text-sm font-medium text-slate-200">Working dir</label>
              <input v-model="form.cwd" type="text" class="field-input font-mono" placeholder="(home)" />
            </div>
            <div>
              <label class="mb-1 block text-sm font-medium text-slate-200">Timeout (s)</label>
              <input v-model="form.timeout_s" type="number" min="1" max="3600" class="field-input" />
            </div>
          </div>
          <p class="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300"><AppIcon glyph="⚠" /> Shell jobs run host commands as the asmltr user — same power as crontab. Owner-only surface.</p>
        </template>

        <p v-if="formError" class="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{{ formError }}</p>
      </form>

      <template #footer>
        <button type="button" class="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-300 transition-colors hover:bg-white/10" @click="modalOpen = false">Cancel</button>
        <button type="button" :disabled="!canSubmit || submitting" class="rounded-xl bg-brand-gradient px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-brand-violet/30 transition-opacity disabled:cursor-not-allowed disabled:opacity-40" @click="onSubmit">{{ submitting ? 'Saving…' : (editingId ? 'Save changes' : 'Create schedule') }}</button>
      </template>
    </ModalShell>
  </div>
</template>

<style scoped>
.act { @apply rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs font-medium text-slate-300 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50; }
.act-danger { @apply rounded-lg border border-rose-500/20 bg-rose-500/5 px-2.5 py-1 text-xs font-medium text-rose-400/80 transition-colors hover:bg-rose-500/15 disabled:cursor-not-allowed disabled:opacity-50; }
.field-input { @apply w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-slate-100 outline-none transition-colors placeholder:text-slate-600 focus:border-brand-violet/60 focus:bg-white/[0.06] disabled:opacity-40; }
.tab { @apply rounded-lg px-2.5 py-1 font-medium text-slate-400 transition-colors hover:text-slate-200; }
.tab-on { @apply bg-white/10 text-slate-100; }
</style>
