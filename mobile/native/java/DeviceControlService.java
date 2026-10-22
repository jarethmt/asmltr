package com.asmltr.assistant;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.IBinder;
import android.util.Base64;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The persistent control link. A foreground service that holds a long-lived SSE to the android
 * connector's /gw/control and executes device_rpc frames NATIVELY (via DeviceTools) — so any agent
 * session can actuate the phone even when the overlay/app is closed. Independent of the WebView, so
 * closing the assistant UI no longer drops the connection. Dependency-free (HttpURLConnection SSE
 * reader); reconnects with backoff; started on app-open and on boot.
 */
public class DeviceControlService extends Service {
  static final String ACTION_START = "com.asmltr.assistant.CONTROL_START";
  static final String ACTION_STOP = "com.asmltr.assistant.CONTROL_STOP";
  private static final String CH = "asmltr_control";
  private volatile boolean running = false;
  private Thread worker;
  private DeviceTools tools;

  // --- Portal relay (ported from insights/dashboard/src/services/portalRelay.js) ---------------------
  // The SOLE driver of a paired asmltr-portal-* dongle — foreground AND background/locked. Because the
  // service always owns the dongle, locking the phone changes nothing (no owner handoff, no race that
  // left the dongle clamped). ALWAYS-ON: the moment a paired dongle is advertising (and we're not
  // yielded) we CONNECT and STAY connected — proactively, without waiting for a command — negotiate
  // Wi-Fi up front, and self-heal a dead/wedged link by dropping + rescanning (the fix for the state
  // that used to need a force-stop). The only intentional disconnect is a yield or the service stopping.
  // Commands still flow over a held long-poll to the core (GET …/exec/next?wait=25). Owns its OWN
  // NativeConfig (its own single GATT). It yields the dongle ONLY while the in-app Portal/Adopt screen
  // is open (see portalYielded) — the one time BLE is driven directly from the WebView.
  // TRADEOFF (Jareth's explicit call, 2026-10): holding BLE + Wi-Fi Direct continuously draws more power
  // than the old on-demand/idle-drop relay. We accept that cost for a link that is reliably up and heals
  // itself without a force-stop — reliability/always-on over battery.
  private static final String PORTAL_SVC    = "00657665-5f61-736d-6c74-72706f727401";
  private static final String PORTAL_INFO   = "00657665-5f61-736d-6c74-72706f727402";
  private static final String PORTAL_EXEC   = "00657665-5f61-736d-6c74-72706f727408";
  private static final String PORTAL_IOBACK = "00657665-5f61-736d-6c74-72706f727409";
  private static final String PORTAL_WIFI   = "00657665-5f61-736d-6c74-72706f72740a";
  private static final String PORTAL_CFG    = "00657665-5f61-736d-6c74-72706f72740b";  // mesh provisioning
  private static final String PORTAL_NAME_PREFIX = "asmltr-portal-";
  private static final String PORTAL_ID = "default";          // single-dongle channel id (matches RELAY_ID)
  private static final int  PORTAL_SCAN_MS = 4000;
  private static final int  PORTAL_IOBACK_POLL_MS = 500;
  private static final int  PORTAL_IOBACK_WINDOW_MS = 6000;   // quiet window after a command before we stop pumping
  private static final long PORTAL_PRESENCE_INTERVAL_MS = 5 * 60 * 1000;  // throttle for present=false while the dongle is absent
  private static final long PORTAL_HEALTH_INTERVAL_MS = 15000;     // keepalive cadence while a link is held
  private static final long PORTAL_HEALTH_READ_TIMEOUT_MS = 6000;  // a keepalive read must complete within this or the link is dead
  private static final long PORTAL_WIFI_RETRY_MS = 30000;          // opportunistic Wi-Fi upgrade retry while still on BLE
  private static final long PORTAL_RECONNECT_BACKOFF_MS = 3000;    // backoff between connect attempts when the dongle isn't reachable
  private volatile boolean portalRunning = false;
  private Thread portalWorker;
  private Thread portalPumpThread;         // continuous ioback drain while a dongle link is held
  private NativeConfig portalBle;          // the relay's own BLE/Wi-Fi bridge (its own GATT)
  // Single-owner gate: the native service owns the dongle ALWAYS (foreground AND background) EXCEPT
  // while the in-app Portal/Adopt screen is open driving BLE directly. That screen flips this via the
  // JS bridge (NativeConfig.portalServiceYield → sets this static); when true the relay drops its link
  // and idles so the screen can scan/connect the single dongle. Volatile — written on the bridge/UI
  // thread, read on the relay + pump threads.
  public static volatile boolean portalYielded = false;
  // One-shot mesh provisioning payload queued from the WebView (NativeConfig.portalProvision). The
  // relay worker writes it to the dongle's CFG char on the next held loop, then clears it — keeping
  // the single-owner model (the worker owns the one BLE connection; the WebView never writes directly).
  public static volatile String portalPendingCfg = null;
  private boolean portalHeld = false;      // true while we hold a connection to a paired dongle
  private String portalTransport = "ble";  // 'ble' | 'wifi' — active data path for the current connection
  private JSONObject portalInfo;           // last-read dongle identity { kind,name,fw,trust,host_os? }
  private long portalLastPresence = 0;     // last present=false post (throttle) while the dongle is absent
  private long portalLastHealth = 0;       // last keepalive check while held
  private int  portalHealthFails = 0;      // consecutive keepalive misses (Doze tolerance — drop only after N)
  private long portalLastWifiTry = 0;      // last Wi-Fi-upgrade attempt (throttles the opportunistic retry)
  private boolean portalWifiPermHinted = false;  // posted the nearby-devices-permission hint once this session

  @Override public IBinder onBind(Intent i) { return null; }

  @Override public void onCreate() {
    super.onCreate();
    tools = new DeviceTools(this);
    portalBle = new NativeConfig(this);   // its own instance → its own single GATT, owned by this service
    startForeground(43, buildNotification("Connecting…"));
  }

  @Override public int onStartCommand(Intent intent, int flags, int startId) {
    if (intent != null && ACTION_STOP.equals(intent.getAction())) { running = false; portalRunning = false; stopSelf(); return START_NOT_STICKY; }
    if (!running) { running = true; worker = new Thread(this::loop, "asmltr-control"); worker.start(); }
    if (!portalRunning) {
      portalRunning = true;
      portalWorker = new Thread(this::portalLoop, "asmltr-portal"); portalWorker.start();
      portalPumpThread = new Thread(this::portalPumpLoop, "asmltr-portal-pump"); portalPumpThread.start();
    }
    try { WakeWord.refresh(this); } catch (Throwable t) {} // (re)configure always-on wake word if enabled
    try { NotifBadgeOverlay.restore(this); } catch (Throwable t) {} // re-raise the held-notification badge after a restart
    return START_STICKY; // Android restarts us if killed → the link is meant to be always-on
  }

  private SharedPreferences prefs() { return getSharedPreferences("asmltr", Context.MODE_PRIVATE); }

  private void loop() {
    int backoff = 2000;
    while (running) {
      SharedPreferences p = prefs();
      String base = p.getString("baseUrl", ""), token = p.getString("token", ""), name = p.getString("name", "android");
      String device = NativeConfig.deviceId(this);
      if (base.isEmpty() || token.isEmpty()) { sleep(5000); continue; } // not configured yet
      HttpURLConnection c = null;
      try {
        String url = base + "/gw/control?token=" + enc(token) + "&device=" + enc(device) + "&name=" + enc(name);
        c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestProperty("Accept", "text/event-stream");
        c.setConnectTimeout(15000); c.setReadTimeout(0); // no read timeout — it's a long-lived stream
        c.connect();
        if (c.getResponseCode() != 200) { updateNote("Auth/failed (" + c.getResponseCode() + ")"); sleep(backoff); backoff = Math.min(backoff * 2, 60000); continue; }
        updateNote("Connected"); backoff = 2000;
        try { WakeWord.refresh(this); } catch (Throwable t) {} // pick up wake-word config changes on (re)connect
        BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"));
        String line;
        while (running && (line = r.readLine()) != null) {
          if (!line.startsWith("data:")) continue;
          String payload = line.substring(5).trim();
          if (payload.isEmpty()) continue;
          try {
            JSONObject o = new JSONObject(payload);
            String type = o.optString("type");
            if ("device_rpc".equals(type)) handleRpc(base, token, device, o);
            else if ("speak".equals(type)) {
              final String text = o.optString("text");
              final boolean hp = o.optBoolean("require_headphones", false);
              // Off the SSE thread: ReadAloud blocks (it may wait out a nav prompt, then speak a whole
              // clip) and stalling the reader here would freeze the control link for the duration.
              // respectDnd=false — the notify ladder already applies its own quiet hours server-side, so
              // this only defers for a live call / another voice on the route, badging it if it can't speak.
              new Thread(() -> {
                if (hp && !Speech.headphonesConnected(this)) return;
                ReadAloud.deliver(this, base, token, text, false, "asmltr");
              }, "asmltr-speak").start();
            }
          } catch (Exception ignore) {}
        }
      } catch (Exception e) {
        updateNote("Reconnecting…");
      } finally { if (c != null) try { c.disconnect(); } catch (Exception e) {} }
      if (running) { sleep(backoff); backoff = Math.min(backoff * 2, 60000); }
    }
  }

  private void handleRpc(final String base, final String token, final String device, JSONObject o) {
    final String id = o.optString("id");
    final String tool = o.optString("tool");
    final JSONObject args = o.optJSONObject("args");
    // Run each command on its own thread so the SSE read loop keeps flowing AND blocking gesture/
    // screenshot ops (whose callbacks land on the main/other threads) don't deadlock. DeviceTools' own
    // actuators are thread-safe (startActivity uses NEW_TASK; accessibility APIs are callable off-main).
    new Thread(() -> {
      String r;
      try { r = tools.dispatch(tool, args != null ? args.toString() : "{}"); }
      catch (Exception e) { r = "{\"ok\":false,\"error\":\"" + (e.getMessage() == null ? "error" : e.getMessage()) + "\"}"; }
      postResult(base, token, device, id, r);
    }, "asmltr-rpc").start();
  }

  private void postResult(String base, String token, String device, String id, String resultJson) {
    HttpURLConnection c = null;
    try {
      c = (HttpURLConnection) new URL(base + "/gw/rpc-result").openConnection();
      c.setRequestMethod("POST"); c.setDoOutput(true);
      c.setRequestProperty("Content-Type", "application/json");
      c.setConnectTimeout(10000); c.setReadTimeout(10000);
      JSONObject body = new JSONObject();
      body.put("token", token); body.put("device", device); body.put("id", id);
      try { body.put("result", new JSONObject(resultJson)); } catch (Exception e) { body.put("result", resultJson); }
      OutputStream os = c.getOutputStream(); os.write(body.toString().getBytes("UTF-8")); os.close();
      c.getResponseCode(); // fire
    } catch (Exception e) { /* the connector times the RPC out if we can't answer */ }
    finally { if (c != null) try { c.disconnect(); } catch (Exception e) {} }
  }

  private static String enc(String s) { try { return URLEncoder.encode(s, "UTF-8"); } catch (Exception e) { return ""; } }
  private void sleep(long ms) { try { Thread.sleep(ms); } catch (InterruptedException e) {} }

  private Notification buildNotification(String text) {
    if (Build.VERSION.SDK_INT >= 26) {
      NotificationChannel ch = new NotificationChannel(CH, "Assistant device link", NotificationManager.IMPORTANCE_MIN);
      ch.setShowBadge(false);
      ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(ch);
    }
    Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CH) : new Notification.Builder(this);
    return b.setContentTitle("Assistant device link").setContentText(text)
      .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth).setOngoing(true).build();
  }
  private void updateNote(String text) {
    try { ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(43, buildNotification(text)); } catch (Exception e) {}
  }

  @Override public void onDestroy() {
    running = false; portalRunning = false;
    try { WakeWord.stop(); } catch (Throwable t) {}
    if (worker != null) worker.interrupt();
    if (portalWorker != null) portalWorker.interrupt();
    if (portalPumpThread != null) portalPumpThread.interrupt();
    try { portalDrop(); } catch (Throwable t) {}
    super.onDestroy();
  }

  // ================================ Portal background relay ========================================
  // Logic ported from insights/dashboard/src/services/portalRelay.js. The WebView relay there posts to
  // /v2/portal/* RELATIVE to the loaded dashboard page origin; this worker needs that SAME absolute
  // origin. See portalBase() for the derivation.

  private void portalLoop() {
    while (portalRunning) {
      try {
        // Yielded: the in-app Portal/Adopt screen owns the single dongle GATT. Drop ours (so the dongle
        // re-advertises for that screen to reclaim) and idle. Otherwise we drive — foreground AND
        // background/locked (ownership never changes on lock, so there's no handoff race).
        if (portalYielded) {
          if (portalHeld) portalDrop();
          sleep(1500);
          continue;
        }
        String base = portalBase();
        if (base.isEmpty()) { sleep(5000); continue; }
        long nowMs = System.currentTimeMillis();

        // ---- MAINTAIN: not connected → keep trying to connect on our OWN, no command required. --------
        if (!portalHeld) {
          // portalEnsureConnectedPaired → portalScan() first clears any stale native GATT (belt-and-
          // suspenders before every connect attempt), then filtered-scan → connect → read INFO → trust.
          // Quiet (emitErrors=false): on an always-on retry we must NOT spam the core with a "no portal"
          // io line every few seconds.
          boolean ok = portalEnsureConnectedPaired(base, false);
          if (ok) {
            portalPostPresent(base, true);        // reflect the live link immediately
            portalLastHealth = nowMs;
            // Wi-Fi negotiated FIRST — up front on connect, not deferred to the first exec — and HELD
            // for the session. A grant-pending err:perm just leaves us on BLE; the held branch retries.
            portalLastWifiTry = nowMs;
            portalTryWifiUpgrade(base);
          } else {
            // Dongle not in range / not paired / BT off. Reflect "not present" on a long interval (don't
            // hammer the core while it's absent), then short backoff and retry — this is what makes us
            // auto-connect the instant the dongle appears.
            if (nowMs - portalLastPresence > PORTAL_PRESENCE_INTERVAL_MS) { portalLastPresence = nowMs; portalPostPresent(base, false); }
            sleep(PORTAL_RECONNECT_BACKOFF_MS);
          }
          continue;
        }

        // ---- SERVE + SELF-HEAL: connected → run commands AND keep the link healthy. -------------------
        // One-shot mesh provisioning write queued from the WebView — now that we hold the connection,
        // push the config to the dongle's CFG char (it saves to NVS + joins the mesh).
        String pendingCfg = portalPendingCfg;
        if (pendingCfg != null) {
          portalPendingCfg = null;
          try { portalChunkWrite(PORTAL_CFG, pendingCfg.getBytes("UTF-8"), "cfg");
                portalPostIo(base, "mesh config written to portal", true); }
          catch (Exception e) { portalPostIo(base, "mesh config write failed: " + e.getMessage(), true); }
        }
        // Opportunistic Wi-Fi upgrade retry if we're still on BLE (e.g. wifiP2pStart returned err:perm
        // earlier because the app wasn't foreground). Throttled so we don't spin.
        if (!"wifi".equals(portalTransport) && nowMs - portalLastWifiTry > PORTAL_WIFI_RETRY_MS) {
          portalLastWifiTry = nowMs;
          portalTryWifiUpgrade(base);
        }
        // Periodic keepalive — detects a wedged/dead GATT the HTTP long-poll can't see. On failure we
        // drop (→ bleDisconnect + clear portalHeld) so the next maintain cycle rescans + reconnects.
        if (nowMs - portalLastHealth > PORTAL_HEALTH_INTERVAL_MS) {
          portalLastHealth = nowMs;
          if (!portalHealthCheck()) {
            // A locked/dozing phone can miss ONE keepalive (BLE event gap) without the link being dead.
            // Only drop after 2 consecutive misses (~30s of real silence) so Doze blips don't flap the
            // link (blue/green→red→reconnect). A real dead GATT fails every time and still drops in ~30s.
            if (++portalHealthFails >= 2) { portalPostIo(base, "link keepalive failed x2; dropping to reconnect", true); portalHealthFails = 0; portalDrop(); continue; }
          } else {
            portalHealthFails = 0;
            portalPostPresent(base, true);   // heartbeat the live link so server-side `present` stays fresh
          }
        }
        // Battery-cheap wait: one held request up to 25s (the core long-polls, capped at 30s server-side).
        long t0 = System.currentTimeMillis();
        JSONObject cmd;
        try { cmd = portalHttpGetJson(base + "/v2/portal/" + PORTAL_ID + "/exec/next?wait=25", 35000); }
        catch (Exception e) { sleep(3000); continue; }
        long elapsed = System.currentTimeMillis() - t0;
        String mode = cmd != null ? cmd.optString("mode", "") : "";
        if (mode.isEmpty()) {
          // No command. If the response came back fast, the core isn't honoring the long-poll (older
          // build) — back off so we don't tight-loop. (The link stays up regardless; the keepalive holds it.)
          if (elapsed < 2000) sleep(3000);
          continue;
        }
        portalHandleExec(base, mode, cmd.optString("data", ""));
      } catch (Throwable t) {
        sleep(PORTAL_RECONNECT_BACKOFF_MS);
      }
    }
    try { portalDrop(); } catch (Throwable t) {}
  }

  /** Cheap keepalive while a link is held: issue a BLE read of INFO and confirm it COMPLETES within a
   *  short timeout. Returns false — meaning the link is dead and should be dropped — when the read can't
   *  be issued (GATT gone → "not-connected"/err), when the GATT reports disconnected/error, or when it
   *  never completes (a wedged GATT: the HTTP side still long-polls fine, but nothing can drive the
   *  dongle — this is exactly the stuck state that used to require a force-stop of the app). Works on the
   *  Wi-Fi transport too: BLE stays connected underneath Wi-Fi Direct, so this still probes the real link.
   *  Runs on the portalLoop thread only, so it never races an exec write (also single-threaded here); the
   *  pump only drains queues and issues no GATT ops. */
  private boolean portalHealthCheck() {
    try {
      String r = portalBle.bleReadChar(PORTAL_SVC, PORTAL_INFO);
      if (!"ok".equals(r)) return false;   // not-connected / no-service / read-failed / err → link gone
      long deadline = System.currentTimeMillis() + PORTAL_HEALTH_READ_TIMEOUT_MS;
      while (System.currentTimeMillis() < deadline && portalRunning) {
        JSONObject res;
        try { res = new JSONObject(portalBle.bleGattResult()); } catch (Exception e) { res = new JSONObject(); }
        String state = res.optString("state", "");
        if ("done".equals(state)) {
          // Opportunistically refresh identity (e.g. host_os may populate after enrollment).
          try { JSONObject info = new JSONObject(res.optString("value", "{}")); if (info.length() > 0) portalInfo = info; } catch (Exception e) {}
          return true;
        }
        if ("error".equals(state) || "disconnected".equals(state)) return false;
        sleep(200);
      }
      return false;   // stuck in "reading" past the timeout → wedged GATT
    } catch (Throwable t) { return false; }
  }

  /** Absolute base for /v2/portal/* — the dashboard page ORIGIN the WebView relay posts to.
   *  SharedPreferences "baseUrl" is the android-connector base (…/app, reaches /gw/*); the core's
   *  /v2/portal/* lives at the origin root (…), i.e. baseUrl with the trailing "/app" removed. This is
   *  exactly what www/index.html computes as `dash = base.replace(/\/app$/,'')` before loading the SPA,
   *  so the native worker hits the same URLs the WebView relay does. */
  private String portalBase() {
    String base = prefs().getString("baseUrl", "");
    if (base == null) return "";
    base = base.trim();
    while (base.endsWith("/")) base = base.substring(0, base.length() - 1);
    if (base.endsWith("/app")) base = base.substring(0, base.length() - 4);
    return base;
  }

  private void portalHandleExec(String base, String mode, String dataB64) {
    // By now the maintain loop is holding the link and Wi-Fi was already negotiated on connect (no
    // per-command upgrade). This guard is a cheap no-op while held; it only does real work in the rare
    // race where the link dropped between the health-check and this call.
    if (!portalEnsureConnectedPaired(base, true)) { portalPostIo(base, "no paired portal in range", true); return; }
    try {
      int m = "cdc".equals(mode) ? 0x02 : 0x01;
      byte[] data = (dataB64 == null || dataB64.isEmpty()) ? new byte[0] : Base64.decode(dataB64, Base64.DEFAULT);
      byte[] payload = new byte[1 + data.length];
      payload[0] = (byte) m;
      System.arraycopy(data, 0, payload, 1, data.length);
      if ("wifi".equals(portalTransport)) {
        String r = portalBle.wifiP2pWrite(Base64.encodeToString(payload, Base64.NO_WRAP));  // native frames [len:2BE]
        if (!"ok".equals(r)) {   // wifi write failed — fall back to BLE for this command and the rest
          portalTransport = "ble"; try { portalBle.wifiP2pStop(); } catch (Throwable t) {}
          portalPostIo(base, "wifi write failed (" + r + "); back on BLE", true);
          sleep(450); portalChunkWrite(PORTAL_EXEC, payload, "exec");
        }
      } else {
        sleep(450);   // let the ioback-subscribe (CCCD write) settle before the first BLE exec write
        portalChunkWrite(PORTAL_EXEC, payload, "exec");
      }
      // The host's return stream is drained by the continuous portalPumpLoop (runs while connected),
      // not a per-command window — so async output that arrives between commands isn't missed.
    } catch (Exception e) {
      // A drive failure (BLE write stuck/failed, GATT gone) means the link is probably dead or wedged.
      // Surface it and DROP so the maintain loop rescans, reconnects, and re-negotiates Wi-Fi — rather
      // than wedging held-but-dead until the app is force-stopped.
      portalPostIo(base, String.valueOf(e.getMessage()), true);
      portalDrop();
    }
  }

  /** Ensure we hold a connection to a PAIRED dongle (scan+connect+read INFO if needed). */
  private boolean portalEnsureConnectedPaired(String base, boolean emitErrors) {
    if (portalHeld) return true;
    String[] dev = portalScan();
    if (dev == null) {
      if (emitErrors) portalPostIo(base, "scan: no asmltr-portal-* advertising (dongle connected elsewhere, or BT off)", true);
      return false;
    }
    try {
      JSONObject info = portalConnectAndReadInfo(dev[0]);
      if (info == null || !"paired".equals(info.optString("trust"))) {
        if (emitErrors) portalPostIo(base, "connected but trust=" + (info == null ? "?" : info.optString("trust")), true);
        portalDrop();
        return false;
      }
      portalInfo = info; portalHeld = true; portalTransport = "ble";
      return true;
    } catch (Exception e) {
      if (emitErrors) portalPostIo(base, "connect: " + e.getMessage(), true);
      portalDrop();
      return false;
    }
  }

  /** Short scan → the first in-range asmltr-portal-* advertiser, or null. Drops any stale link first
   *  (a held connection stops the dongle advertising; it supports one central), then re-discovers. */
  private String[] portalScan() {
    try { portalBle.bleDisconnect(); } catch (Throwable t) {}
    sleep(600);
    if (!"ok".equals(portalBle.bleStartScan())) return null;
    try {
      long deadline = System.currentTimeMillis() + PORTAL_SCAN_MS;
      while (System.currentTimeMillis() < deadline && portalRunning) {
        try {
          JSONArray arr = new JSONArray(portalBle.bleResults());
          for (int i = 0; i < arr.length(); i++) {
            JSONObject d = arr.getJSONObject(i);
            String name = d.optString("name", "");
            if (name.toLowerCase().startsWith(PORTAL_NAME_PREFIX)) return new String[]{ d.optString("id"), name };
          }
        } catch (Exception e) { /* transient */ }
        sleep(600);
      }
    } finally { try { portalBle.bleStopScan(); } catch (Throwable t) {} }
    return null;
  }

  /** Connect + read INFO. Returns the parsed identity or throws. Subscribes ioback on success. */
  private JSONObject portalConnectAndReadInfo(String deviceId) throws Exception {
    if (!"ok".equals(portalBle.bleConnectAndRead(deviceId, PORTAL_SVC, PORTAL_INFO))) throw new Exception("connect failed");
    long deadline = System.currentTimeMillis() + 20000;
    while (System.currentTimeMillis() < deadline && portalRunning) {
      JSONObject res;
      try { res = new JSONObject(portalBle.bleGattResult()); } catch (Exception e) { res = new JSONObject(); }
      String state = res.optString("state", "");
      if ("done".equals(state)) {
        try { portalBle.bleSubscribeIo(PORTAL_SVC, PORTAL_IOBACK); } catch (Throwable t) { /* best-effort */ }
        try { return new JSONObject(res.optString("value", "{}")); }
        catch (Exception e) { JSONObject o = new JSONObject(); try { o.put("_raw", res.optString("value")); } catch (Exception ex) {} return o; }
      }
      if ("error".equals(state) || "disconnected".equals(state)) throw new Exception("connect: " + res.optString("error", state));
      sleep(400);
    }
    throw new Exception("connect timed out");
  }

  /** One-time-per-connection attempt to upgrade the data path from BLE to Wi-Fi Direct. Any failure
   *  leaves us on BLE. Mirrors portalRelay.js tryWifiUpgrade. */
  private void portalTryWifiUpgrade(String base) {
    if ("wifi".equals(portalTransport) || !portalHeld) return;
    try {
      String started = portalBle.wifiP2pStart();
      if (!"ok".equals(started)) {
        // Not yet granted the nearby-devices/Wi-Fi permission (common when the app isn't foreground) —
        // the native side fired the prompt; the grant persists and the held loop retries opportunistically
        // (PORTAL_WIFI_RETRY_MS), so the fast path comes up on its own once granted. Stay on BLE meanwhile.
        // Hint ONCE per held session so the opportunistic retries don't spam the io stream.
        if (started != null && started.contains("err:perm") && !portalWifiPermHinted) {
          portalPostIo(base, "wifi: grant the nearby-devices permission; the fast path then comes up automatically", true);
          portalWifiPermHinted = true;
        }
        return;
      }
      JSONObject info = null;
      for (int i = 0; i < 40 && portalRunning; i++) {   // ~12s for the group to come up
        try { info = new JSONObject(portalBle.wifiP2pInfo()); } catch (Exception e) { info = new JSONObject(); }
        String st = info.optString("state", "");
        if ("ready".equals(st) || "error".equals(st)) break;
        sleep(300);
      }
      if (info == null || !"ready".equals(info.optString("state")) || info.optString("ssid", "").isEmpty()) {
        try { portalBle.wifiP2pStop(); } catch (Throwable t) {}
        return;
      }
      JSONObject creds = new JSONObject();
      creds.put("ssid", info.optString("ssid"));
      creds.put("pass", info.optString("pass"));
      creds.put("ip", info.optString("goIp", "").isEmpty() ? "192.168.49.1" : info.optString("goIp"));
      creds.put("port", info.optInt("port", 9790));
      portalChunkWrite(PORTAL_WIFI, creds.toString().getBytes("UTF-8"), "wifi-creds");  // dongle joins + dials the GO
      for (int i = 0; i < 40 && portalRunning; i++) {   // ~12s for the dongle's TCP socket to land
        if (portalBle.wifiP2pSockConnected()) { portalTransport = "wifi"; portalPostIo(base, "transport: wifi-direct up", true); return; }
        sleep(300);
      }
      try { portalBle.wifiP2pStop(); } catch (Throwable t) {}   // socket never arrived — stay on BLE
    } catch (Exception e) {
      try { portalBle.wifiP2pStop(); } catch (Throwable t) {}
    }
  }

  /** Chunked write with the dongle's [flags][rsvd][seqBE] reassembly framing (exec + wifi-creds chars).
   *  Ported verbatim from portalRelay.js chunkWriteChar — retries GATT BUSY (rc 201) and waits for each
   *  write-with-response to ack before the next frame. */
  private void portalChunkWrite(String uuid, byte[] payload, String label) throws Exception {
    int mtu = portalBle.bleMtuSize();
    if (mtu <= 0) mtu = 23;
    int chunkData = Math.max(16, Math.min(180, mtu - 3 - 4));
    int seq = 0;
    for (int off = 0; off < payload.length; off += chunkData) {
      int end = Math.min(off + chunkData, payload.length);
      int sliceLen = end - off;
      int first = (off == 0) ? 0x01 : 0x00;
      int last = (off + chunkData >= payload.length) ? 0x02 : 0x00;
      byte[] frame = new byte[4 + sliceLen];
      frame[0] = (byte) (first | last);
      frame[1] = 0;
      frame[2] = (byte) ((seq >> 8) & 0xff);
      frame[3] = (byte) (seq & 0xff);
      System.arraycopy(payload, off, frame, 4, sliceLen);
      String b64 = Base64.encodeToString(frame, Base64.NO_WRAP);
      String r = "init"; int tries = 0;
      while (tries++ < 25) {
        r = portalBle.bleWrite(PORTAL_SVC, uuid, b64);
        if ("ok".equals(r)) break;
        if (r != null && r.contains("write-rc:201")) { sleep(150); continue; }   // busy — back off + retry
        throw new Exception(label + " write: " + r);
      }
      if (!"ok".equals(r)) throw new Exception(label + " write: stuck busy (rc 201)");
      boolean done = false;
      for (int i = 0; i < 50; i++) {
        JSONObject st;
        try { st = new JSONObject(portalBle.bleWriteState()); } catch (Exception e) { st = new JSONObject(); }
        String s = st.optString("state", "");
        if ("done".equals(s)) { done = true; break; }
        if ("error".equals(s)) throw new Exception(st.optString("error", label + " write error"));
        sleep(80);
      }
      if (!done) throw new Exception(label + " write timed out");
      seq++;
    }
  }

  /** Continuous ioback pump: while we hold a dongle link, drain its CDC return stream and
   *  forward each chunk to the core — every ~300ms, not just in a window after a command. So the host's
   *  async output (and a command's response, however delayed) is never missed. Runs on its own thread;
   *  only reads the notification/socket QUEUES (thread-safe), never issues GATT ops, so it can't race the
   *  portalLoop's connect/write. */
  private void portalPumpLoop() {
    while (portalRunning) {
      try {
        if (portalHeld && !portalYielded) {
          String base = portalBase();
          String raw = "wifi".equals(portalTransport) ? portalBle.wifiP2pReadIo() : portalBle.bleNotificationsIo();
          JSONArray arr = new JSONArray((raw == null || raw.isEmpty()) ? "[]" : raw);
          if (arr.length() > 0 && !base.isEmpty()) {
            // BATCH: concatenate every ioback chunk drained this tick into ONE POST, rather than one
            // HTTP round-trip per 512 B chunk (that made a ~50 KB screenshot ~70 phone->core POSTs =
            // slow + lossy). The core's appendIo stores each POST's bytes in order; order is preserved
            // within the batch and across ticks, so the reassembled stream is identical.
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            for (int i = 0; i < arr.length(); i++) {
              String b64 = arr.optString(i, "");
              if (!b64.isEmpty()) { byte[] d = Base64.decode(b64, Base64.DEFAULT); bos.write(d, 0, d.length); }
            }
            byte[] all = bos.toByteArray();
            if (all.length > 0) {
              portalPostIo(base, Base64.encodeToString(all, Base64.NO_WRAP), false);
            }
          }
          // If the Wi-Fi socket dropped mid-session, fall back to BLE for subsequent commands (and this
          // re-enables the BLE idle-drop in portalLoop).
          if ("wifi".equals(portalTransport) && !portalBle.wifiP2pSockConnected()) {
            portalTransport = "ble";
            if (!base.isEmpty()) portalPostIo(base, "wifi-direct dropped; back on BLE", true);
          }
        }
      } catch (Throwable t) { /* ignore */ }
      sleep(300);
    }
  }

  private void portalDrop() {
    try { portalBle.wifiP2pStop(); } catch (Throwable t) {}
    try { portalBle.bleDisconnect(); } catch (Throwable t) {}
    portalHeld = false; portalInfo = null; portalTransport = "ble"; portalWifiPermHinted = false;
  }

  /** POST one ioback chunk (already base64) or a relay-side error (base64 of "[relay] <msg>", so it
   *  surfaces as readable io server-side) to the core. Mirrors portalRelay.js setServerSink portal.io. */
  private void portalPostIo(String base, String text, boolean isError) {
    final String body;
    try {
      String data = isError ? Base64.encodeToString(("[relay] " + text).getBytes("UTF-8"), Base64.NO_WRAP) : text;
      JSONObject b = new JSONObject(); b.put("data", data);
      body = b.toString();
    } catch (Exception e) { return; }
    // Retry on a failed POST so a transient phone->core hiccup doesn't silently drop a chunk of the
    // return stream (the truncation we saw). Short backoff; ordered because the single pump thread calls
    // this synchronously, so a retried chunk still lands before the next tick's batch.
    String url = base + "/v2/portal/" + PORTAL_ID + "/io";
    for (int attempt = 0; attempt < 4; attempt++) {
      if (portalHttpPostJson(url, body)) return;
      sleep(150 * (attempt + 1));
    }
  }

  private void portalPostPresent(String base, boolean paired) {
    try {
      JSONObject b = new JSONObject();
      b.put("paired", paired);
      b.put("name", portalInfo != null ? portalInfo.optString("name", "") : "");
      b.put("host_os", portalInfo != null ? portalInfo.optString("host_os", "") : "");
      portalHttpPostJson(base + "/v2/portal/" + PORTAL_ID + "/present", b.toString());
    } catch (Exception e) {}
  }

  private JSONObject portalHttpGetJson(String urlStr, int readTimeout) throws Exception {
    HttpURLConnection c = null;
    try {
      c = (HttpURLConnection) new URL(urlStr).openConnection();
      c.setConnectTimeout(15000); c.setReadTimeout(readTimeout);
      c.setRequestProperty("Accept", "application/json");
      if (c.getResponseCode() != 200) return null;
      BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"));
      StringBuilder sb = new StringBuilder(); String line;
      while ((line = r.readLine()) != null) sb.append(line);
      r.close();
      String s = sb.toString().trim();
      return s.isEmpty() ? new JSONObject() : new JSONObject(s);
    } finally { if (c != null) try { c.disconnect(); } catch (Exception e) {} }
  }

  private boolean portalHttpPostJson(String urlStr, String body) {
    HttpURLConnection c = null;
    try {
      c = (HttpURLConnection) new URL(urlStr).openConnection();
      c.setRequestMethod("POST"); c.setDoOutput(true);
      c.setRequestProperty("Content-Type", "application/json");
      c.setConnectTimeout(10000); c.setReadTimeout(10000);
      OutputStream os = c.getOutputStream(); os.write(body.getBytes("UTF-8")); os.close();
      int code = c.getResponseCode();
      return code >= 200 && code < 300;   // delivered?
    } catch (Exception e) { return false; /* core offline / idle */ }
    finally { if (c != null) try { c.disconnect(); } catch (Exception e) {} }
  }
}
