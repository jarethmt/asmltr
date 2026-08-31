# Changelog

All notable changes to asmltr are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and asmltr uses [Semantic Versioning](https://semver.org/).

Releases are git tags `vX.Y.Z`. The `stable` update channel tracks the latest tag; the `edge`
channel tracks `origin/main`. See [docs/UPDATER-DESIGN.md](docs/UPDATER-DESIGN.md).

## [Unreleased]

### Added
- **Email `--new-thread`.** Blank new letter: no last-inbound quote, no `In-Reply-To`/`References`, no reply-all merge. `--no-reply-all` still only drops extra recipients and still quotes this thread. Sidebar (other customers / personal / internal SKUs) and customer mail after a tainted chain use `--new-thread` so Gmail does not staple that history. Clean human reply-all is unchanged. 31 Aug 2026.

### Changed
- **Email signature image.** After `AI Assistant to …`, two blank lines, then a markdown image, then the Example Co pitch with no extra blank. HTML is 96×96, block, flush above the pitch. `cid:assistant-sig` is mailed inline (`signature_image` path); https images still render. javascript: image URLs are dropped. Inbound quote sanitizer still strips quoted `cid:` so we do not replay someone else's inline parts.
- **Same-guild Discord post is `asmltr send`.** Confirm-first name lookup, on-behalf-of preface, and fuzzy channel match stay. Capability is trusted role or `resolve()` allow (`guild-post` / `send` / `*`). `asmltr guild-post` is a CLI alias of send. Discord/Telegram `/out` and manager `/send` use public attach-stage. Host path deny-list is overlay `hostGate` on manager `/send` and Discord `/out`.
- **Stop actually halts send/voice/stream/inject.** Those paths register a processing abort target. Starter may abort their turn (not owner-only). SDK `/v2/abort` can pass speaker/starter/owner so a host overlay can fail-closed.

### Removed
- **extras/host-local Rolodex MCP.** Contacts are gworkspace People API. `register.sh` no longer adds Rolodex or a rolodex sync timer. Host dumps under `~/rolodex` / `~/.asmltr/rolodex-cache/` are left on disk.

### Fixed
- **Email: reply-all drops automated senders.** `noreply` / `no-reply` / `alerts@` / `notifications@` are not people on the chain (26 Aug 2026). Real vendor employees stay. Staff outreach from an automated-alert turn still uses `--no-reply-all`.
- **Email: do not owner-forward thread participants as strangers.** A From that is already on the chain (In-Reply-To/References + we are To/Cc), stored on the persisted thread, or present in the optional Rolodex/contacts file creates a turn. Cold mail from an address we have never seen still forwards to `owner_forward_to`.
- **Email: no auto-reply of session text.** The connector no longer SMTPs the assistant `reply` action. Letters go out only via `asmltr send` / `/out` (in context: spoken to, or told to do something). CC-only chains are listen-unless-asked. `owner_forward_to` is still a visible Cc when To is someone else. No 30-minute duplicate timer.
- **Email: chain reply-all.** `/out` with a thread `ref` keeps everyone on inbound From/To/Cc (minus the mailbox). `--drop` / `--no-reply-all` only if asked to omit someone. `asmltr send email` from an email turn passes the conversation `ref`.
- **Email signature pitch** (Gaia): extra blank before the name; name and `AI Assistant to …` on adjacent lines; two blanks; then `[Example Co](https://example.com) can build an AI assistant like this for your team.` HTML keeps consecutive blank source lines (`&nbsp;` paragraphs) so Gmail does not collapse `\n\n\n` to one gap.

### Added
- **Example configs for gaia exceptions (no PII):** `shared/media-allow.example.json`; Access-card `friend` (`default_tier` 3) in `seed.example.json` / `seed.gaia.example.json`; `ASMLTR_IMAGE_GEN_CLASSIFY` + `ASMLTR_MEDIA_ALLOW_FILE` in `.env.example` / `env.gaia.example`.
- **`asmltr guild-post` name lookup** also indexes threads on regular text/announcement channels (not only forums) and media channels.
- **`asmltr bounce`:** queue a core+manager+collector restart until the current turn ends (then a short delay so Discord/email can post the reply). Inline `systemctl`/`pm2` restarts of the asmltr stack from a live turn are rewritten to the same queue. `--now` is refused inside a turn.

- **Chunked file uploads.** `POST /v2/upload/init`, `PUT /v2/upload/:id/:index` (raw
  `application/octet-stream`), `GET /v2/upload/:id`, `POST /v2/upload/:id/finish`, and
  `DELETE /v2/upload/:id`, backed by `beginChunked` / `putChunk` / `chunkStatus` / `finishChunked` /
  `abortChunked` / `sweepPartials` in `shared/uploads.js`. The wire unit is a chunk instead of the
  file, so upload size is no longer bounded by a body limit anywhere on the path. Chunks stage under
  `<staging>/<id>/` and are assembled one at a time, so the server holds one chunk rather
  than the whole file; nothing is written to the manifest until `finish` verifies the assembled
  length against both the declared size and the bytes that actually reached the disk, so `list()` can
  never hand the agent a path to a half-written file. Content is verified per chunk via
  `X-Chunk-Sha256`, which keeps the integrity check honest without hashing the whole file (hashing
  the whole file would mean holding it, the thing chunking exists to avoid); a whole-file `sha256` is
  still accepted from clients that know it. Retried chunks are idempotent, a chunk index that is not
  a plain integer is rejected before it reaches a path, and staging left by abandoned uploads is
  swept hourly past a 24 hour TTL. Tuning: `ASMLTR_UPLOAD_CHUNK_SIZE` (default 8 MiB),
  `ASMLTR_UPLOAD_MAX_CHUNK` (default 64mb), `ASMLTR_UPLOAD_MAX_SIZE` (default 128 GiB).
- **`uploads.saveFrom({ tempPath, … })`.** Registers a file already on disk by moving it into the
  shared area, so a file no longer has to fit in a Buffer to be registered. `save()` is unchanged for
  connectors, which already hold Buffers.

- **File routes take raw bytes, not only base64 in a JSON body.** `POST /v2/upload`,
  `POST /v2/silos/:id/file` and `POST /v2/transcribe` now accept the file as the request body with
  its metadata in the query string, the shape `POST /v2/recordings` and `POST /v2/backups/import`
  already used. The JSON `data_base64` form still works, so no existing client breaks. New knob
  `ASMLTR_RAW_BODY_LIMIT` (default `1024mb`) bounds a raw body, and a body over it returns JSON
  naming the limit instead of an HTML stack trace.

### Changed

- **The composer uploads in chunks, with real progress.** `webChat.upload(file, key, { onProgress })`
  sends `file.slice()` chunks over XHR (fetch exposes no upload progress event) and retries a failed
  chunk with backoff instead of failing the whole file. Each file in a multi-file pick gets its own
  progress row; previously one shared `notice` meant five files with three failures showed a single
  message about the last one.
- **Chunks stage outside the Self silo.** `ASMLTR_UPLOAD_STAGING_DIR`, default
  `~/.asmltr/uploads-partial`, replaces the old `<uploads>/.partial`. Since uploads moved into the Self
  silo, staging under the upload area put in-flight partials inside the tree `scripts/backup.js` copies
  wholesale, so an upload abandoned mid-transfer rode into every snapshot taken before the 24 hour
  sweep reaped it, at full file size, and showed up in the Silos GUI as a half-written blob. Backups
  now skip the staging directory as well as `backups/`. Staging belongs on the same filesystem as the
  upload area: `finish` renames the assembled file into place, and across a mount boundary `saveFrom()`
  falls back to copy-then-unlink. Second effect: the silo now sees exactly one raw-path write per
  upload (the move-in) rather than one per chunk, which is the whole surface the artifacts-via-driver
  follow-up has to convert to `Silo.put`.
- **`/rd/` keeps its own 1 MiB body limit.** The remote-desktop signaling broker is deliberately not
  behind the session `auth_request`, and it would otherwise inherit the server-level `1024m` this
  release adds, handing an unauthenticated route a 1 GiB body budget as a side effect of an upload
  change. Pinned to the limit it already ran under. Signaling frames are SDP and ICE candidates.

- **The dashboard sends files as bytes.** The Silos browser's upload button and the voice
  transcription path both posted base64 inside a JSON body, which `express.json({ limit: '10mb' })`
  capped near 7.5 MiB of actual file: measured against that parser, 7,864,000 bytes is accepted and
  7,900,000 is not. Uploading a 10 MB file into a silo failed with `413 Payload Too Large` and no
  size named anywhere the user could see it. Both now send the file itself.

### Fixed

- **Uploads were capped at 767.9 KiB, not the 10 MB the core advertised.** `client_max_body_size` was
  absent from `insights/dashboard/nginx.conf.template`, so nginx applied its 1 MiB default, and the
  base64 JSON body spent a third of that on encoding: 786,327 bytes uploaded and 786,522 failed. An
  ordinary 3 MB phone photo returned `413 Request Entity Too Large` with no size named anywhere in the
  UI or the docs. The same default capped `POST /v2/backups/import` at 1 MiB despite its `limit:
  '1024mb'`, making GUI backup import fail for any real archive. The directive is now set to `1024m`
  at **server** level. Both parts matter: scoping it to `location /v2/` is not enough, because
  `auth_request` runs its check as a subrequest against `location = /_asmltr_authz`, which applied its
  own inherited 1 MiB limit and turned every chunk into a 500; and the value has to match the core's
  own ceiling for `/v2/backups/import`, because that route is not chunked and posts its archive as a
  single body, so whatever is set here is the real backup-import cap.
  ([#91](https://github.com/jarethmt/asmltr/issues/91))

- **Upload failures are no longer silent or misreported.** A manifest append that fails now logs
  instead of being swallowed, so a file that lands on disk without an index says so. Server-side
  faults (`ENOSPC`, `EACCES`) are logged with the upload id and answered with a generic message
  rather than a 400 or an absolute host path in the response body. A `readdir` failure on a staging
  dir is no longer reported as "every chunk is missing", a corrupt `meta.json` is no longer reported
  as "unknown upload", an oversized chunk returns JSON rather than an Express stack trace, and a
  sweep that fails on every directory no longer looks identical to a sweep with nothing to do.

## [0.16.1] - 2026-08-24

- **CI is back on the Node 24 line, unpinned.** v0.14.1 pinned `node-version: 24.18.0` to dodge the
  `(env) != nullptr` teardown abort. With better-sqlite3 on 13.x (N-API) that abort cannot fire, and
  keeping the pin meant nothing ever exercised 24.19 — the version the host will eventually run, which
  is the exposure the N-API move was for. CI now resolves `24` again.

### Added

### Changed

### Fixed
- **Discord "email me that" no longer sits on Working and sends twice.** After a mid-turn context cut the origin session distrusted the compaction summary, grepped for proof, and SMTP'd the same reminder again. `asmltr send` now refuses the same email To+subject for 30 minutes (`--force` only if they said it never arrived). Toolbelt: send, confirm here, end the turn — do not wait on another session.
- **Moderation no longer spends 2–3.5s reasoning on every inbound.** Default classifier `gpt-5-nano` is a reasoning model; the OpenAI call now sets `reasoning_effort: 'minimal'` on gpt-5-family models only (override `ASMLTR_MODERATION_REASONING_EFFORT`; empty/`off`/`none` disables). Decision logs include `duration_ms`. A model that rejects the field is retried without it.
- **Discord "Working" lock after a mid-turn bounce.** Still-working heartbeat is always cleared in `finally`, even when `/v2/stream` errors because core died.
- **Voice speaker identity (#148).** In a multi-person voice call Eve addressed everyone as one person and applied the wrong trust tier, because the voice path passed the speaker's display name as `sender.raw_id` (matches no identity mapping → resolved `default`/tier 0). The speaker's immutable Discord user ID now rides through to `sender.raw_id` (same key the text path uses), so each turn resolves the correct principal + trust — the person who said her name. Verified: user ID → the real principal (tier 1); display name → default (tier 0).
- **"Eve, stop" now actually halts an in-flight realtime reply (#149).** Stop/barge-in fired and aborted, but the reply still spoke ~10s later when the LLM turn finished after the abort. `speak()` now requires a live speech session, and a per-guild reply generation (bumped on stop) makes the in-flight reply bail before synthesizing/speaking/posting even if generation completes after the abort.

## [0.16.0] - 2026-08-24

### Added
- **Persistent voice mute (P2).** Eve can now be muted from *inside* voice — say "<name>, mute" (or `@bot mute-voice` from text) and she keeps transcribing but never speaks/replies until "<name>, unmute" (or `@bot unmute-voice`). Voice parity with the text disable; distinct from the transient `stop`. Clears on leaving voice.

### Changed
- **Discord voice turn-taking honors the shared VAD tunables (#141).** End-of-speech silence and the near-silent gate now come from `stt.config` (`vad_endpoint_ms` / `vad_sensitivity`) instead of a hard-coded 1s, so Discord tunes identically to the app from Settings → Voice. Closes epic #135.

### Fixed

## [0.15.0] - 2026-08-24

### Added
- **Realtime streaming transcription for Discord voice (#140).** Discord voice streams each speaker's audio into the shared OpenAI GA Realtime STT over a WebSocket (`shared/speech/realtime-stt.js`) using the **live streaming model** (`gpt-live-transcribe`), so captions fill in **as you speak** rather than after you stop. Each turn is finalized on Discord's end-of-speech by committing the audio buffer, which flushes the tail and yields a clean per-turn transcript — so overlapping speakers thread by who-started-first. The sliding-window partials are reconstructed into a running transcript (`mergeWindow`). No new dependency (Node's global WebSocket + the ephemeral-token subprotocol). Per-speaker sessions persist across short pauses and idle-close after prolonged silence. Toggle with `voice_realtime` (batch per-utterance STT remains the fallback).

### Changed
- **Discord realtime STT is wired through the `realtime_transcribe` voice-engine role** (#113/#140), not a hard-coded model — Settings picks the engine, with a guard that falls back to the live streaming model if the bound engine isn't realtime-capable (e.g. a diarize model). `openai-live-transcribe` is now marked implemented and is the default `realtime_transcribe` binding.

### Fixed
- **Realtime audio was silently garbled by a downsampler byte-offset bug** (audio flowed to the API but nothing came back). The 48k-stereo→24k-mono conversion stepped 4 bytes per output sample instead of 8, feeding the transcriber time-distorted samples from only the first half of each buffer. Pinned with a regression test.

## [0.14.1] - 2026-08-24

### Added

### Changed

### Fixed
- **CI green again — pinned CI to Node 24.18.0.** Node 24.19.0 has a teardown regression that trips `Assertion failed: (env) != nullptr` in `RemoveEnvironmentCleanupHook` when better-sqlite3's native Statement finalizers run on process exit, crashing `session-resume-recovery.test.js` (every assertion passed — only the exit crashed; red on `main` since PR #114). The `test` workflow now pins `node-version: 24.18.0`; the test also closes its sqlite handle in an `after` hook as hygiene.

## [0.14.0] - 2026-08-24

### Added
- **Shared, confidence-gated wake matcher (`shared/speech/wake.js`).** One deterministic wake/direct-address matcher for every voice surface, with a confidence gate that refuses to fire a turn on a low-confidence or bare-lone-name match — killing the false-trigger bug where a mis-transcribed word made the assistant reply when its name wasn't actually said. Confidence derives from STT token logprobs; the bar scales with `wake_sensitivity`. (#136)
- **Cross-surface interrupt / barge-in for Discord voice.** One hard-stop primitive behind three entry points (#138): a spoken "<name>, stop" (or any configured stop phrase), talking over a reply (low-latency barge-in, no STT round-trip), and text `@bot stop` — which now fans the stop through to a live voice session joined from that channel. Barge-in is toggleable (`voice_barge_in`) and has a short grace window so the asker's own trailing words don't cut off the reply.

### Changed
- **Discord voice STT now routes through the pluggable voice-engine role layer** (`voice-engines.resolve('transcribe')`) instead of a hard-wired model, so a Settings change swaps the engine with no connector edit — with a safe fallback when the bound engine needs a different endpoint shape (e.g. diarize). (#139)

### Fixed
- **Scaffolding/classifier text no longer leaks into voice transcripts** (#137). Dropped the name-priming STT prompt on the Discord path (it biased the decoder toward mis-hearing the wake word *and* got echoed into transcripts on near-silent audio) and added shared prompt-echo suppression in `shared/speech/stt.js` for any surface that still passes a prompt.

## [0.13.1] - 2026-08-18

Dashboard chat now renders assistant replies as sanitized Markdown (bold, lists, code, links) instead of raw asterisks. Streaming turns stay plain and format on completion.

### Added
- **Rendered Markdown in the dashboard chat.** Assistant replies now render Markdown — bold, lists, code, headings, links — instead of showing raw `**asterisks**`. Output is sanitized with DOMPurify before insertion. A streaming turn stays plain text (partial tokens make half-open markdown flicker) and formats once the turn completes.

### Changed

### Fixed

## [0.13.0] - 2026-08-16

Custom WebRTC remote desktop — view and drive a host machine's screen from the app, over a self-owned signaling + NAT-hole-punching transport (no external overlay).

### Added
- **Remote desktop (custom WebRTC).** New `remote-desktop` connector = a signaling broker (SDP/ICE relay + own STUN + per-host view/control trust grants, default-deny). A native Windows host agent (`agents/host-remote-desktop/` — Go + Pion, self-contained bundled ffmpeg) captures the desktop and publishes H.264 over WebRTC. The assistant app is the viewer + controller (touch→mouse, on-screen keyboard, PiP). **Media flows peer-to-peer via ICE hole punching — asmltr negotiates but never relays** (optional TURN fallback is off by default; symmetric-NAT-on-both-ends only).
- **Cast to device.** The dashboard (and the assistant) can push an `open-remote-desktop` directive to a device so it opens a host's live stream; the same channel carries screenshots/streams to a device in-session.
- Design: `docs/REMOTE-DESKTOP.md`.

### Notes
- The Windows host agent must run in the **interactive console session** (a scheduled task with an Interactive principal) — screen capture can't reach the desktop from a service/SSH session. Default capture backend is **gdigrab** (captures a static/idle screen); **ddagrab** (GPU) is opt-in and only emits frames when the screen changes.

## [0.12.3] - 2026-08-13

### Fixed
- **Live transcription no longer double-transcribes or runs while the mic is off.** `startRealtimeSTT` is
  async (token mint + SDP round-trip); a short utterance could end before setup finished, so the connection
  opened *after* stop — transcribing with the mic off (token burn) and stacking a second stream on the next
  listen (the "everything comes back twice" doubling). A generation guard now closes any superseded/in-flight
  session and tears the peer down on every listen-end path, so there is never a live realtime session unless
  listening is active.

## [0.12.2] - 2026-08-13

### Fixed
- **Live transcription now connects (GA endpoint) with the right model.** The SDP exchange used OpenAI's
  retired beta endpoint (`/v1/realtime?intent=transcription` → HTTP 400 "beta API is no longer supported");
  it now posts to the GA `/v1/realtime/calls`. The realtime role also mints **gpt-live-transcribe** (the
  streaming model, no server_vad) instead of the batch gpt-4o-transcribe, aligning with the voice-engine
  role split (epic #113). The client no longer sends a redundant session.update — the session is configured
  in the minted ephemeral secret.

## [0.12.1] - 2026-08-13

### Fixed
- **Live transcription now actually transcribes.** The WebRTC transcription session was never sent its
  `session.update` config over the data channel, so it connected but emitted nothing (the "enabled but no
  caption" bug). It now configures the session (model + server_vad) on data-channel open, and surfaces
  OpenAI's error events + SDP failures visibly (instead of silently falling back) when live STT is enabled.

## [0.12.0] - 2026-08-13

Assistant-app overlay overhaul: multi-session tabs, sub-agent visibility, live streaming transcription, and a batch of voice-UX fixes.

### Added
- **Multi-session tabs in the assistant app.** The overlay can hold several live sessions at once — a tab
  strip switches between them without closing any. The device holds one gateway SSE; the connector now tags
  every frame with its conversation key and the app demultiplexes that stream into per-session tabs. The
  active tab renders live and drives TTS; background tabs keep streaming and buffer their frames (replayed
  silently on activation), so no in-flight state is lost on switch and only the active tab speaks.
- **Sub-agent visibility panel.** The Claude engine detects Task sub-agent start/stop from the SDK stream
  and surfaces it via a new `onSubagent` callback; the core records a `subagent` event + streams a frame,
  and the app renders a live per-turn panel (running ● → stopped ✓). Capability-gated — only engines with a
  sub-agent concept emit it, so Codex/Gemini never show the panel. View-only (the SDK exposes no per-sub-agent kill).
- **Live streaming transcription in the overlay.** A device-gated `/gw/realtime-token` mints an ephemeral
  OpenAI realtime-transcription secret (the real key never leaves the host); the overlay opens a WebRTC
  transcription session and paints a live caption as you speak, finalizing on endpoint. Falls back silently
  to batch transcription when disabled or unavailable.
- **Setting: "Auto-listen when the overlay opens" (default off).** A plain overlay open no longer forces the
  mic on — you can just type; an assist-gesture launch still opens straight into listening.
- **Distinct stop-turn feedback.** Killing an in-flight turn now plays a recognizable cue and shows a
  "⏹ turn stopped" line, matching the existing listen/stop-listening sounds.

### Fixed
- **VAD no longer cuts you off mid-sentence.** The noise floor keeps adapting during pauses, a minimum-utterance
  guard prevents endpointing in the first second of speech, the relaxed sensitivity/endpoint settings are
  honored, and endpointing requires sustained (not flickering) silence.
- **Listening-mode eyes are noticeably whiter/brighter** so it's obvious the mic is hot.

## [0.11.1] - 2026-08-13

Follow-up fixes to the outbound-attachment feature, from on-device testing.

### Fixed
- **Assistant-app chat history now replays turn text.** Android turn events (user text, thinking, tool
  steps, assistant reply) were emitted under the surface `android`, which isn't a valid event surface, so
  they were dropped and never persisted — only attachments (emitted under `assistant-native`) survived, so
  reopening the overlay restored images but not the conversation. Turn events now persist under
  `assistant-native` and replay on reopen.
- **`asmltr send android <identity>` reaches the device and reports honestly.** The file path matched only
  by device id, so sending to an identity (e.g. `owner`) silently matched no live stream yet returned
  success. It now resolves an identity to every connected device for that identity, and a zero live-delivery
  reports `ok:false` (the record still replays on reconnect) instead of a false success.

### Added
- **Full-screen image viewer in the assistant app.** Tapping an inline image opens it over the chat with a
  close button, tap-the-backdrop / Escape / hardware-back to dismiss — instead of opening trapped inside the
  overlay with no way back.

## [0.11.0] - 2026-08-13

asmltr 0.11.0 — channel-agnostic outbound file/image attachments, rendered inline in the assistant app and the dashboard.

### Added

- **Channel-agnostic outbound file & image attachments.** `asmltr send <channel> <target> --file <path>`
  and `asmltr notify --file <path>` now deliver images and files across every capable connector.
  Outbound standardizes on a single `kind:'file'` send that each connector maps to its native transport
  (Telegram photo/document, Discord attachment, email MIME) — the same symmetry inbound already had.
- **The Android app receives attachments inline.** The `android` connector gained a token-gated
  `GET /gw/file` endpoint (opaque id → allow-listed path, no traversal) plus a `media` SSE frame, and
  declares `supports_attachments_out`. The assistant app renders images inline in the chat thread and
  replays them from history; non-image files show as a tappable chip.
- **The dashboard renders image artifacts inline** in the chat thread; other files keep the download chip.
- **`notify --file`** delivers an image to a reachable device as inline media, and otherwise sends the
  actual file through the text-fallback channel (falling back to text if that channel can't attach).

### Fixed

- **Telegram outbound files.** A `kind:'file'` send now routes by MIME to `sendPhoto`/`sendDocument`
  instead of falling through to an empty text message (which Telegram rejected with "message text is empty").

## [0.10.1] - 2026-08-05

### Added

- **Release builds for the mobile app.** `mobile/build.sh release` produces a signed, 16 KB-aligned APK
  at `mobile/dist/asmltr.apk` via the new `mobile/scripts/package-apk.sh` (zipalign **then** apksigner —
  aligning after signing would invalidate the signature). The keystore comes from
  `ASMLTR_ANDROID_KEYSTORE`; it must be the same key previous releases used, otherwise the update cannot
  install over an existing app and users lose their data. Requires build-tools >= 35.0.1 for `zipalign -P`.

### Changed

- **The android connector serves a release APK when one exists.** `/app/gw/download` now prefers
  `mobile/dist/asmltr.apk`, then the gradle release output, and only falls back to the debug build
  (still overridable with `ASMLTR_ANDROID_APK`). Shipping a debug APK made Android show an
  "App Compatibility / debuggable app" warning on launch and left the app's private data readable
  through `run-as`.

### Fixed

- **16 KB page-size compatibility (Android 15+).** Devices that boot with 16 KB memory pages refused to
  accept the app's native libraries: `libvosk.so` shipped 4 KB-aligned LOAD segments, and because
  `minSdk` was 22 the libs had to be packaged compressed (`extractNativeLibs=true`), which Android could
  not verify. Fixed by pinning `vosk-android` to 0.3.75 (16 KB-aligned upstream), raising `minSdk` to 23
  so JNI libs can be stored uncompressed (`useLegacyPackaging false`), and aligning every `.so` to a
  16 KB boundary at packaging time. All three arm64 libraries now report `0x4000` alignment. These are
  applied by `scripts/patch-android.js`, which owns the generated Gradle project.

## [0.10.0] - 2026-08-04

asmltr 0.10.0 — generic `device` connector: a platform-agnostic HTTP+SSE+token gateway that makes any networked device (Pi kiosk, ESP32, desk buddy) a first-class channel, with server-proxied speech and change-only capability descriptors. The android connector is unchanged; platform connectors layer extras on this base.

### Added

- **`device` connector — a generic device gateway.** The platform-agnostic base the `android`
  connector's gateway proved out, minus anything OS-specific: an HTTP + SSE + token surface that makes
  any networked device (a Pi kiosk, an ESP32, a desk buddy, a custom appliance) a first-class channel —
  its turns run through the core (identity/trust, moderation, sessions, redaction, event stream), so it
  shows up in `asmltr map`/`ls`, is takeover-able, and `asmltr send device <id>` / announcements /
  steer / read-aloud push to it. Speech is proxied (`/gw/transcribe` + `/gw/tts`) so a thin client
  needs no on-device speech stack or keys. Per-device **capabilities** (screen dims, audio in/out)
  inject a one-line surface descriptor into the turn's `system_prompt_extra` **only when they change**
  (never per-turn). `conversation_scope` picks one thread per device or one continuous thread per user
  across their devices. Platform connectors (`android`, iOS later) layer their extras on this base; the
  live `android` connector is unchanged. `connectors/types/device/`, docs at `connectors/device.md`.

### Changed

### Fixed

## [0.9.2] - 2026-08-04

Discord mid-turn steering + @<assistant> stop; full-length conversation history (no more 500-char truncation); mobile 0.8.10 orb/eyes refresh + floating notification eyes.

### Added

- **Discord: mid-turn steering + a `@<assistant> stop` interrupt.** A message that arrives while a
  turn is already running in a channel is no longer dropped — if it's addressed to the assistant it's
  queued into the running turn as guidance (via `/v2/inject`, folded into the work in progress and
  continued, like typing mid-task in a CLI), and `@<assistant> stop` (also `cancel`/`abort`/`halt`)
  interrupts the in-flight turn via `/v2/abort` (the session survives and stays resumable). Adds
  `core.abort()` / `core.inject()` to the connector SDK.

### Changed

- **Full-trust principals now get deference alongside capability in the system prompt.** Granting
  `*` / `bypass_moderation` told the model what an operator MAY ask for but said nothing about what
  to do when the model disagrees — so it could re-litigate a settled decision turn after turn,
  refusing an authorized instruction while the moderation layer logged `ALLOW` every time (an
  assistant-side judgment loop, not a permission gate). The `bypass_moderation` branch of
  `buildAuthzPrompt()` now appends an explicit escalation rule: raise a concern once, treat a
  reaffirmed instruction as the decision, verify any checkable premise before refusing, and reserve
  hard stops for the genuinely irreversible or unlawful. Offering a safer method is encouraged;
  withholding the outcome is not.
- **Mobile app (0.8.10): assistant orb refresh.** Notification "eyes" that float over the screen while
  `notify` reads a message aloud; a softer, more organic single-hue glowing orb whose eyes react to
  the live mic while listening and to the decoded speech envelope while replying; and the orb now
  floats over the bottom of the chat instead of taking its own row.

### Fixed

- **Conversation history is no longer truncated.** Inbound/outbound event text doubles as the stored
  conversation record that surfaces (e.g. the mobile app) replay as history, but was clipped to a
  telemetry-sized preview (500 chars; 200 for the android device emit), so long messages were cut off
  when loaded from the conversation list. Conversational text is now kept effectively full (100k).

## [0.9.1] - 2026-07-29

asmltr 0.9.1 — complete package-lock.json (resolved+integrity) so deterministic updates npm ci in seconds instead of a ~40-minute npm install fallback. (#48)

### Added

### Changed

### Fixed

- **`package-lock.json` completed with `resolved` + `integrity` so `npm ci` works.** 614 external
  entries carried only a pinned `version`, so every deterministic update's `npm ci` failed on lock
  drift and fell back to a full `npm install` — ~40 minutes on a cold-cache box. Backfilled from each
  package's registry metadata at its exact locked version, with zero version drift; updates now
  `npm ci` in seconds. (#48)

## [0.9.0] - 2026-07-29

asmltr 0.9.0 — asmltr map now reports what each active agent is doing and where (live activity + git repo mined from all tool activity incl. shell), every active agent listed with a working_dir/channel fallback; ls/sessions/brief show activity + working dir. Follow-up to #79.

### Added

### Changed

- **`asmltr map` now reports what each active agent is doing and where** — not just repos with
  file-edit activity. "What" is the session's live activity rollup (built from inbound + **all** tool
  events, incl. shell); "where" is the git repo it's working in, now mined from absolute paths in
  **Bash/shell** commands (`cd`, `git -C`, file args) as well as file-tool args, with a `working_dir`
  fallback. Every currently-active agent is listed (shell-heavy and channel sessions included), so an
  empty map no longer means "someone might still be working via the shell." Fixes a repo-grouping bug
  where a `cd <repo>` was mis-attributed to the parent directory's repo. Use it to answer "what's
  happening in the other sessions?" (#79 follow-up)
- **`asmltr ls` / `asmltr_sessions` show what+where** — each session's live activity (or title) and
  working-dir basename, instead of the static `claude — <spawn-dir>` task label that collapsed every
  same-directory session to one indistinguishable row. `asmltr brief` likewise.

### Fixed

## [0.8.0] - 2026-07-29

asmltr 0.8.0 — android device-gateway connector, always-on CURRENT SPEAKER prompt line, inject-once system prompt on history-retaining engines, and asmltr_map/asmltr_who toolbelt tools for cross-session collision detection.

### Added

- **`asmltr_map` + `asmltr_who` toolbelt tools** — the working-dir collision-detection commands are
  now exposed as structured MCP tools, not just the CLI, so any reasoning engine (including ones
  without a shell tool) can answer "is another session already working in this repo/dir?" before
  starting. `asmltr_sessions`' description now points at them, and the self-aware system prompt notes
  the MCP equivalents. Closes the gap where an agent could only see a flat session list that collapsed
  many same-directory sessions to one indistinguishable label. (#79)

- Always-on **CURRENT SPEAKER** line in every turn's system prompt — authoritatively names the
  current sender (even without a cast profile) so an assistant on a shared, multi-person channel
  doesn't confuse who it's talking to or default to the box owner.
- **`android` connector — a device gateway** (`connectors/types/android/`). Makes a mobile app a
  first-class channel: the phone holds an SSE stream (`GET /gw/stream`) and POSTs turns
  (`POST /gw/turn`) that run through the core like any other channel — so its session
  (`android:<instance>:device:<id>`) is trust-scoped, seen by the interoception agent, and
  takeover-able from the web GUI, and `asmltr send android <device>` / announcements / steer push
  to the phone over its stream (`POST /out`). Voice I/O stays edge-local on the device via the
  existing `/v2` speech endpoints. Token-authed per device (gitignored `keys.json`).

### Changed

- **Inject-once system prompt on history-retaining engines** — the composed system prompt (identity,
  trust/authz, channel-awareness, toolbelt, …) is now split into a STABLE block (changes only when a
  store/state changes) and a small VOLATILE tail (who's speaking, their authz, per-turn context). On an
  engine whose resume replays prior turns (codex), the stable block is folded into the user turn **once**
  and only the volatile tail is re-sent on resumes — instead of prepending the whole multi-thousand-token
  block to every turn (which the `composePrompt` fix for codex/gemini would otherwise do). Re-injection is
  keyed on a sha256 of the stable block, so an identity edit, trust change, vault lock/unlock, or silo-path
  change re-sends it automatically. The Claude engine is unchanged (its append lands on a cached system
  channel); the full prompt is byte-identical to before. Kill-switch: `ASMLTR_INJECT_ONCE=off`.

### Fixed

- **Core system prompt was silently dropped on the Claude engine.** `options.appendSystemPrompt` is
  a no-op in `@anthropic-ai/claude-agent-sdk`'s `query()`; the engine now passes
  `options.systemPrompt = { type: 'preset', preset: 'claude_code', append }`. Identity, trust/authz,
  channel-awareness, cast, and toolbelt instructions reach the model again (regression since the
  agent-SDK migration — the assistant had been running on `CLAUDE.md` alone).

## [0.7.0] - 2026-07-21

asmltr 0.7.0 — Reasoning engines (Claude/Gemini/Codex/self-hosted), MCP tools registry, guarded backup restore + import, and connector-resilience fixes (#30/#33/#35).

### Added
- **Reasoning engines — pluggable agentic backends.** The channel/web runner is now engine-abstracted
  (`core/src/engines/`): a turn routes to the configured default engine — **Claude Code, Gemini CLI, or
  Codex CLI**. The Claude SDK is loaded lazily, so a Gemini-only or Codex-only install runs without it,
  and every connector (Discord/Telegram/email/GitHub/web/voice) runs on whichever single engine is
  selected. Per-engine model, **connection** (subscription OAuth or a vault-stored API key), one-click
  **install/update + auto-update**, and `asmltr claude|gemini|codex` terminal commands. Settings → Engines.
- **Self-hosted models.** Point the Codex engine at any OpenAI **Responses-API** endpoint (self-hosted
  vLLM/LiteLLM, a gateway, another provider) via a custom base URL; the key is vault-stored.
- **MCP tools registry.** Declare MCP servers once (`~/.asmltr/mcp.json`) and asmltr provisions them into
  every harness (Claude SDK `mcpServers` / Codex `-c` / Gemini `mcp add`). Includes a built-in
  **asmltr-toolbelt** stdio MCP server exposing asmltr's own tools (sessions/send/announce/uploads) to
  every engine. Settings → Engines → MCP tools.
- **Guarded backup restore + import in the dashboard.** Restore is no longer CLI-only: preview (dry-run)
  → type-to-confirm → a detached runner that survives the core restart, with a live progress log. Import
  a `.asmltrbk` archive straight from the browser.
- **Connector liveness heartbeat** (#29, #35). A connector emits a heartbeat from its active I/O path;
  the manager surfaces a deaf-but-alive instance as `healthy:false / heartbeat:stale` on `GET /instances`
  without killing it — closing the "reports running while its I/O loop is dead" gap. `ASMLTR_HEARTBEAT_STALE_MS`.
- **`ASMLTR_ANNOUNCE_FILE`** override for the manager announcements path (#29, #30).
- Loading spinners on every async action button across Settings.

### Changed
- **Docs.** README rewritten plain-language-first with a developer gateway into the deeper docs; new
  Reasoning-engines guide + MCP-registry pages; nav restructured (engines promoted to their own section,
  shipped systems separated from roadmap).
- Model & runtime settings are now **per-engine** (each harness exposes its own model list).

### Fixed
- **SDK auto-update split-brain** (#31, #33). `updateSdk()` now restarts all three PM2 services in
  lockstep, so a bump can't advance `asmltr-core` onto a new sha while the manager & collector run old code.
- **Telegram EFATAL silent death** (#32, #33). A fatal polling error now exits the connector so the
  supervisor respawns a fresh poller, instead of the process staying up and deaf.

## [0.6.0] - 2026-07-16

### Added
- **Self silo (P3).** A directory becomes a silo via a `.silo/manifest.json` marker (git-style); the
  filesystem is the schema, structure comes from a template at creation (no enforced zones). The **Self
  silo** is the assistant's memory + the default home for artifacts — the core ensures it at boot and
  injects a SELF-SILO awareness block into every session. Layered search (filename + full-text, ripgrep
  with a pure-JS fallback). New `asmltr silo <overview|ls|tree|find|get|put|…>` CLI. `shared/silo.js`.
- **Silos GUI.** A file-explorer plane — silo rail (add / select / delete-with-confirm), breadcrumb
  browser, file preview + editor, layered search, new-folder + upload, and a Settings modal to edit the
  manifest. `/v2/silos*` endpoints. A relationship-graph teaser scaffolds the future node graph.
- **Backups (P4).** `scripts/backup.js` — consistent SQLite online-backup snapshots + config + identity
  + silos → gzipped tar, **AES-256-GCM under a scrypt(passphrase) key, vault-independent** (a vault loss
  is itself recoverable). Streamed encrypt/decrypt; `asmltr backup <create|list|verify|restore>` (restore
  stashes overwritten files); auto-snapshot before every self-update. **Remote destinations** push the
  encrypted archive to a storage integration (webdav/s3/local). **Scheduled backups** with retention
  (frequency / max stored / max age) run in-process in the core. Settings → Backups GUI.
- **`asmltr vault init` (P2).** Guided one-command bootstrap — health-check → optional unseal → register
  the identity as a SACRED agent → write `ASMLTR_VAULT_*` to `.env` → verify a store→proxy-fetch→delete
  roundtrip. Plus `asmltr vault <status|unseal|seal>` and a passphrase-unseal form in the Vault GUI when
  the vault is sealed (`POST /v2/vault/unseal`).

### Changed

### Fixed

## [0.5.0] - 2026-07-16

### Added
- **TRUST vault integration (hard dependency).** asmltr now depends on the
  [TRUST Protocol](https://github.com/jarethmt/trust-protocol) for secrets. `shared/vault.js` is the
  client; the assistant registers as a SACRED agent under its identity name. `GET /v2/vault/status`
  reports reachable/sealed for a degraded-but-loud UI. Contributed the **KMS** (envelope encryption —
  `generate`/`wrap`/`unwrap`) *to* TRUST Protocol for encryption-at-rest.
- **Storage substrate + drivers.** `shared/storage.js` — a backend-agnostic driver contract
  (put/get/stat/list/remove/move/mkdir/mint) behind both data silos and backups. Drivers: built-in
  **local**, **WebDAV** (Nextcloud, verified), and **S3-compatible** (AWS/B2/Spaces/R2/MinIO, presigned
  `mint`). **EncryptedStorage** wraps any driver with AES-256-GCM — the per-silo data key comes from the
  vault's KMS (master key never leaves the vault; the key lives only in the runtime crypto layer, never
  in model context, zeroed after use).
- **Integrations framework.** A registry (`integrations/registry.js`) of third-party service links whose
  secret fields are `*_ref` vault key names, resolved from the vault only at open. Core
  `/v2/integrations` endpoints (list/create/update/delete/test).
- **GUI: Vault + Integrations planes.** A **Vault** view (key management — status banner, keys with
  tier + access count, add/delete; values are write-only) and an **Integrations** view (add/configure/
  test storage integrations; creds stored in the vault).

### Changed
- **De-BWS — asmltr's runtime no longer depends on Bitwarden.** `shared/secrets.js` resolves from the
  TRUST vault; all runtime secrets (connector tokens + voice keys) migrated BWS→vault and the BWS
  command provider disabled. Only the vault's own access keys remain in `.env` (the bootstrap root).
- **Vocabulary + GUI rename:** *connector* = an I/O channel to a human; *integration* = a link to a
  third-party service. The old "Integrations" view (connector instances) → **Connectors**.

## [0.4.0] - 2026-07-16

### Added
- **Aesthetic identity facets** — a free-text *aesthetic* sensibility + an ordered *signature palette*
  (primary/secondary/tertiary; names and/or hex), injected into the anchor every session sees, so an
  agent leans on its own colors/style when building assets and no other cue is given. Editable in
  Settings → Identity (GUI + TUI via the manifest).
- **Live UI theming from the palette** — the dashboard's brand accent, gradients, background glow,
  pills, **nav logo** (now inline SVG), and **browser tab favicon** (regenerated data-URI) all retint
  in real time when the signature palette is saved. Falls back to the built-in violet/pink.
- **Discord server invite + membership management** — a *Servers* button on the Discord instance card
  opens a modal with the copyable OAuth invite URL (to add the bot to a new server) and the list of
  servers it's in, each with a *Leave* button. New connector `/servers` control endpoint + manager
  proxy generalization; documented in `docs/connectors/discord.md`.

### Fixed
- **Self-goal extractor no longer gives up** (issue #16) — the reflector now climbs to the loosest
  honest through-line (shared subject/domain/mode/direction; a single part's aim *is* the goal)
  instead of defaulting to "no single goal — the parts are unrelated," which is now a rare last resort.

## [0.3.1] - 2026-07-15

### Added

### Changed
- **Standardized on Node 24 LTS** (issue #21). `engines.node` raised to `>=24.0.0` across the root +
  every workspace, a root `.nvmrc` pinning `24`, and the dashboard build image bumped
  `node:20-alpine → node:24-alpine`. Clears the `EBADENGINE` from `@discordjs/voice@0.19.2`
  (needs `>=22.12`); docs updated from ">= 18".
- **Turn-complete notification toggle moved to Settings → Notifications.** The sidebar header no
  longer carries the toggle; it lives in a GUI-only Settings tab (with permission state + a link to
  the history page). The ✦ Notifications nav item still shows notification history.

### Fixed
- **Documented `ASMLTR_UPDATE_MANAGED` in `.env.example`** (issue #23) — the managed-mode work (#18)
  added the variable but not the example entry CLAUDE.md calls for.

## [0.3.0] - 2026-07-15

### Added
- **Persistent update progress (GUI + TUI).** The updater writes `~/.asmltr/update-status.json`
  through every phase (fetch → install → restart → verify); core exposes `GET /v2/update/progress`.
  The GUI shows a persistent progress panel at the top of every page that survives the mid-update
  service restart (spinner, phase, log tail, terminal result + dismiss); the TUI shows a matching
  overlay reading the status file directly. Triggered from both the banner and Settings → Updates.
- **Agent-name brand + browser tab title.** The header shows the configured agent name with an
  "asmltr control plane" subtext; the running version sits by the collector-live pill; the tab title
  is `<Agent> · <focused session, else active view>`.
- **claude-code sessions now show the assistant's replies.** The connector recovers the reply from
  the transcript on the `Stop` hook and emits it as an `outbound` event (previously only inbound/tool
  events reached the dashboard). Requires wiring the `Stop` hook (README updated).
- **Committed lockfile + `npm ci`** (issue #17): a root `package-lock.json` pins the whole transitive
  tree (incl. native modules); the updater prefers `npm ci` (exact-match) with an `npm install` fallback,
  and `release.js` regenerates the lock per tag so every release ships a matching lock.
- **Externally-managed update mode** (issue #18): `ASMLTR_UPDATE_MANAGED=<manager>` / a `~/.asmltr/managed`
  flag makes the updater step aside cleanly (distinct exit code 6, `getUpdateStatus.managed`,
  `/v2/update/run` refuses) on package/image/config-managed installs instead of crash-looping.
- **The cast (Access-evolution Phase 0)** — the identity/relationship layer, built on the existing
  trust store (no second store). New `principal_profile` (who a member is + how to relate), pairwise
  directional `relationships`, per-scope `engagement` (engage|observe|ignore, retiring per-connector
  bot lists), and `verification_strength` on identifiers. `resolve()` now returns a member's profile,
  ALL cross-channel identities, the self→them relationship, and engagement policy. `buildRelationshipPrompt`
  injects into the system prompt: who you're talking to, their **cross-channel identity** (one person
  across all their channels), your relationship, and the peer agents present (recognition without
  per-channel config). `/trust/{profiles,relationships,engagement}` endpoints. Roadmap: docs/ACCESS-EVOLUTION.md.
- **Cross-session send with assimilation** (`POST /v2/send`, channel-agnostic). An agent in any
  session can post into another channel AND the destination session folds the message into its own
  context (it was posted under its name from a parallel session). Connectors' `/out` now return the
  destination `conversation_key` (Discord + Telegram) so core can route the assimilation. `asmltr send`
  goes through core (falls back to the manager if core is down).

### Fixed
- **Multi-agent no-reply reliability.** When the model decides a message isn't for it, it should emit
  the bare `[[NO_REPLY]]` token — but it often prose-refuses instead ("That's addressed to Moneo, not
  me…"), which got posted as spam. Core now detects that short meta-refusal and stays silent (channel-
  agnostic; length-capped + adjacency-specific to avoid suppressing real replies that merely mention
  who a message was addressed to).
- **Discord reply threading.** A message that uses Discord's reply feature now carries "↩ in reply to
  <author>: …" into the prompt (both addressed and observed paths), so in a busy multi-agent channel
  the agent can tell WHAT a peer replied to instead of losing the reference.
- **Interrupted / empty turns no longer emit a canned greeting.** An empty reply (interrupt,
  tool-only turn, or a deliberate non-answer) now posts nothing instead of "I'm here — what would
  you like to know?", which on multi-agent channels was noise other agents kept answering.
- **Multi-agent self/other attribution.** The observed-activity catch-up now states that other
  participants' "I/my" refers to the named speaker (not the reading agent), and the Discord identity
  line tells the agent its own handle — so an agent stops mistaking peers' first-person messages, or
  its own earlier ones, for something newly said to it.

### Added
- **Full-autonomy terminal sessions**: `asmltr claude` (and dashboard takeovers) launch in
  bypass-permissions mode by default (`--permission-mode bypassPermissions` + `IS_SANDBOX=1`).
  GUI/TUI-toggleable via Settings → Runtime and `/v2/runtime/cli-permission-mode`.
- **Downloadable artifacts in chat**: the GUI auto-detects local file paths in an assistant's reply
  and renders a download chip that streams the file through `GET /v2/file` (Authelia-gated).

## [0.2.0] - 2026-07-15

First deterministic-updater release: LLM-free versioned self-update, pinned releases, stable/edge channels, self-healing setup steps.

### Added
- **Deterministic installer + updater** (no LLM on the happy path): `scripts/update.js` runs the
  full update as a scripted, verified pipeline (fetch → resolve channel target → setup-steps →
  npm install → dashboard build → restart-with-rollback → announce). The agent-driven updater
  remains only as an escape hatch when the deterministic path fails.
- **Semantic versioning + pinned releases**: `VERSION`, this changelog, git tags, and a `scripts/release.js`
  release cutter. Services report `{ version, channel, sha }` from `/version`.
- **Self-healing setup steps**: `setup.d/` numbered idempotent steps + an applied-ledger, so a
  bespoke install picks up any newly-required install step on its next update.
- **Update channels**: `stable` (latest release tag) vs `edge` (origin/main), selectable per install.

## [0.1.0] - 2026-07-15
- Baseline: the pre-versioning state of asmltr (core pipeline, connectors, insights dashboard + TUI,
  shared console manifest, unified speech layer, PWA). First tagged release.
