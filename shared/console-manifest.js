'use strict';
/**
 * The console manifest — ONE declarative source of truth for the assistant's control surfaces
 * (screens + settings + actions), consumed by BOTH the web dashboard (GUI) and the terminal TUI.
 *
 * - The GUI imports this at build time (Settings renders its fields from `settings`).
 * - The TUI `require()`s it (renders a self-generating settings screen + wires session actions).
 * - It is also served at `GET /api/manifest` (collector) for remote/other clients.
 *
 * Add a setting or action here → it shows up in BOTH the GUI and the TUI. Keep this PURE DATA
 * (no process.env / no imports) so it's safe to bundle into the browser build.
 *
 * Endpoints are declared as { service, method, path }:
 *   service: 'collector' (/api/*)  |  'core' (/v2/*)  |  'manager' (connector manager)
 * A client resolves the base per service. Request bodies use `{placeholder}` tokens the caller
 * fills at call time (e.g. {session}, {text}, {value}, {instance}, {channel}).
 */

const manifest = {
  version: 1,

  // Top-level screens. The GUI renders rich views for these; the TUI shows them as a menu.
  surfaces: [
    { id: 'live', label: 'Live', icon: '◉', desc: 'Active sessions across every surface' },
    { id: 'self', label: 'Self', icon: '🧠', desc: 'Proprioception — live parts + the deduced goal' },
    { id: 'schedules', label: 'Schedules', icon: '⏱', desc: 'Cron with a GUI — prompt jobs + shell jobs (powers the morning brief + notify)' },
    { id: 'drafts', label: 'Drafts', icon: '✎', desc: 'Replies held for human approval' },
    { id: 'fleet', label: 'Fleet', icon: '🖥', desc: 'Machines the assistant can reach — transports, grants, live sessions, revocation' },
    { id: 'settings', label: 'Settings', icon: '⚙', desc: 'Identity, runtime, updates, voice' },
  ],

  // Settings — grouped sections; each field is declarative. `type` ∈ text | textarea | toggle | choice.
  // `load` fetches the group's current values; a field reads its value at `get` (dot-path) and writes
  // via `save` (group-level, PATCH-style) or its own `set` endpoint.
  settings: [
    {
      id: 'identity', label: 'Identity', icon: '🪪',
      desc: 'Who this agent is. Asserted at the top of every session (terminal + all channels) so identity is declared, not inferred — the fix for cross-agent drift.',
      load: { service: 'core', method: 'GET', path: '/v2/identity' },
      save: { service: 'core', method: 'POST', path: '/v2/identity' }, // body = changed fields only
      fields: [
        { id: 'name', label: 'Name', type: 'text' },
        { id: 'self_description', label: 'Essence', type: 'textarea', rows: 5, desc: 'the stable core, asserted in the anchor', placeholder: 'Who you are, in your own words…' },
        { id: 'preferences', label: 'Preferences', type: 'textarea', rows: 4, desc: 'tendencies & working style (not rules; self-updatable over time)', placeholder: 'How you tend to work, what you value…' },
        { id: 'story', label: 'Story & context', type: 'textarea', rows: 5, desc: 'the narrative you carry (grows over time)', placeholder: 'Formative events, relationships, the accumulated narrative…' },
        { id: 'aesthetic', label: 'Aesthetic', type: 'textarea', rows: 3, desc: 'artistic & design sensibility — style, mood, typography (leaned on when building assets)', placeholder: 'Clean and minimal; warm tones; generous whitespace; playful but precise…' },
        { id: 'palette', label: 'Signature colors', type: 'text', desc: 'favorite colors in order (primary first) — names and/or hex, comma-separated; the default reached for when nothing else is chosen', placeholder: 'orange #FF6600, teal #2AA198, slate' },
      ],
      preview: { get: 'preamble', label: 'the anchor every session sees' },
    },
    {
      id: 'runtime', label: 'Runtime', icon: '⚙',
      desc: 'The Agent SDK gates which models are reachable — an old SDK silently pins you to an old model. Keep it current and use a model alias to track the latest.',
      load: { service: 'core', method: 'GET', path: '/v2/runtime' },
      fields: [
        {
          id: 'model', label: 'Model', type: 'choice',
          get: 'model.configured', resolvedGet: 'model.resolved', allowCustom: true,
          set: { service: 'core', method: 'POST', path: '/v2/runtime/model', body: { model: '{value}' } },
          choices: [
            { id: 'opus', label: 'Opus', hint: 'latest Opus (recommended)' },
            { id: 'sonnet', label: 'Sonnet', hint: 'faster, latest Sonnet' },
            { id: 'haiku', label: 'Haiku', hint: 'fastest, lightest' },
            { id: '', label: 'SDK default', hint: '1M-context Opus' },
          ],
        },
        {
          id: 'autoUpdate', label: 'Auto-update the SDK', type: 'toggle', get: 'autoUpdate',
          desc: 'Check every 6h and upgrade + restart automatically, so the model never silently goes stale.',
          set: { service: 'core', method: 'POST', path: '/v2/runtime/auto-update', body: { enabled: '{value}' } },
        },
        {
          id: 'cliBypass', label: 'Full-autonomy terminal sessions', type: 'toggle', get: 'cliBypass',
          desc: '`asmltr claude` (and takeovers) launch in bypass-permissions mode — no per-action approval. Off = normal permission prompts. Channel sessions always run autonomously; this is only the terminal ones.',
          set: { service: 'core', method: 'POST', path: '/v2/runtime/cli-permission-mode', body: { enabled: '{value}' } },
        },
      ],
      // read-only status widget (SDK version + an update action)
      status: {
        kind: 'sdk', installedGet: 'sdk.installed', latestGet: 'sdk.latest', availableGet: 'sdk.updateAvailable',
        action: { id: 'sdk-update', label: 'Update now', service: 'core', method: 'POST', path: '/v2/runtime/update' },
      },
    },
    {
      id: 'updates', label: 'Updates', icon: '↑',
      desc: "asmltr's own code. Updates are detected every 15 min; installing runs the deterministic updater (fetch → install → restart → verify) which health-checks and auto-rolls-back on failure — no LLM in the loop.",
      load: { service: 'core', method: 'GET', path: '/v2/update/status' },
      fields: [
        {
          id: 'auto', label: 'Auto-install updates', type: 'toggle',
          load: { service: 'core', method: 'GET', path: '/v2/update/auto' }, get: 'auto',
          desc: 'When a new commit is detected, run the update session automatically (with rollback safety).',
          set: { service: 'core', method: 'POST', path: '/v2/update/auto', body: { enabled: '{value}' } },
        },
      ],
      status: {
        kind: 'code', headGet: 'head', availableGet: 'available', behindGet: 'behind', changelogGet: 'changelog', remoteGet: 'remote',
        action: { id: 'code-update', label: 'Update now', service: 'core', method: 'POST', path: '/v2/update/run' },
      },
    },
    {
      id: 'voice', label: 'Voice', icon: '🎙',
      desc: 'Text-to-speech (how replies are spoken) and speech-to-text (how your voice is transcribed). Uses real models via the OpenAI key; changes apply to the next clip with no restart.',
      load: { service: 'core', method: 'GET', path: '/v2/voice/config' }, // { tts:{voice,model,…}, stt:{model,…} }
      fields: [
        {
          id: 'ack', label: 'Spoken acknowledgment', type: 'toggle',
          load: { service: 'core', method: 'GET', path: '/v2/voice/ack' }, get: 'enabled',
          desc: 'A short spoken "on it" plays while the agent works, so a long turn isn\'t silent.',
          set: { service: 'core', method: 'POST', path: '/v2/voice/ack', body: { enabled: '{value}' } },
        },
        {
          id: 'tts_provider', label: 'TTS provider', type: 'choice', get: 'tts.provider',
          desc: 'ElevenLabs (richer voices; needs elevenlabs_api_key) or OpenAI. The voice and model lists below update to match the selected provider.',
          set: { service: 'core', method: 'POST', path: '/v2/voice/config', body: { tts: { provider: '{value}' } } },
          choices: [
            { id: 'elevenlabs', label: 'ElevenLabs', hint: 'richer voices' },
            { id: 'openai', label: 'OpenAI', hint: 'built-in presets' },
          ],
        },
        {
          id: 'tts_voice', label: 'TTS voice', type: 'choice', get: 'tts.voice', allowCustom: true,
          desc: 'Spoken voice for read-aloud replies — the list shows the selected provider\'s voices (your ElevenLabs account voices, or the OpenAI presets).',
          set: { service: 'core', method: 'POST', path: '/v2/voice/config', body: { tts: { voice: '{value}' } } },
          choices: [
            { id: 'alloy', label: 'Alloy', hint: 'neutral, balanced' },
            { id: 'nova', label: 'Nova', hint: 'warm, bright' },
            { id: 'shimmer', label: 'Shimmer', hint: 'soft, expressive' },
            { id: 'echo', label: 'Echo', hint: 'measured, calm' },
            { id: 'fable', label: 'Fable', hint: 'storytelling' },
            { id: 'onyx', label: 'Onyx', hint: 'deep, grounded' },
            { id: 'coral', label: 'Coral', hint: 'friendly, lively' },
            { id: 'sage', label: 'Sage', hint: 'gentle, even' },
          ],
        },
        {
          id: 'tts_model', label: 'TTS model', type: 'choice', get: 'tts.model', allowCustom: true,
          desc: 'Quality vs. latency — the list shows the selected provider\'s models (ElevenLabs eleven_* models, or the OpenAI presets).',
          set: { service: 'core', method: 'POST', path: '/v2/voice/config', body: { tts: { model: '{value}' } } },
          choices: [
            { id: 'gpt-4o-mini-tts', label: 'gpt-4o-mini-tts', hint: 'newest, steerable (recommended)' },
            { id: 'tts-1', label: 'tts-1', hint: 'fast, lowest latency' },
            { id: 'tts-1-hd', label: 'tts-1-hd', hint: 'higher fidelity' },
          ],
        },
        {
          id: 'stt_model', label: 'STT model (transcription)', type: 'choice', get: 'stt.model',
          desc: 'The model that turns your microphone audio into text (voice input in the chat).',
          set: { service: 'core', method: 'POST', path: '/v2/voice/config', body: { stt: { model: '{value}' } } },
          choices: [
            { id: 'gpt-transcribe', label: 'gpt-transcribe', hint: 'newest, most accurate + cheapest (~$0.0045/min) — recommended' },
            { id: 'gpt-4o-transcribe', label: 'gpt-4o-transcribe', hint: 'previous flagship' },
            { id: 'gpt-live-transcribe', label: 'gpt-live-transcribe', hint: 'realtime streaming (live captions / fast turn dispatch) — ~$0.017/min' },
            { id: 'gpt-4o-mini-transcribe', label: 'gpt-4o-mini-transcribe', hint: 'faster, cheaper' },
            { id: 'whisper-1', label: 'whisper-1', hint: 'classic Whisper' },
          ],
        },
        {
          id: 'stt_endpoint', label: 'End-of-speech pause', type: 'choice', get: 'stt.vad_endpoint_ms',
          desc: 'On push-to-talk surfaces (the mobile overlay), how long a silence ENDS your turn. Raise this if it cuts you off when you pause between sentences.',
          set: { service: 'core', method: 'POST', path: '/v2/voice/config', body: { stt: { vad_endpoint_ms: '{value}' } } },
          choices: [
            { id: '1000', label: '1.0s', hint: 'snappy' },
            { id: '1600', label: '1.6s', hint: 'balanced (recommended)' },
            { id: '2200', label: '2.2s', hint: 'relaxed' },
            { id: '3000', label: '3.0s', hint: 'long pauses' },
          ],
        },
        {
          id: 'stt_sensitivity', label: 'Mic sensitivity', type: 'choice', get: 'stt.vad_sensitivity',
          desc: 'How readily quiet speech counts as talking. Lower it if background noise triggers it; raise it in a quiet room.',
          set: { service: 'core', method: 'POST', path: '/v2/voice/config', body: { stt: { vad_sensitivity: '{value}' } } },
          choices: [
            { id: '25', label: 'Low', hint: 'noisy places' },
            { id: '50', label: 'Medium', hint: 'default' },
            { id: '75', label: 'High', hint: 'quiet room' },
          ],
        },
        {
          id: 'wake_enabled', label: 'Wake word', type: 'toggle', get: 'stt.wake_enabled',
          desc: 'Hands-free trigger on the mobile app — say the wake phrase to open the assistant. Always-on, offline listening (uses a little battery). First enable downloads a ~40MB speech model to the phone.',
          set: { service: 'core', method: 'POST', path: '/v2/voice/config', body: { stt: { wake_enabled: '{value}' } } },
        },
        {
          id: 'wake_phrase', label: 'Wake phrase', type: 'text', get: 'stt.wake_phrase',
          desc: 'What to say to trigger the assistant (default "hey <name>"). Works instantly — offline, on-device (Vosk); no model generation. Use common words for best accuracy (uncommon names may mis-hear).',
          set: { service: 'core', method: 'POST', path: '/v2/voice/config', body: { stt: { wake_phrase: '{value}' } } },
        },
        {
          id: 'stop_phrases', label: 'Stop phrases', type: 'text', get: 'stt.stop_phrases',
          desc: 'Comma-separated. Say one (e.g. "that\'s all", "I\'m done", "thank you") to end a hands-free turn WITHOUT sending it to the assistant — the mic just turns off. Matched on the mobile app before dispatch.',
          set: { service: 'core', method: 'POST', path: '/v2/voice/config', body: { stt: { stop_phrases: '{value}' } } },
        },
        {
          id: 'wake_sensitivity', label: 'Wake sensitivity', type: 'choice', get: 'stt.wake_sensitivity',
          desc: 'How eagerly the wake word fires. Higher catches more but false-triggers more.',
          set: { service: 'core', method: 'POST', path: '/v2/voice/config', body: { stt: { wake_sensitivity: '{value}' } } },
          choices: [
            { id: '35', label: 'Low', hint: 'fewer false triggers' },
            { id: '50', label: 'Medium', hint: 'default' },
            { id: '70', label: 'High', hint: 'catches more' },
          ],
        },
      ],
    },
  ],

  // Session-scoped + global actions. `hotkey` drives the TUI; the GUI wires the same verbs in its
  // own components. `input:'text'` prompts for a message; `confirm:true` guards destructive actions.
  actions: [
    { id: 'watch', label: 'Watch', scope: 'session', hotkey: 'enter', desc: 'Live event stream for the selected session' },
    { id: 'steer', label: 'Steer / inject', scope: 'session', hotkey: 'i', input: 'text',
      desc: 'Inject a message into a live turn; the reply routes back to its origin channel',
      run: { service: 'core', method: 'POST', path: '/v2/inject', body: { conversation_key: '{session}', text: '{text}', by: 'tui' } } },
    { id: 'stop', label: 'Stop in-flight turn', scope: 'session', hotkey: 's',
      desc: 'Abort the current turn (session stays resumable)',
      run: { service: 'core', method: 'POST', path: '/v2/abort', body: { conversation_key: '{session}' } } },
    { id: 'forget', label: 'Delete / forget session', scope: 'session', hotkey: 'd', confirm: true,
      desc: 'Remove from tracking + clear history; next inbound starts fresh',
      run: { service: 'collector', method: 'POST', path: '/api/control/forget', body: { session_id: '{session}' } } },
    { id: 'code-update', label: 'Update asmltr', scope: 'global',
      run: { service: 'core', method: 'POST', path: '/v2/update/run' } },
  ],
};

// CommonJS — required by the collector (to serve /api/manifest) and the TUI. The GUI fetches the
// served copy at runtime, so there's exactly one source and no build coupling.
module.exports = manifest;
