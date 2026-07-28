<script setup>
// Bottom bar with two modes:
//  • install — Android browser, app not installed → link to the APK (default: public GitHub release).
//  • update  — running INSIDE the native app (window.AsmltrNative present) and the instance is serving a
//              newer versionCode than installed → offer an in-app update via the native system installer.
import { ref, onMounted } from 'vue'

const DISMISS_KEY = 'asmltr.androidBannerDismissed'
const APK_URL = import.meta.env.VITE_ANDROID_APK_URL
  || 'https://github.com/jarethmt/asmltr/releases/latest/download/asmltr.apk'

const show = ref(false)
const mode = ref('install')       // 'install' | 'update'
const newVersion = ref('')
const native = () => (typeof window !== 'undefined' ? window.AsmltrNative : null)

onMounted(async () => {
  const n = native()
  if (n && typeof n.getAppVersion === 'function' && typeof n.installUpdate === 'function') {
    // In-app: compare the served versionCode to the installed one.
    try {
      const appVer = n.getAppVersion()
      const j = await fetch('/app/gw/app').then((r) => r.json())
      if (j && j.versionCode && appVer && j.versionCode > appVer) {
        let seen = ''
        try { seen = localStorage.getItem('asmltr.updateDismissed') || '' } catch (_) {}
        if (String(seen) !== String(j.versionCode)) { mode.value = 'update'; newVersion.value = j.versionName || ''; show.value = true }
      }
    } catch (_) {}
    return
  }
  // In a browser: prompt to install if on Android and not already an installed PWA.
  const isAndroid = /Android/i.test(navigator.userAgent || '')
  const standalone = !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
  let dismissed = false
  try { dismissed = localStorage.getItem(DISMISS_KEY) === '1' } catch (_) {}
  if (isAndroid && !standalone && !dismissed) { mode.value = 'install'; show.value = true }
})

function act() {
  if (mode.value === 'update') { try { native().installUpdate(location.origin + '/app/gw/download') } catch (_) {} show.value = false }
  else { window.location.href = APK_URL }
}
function dismiss() {
  try {
    if (mode.value === 'update') { const j = fetch('/app/gw/app').then((r) => r.json()).then((d) => localStorage.setItem('asmltr.updateDismissed', String(d.versionCode || ''))) }
    else localStorage.setItem(DISMISS_KEY, '1')
  } catch (_) {}
  show.value = false
}
</script>

<template>
  <div v-if="show" class="aib" role="complementary">
    <div class="aib-text">
      <strong>{{ mode === 'update' ? 'Update available' : 'Get the Android app' }}</strong>
      <span>{{ mode === 'update' ? ('Version ' + newVersion + ' is ready to install.') : 'Hands-free voice — hold to talk.' }}</span>
    </div>
    <button class="aib-cta" type="button" @click="act">{{ mode === 'update' ? 'Update' : 'Install' }}</button>
    <button class="aib-x" type="button" @click="dismiss" aria-label="Dismiss">&times;</button>
  </div>
</template>

<style scoped>
.aib { position: fixed; left: 0; right: 0; bottom: 0; z-index: 9999; display: flex; align-items: center; gap: 12px;
  padding: 12px 16px; padding-bottom: max(12px, env(safe-area-inset-bottom));
  background: #14141f; border-top: 1px solid #ffffff14; color: #e9e9f2; box-shadow: 0 -6px 24px #00000066; }
.aib-text { flex: 1; display: flex; flex-direction: column; line-height: 1.25; min-width: 0; }
.aib-text strong { font-size: 14px; } .aib-text span { font-size: 12px; color: #9a9ab0; }
.aib-cta { background: linear-gradient(120deg, #8b5cf6, #ec4899); color: #fff; border: none; font-weight: 700;
  font-size: 14px; padding: 9px 18px; border-radius: 10px; white-space: nowrap; }
.aib-x { background: none; border: none; color: #9a9ab0; font-size: 22px; line-height: 1; padding: 4px 8px; cursor: pointer; }
</style>
