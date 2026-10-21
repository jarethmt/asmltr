<script setup>
// PortalConsole — a terminal-style surface for driving a connected Portal dongle (docs/PORTAL-DRIVE.md).
// It is purely presentational + input: the BLE plumbing (subscribing to `ioback`, chunk-writing to
// `exec`) lives in the parent (Portal.vue), the single owner of the GATT connection. This component:
//   • renders the live `ioback` stream the parent feeds in via `lines`,
//   • owns the command input + HID/CDC mode toggle,
//   • emits `send({ mode, text })` (mode = 'hid'|'cdc') and `clear`.
// The parent prepends the mode byte (0x01 hid / 0x02 cdc) and chunks with the load-style header.
import { ref, watch, nextTick, computed } from 'vue'

const props = defineProps({
  connected: { type: Boolean, default: false },
  // [{ dir: 'in'|'out'|'sys', text: string }] — 'in' = ioback, 'out' = what we sent, 'sys' = notices.
  lines: { type: Array, default: () => [] },
  busy: { type: Boolean, default: false },
})
const emit = defineEmits(['send', 'clear'])

const mode = ref('hid')      // 'hid' = keystroke-script (exec mode 0x01), 'cdc' = raw serial (0x02)
const input = ref('')
const logEl = ref(null)

const placeholder = computed(() => mode.value === 'hid'
  ? 'Keystroke script — e.g. {GUI+r}{DELAY:400}powershell{ENTER}'
  : 'Serial text written verbatim to the host over CDC')

// Keep the log pinned to the newest line as it streams in.
watch(() => props.lines.length, async () => {
  await nextTick()
  if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight
})

function doSend() {
  const text = input.value
  if (!text || !props.connected || props.busy) return
  emit('send', { mode: mode.value, text })
  input.value = ''
}

// Enter sends; Shift+Enter inserts a newline (useful for multi-line serial input).
function onKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend() }
}

function cls(dir) {
  if (dir === 'out') return 'text-violet-300'
  if (dir === 'sys') return 'text-slate-500'
  return 'text-emerald-300' // 'in' (ioback)
}
function prefix(dir) {
  if (dir === 'out') return '» '
  if (dir === 'sys') return '· '
  return ''
}
</script>

<template>
  <div class="mt-4 border-t border-white/5 pt-3">
    <div class="mb-2 flex flex-wrap items-center gap-2">
      <h4 class="text-[11px] uppercase tracking-wide text-slate-500">Console</h4>
      <span class="pill border border-white/10 bg-white/5 text-[10px] text-slate-500">exec …727408 · ioback …727409</span>
      <button class="ml-auto text-[11px] text-slate-500 hover:text-slate-300" @click="emit('clear')">Clear</button>
    </div>

    <!-- Live ioback stream -->
    <div
      ref="logEl"
      class="h-56 overflow-auto rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-[11px] leading-relaxed">
      <div v-if="!lines.length" class="text-slate-600">
        Waiting for the host's return stream… send a command below. In HID mode, open a shell first
        (e.g. <code class="text-slate-500">{GUI+r}{DELAY:400}powershell{ENTER}</code>).
      </div>
      <div v-for="(l, i) in lines" :key="i" class="whitespace-pre-wrap break-all" :class="cls(l.dir)">{{ prefix(l.dir) }}{{ l.text }}</div>
    </div>

    <!-- Command input + mode toggle -->
    <div class="mt-2 flex items-stretch gap-2">
      <div class="flex overflow-hidden rounded-lg border border-white/10 text-[11px]">
        <button
          class="px-2.5 py-1.5"
          :class="mode === 'hid' ? 'bg-violet-400/20 text-violet-200' : 'bg-white/[0.03] text-slate-500 hover:text-slate-300'"
          @click="mode = 'hid'">HID</button>
        <button
          class="px-2.5 py-1.5"
          :class="mode === 'cdc' ? 'bg-violet-400/20 text-violet-200' : 'bg-white/[0.03] text-slate-500 hover:text-slate-300'"
          @click="mode = 'cdc'">CDC</button>
      </div>
      <input
        v-model="input"
        type="text"
        :placeholder="placeholder"
        :disabled="!connected || busy"
        class="glass min-w-0 flex-1 bg-transparent px-3 py-1.5 font-mono text-[12px] text-slate-200 placeholder:text-slate-600 disabled:opacity-40"
        @keydown="onKeydown" />
      <button
        class="glass glass-hover px-3 py-1.5 text-xs text-emerald-200 disabled:opacity-40"
        :disabled="!connected || busy || !input"
        @click="doSend">Send</button>
    </div>
    <p class="mt-1.5 text-[10px] leading-relaxed text-slate-600">
      <span class="text-slate-500">HID</span> types a keystroke script as the keyboard ({ENTER} {TAB}
      {GUI+r} {DELAY:500}…). <span class="text-slate-500">CDC</span> writes raw text to the host over
      the dongle's serial line. Enter sends · Shift+Enter = newline.
    </p>
  </div>
</template>
