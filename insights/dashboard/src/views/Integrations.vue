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
  local: { label: 'local', icon: ['fas', 'folder-open'], color: '#34D399' }
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
  return []
}

async function load() {
  loading.value = true
  error.value = null
  try {
    const r = await integrations.list()
    items.value = r.integrations || []
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
  ]
}

const step = ref('type') // 'type' | 'form'
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

function pickType(t) {
  chosenType.value = t
  step.value = 'form'
  Object.keys(fields).forEach((k) => delete fields[k])
  Object.keys(storeNew).forEach((k) => delete storeNew[k])
  for (const f of TYPE_FIELDS[t]) {
    fields[f.key] = ''
    if (f.ref) storeNew[f.key] = { open: false, name: '', value: '' }
  }
}

function toggleStoreNew(key) {
  if (storeNew[key]) storeNew[key].open = !storeNew[key].open
}

const currentFields = computed(() => (chosenType.value ? TYPE_FIELDS[chosenType.value] : []))
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
    await integrations.create({ type: chosenType.value, name: nameField.value.trim(), config })
    addOpen.value = false
    await load()
  } catch (e) {
    formError.value = e.message
  } finally {
    submitting.value = false
  }
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
      :subtitle="chosenType ? `${typeMeta(chosenType).label} storage link` : 'Pick a storage type'"
      wide
      @close="addOpen = false"
    >
      <!-- step 1: pick a type -->
      <div v-if="step === 'type'" class="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <button
          v-for="t in ['webdav', 's3', 'local']"
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
