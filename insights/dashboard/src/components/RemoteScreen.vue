<script setup>
// A live view of one machine's screen, driven by the shared viewer module (shared/rtc/viewer.js) —
// the same code the mobile app runs, so the two surfaces cannot drift.
//
// Two modes, distinguished only by whether input is wired:
//   control  — drive the machine (requires a control grant; the host re-checks regardless)
//   watch    — join a host someone else (often the agent) is already driving, view-only
import { ref, onBeforeUnmount, watch } from 'vue'
import { createViewer } from '@shared/rtc/viewer.js'
import { rd } from '@/services/api'

const props = defineProps({
  hostId: { type: String, required: true },
  hostName: { type: String, default: '' },
  wantControl: { type: Boolean, default: false },
})
const emit = defineEmits(['closed'])

const videoEl = ref(null)
const status = ref('idle')
const level = ref('warn')
const hasControl = ref(false)
const connected = ref(false)
let viewer = null

function start() {
  viewer = createViewer({ brokerUrl: '', token: rd.getToken(), clientId: 'dashboard-' + Math.random().toString(36).slice(2, 8) })
  viewer.on('status', (t, l) => { status.value = t; level.value = l; connected.value = l === 'on' })
  viewer.on('stream', (s) => { if (videoEl.value) { videoEl.value.srcObject = s; videoEl.value.play().catch(() => {}) } })
  viewer.on('control', (ok) => { hasControl.value = ok })
  viewer.on('ended', () => { connected.value = false })
  viewer.connect(props.hostId, { control: props.wantControl }).catch(() => {})
}
function stop() { if (viewer) { viewer.disconnect(); viewer = null } connected.value = false; hasControl.value = false; emit('closed') }

// Normalised pointer position: the host scales to its own resolution, so the wire carries fractions
// rather than pixels and a browser window of any size drives correctly.
function norm(e) {
  const r = videoEl.value.getBoundingClientRect()
  return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }
}
// The host's wire schema uses NAMED buttons and a single 'key' event carrying a down flag — see the
// contract on sendInput() in shared/rtc/viewer.js. Emitting DOM-shaped events (numeric button
// indexes, keydown/keyup types) produces input the agent silently discards.
const BUTTON = ['left', 'middle', 'right']
const onMove = (e) => { if (hasControl.value) viewer.sendInput({ t: 'move', ...norm(e) }) }
const onDown = (e) => { if (hasControl.value) viewer.sendInput({ t: 'down', button: BUTTON[e.button] || 'left', ...norm(e) }) }
const onUp = (e) => { if (hasControl.value) viewer.sendInput({ t: 'up', button: BUTTON[e.button] || 'left', ...norm(e) }) }
const onWheel = (e) => { if (hasControl.value) { e.preventDefault(); viewer.sendInput({ t: 'scroll', dx: e.deltaX, dy: e.deltaY }) } }
const onKey = (e) => {
  if (!hasControl.value) return
  e.preventDefault()
  viewer.sendInput({ t: 'key', code: e.code || e.key, key: e.key, down: e.type === 'keydown' })
}

watch(() => props.hostId, () => { stop(); start() })
start()
onBeforeUnmount(() => { if (viewer) viewer.disconnect() })
</script>

<template>
  <div class="glass overflow-hidden">
    <div class="flex flex-wrap items-center gap-2 border-b border-white/5 px-3 py-2">
      <span class="h-2 w-2 rounded-full" :class="level === 'on' ? 'bg-emerald-400' : level === 'off' ? 'bg-rose-400' : 'bg-amber-400'" />
      <span class="text-sm font-semibold text-slate-100">{{ hostName || hostId }}</span>
      <span class="pill border text-[10px]"
        :class="hasControl ? 'border-violet-400/30 bg-violet-400/10 text-violet-300' : 'border-white/10 bg-white/5 text-slate-400'">
        {{ hasControl ? 'driving' : 'watching' }}
      </span>
      <span class="text-[11px] text-slate-500">{{ status }}</span>
      <button class="ml-auto text-xs text-slate-400 hover:text-rose-300" @click="stop">Disconnect</button>
    </div>

    <!-- tabindex makes the surface focusable so keystrokes route to the machine, not the page -->
    <video
      ref="videoEl" autoplay playsinline muted tabindex="0"
      class="block max-h-[70vh] w-full bg-black outline-none"
      :class="hasControl ? 'cursor-none' : 'cursor-default'"
      @mousemove="onMove" @mousedown="onDown" @mouseup="onUp" @wheel="onWheel"
      @keydown="onKey" @keyup="onKey" @contextmenu.prevent
    />

    <p v-if="hasControl" class="px-3 py-2 text-[11px] text-slate-500">
      Click the screen to focus, then mouse and keyboard drive the machine. Input is refused by the host without a control grant.
    </p>
  </div>
</template>
