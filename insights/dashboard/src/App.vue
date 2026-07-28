<script setup>
import { onMounted, onUnmounted, computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useCollectorStore } from '@/stores/collector'
import { api, update as updateApi, identity, authApi, vaultApi } from '@/services/api'
import { NAV_ROUTES } from '@/router'
import WindowHost from '@/components/WindowHost.vue'
import BrandLogo from '@/components/BrandLogo.vue'
import AndroidInstallBar from '@/components/AndroidInstallBar.vue'
import AuthScreen from '@/views/AuthScreen.vue'
import { useTurnNotifications } from '@/composables/useTurnNotifications'
import { useUpdateProgress } from '@/composables/useUpdateProgress'
import { useWindows } from '@/stores/windows'
import { applyPalette } from '@/composables/useBrandTheme'

const store = useCollectorStore()
const route = useRoute()
const windows = useWindows()

// Start the turn-complete notification watcher (singleton). The enable toggle lives in Settings →
// Notifications; here we just keep the fire-on-new-turn watcher alive at the app root.
useTurnNotifications(store)
// Live update progress (persistent panel, survives the mid-update restart).
const { status: updProgress, active: updActive, begin: updBegin, dismiss: updDismiss } = useUpdateProgress()

// Notifications lives as a bell icon in the header (not a nav row), so filter it out of the menu.
const navItems = computed(() => NAV_ROUTES.filter((r) => r.name !== 'notifications'))

async function logout() {
  try { await authApi.logout() } catch (_) {}
  window.location.reload() // cookie cleared → the auth gate shows the login screen
}

const statusText = computed(() => (store.connected ? 'live' : 'offline'))

// The configured agent's name + the running version — shown in the brand + the browser tab title, so
// the operator always knows which agent's control plane they're looking at.
const agentName = ref('asmltr')
const appVersion = ref('')

// Browser tab title = "<Agent> · <focused session, else active view>".
const focusedTitle = computed(() => {
  const top = windows.topId?.value
  if (top) {
    const w = windows.state.list.find((x) => x.id === top)
    if (w) {
      if (w.kind === 'observer') return 'Observer'
      const p = w.payload || {}
      return p.title || p.task || p.activity || p.identity || 'session'
    }
  }
  return route.meta?.title || 'asmltr' // no window open → the active view
})
watch([agentName, focusedTitle], ([name, sub]) => { document.title = `${name} · ${sub}` }, { immediate: true })

// Progress state → human copy for the panel.
const UPD_STATE_COPY = {
  running: { label: 'Updating…', tone: 'violet' }, restarting: { label: 'Restarting services…', tone: 'violet' },
  success: { label: 'Update complete', tone: 'emerald' }, 'rolled-back': { label: 'Update failed — rolled back to the previous build', tone: 'amber' },
  failed: { label: 'Update failed — manual intervention needed', tone: 'rose' }, 'up-to-date': { label: 'Already up to date', tone: 'emerald' },
  managed: { label: 'Managed externally', tone: 'slate' },
}
const updCopy = computed(() => UPD_STATE_COPY[updProgress.value.state] || { label: updProgress.value.state, tone: 'slate' })
const updTerminal = computed(() => ['success', 'rolled-back', 'failed', 'up-to-date', 'managed'].includes(updProgress.value.state))

// --- self-update banner ---
const upd = ref({ available: false, behind: 0, changelog: [] })
const auto = ref(false)
const updBusy = ref(false)
const updStarted = ref(false)
let updTimer = null
let vaultTimer = null
async function loadUpd() {
  try { upd.value = await api.updateStatus() } catch (_) {}
  try { auto.value = (await updateApi.getAuto()).auto } catch (_) {}
}
async function runUpdate() {
  updBusy.value = true
  updBegin() // show the progress panel immediately, before the updater's first status write
  try { await updateApi.run(); updStarted.value = true } catch (_) {}
  updBusy.value = false
}
async function toggleAuto() { try { auto.value = (await updateApi.setAuto(!auto.value)).auto } catch (_) {} }
async function loadIdentityVersion() {
  try { const id = await identity.get(); if (id) { if (id.name) agentName.value = id.name; applyPalette(id.palette) } } catch (_) {}
  try { const s = await updateApi.status(false); if (s && s.version) appVersion.value = s.version } catch (_) {}
}

// Auth gate (roadmap P1 phase B). Check status first; only boot the app when we're allowed in. When
// auth is enabled and there's no session, render the login/setup screen instead of the control plane.
const authReady = ref(false)
const auth = ref({ enabled: false, configured: true, user: null })
const needsAuth = computed(() => auth.value.enabled && !auth.value.user)

// Vault lock warning — a configured vault that's sealed/unreachable means credential ops fail; warn loudly.
const vaultLocked = ref(false)
async function loadVault() {
  try { const s = await vaultApi.status(); vaultLocked.value = !!(s.configured && (!s.reachable || s.sealed)) } catch (_) { vaultLocked.value = false }
}

function bootApp() {
  store.connectSocket()
  store.startPolling()
  store.fetchSessions()
  store.fetchBrief()
  loadUpd()
  loadIdentityVersion()
  loadVault()
  updTimer = setInterval(loadUpd, 90000)
  vaultTimer = setInterval(loadVault, 30000)
}

onMounted(async () => {
  try { auth.value = await authApi.status() } catch (_) { /* status is public; on error assume open */ }
  authReady.value = true
  loadIdentityVersion() // agent name for the login screen brand (public identity endpoint)
  if (!needsAuth.value) bootApp()
})

onUnmounted(() => {
  store.stopPolling()
  if (updTimer) clearInterval(updTimer)
  if (vaultTimer) clearInterval(vaultTimer)
})
</script>

<template>
  <div v-if="!authReady" class="min-h-screen"></div>
  <AuthScreen v-else-if="needsAuth" :configured="auth.configured" :agent-name="agentName" />
  <div v-else class="flex min-h-screen flex-col lg:flex-row">
    <!-- Sidebar (desktop) / top brand (mobile) -->
    <aside
      class="lg:sticky lg:top-0 lg:h-screen lg:w-60 lg:shrink-0 lg:border-r lg:border-white/10 lg:bg-black/20 lg:backdrop-blur-xl"
    >
      <div class="flex items-center justify-between px-4 py-4 lg:flex-col lg:items-stretch lg:gap-6">
        <!-- Brand — the configured AGENT's name, so you always know whose control plane this is -->
        <div class="flex items-center gap-3">
          <BrandLogo class="h-9 w-9" />
          <div class="leading-tight">
            <div class="text-sm font-bold tracking-tight">
              <span class="gradient-text">{{ agentName }}</span>
            </div>
            <div class="text-[11px] text-slate-400">asmltr control plane</div>
          </div>
        </div>

        <!-- right side: quick actions (notifications bell + sign out) and, on mobile, the connection pill. -->
        <div class="flex items-center gap-1">
          <RouterLink
            to="/notifications" title="Notifications"
            class="rounded-lg p-2 text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-200"
            :class="route.name === 'notifications' ? 'text-brand-violet' : ''"
          >
            <AppIcon glyph="✦" class="text-base" />
          </RouterLink>
          <button
            v-if="auth.enabled" type="button" title="Sign out" @click="logout"
            class="rounded-lg p-2 text-slate-400 transition-colors hover:bg-rose-500/10 hover:text-rose-300"
          >
            <AppIcon glyph="⎋" class="text-base" />
          </button>
          <div class="ml-1 flex items-center gap-2 lg:hidden">
            <span
              class="h-2 w-2 rounded-full"
              :class="store.connected ? 'bg-emerald-400 animate-pulse-dot' : 'bg-rose-500'"
            ></span>
            <span class="text-xs text-slate-400">{{ statusText }}</span>
          </div>
        </div>
      </div>

      <!-- Nav -->
      <nav
        class="flex gap-1 overflow-x-auto border-t border-white/10 px-2 py-2 lg:flex-col lg:overflow-visible lg:border-0 lg:px-3"
      >
        <RouterLink
          v-for="item in navItems"
          :key="item.name"
          :to="item.path"
          class="group flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium text-slate-300 transition-colors hover:bg-white/5"
          :class="route.name === item.name ? 'bg-white/[0.07] text-white gradient-border' : ''"
        >
          <AppIcon
            :glyph="item.meta.icon"
            class="w-5 text-base"
            :class="route.name === item.name ? 'text-brand-violet' : 'text-slate-500 group-hover:text-slate-300'"
          />
          <span class="whitespace-nowrap">{{ item.meta.title }}</span>
        </RouterLink>
      </nav>

      <!-- Connection pill (desktop, bottom) -->
      <div class="hidden lg:absolute lg:bottom-0 lg:left-0 lg:right-0 lg:block lg:px-4 lg:py-4">
        <div class="glass flex items-center justify-between px-3 py-2">
          <div class="flex items-center gap-2">
            <span
              class="h-2 w-2 rounded-full"
              :class="store.connected ? 'bg-emerald-400 animate-pulse-dot' : 'bg-rose-500'"
            ></span>
            <span class="text-xs text-slate-300">collector {{ statusText }}</span>
          </div>
          <span v-if="appVersion" class="font-mono text-[11px] text-slate-500" title="asmltr version">v{{ appVersion }}</span>
        </div>
        <p v-if="store.lastError" class="mt-2 truncate text-[10px] text-rose-400/80" :title="store.lastError">
          {{ store.lastError }}
        </p>
      </div>
    </aside>

    <!-- Main -->
    <main class="min-w-0 flex-1 px-4 py-5 lg:px-8 lg:py-7">
      <!-- vault-locked warning — credential ops are unavailable until it's unlocked -->
      <RouterLink
        v-if="vaultLocked" to="/vault"
        class="glass mb-4 flex items-center gap-3 border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-sm text-amber-200 transition-colors hover:bg-amber-400/15"
      >
        <AppIcon glyph="🔒" class="text-lg text-amber-300" />
        <span class="flex-1"><b>Vault is locked</b> — credential-backed operations are unavailable until you unlock it.</span>
        <span class="shrink-0 text-[12px] text-amber-300/80">Unlock →</span>
      </RouterLink>

      <!-- LIVE update progress (persistent; survives the mid-update service restart) -->
      <div v-if="updActive" class="glass mb-4 border px-4 py-3"
           :class="{ 'border-brand-violet/40 bg-brand-violet/10': ['violet'].includes(updCopy.tone), 'border-emerald-400/40 bg-emerald-500/10': updCopy.tone==='emerald', 'border-amber-400/40 bg-amber-500/10': updCopy.tone==='amber', 'border-rose-400/40 bg-rose-500/10': updCopy.tone==='rose', 'border-white/10': updCopy.tone==='slate' }">
        <div class="flex items-center gap-3">
          <span v-if="!updTerminal" class="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-brand-violet/30 border-t-brand-violet"></span>
          <AppIcon v-else class="text-lg leading-none" :glyph="updProgress.state==='success' || updProgress.state==='up-to-date' ? '✓' : updProgress.state==='rolled-back' ? '↩' : updProgress.state==='managed' ? 'ⓘ' : '✗'" />
          <div class="min-w-0 flex-1">
            <p class="text-sm font-semibold"
               :class="{ 'text-violet-200': updCopy.tone==='violet', 'text-emerald-200': updCopy.tone==='emerald', 'text-amber-200': updCopy.tone==='amber', 'text-rose-200': updCopy.tone==='rose', 'text-slate-200': updCopy.tone==='slate' }">
              {{ updCopy.label }}
              <span v-if="updProgress.from" class="ml-1 font-mono text-[11px] font-normal text-slate-400">{{ updProgress.from }}{{ updProgress.to ? ' → ' + updProgress.to : '' }}</span>
              <span v-if="updProgress.version && updTerminal" class="ml-1 text-[11px] font-normal text-slate-400">v{{ updProgress.version }}</span>
            </p>
            <p v-if="!updTerminal && updProgress.phase" class="mt-0.5 truncate text-[12px] text-slate-400"><AppIcon glyph="›" class="mr-1 opacity-70" />{{ updProgress.phase }}</p>
            <p v-if="updProgress.message && updTerminal" class="mt-0.5 text-[12px] text-slate-400">{{ updProgress.message }}</p>
          </div>
          <button v-if="updTerminal" type="button" class="shrink-0 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-slate-300 hover:bg-white/10" @click="updDismiss">Dismiss</button>
        </div>
        <pre v-if="updProgress.log && updProgress.log.length" class="mt-2 max-h-28 overflow-y-auto whitespace-pre-wrap rounded-lg border border-white/5 bg-black/30 p-2 font-mono text-[10.5px] leading-relaxed text-slate-400">{{ updProgress.log.slice(-6).join('\n') }}</pre>
      </div>

      <!-- self-update banner -->
      <div v-if="upd.available" class="glass mb-4 flex flex-wrap items-center gap-3 border border-violet-400/30 bg-violet-500/10 px-4 py-3">
        <AppIcon glyph="⬆" class="text-lg text-violet-300" />
        <div class="min-w-0 flex-1">
          <p class="text-sm font-semibold text-violet-200">A newer asmltr is available — {{ upd.behind }} new commit{{ upd.behind === 1 ? '' : 's' }}.</p>
          <p v-if="upd.changelog && upd.changelog.length" class="mt-0.5 truncate font-mono text-[11px] text-slate-400" :title="upd.changelog.join('\n')">
            {{ upd.changelog[0] }}{{ upd.changelog.length > 1 ? ` (+${upd.changelog.length - 1} more)` : '' }}
          </p>
        </div>
        <label class="flex items-center gap-1.5 text-[11px] text-slate-400" title="Auto-update: run the update session automatically when a new version is detected">
          <input type="checkbox" :checked="auto" @change="toggleAuto" /> auto
        </label>
        <button
          class="rounded bg-violet-500/30 px-3 py-1.5 text-sm text-violet-100 hover:bg-violet-500/40 disabled:opacity-50"
          :disabled="updBusy || updStarted" @click="runUpdate"
        >{{ updStarted ? 'updating…' : (updBusy ? '…' : 'Update now') }}</button>
      </div>

      <RouterView v-slot="{ Component }">
        <Transition name="fade" mode="out-in">
          <component :is="Component" />
        </Transition>
      </RouterView>
    </main>

    <!-- floating chat windows (session chats + the observer) live here, above everything -->
    <WindowHost />
  </div>

  <!-- Android-only, dismissible: prompt to install the native app (hands-free assist) -->
  <AndroidInstallBar />
</template>
