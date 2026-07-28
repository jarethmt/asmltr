# asmltr mobile assistant

A Capacitor shell around a tiny voice web brain, plus a native **assist trigger** so a phone's
hold-to-assist gesture (e.g. earbuds) opens the assistant in listen mode. It talks to the
[`android` connector](../connectors/types/android/) — so the phone is a **first-class channel**
(trust-scoped session, interoception-aware, takeover-able from the web GUI, reachable by
`asmltr send android <device>`), not a dumb client.

## Layout

- `www/` — the web brain (framework-free): connects to the connector's SSE, records → `/gw/transcribe`,
  posts turns → `/gw/turn`, speaks replies → `/gw/tts`. One base URL + one device token.
- `www/config.js` — generic build defaults (public). `www/config.local.js` (gitignored) overrides with a
  real server URL + device token for a specific install.
- `native/` — the Android assist layer (Java + res/xml): `VoiceInteractionService` (selectable as the
  system Digital Assistant), a session that launches the app in listen mode on the assist gesture, a stub
  `RecognitionService` (required for eligibility), and a `MainActivity` that tells the web brain to start
  listening.
- `scripts/patch-android.js` — copies `native/` into the Capacitor-generated `android/` and injects the
  services + permissions into `AndroidManifest.xml` (idempotent).
- `build.sh` — one-command, resource-limited debug build.

## Build (needs the Android SDK + JDK 17/21)

```bash
cd mobile
ASMLTR_APP_URL=https://<host>/app ASMLTR_APP_TOKEN=<device-token> bash build.sh
```

Output: `android/app/build/outputs/apk/debug/app-debug.apk`. Point `ASMLTR_ANDROID_APK` at it (or copy it
to the default path) and the connector serves it at `https://<host>/app/gw/download` — install straight
from the instance.

## Make it the phone's assistant (earbud-hold → talk)

Install the APK → open once (grant mic) → **Settings → Apps → Default apps → Digital assistant app →
asmltr**. Now the assist gesture (earbud hold) opens it in listen mode. Until then, tap-to-talk works.

## iOS

Not yet — iOS doesn't allow a third-party default assistant. The web brain + connector are
platform-agnostic; an iOS shell (App Intents/Siri Shortcuts as the closest trigger) can be added later.
