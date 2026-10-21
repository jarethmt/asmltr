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
// Portal management only makes sense inside the native app: the dongle link (BLE + Wi-Fi Direct) runs
// through window.AsmltrNative, which a desktop browser doesn't have — so hide it unless the bridge is present.
const isNativeApp = typeof window !== 'undefined' && !!window.AsmltrNative
const navItems = computed(() => NAV_ROUTES.filter((r) => r.name !== 'notifications' && (r.name !== 'portal' || isNativeApp)))

// --- responsive nav: mobile drawer + collapsible desktop sidebar -------------------------------------
const drawerOpen = ref(false)                 // mobile: slide-in navigation drawer
const navCollapsed = ref(localStorage.getItem('asmltr:navCollapsed') === '1') // desktop: icon-only rail
function toggleCollapse() {
  navCollapsed.value = !navCollapsed.value
  localStorage.setItem('asmltr:navCollapsed', navCollapsed.value ? '1' : '0')
}
// Close the mobile drawer whenever the route changes (a nav item was tapped) or on Escape.
watch(() => route.fullPath, () => { drawerOpen.value = false })
function onKey(e) { if (e.key === 'Escape') drawerOpen.value = false }
onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))

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
    <!-- Mobile top app bar (Material): hamburger · brand · connection + quick actions -->
    <header
      class="sticky top-0 z-30 flex items-center gap-1 border-b border-white/10 bg-[hsl(258,26%,9%)]/85 px-2 py-1.5 backdrop-blur-xl lg:hidden"
      style="padding-top: max(0.375rem, env(safe-area-inset-top)); padding-left: max(0.5rem, env(safe-area-inset-left))"
    >
      <button type="button" aria-label="Open navigation" class="grid h-11 w-11 place-items-center rounded-xl text-slate-300 transition-colors hover:bg-white/5" @click="drawerOpen = true">
        <AppIcon glyph="≡" class="text-xl" />
      </button>
      <RouterLink to="/" class="flex items-center gap-2">
        <BrandLogo class="h-8 w-8" />
        <span class="gradient-text text-sm font-bold tracking-tight">{{ agentName }}</span>
      </RouterLink>
      <div class="ml-auto flex items-center">
        <span class="mr-1 h-2 w-2 rounded-full" :class="store.connected ? 'bg-emerald-400 animate-pulse-dot' : 'bg-rose-500'"></span>
        <RouterLink to="/notifications" aria-label="Notifications" class="grid h-11 w-11 place-items-center rounded-xl text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-200" :class="route.name === 'notifications' ? '!text-brand-violet' : ''"><AppIcon glyph="✦" /></RouterLink>
        <button v-if="auth.enabled" type="button" aria-label="Sign out" class="grid h-11 w-11 place-items-center rounded-xl text-slate-400 transition-colors hover:bg-rose-500/10 hover:text-rose-300" @click="logout"><AppIcon glyph="⎋" /></button>
      </div>
    </header>

    <!-- Scrim behind the mobile drawer -->
    <Transition name="fade">
      <div v-if="drawerOpen" class="fixed inset-0 z-40 bg-black/60 lg:hidden" @click="drawerOpen = false"></div>
    </Transition>

    <!-- Navigation: slide-in drawer on mobile, persistent collapsible rail on desktop -->
    <aside
      class="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-white/10 bg-[hsl(258,26%,9%)]/95 backdrop-blur-xl transition-transform duration-200 ease-out lg:sticky lg:top-0 lg:z-auto lg:h-screen lg:max-w-none lg:translate-x-0 lg:bg-black/20"
      :class="[drawerOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0', navCollapsed ? 'lg:w-[76px]' : 'lg:w-60']"
    >
      <!-- Brand row (+ collapse toggle on desktop, close on mobile) -->
      <div class="flex items-center gap-3 px-4 py-4" :class="navCollapsed ? 'lg:justify-center lg:px-2' : ''">
        <BrandLogo class="h-9 w-9 shrink-0" />
        <div class="leading-tight" :class="navCollapsed ? 'lg:hidden' : ''">
          <div class="text-sm font-bold tracking-tight"><span class="gradient-text">{{ agentName }}</span></div>
          <div class="text-[11px] text-slate-400">asmltr control plane</div>
        </div>
        <button type="button" aria-label="Collapse sidebar" class="ml-auto hidden h-8 w-8 place-items-center rounded-lg text-slate-500 transition-colors hover:bg-white/5 hover:text-slate-300 lg:grid" :class="navCollapsed ? 'lg:hidden' : ''" @click="toggleCollapse"><AppIcon glyph="‹" /></button>
        <button type="button" aria-label="Close navigation" class="ml-auto grid h-9 w-9 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-white/5 lg:hidden" @click="drawerOpen = false"><AppIcon glyph="✕" /></button>
      </div>

      <!-- Expand toggle when the desktop rail is collapsed -->
      <button v-if="navCollapsed" type="button" aria-label="Expand sidebar" class="mx-auto mb-1 hidden h-8 w-8 place-items-center rounded-lg text-slate-500 transition-colors hover:bg-white/5 hover:text-slate-300 lg:grid" @click="toggleCollapse"><AppIcon glyph="›" /></button>

      <!-- Nav list (scrolls if it overflows; never the whole page) -->
      <nav class="flex-1 space-y-0.5 overflow-y-auto px-3 py-2" :class="navCollapsed ? 'lg:px-2' : ''">
        <RouterLink
          v-for="item in navItems" :key="item.name" :to="item.path"
          :title="navCollapsed ? item.meta.title : ''"
          class="group flex min-h-[44px] items-center gap-3 rounded-xl px-3 text-sm font-medium text-slate-300 transition-colors hover:bg-white/5"
          :class="[route.name === item.name ? 'bg-white/[0.07] text-white gradient-border' : '', navCollapsed ? 'lg:justify-center lg:px-0' : '']"
        >
          <AppIcon :glyph="item.meta.icon" class="w-5 shrink-0 text-base" :class="route.name === item.name ? 'text-brand-violet' : 'text-slate-500 group-hover:text-slate-300'" />
          <span class="whitespace-nowrap" :class="navCollapsed ? 'lg:hidden' : ''">{{ item.meta.title }}</span>
        </RouterLink>
      </nav>

      <!-- Desktop quick actions (mobile has them in the top bar) -->
      <div class="hidden items-center gap-1 border-t border-white/10 px-3 py-1.5 lg:flex" :class="navCollapsed ? 'lg:justify-center' : ''">
        <RouterLink to="/notifications" title="Notifications" class="grid h-10 w-10 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-200" :class="route.name === 'notifications' ? '!text-brand-violet' : ''"><AppIcon glyph="✦" /></RouterLink>
        <button v-if="auth.enabled" type="button" title="Sign out" class="grid h-10 w-10 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-rose-500/10 hover:text-rose-300" @click="logout"><AppIcon glyph="⎋" /></button>
      </div>

      <!-- Connection pill -->
      <div class="border-t border-white/10 px-3 py-3" :class="navCollapsed ? 'lg:px-2' : ''">
        <div class="glass flex items-center justify-between px-3 py-2" :class="navCollapsed ? 'lg:justify-center lg:px-2' : ''">
          <div class="flex items-center gap-2">
            <span class="h-2 w-2 shrink-0 rounded-full" :class="store.connected ? 'bg-emerald-400 animate-pulse-dot' : 'bg-rose-500'"></span>
            <span class="text-xs text-slate-300" :class="navCollapsed ? 'lg:hidden' : ''">collector {{ statusText }}</span>
          </div>
          <span v-if="appVersion" class="font-mono text-[11px] text-slate-500" :class="navCollapsed ? 'lg:hidden' : ''" title="asmltr version">v{{ appVersion }}</span>
        </div>
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
