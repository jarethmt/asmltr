<script setup>
import { computed, ref } from 'vue'
import SurfaceBadge from './SurfaceBadge.vue'
import { statusMeta, fmtAge, fmtNum, truncate } from '@/lib/format'

// One-click copy of the session id (the conversation_key) — the id you hand to `asmltr context <id>`.
const copied = ref(false)
function copyId() {
  const id = props.session.session_id
  const done = () => { copied.value = true; setTimeout(() => (copied.value = false), 1200) }
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(id).then(done).catch(done)
  else { try { const t = document.createElement('textarea'); t.value = id; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); done() } catch (_) {} }
}

const props = defineProps({
  session: { type: Object, required: true },
  now: { type: Number, default: () => Date.now() },
  preview: { type: Object, default: null }, // latest event for this session (live)
  mutable: { type: Object, default: null }, // { instanceId, channelId, label } if this session's channel can be muted
  channelState: { type: Boolean, default: undefined }, // monitored on/off for that channel
  channelBusy: { type: Boolean, default: false },
  searchSnippet: { type: String, default: '' } // why this card matched a content search
})
defineEmits(['open', 'toggle-channel'])

const st = computed(() => statusMeta(props.session.status))
const monitored = computed(() => props.channelState !== false) // default enabled
// Tooltip spelling out exactly what the toggle does (capability-driven; only shows when mutable).
const monitorTip = computed(() => {
  const unit = props.mutable?.label || 'channel'
  return monitored.value
    ? `Monitored — the assistant reads this ${unit} and can respond autonomously. Click to mute (it stops reading & replying here; no restart).`
    : `Muted — the assistant ignores this ${unit}. Click to resume monitoring it.`
})

// Live one-line preview of the most recent conversation/tool activity — replaces
// the static "no active task" line so the card breathes.
const ICON = { inbound: '▶', outbound: '◀', thinking: '💭', tool: '🔧', tool_result: '📥', moderation_decision: '🛡', control: '⚙', 'token-usage': '∑', 'session-start': '●' }
const previewLine = computed(() => {
  // Prefer the semantic "what it's doing right now" rollup (a cheap haiku status the collector
  // keeps fresh) — the human-readable version of the raw last event below.
  if (props.session.activity) return { icon: '›', text: String(props.session.activity) }
  const e = props.preview
  if (!e) return null
  const p = e._payload || {}
  let text = ''
  if (e.event_type === 'tool') text = `${p.tool || 'tool'} ${typeof p.input === 'object' ? JSON.stringify(p.input) : (p.input || '')}`
  else if (e.event_type === 'tool_result') text = typeof p.output === 'object' ? JSON.stringify(p.output) : (p.output || 'result')
  else text = p.text || p.decision || p.action || e.event_type
  return { icon: ICON[e.event_type] || '·', text: String(text).replace(/\s+/g, ' ').trim() }
})
const age = computed(() => fmtAge(props.session.started_unix, props.now))
const lastSeen = computed(() => fmtAge(props.session.last_activity_unix, props.now))

const muxLabel = computed(() => {
  const m = props.session.multiplexer
  if (!m || m === 'none') return null
  return props.session.tmux_target ? `${m}:${props.session.tmux_target}` : m
})

const claimLabel = computed(() => {
  const c = props.session.claim_state
  if (!c || c === 'free') return null
  return props.session.claimed_by ? `${c} · ${props.session.claimed_by}` : c
})
</script>

<template>
  <div
    class="glass glass-hover flex cursor-pointer flex-col gap-3 p-4 transition-colors hover:border-brand-violet/30"
    role="button"
    tabindex="0"
    title="Open session — direct it, stop a turn, or take over in a terminal"
    @click="$emit('open', session)"
    @keydown.enter="$emit('open', session)"
  >
    <!-- header row -->
    <div class="flex items-start justify-between gap-2">
      <div class="flex flex-wrap items-center gap-2">
        <SurfaceBadge :surface="session.surface" />
        <span
          class="pill border border-white/10 bg-white/5 text-slate-300"
          :title="session.kind === 'persistent' ? 'long-lived daemon' : 'ephemeral session'"
        >
          {{ session.kind }}
        </span>
      </div>
      <div class="flex items-center gap-1.5 text-xs" :style="{ color: st.color }">
        <span
          class="h-2 w-2 rounded-full"
          :class="st.pulse ? 'animate-pulse-dot' : ''"
          :style="{ backgroundColor: st.color }"
        ></span>
        {{ st.label }}
      </div>
    </div>

    <!-- title / identity / live activity -->
    <div class="min-w-0">
      <div
        v-if="session.title"
        class="truncate text-sm font-semibold text-slate-100"
        :title="session.title"
      >
        {{ session.title }}
      </div>
      <div class="flex items-center gap-1.5 truncate font-mono text-[11px] text-slate-500" :title="session.session_id">
        <span class="truncate">{{ session.identity || session.session_id }}</span>
        <button
          class="shrink-0 rounded px-1 text-slate-500 hover:bg-white/10 hover:text-slate-200"
          :title="copied ? 'Copied!' : 'Copy session id (for `asmltr context <id>`)'"
          @click.stop="copyId"
        ><AppIcon :glyph="copied ? '✓' : '⧉'" /></button>
        <span v-if="session.location" class="shrink-0 text-slate-600" :title="session.location">· <AppIcon :name="['fas','comments']" /> {{ truncate(session.location, 30) }}</span>
      </div>
      <!-- live activity preview (falls back to task/context, then a hint) -->
      <div
        v-if="previewLine"
        class="mt-1 flex items-start gap-1.5 text-[13px] leading-snug text-slate-300"
        :title="previewLine.text"
      >
        <AppIcon :glyph="previewLine.icon" class="shrink-0 select-none opacity-80" />
        <span class="min-w-0 truncate">{{ truncate(previewLine.text, 84) }}</span>
      </div>
      <div
        v-else-if="!session.title"
        class="mt-1 text-[13px] leading-snug text-slate-400"
        :title="session.task || session.context || ''"
      >
        {{ truncate(session.task || session.context || 'no recent activity', 90) }}
      </div>
      <div
        v-if="session.working_dir"
        class="mt-1 truncate font-mono text-[11px] text-slate-500"
        :title="session.working_dir"
      >
        {{ session.working_dir }}<span v-if="session.worktree"> · wt:{{ session.worktree }}</span>
      </div>
    </div>

    <!-- search match snippet (why this card matched) -->
    <div v-if="searchSnippet" class="truncate rounded-md border border-brand-violet/20 bg-brand-violet/5 px-2 py-1 text-[11px] text-violet-300/90" :title="searchSnippet">
      <AppIcon glyph="🔍" /> …{{ truncate(searchSnippet, 90) }}…
    </div>

    <!-- meta chips -->
    <div class="flex flex-wrap items-center gap-1.5 text-[11px]">
      <span class="pill border border-white/10 bg-white/5 text-slate-300" title="session age">
        <AppIcon glyph="⏱" /> {{ age }}
      </span>
      <span class="pill border border-white/10 bg-white/5 text-slate-300" title="last activity">
        last {{ lastSeen }}
      </span>
      <span
        class="pill border border-violet-400/30 bg-violet-400/10 text-violet-300"
        title="tokens (attributed)"
      >
        ⟁ {{ fmtNum(session.tokens_total) }} tok
      </span>
      <span
        v-if="session.tool_count"
        class="pill border border-amber-400/30 bg-amber-400/10 text-amber-300"
        title="tool calls"
      >
        <AppIcon glyph="🛠" /> {{ fmtNum(session.tool_count) }}
      </span>
      <span
        v-if="muxLabel"
        class="pill border border-cyan-400/30 bg-cyan-400/10 text-cyan-300"
        title="multiplexer"
      >
        <AppIcon glyph="▣" /> {{ muxLabel }}
      </span>
      <span
        v-if="claimLabel"
        class="pill border border-pink-400/30 bg-pink-400/10 text-pink-300"
        title="claim state"
      >
        <AppIcon glyph="🔒" /> {{ claimLabel }}
      </span>
      <span
        v-if="session.pid"
        class="pill border border-white/10 bg-white/5 text-slate-500"
        title="process id"
      >
        pid {{ session.pid }}
      </span>
    </div>

    <!-- footer: monitor toggle (mute-capable connectors, e.g. Discord channels) + open details -->
    <div class="mt-1 flex items-center justify-between border-t border-white/5 pt-3">
      <button
        v-if="mutable"
        type="button"
        :disabled="channelBusy"
        :title="monitorTip"
        class="rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-40"
        :class="monitored ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300 hover:bg-emerald-400/20' : 'border-white/10 bg-white/5 text-slate-500 hover:text-slate-300'"
        @click.stop="$emit('toggle-channel', session.session_id)"
      >
<template v-if="channelBusy">…</template><template v-else><AppIcon :glyph="monitored ? '●' : '○'" /> {{ monitored ? 'monitored' : 'muted' }}</template>
      </button>
      <span v-else></span>
      <button
        type="button"
        class="rounded-lg border border-brand-violet/30 bg-brand-violet/10 px-3 py-1 text-xs font-medium text-violet-300 transition-colors hover:bg-brand-violet/20"
        @click.stop="$emit('open', session)"
      >
        Manage session →
      </button>
    </div>
  </div>
</template>
