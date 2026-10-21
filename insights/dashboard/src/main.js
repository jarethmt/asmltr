import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import './assets/main.css'
import { FontAwesomeIcon } from './icons'
import AppIcon from './components/AppIcon.vue'

const app = createApp(App)
app.use(createPinia())
app.use(router)
// Global icon components: <font-awesome-icon> for explicit icons, <AppIcon :glyph> to translate a
// source emoji/symbol (manifest, format.js, router) into its Font Awesome equivalent.
app.component('FontAwesomeIcon', FontAwesomeIcon)
app.component('AppIcon', AppIcon)
app.mount('#app')


// Portal background relay (docs/PORTAL-DRIVE.md §2 + DESIGN §5): in the native app, opportunistically
// auto-connect to a paired Portal dongle and relay portal.exec/portal.io. Self-guards to native-only
// (no-op in a desktop browser) and is battery-cheap (connect-on-demand, long presence interval). The
// server message channel is wired separately — see portalRelay.js setServerSink()/handleServerMessage()
// and its TODO(relay) markers; until that's wired this stays dormant.
import { startPortalRelay } from './services/portalRelay'
startPortalRelay()


// PWA: register the service worker so the dashboard is installable (and can receive push /
// show notifications). Served from public/sw.js; failures are non-fatal (e.g. plain http dev).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}
