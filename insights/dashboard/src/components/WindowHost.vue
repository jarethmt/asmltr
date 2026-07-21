<script setup>
// Renders every open floating window once, globally (mounted in App). Views just call
// windows.openSession()/openObserver(); this handles stacking, focus, minimize, and the taskbar.
// The observer reuses the SAME chat component (SessionDetail) — it's just a web session on a fixed
// key with a per-turn context provider (the live body snapshot) + accent styling. So it gets tool
// calls, thinking, interrupt/stop for free.
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useWindows } from '@/stores/windows'
import { api, identity } from '@/services/api'
import SessionDetail from './SessionDetail.vue'

const { state, close, focus, minimize, topId, minimized } = useWindows()

const now = ref(Date.now())
const obsName = ref('the assistant')
const obsSchema = ref(null)
const obsAssessment = ref(null)
const hasObserver = computed(() => state.list.some((w) => w.kind === 'observer'))
let nowTimer = null, obsTimer = null

// Keep the observer's live body snapshot fresh while its window is open.
async function refreshObserver() {
  if (!hasObserver.value) return
  try { obsSchema.value = await api.selfSchema() } catch (_) {}
  try { obsAssessment.value = await api.selfAssessment() } catch (_) {}
}
onMounted(() => {
  nowTimer = setInterval(() => { now.value = Date.now() }, 30000)
  identity.get().then((d) => { if (d && d.name) obsName.value = d.name }).catch(() => {})
  refreshObserver(); obsTimer = setInterval(refreshObserver, 20000)
})
onUnmounted(() => { clearInterval(nowTimer); clearInterval(obsTimer) })

// synthetic "session" for the observer — a web session on a stable key
const observerSession = { session_id: 'web:self-observer', surface: 'assistant-web', kind: 'ephemeral', status: 'active', identity: 'proprioception', working_dir: null }
const observerTitle = computed(() => `The Observer — ${obsName.value} as a whole`)

// per-turn system-prompt context: the live body (parts + links) + the reflector's deduced goal
function observerContext() {
  const s = obsSchema.value
  const latest = obsAssessment.value && obsAssessment.value.latest
  const lines = ['[YOU ARE THE OBSERVER — proprioception]',
    'You are reflecting on yourself AS A WHOLE — the observer of all your working sessions, not any single one. You are being asked about your overall state. Speak as the whole ("I have N parts working on…"), and be honest about what you observe.']
  if (s && s.nodes && s.nodes.length) {
    lines.push('', `YOUR BODY RIGHT NOW — ${s.nodes.length} part(s):`)
    for (const n of s.nodes.slice(0, 40)) {
      const what = n.activity || n.title || '(idle)'
      const repo = n.repo ? ` · ${n.repo.split('/').slice(-1)[0]}` : ''
      const age = n.age_min <= 1 ? 'now' : `${n.age_min}m ago`
      lines.push(`- [${n.surface}] ${what}${repo} · active ${age}`)
    }
    if (s.edges && s.edges.length) lines.push(`STRUCTURAL LINKS: ${s.edges.length} (same-repo / announced-to)`)
  } else {
    lines.push('', 'YOUR BODY RIGHT NOW: at rest (no active parts).')
  }
  if (latest && latest.goal) {
    lines.push('', `DEDUCED GOAL (your reflector's last read): ${latest.goal}`)
    if (latest.threads && latest.threads.length) lines.push(`THREADS: ${latest.threads.join(' · ')}`)
    if (latest.flags && latest.flags.length) lines.push(`FLAGS: ${latest.flags.join(' · ')}`)
  }
  lines.push('',
    'To look deeper or act, use the asmltr CLI via Bash: `asmltr ls` / `asmltr map` (what each part is doing) · ' +
    '`asmltr who <path>` · `asmltr announce "<text>" [--to <target>]` to put a note into a part\'s next turn. ' +
    'GUIDE, don\'t command — prefer announce over steer; the parts decide for themselves.')
  return lines.join('\n')
}

function label(w) {
  if (w.kind === 'observer') return 'Observer'
  const p = w.payload || {}
  return p.title || p.activity || String(p.session_id || 'session').split(':').slice(0, 2).join(':')
}
</script>

<template>
  <div>
    <template v-for="w in state.list" :key="w.id">
      <SessionDetail
        v-if="w.kind === 'session'"
        :session="w.payload" :now="now" :z="w.z" :focused="topId === w.id" :minimized="w.minimized"
        @close="close(w.id)" @minimize="minimize(w.id)" @focus="focus(w.id)" />
      <SessionDetail
        v-else
        :session="observerSession" :now="now" :z="w.z" :focused="topId === w.id" :minimized="w.minimized"
        :context-provider="observerContext" :title-override="observerTitle" accent="#8B5CF6"
        @close="close(w.id)" @minimize="minimize(w.id)" @focus="focus(w.id)" />
    </template>

    <!-- taskbar — restore minimized windows -->
    <div v-if="minimized.length" class="fixed bottom-3 left-1/2 z-[95] flex max-w-[92vw] -translate-x-1/2 flex-wrap justify-center gap-2">
      <div v-for="w in minimized" :key="w.id"
           class="glass glass-hover flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs text-slate-200 shadow-lg shadow-black/40">
        <button class="flex max-w-[200px] items-center gap-1.5 truncate" :title="label(w)" @click="focus(w.id)"><AppIcon v-if="w.kind === 'observer'" glyph="🧠" class="text-brand-violet" /><span class="truncate">{{ label(w) }}</span></button>
        <button class="text-slate-500 hover:text-rose-300" title="Close" @click="close(w.id)"><AppIcon glyph="✕" /></button>
      </div>
    </div>
  </div>
</template>
