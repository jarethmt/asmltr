// Build-time defaults for the asmltr mobile assistant. A self-hosted build overrides these (or the
// user edits them in Settings, which persists to localStorage and wins). Kept generic on purpose —
// no personal identifiers in the public repo. The install/build step can rewrite ASMLTR_DEFAULTS.
window.ASMLTR_DEFAULTS = {
  // Public base URL that reaches the android connector (…/gw/* + /health). Trailing slash optional.
  baseUrl: '',
  // Per-device token (maps to a trust identity in the connector's keys.json). Leave blank → user pastes it.
  token: '',
  // Friendly agent label shown in the header (falls back to "assistant").
  agentName: 'assistant',
};
