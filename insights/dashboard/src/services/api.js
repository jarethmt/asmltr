// Thin REST client for the asmltr collector. All calls go through the Vite
// proxy (/api -> http://127.0.0.1:3017) so this works in dev and behind a
// reverse proxy later without code changes.

async function get(path, params) {
  const qs = params
    ? '?' +
      new URLSearchParams(
        Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
      ).toString()
    : ''
  const res = await fetch(`/api${path}${qs}`, {
    headers: { Accept: 'application/json' }
  })
  if (!res.ok) {
    throw new Error(`GET /api${path} -> ${res.status} ${res.statusText}`)
  }
  return res.json()
}

export const api = {
  sessions: (params = { active: 1 }) => get('/sessions', params),
  updateStatus: () => get('/update-status'),
  events: (params = {}) => get('/events', params),
  usage: (params = {}) => get('/usage', params),
  system: (params = {}) => get('/system', params),
  notifications: () => get('/notifications'),
  brief: () => get('/brief'),
  search: (q) => get('/search', { q }),
  // proprioception — the body-schema graph (parts + structural edges)
  selfSchema: (params) => get('/self/schema', params),
  // proprioception 1b — the deduced goal / threads / flags / semantic relations + history
  selfAssessment: () => get('/self/assessment'),
  // the console manifest — single source of truth for settings/actions/screens (shared with the TUI)
  manifest: () => get('/manifest')
}

// Control plane on the CORE (served at root under /v2/...). Used by the live
// "conversation details" pane to take over a session: abort the in-flight turn,
// or inject an operator message (the reply routes back to the origin channel).
async function getCore(path) {
  const res = await fetch(path, { headers: { Accept: 'application/json' } })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error || `GET ${path} -> ${res.status} ${res.statusText}`)
  return json
}

async function postCore(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body || {})
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error || `POST ${path} -> ${res.status} ${res.statusText}`)
  return json
}

async function reqCore(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body || {})
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error || `${method} ${path} -> ${res.status} ${res.statusText}`)
  return json
}

// Third-party service integrations (storage, …). Secret fields are *_ref (vault key names).
export const integrations = {
  list: () => getCore('/v2/integrations'),
  create: (payload) => postCore('/v2/integrations', payload),
  update: (id, patch) => reqCore('PATCH', `/v2/integrations/${id}`, patch),
  remove: (id) => reqCore('DELETE', `/v2/integrations/${id}`),
  test: (id) => postCore(`/v2/integrations/${id}/test`)
}

// TRUST vault — status + key management (metadata only; values are write-only from the GUI).
export const vaultApi = {
  status: () => getCore('/v2/vault/status'),
  secrets: () => getCore('/v2/vault/secrets'),
  addSecret: (payload) => postCore('/v2/vault/secrets', payload),
  removeSecret: (name) => reqCore('DELETE', `/v2/vault/secrets/${encodeURIComponent(name)}`),
  unseal: (password) => postCore('/v2/vault/unseal', { password })
}

// Data silos — the file-explorer surface. `id` defaults to 'self' (the Self silo). Paths are silo-relative.
const q = (o) => { const s = new URLSearchParams(Object.entries(o || {}).filter(([, v]) => v != null && v !== '')).toString(); return s ? '?' + s : '' }
export const silosApi = {
  list: () => getCore('/v2/silos'),
  create: (payload) => postCore('/v2/silos', payload),
  update: (id, patch) => reqCore('PATCH', `/v2/silos/${encodeURIComponent(id)}`, patch),
  remove: (id) => reqCore('DELETE', `/v2/silos/${encodeURIComponent(id)}`),
  overview: (id = 'self') => getCore(`/v2/silos/${encodeURIComponent(id)}/overview`),
  ls: (id = 'self', path = '') => getCore(`/v2/silos/${encodeURIComponent(id)}/ls${q({ path })}`),
  find: (id = 'self', opts = {}) => getCore(`/v2/silos/${encodeURIComponent(id)}/find${q(opts)}`),
  file: (id = 'self', path) => getCore(`/v2/silos/${encodeURIComponent(id)}/file${q({ path })}`),
  putFile: (id = 'self', payload) => postCore(`/v2/silos/${encodeURIComponent(id)}/file`, payload),
  mkdir: (id = 'self', path) => postCore(`/v2/silos/${encodeURIComponent(id)}/mkdir`, { path }),
  rm: (id = 'self', path) => reqCore('DELETE', `/v2/silos/${encodeURIComponent(id)}/file${q({ path })}`)
}

// Auth — session gate (roadmap P1). status/setup/login/logout are public; the session cookie is httpOnly.
export const authApi = {
  status: () => getCore('/v2/auth/status'),
  setup: (username, password) => postCore('/v2/auth/setup', { username, password }),
  // login returns a STRUCTURED result (never throws) so the caller can detect { totp_required }.
  login: async (username, password, totp) => {
    const res = await fetch('/v2/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ username, password, totp }) })
    const json = await res.json().catch(() => ({}))
    return { ok: res.ok, ...json }
  },
  logout: () => postCore('/v2/auth/logout'),
  // External login (OIDC client) — providers enabled only when configured
  external: () => getCore('/v2/auth/external'),
  externalStartUrl: (provider) => `/v2/auth/external/${provider}/start`,
  externalUnlink: (provider) => reqCore('DELETE', `/v2/auth/external/${provider}`),
  // TOTP 2FA enrollment (requires a session)
  totpSetup: () => postCore('/v2/auth/totp/setup'),
  totpEnable: (code) => postCore('/v2/auth/totp/enable', { code }),
  totpDisable: (password) => postCore('/v2/auth/totp/disable', { password }),
  // WebAuthn passkeys
  passkeys: () => getCore('/v2/auth/passkeys'),
  passkeyRegisterOptions: () => postCore('/v2/auth/passkey/register/options'),
  passkeyRegisterVerify: (response, label) => postCore('/v2/auth/passkey/register/verify', { response, label }),
  passkeyRemove: (id) => reqCore('DELETE', `/v2/auth/passkey/${encodeURIComponent(id)}`),
  passkeyLoginOptions: (username) => postCore('/v2/auth/passkey/login/options', username ? { username } : {}),
  passkeyLoginVerify: (response) => postCore('/v2/auth/passkey/login/verify', { response })
}

// OIDC provider — client registry (asmltr issues tokens to registered apps). Session-gated.
export const oidcApi = {
  status: () => getCore('/v2/oidc/status'),
  clients: () => getCore('/v2/oidc/clients'),
  addClient: (payload) => postCore('/v2/oidc/clients', payload),
  removeClient: (id) => reqCore('DELETE', `/v2/oidc/clients/${encodeURIComponent(id)}`)
}

// Reasoning engines — pluggable agentic backends (claude/gemini/codex): registry + default + config.
export const enginesApi = {
  list: () => getCore('/v2/engines'),
  setDefault: (id) => postCore('/v2/engines/default', { id }),
  setConfig: (id, config) => reqCore('PATCH', `/v2/engines/${encodeURIComponent(id)}`, config),
  check: (id) => getCore(`/v2/engines/${encodeURIComponent(id)}/check`),
  install: (id) => postCore(`/v2/engines/${encodeURIComponent(id)}/install`),
  setAutoUpdate: (id, enabled) => postCore(`/v2/engines/${encodeURIComponent(id)}/auto-update`, { enabled }),
  setAuthMode: (id, mode) => postCore(`/v2/engines/${encodeURIComponent(id)}/auth`, { mode }),
  setBaseUrl: (id, url) => postCore(`/v2/engines/${encodeURIComponent(id)}/base-url`, { url }),
  setApiKey: (id, value) => reqCore('PUT', `/v2/engines/${encodeURIComponent(id)}/apikey`, { value }),
  clearApiKey: (id) => reqCore('DELETE', `/v2/engines/${encodeURIComponent(id)}/apikey`)
}

export const mcpApi = {
  list: () => getCore('/v2/mcp'),
  add: (def) => postCore('/v2/mcp', def),
  remove: (name) => reqCore('DELETE', `/v2/mcp/${encodeURIComponent(name)}`),
  toggle: (name, disabled) => postCore(`/v2/mcp/${encodeURIComponent(name)}/toggle`, { disabled })
}

// Backups — encrypted, restorable snapshots. Restore is CLI-only (deliberate footgun guard).
export const backupApi = {
  list: (destination) => getCore('/v2/backups' + (destination && destination !== 'local' ? q({ destination }) : '')),
  create: (payload) => postCore('/v2/backups', payload),
  verify: (payload) => postCore('/v2/backups/verify', payload),
  getSchedule: () => getCore('/v2/backups/schedule'),
  setSchedule: (payload) => reqCore('PUT', '/v2/backups/schedule', payload),
  restorePreview: (payload) => postCore('/v2/backups/restore/preview', payload),
  restore: (payload) => postCore('/v2/backups/restore', payload),
  restoreLog: () => getCore('/v2/backups/restore/log'),
  async import(file) {
    const res = await fetch('/v2/backups/import', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Backup-Filename': file.name, Accept: 'application/json' }, body: file })
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `import failed (${res.status})`)
    return res.json()
  }
}

export const control = {
  // SDK/channel sessions → the core control plane
  abort: (conversation_key) => postCore('/v2/abort', { conversation_key }),
  inject: (conversation_key, text) => postCore('/v2/inject', { conversation_key, text, by: 'dashboard' }),
  // interactive `asmltr claude` (tmux) sessions → collector send-keys (steer / interrupt)
  sendText: (session_id, text) => postCore('/api/control/send-keys', { session_id, text, enter: true }),
  sendKey: (session_id, keys) => postCore('/api/control/send-keys', { session_id, keys }),
  // manually set a session title (locks it against AI regeneration); '' reverts to AI
  setTitle: (session_id, title) => postCore('/api/control/session-title', { session_id, title }),
  // forget/delete a session — removes it from tracking + events (collector) and clears the core
  // engine mapping, so the next inbound on this key starts a fresh session with new history
  forget: (session_id) => postCore('/api/control/forget', { session_id })
}

// Self-update on the CORE (git code) — status (behind/available + changelog), toggle auto-install,
// or run the update session now (a background agent session that runs UPDATE-WITH-AGENT.md).
export const update = {
  status: (fetch = true) => getCore('/v2/update/status' + (fetch ? '' : '?fetch=0')),
  // live progress of a running/last update — from the status file, survives the mid-update restart
  progress: () => getCore('/v2/update/progress'),
  run: () => postCore('/v2/update/run', { by: 'dashboard' }),
  getAuto: () => getCore('/v2/update/auto'),
  setAuto: (enabled) => postCore('/v2/update/auto', { enabled }),
  // release channel: 'stable' (newest tag) | 'edge' (origin/main)
  getChannel: () => getCore('/v2/update/channel'),
  setChannel: (channel) => postCore('/v2/update/channel', { channel }),
}

// Web chat — the browser acts as a connector. Post an `assistant-web` envelope to the core's
// streaming endpoint and get the reply token-by-token; the core records the whole exchange, so the
// session shows up in Live like any other. The operator identity is resolved server-side (the
// dashboard never hardcodes it), so `sender` here is just a placeholder the core overwrites.
export const webChat = {
  // Stream one turn. `handlers` = { onDelta, onSegment, onTool, onThinking, onDone, onError }.
  // Returns an AbortController so the caller can cancel the fetch (the core also has /v2/abort).
  send({ conversation_key, text, attachments = [], working_dir = null, system_prompt_extra = null }, handlers = {}) {
    const ac = new AbortController()
    const envelope = {
      channel: 'assistant-web',
      conversation_key,
      sender: { raw_id: 'dashboard', raw_username: 'dashboard' },
      content: { text, attachments },
      delivery: 'sync',
      public: false,
      ...(working_dir ? { working_dir } : {}),
      ...(system_prompt_extra ? { system_prompt_extra } : {})
    }
    ;(async () => {
      let res
      try {
        res = await fetch('/v2/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify(envelope),
          signal: ac.signal
        })
      } catch (e) { handlers.onError?.(e.message || 'network error'); return }
      if (!res.ok || !res.body) { handlers.onError?.(`stream ${res.status}`); return }
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          // SSE frames are separated by a blank line; each frame's payload is a `data: {...}` line.
          let idx
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const raw = buf.slice(0, idx); buf = buf.slice(idx + 2)
            const line = raw.split('\n').find((l) => l.startsWith('data:'))
            if (!line) continue
            let f; try { f = JSON.parse(line.slice(5).trim()) } catch { continue }
            if (f.type === 'delta') handlers.onDelta?.(f.text)
            else if (f.type === 'segment') handlers.onSegment?.(f.text)
            else if (f.type === 'tool') handlers.onTool?.(f.name)
            else if (f.type === 'thinking') handlers.onThinking?.(f.text)
            else if (f.type === 'done') handlers.onDone?.(f.actions || [])
            else if (f.type === 'error') handlers.onError?.(f.error || 'stream error')
          }
        }
      } catch (e) {
        if (ac.signal.aborted) handlers.onError?.('aborted')
        else handlers.onError?.(e.message || 'stream read error')
      }
    })()
    return ac
  },

  // Attach a file: base64 it and POST to the core, which stores it in the shared upload area and
  // returns the on-disk path. The next message references that path so the agent can Read it.
  async upload(file, conversation_key) {
    const data_base64 = await new Promise((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result).split(',')[1] || '')
      r.onerror = () => reject(new Error('read failed'))
      r.readAsDataURL(file)
    })
    return postCore('/v2/upload', { filename: file.name, mime: file.type, conversation_key, data_base64 })
  }
}

// Voice — the core speech layer. `speak()` streams a turn as interleaved transcript + audio-clip
// frames (chime/drone cues, an optional spoken ack, then the answer sentence-by-sentence). Same
// browser-as-connector envelope as webChat; the reply is spoken. Ack on/off persists server-side.
export const voice = {
  getAck: () => getCore('/v2/voice/ack'),
  setAck: (enabled) => postCore('/v2/voice/ack', { enabled }),
  // TTS voice/model + STT model config (persisted server-side; applies to the next clip). Shape:
  // { tts: { voice, model, provider, format }, stt: { model, language } }. Partial updates merge.
  getConfig: () => getCore('/v2/voice/config'),
  setConfig: (body) => postCore('/v2/voice/config', body),
  // Synthesize text → one audio clip (no agent turn). Returns { mime, b64 } for the chat read-aloud.
  tts: (text, opts = {}) => postCore('/v2/tts', { text, ...opts }),
  assetUrl: (name) => `/v2/voice/asset/${name}`,
  // handlers: { onCue(name), onText({seq,text}), onAudio({seq,role,mime,b64}), onDone(actions), onError(msg) }
  speak({ conversation_key, text }, handlers = {}) {
    const ac = new AbortController()
    const envelope = {
      channel: 'assistant-web', conversation_key,
      sender: { raw_id: 'dashboard', raw_username: 'dashboard' },
      content: { text }, delivery: 'sync', public: false
    }
    ;(async () => {
      let res
      try { res = await fetch('/v2/speak', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify(envelope), signal: ac.signal }) }
      catch (e) { handlers.onError?.(e.message || 'network error'); return }
      if (!res.ok || !res.body) { handlers.onError?.(`speak ${res.status}`); return }
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ''
      try {
        for (;;) {
          const { value, done } = await reader.read(); if (done) break
          buf += dec.decode(value, { stream: true }); let i
          while ((i = buf.indexOf('\n\n')) !== -1) {
            const raw = buf.slice(0, i); buf = buf.slice(i + 2)
            const line = raw.split('\n').find((l) => l.startsWith('data:')); if (!line) continue
            let f; try { f = JSON.parse(line.slice(5).trim()) } catch { continue }
            if (f.type === 'cue') handlers.onCue?.(f.cue)
            else if (f.type === 'text') handlers.onText?.(f)
            else if (f.type === 'audio') handlers.onAudio?.(f)
            else if (f.type === 'done') handlers.onDone?.(f.actions || [])
            else if (f.type === 'error') handlers.onError?.(f.error || 'speak error')
          }
        }
      } catch (e) { if (!ac.signal.aborted) handlers.onError?.(e.message || 'stream error') }
    })()
    return ac
  }
}

// Identity — the "Self" (Likeness plane): the name + editable self-description, and a preview of the
// anchor injected into every session's system prompt so identity is asserted, not inferred.
export const identity = {
  get: () => getCore('/v2/identity'),
  set: (body) => postCore('/v2/identity', body) // { name?, self_description? }
}

// Agent runtime — the Agent SDK version (which gates model availability), model selection, and
// SDK auto-update. Keeping the SDK current is how the underlying model stays up to date.
export const runtime = {
  get: (fetch = true) => getCore('/v2/runtime' + (fetch ? '' : '?fetch=0')),
  setModel: (model) => postCore('/v2/runtime/model', { model }),
  setAutoUpdate: (enabled) => postCore('/v2/runtime/auto-update', { enabled }),
  // bypass-permissions for interactive `asmltr claude` terminal sessions (default on)
  setCliBypass: (enabled) => postCore('/v2/runtime/cli-permission-mode', { enabled }),
  update: () => postCore('/v2/runtime/update', { by: 'dashboard' })
}

// Draft / approval queue on the CORE — replies any connector held for a human to approve.
export const drafts = {
  list: (status = 'pending') => getCore(`/v2/drafts?status=${encodeURIComponent(status)}`),
  approve: (id) => postCore(`/v2/drafts/${id}/approve`),
  discard: (id) => postCore(`/v2/drafts/${id}/discard`)
}

// Local artifacts — when the agent mentions a file it created on its host, the chat offers a download
// link that streams it through the core (Authelia-gated). stat() decides whether the chip shows.
export const files = {
  stat: (path) => getCore('/v2/file?stat=1&path=' + encodeURIComponent(path)),
  downloadUrl: (path) => '/v2/file?path=' + encodeURIComponent(path)
}

// Speech-to-text — record audio in the browser, send it to the core's transcription model (the STT
// model chosen in Settings), get text back. Base64 JSON body (mirrors webChat.upload; no multipart).
export const stt = {
  // Mint an ephemeral token for a streaming realtime transcription session (server VAD). The browser
  // then connects to OpenAI directly over WebRTC with this token — the real key stays server-side.
  realtimeToken: () => postCore('/v2/realtime/transcribe-token', {}),
  async transcribe(blob, { model, language } = {}) {
    const data_base64 = await new Promise((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result).split(',')[1] || '')
      r.onerror = () => reject(new Error('read failed'))
      r.readAsDataURL(blob)
    })
    return postCore('/v2/transcribe', { data_base64, mime: blob.type || 'audio/webm', model, language })
  }
}

// payload arrives as a JSON *string* over REST. Be defensive.
export function parsePayload(payload) {
  if (payload == null) return null
  if (typeof payload === 'object') return payload
  try {
    return JSON.parse(payload)
  } catch {
    return { _raw: String(payload) }
  }
}
