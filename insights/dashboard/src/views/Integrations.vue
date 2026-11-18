<script setup>
// Integrations — third-party service links (storage). The connectors are the CHAT channels;
// these are the OUTBOUND storage/service targets (webdav / s3 / local). Credentials never live in
// the integration config — a *_ref field carries a VAULT KEY NAME; the secret lives in the vault
// under that name (see Vault.vue). This view: a grid of configured integrations (each with Test +
// Delete) and an add-integration modal (pick a type, then a per-type form with vault-key pickers).
import { onMounted, reactive, ref, computed } from 'vue'
import { integrations, vaultApi } from '@/services/api'
import PageHeader from '@/components/PageHeader.vue'
import ModalShell from '@/components/ModalShell.vue'

// ── list state ──────────────────────────────────────────────────────────────
const items = ref([])
const loading = ref(false)
const error = ref(null)
const testResult = reactive({}) // id -> { ok, text }
const busy = reactive({}) // id -> action string in flight

// type presentation (icon + label + accent), mirrors connectorTypeMeta styling
// icons chosen from the registered set (icons.js): webdav→globe (remote http store),
// s3→server (object store), local→folder-open. ('cloud'/'database' aren't registered.)
const TYPE_META = {
  webdav: { label: 'webdav', icon: ['fas', 'globe'], color: '#22D3EE' },
  s3: { label: 's3', icon: ['fas', 'server'], color: '#8B5CF6' },
  local: { label: 'local', icon: ['fas', 'folder-open'], color: '#34D399' },
  mail: { label: 'mail', icon: ['fas', 'envelope'], color: '#EC4899' },
  caldav: { label: 'calendar', icon: ['fas', 'calendar-days'], color: '#F59E0B' },
  carddav: { label: 'contacts', icon: ['fas', 'address-book'], color: '#60A5FA' }
}
function typeMeta(t) {
  return TYPE_META[t] || { label: t, icon: ['fas', 'globe'], color: '#94A3B8' }
}

// compact per-type config summary chips
function summary(it) {
  const c = it.config || {}
  if (it.type === 'webdav') return [c.base_url, c.root].filter(Boolean)
  if (it.type === 's3') return [c.endpoint, c.bucket, c.prefix].filter(Boolean)
  if (it.type === 'local') return [c.root].filter(Boolean)
  if (it.type === 'mail') return [c.email_address, c.imap_host, c.auth === 'oauth2' ? 'oauth' : 'password'].filter(Boolean)
  if (it.type === 'caldav' || it.type === 'carddav') return [c.base_url, c.auth === 'oauth2' ? 'oauth' : 'password'].filter(Boolean)
  return []
}

async function load() {
  loading.value = true
  error.value = null
  try {
    const r = await integrations.list()
    items.value = r.integrations || []
    refreshAuthStates(items.value)   // fire-and-forget: cards render, badges fill in
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

async function onTest(it) {
  busy[it.id] = 'test'
  delete testResult[it.id]
  try {
    const r = await integrations.test(it.id)
    testResult[it.id] = r && r.ok
      ? { ok: true, text: 'ok' }
      : { ok: false, text: (r && r.error) || 'failed' }
  } catch (e) {
    testResult[it.id] = { ok: false, text: e.message }
  } finally {
    busy[it.id] = ''
  }
}

async function onDelete(it) {
  if (!window.confirm(`Delete integration "${it.name}" (${it.type})?\nThis removes its link permanently.`)) return
  busy[it.id] = 'delete'
  error.value = null
  try {
    await integrations.remove(it.id)
    await load()
  } catch (e) {
    error.value = e.message
  } finally {
    busy[it.id] = ''
  }
}

// ── add-integration modal ────────────────────────────────────────────────────
const addOpen = ref(false)
const vaultKeys = ref([]) // existing vault key names for the *_ref datalists

// per-type field definitions. `ref: true` => this is a vault-key-name field (not a raw secret).
const TYPE_FIELDS = {
  local: [{ key: 'root', label: 'Root path', placeholder: '/data/asmltr', mono: true }],
  webdav: [
    { key: 'base_url', label: 'Base URL', placeholder: 'https://dav.example.com/remote.php/dav', mono: true },
    { key: 'username', label: 'Username', placeholder: 'user' },
    { key: 'root', label: 'Root', placeholder: '/asmltr', mono: true },
    { key: 'password_ref', label: 'Password', ref: true }
  ],
  s3: [
    { key: 'endpoint', label: 'Endpoint', placeholder: 'https://s3.us-east-1.amazonaws.com', mono: true },
    { key: 'region', label: 'Region', placeholder: 'us-east-1' },
    { key: 'bucket', label: 'Bucket', placeholder: 'my-bucket' },
    { key: 'prefix', label: 'Prefix', placeholder: 'asmltr/', mono: true },
    { key: 'access_key_id_ref', label: 'Access key ID', ref: true },
    { key: 'secret_access_key_ref', label: 'Secret access key', ref: true }
  ],
  // mail/caldav/carddav each serve TWO providers. The provider preset (below) decides which
  // fields matter, so an operator adding Gmail is not asked for an IMAP host.
  mail: [
    { key: 'email_address', label: 'Email address', placeholder: 'you@example.com' },
    { key: 'imap_host', label: 'IMAP host', placeholder: 'imap.example.com', mono: true },
    { key: 'imap_port', label: 'IMAP port', placeholder: '993' },
    { key: 'smtp_host', label: 'SMTP host', placeholder: 'smtp.example.com', mono: true },
    { key: 'smtp_port', label: 'SMTP port', placeholder: '587' },
    { key: 'from_name', label: 'From name', placeholder: 'Your Name' },
    { key: 'user_ref', label: 'Username', ref: true },
    { key: 'password_ref', label: 'Password', ref: true }
  ],
  caldav: [
    { key: 'email_address', label: 'Email address', placeholder: 'you@example.com' },
    { key: 'base_url', label: 'Collection URL', placeholder: 'https://host/SOGo/dav/user@d.com/Calendar/', mono: true },
    { key: 'username_ref', label: 'Username', ref: true },
    { key: 'password_ref', label: 'Password', ref: true }
  ],
  carddav: [
    { key: 'email_address', label: 'Email address', placeholder: 'you@example.com' },
    { key: 'base_url', label: 'Collection URL', placeholder: 'https://host/SOGo/dav/user@d.com/Contacts/', mono: true },
    { key: 'username_ref', label: 'Username', ref: true },
    { key: 'password_ref', label: 'Password', ref: true }
  ]
}

// Provider presets. Choosing one prefills hosts and sets `auth`, so the operator picks
// "Gmail" rather than remembering imap.gmail.com — and an OAuth provider deliberately hides the
// credential fields, because the secret arrives from the consent flow, not from a form.
// Each provider declares EXACTLY which fields it asks for. An OAuth provider asks for the address
// and nothing else: hosts are known, and the credential arrives from consent — so showing an IMAP
// host or a password field there is just a form the operator has to ignore.
const PROVIDERS = {
  mail: [
    { id: 'imap', label: 'IMAP / SMTP', icon: ['fas', 'server'],
      hint: 'mailcow, Dovecot, any standard server — authenticates with a stored password',
      ask: ['email_address', 'imap_host', 'imap_port', 'smtp_host', 'smtp_port', 'from_name', 'user_ref', 'password_ref'],
      preset: { imap_port: '993', smtp_port: '587' }, oauth: false },
    { id: 'gmail', label: 'Gmail / Google Workspace', icon: ['fas', 'envelope'],
      hint: 'just the address — authorize with Google afterwards; one consent also covers calendar and contacts',
      ask: ['email_address', 'from_name'],
      preset: { imap_host: 'imap.gmail.com', imap_port: '993', smtp_host: 'smtp.gmail.com', smtp_port: '587' }, oauth: true }
  ],
  caldav: [
    { id: 'sogo', label: 'SOGo / mailcow', icon: ['fas', 'server'],
      hint: 'a CalDAV collection URL plus a stored password',
      ask: ['base_url', 'username_ref', 'password_ref'], preset: {}, oauth: false },
    { id: 'google', label: 'Google Calendar', icon: ['fas', 'calendar-days'],
      hint: 'just the address — the collection URL is derived and Google authorizes it',
      ask: ['email_address'], oauth: true,
      urlTemplate: (a) => `https://apidata.googleusercontent.com/caldav/v2/${encodeURIComponent(a)}/` }
  ],
  carddav: [
    { id: 'sogo', label: 'SOGo / mailcow', icon: ['fas', 'server'],
      hint: 'a CardDAV collection URL plus a stored password',
      ask: ['base_url', 'username_ref', 'password_ref'], preset: {}, oauth: false },
    { id: 'google', label: 'Google Contacts', icon: ['fas', 'address-book'],
      hint: 'just the address — the collection URL is derived and Google authorizes it',
      ask: ['email_address'], oauth: true,
      urlTemplate: (a) => `https://www.googleapis.com/carddav/v1/principals/${encodeURIComponent(a)}/lists/default/` }
  ]
}
function providersFor(t) { return PROVIDERS[t] || [] }

const step = ref('type') // 'type' | 'provider' | 'form'
const chosenProvider = ref(null)
const chosenType = ref(null)
const nameField = ref('')
const fields = reactive({}) // key -> value string
// optional "store new secret" toggles per *_ref field: refKey -> { open, name, value }
const storeNew = reactive({})
const submitting = ref(false)
const formError = ref(null)

function openAdd() {
  step.value = 'type'
  chosenType.value = null
  nameField.value = ''
  formError.value = null
  Object.keys(fields).forEach((k) => delete fields[k])
  Object.keys(storeNew).forEach((k) => delete storeNew[k])
  addOpen.value = true
  // refresh vault key names for the pickers (best-effort)
  vaultApi
    .secrets()
    .then((r) => (vaultKeys.value = (r.secrets || []).map((s) => s.name)))
    .catch(() => (vaultKeys.value = []))
}

function resetFormFields(t) {
  Object.keys(fields).forEach((k) => delete fields[k])
  Object.keys(storeNew).forEach((k) => delete storeNew[k])
  for (const f of TYPE_FIELDS[t] || []) {
    fields[f.key] = ''
    if (f.ref) storeNew[f.key] = { open: false, name: '', value: '' }
  }
}

function pickType(t) {
  chosenType.value = t
  chosenProvider.value = null
  resetFormFields(t)
  // types that serve more than one provider ask which first, so the form can be the right shape
  step.value = providersFor(t).length ? 'provider' : 'form'
}

function pickProvider(pr) {
  chosenProvider.value = pr
  resetFormFields(chosenType.value)
  for (const [k, v] of Object.entries(pr.preset || {})) fields[k] = v
  step.value = 'form'
}

// An OAuth provider must not ask for a password: the secret comes from the consent flow. The URL
// for Google DAV collections is derived from the address, so that is hidden too.
// The form is the provider's `ask` list, in that order. Anything a provider does not ask for is
// either preset or derived, so it never reaches the operator.
const visibleFields = computed(() => {
  const all = chosenType.value ? TYPE_FIELDS[chosenType.value] || [] : []
  const pr = chosenProvider.value
  if (!pr) return all
  if (!Array.isArray(pr.ask)) return all
  const byKey = Object.fromEntries(all.map((f) => [f.key, f]))
  return pr.ask
    .map((k) => byKey[k] || { key: k, label: k.replace(/_ref$/, '').replace(/_/g, ' '), ref: k.endsWith('_ref') })
    .filter(Boolean)
})

function toggleStoreNew(key) {
  if (storeNew[key]) storeNew[key].open = !storeNew[key].open
}

const currentFields = computed(() => visibleFields.value)
const canSubmit = computed(() => !!chosenType.value && !!nameField.value.trim())

async function onCreate() {
  if (!canSubmit.value || submitting.value) return
  submitting.value = true
  formError.value = null
  try {
    // resolve any "store new" refs first: persist the secret to the vault, then use its name as the ref.
    for (const f of currentFields.value) {
      if (!f.ref) continue
      const sn = storeNew[f.key]
      if (sn && sn.open && sn.name.trim() && sn.value) {
        await vaultApi.addSecret({ name: sn.name.trim(), value: sn.value })
        fields[f.key] = sn.name.trim()
      }
    }
    // build config from non-empty fields only
    const config = {}
    for (const f of currentFields.value) {
      const v = (fields[f.key] || '').trim()
      if (v) config[f.key] = v
    }
    const pr = chosenProvider.value
    // hidden presets (hosts/ports) still belong in the stored config
    if (pr && pr.preset) for (const [k, v] of Object.entries(pr.preset)) if (!config[k]) config[k] = v
    if (pr && pr.oauth) {
      config.auth = 'oauth2'
      // derive the collection URL for Google DAV from the address rather than making the
      // operator paste a long templated URL
      const addr = (fields.email_address || nameField.value || '').trim()
      if (pr.urlTemplate && addr) config.base_url = pr.urlTemplate(addr)
      if (addr && chosenType.value === 'mail') config.email_address = addr
    }
    const made = await integrations.create({ type: chosenType.value, name: nameField.value.trim(), config })
    addOpen.value = false
    await load()
    // an OAuth integration is created UNAUTHORIZED — take the operator straight to its wizard
    // instead of leaving a card that silently cannot connect
    if (pr && pr.oauth && made && made.id) openAuth(items.value.find((x) => x.id === made.id) || made)
  } catch (e) {
    formError.value = e.message
  } finally {
    submitting.value = false
  }
}

// ── per-card authorization ──────────────────────────────────────────────────
// Each integration runs its OWN flow from its own card. `auth` state is fetched per card so a
// card can say "needs authorizing" before the operator clicks anything, and so a provider that
// needs no flow (a stored password) simply never shows the control.
const authState = reactive({})   // integration id -> state from GET /:id/auth
const auth = reactive({
  open: false, it: null, st: null, loading: false, busy: false, error: null, done: null,
  authUrl: '', state: null, mode: '', code: '',
  clientId: '', clientSecret: '', clientType: 'web', savingClient: false,
})

async function refreshAuthStates(list) {
  await Promise.all((list || []).map(async (it) => {
    try { authState[it.id] = await integrations.authState(it.id) }
    catch (_) { authState[it.id] = null }
  }))
}
function needsAuthorizing(it) {
  const a = authState[it.id]
  return !!a && a.required && !a.authorized
}
function authBadge(it) {
  const a = authState[it.id]
  if (!a || !a.required) return null
  return a.authorized ? { text: 'authorized', cls: 'text-emerald-300' } : { text: 'needs authorizing', cls: 'text-amber-300' }
}

async function openAuth(it) {
  auth.open = true; auth.it = it; auth.st = null; auth.error = null; auth.done = null
  auth.authUrl = ''; auth.state = null; auth.code = ''; auth.loading = true
  try {
    auth.st = await integrations.authState(it.id)
    authState[it.id] = auth.st
    const c = await integrations.oauthClient()
    if (c && c.client_type) auth.clientType = c.client_type
  } catch (e) { auth.error = e.message } finally { auth.loading = false }
}

async function saveOauthClient() {
  auth.error = null
  if (!auth.clientId.trim() || !auth.clientSecret.trim()) { auth.error = 'Both the client ID and secret are required'; return }
  auth.savingClient = true
  try {
    await integrations.saveOauthClient({ client_id: auth.clientId.trim(), client_secret: auth.clientSecret.trim(), client_type: auth.clientType })
    auth.clientId = ''; auth.clientSecret = ''
    auth.st = await integrations.authState(auth.it.id)      // mode may now be `redirect`
    authState[auth.it.id] = auth.st
  } catch (e) { auth.error = e.message } finally { auth.savingClient = false }
}

async function beginAuth() {
  auth.error = null; auth.busy = true
  try {
    const r = await integrations.authStart(auth.it.id)
    auth.state = r.state; auth.authUrl = r.auth_url; auth.mode = r.mode
    window.open(r.auth_url, '_blank', 'noopener')
  } catch (e) { auth.error = e.message } finally { auth.busy = false }
}

async function finishAuth() {
  auth.error = null
  if (!auth.code.trim()) { auth.error = 'Paste the code (or the whole redirected URL)'; return }
  auth.busy = true
  try {
    auth.done = await integrations.authClaim(auth.it.id, { state: auth.state, code: auth.code.trim() })
    auth.code = ''; auth.authUrl = ''; auth.state = null
    await load()
  } catch (e) { auth.error = e.message } finally { auth.busy = false }
}

onMounted(load)
</script>

<template>
  <div>
    <PageHeader
      title="Integrations"
      subtitle="Third-party service links (storage) — credentials live in the vault, never in config"
    >
      <template #actions>
        <button class="glass glass-hover px-3 py-1.5 text-sm text-slate-300" @click="load">
          <AppIcon glyph="↻" /> Refresh
        </button>
        <button
          class="rounded-xl bg-brand-gradient px-3 py-1.5 text-sm font-semibold text-white shadow-lg shadow-brand-violet/30 transition-opacity hover:opacity-90"
          @click="openAdd"
        >
          ＋ Add integration
        </button>
      </template>
    </PageHeader>

    <p
      v-if="error"
      class="mb-4 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm text-rose-300"
    >
      {{ error }}
    </p>

    <!-- configured integrations -->
    <div v-if="items.length" class="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <div v-for="it in items" :key="it.id" class="glass glass-hover flex flex-col gap-3 p-4">
        <!-- header -->
        <div class="flex items-start justify-between gap-2">
          <span
            class="pill border"
            :style="{
              color: typeMeta(it.type).color,
              borderColor: typeMeta(it.type).color + '40',
              backgroundColor: typeMeta(it.type).color + '1a'
            }"
          >
            <AppIcon :name="typeMeta(it.type).icon" /> {{ typeMeta(it.type).label }}
          </span>
        </div>

        <!-- name + id -->
        <div class="min-w-0">
          <div class="truncate text-sm font-semibold text-slate-100" :title="it.name">{{ it.name }}</div>
          <div class="mt-0.5 truncate font-mono text-[11px] text-slate-500" :title="it.id">{{ it.id }}</div>
        </div>

        <!-- config summary -->
        <div v-if="summary(it).length" class="flex flex-wrap items-center gap-1.5 text-[11px]">
          <span
            v-for="chip in summary(it)"
            :key="chip"
            class="pill border border-white/10 bg-white/5 font-mono text-slate-400"
          >
            {{ chip }}
          </span>
        </div>

        <!-- action row -->
        <div class="mt-1 flex flex-wrap items-center gap-2 border-t border-white/5 pt-3">
          <button
            v-if="authState[it.id] && authState[it.id].required"
            type="button"
            class="act"
            :class="needsAuthorizing(it) ? 'text-amber-300' : 'text-emerald-300'"
            @click="openAuth(it)"
          >
            <AppIcon glyph="🔑" /> {{ needsAuthorizing(it) ? 'Authorize' : 'Re-authorize' }}
          </button>
          <button type="button" class="act" :disabled="!!busy[it.id]" @click="onTest(it)">
            <template v-if="busy[it.id] === 'test'">…</template>
            <template v-else><AppIcon glyph="✓" /> Test</template>
          </button>

          <!-- transient test result chip -->
          <span
            v-if="testResult[it.id]"
            class="pill border"
            :class="testResult[it.id].ok
              ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
              : 'border-rose-500/30 bg-rose-500/10 text-rose-300'"
            :title="testResult[it.id].text"
          >
            <AppIcon :glyph="testResult[it.id].ok ? '✓' : '✗'" />
            <span class="max-w-[16rem] truncate">{{ testResult[it.id].ok ? 'ok' : testResult[it.id].text }}</span>
          </span>

          <button type="button" class="act-danger ml-auto" :disabled="!!busy[it.id]" @click="onDelete(it)">
            <template v-if="busy[it.id] === 'delete'">…</template>
            <template v-else><AppIcon glyph="🗑" /> Delete</template>
          </button>
        </div>
      </div>
    </div>

    <p v-else class="glass px-4 py-6 text-center text-sm text-slate-500">
      {{ loading ? 'Loading integrations…' : 'No integrations configured yet — add one above.' }}
    </p>

    <!-- add-integration modal -->
    <ModalShell
      v-if="addOpen"
      title="Add integration"
      :subtitle="step === 'type' ? 'Pick what to connect' : (step === 'provider' ? `${typeMeta(chosenType).label} — pick a provider` : `${typeMeta(chosenType).label}${chosenProvider ? ' · ' + chosenProvider.label : ''}`)"
      wide
      @close="addOpen = false"
    >
      <!-- step 1: pick a type -->
      <div v-if="step === 'type'" class="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <button
          v-for="t in ['mail', 'caldav', 'carddav', 'webdav', 's3', 'local']"
          :key="t"
          type="button"
          class="glass glass-hover flex flex-col items-center gap-2 p-5 text-center"
          @click="pickType(t)"
        >
          <span class="text-2xl" :style="{ color: typeMeta(t).color }">
            <AppIcon :name="typeMeta(t).icon" />
          </span>
          <span class="text-sm font-semibold text-slate-100">{{ typeMeta(t).label }}</span>
        </button>
      </div>

      <!-- step 2: per-type form -->
      <form v-else class="flex flex-col gap-4" @submit.prevent="onCreate">
        <button
          type="button"
          class="self-start text-xs font-medium text-slate-400 transition-colors hover:text-slate-200"
          @click="step = 'type'"
        >
          ← Back to type
        </button>

        <!-- name -->
        <div>
          <label class="mb-1 flex items-center gap-2 text-sm font-medium text-slate-200">
            <span>Name</span><span class="text-rose-400">*</span>
          </label>
          <input v-model="nameField" type="text" class="field-input" placeholder="e.g. nextcloud-backup" />
        </div>

        <!-- per-type fields -->
        <div v-for="f in currentFields" :key="f.key">
          <label class="mb-1 block text-sm font-medium text-slate-200">
            {{ f.label }}<template v-if="f.ref"> — vault key name</template>
          </label>

          <!-- vault-key-name field (*_ref) -->
          <template v-if="f.ref">
            <input
              v-model="fields[f.key]"
              type="text"
              class="field-input font-mono"
              :list="`vaultkeys-${f.key}`"
              placeholder="pick or type a vault key name"
              :disabled="storeNew[f.key] && storeNew[f.key].open"
            />
            <datalist :id="`vaultkeys-${f.key}`">
              <option v-for="k in vaultKeys" :key="k" :value="k" />
            </datalist>
            <div class="mt-1 flex items-center justify-between gap-2">
              <p class="text-xs text-slate-500">The secret lives in the vault under this name.</p>
              <button
                type="button"
                class="shrink-0 text-xs font-medium text-violet-300 transition-colors hover:text-violet-200"
                @click="toggleStoreNew(f.key)"
              >
                {{ storeNew[f.key] && storeNew[f.key].open ? '✕ cancel' : '＋ store new' }}
              </button>
            </div>

            <!-- inline "store new secret" (optional) -->
            <div
              v-if="storeNew[f.key] && storeNew[f.key].open"
              class="mt-2 rounded-xl border border-brand-violet/30 bg-brand-violet/10 p-3"
            >
              <div class="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-wide text-violet-300">
                <AppIcon glyph="🔒" /> store a new secret in the vault
              </div>
              <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <input
                  v-model="storeNew[f.key].name"
                  type="text"
                  class="field-input font-mono"
                  placeholder="new key name"
                />
                <input
                  v-model="storeNew[f.key].value"
                  type="password"
                  class="field-input"
                  placeholder="secret value"
                />
              </div>
              <p class="mt-1 text-xs text-slate-500">Saved on create, then used as the ref above.</p>
            </div>
          </template>

          <!-- plain field -->
          <input
            v-else
            v-model="fields[f.key]"
            type="text"
            class="field-input"
            :class="f.mono ? 'font-mono' : ''"
            :placeholder="f.placeholder || ''"
          />
        </div>

        <p
          v-if="formError"
          class="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300"
        >
          {{ formError }}
        </p>
      </form>

      <!-- step 1b: pick a provider (only for types that serve more than one) -->
      <div v-if="step === 'provider'" class="space-y-2">
        <button
          v-for="pr in providersFor(chosenType)"
          :key="pr.id"
          type="button"
          class="glass glass-hover w-full rounded-xl p-3 text-left"
          @click="pickProvider(pr)"
        >
          <div class="flex items-center justify-between gap-3">
            <span class="flex items-center gap-2 text-sm font-semibold text-slate-100">
              <span v-if="pr.icon" class="text-lg" :style="{ color: typeMeta(chosenType).color }">
                <AppIcon :name="pr.icon" />
              </span>
              {{ pr.label }}
            </span>
            <span v-if="pr.oauth" class="rounded-lg bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-300">
              needs authorizing
            </span>
          </div>
          <p class="mt-1 text-xs text-slate-400">{{ pr.hint }}</p>
        </button>
        <button type="button" class="act mt-1" @click="step = 'type'">← back</button>
      </div>

      <template v-if="step === 'form'" #footer>
        <button
          type="button"
          class="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-300 transition-colors hover:bg-white/10"
          @click="addOpen = false"
        >
          Cancel
        </button>
        <button
          type="button"
          :disabled="!canSubmit || submitting"
          class="rounded-xl bg-brand-gradient px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-brand-violet/30 transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
          @click="onCreate"
        >
          {{ submitting ? 'Adding…' : 'Add integration' }}
        </button>
      </template>
    </ModalShell>

    <!-- per-card authorization wizard -->
    <ModalShell
      v-if="auth.open"
      :title="`Authorize — ${auth.it ? auth.it.name : ''}`"
      :subtitle="auth.st && auth.st.provider === 'google' ? 'Google: one consent covers mail, calendar and contacts' : 'Authorization'"
      wide
      @close="auth.open = false"
    >
      <p v-if="auth.loading" class="text-sm text-slate-400">Checking what this integration needs…</p>

      <div v-else-if="auth.st" class="space-y-3">
        <!-- nothing to do -->
        <p v-if="!auth.st.required" class="rounded-xl bg-slate-800/40 p-3 text-xs text-slate-300">
          {{ auth.st.note }}
        </p>

        <template v-else>
          <!-- current state -->
          <div class="rounded-xl bg-slate-800/40 p-3 text-xs">
            <p class="text-slate-300">
              <span class="font-semibold">Status:</span>
              <span :class="auth.st.authorized ? 'text-emerald-300' : 'text-amber-300'">
                {{ auth.st.authorized ? 'authorized' : 'not yet authorized' }}
              </span>
              <span v-if="auth.st.client_type" class="text-slate-500">
                · {{ auth.st.client_type }} client ({{ auth.st.client_source }})
              </span>
            </p>
            <p v-if="auth.st.callback_url" class="mt-1 text-slate-400">
              Callback: <code class="text-slate-300">{{ auth.st.callback_url }}</code>
            </p>
            <p v-if="auth.st.reason" class="mt-1 text-slate-400">{{ auth.st.reason }}</p>
            <p v-if="auth.st.warning" class="mt-1 text-amber-300">{{ auth.st.warning }}</p>
            <ul v-if="auth.st.how_to_fix" class="mt-1 list-disc space-y-0.5 pl-5 text-slate-400">
              <li v-for="(h, i) in auth.st.how_to_fix" :key="i">{{ h }}</li>
            </ul>
            <p v-if="auth.st.scopes" class="mt-1 text-slate-500">Scopes: {{ auth.st.scopes }}</p>
          </div>

          <!-- supply / replace the OAuth client. This is what unlocks the https redirect. -->
          <details class="rounded-xl bg-slate-800/40 p-3" :open="auth.st.mode === 'needs_client'">
            <summary class="cursor-pointer text-xs font-semibold text-slate-300">
              OAuth client {{ auth.st.mode === 'needs_client' ? '(required)' : '(replace)' }}
            </summary>
            <p class="mt-2 text-xs text-slate-400">
              Stored in the vault, never on disk. A <strong>Web application</strong> client plus a
              configured public URL gives one-click consent; a Desktop client can only use a
              loopback redirect, which means copying a code back.
            </p>
            <div class="mt-2 grid gap-2 sm:grid-cols-2">
              <input v-model="auth.clientId" placeholder="client ID"
                class="rounded-xl bg-slate-900/60 px-3 py-1.5 text-sm text-slate-200 outline-none ring-1 ring-slate-700 focus:ring-brand-violet" />
              <input v-model="auth.clientSecret" type="password" placeholder="client secret"
                class="rounded-xl bg-slate-900/60 px-3 py-1.5 text-sm text-slate-200 outline-none ring-1 ring-slate-700 focus:ring-brand-violet" />
              <select v-model="auth.clientType"
                class="rounded-xl bg-slate-900/60 px-3 py-1.5 text-sm text-slate-200 outline-none ring-1 ring-slate-700">
                <option value="web">Web application</option>
                <option value="installed">Desktop app</option>
              </select>
              <button :disabled="auth.savingClient"
                class="rounded-xl bg-brand-gradient px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
                @click="saveOauthClient">
                {{ auth.savingClient ? 'Saving…' : 'Save client' }}
              </button>
            </div>
          </details>

          <!-- begin consent -->
          <div v-if="auth.st.ready" class="flex flex-wrap items-center gap-2">
            <button :disabled="auth.busy"
              class="rounded-xl bg-brand-gradient px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
              @click="beginAuth">
              {{ auth.busy ? 'Working…' : (auth.st.authorized ? 'Re-authorize' : 'Begin consent') }}
            </button>
            <span class="text-xs text-slate-500">
              {{ auth.st.mode === 'redirect' ? 'opens Google, returns here automatically' : 'opens Google, then paste the code back' }}
            </span>
          </div>

          <!-- paste step -->
          <div v-if="auth.authUrl" class="rounded-xl bg-slate-800/40 p-3">
            <p class="text-xs text-slate-400">
              A Google tab was opened. If not,
              <a :href="auth.authUrl" target="_blank" rel="noopener" class="text-brand-violet underline">open it here</a>.
            </p>
            <template v-if="auth.mode !== 'redirect'">
              <p class="mt-2 text-xs text-slate-400">
                After approving, the page Google lands on <strong>will fail to load</strong> — expected.
                Copy the whole address-bar URL and paste it below.
              </p>
              <div class="mt-2 flex flex-wrap items-center gap-2">
                <input v-model="auth.code" placeholder="paste the redirected URL, or just the code=… value"
                  class="min-w-[18rem] flex-1 rounded-xl bg-slate-900/60 px-3 py-1.5 text-sm text-slate-200 outline-none ring-1 ring-slate-700 focus:ring-brand-violet" />
                <button :disabled="auth.busy"
                  class="rounded-xl bg-brand-gradient px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
                  @click="finishAuth">Finish</button>
              </div>
            </template>
            <p v-else class="mt-2 text-xs text-slate-400">Approve in that tab and you will be returned here.</p>
          </div>

          <p v-if="auth.error" class="text-xs text-rose-300">{{ auth.error }}</p>
          <div v-if="auth.done" class="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs">
            <p class="font-semibold text-emerald-300">Authorized {{ auth.done.account }}</p>
            <p class="mt-1 text-emerald-200/90">
              One grant covered {{ auth.done.authorized.length }} integration(s):
              {{ auth.done.authorized.map(a => a.type).join(', ') }}
            </p>
          </div>
        </template>
      </div>
    </ModalShell>
  </div>
</template>

<style scoped>
.act {
  @apply rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs font-medium text-slate-300 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50;
}
.act-danger {
  @apply rounded-lg border border-rose-500/20 bg-rose-500/5 px-2.5 py-1 text-xs font-medium text-rose-400/80 transition-colors hover:bg-rose-500/15 disabled:cursor-not-allowed disabled:opacity-50;
}
.field-input {
  @apply w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-slate-100 outline-none transition-colors;
  @apply placeholder:text-slate-600 focus:border-brand-violet/60 focus:bg-white/[0.06] disabled:opacity-40;
}
</style>
