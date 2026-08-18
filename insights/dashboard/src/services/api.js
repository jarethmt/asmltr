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
  // Raw-bytes write for an actual file. putFile() base64s into a JSON body, which the core's
  // express.json 10mb limit caps near 7.5 MiB of file; the bytes go up as the body instead.
  async putFileRaw(id = 'self', path, file) {
    const res = await fetch(`/v2/silos/${encodeURIComponent(id)}/file${q({ path })}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream', Accept: 'application/json' },
      body: file
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(json.error || `upload -> ${res.status} ${res.statusText}`)
    return json
  },
  mkdir: (id = 'self', path) => postCore(`/v2/silos/${encodeURIComponent(id)}/mkdir`, { path }),
  rm: (id = 'self', path) => reqCore('DELETE', `/v2/silos/${encodeURIComponent(id)}/file${q({ path })}`)
}

// Recordings (roadmap §B1/§B3, issues #94/#96) — the recording app's backend, served on the core.
export const recordingsApi = {
  list: () => getCore('/v2/recordings'),
  get: (id) => getCore(`/v2/recordings/${encodeURIComponent(id)}`),
  enrich: (id) => postCore(`/v2/recordings/${encodeURIComponent(id)}/enrich`, {}),
  diarize: (id) => postCore(`/v2/recordings/${encodeURIComponent(id)}/diarize`, {}),
  patch: (id, body) => reqCore('PATCH', `/v2/recordings/${encodeURIComponent(id)}`, body),
  toStream: (id, body) => postCore(`/v2/recordings/${encodeURIComponent(id)}/to-stream`, body),
  remove: (id) => reqCore('DELETE', `/v2/recordings/${encodeURIComponent(id)}`),
  audioUrl: (id) => `/v2/recordings/${encodeURIComponent(id)}/audio`,
  // Raw-bytes upload (octet-stream) — dodges the base64-in-JSON size cap. `file` is a browser File/Blob.
  async upload(file, { source = 'upload', title } = {}) {
    const res = await fetch(`/v2/recordings${q({ source, title })}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream', Accept: 'application/json' },
      body: file
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(json.error || `upload -> ${res.status} ${res.statusText}`)
    return json
  }
}

// Voice engines (epic #113) — the pluggable role/capability voice layer.
export const voiceEnginesApi = {
  get: () => getCore('/v2/voice/engines'),
  bind: (role, engine) => postCore('/v2/voice/engines/bind', { role, engine })
}

// Streams (roadmap §A, issue #93) — topic/project event streams: list, create, read, recall (FTS search).
export const streamsApi = {
  list: () => getCore('/v2/streams'),
  get: (id) => getCore(`/v2/streams/${encodeURIComponent(id)}`),
  create: (name, description) => postCore('/v2/streams', { name, description }),
  recall: (id, q) => getCore(`/v2/streams/${encodeURIComponent(id)}/recall${q ? '?q=' + encodeURIComponent(q) : ''}`),
  remove: (id) => reqCore('DELETE', `/v2/streams/${encodeURIComponent(id)}`)
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

// Reasoning engines — pluggable agentic backends (claude/gemini/codex/grok): registry + default + config.
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

// Schedules — "cron with a GUI": prompt jobs (managed turns) + shell jobs. Owner-only surface.
export const schedulesApi = {
  list: () => getCore('/v2/schedules'),
  create: (payload) => postCore('/v2/schedules', payload),
  update: (id, patch) => reqCore('PATCH', `/v2/schedules/${encodeURIComponent(id)}`, patch),
  remove: (id) => reqCore('DELETE', `/v2/schedules/${encodeURIComponent(id)}`),
  runNow: (id) => postCore(`/v2/schedules/${encodeURIComponent(id)}/run`)
}

// Notify — the proactive read-aloud / delivery-ladder primitive (Part A). Config + a test-send.
export const notifyApi = {
  getConfig: () => getCore('/v2/notify/config'),
  setConfig: (body) => postCore('/v2/notify/config', body),
  send: (body) => postCore('/v2/notify', body)
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

  // Attach a file: send it as fixed-size raw chunks and let the core assemble it. The old path
  // base64'd the whole file into one JSON body, which capped uploads at whatever the smallest body
  // limit on the route allowed (767.9 KiB in practice) and held the file in memory three times over.
  // Chunking makes file size irrelevant, gives real byte-level progress, and retries a failed chunk
  // instead of the whole file. Returns the same { ok, file } shape as before.
  // opts: { onProgress(fraction 0..1), signal }
  async upload(file, conversation_key, opts = {}) {
    if (!file.size) throw new Error('empty file')
    const init = await postCore('/v2/upload/init', {
      filename: file.name, mime: file.type, size: file.size, conversation_key
    })
    const { upload_id, chunk_size, chunks } = init
    const done = new Set(init.received || [])

    let sent = 0
    const report = (inFlight = 0) => opts.onProgress?.(Math.min(1, (sent + inFlight) / file.size))
    report()

    try {
      for (let i = 0; i < chunks; i++) {
        const blob = file.slice(i * chunk_size, Math.min(file.size, (i + 1) * chunk_size))
        // Count a chunk the server already has toward progress, otherwise a resumed upload finishes
        // reporting less than 100%.
        if (done.has(i)) { sent += blob.size; report(); continue }
        const sha256 = await digestOf(blob)          // once per chunk, not once per retry
        await withRetry(() => putChunk(upload_id, i, blob, { onProgress: report, signal: opts.signal, sha256 }))
        sent += blob.size
        report()
      }
      return await postCore(`/v2/upload/${upload_id}/finish`, {})
    } catch (e) {
      // Give the staged chunks back rather than leaving them for the 24h sweeper. Three failed
      // attempts at a 2 GB file would otherwise strand 6 GB, which is how the next upload hits ENOSPC.
      // This is right only while the client cannot resume: `upload_id` lives in this closure, so a
      // reload loses it and the staging could never be reclaimed by a retry. Whoever persists
      // upload_id (sessionStorage) to enable real resume must drop this discard at the same time.
      try { await reqCore('DELETE', `/v2/upload/${upload_id}`) } catch { /* best effort */ }
      throw e
    }
  }
}

// Digest of ONE chunk, so integrity is verified without ever hashing the whole file (which would mean
// holding all of it, the exact thing chunking avoids). crypto.subtle needs a secure context: on
// localhost and https it is there, over plain http on a LAN address it is not, so this degrades to
// "no per-chunk check" rather than breaking the upload.
async function digestOf(blob) {
  if (!globalThis.crypto?.subtle) return null
  try {
    const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('')
  } catch { return null }
}

// One chunk, over XHR rather than fetch: fetch exposes no upload progress event, so a large chunk on
// a slow link would otherwise sit at zero with nothing to show the user.
function putChunk(uploadId, index, blob, { onProgress, signal, sha256 } = {}) {
  return new Promise((resolve, reject) => {
    // abort() on an XHR that was opened but never sent is a no-op: it fires no event, so returning
    // here without rejecting would leave this promise pending forever and wedge the whole upload.
    if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { aborted: true }))

    const xhr = new XMLHttpRequest()
    xhr.open('PUT', `/v2/upload/${uploadId}/${index}`)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    if (sha256) xhr.setRequestHeader('X-Chunk-Sha256', sha256)
    // Without a timeout a half-open connection (closed lid, dropped VPN, expired NAT entry) fires
    // neither load nor error, and the transfer hangs until the OS gives up, which can be hours.
    xhr.timeout = Number(import.meta.env?.VITE_UPLOAD_CHUNK_TIMEOUT_MS) || 120000

    const onAbort = () => xhr.abort()
    const settle = (fn) => (...args) => { signal?.removeEventListener('abort', onAbort); fn(...args) }
    const ok = settle(resolve)
    const no = settle(reject)

    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded) }
    xhr.onload = () => {
      // Parse before branching: a 2xx carrying a non-JSON body (a proxy interstitial, a truncated
      // response) used to throw inside this handler, which rejects nothing and settles nothing.
      let body = null
      try { body = JSON.parse(xhr.responseText || '{}') } catch { body = null }
      if (xhr.status >= 200 && xhr.status < 300) {
        if (body) return ok(body)
        return no(Object.assign(new Error(`chunk ${index}: ${xhr.status} with a non-JSON body, something is rewriting the response`), { status: xhr.status }))
      }
      let msg = body?.error || `chunk ${index} -> ${xhr.status}`
      // The likeliest deployment failure for this feature, so name the cause rather than the number.
      if (xhr.status === 413 && !body?.error) msg = `chunk ${index} rejected as too large (413): the reverse proxy's client_max_body_size is below the chunk size`
      no(Object.assign(new Error(msg), { status: xhr.status }))
    }
    xhr.onerror = () => no(new Error('network error'))
    xhr.ontimeout = () => no(Object.assign(new Error(`chunk ${index} timed out`), { status: 408 }))
    xhr.onabort = () => no(Object.assign(new Error('aborted'), { aborted: true }))
    signal?.addEventListener('abort', onAbort, { once: true })
    xhr.send(blob)
  })
}

// Retry a chunk through transient failures (dropped connection, 5xx, rate limit). A 4xx other than
// 408/429 means the request itself is wrong, so retrying it unchanged can only fail the same way.
async function withRetry(fn, { attempts = 4, baseMs = 400 } = {}) {
  let last
  for (let a = 0; a < attempts; a++) {
    try { return await fn() } catch (e) {
      last = e
      if (e.aborted) throw e
      if (e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) throw e
      if (a < attempts - 1) await new Promise((r) => setTimeout(r, baseMs * 2 ** a))
    }
  }
  throw last
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
  // Selectable voices for a provider (ElevenLabs = live from the account; OpenAI = presets).
  voices: (provider) => getCore('/v2/voice/voices' + (provider ? `?provider=${encodeURIComponent(provider)}` : '')),
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
  // The clip goes up as raw bytes. As base64 in a JSON body it was bounded by the core's 10mb JSON
  // limit, which is roughly 40 minutes of webm opus and a hard stop rather than a graceful one.
  async transcribe(blob, { model, language } = {}) {
    const mime = blob.type || 'audio/webm'
    const res = await fetch(`/v2/transcribe${q({ mime, model, language })}`, {
      method: 'POST',
      headers: { 'Content-Type': mime, Accept: 'application/json' },
      body: blob
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(json.error || `transcribe -> ${res.status} ${res.statusText}`)
    return json
  }
}

// Remote Desktop — the WebRTC signaling broker (a connector, same-origin /rd via the proxy). The broker
// authenticates the caller by an RD token → trust identity (default-deny): `list` needs a view grant,
// `cast` needs full trust (control). Unlike the collector/manager, the token isn't injected by nginx —
// the broker's clients are agents/phones presenting a token, so we keep it DEVICE-LOCAL (localStorage,
// like the mobile RD viewer) and send it in the message body.
const RD_TOKEN_KEY = 'asmltr.rd.token'
export const rd = {
  // Prefer a device-local token the owner set; otherwise fall back to the token injected by nginx into
  // the authenticated GUI (window.__RD_TOKEN__ from /gui-config.js — served only behind the session auth),
  // so a logged-in owner sees the host list without pasting anything.
  getToken() { try { return localStorage.getItem(RD_TOKEN_KEY) || (typeof window !== 'undefined' && window.__RD_TOKEN__) || '' } catch { return '' } },
  setToken(t) { try { localStorage.setItem(RD_TOKEN_KEY, t || '') } catch { /* ignore */ } },
  async msg(body) {
    const res = await fetch('/rd/msg', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ token: rd.getToken(), ...body })
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok || json.ok === false) throw new Error(json.error || `POST /rd/msg -> ${res.status} ${res.statusText}`)
    return json
  },
  // The registry: all registered hosts + their caps/online state.
  list: () => rd.msg({ type: 'list' }),
  // Cast-to-device: push an open-remote-desktop directive to a target device (''/undefined = all my
  // connected devices). `control` opens the stream with input control (clamped by grants on the broker).
  async cast(device, host_id, control) {
    const res = await fetch('/rd/cast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ token: rd.getToken(), device: device || '', host_id, control: !!control })
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok || json.ok === false) throw new Error(json.error || `POST /rd/cast -> ${res.status} ${res.statusText}`)
    return json
  },
  // Castable android devices (for the target picker) + whether this caller may cast (full trust).
  async devices() {
    const res = await fetch(`/rd/devices?token=${encodeURIComponent(rd.getToken())}`, { headers: { Accept: 'application/json' } })
    const json = await res.json().catch(() => ({}))
    if (!res.ok || json.ok === false) throw new Error(json.error || `GET /rd/devices -> ${res.status} ${res.statusText}`)
    return json
  },
  async health() { const res = await fetch('/rd/health'); return res.json() }
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
