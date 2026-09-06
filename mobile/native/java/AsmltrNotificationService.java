package com.asmltr.assistant;

import android.app.Notification;
import android.content.Context;
import android.content.SharedPreferences;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;

/**
 * The Android notification reader (Part B of docs/NOTIFY-READ-ALOUD.md). Captures posted notifications,
 * gates them (enabled · BT audio route · per-app deny · noise filters), collects a ~3s BURST, then asks
 * the asmltr core (via the android connector /gw/notify-triage → DEFAULT reasoning engine, on-device
 * Agent SDK, NOT a metered API) for { speak, priority, synopsis }. If speak && priority >= threshold it
 * reads the synopsis aloud via Speech (the CONFIGURED provider/voice through /gw/tts) over the headphones.
 *
 * IMPORTANT: this path is fully local + native. It deliberately does NOT fall back to push/telegram —
 * a phone notification never bounces to another channel (that's asmltr notify / Part A, a separate system).
 *
 * Config lives in SharedPreferences("asmltr"), written by NativeConfig.saveNotifyConfig from the app UI.
 */
public class AsmltrNotificationService extends NotificationListenerService {
  private static final String TAG = "AsmltrNotif";   // adb logcat -s AsmltrNotif
  private final Handler main = new Handler(Looper.getMainLooper());
  private final List<Item> burst = new ArrayList<>();
  private boolean flushScheduled = false;

  private static class Item { String app, title, text, pkg; long when; }

  private SharedPreferences prefs() { return getSharedPreferences("asmltr", Context.MODE_PRIVATE); }

  /** The interruption filter (Do Not Disturb) is only legible to a bound notification listener, so we
   *  cache it here for SpeakGate — which runs from the badge and the control link too. */
  @Override public void onListenerConnected() {
    try { SpeakGate.cacheInterruptionFilter(getCurrentInterruptionFilter()); } catch (Throwable t) {}
    try { NotifBadgeOverlay.restore(this); } catch (Throwable t) {}   // backlog survived a process restart
  }

  @Override public void onInterruptionFilterChanged(int interruptionFilter) {
    android.util.Log.d(TAG, "interruption filter → " + interruptionFilter + " (DND " + (interruptionFilter >= 2 ? "ON" : "off") + ")");
    SpeakGate.cacheInterruptionFilter(interruptionFilter);
  }

  @Override public void onNotificationPosted(StatusBarNotification sbn) {
    try {
      // Every gate says WHY it dropped a notification. Without this the reader is a black box: it
      // either speaks or it doesn't, with no way to tell which of six conditions bailed.
      SharedPreferences p = prefs();
      if (!p.getBoolean("notif_enabled", false)) { android.util.Log.d(TAG, "drop: reader disabled (notif_enabled=false)"); return; }
      if (sbn == null || sbn.getPackageName() == null) return;
      String pkg = sbn.getPackageName();
      if (pkg.equals(getPackageName())) return;                    // never read our own notifications
      if (isDenied(p, pkg)) { android.util.Log.d(TAG, "drop: " + pkg + " is on the deny list"); return; }

      Notification n = sbn.getNotification();
      if (n == null) return;
      // Skip noise: ongoing/foreground-service notifications and transport/service categories.
      if ((n.flags & Notification.FLAG_ONGOING_EVENT) != 0) { android.util.Log.d(TAG, "drop: " + pkg + " ongoing"); return; }
      if ((n.flags & Notification.FLAG_FOREGROUND_SERVICE) != 0) { android.util.Log.d(TAG, "drop: " + pkg + " foreground-service"); return; }
      String cat = n.category;
      if (Notification.CATEGORY_TRANSPORT.equals(cat) || Notification.CATEGORY_SERVICE.equals(cat) || Notification.CATEGORY_PROGRESS.equals(cat)) { android.util.Log.d(TAG, "drop: " + pkg + " category=" + cat); return; }

      // Headphones gate: only read aloud over a Bluetooth (or wired) audio route, if required.
      if (p.getBoolean("notif_headphones_only", true) && !btRouteOk(p)) {
        android.util.Log.d(TAG, "drop: " + pkg + " — headphones_only is on but no matching audio route"
            + " (wanted='" + p.getString("notif_bt_devices", "") + "')");
        return;
      }

      Bundle ex = n.extras;
      String title = str(ex, Notification.EXTRA_TITLE);
      String text = str(ex, Notification.EXTRA_TEXT);
      if ((title == null || title.isEmpty()) && (text == null || text.isEmpty())) { android.util.Log.d(TAG, "drop: " + pkg + " has no title/text"); return; }
      android.util.Log.d(TAG, "queued: " + pkg + " / " + title);

      Item it = new Item();
      it.pkg = pkg;
      it.app = appLabel(pkg);
      it.title = title == null ? "" : title;
      it.text = text == null ? "" : text;
      it.when = sbn.getPostTime();
      synchronized (burst) { burst.add(it); }
      scheduleFlush();
    } catch (Throwable t) { /* never crash the listener */ }
  }

  // Collect a 3-second burst window, then triage the whole batch at once (so 5 messages become one synopsis).
  private void scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    main.postDelayed(() -> { flushScheduled = false; flush(); }, 3000);
  }

  private void flush() {
    final List<Item> batch = new ArrayList<>();
    synchronized (burst) { batch.addAll(burst); burst.clear(); }
    if (batch.isEmpty()) return;
    new Thread(() -> triageAndSpeak(batch)).start();
  }

  private void triageAndSpeak(List<Item> batch) {
    // Refresh the Do Not Disturb cache from the one component allowed to read it. onInterruptionFilterChanged
    // covers live changes, but a filter set while we were unbound would otherwise go unnoticed.
    try { SpeakGate.cacheInterruptionFilter(getCurrentInterruptionFilter()); } catch (Throwable t) {}
    SharedPreferences p = prefs();
    String base = p.getString("baseUrl", ""), token = p.getString("token", "");
    if (base.isEmpty()) { android.util.Log.w(TAG, "drop: no baseUrl configured — can't reach triage"); return; }
    int threshold = p.getInt("notif_threshold", 40);

    // Build the triage payload. One → its own title/text; many → a combined batch the model summarizes.
    String title, text;
    if (batch.size() == 1) {
      Item it = batch.get(0);
      title = it.app + (it.title.isEmpty() ? "" : (": " + it.title));
      text = it.text;
    } else {
      title = batch.size() + " new notifications";
      StringBuilder sb = new StringBuilder();
      for (Item it : batch) {
        sb.append("• ").append(it.app);
        if (!it.title.isEmpty()) sb.append(" — ").append(it.title);
        if (!it.text.isEmpty()) sb.append(": ").append(it.text);
        sb.append('\n');
      }
      text = sb.toString().trim();
    }

    try {
      JSONObject body = new JSONObject();
      body.put("token", token);
      body.put("title", title);
      body.put("text", text);
      body.put("count", batch.size());
      body.put("app", batch.size() == 1 ? batch.get(0).app : "multiple");
      android.util.Log.d(TAG, "triage → " + base + "/gw/notify-triage  (" + batch.size() + " item(s))");
      JSONObject r = postJson(base + "/gw/notify-triage", body);
      if (r == null) { android.util.Log.w(TAG, "triage returned nothing (network/auth failure)"); return; }
      boolean speak = r.optBoolean("speak", false);
      int priority = r.optInt("priority", 0);
      String synopsis = r.optString("synopsis", "");
      // Read the synopsis in the CONFIGURED voice (ElevenLabs/OpenAI via /gw/tts), not the OS robot engine.
      // The BT-route gate already ran before we buffered this, so no need to re-gate on headphones here.
      android.util.Log.d(TAG, "triage result: speak=" + speak + " priority=" + priority
          + " (threshold=" + threshold + ") synopsis=" + (synopsis.isEmpty() ? "<empty>" : synopsis));
      if (speak && priority >= threshold && !synopsis.isEmpty()) {
        // Hand off to the shared read-aloud door: it speaks now if the ear is free (ducking music),
        // waits out a navigation prompt, or holds the synopsis behind the corner badge during a call
        // or Do Not Disturb. We're already on a worker thread, so blocking here is fine.
        android.util.Log.d(TAG, "DELIVERING");
        ReadAloud.deliver(this, base, token, synopsis, true,
            batch.size() == 1 ? batch.get(0).app : "multiple");
      } else {
        android.util.Log.d(TAG, "not speaking — gate not met");
      }
    } catch (Throwable t) { android.util.Log.w(TAG, "triage failed: " + t); }
  }

  // ── gates + helpers ────────────────────────────────────────────────────────
  private boolean isDenied(SharedPreferences p, String pkg) {
    String csv = p.getString("notif_apps_denied", "");
    if (csv == null || csv.isEmpty()) return false;
    for (String d : csv.split(",")) if (pkg.equalsIgnoreCase(d.trim())) return true;
    return false;
  }

  /** A Bluetooth (or wired) audio output is connected. If specific BT device addresses are configured,
   *  require one of them; otherwise any BT/wired route counts. */
  private boolean btRouteOk(SharedPreferences p) {
    try {
      AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
      if (am == null) return false;
      String wanted = p.getString("notif_bt_devices", "");
      AudioDeviceInfo[] devs = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS);
      for (AudioDeviceInfo d : devs) {
        int type = d.getType();
        boolean bt = type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP || type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO;
        boolean wired = type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES || type == AudioDeviceInfo.TYPE_WIRED_HEADSET
            || type == AudioDeviceInfo.TYPE_USB_HEADSET;
        if (!bt && !wired) continue;
        if (wanted == null || wanted.isEmpty()) return true;         // any headphone route
        String addr = d.getAddress();
        if (addr != null) for (String w : wanted.split(",")) if (addr.equalsIgnoreCase(w.trim())) return true;
      }
    } catch (Throwable t) {}
    return false;
  }

  private String appLabel(String pkg) {
    try { return getPackageManager().getApplicationLabel(getPackageManager().getApplicationInfo(pkg, 0)).toString(); }
    catch (Throwable t) { return pkg; }
  }

  private static String str(Bundle b, String k) {
    if (b == null) return null;
    CharSequence cs = b.getCharSequence(k);
    return cs == null ? null : cs.toString();
  }

  private JSONObject postJson(String url, JSONObject body) {
    HttpURLConnection c = null;
    try {
      c = (HttpURLConnection) new URL(url).openConnection();
      c.setRequestMethod("POST");
      c.setConnectTimeout(8000); c.setReadTimeout(20000);
      c.setDoOutput(true);
      c.setRequestProperty("Content-Type", "application/json");
      byte[] out = body.toString().getBytes("UTF-8");
      try (OutputStream os = c.getOutputStream()) { os.write(out); }
      int code = c.getResponseCode();
      if (code < 200 || code >= 300) return null;
      java.io.InputStream is = c.getInputStream();
      java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
      byte[] buf = new byte[4096]; int n;
      while ((n = is.read(buf)) > 0) bo.write(buf, 0, n);
      return new JSONObject(bo.toString("UTF-8"));
    } catch (Throwable t) { return null; }
    finally { if (c != null) c.disconnect(); }
  }

}
