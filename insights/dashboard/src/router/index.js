import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  { path: '/', name: 'live', component: () => import('@/views/Live.vue'), meta: { title: 'Live', icon: '◉' } },
  { path: '/self', name: 'self', component: () => import('@/views/Self.vue'), meta: { title: 'Self', icon: '🧠' } },
  { path: '/timeline', name: 'timeline', component: () => import('@/views/Timeline.vue'), meta: { title: 'Timeline', icon: '≣' } },
  { path: '/recordings', name: 'recordings', component: () => import('@/views/Recordings.vue'), meta: { title: 'Recordings', icon: '🎙' } },
  { path: '/streams', name: 'streams', component: () => import('@/views/Streams.vue'), meta: { title: 'Streams', icon: '🌊' } },
  { path: '/fleet', name: 'fleet', component: () => import('@/views/Fleet.vue'), meta: { title: 'Fleet', icon: '🖥' } },
  // Superseded by Fleet; kept so existing links/bookmarks still land somewhere sensible.
  { path: '/remote-desktop', redirect: '/fleet' },
  { path: '/usage', name: 'usage', component: () => import('@/views/Usage.vue'), meta: { title: 'Usage', icon: '▤' } },
  { path: '/system', name: 'system', component: () => import('@/views/System.vue'), meta: { title: 'System', icon: '▦' } },
  { path: '/schedules', name: 'schedules', component: () => import('@/views/Schedules.vue'), meta: { title: 'Schedules', icon: '⏱' } },
  { path: '/notifications', name: 'notifications', component: () => import('@/views/Notifications.vue'), meta: { title: 'Notifications', icon: '✦' } },
  { path: '/drafts', name: 'drafts', component: () => import('@/views/Drafts.vue'), meta: { title: 'Drafts', icon: '✎' } },
  { path: '/connectors', name: 'connectors', component: () => import('@/views/Connectors.vue'), meta: { title: 'Connectors', icon: '🔌' } },
  { path: '/integrations', name: 'integrations', component: () => import('@/views/Integrations.vue'), meta: { title: 'Integrations', icon: '🧩' } },
  { path: '/silos', name: 'silos', component: () => import('@/views/Silos.vue'), meta: { title: 'Silos', icon: '🗄' } },
  { path: '/vault', name: 'vault', component: () => import('@/views/Vault.vue'), meta: { title: 'Vault', icon: '🔒' } },
  { path: '/access', name: 'access', component: () => import('@/views/Access.vue'), meta: { title: 'Access', icon: '🔑' } },
  { path: '/settings', name: 'settings', component: () => import('@/views/Settings.vue'), meta: { title: 'Settings', icon: '⚙' } }
]

export default createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 })
})

export const NAV_ROUTES = routes
