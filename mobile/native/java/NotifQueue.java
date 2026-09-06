package com.asmltr.assistant;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The held-notification queue: what the reader WOULD have said, kept until the moment is right.
 *
 * When SpeakGate says the ear is busy (a call, Do Not Disturb, navigation), the triaged synopsis lands
 * here instead of being spoken or thrown away, and the corner badge appears. Tapping the badge reads the
 * whole backlog in one go; dragging it to the ✕ discards it.
 *
 * Persisted as JSON in SharedPreferences so a five-minute phone call — or the listener process being
 * restarted by the system mid-call — doesn't lose the backlog. Stale entries expire: a synopsis from
 * three hours ago is noise, not news.
 */
class NotifQueue {
  private static final String KEY = "notif_held";
  private static final int MAX = 25;
  private static final long TTL_MS = 3 * 60 * 60 * 1000L;   // 3 hours

  private static SharedPreferences prefs(Context c) {
    return c.getApplicationContext().getSharedPreferences("asmltr", Context.MODE_PRIVATE);
  }

  /** Queue a synopsis. Returns the new backlog size. */
  static synchronized int add(Context ctx, String synopsis, String app) {
    if (synopsis == null || synopsis.trim().isEmpty()) return size(ctx);
    try {
      JSONArray arr = items(ctx);
      JSONObject o = new JSONObject();
      o.put("text", synopsis.trim());
      o.put("app", app == null ? "" : app);
      o.put("at", System.currentTimeMillis());
      arr.put(o);
      // Keep the newest MAX. An overflowing backlog means the user has been away a long time; the oldest
      // items are the least worth reading back.
      while (arr.length() > MAX) arr.remove(0);
      prefs(ctx).edit().putString(KEY, arr.toString()).apply();
      return arr.length();
    } catch (Throwable t) { return size(ctx); }
  }

  /** The live backlog, with expired entries pruned (and persisted back if anything was dropped). */
  static synchronized JSONArray items(Context ctx) {
    JSONArray out = new JSONArray();
    try {
      String raw = prefs(ctx).getString(KEY, "");
      if (raw == null || raw.isEmpty()) return out;
      JSONArray arr = new JSONArray(raw);
      long cutoff = System.currentTimeMillis() - TTL_MS;
      boolean pruned = false;
      for (int i = 0; i < arr.length(); i++) {
        JSONObject o = arr.optJSONObject(i);
        if (o == null) { pruned = true; continue; }
        if (o.optLong("at", 0) < cutoff) { pruned = true; continue; }
        out.put(o);
      }
      if (pruned) prefs(ctx).edit().putString(KEY, out.toString()).apply();
    } catch (Throwable t) { /* a corrupt queue is an empty queue */ }
    return out;
  }

  static int size(Context ctx) { return items(ctx).length(); }

  static synchronized void clear(Context ctx) {
    try { prefs(ctx).edit().remove(KEY).apply(); } catch (Throwable t) {}
  }

  /**
   * The backlog as one utterance. Deliberately assembled in code rather than re-summarized by the
   * model: each synopsis was already triaged into a readable sentence, and a second round-trip would
   * add latency and a chance to lose something the user is waiting to hear.
   */
  static String spokenText(Context ctx) {
    JSONArray arr = items(ctx);
    if (arr.length() == 0) return "";
    if (arr.length() == 1) return arr.optJSONObject(0).optString("text", "");
    StringBuilder sb = new StringBuilder();
    sb.append("Here's what came in while you were busy. ");
    for (int i = 0; i < arr.length(); i++) {
      String t = arr.optJSONObject(i).optString("text", "").trim();
      if (t.isEmpty()) continue;
      sb.append(t);
      if (!t.endsWith(".") && !t.endsWith("!") && !t.endsWith("?")) sb.append('.');
      sb.append(' ');
    }
    return sb.toString().trim();
  }
}
