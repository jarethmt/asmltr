// Surface + event styling and small formatting helpers shared across views.

// surface -> tailwind-ish color tokens (hex used for charts + inline styles)
export const SURFACE_META = {
  discord: { label: 'Discord', color: '#5865F2', icon: '💬' },
  telegram: { label: 'Telegram', color: '#229ED9', icon: '✈️' },
  'assistant-web': { label: 'Assistant·web', color: '#8B5CF6', icon: '🌐' },
  'assistant-native': { label: 'Assistant·native', color: '#A855F7', icon: '📱' },
  mcp: { label: 'MCP', color: '#10B981', icon: '🔌' },
  github: { label: 'GitHub', color: '#94A3B8', icon: '🐙' },
  'claude-code': { label: 'Claude Code', color: '#EC4899', icon: '⌨️' },
  system: { label: 'System', color: '#F59E0B', icon: '🖥️' },
  core: { label: 'Core', color: '#22D3EE', icon: '⚙️' }
}

export function surfaceMeta(surface) {
  return (
    SURFACE_META[surface] || {
      label: surface || 'unknown',
      color: '#64748B',
      icon: '•'
    }
  )
}

export const EVENT_TYPE_COLORS = {
  inbound: '#60A5FA',
  outbound: '#34D399',
  tool: '#FBBF24',
  'token-usage': '#A78BFA',
  identity_resolved: '#22D3EE',
  moderation_decision: '#F87171',
  'session-start': '#4ADE80',
  'session-end': '#FB7185',
  'system-sample': '#F59E0B',
  notification: '#EC4899',
  control: '#94A3B8'
}

export function eventTypeColor(t) {
  return EVENT_TYPE_COLORS[t] || '#94A3B8'
}

export const STATUS_META = {
  active: { color: '#34D399', label: 'active', pulse: true },
  idle: { color: '#FBBF24', label: 'idle', pulse: false },
  ended: { color: '#64748B', label: 'ended', pulse: false }
}

export function statusMeta(s) {
  return STATUS_META[s] || { color: '#64748B', label: s || 'unknown', pulse: false }
}

// Ivy/grok default matches core DEFAULT_IDLE_MINUTES / ASMLTR_IDLE_MS=1800000.
export const DEFAULT_IDLE_MS = 1_800_000

/** Collector timestamps are unix ms; tolerate accidental seconds. */
export function activityMs(unix) {
  if (!unix) return 0
  return unix < 1e12 ? unix * 1000 : unix
}

/**
 * Derived status word (History SessionDetail, Live exclusion).
 * Collector web rows stay status=active (no pid for reconcile). After
 * last_activity + idle, return `idle` so Live can drop the card and
 * History can still show the existing idle word. Do not badge Live as Idle —
 * past-idle cards must not appear there. A live pid stays Active.
 */
export function displayStatus(session, now = Date.now(), idleMs = DEFAULT_IDLE_MS) {
  const stored = session && session.status
  if (stored && stored !== 'active') return stored
  if (session && session.pid) return stored || 'active'
  const last = activityMs(session && session.last_activity_unix)
  if (!last) return stored || 'active'
  if (idleMs > 0 && now - last > idleMs) return 'idle'
  return stored || 'active'
}

// Connector-instance runtime status -> pill styling (manager control plane).
export const RUNTIME_STATUS_META = {
  running: { color: '#34D399', label: 'running', pulse: true },
  starting: { color: '#FBBF24', label: 'starting', pulse: true },
  restarting: { color: '#FBBF24', label: 'restarting', pulse: true },
  stopped: { color: '#64748B', label: 'stopped', pulse: false },
  failed: { color: '#F87171', label: 'failed', pulse: false }
}

export function runtimeStatusMeta(s) {
  return RUNTIME_STATUS_META[s] || { color: '#64748B', label: s || 'unknown', pulse: false }
}

// Connector type -> reuses surface colors where the type lines up with a
// known surface; falls back to a neutral chip with the displayName.
export function connectorTypeMeta(type, displayName) {
  const s = SURFACE_META[type]
  return {
    label: displayName || (s && s.label) || type || 'unknown',
    color: (s && s.color) || '#8B5CF6',
    icon: (s && s.icon) || '🔌'
  }
}

// Timestamps are unix MILLISECONDS.
export function fmtAge(unixMs, now = Date.now()) {
  if (!unixMs) return '—'
  let s = Math.max(0, Math.floor((now - unixMs) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}

export function fmtTime(unixMs) {
  if (!unixMs) return '—'
  return new Date(unixMs).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

export function fmtDateTime(unixMs) {
  if (!unixMs) return '—'
  return new Date(unixMs).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

export function fmtNum(n) {
  if (n == null) return '0'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(n)
}

export function fmtUsd(n) {
  if (!n || n <= 0) return null
  return '$' + Number(n).toFixed(n < 1 ? 4 : 2)
}

export function truncate(str, len = 80) {
  if (!str) return ''
  return str.length > len ? str.slice(0, len - 1) + '…' : str
}
