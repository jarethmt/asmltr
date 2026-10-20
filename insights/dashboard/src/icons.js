// Central Font Awesome registry + a glyph→icon map.
//
// The dashboard's icons are sourced from several places that must stay emoji for portability:
//   - the shared console-manifest (also drives the terminal TUI, which can't render SVG),
//   - lib/format.js surface/event metadata,
//   - router meta.icon.
// Rather than fork those, we keep the emoji at the source and translate to a proper Font Awesome
// glyph at RENDER time via <AppIcon :glyph="…">. Unknown glyphs fall back to the raw character, so
// nothing ever disappears. Component-local icons pass the same emoji and get the same treatment.
import { library } from '@fortawesome/fontawesome-svg-core'
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import {
  faCircleDot, faBrain, faStream, faChartColumn, faServer, faMicrophone, faBell, faBellSlash,
  faPenToSquare, faPlug, faKey, faGear, faIdCard, faArrowUp, faGlobe, faMobileScreenButton,
  faKeyboard, faDesktop, faCircle, faAngleRight, faCommentDots, faWrench, faTriangleExclamation,
  faInbox, faShieldHalved, faPaperclip, faVolumeHigh, faVolumeOff, faMagnifyingGlass,
  faHourglassHalf, faRotate, faRotateLeft, faXmark, faCheck, faCircleInfo, faPlay, faStop,
  faCircleArrowUp, faCircleCheck, faCircleXmark, faCoins, faSitemap,
  faBolt, faLock, faTrashCan, faBan, faFolderOpen, faHeadphones, faScrewdriverWrench,
  faStopwatch, faWindowMaximize, faBars, faDownload, faFileLines, faAngleLeft, faComments, faPuzzlePiece,
  faDatabase, faRightFromBracket, faLayerGroup, faTowerBroadcast,
} from '@fortawesome/free-solid-svg-icons'
import { faDiscord, faTelegram, faGithub } from '@fortawesome/free-brands-svg-icons'

library.add(
  faCircleDot, faBrain, faStream, faChartColumn, faServer, faMicrophone, faBell, faBellSlash,
  faPenToSquare, faPlug, faKey, faGear, faIdCard, faArrowUp, faGlobe, faMobileScreenButton,
  faKeyboard, faDesktop, faCircle, faAngleRight, faCommentDots, faWrench, faTriangleExclamation,
  faInbox, faShieldHalved, faPaperclip, faVolumeHigh, faVolumeOff, faMagnifyingGlass,
  faHourglassHalf, faRotate, faRotateLeft, faXmark, faCheck, faCircleInfo, faPlay, faStop,
  faCircleArrowUp, faCircleCheck, faCircleXmark, faCoins, faSitemap,
  faBolt, faLock, faTrashCan, faBan, faFolderOpen, faHeadphones, faScrewdriverWrench,
  faStopwatch, faWindowMaximize, faBars, faDownload, faFileLines, faAngleLeft, faComments, faPuzzlePiece,
  faDatabase, faRightFromBracket, faLayerGroup, faTowerBroadcast,
  faDiscord, faTelegram, faGithub,
)

// glyph (as it appears in data/source) -> ['prefix', 'icon-name']. Variation-selector-16 (U+FE0F)
// is stripped before lookup so '✈️' and '✈' both match.
const GLYPH_TO_FA = {
  // ---- navigation + manifest settings tabs ----
  '◉': ['fas', 'circle-dot'],       // Live
  '🧠': ['fas', 'brain'],            // Self / observer
  '≣': ['fas', 'stream'],           // Timeline
  '▤': ['fas', 'chart-column'],     // Usage
  '▦': ['fas', 'sitemap'],          // System
  '🎙': ['fas', 'microphone'],       // Voice
  '✦': ['fas', 'bell'],             // Notifications
  '✎': ['fas', 'pen-to-square'],    // Drafts / edit
  '🔌': ['fas', 'plug'],             // Connectors / mcp
  '🧩': ['fas', 'puzzle-piece'],     // Integrations (third-party services)
  '🗄': ['fas', 'database'],          // Silos (data silos / file explorer)
  '🌊': ['fas', 'layer-group'],       // Streams (topic event streams)
  '⎋': ['fas', 'right-from-bracket'], // Sign out
  '🔑': ['fas', 'key'],              // Access
  '⚙': ['fas', 'gear'],             // Settings / control
  '🪪': ['fas', 'id-card'],          // Identity tab
  '↑': ['fas', 'arrow-up'],         // update available
  // ---- surfaces / channels (lib/format.js) ----
  '💬': ['fab', 'discord'],
  '✈': ['fab', 'telegram'],
  '🌐': ['fas', 'globe'],
  '📱': ['fas', 'mobile-screen-button'],
  '🐙': ['fab', 'github'],
  '⌨': ['fas', 'keyboard'],
  '🖥': ['fas', 'desktop'],
  '🌀': ['fas', 'tower-broadcast'],   // Portal (BLE dongle — advertises to be discovered)
  '•': ['fas', 'circle'],
  // ---- session event / activity icons ----
  '›': ['fas', 'angle-right'],
  '💭': ['fas', 'comment-dots'],
  '🔧': ['fas', 'wrench'],
  '⚠': ['fas', 'triangle-exclamation'],
  '📥': ['fas', 'inbox'],
  '🛡': ['fas', 'shield-halved'],
  '∑': ['fas', 'coins'],
  '●': ['fas', 'circle'],
  '○': ['fas', 'circle'],
  '🔔': ['fas', 'bell'],
  '🔕': ['fas', 'bell-slash'],
  // ---- controls / status glyphs ----
  '⬆': ['fas', 'circle-arrow-up'],
  '📎': ['fas', 'paperclip'],
  '🔊': ['fas', 'volume-high'],
  '🔈': ['fas', 'volume-off'],
  '⏺': ['fas', 'circle-dot'],
  '🔍': ['fas', 'magnifying-glass'],
  '⏳': ['fas', 'hourglass-half'],
  '↻': ['fas', 'rotate'],
  '↩': ['fas', 'rotate-left'],
  '✕': ['fas', 'xmark'],
  '✗': ['fas', 'circle-xmark'],
  '✓': ['fas', 'check'],
  'ⓘ': ['fas', 'circle-info'],
  'ℹ': ['fas', 'circle-info'],
  '▶': ['fas', 'play'],
  '◀': ['fas', 'angle-left'],
  '⏹': ['fas', 'stop'],
  '⏱': ['fas', 'stopwatch'],
  '⬇': ['fas', 'download'],
  '⚡': ['fas', 'bolt'],
  '🔒': ['fas', 'lock'],
  '🗑': ['fas', 'trash-can'],
  '🚫': ['fas', 'ban'],
  '📂': ['fas', 'folder-open'],
  '🎧': ['fas', 'headphones'],
  '🛠': ['fas', 'screwdriver-wrench'],
  '▣': ['fas', 'window-maximize'],
}

export function faFor(glyph) {
  if (!glyph) return null
  return GLYPH_TO_FA[String(glyph).replace(/️/g, '')] || null
}

export { FontAwesomeIcon }
