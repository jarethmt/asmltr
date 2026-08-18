<script setup>
// Settings — the field/section DEFINITIONS come from the shared console manifest (GET /api/manifest),
// the ONE source of truth also driving the terminal TUI. This view keeps its hand-crafted layout +
// the bespoke status widgets (SDK version, changelog); only the declarative bits (tabs, fields, model
// choices, toggle copy) are sourced from the manifest, so adding a setting updates both GUI and TUI.
import { ref, onMounted, onBeforeUnmount, computed, reactive } from 'vue'
import PageHeader from '@/components/PageHeader.vue'
import Spinner from '@/components/Spinner.vue'
import VoiceEngines from '@/components/VoiceEngines.vue'
import { api, runtime, voice, identity, update, backupApi, integrations as integrationsApi, authApi, oidcApi, enginesApi, mcpApi, notifyApi } from '@/services/api'
import QRCode from 'qrcode'
import { startRegistration } from '@simplewebauthn/browser'
import { useUpdateProgress } from '@/composables/useUpdateProgress'
import { useTurnNotifications } from '@/composables/useTurnNotifications'
import { applyPalette } from '@/composables/useBrandTheme'

// Shared progress poller — calling begin() pops the global App.vue progress panel immediately.
const { begin: updBegin } = useUpdateProgress()
// Turn-complete browser notifications (moved here from the sidebar). Shared singleton state.
const { supported: notifySupported, enabled: notifyOn, permission: notifyPerm, toggle: toggleNotify } = useTurnNotifications()

const manifest = ref(null)
const tab = ref('identity')
const busy = ref('')      // which action is in flight
const notice = ref('')

// --- manifest-derived definitions (single source of truth) ---
const sections = computed(() => manifest.value?.settings || [])
// The manifest drives the shared GUI+TUI tabs; "Notifications" is appended GUI-only because it's a
// browser capability (Notification API) with no meaning in the terminal.
const TABS = computed(() => [
  // 'runtime' (model + permission mode) is folded into the Engines tab, so drop its standalone tab here.
  ...sections.value.filter((s) => s.id !== 'runtime').map((s) => ({ id: s.id, label: s.label, icon: s.icon })),
  { id: 'engines', label: 'Engines', icon: '🧠' },
  { id: 'security', label: 'Security', icon: '🔒' },
  { id: 'backups', label: 'Backups', icon: '🗄' },
  { id: 'notifications', label: 'Notifications', icon: '✦' },
])

// --- reasoning engines ---
const engines = ref([])
const enginesDefault = ref('claude')
const engBusy = ref('')          // engine id with an action in flight
const engCheck = reactive({})    // id -> { latest, updateAvailable }
const engError = ref('')
async function loadEngines() { try { const r = await enginesApi.list(); engines.value = r.engines || []; enginesDefault.value = r.default; checkAllEngines() } catch (_) {} }
async function setDefaultEngine(id) {
  engBusy.value = id
  try { await enginesApi.setDefault(id); await loadEngines() } catch (_) {} finally { engBusy.value = '' }
}
async function checkEngine(id) {
  try { const r = await enginesApi.check(id); engCheck[id] = { latest: r.latest, updateAvailable: r.updateAvailable } } catch (_) {}
}
async function installEngine(id) {
  engBusy.value = id; engError.value = ''
  try { await enginesApi.install(id); delete engCheck[id]; await loadEngines() }
  catch (e) { engError.value = `${id}: ${e.message}` } finally { engBusy.value = '' }
}
const autoBusy = ref('')
async function toggleEngineAuto(id, on) {
  autoBusy.value = id; engError.value = ''
  try { await enginesApi.setAutoUpdate(id, on); await loadEngines() }
  catch (e) { engError.value = `${id}: ${e.message}` } finally { autoBusy.value = '' }
}
// On opening the Engines tab, check installed engines for available updates (best-effort, background).
function checkAllEngines() { engines.value.filter((e) => e.installed).forEach((e) => checkEngine(e.id)) }

// per-engine model selection — set any engine's model without touching the default.
const modelBusy = ref('')            // engine id while its model is saving
const customModel = reactive({})     // id -> custom model id being typed
async function pickModelFor(id, modelId) {
  const m = String(modelId || '').trim(); if (!m) return
  modelBusy.value = id; engError.value = ''
  try { await enginesApi.setConfig(id, { model: m }); customModel[id] = ''; await loadEngines(); if (id === 'claude') await loadRuntime(true) }
  catch (e) { engError.value = `${id}: ${e.message}` } finally { modelBusy.value = '' }
}

// MCP registry — shared across all engines (declare once, provisioned into each harness).
const mcpServers = ref([])
const mcpBusy = ref('')
const newMcp = reactive({ name: '', command: '', args: '', url: '' })
const mcpError = ref('')
async function loadMcp() { try { mcpServers.value = (await mcpApi.list()).servers || [] } catch (_) {} }
async function addMcp() {
  mcpBusy.value = 'add'; mcpError.value = ''
  try {
    const def = { name: newMcp.name.trim() }
    if (newMcp.url.trim()) def.url = newMcp.url.trim()
    else { def.command = newMcp.command.trim(); def.args = newMcp.args.trim() ? newMcp.args.trim().split(/\s+/) : [] }
    await mcpApi.add(def); Object.assign(newMcp, { name: '', command: '', args: '', url: '' }); await loadMcp()
  } catch (e) { mcpError.value = e.message } finally { mcpBusy.value = '' }
}
async function toggleMcp(s) { mcpBusy.value = s.name; try { await mcpApi.toggle(s.name, !s.disabled); await loadMcp() } catch (e) { mcpError.value = e.message } finally { mcpBusy.value = '' } }
async function removeMcp(name) { if (!window.confirm(`Remove MCP server "${name}"?`)) return; mcpBusy.value = name; try { await mcpApi.remove(name); await loadMcp() } catch (e) { mcpError.value = e.message } finally { mcpBusy.value = '' } }

// per-engine connection / auth — subscription (OAuth) vs API key (stored in the vault).
const authBusy = ref('')             // engine id while an auth action is in flight
const apiKeyInput = reactive({})     // id -> new API key being entered
async function setEngineAuthMode(id, mode) {
  authBusy.value = id; engError.value = ''
  try { await enginesApi.setAuthMode(id, mode); await loadEngines() }
  catch (e) { engError.value = `${id}: ${e.message}` } finally { authBusy.value = '' }
}
async function saveApiKey(id) {
  const v = (apiKeyInput[id] || '').trim(); if (!v) return
  authBusy.value = id; engError.value = ''
  try { await enginesApi.setApiKey(id, v); apiKeyInput[id] = ''; await loadEngines() }
  catch (e) { engError.value = `${id}: ${e.message}` } finally { authBusy.value = '' }
}
async function removeApiKey(id) {
  authBusy.value = id; engError.value = ''
  try { await enginesApi.clearApiKey(id); await loadEngines() }
  catch (e) { engError.value = `${id}: ${e.message}` } finally { authBusy.value = '' }
}
// custom (self-hosted / alternate-provider) OpenAI-compatible endpoint
const baseUrlInput = reactive({})   // id -> edited base URL
async function saveBaseUrl(id) {
  authBusy.value = id; engError.value = ''
  try { await enginesApi.setBaseUrl(id, (baseUrlInput[id] ?? '').trim()); await loadEngines() }
  catch (e) { engError.value = `${id}: ${e.message}` } finally { authBusy.value = '' }
}

// --- security / 2FA ---
const authStatus = ref({ enabled: false, configured: false, user: null, totp: false })
const enroll = ref(null)      // { otpauth, secret, qr } during enrollment
const enrollCode = ref('')
const recoveryCodes = ref(null)
const disablePass = ref('')
const secBusy = ref(false)
const secError = ref('')
const passkeys = ref([])
const pkBusy = ref(false)
const extProviders = ref([]) // configured external login providers
const extLinked = ref([])     // ones this account has linked
// Generic per-row action spinner, keyed by `${kind}:${id}` (passkey/ext/oidc/backup-refresh).
const rowBusy = reactive({})
const oidcBusy = ref(false)   // "Register app" submit in flight
async function loadSecurity() {
  try { authStatus.value = await authApi.status() } catch (_) {}
  try { passkeys.value = (await authApi.passkeys()).passkeys || [] } catch (_) { passkeys.value = [] }
  try { const r = await authApi.external(); extProviders.value = r.providers || []; extLinked.value = r.linked || [] } catch (_) {}
}
const extProviderIcon = { github: '🐙', google: '🌐' }
const isLinked = (p) => extLinked.value.some((l) => l.provider === p)
function connectExternal(p) { rowBusy[`ext:${p}`] = true; window.location.href = authApi.externalStartUrl(p) }
async function disconnectExternal(p) {
  rowBusy[`ext:${p}`] = true; secError.value = ''
  try { await authApi.externalUnlink(p); await loadSecurity() } catch (e) { secError.value = e.message } finally { rowBusy[`ext:${p}`] = false }
}
async function addPasskey() {
  pkBusy.value = true; secError.value = ''
  try {
    const optionsJSON = await authApi.passkeyRegisterOptions()
    const label = window.prompt('Name this passkey (e.g. "MacBook Touch ID"):') || 'passkey'
    const response = await startRegistration({ optionsJSON })
    await authApi.passkeyRegisterVerify(response, label)
    await loadSecurity()
  } catch (e) { secError.value = e.message || 'Passkey registration failed.' } finally { pkBusy.value = false }
}
async function removePasskey(id) {
  if (!window.confirm('Remove this passkey?')) return
  rowBusy[`passkey:${id}`] = true; secError.value = ''
  try { await authApi.passkeyRemove(id); await loadSecurity() } catch (e) { secError.value = e.message } finally { rowBusy[`passkey:${id}`] = false }
}

// OIDC provider — client registry
const oidcStatus = ref({ enabled: false, issuer: null })
const oidcClients = ref([])
const newClient = reactive({ client_name: '', redirect_uris: '' })
const newClientSecret = ref(null) // shown once after creation
async function loadOidc() {
  try { oidcStatus.value = await oidcApi.status() } catch (_) {}
  if (!oidcStatus.value.enabled) return
  try { const r = await oidcApi.clients(); oidcClients.value = r.clients || []; oidcStatus.value.issuer = r.issuer || oidcStatus.value.issuer } catch (_) {}
}
async function addOidcClient() {
  secError.value = ''; newClientSecret.value = null; oidcBusy.value = true
  try {
    const uris = newClient.redirect_uris.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
    const c = await oidcApi.addClient({ client_name: newClient.client_name || undefined, redirect_uris: uris })
    newClientSecret.value = { client_id: c.client_id, client_secret: c.client_secret }
    newClient.client_name = ''; newClient.redirect_uris = ''
    await loadOidc()
  } catch (e) { secError.value = e.message } finally { oidcBusy.value = false }
}
async function removeOidcClient(id) {
  if (!window.confirm('Delete this OIDC client? Apps using it will stop working.')) return
  rowBusy[`oidc:${id}`] = true; secError.value = ''
  try { await oidcApi.removeClient(id); await loadOidc() } catch (e) { secError.value = e.message } finally { rowBusy[`oidc:${id}`] = false }
}
async function beginEnroll() {
  secBusy.value = true; secError.value = ''; recoveryCodes.value = null
  try {
    const r = await authApi.totpSetup()
    const qr = await QRCode.toDataURL(r.otpauth, { margin: 1, width: 200 })
    enroll.value = { otpauth: r.otpauth, secret: r.secret, qr }
  } catch (e) { secError.value = e.message } finally { secBusy.value = false }
}
async function confirmEnroll() {
  secBusy.value = true; secError.value = ''
  try {
    const r = await authApi.totpEnable(enrollCode.value)
    recoveryCodes.value = r.codes; enroll.value = null; enrollCode.value = ''
    await loadSecurity()
  } catch (e) { secError.value = e.message } finally { secBusy.value = false }
}
async function disable2fa() {
  if (!disablePass.value) { secError.value = 'Enter your password to disable 2FA.'; return }
  secBusy.value = true; secError.value = ''
  try { await authApi.totpDisable(disablePass.value); disablePass.value = ''; recoveryCodes.value = null; await loadSecurity() }
  catch (e) { secError.value = e.message } finally { secBusy.value = false }
}

// --- backups (encrypted, restorable snapshots) ---
const backups = ref([])
const backupDir = ref('')
const backupPass = ref('')
const backupLabel = ref('manual')
const backupDest = ref('local')
const backupBusy = ref(false)
const backupError = ref('')
const storageIntegrations = ref([]) // storage integrations available as remote destinations
const schedule = reactive({ enabled: false, every_hours: 24, destination: 'local', max_count: 14, max_age_days: 0, last_run: 0 })
const scheduleBusy = ref(false)
async function loadBackups() {
  rowBusy['backup-refresh'] = true
  try {
    const [r, ints] = await Promise.all([backupApi.list(), integrationsApi.list().catch(() => ({ integrations: [] }))])
    backups.value = r.backups || []; backupDir.value = r.dir || ''
    if (r.schedule) Object.assign(schedule, r.schedule)
    storageIntegrations.value = (ints.integrations || [])
  } catch (e) { backupError.value = e.message } finally { rowBusy['backup-refresh'] = false }
}
async function createBackup() {
  backupBusy.value = true; backupError.value = ''
  try {
    await backupApi.create({ label: backupLabel.value || 'manual', passphrase: backupPass.value || undefined, destination: backupDest.value })
    backupPass.value = ''
    await loadBackups()
  } catch (e) { backupError.value = e.message } finally { backupBusy.value = false }
}
async function saveSchedule() {
  scheduleBusy.value = true; backupError.value = ''
  try { const s = await backupApi.setSchedule({ enabled: schedule.enabled, every_hours: Number(schedule.every_hours), destination: schedule.destination, max_count: Number(schedule.max_count), max_age_days: Number(schedule.max_age_days) }); Object.assign(schedule, s) }
  catch (e) { backupError.value = e.message } finally { scheduleBusy.value = false }
}
// --- restore / import (guarded: preview → type-to-confirm → detached runner) ---
const restoreTarget = ref(null)     // { name, file } being restored, or null
const restorePass = ref('')
const restorePreview = ref(null)    // { manifest, plan, logs }
const restoreConfirm = ref('')      // operator must type the backup name
const restoreBusy = ref('')         // '' | 'preview' | 'running'
const restoreLog = ref('')
const importBusy = ref(false)
let _restorePoll = null
function openRestore(b) { restoreTarget.value = { name: b.name, file: b.file }; restorePreview.value = null; restoreConfirm.value = ''; restorePass.value = ''; restoreLog.value = ''; backupError.value = '' }
function closeRestore() { restoreTarget.value = null; if (_restorePoll) { clearInterval(_restorePoll); _restorePoll = null } }
async function doPreview() {
  restoreBusy.value = 'preview'; backupError.value = ''; restorePreview.value = null
  try { restorePreview.value = await backupApi.restorePreview({ file: restoreTarget.value.file, passphrase: restorePass.value || undefined }) }
  catch (e) { backupError.value = e.message } finally { restoreBusy.value = '' }
}
async function doRestore() {
  if (restoreConfirm.value.trim() !== restoreTarget.value.name) { backupError.value = 'Type the exact backup name to confirm.'; return }
  restoreBusy.value = 'running'; backupError.value = ''; restoreLog.value = 'starting…\n'
  try {
    await backupApi.restore({ file: restoreTarget.value.file, passphrase: restorePass.value || undefined, confirm: true })
    // Poll the log — the core restarts mid-restore (activate), so errors while it's down are expected.
    _restorePoll = setInterval(async () => {
      try { const r = await backupApi.restoreLog(); if (r.log) restoreLog.value = r.log; if (/restore-runner exited/.test(r.log)) { clearInterval(_restorePoll); _restorePoll = null; restoreBusy.value = ''; await loadBackups() } } catch (_) { restoreLog.value += '.' }
    }, 2000)
  } catch (e) { backupError.value = e.message; restoreBusy.value = '' }
}
async function importBackup(evt) {
  const file = evt.target.files && evt.target.files[0]; if (!file) return
  importBusy.value = true; backupError.value = ''
  try { await backupApi.import(file); await loadBackups() }
  catch (e) { backupError.value = e.message } finally { importBusy.value = false; evt.target.value = '' }
}
const fmtMB = (n) => (n / 1048576).toFixed(2) + ' MB'
function section(id) { return sections.value.find((s) => s.id === id) || { fields: [] } }
function field(sectionId, fieldId) { return (section(sectionId).fields || []).find((f) => f.id === fieldId) || {} }
const identityFields = computed(() => section('identity').fields || [])

// --- Identity (the Self / Likeness plane) ---
const idn = ref(null)
const d = reactive({ name: '', self_description: '', preferences: '', story: '', aesthetic: '', palette: '' })
const showPreamble = ref(false)
const nameDirty = computed(() => idn.value && d.name.trim() && d.name.trim() !== idn.value.name)
const idnDirty = computed(() => idn.value && (nameDirty.value
  || d.self_description !== idn.value.self_description
  || d.preferences !== idn.value.preferences
  || d.story !== idn.value.story
  || d.aesthetic !== (idn.value.aesthetic || '')
  || d.palette !== (idn.value.palette || '')))
function syncIdentity() { Object.assign(d, { name: idn.value.name, self_description: idn.value.self_description, preferences: idn.value.preferences || '', story: idn.value.story || '', aesthetic: idn.value.aesthetic || '', palette: idn.value.palette || '' }) }
async function loadIdentity() { try { idn.value = await identity.get(); syncIdentity() } catch (_) {} }
async function saveIdentity() {
  busy.value = 'identity'; notice.value = ''
  const renamed = nameDirty.value
  try {
    const body = {}
    if (nameDirty.value) body.name = d.name.trim()
    if (d.self_description !== idn.value.self_description) body.self_description = d.self_description
    if (d.preferences !== idn.value.preferences) body.preferences = d.preferences
    if (d.story !== idn.value.story) body.story = d.story
    if (d.aesthetic !== (idn.value.aesthetic || '')) body.aesthetic = d.aesthetic
    if (d.palette !== (idn.value.palette || '')) body.palette = d.palette
    idn.value = await identity.set(body); syncIdentity()
    applyPalette(idn.value.palette) // retint the whole UI live from the saved signature colors
    notice.value = renamed
      ? `Saved. The core uses “${idn.value.name}” from the next turn — but connector-level name (Discord wake word, the shell alias, the bot's own username) needs a service restart + re-provision to fully realign.`
      : 'Identity saved — applies to the next turn on every surface.'
  } catch (e) { notice.value = 'Failed: ' + e.message } finally { busy.value = '' }
}

// --- Updates (code self-update: deterministic, versioned, channel-based) ---
const upd = ref(null)
const updAuto = ref(false)
const updChannel = ref('edge')
async function loadUpdates() {
  try { upd.value = await update.status(true) } catch (_) {}
  try { updAuto.value = (await update.getAuto()).auto } catch (_) {}
  try { updChannel.value = (await update.getChannel()).channel } catch (_) {}
}
async function toggleUpdAuto() {
  busy.value = 'upd-auto'
  try { updAuto.value = (await update.setAuto(!updAuto.value)).auto } catch (e) { notice.value = 'Failed: ' + e.message } finally { busy.value = '' }
}
async function setChannel(ch) {
  if (ch === updChannel.value) return
  busy.value = 'upd-channel'; notice.value = ''
  try { updChannel.value = (await update.setChannel(ch)).channel; upd.value = await update.status(true); notice.value = `Update channel set to “${ch}”.` }
  catch (e) { notice.value = 'Failed: ' + e.message } finally { busy.value = '' }
}
async function runUpdate() {
  busy.value = 'upd-run'; notice.value = ''
  updBegin() // show the persistent progress panel immediately
  try { await update.run(); notice.value = 'Update started — the deterministic updater is running (fetch → install → restart → verify, auto-rollback on failure). Progress shows at the top of every page and survives the restart.' }
  catch (e) { notice.value = 'Failed to start: ' + e.message } finally { busy.value = '' }
}

// --- Runtime (Claude Agent SDK: version + auto-update + permission mode) ---
const rt = ref(null)
async function loadRuntime(fetch = true) { try { rt.value = await runtime.get(fetch) } catch (e) { notice.value = 'Could not load runtime: ' + e.message } }
async function toggleAuto() {
  busy.value = 'auto'
  try { const r = await runtime.setAutoUpdate(!rt.value.autoUpdate); rt.value.autoUpdate = r.autoUpdate }
  catch (e) { notice.value = 'Failed: ' + e.message } finally { busy.value = '' }
}
async function toggleCliBypass() {
  busy.value = 'cli-bypass'
  try { const r = await runtime.setCliBypass(!rt.value.cliBypass); rt.value.cliBypass = r.cliBypass; notice.value = `Terminal sessions now launch in ${r.cliBypass ? 'bypass-permissions (full-autonomy)' : 'normal-permission'} mode — applies to the next ‘asmltr claude’.` }
  catch (e) { notice.value = 'Failed: ' + e.message } finally { busy.value = '' }
}
async function updateSdk() {
  busy.value = 'update'; notice.value = ''
  try {
    await runtime.update()
    notice.value = 'SDK update started — the core will reinstall and restart. This can take a minute; the version refreshes automatically.'
    const before = rt.value?.sdk?.installed; let tries = 0
    const timer = setInterval(async () => {
      tries++
      try { const r = await runtime.get(true); if (r?.sdk?.installed && r.sdk.installed !== before) { rt.value = r; notice.value = `Updated to ${r.sdk.installed}.`; clearInterval(timer) } } catch (_) {}
      if (tries > 30) clearInterval(timer)
    }, 6000)
  } catch (e) { notice.value = 'Update failed to start: ' + e.message } finally { busy.value = '' }
}

// --- Voice ---
const ackOn = ref(true)
function toggleAck() { ackOn.value = !ackOn.value; voice.setAck(ackOn.value).catch(() => {}) }
// TTS voice/model + STT model — server-persisted config; the choice lists come from the manifest.
const vcfg = ref(null) // { tts: { provider, voice, model, … }, stt: { model, … } }
const customVoice = ref('')
const customTtsModel = ref('')
const ttsProviderChoices = computed(() => field('voice', 'tts_provider').choices || [])
// Live voices for the selected provider (ElevenLabs = the account's voices; OpenAI = presets). Falls
// back to the manifest's static list only if the live fetch hasn't populated.
const dynamicVoices = ref(null)
const voicesLoading = ref(false)
const ttsVoiceChoices = computed(() => dynamicVoices.value || field('voice', 'tts_voice').choices || [])
// ElevenLabs models (their `eleven_*` model ids — the OpenAI models in the manifest don't apply to EL).
const EL_TTS_MODELS = [
  { id: 'eleven_multilingual_v2', label: 'eleven_multilingual_v2', hint: 'highest quality, 29 languages' },
  { id: 'eleven_turbo_v2_5', label: 'eleven_turbo_v2_5', hint: 'fast, low latency (recommended)' },
  { id: 'eleven_flash_v2_5', label: 'eleven_flash_v2_5', hint: 'fastest, ~75ms' },
  { id: 'eleven_v3', label: 'eleven_v3', hint: 'newest, most expressive (alpha)' },
]
// Model list follows the selected provider: ElevenLabs → eleven_* models; OpenAI → the manifest presets.
const ttsModelChoices = computed(() => vcfg.value?.tts?.provider === 'elevenlabs' ? EL_TTS_MODELS : (field('voice', 'tts_model').choices || []))
const sttModelChoices = computed(() => field('voice', 'stt_model').choices || [])
async function loadVoices(provider) {
  voicesLoading.value = true
  try { const r = await voice.voices(provider); dynamicVoices.value = (r.voices || []).map((v) => ({ id: v.id, label: v.label })) }
  catch (_) { dynamicVoices.value = null }
  finally { voicesLoading.value = false }
}
const wakePhrase = ref('')
const stopPhrasesInput = ref('')
const sttEndpointChoices = computed(() => field('voice', 'stt_endpoint').choices || [])
const sttSensChoices = computed(() => field('voice', 'stt_sensitivity').choices || [])
async function loadVoiceCfg() { try { vcfg.value = await voice.getConfig(); wakePhrase.value = vcfg.value?.stt?.wake_phrase || ''; stopPhrasesInput.value = vcfg.value?.stt?.stop_phrases || ''; await loadVoices(vcfg.value?.tts?.provider) } catch (_) {} }
async function setVoiceCfg(part) {
  busy.value = 'voicecfg'; notice.value = ''
  // When the provider flips, snap the model to that provider's default so the UI never leaves an
  // OpenAI model selected under ElevenLabs (or vice-versa) — matches the backend's coercion.
  if (part.tts && part.tts.provider && part.tts.model === undefined) {
    part = { ...part, tts: { ...part.tts, model: part.tts.provider === 'elevenlabs' ? 'eleven_turbo_v2_5' : 'gpt-4o-mini-tts' } }
  }
  try {
    vcfg.value = await voice.setConfig(part); notice.value = 'Voice settings saved — applies to the next clip.'
    if (part.tts && part.tts.provider) await loadVoices(part.tts.provider) // provider changed → refresh the voice list
  }
  catch (e) { notice.value = 'Failed: ' + e.message } finally { busy.value = '' }
}
async function setCustomVoice() { const v = customVoice.value.trim(); if (v) { await setVoiceCfg({ tts: { voice: v } }); customVoice.value = '' } }
async function setCustomTtsModel() { const m = customTtsModel.value.trim(); if (m) { await setVoiceCfg({ tts: { model: m } }); customTtsModel.value = '' } }

// --- Voice pipeline tester (talk to the full agent + hear it streamed back) --------------------------
const vtPrompt = ref("Walk me through what you'd check first if a web service returned a 502, in two or three sentences.")
const vtBusy = ref(false)
const vtStatus = ref('')
const vtRows = ref([])            // { kind:'ack'|'text', text }
let vtCtrl = null
let _chime = null, _drone = null
const _q = []; let _playing = false
function _audio(url) { const a = new Audio(url); return a }
function _enqueue(b64, mime) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  _q.push(URL.createObjectURL(new Blob([bytes], { type: mime || 'audio/mpeg' })))
  if (!_playing) _playNext()
}
function _playNext() {
  const url = _q.shift(); if (!url) { _playing = false; return }
  _playing = true; const a = _audio(url)
  a.onended = a.onerror = () => { URL.revokeObjectURL(url); _playNext() }
  a.play().catch(() => _playNext())
}
function _stopDrone() { try { _drone && _drone.pause(); if (_drone) _drone.currentTime = 0 } catch (_) {} }
function _stopAudio() { _stopDrone(); _q.length = 0; _playing = false }
function vtSpeak() {
  const text = vtPrompt.value.trim(); if (!text || vtBusy.value) return
  if (!_chime) { _chime = _audio(voice.assetUrl('chime.ogg')) }
  if (!_drone) { _drone = _audio(voice.assetUrl('drone.ogg')); _drone.loop = true; _drone.volume = 0.35 }
  vtBusy.value = true; vtRows.value = []; vtStatus.value = 'connecting…'
  const t0 = performance.now()
  vtCtrl = voice.speak({ conversation_key: 'web:voice-test-' + Date.now(), text }, {
    onCue: (cue) => {
      if (cue === 'chime') { _chime.currentTime = 0; _chime.play().catch(() => {}); vtStatus.value = 'on it…' }
      else if (cue === 'drone-start') _drone.play().catch(() => {})
      else if (cue === 'drone-stop') { _stopDrone(); vtStatus.value = `answering… (${((performance.now() - t0) / 1000).toFixed(1)}s to first reply)` }
    },
    onAudio: (f) => { _enqueue(f.b64, f.mime); if (f.role === 'ack') vtRows.value.push({ kind: 'ack', text: f.text || '(acknowledgment)' }) },
    onText: (f) => vtRows.value.push({ kind: 'text', text: f.text }),
    onDone: () => { vtStatus.value = `done · ${((performance.now() - t0) / 1000).toFixed(1)}s total`; vtBusy.value = false; vtCtrl = null },
    onError: (m) => { vtStatus.value = 'error: ' + m; vtBusy.value = false; vtCtrl = null; _stopDrone() },
  })
}
function vtStop() { try { vtCtrl && vtCtrl.abort() } catch (_) {} _stopAudio(); vtBusy.value = false; vtStatus.value = 'stopped' }
onBeforeUnmount(() => { try { vtCtrl && vtCtrl.abort() } catch (_) {} _stopAudio() })

// --- Notify delivery ladder (asmltr notify: android read-aloud → push → text fallback) ---------------
const ncfg = reactive({ quiet_start: 23, quiet_end: 8, require_headphones: false, fb_channel: '', fb_target: '' })
const notifyMsg = ref('')
async function loadNotify() {
  try {
    const c = await notifyApi.getConfig()
    ncfg.quiet_start = c.quiet_hours?.start ?? 23
    ncfg.quiet_end = c.quiet_hours?.end ?? 8
    ncfg.require_headphones = !!c.require_headphones
    ncfg.fb_channel = c.text_fallback?.channel || ''
    ncfg.fb_target = c.text_fallback?.target || ''
  } catch (_) { /* notify config optional */ }
}
async function saveNotify() {
  notifyMsg.value = 'saving…'
  try {
    await notifyApi.setConfig({
      quiet_hours: { start: Number(ncfg.quiet_start), end: Number(ncfg.quiet_end) },
      require_headphones: ncfg.require_headphones,
      text_fallback: ncfg.fb_channel && ncfg.fb_target ? { channel: ncfg.fb_channel.trim(), target: ncfg.fb_target.trim() } : null,
    })
    notifyMsg.value = '✓ saved'
  } catch (e) { notifyMsg.value = '✗ ' + e.message }
  setTimeout(() => (notifyMsg.value = ''), 2500)
}
async function testNotify() {
  notifyMsg.value = 'sending test…'
  try { const r = await notifyApi.send({ text: 'asmltr notify test — this is a delivery-ladder check.', title: 'Test' }); notifyMsg.value = r.delivered ? `✓ delivered via ${r.via}` : '· not delivered (no reachable step)' }
  catch (e) { notifyMsg.value = '✗ ' + e.message }
  setTimeout(() => (notifyMsg.value = ''), 4000)
}

onMounted(async () => {
  try { manifest.value = await api.manifest() } catch (_) {}
  await Promise.all([loadIdentity(), loadRuntime(true), loadUpdates(), loadVoiceCfg(), loadNotify(), loadBackups(), loadSecurity(), loadOidc(), loadEngines(), loadMcp()])
  try { ackOn.value = (await voice.getAck()).enabled } catch (_) {}
})
</script>

<template>
  <div>
    <PageHeader title="Settings" subtitle="Identity, runtime, and behaviour" />

    <div class="mx-auto max-w-2xl">
      <p v-if="!manifest" class="glass py-8 text-center text-sm text-slate-500">loading settings…</p>
      <template v-else>
        <!-- tab bar (from the manifest) — wraps to multiple rows on narrow screens instead of overflowing -->
        <div class="mb-5 flex flex-wrap gap-1 rounded-xl border border-white/10 bg-white/[0.03] p-1">
          <button
            v-for="t in TABS" :key="t.id" type="button"
            class="grow whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition-colors"
            :class="tab === t.id ? 'bg-brand-violet/20 text-violet-200' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'"
            @click="tab = t.id"
          ><AppIcon :glyph="t.icon" class="mr-1" /> {{ t.label }}</button>
        </div>

        <!-- Identity — fields from the manifest -->
        <div v-show="tab === 'identity'" class="glass p-5">
          <h3 class="mb-1 text-sm font-semibold text-slate-200">{{ section('identity').label }}</h3>
          <p class="mb-4 text-[12px] text-slate-500">{{ section('identity').desc }}</p>
          <template v-if="idn">
            <template v-for="fld in identityFields" :key="fld.id">
              <label class="mb-1 block text-[11px] uppercase tracking-wide text-slate-500">{{ fld.label }}<span v-if="fld.desc" class="normal-case text-slate-600"> — {{ fld.desc }}</span></label>
              <input
                v-if="fld.type === 'text'"
                v-model="d[fld.id]" type="text"
                class="mb-4 w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm font-semibold text-slate-100 outline-none transition-colors focus:border-brand-violet/60 focus:bg-white/[0.06]"
              />
              <textarea
                v-else
                v-model="d[fld.id]" :rows="fld.rows || 4" :placeholder="fld.placeholder"
                class="mb-4 w-full resize-y rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-[13px] leading-relaxed text-slate-100 outline-none transition-colors placeholder:text-slate-600 focus:border-brand-violet/60 focus:bg-white/[0.06]"
              ></textarea>
            </template>
            <div class="mt-2 flex items-center gap-2">
              <button
                type="button"
                :disabled="!idnDirty || busy === 'identity'"
                class="rounded-lg bg-brand-gradient px-4 py-1.5 text-xs font-semibold text-white shadow-lg shadow-brand-violet/30 disabled:opacity-40"
                @click="saveIdentity"
              ><Spinner v-if="busy === 'identity'" size="xs" class="mr-1" />{{ busy === 'identity' ? 'saving…' : 'Save' }}</button>
              <button type="button" class="text-xs text-slate-400 hover:text-slate-200" @click="showPreamble = !showPreamble">
                {{ showPreamble ? 'hide' : 'preview' }} the anchor every session sees
              </button>
            </div>
            <pre v-if="showPreamble" class="mt-3 max-h-56 overflow-y-auto whitespace-pre-wrap rounded-lg border border-white/5 bg-black/30 p-3 text-[11px] leading-relaxed text-slate-400">{{ idn.preamble }}</pre>
          </template>
          <p v-else class="py-3 text-center text-sm text-slate-500">loading…</p>
        </div>

        <!-- Reasoning engines — one card per engine: header · model · connection · runtime. Configure them
             all at once; the default (★) is what the agent command uses, but any is invokable directly. -->
        <div v-show="tab === 'engines'" class="space-y-4">
          <div class="glass p-5">
            <h3 class="mb-1 text-sm font-semibold text-slate-200">Reasoning engines</h3>
            <p class="text-[12px] text-slate-500">
              Configure each agentic backend once — model, connection, runtime. The <b class="text-violet-300">★ default</b> is
              what the <span class="font-mono">{{ agentName }}</span> command and new sessions use, but any configured engine can be
              invoked directly via <span class="font-mono">asmltr &lt;engine&gt;</span>. API keys are stored in the TRUST vault, never on disk.
            </p>
            <p v-if="engError" class="mt-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-300">{{ engError }}</p>
          </div>

          <div v-for="e in engines" :key="e.id" class="glass space-y-4 p-5" :class="e.isDefault ? 'ring-1 ring-brand-violet/40' : ''">
            <!-- header -->
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-sm font-semibold text-slate-100">{{ e.label }}</span>
              <span v-if="e.isDefault" class="pill border border-brand-violet/40 bg-brand-violet/10 text-[10px] text-violet-300">★ default</span>
              <span class="pill border text-[10px]" :class="e.installed ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300' : 'border-white/10 bg-white/5 text-slate-500'">{{ e.installed ? '● installed' : '○ not installed' }}</span>
              <span v-if="engCheck[e.id] && engCheck[e.id].updateAvailable" class="pill border border-amber-400/30 bg-amber-400/10 text-[10px] text-amber-300">update → {{ engCheck[e.id].latest }}</span>
              <span class="font-mono text-[10px] text-slate-500">{{ e.version || '—' }} · asmltr {{ e.id }}</span>
              <div class="ml-auto flex items-center gap-2">
                <button v-if="!e.installed && e.pkg" type="button" class="act" :disabled="engBusy===e.id" @click="installEngine(e.id)"><Spinner v-if="engBusy===e.id" size="xs" class="mr-1" />{{ engBusy===e.id ? 'installing…' : 'Install' }}</button>
                <button v-else-if="e.pkg && engCheck[e.id] && engCheck[e.id].updateAvailable" type="button" class="act" :disabled="engBusy===e.id" @click="installEngine(e.id)"><Spinner v-if="engBusy===e.id" size="xs" class="mr-1" />{{ engBusy===e.id ? 'updating…' : 'Update' }}</button>
                <button v-if="e.installed && !e.isDefault" type="button" class="act" :disabled="!!engBusy" @click="setDefaultEngine(e.id)"><Spinner v-if="engBusy===e.id" size="xs" class="mr-1" />Set default</button>
              </div>
            </div>

            <!-- auto-update (keep the harness current on a cadence) -->
            <p v-if="!e.installed && !e.pkg && e.installHint" class="w-full text-[12px] text-slate-500">Not an npm package. Install with <span class="font-mono text-slate-400">{{ e.installHint }}</span>, then refresh.</p>
            <label v-if="e.installed && e.pkg" class="flex cursor-pointer items-center justify-between gap-3">
              <span>
                <span class="text-sm text-slate-200">Auto-update this engine</span>
                <span class="block text-[12px] text-slate-500">Check npm every 6h and upgrade the <span class="font-mono">{{ e.id }}</span> harness in place, so it never goes stale.</span>
              </span>
              <span class="flex items-center gap-2">
                <Spinner v-if="autoBusy===e.id" size="xs" class="text-slate-400" />
                <button type="button" :disabled="autoBusy===e.id" class="relative h-6 w-11 shrink-0 rounded-full transition-colors" :class="e.autoUpdate ? 'bg-brand-violet' : 'bg-white/15'" @click="toggleEngineAuto(e.id, !e.autoUpdate)">
                  <span class="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all" :class="e.autoUpdate ? 'left-[22px]' : 'left-0.5'"></span>
                </button>
              </span>
            </label>

            <!-- model -->
            <div>
              <div class="mb-1.5 text-[11px] uppercase tracking-wide text-slate-500">Model
                <span v-if="e.id==='claude' && rt && rt.model && rt.model.resolved" class="ml-1 font-mono text-slate-400">· running {{ rt.model.resolved }}</span>
                <span v-else-if="e.model" class="ml-1 font-mono text-slate-400">· {{ e.model }}</span>
                <Spinner v-if="modelBusy===e.id" size="xs" class="ml-1 text-slate-400" />
              </div>
              <div class="flex flex-wrap gap-2">
                <button v-for="c in e.models" :key="c.id" type="button" :disabled="modelBusy===e.id"
                  class="rounded-lg border px-3 py-2 text-left text-xs transition-colors"
                  :class="e.model===c.id ? 'border-brand-violet/60 bg-brand-violet/15 text-violet-200' : 'border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/10'"
                  @click="pickModelFor(e.id, c.id)">
                  <div class="font-semibold">{{ c.label }}</div>
                </button>
              </div>
              <div class="mt-2 flex items-center gap-2">
                <input v-model="customModel[e.id]" type="text" :placeholder="'or a full model id for ' + e.id"
                  class="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 font-mono text-xs text-slate-100 outline-none focus:border-brand-violet/60"
                  @keydown.enter.prevent="pickModelFor(e.id, customModel[e.id])" />
                <button type="button" :disabled="!(customModel[e.id]||'').trim() || modelBusy===e.id" class="shrink-0 rounded-lg bg-brand-gradient px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40" @click="pickModelFor(e.id, customModel[e.id])"><Spinner v-if="modelBusy===e.id" size="xs" class="mr-1" />Set</button>
              </div>
            </div>

            <!-- connection: subscription (OAuth, owned by the CLI) vs API key (stored in the vault) -->
            <div v-if="e.auth">
              <div class="mb-1.5 text-[11px] uppercase tracking-wide text-slate-500">Connection<Spinner v-if="authBusy===e.id" size="xs" class="ml-1 text-slate-400" /></div>
              <div class="flex flex-wrap gap-2">
                <button v-for="m in e.auth.modes" :key="m" type="button" :disabled="authBusy===e.id"
                  class="rounded-lg border px-3 py-1.5 text-xs transition-colors"
                  :class="e.auth.mode===m ? 'border-brand-violet/60 bg-brand-violet/15 text-violet-200' : 'border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/10'"
                  @click="setEngineAuthMode(e.id, m)">{{ m==='subscription' ? 'Subscription (OAuth)' : 'API key' }}</button>
                <span v-if="e.auth.modes.length===1" class="self-center text-[11px] text-slate-500">subscription only</span>
              </div>
              <p v-if="e.auth.mode==='subscription'" class="mt-2 text-[12px] text-slate-500">
                Signed in through the harness's own login. If a session reports it isn't authenticated, run
                <span class="font-mono text-slate-400">{{ e.auth.loginCmd }}</span> once in a terminal.
              </p>
              <div v-else-if="e.auth.mode==='api_key'" class="mt-2 space-y-2">
                <div v-if="e.auth.hasApiKey" class="flex items-center gap-2">
                  <span class="pill border border-emerald-400/30 bg-emerald-400/10 text-[10px] text-emerald-300">🔒 key stored in vault</span>
                  <button type="button" class="act-danger" :disabled="authBusy===e.id" @click="removeApiKey(e.id)"><Spinner v-if="authBusy===e.id" size="xs" class="mr-1" />Remove</button>
                </div>
                <div class="flex items-center gap-2">
                  <input v-model="apiKeyInput[e.id]" type="password" autocomplete="off" :placeholder="(e.auth.hasApiKey ? 'replace ' : 'paste ') + (e.auth.apiKeyEnv || 'API key')"
                    class="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 font-mono text-xs text-slate-100 outline-none focus:border-brand-violet/60"
                    @keydown.enter.prevent="saveApiKey(e.id)" />
                  <button type="button" :disabled="!(apiKeyInput[e.id]||'').trim() || authBusy===e.id" class="shrink-0 rounded-lg bg-brand-gradient px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40" @click="saveApiKey(e.id)"><Spinner v-if="authBusy===e.id" size="xs" class="mr-1" />{{ authBusy===e.id ? 'saving…' : 'Save' }}</button>
                </div>
                <p class="text-[12px] text-slate-500">{{ e.auth.note }}</p>
              </div>

              <!-- self-hosted / custom OpenAI-compatible endpoint (base_url-capable engines only) -->
              <div v-if="e.supportsBaseUrl" class="mt-3 border-t border-white/5 pt-3">
                <div class="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wide text-slate-500">
                  Custom endpoint <span class="font-normal normal-case text-slate-600">— self-hosted / alternate provider</span>
                  <span v-if="e.baseUrl" class="pill border border-emerald-400/30 bg-emerald-400/10 text-[10px] text-emerald-300">● {{ e.baseUrl }}</span>
                </div>
                <div class="flex items-center gap-2">
                  <input :value="baseUrlInput[e.id] ?? e.baseUrl" @input="baseUrlInput[e.id] = $event.target.value" type="text" :placeholder="e.baseUrlHint"
                    class="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 font-mono text-xs text-slate-100 outline-none focus:border-brand-violet/60"
                    @keydown.enter.prevent="saveBaseUrl(e.id)" />
                  <button type="button" :disabled="authBusy===e.id" class="shrink-0 rounded-lg bg-brand-gradient px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40" @click="saveBaseUrl(e.id)"><Spinner v-if="authBusy===e.id" size="xs" class="mr-1" />Save</button>
                  <button v-if="e.baseUrl" type="button" class="act-danger" :disabled="authBusy===e.id" @click="baseUrlInput[e.id]=''; saveBaseUrl(e.id)">Clear</button>
                </div>
                <p class="mt-1 text-[12px] text-slate-500">When set, this engine's turns route to your endpoint (use <b>API key</b> mode above with the server's key, or any placeholder if it needs none). The model becomes whatever your server serves.</p>
              </div>
            </div>

            <!-- runtime: Claude Agent SDK web runner only (SDK version + auto-update + permission mode) -->
            <div v-if="e.id==='claude' && rt" class="space-y-4 border-t border-white/5 pt-4">
              <div class="text-[11px] uppercase tracking-wide text-slate-500">Runtime · Agent SDK <span class="font-normal normal-case text-slate-600">(the web-session runner)</span></div>
              <div class="flex flex-wrap items-center gap-3 rounded-lg border border-white/5 bg-black/20 p-3">
                <div class="min-w-0">
                  <div class="text-[11px] uppercase tracking-wide text-slate-500">Agent SDK</div>
                  <div class="font-mono text-sm text-slate-200">{{ rt.sdk.installed || '—' }}
                    <span v-if="rt.sdk.latest && !rt.sdk.updateAvailable" class="ml-1 text-[11px] text-emerald-400"><AppIcon glyph="✓" /> up to date</span>
                    <span v-else-if="rt.sdk.updateAvailable" class="ml-1 text-[11px] text-amber-400">→ {{ rt.sdk.latest }} available</span>
                  </div>
                </div>
                <button type="button" :disabled="busy === 'update' || !rt.sdk.updateAvailable"
                  class="ml-auto rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-40"
                  :class="rt.sdk.updateAvailable ? 'border-amber-400/30 bg-amber-400/10 text-amber-300 hover:bg-amber-400/20' : 'border-white/10 bg-white/5 text-slate-500'"
                  @click="updateSdk"
                ><Spinner v-if="busy === 'update'" size="xs" class="mr-1" />{{ busy === 'update' ? 'starting…' : (rt.sdk.updateAvailable ? 'Update now' : 'Latest') }}<AppIcon v-if="busy !== 'upd-run' && busy !== 'update'" glyph="↑" class="ml-1" /></button>
              </div>
              <label class="flex cursor-pointer items-center justify-between gap-3">
                <span>
                  <span class="text-sm text-slate-200">{{ field('runtime','autoUpdate').label }}</span>
                  <span class="block text-[12px] text-slate-500">{{ field('runtime','autoUpdate').desc }}</span>
                </span>
                <button type="button" :disabled="busy === 'auto'" class="relative h-6 w-11 shrink-0 rounded-full transition-colors" :class="rt.autoUpdate ? 'bg-brand-violet' : 'bg-white/15'" @click="toggleAuto">
                  <span class="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all" :class="rt.autoUpdate ? 'left-[22px]' : 'left-0.5'"></span>
                </button>
              </label>
              <label class="flex cursor-pointer items-center justify-between gap-3">
                <span>
                  <span class="text-sm text-slate-200">{{ field('runtime','cliBypass').label }}</span>
                  <span class="block text-[12px] text-slate-500">{{ field('runtime','cliBypass').desc }}</span>
                </span>
                <button type="button" :disabled="busy === 'cli-bypass'" class="relative h-6 w-11 shrink-0 rounded-full transition-colors" :class="rt.cliBypass ? 'bg-brand-violet' : 'bg-white/15'" @click="toggleCliBypass">
                  <span class="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all" :class="rt.cliBypass ? 'left-[22px]' : 'left-0.5'"></span>
                </button>
              </label>
            </div>
          </div>

          <!-- MCP tools — declared once, provisioned into EVERY engine (Claude SDK / Codex / Gemini) -->
          <div class="glass p-5">
            <h3 class="mb-1 text-sm font-semibold text-slate-200">MCP tools <span class="text-[11px] font-normal text-slate-500">· shared across all engines</span></h3>
            <p class="mb-3 text-[12px] text-slate-500">Declare an MCP server once; it's provisioned into whichever engine runs a turn. The built-in <span class="font-mono">asmltr-toolbelt</span> exposes {{ agentName }}'s own tools (sessions · send · announce · uploads) to every harness.</p>
            <p v-if="mcpError" class="mb-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-300">{{ mcpError }}</p>
            <ul class="divide-y divide-white/5 overflow-hidden rounded-xl border border-white/5">
              <li v-for="s in mcpServers" :key="s.name" class="flex items-center gap-2 px-3 py-2 text-sm">
                <AppIcon glyph="🧩" class="text-slate-500" />
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <span class="font-medium text-slate-100">{{ s.name }}</span>
                    <span v-if="s.builtin" class="pill border border-brand-violet/40 bg-brand-violet/10 text-[10px] text-violet-300">built-in</span>
                    <span class="pill border border-white/10 bg-white/5 text-[10px] text-slate-500">{{ s.type }}</span>
                    <span v-if="s.disabled" class="pill border border-white/10 bg-white/5 text-[10px] text-slate-500">off</span>
                  </div>
                  <div class="truncate font-mono text-[10px] text-slate-500">{{ s.url || (s.command + ' ' + (s.args||[]).join(' ')) }}</div>
                </div>
                <button type="button" class="act" :disabled="mcpBusy===s.name" @click="toggleMcp(s)"><Spinner v-if="mcpBusy===s.name" size="xs" class="mr-1" />{{ s.disabled ? 'Enable' : 'Disable' }}</button>
                <button v-if="!s.builtin" type="button" class="act-danger" :disabled="mcpBusy===s.name" @click="removeMcp(s.name)"><AppIcon glyph="🗑" /></button>
              </li>
            </ul>
            <div class="mt-3 rounded-xl border border-white/10 bg-white/[0.03] p-3">
              <div class="mb-2 text-[11px] uppercase tracking-wide text-slate-500">Add a server</div>
              <div class="flex flex-wrap items-end gap-2">
                <input v-model="newMcp.name" type="text" placeholder="name" class="field-input w-32" />
                <input v-model="newMcp.command" type="text" placeholder="command (e.g. npx)" class="field-input w-40" :disabled="!!newMcp.url" />
                <input v-model="newMcp.args" type="text" placeholder="args (space-separated)" class="field-input min-w-0 flex-1" :disabled="!!newMcp.url" />
                <input v-model="newMcp.url" type="text" placeholder="…or http URL" class="field-input w-44" />
                <button type="button" :disabled="!newMcp.name.trim() || (!newMcp.command.trim() && !newMcp.url.trim()) || mcpBusy==='add'" class="shrink-0 rounded-lg bg-brand-gradient px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40" @click="addMcp"><Spinner v-if="mcpBusy==='add'" size="xs" class="mr-1" />Add</button>
              </div>
            </div>
          </div>
        </div>

        <!-- Updates — toggle copy from the manifest; changelog/status stays bespoke -->
        <div v-show="tab === 'updates'" class="glass p-5">
          <h3 class="mb-1 text-sm font-semibold text-slate-200">Updates</h3>
          <p class="mb-4 text-[12px] text-slate-500">{{ section('updates').desc }}</p>
          <template v-if="upd">
            <!-- release channel -->
            <div class="mb-3 flex items-center justify-between gap-3">
              <div>
                <span class="text-sm text-slate-200">Release channel</span>
                <span class="block text-[12px] text-slate-500">Stable pins to the newest release tag; edge tracks the latest commit.</span>
              </div>
              <div class="flex shrink-0 gap-1 rounded-lg border border-white/10 bg-white/[0.03] p-0.5">
                <button v-for="ch in ['stable','edge']" :key="ch" type="button" :disabled="busy === 'upd-channel'"
                  class="rounded-md px-3 py-1 text-xs font-medium transition-colors"
                  :class="updChannel === ch ? 'bg-brand-violet/25 text-violet-200' : 'text-slate-400 hover:text-slate-200'"
                  @click="setChannel(ch)">{{ ch }}</button>
              </div>
            </div>
            <div class="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-white/5 bg-black/20 p-3">
              <div class="min-w-0">
                <div class="text-[11px] uppercase tracking-wide text-slate-500">Version <span class="normal-case text-slate-600">· {{ upd.channel }}</span></div>
                <div class="font-mono text-sm text-slate-200">v{{ upd.version || '?' }} <span class="text-slate-500">({{ upd.head || '—' }})</span>
                  <span v-if="!upd.available" class="ml-1 text-[11px] text-emerald-400"><AppIcon glyph="✓" /> up to date</span>
                  <span v-else class="ml-1 text-[11px] text-amber-400">→ {{ upd.behind }} behind{{ upd.latest_version ? ' · v' + upd.latest_version : '' }} ({{ upd.remote }})</span>
                </div>
              </div>
              <button
                type="button"
                :disabled="busy === 'upd-run' || !upd.available"
                class="ml-auto rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-40"
                :class="upd.available ? 'border-amber-400/30 bg-amber-400/10 text-amber-300 hover:bg-amber-400/20' : 'border-white/10 bg-white/5 text-slate-500'"
                @click="runUpdate"
              ><Spinner v-if="busy === 'upd-run'" size="xs" class="mr-1" />{{ busy === 'upd-run' ? 'starting…' : (upd.available ? 'Update now' : 'Latest') }}<AppIcon v-if="busy !== 'upd-run' && busy !== 'update'" glyph="↑" class="ml-1" /></button>
            </div>
            <div v-if="upd.available && upd.changelog?.length" class="mb-4 max-h-40 overflow-y-auto rounded-lg border border-white/5 bg-black/20 p-3">
              <div class="mb-1 text-[11px] uppercase tracking-wide text-slate-500">Incoming ({{ upd.behind }})</div>
              <div v-for="(c, i) in upd.changelog" :key="i" class="truncate font-mono text-[11px] text-slate-400">{{ c }}</div>
            </div>
            <label class="flex cursor-pointer items-center justify-between gap-3">
              <span>
                <span class="text-sm text-slate-200">{{ field('updates','auto').label }}</span>
                <span class="block text-[12px] text-slate-500">{{ field('updates','auto').desc }}</span>
              </span>
              <button type="button" :disabled="busy === 'upd-auto'" class="relative h-6 w-11 shrink-0 rounded-full transition-colors" :class="updAuto ? 'bg-brand-violet' : 'bg-white/15'" @click="toggleUpdAuto">
                <span class="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all" :class="updAuto ? 'left-[22px]' : 'left-0.5'"></span>
              </button>
            </label>
          </template>
          <p v-else class="py-3 text-center text-sm text-slate-500">loading…</p>
        </div>

        <!-- Voice — ack toggle + TTS voice/model + STT model, all sourced from the manifest -->
        <div v-show="tab === 'voice'" class="glass p-5">
          <h3 class="mb-1 text-sm font-semibold text-slate-200">Voice</h3>
          <p class="mb-5 text-[12px] text-slate-500">{{ section('voice').desc }}</p>

          <VoiceEngines @changed="loadVoiceCfg" />

          <template v-if="vcfg">
            <div class="space-y-7">
              <!-- ══ Read-aloud (text-to-speech) ══════════════════════════════════ -->
              <section class="space-y-4">
                <h4 class="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-slate-300">
                  <AppIcon glyph="🔊" class="text-sm text-brand-violet" /> Read-aloud
                  <span class="font-medium normal-case tracking-normal text-slate-500">· how replies are spoken</span>
                </h4>

                <!-- spoken ack -->
                <label class="flex cursor-pointer items-center justify-between gap-3">
                  <span>
                    <span class="text-sm text-slate-200">{{ field('voice','ack').label }}</span>
                    <span class="block text-[12px] text-slate-500">{{ field('voice','ack').desc }}</span>
                  </span>
                  <button type="button" class="relative h-6 w-11 shrink-0 rounded-full transition-colors" :class="ackOn ? 'bg-brand-violet' : 'bg-white/15'" @click="toggleAck">
                    <span class="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all" :class="ackOn ? 'left-[22px]' : 'left-0.5'"></span>
                  </button>
                </label>

                <!-- TTS provider — now chosen in the Voice engines panel above (synthesize role) -->
                <div v-if="false">
                  <div class="mb-1.5 text-[11px] uppercase tracking-wide text-slate-500">{{ field('voice','tts_provider').label }}
                    <span class="normal-case text-slate-600">— {{ field('voice','tts_provider').desc }}</span>
                  </div>
                  <div class="flex flex-wrap gap-2">
                    <button v-for="c in ttsProviderChoices" :key="c.id" type="button" :disabled="busy === 'voicecfg'"
                      class="rounded-lg border px-3 py-2 text-left text-xs transition-colors"
                      :class="vcfg.tts?.provider === c.id ? 'border-brand-violet/60 bg-brand-violet/15 text-violet-200' : 'border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/10'"
                      @click="setVoiceCfg({ tts: { provider: c.id } })">
                      <div class="font-semibold">{{ c.label }}</div>
                      <div class="text-[10px] text-slate-500">{{ c.hint }}</div>
                    </button>
                  </div>
                </div>

                <!-- TTS voice -->
                <div>
                  <div class="mb-1.5 text-[11px] uppercase tracking-wide text-slate-500">{{ field('voice','tts_voice').label }}
                    <span class="normal-case text-slate-600">— {{ field('voice','tts_voice').desc }}</span>
                  </div>
                  <div v-if="voicesLoading" class="mb-2 flex items-center gap-2 text-[11px] text-slate-500"><Spinner size="xs" />Loading {{ vcfg.tts?.provider }} voices…</div>
                  <div class="flex flex-wrap gap-2">
                    <button v-for="c in ttsVoiceChoices" :key="c.id" type="button" :disabled="busy === 'voicecfg'"
                      class="rounded-lg border px-3 py-2 text-left text-xs transition-colors"
                      :class="vcfg.tts?.voice === c.id ? 'border-brand-violet/60 bg-brand-violet/15 text-violet-200' : 'border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/10'"
                      @click="setVoiceCfg({ tts: { voice: c.id } })">
                      <div class="font-semibold">{{ c.label }}</div>
                      <div class="text-[10px] text-slate-500">{{ c.hint }}</div>
                    </button>
                  </div>
                  <div v-if="field('voice','tts_voice').allowCustom" class="mt-2 flex items-center gap-2">
                    <input v-model="customVoice" type="text" placeholder="or another voice id"
                      class="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 font-mono text-xs text-slate-100 outline-none focus:border-brand-violet/60"
                      @keydown.enter.prevent="setCustomVoice" />
                    <button type="button" :disabled="!customVoice.trim() || busy === 'voicecfg'" class="shrink-0 rounded-lg bg-brand-gradient px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40" @click="setCustomVoice"><Spinner v-if="busy === 'voicecfg'" size="xs" class="mr-1" />Set</button>
                  </div>
                </div>

                <!-- TTS model -->
                <div>
                  <div class="mb-1.5 text-[11px] uppercase tracking-wide text-slate-500">{{ field('voice','tts_model').label }}
                    <span class="normal-case text-slate-600">— {{ field('voice','tts_model').desc }}</span>
                  </div>
                  <div class="flex flex-wrap gap-2">
                    <button v-for="c in ttsModelChoices" :key="c.id" type="button" :disabled="busy === 'voicecfg'"
                      class="rounded-lg border px-3 py-2 text-left text-xs transition-colors"
                      :class="vcfg.tts?.model === c.id ? 'border-brand-violet/60 bg-brand-violet/15 text-violet-200' : 'border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/10'"
                      @click="setVoiceCfg({ tts: { model: c.id } })">
                      <div class="font-semibold">{{ c.label }}</div>
                      <div class="text-[10px] text-slate-500">{{ c.hint }}</div>
                    </button>
                  </div>
                  <div v-if="field('voice','tts_model').allowCustom" class="mt-2 flex items-center gap-2">
                    <input v-model="customTtsModel" type="text" placeholder="or another model id (e.g. eleven_turbo_v2_5)"
                      class="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 font-mono text-xs text-slate-100 outline-none focus:border-brand-violet/60"
                      @keydown.enter.prevent="setCustomTtsModel" />
                    <button type="button" :disabled="!customTtsModel.trim() || busy === 'voicecfg'" class="shrink-0 rounded-lg bg-brand-gradient px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40" @click="setCustomTtsModel"><Spinner v-if="busy === 'voicecfg'" size="xs" class="mr-1" />Set</button>
                  </div>
                </div>
              </section>

              <!-- ══ Voice input (speech-to-text) ══════════════════════════════════ -->
              <section class="space-y-4 border-t border-white/10 pt-6">
                <h4 class="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-slate-300">
                  <AppIcon glyph="🎙" class="text-sm text-brand-violet" /> Voice input
                  <span class="font-medium normal-case tracking-normal text-slate-500">· how your speech is transcribed</span>
                </h4>

                <!-- STT model — now chosen in the Voice engines panel above (transcribe role) -->
                <div v-if="false">
                  <div class="mb-1.5 text-[11px] uppercase tracking-wide text-slate-500">{{ field('voice','stt_model').label }}
                    <span class="normal-case text-slate-600">— {{ field('voice','stt_model').desc }}</span>
                  </div>
                  <div class="flex flex-wrap gap-2">
                    <button v-for="c in sttModelChoices" :key="c.id" type="button" :disabled="busy === 'voicecfg'"
                      class="rounded-lg border px-3 py-2 text-left text-xs transition-colors"
                      :class="vcfg.stt?.model === c.id ? 'border-brand-violet/60 bg-brand-violet/15 text-violet-200' : 'border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/10'"
                      @click="setVoiceCfg({ stt: { model: c.id } })">
                      <div class="font-semibold">{{ c.label }}</div>
                      <div class="text-[10px] text-slate-500">{{ c.hint }}</div>
                    </button>
                  </div>
                </div>

                <!-- End-of-speech pause (VAD endpoint) -->
                <div v-if="sttEndpointChoices.length">
                  <div class="mb-1.5 text-[11px] uppercase tracking-wide text-slate-500">{{ field('voice','stt_endpoint').label }}
                    <span class="normal-case text-slate-600">— {{ field('voice','stt_endpoint').desc }}</span>
                  </div>
                  <div class="flex flex-wrap gap-2">
                    <button v-for="c in sttEndpointChoices" :key="c.id" type="button" :disabled="busy === 'voicecfg'"
                      class="rounded-lg border px-3 py-2 text-left text-xs transition-colors"
                      :class="String(vcfg.stt?.vad_endpoint_ms) === c.id ? 'border-brand-violet/60 bg-brand-violet/15 text-violet-200' : 'border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/10'"
                      @click="setVoiceCfg({ stt: { vad_endpoint_ms: Number(c.id) } })">
                      <div class="font-semibold">{{ c.label }}</div>
                      <div class="text-[10px] text-slate-500">{{ c.hint }}</div>
                    </button>
                  </div>
                </div>

                <!-- Mic sensitivity (VAD) -->
                <div v-if="sttSensChoices.length">
                  <div class="mb-1.5 text-[11px] uppercase tracking-wide text-slate-500">{{ field('voice','stt_sensitivity').label }}
                    <span class="normal-case text-slate-600">— {{ field('voice','stt_sensitivity').desc }}</span>
                  </div>
                  <div class="flex flex-wrap gap-2">
                    <button v-for="c in sttSensChoices" :key="c.id" type="button" :disabled="busy === 'voicecfg'"
                      class="rounded-lg border px-3 py-2 text-left text-xs transition-colors"
                      :class="String(vcfg.stt?.vad_sensitivity) === c.id ? 'border-brand-violet/60 bg-brand-violet/15 text-violet-200' : 'border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/10'"
                      @click="setVoiceCfg({ stt: { vad_sensitivity: Number(c.id) } })">
                      <div class="font-semibold">{{ c.label }}</div>
                      <div class="text-[10px] text-slate-500">{{ c.hint }}</div>
                    </button>
                  </div>
                </div>

                <!-- Wake word — a labelled sub-group inside Voice input -->
                <div class="rounded-xl border border-white/10 bg-white/[0.02] p-3.5">
                  <label class="flex cursor-pointer items-center justify-between gap-3">
                    <span>
                      <span class="text-sm text-slate-200">{{ field('voice','wake_enabled').label || 'Wake word' }}</span>
                      <span class="block text-[12px] text-slate-500">{{ field('voice','wake_enabled').desc }}</span>
                    </span>
                    <input type="checkbox" :disabled="busy === 'voicecfg'" :checked="!!vcfg.stt?.wake_enabled"
                      @change="setVoiceCfg({ stt: { wake_enabled: $event.target.checked } })" />
                  </label>
                  <div class="mt-3">
                    <div class="mb-1.5 text-[11px] uppercase tracking-wide text-slate-500">{{ field('voice','wake_phrase').label || 'Wake phrase' }}
                      <span class="normal-case text-slate-600">— {{ field('voice','wake_phrase').desc }}</span>
                    </div>
                    <div class="flex items-center gap-2">
                      <input v-model="wakePhrase" type="text" placeholder="hey Eve"
                        class="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-slate-200" />
                      <button type="button" :disabled="!wakePhrase.trim() || busy === 'voicecfg'" @click="setVoiceCfg({ stt: { wake_phrase: wakePhrase.trim() } })"
                        class="shrink-0 rounded-lg bg-brand-gradient px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">
                        <Spinner v-if="busy === 'voicecfg'" size="xs" class="mr-1" />Set</button>
                    </div>
                  </div>
                  <div class="mt-3" v-if="field('voice','stop_phrases').id">
                    <div class="mb-1.5 text-[11px] uppercase tracking-wide text-slate-500">{{ field('voice','stop_phrases').label || 'Stop phrases' }}
                      <span class="normal-case text-slate-600">— {{ field('voice','stop_phrases').desc }}</span>
                    </div>
                    <div class="flex items-center gap-2">
                      <input v-model="stopPhrasesInput" type="text" placeholder="that's all, I'm done, thank you"
                        class="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-slate-200" />
                      <button type="button" :disabled="busy === 'voicecfg'" @click="setVoiceCfg({ stt: { stop_phrases: stopPhrasesInput.trim() } })"
                        class="shrink-0 rounded-lg bg-brand-gradient px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">
                        <Spinner v-if="busy === 'voicecfg'" size="xs" class="mr-1" />Set</button>
                    </div>
                  </div>
                </div>
              </section>

              <!-- ══ Test the pipeline ══════════════════════════════════════════════ -->
              <section class="space-y-3 border-t border-white/10 pt-6">
                <h4 class="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-slate-300">
                  <AppIcon glyph="▶" class="text-sm text-brand-violet" /> Test the pipeline
                  <span class="font-medium normal-case tracking-normal text-slate-500">· hear a reply with the settings above</span>
                </h4>
                <textarea v-model="vtPrompt" rows="2" placeholder="Ask something…"
                  class="w-full resize-y rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-brand-violet/60"
                  @keydown.enter.exact.prevent="vtSpeak"></textarea>
                <div class="flex items-center gap-2">
                  <button type="button" :disabled="vtBusy || !vtPrompt.trim()" @click="vtSpeak"
                    class="rounded-lg bg-brand-gradient px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-brand-violet/30 disabled:opacity-40">
                    <AppIcon glyph="▶" /> Speak</button>
                  <button v-if="vtBusy" type="button" @click="vtStop"
                    class="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm font-semibold text-rose-300 hover:bg-rose-500/20">
                    <AppIcon glyph="⏹" /> Stop</button>
                  <span class="ml-auto text-xs text-slate-500">{{ vtStatus }}</span>
                </div>
                <div v-if="vtRows.length" class="max-h-[32vh] space-y-2 overflow-y-auto rounded-lg border border-white/10 bg-white/[0.02] p-3">
                  <div v-for="(r, i) in vtRows" :key="i"
                    class="whitespace-pre-wrap break-words rounded-2xl rounded-bl-sm border px-3 py-2 text-[13px] leading-snug"
                    :class="r.kind === 'ack' ? 'border-white/10 bg-white/[0.03] italic text-slate-400' : 'border-white/10 bg-white/[0.05] text-slate-100'"
                  >{{ r.text }}</div>
                </div>
              </section>
            </div>
          </template>
        </div>

        <!-- Notifications — GUI-only (browser Notification API); the ✦ Notifications page shows history -->
        <div v-show="tab === 'notifications'" class="glass p-5">
          <h3 class="mb-1 text-sm font-semibold text-slate-200">Notifications</h3>
          <p class="mb-4 text-[12px] text-slate-500">Desktop/mobile alerts from this browser when a session turn completes — so you know a reply is ready while you're on another tab.</p>
          <label class="flex cursor-pointer items-center justify-between gap-3">
            <span>
              <span class="text-sm text-slate-200">Notify me when a turn completes</span>
              <span class="block text-[12px] text-slate-500">
                <template v-if="!notifySupported">This browser doesn't support notifications.</template>
                <template v-else-if="notifyPerm === 'denied'">Blocked in the browser — allow notifications for this site to enable.</template>
                <template v-else>Fires a notification for each completed reply (skips the web chats you're already viewing).</template>
              </span>
            </span>
            <button type="button" class="relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-40"
              :class="notifyOn ? 'bg-brand-violet' : 'bg-white/15'"
              :disabled="!notifySupported || notifyPerm === 'denied'" @click="toggleNotify">
              <span class="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all" :class="notifyOn ? 'left-[22px]' : 'left-0.5'"></span>
            </button>
          </label>
          <RouterLink to="/notifications" class="mt-4 inline-flex items-center gap-1.5 text-[12px] text-brand-violet hover:underline">
            <AppIcon glyph="✦" /> View notification history
          </RouterLink>

          <!-- asmltr notify delivery ladder (moved here from Schedules) — how a prompt job reaches you -->
          <div class="mt-6 border-t border-white/10 pt-5">
            <h3 class="mb-1 text-sm font-semibold text-slate-200"><AppIcon glyph="🔔" /> Notify delivery</h3>
            <p class="mb-4 text-[12px] text-slate-500">
              How <span class="font-mono">asmltr notify</span> reaches you. Ladder:
              <b>android read-aloud</b> (a connected assistant device speaks it) → push → text fallback.
              Quiet hours suppress the spoken step (text still goes).
            </p>
            <div class="flex flex-col gap-4">
              <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label class="mb-1 block text-xs font-medium text-slate-300">Quiet hours start</label>
                  <input v-model="ncfg.quiet_start" type="number" min="0" max="23" class="w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-slate-200" />
                </div>
                <div>
                  <label class="mb-1 block text-xs font-medium text-slate-300">Quiet hours end</label>
                  <input v-model="ncfg.quiet_end" type="number" min="0" max="23" class="w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-slate-200" />
                </div>
                <label class="flex items-end gap-2 pb-2 text-sm text-slate-300">
                  <input v-model="ncfg.require_headphones" type="checkbox" class="h-4 w-4" /> Only read aloud over headphones
                </label>
              </div>
              <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label class="mb-1 block text-xs font-medium text-slate-300">Text fallback — channel</label>
                  <input v-model="ncfg.fb_channel" type="text" class="w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 font-mono text-sm text-slate-200" placeholder="telegram / discord / email (blank = off)" />
                </div>
                <div>
                  <label class="mb-1 block text-xs font-medium text-slate-300">Text fallback — target</label>
                  <input v-model="ncfg.fb_target" type="text" class="w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 font-mono text-sm text-slate-200" placeholder="chat id / channel / address" />
                </div>
              </div>
              <div class="flex items-center gap-2">
                <button type="button" class="rounded-lg bg-brand-gradient px-4 py-2 text-sm font-semibold text-white" @click="saveNotify">Save</button>
                <button type="button" class="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-300 hover:bg-white/10" @click="testNotify"><AppIcon glyph="▶" /> Send test</button>
                <span class="text-xs text-slate-400">{{ notifyMsg }}</span>
              </div>
            </div>
          </div>
        </div>

        <div v-show="tab === 'security'" class="glass p-5">
          <h3 class="mb-1 text-sm font-semibold text-slate-200">Security</h3>
          <p class="mb-4 text-[12px] text-slate-500">
            Built-in auth <span :class="authStatus.enabled ? 'text-emerald-300' : 'text-slate-400'">{{ authStatus.enabled ? 'is enforced' : 'is off' }}</span>.
            Signed in as <span class="font-mono text-slate-300">{{ authStatus.user || '—' }}</span>.
          </p>

          <!-- 2FA -->
          <div class="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <div class="mb-2 flex items-center justify-between gap-3">
              <span class="text-sm font-medium text-slate-200">Two-factor authentication (TOTP)</span>
              <span class="pill border text-[11px]" :class="authStatus.totp ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300' : 'border-white/10 bg-white/5 text-slate-400'">
                {{ authStatus.totp ? '● enabled' : '○ disabled' }}
              </span>
            </div>

            <!-- freshly generated recovery codes (show once) -->
            <div v-if="recoveryCodes" class="mb-3 rounded-lg border border-amber-400/30 bg-amber-400/10 p-3">
              <p class="mb-2 text-[12px] font-semibold text-amber-200">Save these recovery codes — each works once, shown only now:</p>
              <div class="grid grid-cols-2 gap-1 font-mono text-[12px] text-amber-100">
                <span v-for="c in recoveryCodes" :key="c">{{ c }}</span>
              </div>
            </div>

            <!-- enabled → offer disable -->
            <template v-if="authStatus.totp && !enroll">
              <div class="flex flex-wrap items-end gap-2">
                <label class="flex flex-col gap-1">
                  <span class="text-[11px] text-slate-500">Password (to disable)</span>
                  <input v-model="disablePass" type="password" autocomplete="off" class="field-input w-56" />
                </label>
                <button type="button" :disabled="secBusy" class="act-danger" @click="disable2fa"><Spinner v-if="secBusy" size="xs" class="mr-1" /><AppIcon v-else glyph="🚫" /> Disable 2FA</button>
              </div>
            </template>

            <!-- disabled → enroll -->
            <template v-else-if="!authStatus.totp">
              <div v-if="!enroll">
                <button type="button" :disabled="secBusy" class="rounded-xl bg-brand-gradient px-3 py-1.5 text-sm font-semibold text-white shadow-lg shadow-brand-violet/30 disabled:opacity-40" @click="beginEnroll">
                  <Spinner v-if="secBusy" size="xs" class="mr-1" />{{ secBusy ? 'Generating…' : 'Enable 2FA' }}
                </button>
              </div>
              <div v-else class="flex flex-col gap-3 sm:flex-row sm:items-start">
                <img :src="enroll.qr" alt="TOTP QR" class="h-40 w-40 shrink-0 rounded-lg bg-white p-1" />
                <div class="min-w-0 flex-1">
                  <p class="text-[12px] text-slate-400">Scan with your authenticator, or enter this key manually:</p>
                  <code class="mt-1 block break-all rounded bg-black/30 px-2 py-1 font-mono text-[11px] text-slate-300">{{ enroll.secret }}</code>
                  <p class="mt-3 text-[12px] text-slate-400">Then enter the current 6-digit code to confirm:</p>
                  <div class="mt-1 flex items-center gap-2">
                    <input v-model="enrollCode" type="text" inputmode="numeric" maxlength="6" placeholder="000000" class="field-input w-28 text-center tracking-widest" />
                    <button type="button" :disabled="secBusy || enrollCode.length < 6" class="rounded-xl bg-brand-gradient px-3 py-2 text-sm font-semibold text-white shadow-lg shadow-brand-violet/30 disabled:opacity-40" @click="confirmEnroll"><Spinner v-if="secBusy" size="xs" class="mr-1" />Confirm</button>
                    <button type="button" class="act" @click="enroll = null">Cancel</button>
                  </div>
                </div>
              </div>
            </template>

            <p v-if="secError" class="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{{ secError }}</p>
          </div>

          <!-- passkeys -->
          <div class="mt-4 rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <div class="mb-2 flex items-center justify-between gap-3">
              <div>
                <span class="text-sm font-medium text-slate-200">Passkeys</span>
                <span class="block text-[12px] text-slate-500">Passwordless, phishing-resistant sign-in (Touch ID, Windows Hello, a security key).</span>
              </div>
              <button type="button" :disabled="pkBusy" class="rounded-xl bg-brand-gradient px-3 py-1.5 text-sm font-semibold text-white shadow-lg shadow-brand-violet/30 disabled:opacity-40" @click="addPasskey">
                <Spinner v-if="pkBusy" size="xs" class="mr-1" />{{ pkBusy ? 'Waiting…' : '＋ Add a passkey' }}
              </button>
            </div>
            <ul v-if="passkeys.length" class="divide-y divide-white/5">
              <li v-for="p in passkeys" :key="p.id" class="flex items-center gap-2 py-2 text-sm">
                <AppIcon glyph="🔑" class="text-slate-500" />
                <span class="min-w-0 flex-1 truncate text-slate-200">{{ p.name || 'passkey' }}</span>
                <span class="font-mono text-[10px] text-slate-600">{{ p.last_used ? 'used ' + new Date(p.last_used).toLocaleDateString() : 'never used' }}</span>
                <button type="button" class="act-danger" :disabled="rowBusy['passkey:'+p.id]" @click="removePasskey(p.id)"><Spinner v-if="rowBusy['passkey:'+p.id]" size="xs" /><AppIcon v-else glyph="🗑" /></button>
              </li>
            </ul>
            <p v-else class="text-[12px] text-slate-500">No passkeys registered yet.</p>
          </div>

          <!-- connected external accounts (OIDC client) — only if a provider is configured on this install -->
          <div v-if="extProviders.length" class="mt-4 rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <div class="mb-1 text-sm font-medium text-slate-200">Connected accounts</div>
            <p class="mb-3 text-[12px] text-slate-500">Link an external account to sign in with it (in addition to your password).</p>
            <ul class="divide-y divide-white/5">
              <li v-for="p in extProviders" :key="p.id" class="flex items-center gap-2 py-2 text-sm">
                <AppIcon :glyph="extProviderIcon[p.id] || '🌐'" class="text-slate-500" />
                <span class="min-w-0 flex-1 truncate text-slate-200">{{ p.label }}</span>
                <template v-if="isLinked(p.id)">
                  <span class="pill border border-emerald-400/30 bg-emerald-400/10 text-[11px] text-emerald-300">connected</span>
                  <button type="button" class="act-danger" :disabled="rowBusy['ext:'+p.id]" @click="disconnectExternal(p.id)"><Spinner v-if="rowBusy['ext:'+p.id]" size="xs" class="mr-1" />Disconnect</button>
                </template>
                <button v-else type="button" class="act" :disabled="rowBusy['ext:'+p.id]" @click="connectExternal(p.id)"><Spinner v-if="rowBusy['ext:'+p.id]" size="xs" class="mr-1" />Connect</button>
              </li>
            </ul>
          </div>

          <!-- OIDC provider — register apps that SSO against asmltr -->
          <div v-if="oidcStatus.enabled" class="mt-4 rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <div class="mb-1 flex items-center justify-between gap-3">
              <span class="text-sm font-medium text-slate-200">OIDC provider — apps</span>
              <span class="pill border border-emerald-400/30 bg-emerald-400/10 text-[11px] text-emerald-300">● issuing</span>
            </div>
            <p class="mb-3 text-[12px] text-slate-500">
              Other apps can SSO against asmltr. Issuer: <code class="font-mono text-slate-400">{{ oidcStatus.issuer }}</code>
              (discovery at <span class="font-mono">/.well-known/openid-configuration</span>).
            </p>

            <div v-if="newClientSecret" class="mb-3 rounded-lg border border-amber-400/30 bg-amber-400/10 p-3 text-[12px]">
              <p class="mb-1 font-semibold text-amber-200">Client created — copy the secret now (shown only once):</p>
              <p class="font-mono text-amber-100">client_id: {{ newClientSecret.client_id }}</p>
              <p class="font-mono break-all text-amber-100">client_secret: {{ newClientSecret.client_secret }}</p>
            </div>

            <ul v-if="oidcClients.length" class="mb-3 divide-y divide-white/5">
              <li v-for="c in oidcClients" :key="c.client_id" class="flex items-center gap-2 py-2 text-sm">
                <AppIcon glyph="🧩" class="text-slate-500" />
                <span class="min-w-0 flex-1 truncate">
                  <span class="text-slate-200">{{ c.client_name }}</span>
                  <span class="block truncate font-mono text-[10px] text-slate-500">{{ c.client_id }} · {{ (c.redirect_uris || []).join(', ') }}</span>
                </span>
                <button type="button" class="act-danger" :disabled="rowBusy['oidc:'+c.client_id]" @click="removeOidcClient(c.client_id)"><Spinner v-if="rowBusy['oidc:'+c.client_id]" size="xs" /><AppIcon v-else glyph="🗑" /></button>
              </li>
            </ul>

            <form class="flex flex-wrap items-end gap-2" @submit.prevent="addOidcClient">
              <label class="flex flex-col gap-1">
                <span class="text-[11px] text-slate-500">App name</span>
                <input v-model="newClient.client_name" type="text" class="field-input w-44" placeholder="My App" />
              </label>
              <label class="flex flex-1 flex-col gap-1">
                <span class="text-[11px] text-slate-500">Redirect URIs (space/comma separated)</span>
                <input v-model="newClient.redirect_uris" type="text" class="field-input w-full" placeholder="https://app.example.com/callback" />
              </label>
              <button type="submit" :disabled="!newClient.redirect_uris || oidcBusy" class="rounded-xl bg-brand-gradient px-3 py-2 text-sm font-semibold text-white shadow-lg shadow-brand-violet/30 disabled:opacity-40"><Spinner v-if="oidcBusy" size="xs" class="mr-1" />{{ oidcBusy ? 'Registering…' : 'Register app' }}</button>
            </form>
            <p class="mt-2 text-[11px] text-slate-600">New clients take effect on the next core restart.</p>
          </div>
        </div>

        <div v-show="tab === 'backups'" class="glass p-5">
          <h3 class="mb-1 text-sm font-semibold text-slate-200">Backups</h3>
          <p class="mb-4 text-[12px] text-slate-500">
            Encrypted, restorable snapshots — the SQLite DBs (consistent), config, identity, and the silos, in one
            passphrase-encrypted archive that's <em>independent of the vault</em> (so a vault loss is itself recoverable).
            One is taken automatically before each self-update.
          </p>

          <form class="mb-4 flex flex-wrap items-end gap-2" @submit.prevent="createBackup">
            <label class="flex flex-col gap-1">
              <span class="text-[11px] text-slate-500">Label</span>
              <input v-model="backupLabel" type="text" class="field-input w-32" placeholder="manual" />
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-[11px] text-slate-500">Destination</span>
              <select v-model="backupDest" class="field-input w-44">
                <option value="local">local ({{ backupDir ? '~/.asmltr/backups' : 'default' }})</option>
                <option v-for="it in storageIntegrations" :key="it.id" :value="it.id">{{ it.name }} ({{ it.type }})</option>
              </select>
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-[11px] text-slate-500">Passphrase <span class="text-slate-600">(blank → server default)</span></span>
              <input v-model="backupPass" type="password" class="field-input w-56" placeholder="backup passphrase" autocomplete="off" />
            </label>
            <button type="submit" :disabled="backupBusy"
              class="rounded-xl bg-brand-gradient px-3 py-2 text-sm font-semibold text-white shadow-lg shadow-brand-violet/30 disabled:opacity-40">
              <Spinner v-if="backupBusy" size="xs" class="mr-1" />{{ backupBusy ? 'Creating…' : 'Create backup' }}
            </button>
            <button type="button" :disabled="rowBusy['backup-refresh']" class="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-300 hover:bg-white/10 disabled:opacity-40" @click="loadBackups">
              <Spinner v-if="rowBusy['backup-refresh']" size="xs" class="mr-1" /><AppIcon v-else glyph="↻" /> Refresh
            </button>
          </form>

          <p v-if="backupError" class="mb-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{{ backupError }}</p>

          <!-- scheduled backups + retention -->
          <div class="mb-4 rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <label class="mb-3 flex cursor-pointer items-center justify-between gap-3">
              <span>
                <span class="text-sm font-medium text-slate-200">Scheduled backups</span>
                <span class="block text-[12px] text-slate-500">Automatic snapshots on a timer, with retention. Needs a passphrase configured on the server (<span class="font-mono">ASMLTR_BACKUP_PASSPHRASE</span>).</span>
              </span>
              <button type="button" class="relative h-6 w-11 shrink-0 rounded-full transition-colors"
                :class="schedule.enabled ? 'bg-brand-violet' : 'bg-white/15'" @click="schedule.enabled = !schedule.enabled">
                <span class="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all" :class="schedule.enabled ? 'left-[22px]' : 'left-0.5'"></span>
              </button>
            </label>
            <div class="grid grid-cols-2 gap-3 sm:grid-cols-4" :class="schedule.enabled ? '' : 'opacity-50'">
              <label class="flex flex-col gap-1">
                <span class="text-[11px] text-slate-500">Every (hours)</span>
                <input v-model="schedule.every_hours" type="number" min="1" class="field-input" :disabled="!schedule.enabled" />
              </label>
              <label class="flex flex-col gap-1">
                <span class="text-[11px] text-slate-500">Destination</span>
                <select v-model="schedule.destination" class="field-input" :disabled="!schedule.enabled">
                  <option value="local">local</option>
                  <option v-for="it in storageIntegrations" :key="it.id" :value="it.id">{{ it.name }}</option>
                </select>
              </label>
              <label class="flex flex-col gap-1">
                <span class="text-[11px] text-slate-500">Max stored</span>
                <input v-model="schedule.max_count" type="number" min="0" class="field-input" :disabled="!schedule.enabled" />
              </label>
              <label class="flex flex-col gap-1">
                <span class="text-[11px] text-slate-500">Max age (days)</span>
                <input v-model="schedule.max_age_days" type="number" min="0" class="field-input" :disabled="!schedule.enabled" />
              </label>
            </div>
            <div class="mt-3 flex items-center gap-3">
              <button type="button" :disabled="scheduleBusy" class="rounded-xl bg-brand-gradient px-3 py-1.5 text-sm font-semibold text-white shadow-lg shadow-brand-violet/30 disabled:opacity-40" @click="saveSchedule">
                <Spinner v-if="scheduleBusy" size="xs" class="mr-1" />{{ scheduleBusy ? 'Saving…' : 'Save schedule' }}
              </button>
              <span v-if="schedule.last_run" class="text-[11px] text-slate-500">Last run: {{ new Date(schedule.last_run).toLocaleString() }}</span>
              <span class="text-[11px] text-slate-600">0 = unlimited</span>
            </div>
          </div>

          <div class="mb-2 flex items-center justify-between gap-2">
            <span class="text-[11px] uppercase tracking-wide text-slate-500">Snapshots</span>
            <label class="act cursor-pointer">
              <Spinner v-if="importBusy" size="xs" class="mr-1" /><span v-else>＋</span> Import…
              <input type="file" accept=".asmltrbk" class="hidden" :disabled="importBusy" @change="importBackup" />
            </label>
          </div>
          <ul class="divide-y divide-white/5 overflow-hidden rounded-xl border border-white/5">
            <li v-for="b in backups" :key="b.name" class="flex items-center gap-2 px-3 py-2 text-sm">
              <AppIcon glyph="🗄" class="text-slate-500" />
              <span class="min-w-0 flex-1 truncate font-mono text-[12px] text-slate-300" :title="b.name">{{ b.name }}</span>
              <span class="font-mono text-[11px] text-slate-600">{{ fmtMB(b.bytes) }}</span>
              <button type="button" class="act" @click="openRestore(b)">Restore…</button>
            </li>
            <li v-if="!backups.length" class="px-3 py-6 text-center text-sm text-slate-500">No backups yet.</li>
          </ul>
          <p class="mt-3 text-[12px] text-slate-500">
            Stored in <span class="font-mono text-slate-400">{{ backupDir }}</span>. Restore overwrites config +
            databases and restarts the core — it always previews first and asks you to confirm.
          </p>

          <!-- guarded restore panel: preview → type-to-confirm → detached runner + live log -->
          <div v-if="restoreTarget" class="mt-4 rounded-xl border border-amber-400/30 bg-amber-400/[0.06] p-4">
            <div class="mb-2 flex items-center justify-between gap-2">
              <span class="text-sm font-semibold text-amber-200">Restore <span class="font-mono text-[12px]">{{ restoreTarget.name }}</span></span>
              <button type="button" class="act" :disabled="restoreBusy==='running'" @click="closeRestore">Cancel</button>
            </div>
            <p class="mb-3 text-[12px] text-amber-200/80">This overwrites the live config, secrets and databases with the snapshot's contents (prior files are stashed under <span class="font-mono">pre-restore-*</span>), then restarts the core. Preview first, then type the name to confirm.</p>

            <div class="mb-3 flex flex-wrap items-end gap-2">
              <label class="flex flex-col gap-1">
                <span class="text-[11px] text-slate-400">Passphrase <span class="text-slate-600">(blank → server default)</span></span>
                <input v-model="restorePass" type="password" autocomplete="off" class="field-input w-56" placeholder="backup passphrase" />
              </label>
              <button type="button" class="act" :disabled="restoreBusy==='preview'" @click="doPreview"><Spinner v-if="restoreBusy==='preview'" size="xs" class="mr-1" />Preview</button>
            </div>

            <div v-if="restorePreview" class="mb-3 rounded-lg border border-white/10 bg-black/20 p-3 text-[12px]">
              <div class="mb-1 text-slate-300">
                <span class="font-semibold">{{ restorePreview.manifest.version }}</span> / {{ restorePreview.manifest.label }}
                · {{ new Date(restorePreview.manifest.created_at).toLocaleString() }}
                · host <span class="font-mono">{{ restorePreview.manifest.host }}</span>
              </div>
              <div class="text-slate-400">Would restore {{ (restorePreview.plan || []).length }} path(s):</div>
              <ul class="mt-1 max-h-40 space-y-0.5 overflow-auto font-mono text-[11px] text-slate-500">
                <li v-for="p in restorePreview.plan" :key="p" class="truncate">{{ p }}</li>
              </ul>
            </div>

            <div v-if="restorePreview && restoreBusy!=='running'" class="flex flex-wrap items-end gap-2">
              <label class="flex flex-1 flex-col gap-1">
                <span class="text-[11px] text-slate-400">Type <span class="font-mono text-slate-300">{{ restoreTarget.name }}</span> to confirm</span>
                <input v-model="restoreConfirm" type="text" class="field-input w-full" :placeholder="restoreTarget.name" />
              </label>
              <button type="button" class="act-danger" :disabled="restoreConfirm.trim() !== restoreTarget.name" @click="doRestore"><AppIcon glyph="⚠" class="mr-1" />Restore &amp; restart</button>
            </div>

            <div v-if="restoreLog" class="mt-3">
              <div class="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wide text-slate-500">Progress <Spinner v-if="restoreBusy==='running'" size="xs" class="text-slate-400" /></div>
              <pre class="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-white/10 bg-black/40 p-2 font-mono text-[11px] text-slate-400">{{ restoreLog }}</pre>
            </div>
          </div>
        </div>

        <p v-if="notice" class="mt-4 text-center text-[12px] text-slate-400">{{ notice }}</p>
      </template>
    </div>
  </div>
</template>

<style scoped>
.field-input {
  @apply rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-slate-100 outline-none transition-colors;
  @apply placeholder:text-slate-600 focus:border-brand-violet/60 focus:bg-white/[0.06];
}
.act {
  @apply shrink-0 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs font-medium text-slate-300 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50;
}
.act-danger {
  @apply shrink-0 rounded-lg border border-rose-500/20 bg-rose-500/5 px-2.5 py-1 text-xs font-medium text-rose-400/80 transition-colors hover:bg-rose-500/15 disabled:cursor-not-allowed disabled:opacity-50;
}
</style>
