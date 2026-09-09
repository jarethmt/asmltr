# Roadmap — the launcher (brainstorm)

> **Status: rough. Nothing here is committed.** This is a design sketch from a working session, written
> down so it can be argued with rather than re-derived. Names, gestures and grammar are all provisional.

An optional Android **home-screen replacement** shipped alongside the assistant app: a minimal,
terminal-flavoured launcher that is also the ambient surface for the assistant and its server.

---

## Why a launcher at all

The assistant app is a guest on the system, and most of its rough edges come from exactly that:

- the floating overlay needs `SYSTEM_ALERT_WINDOW`, and the user has to be talked into granting it;
- `TYPE_APPLICATION_OVERLAY` is **hidden by the keyguard**, so the held-notification badge is invisible
  while the phone is locked (see [Notify & read-aloud](NOTIFY-READ-ALOUD.md));
- there is nowhere to put ambient state, so anything the user should passively notice has to become a
  notification and compete with everything else.

A launcher owns the home screen outright. The face stops being an overlay hack and simply lives there,
and ambient state gets a home. That is the whole argument, and it is a strong one:

**You look at your home screen dozens of times a day. It is the cheapest place in the system to put
something you would otherwise have to go and check.**

---

## Design principles

1. **The launcher is a prompt, not a dashboard.** One text field. Everything is reachable by typing.
   The dashboard material shows up as *status lines and completions*, not widgets.
2. **Almost nothing gets permanent pixels.** Olauncher's stated policy — *"to maintain the simplicity of
   the launcher, a few niche features are available but hidden"* — is the discipline to copy. The moment
   this becomes a grid of panels it has lost.
3. **Dead quiet, with one living thing.** Monospace, near-monochrome, a single accent. The eyes are the
   only animated element on the screen. Contrast is the identity.
4. **Home must draw when the server is down.** Session state is decoration; app launching is not. No
   agent code path may be able to take the home screen with it.
5. **Presence is public, content is not.** Anyone can see your home screen. Counts and states are fine;
   message text is not, until unlock.

---

## The prompt and its sigils

One input field. A leading character selects the namespace, so the user always knows what the text
*means* — no guessing whether an app or the agent will answer.

| Input | Resolves to |
|---|---|
| `sig` | launches the app (auto-launch on unique match — see below) |
| `!weather tomorrow` | web search |
| `> fix the CI build` | an agent turn |
| `@discord` | jump to that live session |
| `/brief` | run a saved routine ([schedules](SCHEDULES.md)) |
| `#invoices` | search silos + the upload surface ([silos](silos.md)) |

Every sigil maps onto something that already exists, which is the point — the launcher is a *surface*,
not a new subsystem.

**Auto-launch on unique match.** The moment the filtered app list contains exactly one entry, launch it —
no Enter, no tap. Type `sig`, Signal opens. Suppressed whenever a sigil is present, so `>` and friends
can be typed freely. (Borrowed behaviour, not code — see [Prior art](#prior-art).)

---

## Gestures

The whole launcher, with no icons and no pages:

| Gesture | Action |
|---|---|
| Type | the prompt above |
| Swipe up | app drawer |
| Swipe **right** | **what's running** — live sessions; tap to engage |
| Swipe **left** | **what wants you** — approvals/drafts, held notifications, extracted action items |
| Swipe down | notifications |
| Double-tap | lock |
| Long-press | settings |

The left/right pair is deliberately a dichotomy — *running* vs *waiting on me* — because both already
have real content: the core's session table on one side, and the draft/approval primitive plus the held
notification queue on the other.

---

## The capture dock

A configurable icon row along the bottom. The inversion is the idea: a normal launcher's dock is *apps I
open often*; this one is **ways to get material into the assistant**.

- **text** — focus the prompt
- **camera / image** — shoot or pick, send for identification and processing (engines already have vision)
- **audio** — record an artifact
- **file / share-in** — drop into a silo
- **screenshot** — capture and attach

Most of this is a surface over the [recorder roadmap](ROADMAP-RECORDER-CONTEXTBANKS.md), not new backend:

| Dock action | Existing item |
|---|---|
| audio record | **B1** recorder MVP — chunked STT → recording record in a silo |
| camera / image | **B7** media capture as timestamped assets |
| file / share-in | **C1** direct file→session/bank upload |
| after any capture | **B5** save-to-target |

**B5 is what makes the dock worth building.** On finishing a capture you pick an active project/stream,
with an optional checkmark to *also* fire a prompt into a new or existing session. From the dock that
becomes: tap camera → shoot → pick stream → "identify this." Two taps from the home screen to an artifact
that has been filed *and* reasoned about.

### Recording, specifically

The recorder is designed in [ROADMAP-RECORDER-CONTEXTBANKS.md](ROADMAP-RECORDER-CONTEXTBANKS.md) and this
document defers to it entirely — B1–B11 and the context-bank foundation are the design. What a launcher
adds is **capture-side context the server cannot see**:

- **Pre-assign the stream on start, not on save.** B5 targets a bank when you finish; the launcher can
  target one when you *begin*, because it knows the time, the calendar entry, the location, and which
  Bluetooth device just connected. Walk into a workshop, hit record, it is already filed.
- **Recording-in-progress as home-screen state.** A status line, and the face shifts to `listening`. The
  user should never have to wonder whether it is running.
- **Post-capture triage from home.** New recordings land in the left panel; swipe into a stream, or fire
  the B5 prompt without opening anything.
- **A short rolling buffer**, so hitting record retroactively captures the preceding minute — the feature
  that makes ambient capture useful rather than "remember to press the button." Note honestly that a ring
  buffer *is* capture and does not sidestep the consent question below.

---

## The face

The eyes (the shared engine, `mobile/www/eyes.js`) become the wallpaper layer rather than an overlay window:

- no `SYSTEM_ALERT_WINDOW` required on the home screen;
- idle when nothing is happening; `thinking` while a session is working; `listening` while recording;
  expression driven by the `[[MOOD:…]]` sentinel;
- an **ambient mode** — desaturated, dimmed, low frame rate, reduced motion — for the lock screen and for
  the home screen when the device has been idle.

Must pause entirely when not visible. An animated canvas on a surface the user returns to fifty times a
day is a battery question first and a design question second.

---

## Constraints and risks

**A broken launcher strands the phone.** This is the one that deserves real engineering. If home crashes,
the user cannot get anywhere. Requirements: home renders from cached app data with zero network
dependency; a watchdog; and a documented escape hatch. The standard trick — temporarily enabling a dummy
`CATEGORY_HOME` activity, firing `ACTION_MAIN`/`CATEGORY_HOME` so the system shows the launcher chooser,
then disabling it again (API 29+: `RoleManager.ROLE_HOME`) — should be a first-class, always-reachable
setting, not a recovery path.

**Privacy inverts on the home screen.** Presence and counts always; content only after unlock.

**Recording consent is a legal constraint, not a preference.** Many jurisdictions require *all-party*
consent to record an oral conversation — Pennsylvania, California, Illinois, Florida and others — and
violations can be criminal, not merely civil. Recording yourself is not the exposure; ambient capture of a
room containing other people is. Design consequences: explicit start rather than always-on, an unmissable
indicator, short default retention, and a "who was present" prompt at save time (which feeds B2's people
records anyway).

> **Gap in the current roadmap:** E1's legal deep-dive scopes *voiceprinting* (BIPA/GDPR Art. 9,
> biometrics). **Ambient capture consent is a separate question and is not covered.** If ambient recording
> is pursued, E1 needs a section for it — it gates the sharper risk of the two.

**The platform agrees.** From Android 11 background microphone access requires a foreground service typed
`microphone`, and the OS shows a persistent mic indicator regardless. Ambient recording is required to be
visible; design with that rather than against it.

**Keep it generic.** A launcher attracts personal-shaped assumptions faster than any other component.
No install-specific defaults, no hardcoded assistant name (`ASSISTANT_NAME`), no assumptions about which
connectors exist.

---

## Prior art

- **[Olauncher](https://github.com/tanujnotes/Olauncher)** (GPL-3.0) — the minimal text launcher this
  borrows its *feel* from. **Pro Launcher** is the same developer's proprietary paid version (widgets,
  weather, folders); its README links to it. Two behaviours worth having: auto-launch on unique match, and
  the `!` prefix that switches the input's meaning — the direct ancestor of the sigil grammar above.
- **[Kvaesitso](https://github.com/MM2-0/Kvaesitso)** (search-first, Jetpack Compose, plugin SDK under
  Apache-2.0) — closest architectural relative: one unified search across apps, contacts, files and web
  services, with pluggable providers. Worth studying before designing the resolver.

> **Licensing.** Olauncher is **GPL-3.0** (copyleft). Reading it for design ideas is fine; copying code
> would make this component GPL-3.0. Decompiling the proprietary Pro Launcher to inform a public
> open-source project is the version to avoid outright — and is unnecessary, since the open-source parent
> shares its design lineage. **Separately: this repository currently has no `LICENSE` file and no `license`
> field in `package.json`, which defaults to all-rights-reserved. That should be resolved before adding a
> component whose licensing questions are live.**

---

## Phasing

**Phase 0 — a launcher worth living on.** App drawer, prompt with auto-launch, gestures, wallpaper, the
face, the escape hatch. No agent integration beyond the face. Daily-drive it for a week. If it is annoying
as a *launcher*, nothing else matters.

**Phase 1 — the two panels.** Right: live sessions, tap to engage. Left: approvals and held notifications.
This is the highest value per pixel on the list and the plumbing already exists.

**Phase 2 — the capture dock.** Text, camera, audio, share-in, wired to B1/B7/C1 with the B5 save-to-target
flow.

**Phase 3 — sigils beyond apps.** `>` agent turns, `@` session jump, `/` routines, `#` silo search.

**Phase 4 — recording as a home surface.** Pre-assignment, in-progress state, post-capture triage. Gated
on the consent work above.

---

## Open questions

- Native (Compose) or the existing WebView brain? A launcher is the one surface where jank is unforgivable,
  which argues native — but every other surface is web, which argues against two codebases.
- Does the prompt search *inside* silos and sessions by default, or only under `#`/`@`? Kvaesitso searches
  everything at once; that may be too much for a home screen.
- Should the launcher be a separate APK or a mode of the assistant app? Separate is safer (a launcher crash
  cannot take the assistant down, and vice versa) but doubles install friction.
- Does tapping a held notification on the lock screen read it aloud *without* unlocking? Speaking is
  arguably already consented to by enabling readout; opening the app is not.
- How much does the launcher work when the server is unreachable, beyond app launching?
