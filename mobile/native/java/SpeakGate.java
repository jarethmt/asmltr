package com.asmltr.assistant;

import android.app.NotificationManager;
import android.content.Context;
import android.media.AudioManager;
import android.media.AudioPlaybackConfiguration;
import android.os.Build;

import java.util.List;

/**
 * "Is this a good moment to talk?" — the politeness gate in front of every headless read-aloud.
 *
 * The reader used to speak the instant triage said yes, which meant it talked straight over phone calls,
 * navigation prompts and anything else already using the ear. This asks three questions first:
 *
 *   1. **Do Not Disturb** — if the user silenced the phone, the assistant is not exempt. (Read from the
 *      notification listener, which is the only component that reliably sees the interruption filter;
 *      it caches the value here on connect and on every change.)
 *   2. **A call** — cellular OR VoIP. `AudioManager.getMode()` catches both without READ_PHONE_STATE:
 *      the telephony stack sets MODE_IN_CALL / MODE_RINGTONE, VoIP apps set MODE_IN_COMMUNICATION.
 *      (Our own headset capture also sets MODE_IN_COMMUNICATION — deliberately treated as busy too,
 *      since talking over a live turn is just as wrong.)
 *   3. **Something already speaking** — the active playback configurations expose each player's usage,
 *      so a navigation prompt, an alarm or a screen reader can be waited out rather than trampled.
 *
 * The result is three-valued on purpose. A nav announcement lasts seconds and is worth WAITING for; a
 * phone call lasts minutes and must be HELD (queued behind the badge) instead of retried into oblivion.
 */
public class SpeakGate {
  public static final int OK = 0;    // go ahead — the ear is free
  public static final int WAIT = 1;  // something transient is talking; retry in a few seconds
  public static final int HOLD = 2;  // a call / DND; park it in NotifQueue and badge it

  private static final String TAG = "AsmltrNotif";

  /** Last interruption filter seen by the notification listener. -1 = never reported. */
  private static volatile int filter = -1;
  /** Why the last check() answered the way it did — surfaced in logs so this stays diagnosable. */
  private static volatile String lastReason = "";

  static void cacheInterruptionFilter(int f) { filter = f; }
  public static String reason() { return lastReason; }

  /**
   * @param respectDnd  honor Do Not Disturb (true for phone notifications; false when the user has
   *                    explicitly tapped the badge, which is consent enough).
   * @param holdForNav  wait out navigation guidance / assistant speech (config: notif_hold_nav).
   */
  public static int check(Context ctx, boolean respectDnd, boolean holdForNav) {
    if (respectDnd && dndOn(ctx)) { lastReason = "Do Not Disturb is on"; return HOLD; }
    if (inCall(ctx)) { lastReason = "a call is in progress (audio mode " + mode(ctx) + ")"; return HOLD; }
    int busy = playbackBusy(ctx, holdForNav);
    if (busy != OK) return busy;      // playbackBusy sets its own reason
    lastReason = "clear";
    return OK;
  }

  /** Convenience for the notification reader, which reads both toggles from SharedPreferences. */
  public static int check(Context ctx) {
    android.content.SharedPreferences p = ctx.getSharedPreferences("asmltr", Context.MODE_PRIVATE);
    return check(ctx, p.getBoolean("notif_respect_dnd", true), p.getBoolean("notif_hold_nav", true));
  }

  // ── the three questions ─────────────────────────────────────────────────────

  /** Any interruption filter other than "allow all" means the user asked for quiet. */
  public static boolean dndOn(Context ctx) {
    int f = filter;
    if (f <= NotificationManager.INTERRUPTION_FILTER_UNKNOWN) {
      // Fallback for when the listener hasn't connected yet. Only meaningful if we hold policy access
      // or notification access; otherwise it answers UNKNOWN and we treat that as "not silenced".
      try {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) f = nm.getCurrentInterruptionFilter();
      } catch (Throwable t) { f = NotificationManager.INTERRUPTION_FILTER_UNKNOWN; }
    }
    // ALL(1) = no DND. PRIORITY(2) / NONE(3) / ALARMS(4) all mean some form of DND is on.
    return f >= NotificationManager.INTERRUPTION_FILTER_PRIORITY;
  }

  /** A cellular or VoIP call is up (or ringing). No permission required — the audio mode says so. */
  public static boolean inCall(Context ctx) {
    int m = mode(ctx);
    if (m == AudioManager.MODE_IN_CALL || m == AudioManager.MODE_IN_COMMUNICATION || m == AudioManager.MODE_RINGTONE) return true;
    // MODE_CALL_SCREENING (4, API 30), MODE_CALL_REDIRECT (5) and MODE_COMMUNICATION_REDIRECT (6, API 31)
    // are referenced numerically so this still compiles against an older platform SDK.
    if (Build.VERSION.SDK_INT >= 30 && m == 4) return true;
    if (Build.VERSION.SDK_INT >= 31 && (m == 5 || m == 6)) return true;
    return false;
  }

  private static int mode(Context ctx) {
    try {
      AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
      return am == null ? AudioManager.MODE_NORMAL : am.getMode();
    } catch (Throwable t) { return AudioManager.MODE_NORMAL; }
  }

  /**
   * Inspect who is actually playing audio right now. Best-effort: the API is 26+, and a non-privileged
   * caller sees an anonymized copy of each player's attributes — the usage survives, which is all we
   * need. Anything unreadable falls through as "not busy" and the audio-focus request in Speech becomes
   * the backstop.
   *
   * Music/games are NOT busy: those get ducked (that's the whole point of the focus request) rather than
   * deferred, so a spoken synopsis lands over quieted music instead of on top of it.
   */
  private static int playbackBusy(Context ctx, boolean holdForNav) {
    if (Build.VERSION.SDK_INT < 26) return OK;
    try {
      AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
      if (am == null) return OK;
      List<AudioPlaybackConfiguration> cfgs = am.getActivePlaybackConfigurations();
      if (cfgs == null) return OK;
      for (AudioPlaybackConfiguration c : cfgs) {
        int u;
        try { u = c.getAudioAttributes().getUsage(); } catch (Throwable t) { continue; }
        if (u == android.media.AudioAttributes.USAGE_VOICE_COMMUNICATION
            || u == android.media.AudioAttributes.USAGE_VOICE_COMMUNICATION_SIGNALLING) {
          lastReason = "a voice call is playing audio"; return HOLD;
        }
        if (!holdForNav) continue;
        if (u == android.media.AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE) {
          lastReason = "navigation guidance is speaking"; return WAIT;
        }
        if (u == android.media.AudioAttributes.USAGE_ASSISTANT) {
          lastReason = "another assistant is speaking"; return WAIT;
        }
        if (u == android.media.AudioAttributes.USAGE_ALARM || u == android.media.AudioAttributes.USAGE_NOTIFICATION_RINGTONE) {
          lastReason = "an alarm/ringtone is sounding"; return WAIT;
        }
        if (u == android.media.AudioAttributes.USAGE_ASSISTANCE_ACCESSIBILITY) {
          lastReason = "an accessibility service is speaking"; return WAIT;
        }
      }
    } catch (Throwable t) { /* advisory only */ }
    return OK;
  }
}
