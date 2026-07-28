<script setup>
// A dismissible bottom bar prompting Android browser users to install the native app (which carries the
// hands-free assist trigger). We can't reliably detect a sideloaded install from the web, so we gate on
// Android UA + not-standalone + not-dismissed (standard smart-banner behaviour). The APK URL defaults to
// the public GitHub release and is overridable per-install via VITE_ANDROID_APK_URL at build time.
import { ref, onMounted } from 'vue'

const DISMISS_KEY = 'asmltr.androidBannerDismissed'
const APK_URL = import.meta.env.VITE_ANDROID_APK_URL
  || 'https://github.com/jarethmt/asmltr/releases/latest/download/asmltr.apk'

const show = ref(false)
onMounted(() => {
  const isAndroid = /Android/i.test(navigator.userAgent || '')
  const standalone = !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
  let dismissed = false
  try { dismissed = localStorage.getItem(DISMISS_KEY) === '1' } catch (_) {}
  show.value = isAndroid && !standalone && !dismissed
})
function dismiss() { try { localStorage.setItem(DISMISS_KEY, '1') } catch (_) {} show.value = false }
</script>

<template>
  <div v-if="show" class="aib" role="complementary" aria-label="Install the Android app">
    <div class="aib-text">
      <strong>Get the Android app</strong>
      <span>Hands-free voice — hold to talk.</span>
    </div>
    <a class="aib-cta" :href="APK_URL" rel="noopener">Install</a>
    <button class="aib-x" type="button" @click="dismiss" aria-label="Dismiss">&times;</button>
  </div>
</template>

<style scoped>
.aib {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 9999;
  display: flex; align-items: center; gap: 12px;
  padding: 12px 16px; padding-bottom: max(12px, env(safe-area-inset-bottom));
  background: #14141f; border-top: 1px solid #ffffff14; color: #e9e9f2;
  box-shadow: 0 -6px 24px #00000066;
}
.aib-text { flex: 1; display: flex; flex-direction: column; line-height: 1.25; min-width: 0; }
.aib-text strong { font-size: 14px; }
.aib-text span { font-size: 12px; color: #9a9ab0; }
.aib-cta {
  background: linear-gradient(120deg, #8b5cf6, #ec4899); color: #fff; text-decoration: none;
  font-weight: 700; font-size: 14px; padding: 9px 18px; border-radius: 10px; white-space: nowrap;
}
.aib-x { background: none; border: none; color: #9a9ab0; font-size: 22px; line-height: 1; padding: 4px 8px; cursor: pointer; }
</style>
