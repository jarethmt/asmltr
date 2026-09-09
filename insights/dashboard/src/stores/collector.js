// Central Pinia store: wraps the REST API + the shared socket. Views read
// reactive state from here; the socket lifecycle is owned here (connect once
// on app mount, live-append into the in-memory buffers).
import { defineStore } from 'pinia'
import { api, parsePayload } from '@/services/api'
import { displayStatus } from '@/lib/format'
import { getSocket } from '@/services/socket'

const EVENT_BUFFER_MAX = 1000
const SAMPLE_BUFFER_MAX = 500

export const useCollectorStore = defineStore('collector', {
  state: () => ({
    connected: false,
    lastError: null,

    sessions: [],
    sessionsCount: 0,

    events: [], // newest-first
    usage: [],
    usageAux: [], // per-feature/provider metered aux spend (tts/stt/moderation)
    samples: [], // oldest-first (chart-friendly)
    notifications: [],
    brief: null,

    loading: {
      sessions: false,
      events: false,
      usage: false,
      samples: false,
      notifications: false,
      brief: false
    },

    _socketBound: false,
    _pollTimer: null
  }),

  getters: {
    activeSessions: (s) => s.sessions.filter((x) => displayStatus(x) === 'active'),
    persistentSessions: (s) => s.sessions.filter((x) => x.kind === 'persistent'),
    latestSample: (s) => s.samples[s.samples.length - 1] || null,
    // distinct lists for filter chips
    knownSurfaces: (s) => [...new Set(s.events.map((e) => e.surface).filter(Boolean))].sort(),
    knownIdentities: (s) =>
      [...new Set(s.events.map((e) => e.identity).filter(Boolean))].sort()
  },

  actions: {
    // ---- REST fetchers ----
    async fetchSessions() {
      this.loading.sessions = true
      try {
        const data = await api.sessions({ active: 1 })
        this.sessions = data.sessions || []
        this.sessionsCount = data.count ?? this.sessions.length
        this.lastError = null
      } catch (e) {
        this.lastError = e.message
      } finally {
        this.loading.sessions = false
      }
    },

    async fetchEvents(params = { limit: 200 }) {
      this.loading.events = true
      try {
        const data = await api.events(params)
        const rows = (data.events || []).map((e) => ({
          ...e,
          _payload: parsePayload(e.payload)
        }))
        // API returns newest-first already; keep that order.
        this.events = rows
        this.lastError = null
      } catch (e) {
        this.lastError = e.message
      } finally {
        this.loading.events = false
      }
    },

    async fetchUsage(params = {}) {
      this.loading.usage = true
      try {
        const data = await api.usage(params)
        this.usage = data.usage || []
        this.usageAux = data.aux || []
        this.lastError = null
      } catch (e) {
        this.lastError = e.message
      } finally {
        this.loading.usage = false
      }
    },

    async fetchSystem(params = {}) {
      this.loading.samples = true
      try {
        const data = await api.system(params)
        // API returns newest-first; charts want oldest-first.
        this.samples = (data.samples || []).slice().sort((a, b) => a.ts - b.ts)
        this.lastError = null
      } catch (e) {
        this.lastError = e.message
      } finally {
        this.loading.samples = false
      }
    },

    async fetchNotifications() {
      this.loading.notifications = true
      try {
        const data = await api.notifications()
        this.notifications = data.notifications || []
        this.lastError = null
      } catch (e) {
        this.lastError = e.message
      } finally {
        this.loading.notifications = false
      }
    },

    async fetchBrief() {
      this.loading.brief = true
      try {
        this.brief = await api.brief()
        this.lastError = null
      } catch (e) {
        this.lastError = e.message
      } finally {
        this.loading.brief = false
      }
    },

    // ---- live append helpers (socket payloads are OBJECTS already) ----
    pushEvent(ev) {
      const enriched = { ...ev, _payload: parsePayload(ev.payload), _live: true }
      this.events.unshift(enriched)
      if (this.events.length > EVENT_BUFFER_MAX) this.events.length = EVENT_BUFFER_MAX
    },

    pushSample(sample) {
      this.samples.push(sample)
      if (this.samples.length > SAMPLE_BUFFER_MAX) this.samples.shift()
    },

    // ---- socket lifecycle ----
    connectSocket() {
      if (this._socketBound) return
      const socket = getSocket()
      this._socketBound = true

      socket.on('connect', () => {
        this.connected = true
      })
      socket.on('disconnect', () => {
        this.connected = false
      })
      socket.on('connect_error', (err) => {
        this.connected = false
        this.lastError = `socket: ${err.message}`
      })

      socket.on('event', (ev) => this.pushEvent(ev))
      socket.on('system-sample', (s) => this.pushSample(s))
      socket.on('sessions-changed', ({ count } = {}) => {
        this.sessionsCount = count ?? this.sessionsCount
        // session metadata may have changed; refresh the cards.
        this.fetchSessions()
        this.fetchBrief()
      })
    },

    // light polling as a safety net for REST-only data (usage/notifications)
    startPolling(ms = 30000) {
      this.stopPolling()
      this._pollTimer = setInterval(() => {
        this.fetchSessions()
        this.fetchBrief()
      }, ms)
    },
    stopPolling() {
      if (this._pollTimer) {
        clearInterval(this._pollTimer)
        this._pollTimer = null
      }
    }
  }
})
