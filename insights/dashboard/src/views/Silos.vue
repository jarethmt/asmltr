<script setup>
// Silos — a file explorer over the assistant's data silos (the .silo/ construct; see shared/silo.js).
// Left rail: every silo (add / select / delete-with-confirm). Main: a breadcrumb + directory list +
// a file preview/editor, plus layered search (metadata + full-text). A silo's manifest (name, …) is
// editable in the Settings modal. The node-graph of data relationships is scaffolded as a teaser —
// it lands on top of this same surface later.
import { onMounted, reactive, ref, computed, watch } from 'vue'
import { silosApi } from '@/services/api'
import PageHeader from '@/components/PageHeader.vue'
import ModalShell from '@/components/ModalShell.vue'

// ── silo list ────────────────────────────────────────────────────────────────
const silos = ref([])
const templates = ref([])
const selectedId = ref('self')
const error = ref(null)
const loading = ref(false)

const selected = computed(() => silos.value.find((s) => s.id === selectedId.value) || null)

async function loadSilos() {
  loading.value = true
  error.value = null
  try {
    const r = await silosApi.list()
    silos.value = r.silos || []
    templates.value = r.templates || []
    if (!silos.value.some((s) => s.id === selectedId.value) && silos.value.length) {
      selectedId.value = silos.value[0].id
    }
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

function selectSilo(id) {
  if (id === selectedId.value) return
  selectedId.value = id
}

// ── directory browsing ───────────────────────────────────────────────────────
const cwd = ref('')
const entries = ref([])
const overview = ref(null)
const browseError = ref(null)

const crumbs = computed(() => {
  const parts = cwd.value ? cwd.value.split('/') : []
  let acc = ''
  return parts.map((p) => { acc = acc ? `${acc}/${p}` : p; return { label: p, path: acc } })
})

async function loadDir(path = '') {
  cwd.value = path
  clearSearch()
  selectedFile.value = null
  browseError.value = null
  try {
    const [ls, ov] = await Promise.all([silosApi.ls(selectedId.value, path), silosApi.overview(selectedId.value)])
    // folders first, then files; alpha within each
    entries.value = (ls.entries || []).sort((a, b) =>
      (a.type === b.type ? 0 : a.type === 'dir' ? -1 : 1) || a.path.localeCompare(b.path))
    overview.value = ov
  } catch (e) {
    browseError.value = e.message
    entries.value = []
  }
}

const baseName = (p) => (p || '').split('/').pop()
function onEntry(e) {
  if (e.type === 'dir') loadDir(e.path)
  else openFile(e.path)
}

// ── file preview / editor ────────────────────────────────────────────────────
const selectedFile = ref(null) // { path, content, binary, size, mtime, draft, dirty, saving }

async function openFile(path) {
  try {
    const f = await silosApi.file(selectedId.value, path)
    selectedFile.value = { ...f, draft: f.content || '', dirty: false, saving: false }
  } catch (e) {
    browseError.value = e.message
  }
}
function onDraftInput() { if (selectedFile.value) selectedFile.value.dirty = selectedFile.value.draft !== (selectedFile.value.content || '') }
async function saveFile() {
  const f = selectedFile.value
  if (!f || f.binary || !f.dirty) return
  f.saving = true
  try {
    await silosApi.putFile(selectedId.value, { path: f.path, content: f.draft })
    f.content = f.draft
    f.dirty = false
  } catch (e) {
    browseError.value = e.message
  } finally {
    f.saving = false
  }
}

async function deleteEntry(e) {
  if (!window.confirm(`Delete "${e.path}" from ${selectedId.value}?` + (e.type === 'dir' ? '\nThis removes the folder and its contents.' : ''))) return
  try {
    await silosApi.rm(selectedId.value, e.path)
    if (selectedFile.value && selectedFile.value.path === e.path) selectedFile.value = null
    await loadDir(cwd.value)
  } catch (err) { browseError.value = err.message }
}

// ── new folder / upload ──────────────────────────────────────────────────────
async function newFolder() {
  const name = window.prompt('New folder name:')
  if (!name) return
  try {
    await silosApi.mkdir(selectedId.value, cwd.value ? `${cwd.value}/${name}` : name)
    await loadDir(cwd.value)
  } catch (e) { browseError.value = e.message }
}
const fileInput = ref(null)
function pickUpload() { fileInput.value && fileInput.value.click() }
async function onUpload(ev) {
  const file = ev.target.files && ev.target.files[0]
  if (!file) return
  try {
    // Raw bytes, not base64 in a JSON body: the JSON route caps near 7.5 MiB of file.
    await silosApi.putFileRaw(selectedId.value, cwd.value ? `${cwd.value}/${file.name}` : file.name, file)
    ev.target.value = ''
    await loadDir(cwd.value)
  } catch (e) { browseError.value = e.message }
}

// ── search ───────────────────────────────────────────────────────────────────
const query = ref('')
const contentSearch = ref(false)
const results = ref(null) // null = not searching
const searching = ref(false)
function clearSearch() { results.value = null; query.value = '' }
async function runSearch() {
  const q = query.value.trim()
  if (!q) return clearSearch()
  searching.value = true
  try {
    const r = await silosApi.find(selectedId.value, { q, content: contentSearch.value ? 1 : undefined })
    results.value = (r.results || []).sort((a, b) => a.path.localeCompare(b.path))
  } catch (e) {
    browseError.value = e.message
  } finally {
    searching.value = false
  }
}

// ── add silo ─────────────────────────────────────────────────────────────────
const addOpen = ref(false)
const addForm = reactive({ id: '', name: '', type: 'generic' })
const addError = ref(null)
const adding = ref(false)
function openAdd() {
  addForm.id = ''; addForm.name = ''; addForm.type = 'generic'
  addError.value = null
  addOpen.value = true
}
async function createSilo() {
  if (!addForm.id.trim() || adding.value) return
  adding.value = true
  addError.value = null
  try {
    await silosApi.create({ id: addForm.id.trim(), name: addForm.name.trim() || addForm.id.trim(), type: addForm.type })
    addOpen.value = false
    selectedId.value = addForm.id.trim()
    await loadSilos()
  } catch (e) { addError.value = e.message } finally { adding.value = false }
}

// ── silo settings (manifest edit + delete) ───────────────────────────────────
const settingsOpen = ref(false)
const manifestForm = reactive({ name: '', description: '' })
const settingsError = ref(null)
const savingSettings = ref(false)
function openSettings() {
  const m = selected.value || {}
  manifestForm.name = m.name || ''
  manifestForm.description = m.description || ''
  settingsError.value = null
  settingsOpen.value = true
}
async function saveManifest() {
  savingSettings.value = true
  settingsError.value = null
  try {
    await silosApi.update(selectedId.value, { name: manifestForm.name, description: manifestForm.description })
    settingsOpen.value = false
    await loadSilos()
  } catch (e) { settingsError.value = e.message } finally { savingSettings.value = false }
}
async function deleteSilo() {
  const m = selected.value
  if (!m) return
  if (m.id === 'self') { settingsError.value = 'The Self silo cannot be deleted.'; return }
  if (!window.confirm(`Delete silo "${m.name}" (${m.id})?\n\nThis permanently removes the silo and ALL its files. This cannot be undone.`)) return
  try {
    await silosApi.remove(m.id)
    settingsOpen.value = false
    selectedId.value = 'self'
    await loadSilos()
  } catch (e) { settingsError.value = e.message }
}

// ── graph teaser (scaffold) ──────────────────────────────────────────────────
const showGraph = ref(false)

const fmtBytes = (n) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`)
const TYPE_ICON = { self: '🧠', 'software-project': '🛠', research: '📂', media: '🎧', generic: '📂' }

watch(selectedId, () => { selectedFile.value = null; loadDir('') })
onMounted(async () => { await loadSilos(); await loadDir('') })
</script>

<template>
  <div>
    <PageHeader title="Silos" subtitle="Explore the assistant's data silos — its memory and its artifacts">
      <template #actions>
        <button class="glass glass-hover px-3 py-1.5 text-sm text-slate-300" @click="loadSilos(); loadDir(cwd)">
          <AppIcon glyph="↻" /> Refresh
        </button>
        <button
          class="rounded-xl bg-brand-gradient px-3 py-1.5 text-sm font-semibold text-white shadow-lg shadow-brand-violet/30 transition-opacity hover:opacity-90"
          @click="openAdd"
        >
          ＋ Add silo
        </button>
      </template>
    </PageHeader>

    <p v-if="error" class="mb-4 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm text-rose-300">{{ error }}</p>

    <div class="grid grid-cols-1 gap-4 lg:grid-cols-[16rem_1fr]">
      <!-- ── left rail: silo list ── -->
      <aside class="glass flex flex-col gap-1 p-2">
        <div class="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Silos</div>
        <button
          v-for="s in silos"
          :key="s.id"
          type="button"
          class="flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors"
          :class="s.id === selectedId ? 'bg-brand-violet/20 text-slate-100' : 'text-slate-400 hover:bg-white/5'"
          @click="selectSilo(s.id)"
        >
          <AppIcon :glyph="TYPE_ICON[s.type] || '📂'" />
          <span class="min-w-0 flex-1 truncate">
            <span class="block truncate font-medium">{{ s.name }}</span>
            <span class="block truncate font-mono text-[10px] text-slate-500">{{ s.id }} · {{ s.type }}</span>
          </span>
        </button>
        <p v-if="!silos.length && !loading" class="px-2 py-3 text-center text-xs text-slate-500">No silos yet.</p>
      </aside>

      <!-- ── main: explorer ── -->
      <section class="flex min-w-0 flex-col gap-3">
        <!-- toolbar -->
        <div class="glass flex flex-wrap items-center gap-2 p-3">
          <!-- breadcrumb -->
          <nav class="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-sm">
            <button class="crumb" @click="loadDir('')">
              <AppIcon :glyph="TYPE_ICON[selected?.type] || '📂'" /> {{ selected?.name || selectedId }}
            </button>
            <template v-for="c in crumbs" :key="c.path">
              <span class="text-slate-600">/</span>
              <button class="crumb" @click="loadDir(c.path)">{{ c.label }}</button>
            </template>
          </nav>
          <button class="act" @click="newFolder"><AppIcon glyph="📂" /> New folder</button>
          <button class="act" @click="pickUpload"><AppIcon glyph="⬆" /> Upload</button>
          <button class="act" @click="openSettings"><AppIcon glyph="⚙" /> Settings</button>
          <input ref="fileInput" type="file" class="hidden" @change="onUpload" />
        </div>

        <!-- search -->
        <div class="glass flex flex-wrap items-center gap-2 p-2">
          <span class="pl-1 text-slate-500"><AppIcon glyph="🔍" /></span>
          <input
            v-model="query"
            type="text"
            class="field-input flex-1"
            placeholder="Search this silo by filename…"
            @keyup.enter="runSearch"
          />
          <label class="flex cursor-pointer items-center gap-1.5 text-xs text-slate-400">
            <input v-model="contentSearch" type="checkbox" class="accent-violet-500" /> full-text
          </label>
          <button class="act" :disabled="searching" @click="runSearch">
            <template v-if="searching">…</template><template v-else>Search</template>
          </button>
          <button v-if="results" class="act" @click="clearSearch"><AppIcon glyph="✕" /> clear</button>
        </div>

        <p v-if="browseError" class="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm text-rose-300">{{ browseError }}</p>

        <!-- overview stat strip -->
        <div v-if="overview && !results" class="flex flex-wrap items-center gap-1.5 text-[11px]">
          <span class="pill border border-white/10 bg-white/5 text-slate-400">{{ overview.type }}</span>
          <span class="pill border border-white/10 bg-white/5 text-slate-400">{{ overview.files }} files</span>
          <span v-for="z in overview.zones" :key="z" class="pill border border-white/10 bg-white/5 font-mono text-slate-500">{{ z }}/</span>
        </div>

        <div class="grid grid-cols-1 gap-3" :class="selectedFile ? 'xl:grid-cols-2' : ''">
          <!-- listing OR search results -->
          <div class="glass overflow-hidden">
            <div v-if="results" class="border-b border-white/5 px-3 py-2 text-xs text-slate-400">
              {{ results.length }} result{{ results.length === 1 ? '' : 's' }} for “{{ query }}”
            </div>
            <ul class="divide-y divide-white/5">
              <template v-if="results">
                <li v-for="r in results" :key="r.path" class="flex items-center gap-2 px-3 py-2 text-sm hover:bg-white/5">
                  <AppIcon glyph="✎" class="text-slate-500" />
                  <button class="min-w-0 flex-1 truncate text-left text-slate-200" @click="openFile(r.path)">{{ r.path }}</button>
                  <span v-if="r.match" class="pill border border-white/10 bg-white/5 text-[10px] text-slate-500">{{ r.match }}</span>
                </li>
                <li v-if="!results.length" class="px-3 py-6 text-center text-sm text-slate-500">No matches.</li>
              </template>
              <template v-else>
                <li
                  v-for="e in entries"
                  :key="e.path"
                  class="flex items-center gap-2 px-3 py-2 text-sm hover:bg-white/5"
                  :class="selectedFile && selectedFile.path === e.path ? 'bg-brand-violet/10' : ''"
                >
                  <AppIcon :glyph="e.type === 'dir' ? '📂' : '✎'" :class="e.type === 'dir' ? 'text-violet-300' : 'text-slate-500'" />
                  <button class="min-w-0 flex-1 truncate text-left" :class="e.type === 'dir' ? 'font-medium text-slate-100' : 'text-slate-300'" @click="onEntry(e)">
                    {{ baseName(e.path) }}<span v-if="e.type === 'dir'">/</span>
                  </button>
                  <span v-if="e.type === 'file'" class="font-mono text-[10px] text-slate-600">{{ fmtBytes(e.size) }}</span>
                  <button class="act-danger" @click.stop="deleteEntry(e)"><AppIcon glyph="🗑" /></button>
                </li>
                <li v-if="!entries.length" class="px-3 py-6 text-center text-sm text-slate-500">Empty folder.</li>
              </template>
            </ul>
          </div>

          <!-- file preview / editor -->
          <div v-if="selectedFile" class="glass flex flex-col overflow-hidden">
            <div class="flex items-center gap-2 border-b border-white/5 px-3 py-2">
              <AppIcon glyph="✎" class="text-slate-500" />
              <span class="min-w-0 flex-1 truncate font-mono text-xs text-slate-300" :title="selectedFile.path">{{ selectedFile.path }}</span>
              <span class="font-mono text-[10px] text-slate-600">{{ fmtBytes(selectedFile.size) }}</span>
              <button
                v-if="!selectedFile.binary"
                class="act"
                :disabled="!selectedFile.dirty || selectedFile.saving"
                @click="saveFile"
              >
                <template v-if="selectedFile.saving">…</template>
                <template v-else><AppIcon glyph="✓" /> Save</template>
              </button>
              <button class="act" @click="selectedFile = null"><AppIcon glyph="✕" /></button>
            </div>
            <div v-if="selectedFile.binary" class="p-6 text-center text-sm text-slate-500">
              Binary file — {{ fmtBytes(selectedFile.size) }}, not previewable.
            </div>
            <textarea
              v-else
              v-model="selectedFile.draft"
              class="min-h-[24rem] w-full flex-1 resize-y bg-transparent p-3 font-mono text-xs leading-relaxed text-slate-200 outline-none"
              spellcheck="false"
              @input="onDraftInput"
            ></textarea>
          </div>
        </div>

        <!-- graph teaser (scaffold for future data-relationship view) -->
        <div class="glass p-3">
          <button class="flex w-full items-center gap-2 text-left text-sm text-slate-400 hover:text-slate-200" @click="showGraph = !showGraph">
            <AppIcon glyph="▦" /> Relationship graph <span class="pill border border-white/10 bg-white/5 text-[10px] text-slate-500">soon</span>
            <span class="ml-auto text-slate-600">{{ showGraph ? '▾' : '▸' }}</span>
          </button>
          <p v-if="showGraph" class="mt-2 border-t border-white/5 pt-2 text-xs leading-relaxed text-slate-500">
            A node graph of the relationships between items — within a silo and across silos — will render here.
            The explorer above is the substrate it builds on: files are the nodes; links (references, provenance,
            derived-from) become the edges. Coming in a later pass.
          </p>
        </div>
      </section>
    </div>

    <!-- add-silo modal -->
    <ModalShell v-if="addOpen" title="Add silo" subtitle="Create a new data silo from a template" @close="addOpen = false">
      <form class="flex flex-col gap-4" @submit.prevent="createSilo">
        <div>
          <label class="mb-1 flex items-center gap-2 text-sm font-medium text-slate-200"><span>ID</span><span class="text-rose-400">*</span></label>
          <input v-model="addForm.id" type="text" class="field-input font-mono" placeholder="e.g. jennmar-clips" />
          <p class="mt-1 text-xs text-slate-500">A short slug (no slashes). Becomes the folder name under the silos root.</p>
        </div>
        <div>
          <label class="mb-1 block text-sm font-medium text-slate-200">Name</label>
          <input v-model="addForm.name" type="text" class="field-input" placeholder="Human-friendly name" />
        </div>
        <div>
          <label class="mb-1 block text-sm font-medium text-slate-200">Template</label>
          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button
              v-for="t in templates"
              :key="t.id"
              type="button"
              class="glass glass-hover flex flex-col items-start gap-1 p-3 text-left"
              :class="addForm.type === t.id ? 'ring-1 ring-brand-violet/60' : ''"
              @click="addForm.type = t.id"
            >
              <span class="flex items-center gap-2 text-sm font-semibold text-slate-100"><AppIcon :glyph="TYPE_ICON[t.id] || '📂'" /> {{ t.id }}</span>
              <span class="text-xs text-slate-500">{{ t.desc }}</span>
              <span v-if="t.folders && t.folders.length" class="font-mono text-[10px] text-slate-600">{{ t.folders.join(' · ') }}</span>
            </button>
          </div>
        </div>
        <p v-if="addError" class="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{{ addError }}</p>
      </form>
      <template #footer>
        <button type="button" class="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-300 hover:bg-white/10" @click="addOpen = false">Cancel</button>
        <button
          type="button"
          :disabled="!addForm.id.trim() || adding"
          class="rounded-xl bg-brand-gradient px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-brand-violet/30 disabled:cursor-not-allowed disabled:opacity-40"
          @click="createSilo"
        >{{ adding ? 'Creating…' : 'Create silo' }}</button>
      </template>
    </ModalShell>

    <!-- silo settings modal (manifest edit + delete) -->
    <ModalShell v-if="settingsOpen" :title="`Silo settings — ${selectedId}`" subtitle="Edit the manifest, or delete the silo" @close="settingsOpen = false">
      <form class="flex flex-col gap-4" @submit.prevent="saveManifest">
        <div>
          <label class="mb-1 block text-sm font-medium text-slate-200">Name</label>
          <input v-model="manifestForm.name" type="text" class="field-input" placeholder="Silo name" />
        </div>
        <div>
          <label class="mb-1 block text-sm font-medium text-slate-200">Description</label>
          <textarea v-model="manifestForm.description" rows="2" class="field-input" placeholder="What this silo holds (optional)"></textarea>
        </div>
        <div class="flex flex-wrap gap-1.5 text-[11px]">
          <span class="pill border border-white/10 bg-white/5 font-mono text-slate-500">id: {{ selected?.id }}</span>
          <span class="pill border border-white/10 bg-white/5 font-mono text-slate-500">type: {{ selected?.type }}</span>
          <span class="pill border border-white/10 bg-white/5 font-mono text-slate-500">created with {{ selected?.created_with }}</span>
        </div>
        <p v-if="settingsError" class="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{{ settingsError }}</p>

        <!-- danger zone -->
        <div class="rounded-xl border border-rose-500/20 bg-rose-500/[0.04] p-3">
          <div class="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wide text-rose-400/80"><AppIcon glyph="⚠" /> danger zone</div>
          <div class="flex items-center justify-between gap-2">
            <p class="text-xs text-slate-500">
              {{ selected?.id === 'self' ? 'The Self silo cannot be deleted.' : 'Permanently delete this silo and all its files.' }}
            </p>
            <button type="button" class="act-danger" :disabled="selected?.id === 'self'" @click="deleteSilo"><AppIcon glyph="🗑" /> Delete silo</button>
          </div>
        </div>
      </form>
      <template #footer>
        <button type="button" class="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-300 hover:bg-white/10" @click="settingsOpen = false">Cancel</button>
        <button
          type="button"
          :disabled="savingSettings"
          class="rounded-xl bg-brand-gradient px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-brand-violet/30 disabled:opacity-40"
          @click="saveManifest"
        >{{ savingSettings ? 'Saving…' : 'Save changes' }}</button>
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
.crumb {
  @apply inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-slate-300 transition-colors hover:bg-white/5 hover:text-slate-100;
}
.field-input {
  @apply w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-slate-100 outline-none transition-colors;
  @apply placeholder:text-slate-600 focus:border-brand-violet/60 focus:bg-white/[0.06] disabled:opacity-40;
}
</style>
