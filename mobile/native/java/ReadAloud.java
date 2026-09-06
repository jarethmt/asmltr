package com.asmltr.assistant;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * One door for every headless read-aloud on the phone — the notification reader and the `asmltr notify`
 * speak frame both come through here, so "don't talk over me" is implemented once.
 *
 * The rule: ask {@link SpeakGate} whether the ear is free. If it is, speak (ducking whatever music is
 * playing). If something transient is talking — a navigation prompt — wait it out for a few seconds. If
 * the phone is on a call or in Do Not Disturb, don't speak at all: park the line in {@link NotifQueue}
 * and raise the corner badge, which reads the whole backlog when tapped.
 *
 * Every method here BLOCKS (speech is synchronous) and must be called off the main thread.
 */
public class ReadAloud {
  private static final String TAG = "AsmltrNotif";
  private static final int WAIT_TRIES = 4;      // ~20s of patience for a nav prompt to finish
  private static final long WAIT_MS = 5000L;

  /**
   * Speak `text` now, or hold it behind the badge.
   *
   * @param respectDnd  true for phone notifications (Do Not Disturb means the user asked for quiet);
   *                    false for an assistant-initiated notify, whose timing is already governed by the
   *                    server-side quiet hours in the notify ladder.
   */
  public static void deliver(Context ctx, String base, String token, String text, boolean respectDnd, String app) {
    if (text == null || text.trim().isEmpty()) return;
    final Context c = ctx.getApplicationContext();
    SharedPreferences p = c.getSharedPreferences("asmltr", Context.MODE_PRIVATE);
    boolean holdWhenBusy = p.getBoolean("notif_hold_busy", true);
    boolean holdForNav = p.getBoolean("notif_hold_nav", true);

    if (!holdWhenBusy) {                                  // opt-out: old barge-in behavior, still ducked
      NotifEyesOverlay.show(c, text);
      Speech.speakBlocking(c, base, token, text);
      return;
    }

    int gate = SpeakGate.check(c, respectDnd, holdForNav);
    for (int i = 0; gate == SpeakGate.WAIT && i < WAIT_TRIES; i++) {
      android.util.Log.d(TAG, "waiting to speak — " + SpeakGate.reason());
      sleep(WAIT_MS);
      gate = SpeakGate.check(c, respectDnd, holdForNav);
    }

    if (gate == SpeakGate.OK) {
      NotifEyesOverlay.show(c, text);
      int r = Speech.speakBlocking(c, base, token, text);
      NotifEyesOverlay.hide(c);                            // the eyes track the voice, not a length guess
      if (r == Speech.SPOKE) return;
      android.util.Log.d(TAG, "speech did not complete (" + r + ") — holding instead");
    } else {
      android.util.Log.d(TAG, "holding: " + SpeakGate.reason());
    }
    hold(c, text, app);
  }

  /** Queue a line and raise (or bump) the badge. */
  static void hold(Context ctx, String text, String app) {
    int n = NotifQueue.add(ctx, text, app);
    NotifBadgeOverlay.show(ctx, n);
  }

  /**
   * The badge was tapped: read the whole backlog. Do Not Disturb is ignored here — tapping IS the
   * consent — but a live call is still respected, because reading into a call is the exact failure this
   * whole path exists to prevent.
   */
  static void flush(Context ctx) {
    final Context c = ctx.getApplicationContext();
    SharedPreferences p = c.getSharedPreferences("asmltr", Context.MODE_PRIVATE);
    String base = p.getString("baseUrl", ""), token = p.getString("token", "");

    String text = NotifQueue.spokenText(c);
    if (text.isEmpty()) { NotifBadgeOverlay.hide(c); return; }

    if (SpeakGate.check(c, false, p.getBoolean("notif_hold_nav", true)) != SpeakGate.OK) {
      android.util.Log.d(TAG, "badge tapped but still busy: " + SpeakGate.reason());
      NotifBadgeOverlay.setState("busy");
      return;                                              // stay up; they can tap again in a moment
    }

    NotifBadgeOverlay.setState("reading");
    int r = Speech.speakBlocking(c, base, token, text);
    if (r == Speech.SPOKE) {
      NotifQueue.clear(c);
      NotifBadgeOverlay.hide(c);
    } else {
      android.util.Log.d(TAG, "backlog read did not complete (" + r + ") — keeping the badge up");
      NotifBadgeOverlay.setState("busy");
    }
  }

  private static void sleep(long ms) { try { Thread.sleep(ms); } catch (InterruptedException e) {} }
}
