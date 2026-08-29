# Bluetooth audio on the Android app

Why talking to the assistant through earbuds is harder than it looks, what the constraints actually
are, and the one problem that is still open.

Written 2026-08-29 after chasing this end to end on a Pixel 10 Pro / Android 17 with Shokz OpenDots
ONE. Almost every wrong turn below *looked* correct and failed silently, so the reasoning is recorded
alongside the answer.

## The two profiles

A Bluetooth headset speaks two different audio profiles, and only one of them carries a microphone:

| | A2DP | HFP / SCO |
|---|---|---|
| Direction | output only | output **and input** |
| Quality | stereo, full band | mono, narrowband |
| Android calls it | `bt_a2dp` | `bt_sco_hs` |
| What it means to the headset | "playing media" | **"in a call"** |

There is no third option. **Capturing from the headset mic requires SCO, and SCO means the headset
believes it is in a call.** Everything below follows from that.

## Getting capture onto the headset mic

Three things must all be true. Each one silently defeats the others, which is what made this hard to
diagnose — every failure mode looks identical from the app (audio records fine, just from the wrong
mic).

### 1. `BLUETOOTH_CONNECT` must be declared *and* granted

Without it Chromium's media stack will not touch the adapter at all:

```
W/cr_media: BLUETOOTH_CONNECT permission is missing.
W/cr_media: getBluetoothAdapter() requires BLUETOOTH permission
```

No route nomination can succeed past this. It is a runtime (dangerous) permission on Android 12+, so
declaring it in the manifest is not enough — `MainActivity` requests it.

### 2. The route must be nominated natively, not in JS

**Chromium on Android does not enumerate per-device microphones.** `enumerateDevices()` exposes
essentially one `default` audio input, so no `getUserMedia` `deviceId` can select the earbud mic.
Matching device labels — which an earlier revision did — finds nothing and silently falls back to the
phone mic.

The route has to be set at the `AudioManager` level:

```java
for (AudioDeviceInfo d : am.getAvailableCommunicationDevices())
  if (d.getType() == AudioDeviceInfo.TYPE_BLUETOOTH_SCO) am.setCommunicationDevice(d);
```

`setCommunicationDevice()` returns **before the SCO link is up**, and capture opened too early binds
to the phone mic anyway — so poll `getCommunicationDevice()` until the route is live before calling
`getUserMedia`.

### 3. `echoCancellation` must be **on**

This is the counter-intuitive one. Echo cancellation puts Chromium on its WebRTC capture path, which
opens the stream as `AUDIO_SOURCE_VOICE_COMMUNICATION` — **the only source that follows the
communication device onto SCO**. With it off, capture opens as `AUDIO_SOURCE_MIC` and binds to the
built-in mic regardless of the route.

The symptom is unmistakable once you know where to look:

```
$ adb shell dumpsys media.audio_flinger
  Output devices: 0x20 (AUDIO_DEVICE_OUT_BLUETOOTH_SCO_HEADSET)   ← route nominated fine
  Input device:   0    (AUDIO_DEVICE_NONE)
  Audio source:   0    (AUDIO_SOURCE_DEFAULT)                      ← capture never followed
```

## The three side effects of SCO, and how each is handled

Turning SCO on is not free. Each of these was a separate user-visible bug.

| Side effect | Why | Fix |
|---|---|---|
| Music keeps playing but sounds like a phone call | media is dragged onto the narrowband call channel | `OverlayService` holds `AUDIOFOCUS_GAIN_TRANSIENT` for the session — other players pause on open, resume on close |
| The spoken reply is inaudible for ~20s | Android holds the SCO route after the mic closes; the reply plays into a dead channel | `releaseCommunicationRoute()` clears the communication device the moment capture ends |
| The start/stop beeps vanish | cues played as `USAGE_MEDIA`, which is silent while SCO holds the route | `Chime` follows the live route (`USAGE_VOICE_COMMUNICATION` on SCO, else media); web cues call it instead of WebAudio; the listen cue moved to *after* the stream opens so the SCO transition can't clip it |

## Diagnosing this

Symptoms are silent, so go to the system state rather than the app.

```bash
# which mic is capture actually bound to?
adb shell dumpsys media.audio_flinger | grep -E 'Input device:|Audio source:|Output devices:'

# did the app ask for the SCO route, and when?
adb shell dumpsys audio | grep -E 'setCommunicationDevice|startBluetoothSco'

# is Chromium refusing to touch Bluetooth?
adb logcat -d --pid=$(adb shell pidof com.asmltr.assistant) | grep cr_media

# what is the link doing right now?
adb shell dumpsys audio | grep -E 'ACL BR/EDR|Active communication device'
```

`ACL BR/EDR:Y LE:N` means classic Bluetooth only — useful for confirming a headset isn't using BLE.

## Open problem: SCO steals the headset's own gestures

**This is unsolved and it is a genuine conflict, not a bug.**

Earbuds keep **two** gesture maps — one for media, one for calls — and switch on the call state. The
moment SCO comes up to give us the mic, the headset switches to its in-call map, where the gesture
that launches the assistant is typically volume or answer/end instead.

So on the same hardware:

- **assistant gesture works** → SCO is not up → we are on the phone mic
- **assistant gesture adjusts volume** → SCO is up → we have the headset mic

Pressing the earbud to *stop* a turn is exactly the moment SCO is guaranteed to be up, so that
specific interaction is the one most reliably broken.

There is no way to have SCO audio without the headset believing it is in a call — SCO *is* the call
channel. Options, none free:

1. **Remap the in-call gesture** in the vendor's app, if it exposes call-mode gestures. Cheapest; the
   in-call function list is usually short (answer/end/mute/volume).
2. **Use the spoken stop phrase** instead of a gesture. Unaffected by call mode, works today, and
   needs no hardware cooperation. The pragmatic answer.
3. **Stay on the phone mic.** Gestures always work; speech recognition degrades with distance.
4. **Rewrite the headset's call-mode gesture map directly.** Only viable where the vendor protocol has
   been reverse engineered — see `/root/projects/personal/shokz-opendots-re` for the OpenDots ONE,
   where the gesture table is a known attribute and only the write opcode is still missing.

Option 4 is the only one that delivers both, and it is device-specific.
