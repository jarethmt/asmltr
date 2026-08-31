# Eve recut (public-shaped) — 2026-08-31

Worktree only. Do not apply host cutover. Live product stays on `ivy` /
ivy-local `main`. Public persona examples stay Gaia. Host identity stays
the configured `ASSISTANT_NAME`.

Public extras live in `extras/host-local` (renamed from `extras/ivy-local`). The private overlay repo is still ivy-local; do not confuse the two.

## Public product

- Stop: anyone may abort a processing turn. Overlay wrapAbortRoute on
  core `/v2/abort` keeps starter-or-owner. Public abort-allow has no overlay require.
- Who + surface live in `trust.resolve` (connector sets `envelope.public`
  only). Product owner-always-bypass on unspoofable principal id `owner`.
  Grants may narrow `*` on a public surface. Overlay owner-lock still
  restricts public Discord even with bypass.
- `shared/media-allow.js` is media/code allowlists + deny-env, not a second
  capability plane. Overlay wraps `isRestricted` / `policyFor` for V31.
- Grants render through `buildAuthzPrompt`. No second TOOLBELT builder.
  Omit-denied-tools is engine/forbidden from `resolve()`.
- Discord connector is I/O. No trust-principal polling. Speaker-local
  last-name hints only. Trust-store PII is overlay wrap of core redact.
- Send is `asmltr send` + fuzzy name resolver (`shared/discord-targets.js`).
  Overlay keeps confirm / on-behalf-of / same-guild.
- Path deny-list (`.ssh` / vault / silos / `.env` / sqlite / 25MB / realpath)
  stays overlay (`hostGate` / wrapOutRoute on `/out` and `/v2/send`).
  Public `attach-stage` is staging only.
- Settings: PII off, attachments `all_files`, thought chips off, temp GC
  opt-in (`ASMLTR_GC_TEMPS`, default off). Overlay `host-settings.json`
  pins live host behavior including GC-on. Do not edit running host config.

## Overlay first

`overlay/eve-20260831` must be loaded from ivy-local `core-entry.js` before
this public branch is ever fast-forwarded. See ivy-local `overlay/README.md`.
