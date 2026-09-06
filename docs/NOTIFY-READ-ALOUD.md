# Notify & read-aloud

Two ways asmltr uses **voice** to keep you in the loop when you're away from a chat window:

- **Notify** — the assistant (or a [schedule](SCHEDULES.md)) proactively **reaches you** with a spoken /
  pushed message, trying the best channel that can actually get through.
- **Notification reader** — your phone reads **incoming notifications** aloud over your headphones as a
  short spoken synopsis, skipping the noise.

Both are voice-first, both respect quiet hours, and both are configurable.

---

## Reaching you — `asmltr notify`

When something needs your attention out-of-band — a scheduled morning brief, "your build finished," an
alert while you're away — the assistant calls:

```bash
asmltr notify "<message>" [--title "<title>"] [--force] [--silent]
```

| Flag | Effect |
|---|---|
| `--title` | A short heading shown with the message. |
| `--force` | Deliver even during quiet hours (use only when it's genuinely urgent). |
| `--silent` | Skip the spoken step — deliver as text only. |

A schedule whose prompt says *"notify me…"* or *"send me a message"* is exactly this command. It's also
the primitive the morning brief uses.

### The delivery ladder

`asmltr notify` doesn't just fire and hope — it walks a **ladder** and stops at the first step that can
actually reach you:

1. **Read aloud** — if a connected assistant device (the phone app or a headless control link) is present
   and allowed to speak, it's spoken aloud through your configured voice.
2. **Push** — a push notification to the device (when a push sender is configured).
3. **Text fallback** — a message to a configured channel (Telegram / Discord / email).

If a step isn't reachable or isn't configured, the ladder falls through to the next. The command reports
which step delivered it (`✓ notified via android`) or that nothing landed — so a notification never
silently vanishes into the void.

**Quiet hours** suppress the *spoken* step (so a 3 AM brief won't wake you); the message still travels the
rest of the ladder as text unless you passed `--force`. If no quieter step is configured, it's held rather
than spoken.

### Configuring delivery

Set the policy in the dashboard under **Settings → Notifications → Notify delivery**:

- **Quiet hours** — the window where the spoken step is suppressed.
- **Only read aloud over headphones** — never speak over the phone's loudspeaker.
- **Text fallback** — the channel + target that catches messages the spoken step can't (recommended, so
  quiet-hours notifications still reach you silently).

Under the hood this is stored at `~/.asmltr/notify.json` and served by `POST /v2/notify` +
`/v2/notify/config`; connectors are reached through the connector manager's unified send path, so there
are no host-specific scripts to wire up.

---

## Reading phone notifications aloud

The **notification reader** speaks a natural-language synopsis of incoming phone notifications over your
headphones — like a conversational, selective version of a car's "read my messages." It's a native feature
of the Android app.

### How it works

- The app watches posted notifications (you grant Android's **Notification access** once).
- Each one is judged **on-device by the local engine** — it returns whether to speak it, a priority
  score, and a one-sentence synopsis. Because this runs on the local Agent SDK (not a metered/cloud API),
  the content of your private notifications never leaves the device for a third-party key.
- If it clears your threshold, the app reads the synopsis aloud
  (*"You've got a direct message on Discord — they're done with the project"*).
- A burst of notifications is summarized together rather than read one by one.
- **It waits for a gap rather than talking over you** — see below.

### It won't talk over you

A synopsis is only ever spoken into a free ear. Before anything is read, the app asks whether this is
actually a good moment:

| Situation | What happens |
|---|---|
| **You're on a call** — cellular or VoIP (WhatsApp, Meet, Discord…) | Held. Nothing is spoken. |
| **Do Not Disturb is on** | Held. DND means quiet, and the assistant is not exempt. |
| **Navigation is speaking**, or an alarm/other assistant is | Waits it out (~20s), then holds if it's still going. |
| **Music or a podcast is playing** | Spoken — but the music **ducks** to a murmur underneath, then comes back. |
| **A call starts mid-sentence** | Playback stops immediately and the rest is held. |

"Held" never means "lost". The synopsis goes into a backlog and the **eyes appear in a corner of the
screen wearing a "!"**:

- **Tap them** → the whole backlog is read aloud in one go, in order, in your voice. If five things
  arrived during a twenty-minute call, you hear all five when you're ready.
- **Drag them to the ✕** (it fades in at the bottom of the screen while you drag) → discard the
  backlog unheard.
- **Fling them off any edge** → same thing, faster.
- **Drag them anywhere else** → they snap to the nearest side and stay there; the app remembers.

The backlog survives the app being restarted by the system, and entries older than three hours expire
on their own — a synopsis from this morning is noise, not news.

The same gate covers `asmltr notify`'s spoken step, so a proactive message from the assistant can't
barge into a call either. (Do Not Disturb is *not* applied there: that path already has its own quiet
hours, and the notify ladder decides its own timing.)

### Gating & settings (app → **⚙ Notifications**)

- **Enable readout** on/off, and **only over headphones** (skip when on the speaker).
- **Quiet hours** — no readout during your configured window.
- **Priority threshold** — read only notifications scored at or above your bar.
- **Per-app allow/deny** and a **sender allow-list**; ongoing/transport/foreground-service noise is
  filtered out automatically.
- **Verbosity** — headline vs. full synopsis — and **burst-summarize** on/off.
- **Hold instead of interrupting** — on by default. Turning it off restores barge-in behavior (still
  ducked, still respecting the headphones gate).
- **Respect Do Not Disturb** — on by default.
- **Wait out navigation prompts and alarms** — on by default. Turn it off if you'd rather hear
  notifications while a route is being narrated.

The settings screen also shows the live gate state (*"Right now: free to speak"* / *"a call is in
progress"* / *"3 held"*) and a **Test held badge** button, so the corner UI can be tried without
staging a phone call.

### Privacy

Notification text is sensitive by nature. The synopsis is generated **locally**, nothing is retained
beyond what's needed to de-duplicate a burst, and readout only happens over a private audio route
(headphones). Android's own consent screen gates the whole feature.
