<script setup>
// A live terminal on a registered machine — or a live WINDOW onto a shell the agent is already
// driving. Both are the same thing: the core broadcasts one PTY to every subscriber, so opening this
// on an agent-owned session shows the agent's work as it happens, keystroke by keystroke.
//
// Deliberately not a full terminal emulator. It renders the byte stream with ANSI control sequences
// stripped rather than interpreted — enough to read a build log or watch a command run, without
// pulling in a dependency for what is, today, an observation surface.
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue'

const props = defineProps({
  sessionId: { type: String, required: true },
  title: { type: String, default: '' },
  canType: { type: Boolean, default: false },
  principalId: { type: String, default: '' },
})
const emit = defineEmits(['closed'])

const out = ref('')
const ended = ref(false)
const input = ref('')
const paneEl = ref(null)
let es = null

// Strip CSI/OSC sequences and bare carriage returns; keep the text. Interpreting them properly is a
// terminal emulator's job, and this is a window, not a terminal.
const ANSI = new RegExp('\\u001b\\[[0-9;?]*[ -/]*[@-~]|\\u001b\\][^\\u0007]*(?:\\u0007|\\u001b\\\\)|\\r(?!\\n)', 'g')
function append(text) {
  out.value += String(text).replace(ANSI, '')
  if (out.value.length > 200000) out.value = out.value.slice(-200000)   // bounded: build logs are chatty
  nextTick(() => { if (paneEl.value) paneEl.value.scrollTop = paneEl.value.scrollHeight })
}

function connect() {
  const q = props.principalId ? '?principal_id=' + encodeURIComponent(props.principalId) : ''
  es = new EventSource('/v2/device-shell/' + encodeURIComponent(props.sessionId) + '/stream' + q)
  es.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data) } catch { return }
    if (m.type === 'end') { ended.value = true; append('\n[session ended]\n'); es.close() }
    else if (m.type === 'data') append(m.text)
  }
  es.onerror = () => { if (!ended.value) append('\n[stream interrupted]\n') }
}

async function send() {
  if (!props.canType || !input.value) return
  const data = input.value + '\n'
  input.value = ''
  await fetch('/v2/device-shell/' + encodeURIComponent(props.sessionId) + '/input', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data, principal_id: props.principalId }),
  }).catch(() => {})
}

function stop() { if (es) { es.close(); es = null } emit('closed') }
onMounted(connect)
onBeforeUnmount(() => { if (es) es.close() })
</script>

<template>
  <div class="glass overflow-hidden">
    <div class="flex flex-wrap items-center gap-2 border-b border-white/5 px-3 py-2">
      <span class="h-2 w-2 rounded-full" :class="ended ? 'bg-slate-600' : 'bg-emerald-400'" />
      <span class="text-sm font-semibold text-slate-100">{{ title || sessionId }}</span>
      <span class="pill border text-[10px]"
        :class="canType ? 'border-violet-400/30 bg-violet-400/10 text-violet-300' : 'border-white/10 bg-white/5 text-slate-400'">
        {{ canType ? 'interactive' : 'watching' }}
      </span>
      <button class="ml-auto text-xs text-slate-400 hover:text-rose-300" @click="stop">Close</button>
    </div>

    <pre ref="paneEl" class="max-h-[60vh] overflow-auto bg-black/60 px-3 py-2 font-mono text-[12px] leading-relaxed text-slate-200">{{ out || 'waiting for output...' }}</pre>

    <div v-if="canType && !ended" class="flex items-center gap-2 border-t border-white/5 px-3 py-2">
      <span class="font-mono text-xs text-emerald-400">$</span>
      <input
        v-model="input" placeholder="type a command and press enter"
        class="min-w-0 flex-1 bg-transparent font-mono text-xs text-slate-100 outline-none"
        @keydown.enter.prevent="send"
      />
    </div>
  </div>
</template>
