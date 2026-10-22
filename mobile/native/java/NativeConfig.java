package com.asmltr.assistant;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.media.AudioManager;
import android.media.AudioDeviceInfo;
import android.webkit.JavascriptInterface;
import android.Manifest;
import android.content.pm.PackageManager;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothStatusCodes;
import android.util.Base64;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.UUID;

/** Bridge for the app + overlay WebViews: connector config (SharedPreferences, merge semantics),
 *  the installed version, and a robust in-app updater via the PackageInstaller session API (no
 *  app-chooser, no FileProvider — streams the APK straight to the system installer + confirm dialog). */
public class NativeConfig {
  private final Context ctx;
  public NativeConfig(Context c) { ctx = c; }

  @JavascriptInterface
  public void saveConfig(String baseUrl, String token, String name) {
    SharedPreferences.Editor e = ctx.getSharedPreferences("asmltr", Context.MODE_PRIVATE).edit();
    if (baseUrl != null && !baseUrl.isEmpty()) e.putString("baseUrl", baseUrl);
    if (token != null && !token.isEmpty()) e.putString("token", token);
    if (name != null && !name.isEmpty()) e.putString("name", name);
    e.apply();
    // Config just landed → (re)start the persistent control link so the phone connects on its own.
    startControlLink();
  }

  /** A stable per-install device id, shared by the web chat stream and the native control link so both
   *  map to the same conversation. Generated once, persisted in SharedPreferences. */
  static String deviceId(Context ctx) {
    SharedPreferences p = ctx.getSharedPreferences("asmltr", Context.MODE_PRIVATE);
    String id = p.getString("deviceId", "");
    if (id == null || id.isEmpty()) { id = "dev-" + UUID.randomUUID().toString().substring(0, 12); p.edit().putString("deviceId", id).apply(); }
    return id;
  }
  @JavascriptInterface
  public String getDeviceId() { return deviceId(ctx); }

  // --- BLE discovery (native) -------------------------------------------------------------------
  // The dashboard loads as a REMOTE page where Capacitor plugins don't bridge, so BLE goes through
  // this addJavascriptInterface bridge (same mechanism as the rest of AsmltrNative). JS starts a scan,
  // polls bleResults(), then stops. FILTERED by the Portal service UUID so it works screen-off (Android blocks unfiltered scans then); downstream still prefix-checks the name.
  private BluetoothLeScanner bleScanner;
  private ScanCallback bleCallback;
  private final Map<String, JSONObject> bleFound = new ConcurrentHashMap<>();

  @JavascriptInterface
  public boolean bleScanPermitted() {
    return Build.VERSION.SDK_INT < 31 || ctx.checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED;
  }

  @JavascriptInterface
  public String bleStartScan() {
    try {
      if (!bleScanPermitted()) return "no-permission";
      BluetoothManager m = (BluetoothManager) ctx.getSystemService(Context.BLUETOOTH_SERVICE);
      BluetoothAdapter a = m != null ? m.getAdapter() : null;
      if (a == null) return "no-adapter";
      if (!a.isEnabled()) return "bt-off";
      bleScanner = a.getBluetoothLeScanner();
      if (bleScanner == null) return "no-scanner";
      bleFound.clear();
      bleCallback = new ScanCallback() {
        @Override public void onScanResult(int type, ScanResult r) {
          try {
            String name = r.getScanRecord() != null ? r.getScanRecord().getDeviceName() : null;
            // The scan is FILTERED to the Portal service UUID, so every hit IS a Portal. Screen-off
            // offload results carry only the primary packet (the name lives in the scan response, unseen),
            // so a hit may be nameless — label it so the downstream asmltr-portal- prefix checks still
            // accept it; the real name is read from INFO on connect.
            if (name == null || name.isEmpty()) name = "asmltr-portal-?";
            JSONObject o = new JSONObject();
            o.put("id", r.getDevice().getAddress()); o.put("name", name); o.put("rssi", r.getRssi());
            bleFound.put(r.getDevice().getAddress(), o);
          } catch (Exception e) {}
        }
      };
      ScanSettings s = new ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build();
      // FILTER by the Portal service UUID (…727401). A filtered scan is the only kind Android will run
      // with the screen off — so this is what lets the background service discover the dongle when locked.
      java.util.List<ScanFilter> filters = new java.util.ArrayList<>();
      filters.add(new ScanFilter.Builder()
          .setServiceUuid(android.os.ParcelUuid.fromString("00657665-5f61-736d-6c74-72706f727401"))
          .build());
      bleScanner.startScan(filters, s, bleCallback);
      return "ok";
    } catch (Exception e) { return "err:" + e.getMessage(); }
  }

  @JavascriptInterface
  public String bleResults() {
    JSONArray arr = new JSONArray();
    for (JSONObject o : bleFound.values()) arr.put(o);
    return arr.toString();
  }

  @JavascriptInterface
  public void bleStopScan() {
    try { if (bleScanner != null && bleCallback != null) bleScanner.stopScan(bleCallback); } catch (Exception e) {}
    bleCallback = null;
  }

  // --- BLE GATT session: connect, read, write, subscribe (persistent callback) ------------------
  // One held connection drives the whole control flow: read `info`, write `pair`, chunk `load`,
  // trigger `run`, and receive `status` notifications — all on the same gatt via a single callback.
  private BluetoothGatt gatt;
  private volatile String gattState = "idle";   // idle|connecting|connected|reading|done|error|disconnected
  private volatile String gattValue = "";        // last read characteristic value (UTF-8)
  private volatile String gattError = "";
  private volatile String writeState = "idle";   // idle|writing|done|error
  private volatile String writeError = "";
  private volatile int    bleMtu = 23;           // negotiated ATT MTU (payload = mtu-3)
  private final java.util.concurrent.ConcurrentLinkedQueue<String> bleNotif = new java.util.concurrent.ConcurrentLinkedQueue<>();
  // Second, independent notify path for the Portal `ioback` char (the host's CDC return stream).
  // Kept separate from `bleNotif` (status) so both can be subscribed on the same GATT at once and
  // drained without racing. ioback may be binary (e.g. JPEG screenshots over CDC), so entries are
  // stored base64-encoded (binary-safe) and the JS side decodes — unlike status, which is UTF-8 text.
  private final java.util.concurrent.ConcurrentLinkedQueue<String> bleIoNotif = new java.util.concurrent.ConcurrentLinkedQueue<>();
  private volatile java.util.UUID ioChar;   // when set, notifications from this char route to bleIoNotif
  private java.util.UUID readSvc, readChar;

  private final BluetoothGattCallback gattCb = new BluetoothGattCallback() {
    @Override public void onConnectionStateChange(BluetoothGatt g, int status, int newState) {
      if (newState == BluetoothProfile.STATE_CONNECTED) {
        gattState = "connected";
        try { g.requestMtu(247); } catch (Exception e) {}
        try { g.discoverServices(); } catch (Exception e) {}
      } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
        bleMtu = 23;
        if (!"done".equals(gattState) && !"error".equals(gattState)) gattState = "disconnected";
      }
    }
    @Override public void onMtuChanged(BluetoothGatt g, int mtu, int status) {
      if (status == BluetoothGatt.GATT_SUCCESS) bleMtu = mtu;
    }
    @Override public void onServicesDiscovered(BluetoothGatt g, int status) {
      // If a read was requested on connect (identity), do it now; otherwise just mark connected.
      if (readChar == null) { gattState = "done"; return; }
      try {
        BluetoothGattService svc = g.getService(readSvc);
        if (svc == null) { gattState = "error"; gattError = "service not found"; return; }
        BluetoothGattCharacteristic ch = svc.getCharacteristic(readChar);
        if (ch == null) { gattState = "error"; gattError = "characteristic not found"; return; }
        gattState = "reading"; g.readCharacteristic(ch);
      } catch (Exception e) { gattState = "error"; gattError = String.valueOf(e.getMessage()); }
    }
    @Override public void onCharacteristicRead(BluetoothGatt g, BluetoothGattCharacteristic ch, int status) {
      if (status == BluetoothGatt.GATT_SUCCESS && ch.getValue() != null) { gattValue = new String(ch.getValue()); gattState = "done"; }
      else { gattState = "error"; gattError = "read status " + status; }
    }
    @Override public void onCharacteristicWrite(BluetoothGatt g, BluetoothGattCharacteristic ch, int status) {
      if (status == BluetoothGatt.GATT_SUCCESS) { writeState = "done"; }
      else { writeState = "error"; writeError = "write status " + status; }
    }
    @Override public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic ch) {
      try {
        byte[] v = ch.getValue();
        if (v == null) return;
        if (ioChar != null && ioChar.equals(ch.getUuid())) bleIoNotif.add(Base64.encodeToString(v, Base64.NO_WRAP));
        else bleNotif.add(new String(v));   // status: UTF-8 text, unchanged (backward compatible)
      } catch (Exception e) {}
    }
  };

  @JavascriptInterface
  public String bleConnectAndRead(String deviceId, String serviceUuid, String charUuid) {
    try {
      BluetoothManager m = (BluetoothManager) ctx.getSystemService(Context.BLUETOOTH_SERVICE);
      BluetoothAdapter a = m != null ? m.getAdapter() : null;
      if (a == null) return "no-adapter";
      bleStopScan();
      try { if (gatt != null) { gatt.close(); gatt = null; } } catch (Exception e) {}
      gattState = "connecting"; gattValue = ""; gattError = ""; writeState = "idle"; writeError = ""; bleMtu = 23; bleNotif.clear(); bleIoNotif.clear(); ioChar = null;
      readSvc = java.util.UUID.fromString(serviceUuid);
      readChar = java.util.UUID.fromString(charUuid);
      BluetoothDevice dev = a.getRemoteDevice(deviceId);
      gatt = dev.connectGatt(ctx, false, gattCb);
      return "ok";
    } catch (Exception e) { gattState = "error"; gattError = String.valueOf(e.getMessage()); return "err:" + e.getMessage(); }
  }

  @JavascriptInterface
  public String bleGattResult() {
    try { JSONObject o = new JSONObject(); o.put("state", gattState); o.put("value", gattValue); o.put("error", gattError); return o.toString(); }
    catch (Exception e) { return "{\"state\":\"error\"}"; }
  }

  // Re-read a characteristic on the live connection (e.g. `info` again after pairing). Poll bleGattResult().
  @JavascriptInterface
  public String bleReadChar(String serviceUuid, String charUuid) {
    if (gatt == null) return "not-connected";
    try {
      gattState = "reading"; gattValue = ""; gattError = "";
      BluetoothGattService svc = gatt.getService(java.util.UUID.fromString(serviceUuid));
      if (svc == null) return "no-service";
      BluetoothGattCharacteristic ch = svc.getCharacteristic(java.util.UUID.fromString(charUuid));
      if (ch == null) return "no-char";
      return gatt.readCharacteristic(ch) ? "ok" : "read-failed";
    } catch (Exception e) { return "err:" + e.getMessage(); }
  }

  // Write one base64 value to a characteristic (pair / load-chunk / run). Poll bleWriteState().
  @JavascriptInterface
  public String bleWrite(String serviceUuid, String charUuid, String base64Value) {
    if (gatt == null) return "not-connected";
    try {
      byte[] val = Base64.decode(base64Value, Base64.DEFAULT);
      BluetoothGattService svc = gatt.getService(java.util.UUID.fromString(serviceUuid));
      if (svc == null) return "no-service";
      BluetoothGattCharacteristic ch = svc.getCharacteristic(java.util.UUID.fromString(charUuid));
      if (ch == null) return "no-char";
      writeState = "writing"; writeError = "";
      int wt = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT;  // write-with-response: acked ordering
      if (Build.VERSION.SDK_INT >= 33) {
        int rc = gatt.writeCharacteristic(ch, val, wt);
        return rc == BluetoothStatusCodes.SUCCESS ? "ok" : ("write-rc:" + rc);
      } else {
        ch.setWriteType(wt); ch.setValue(val);
        return gatt.writeCharacteristic(ch) ? "ok" : "write-failed";
      }
    } catch (Exception e) { writeState = "error"; writeError = String.valueOf(e.getMessage()); return "err:" + e.getMessage(); }
  }

  @JavascriptInterface
  public String bleWriteState() {
    try { JSONObject o = new JSONObject(); o.put("state", writeState); o.put("error", writeError); return o.toString(); }
    catch (Exception e) { return "{\"state\":\"error\"}"; }
  }

  // Shared CCCD-enable routine for any NOTIFY characteristic. Both the status and ioback subscribes
  // use it; the only difference is which drain queue the char's data lands in (see onCharacteristicChanged).
  private String enableNotify(String serviceUuid, String charUuid) {
    if (gatt == null) return "not-connected";
    try {
      BluetoothGattService svc = gatt.getService(java.util.UUID.fromString(serviceUuid));
      if (svc == null) return "no-service";
      BluetoothGattCharacteristic ch = svc.getCharacteristic(java.util.UUID.fromString(charUuid));
      if (ch == null) return "no-char";
      gatt.setCharacteristicNotification(ch, true);
      BluetoothGattDescriptor cccd = ch.getDescriptor(java.util.UUID.fromString("00002902-0000-1000-8000-00805f9b34fb"));
      if (cccd != null) {
        if (Build.VERSION.SDK_INT >= 33) gatt.writeDescriptor(cccd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
        else { cccd.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE); gatt.writeDescriptor(cccd); }
      }
      return "ok";
    } catch (Exception e) { return "err:" + e.getMessage(); }
  }

  // Subscribe to a NOTIFY characteristic (status); lines arrive via bleNotifications().
  @JavascriptInterface
  public String bleSubscribe(String serviceUuid, String charUuid) { return enableNotify(serviceUuid, charUuid); }

  // Subscribe to the Portal `ioback` NOTIFY char (the CDC return stream). Marks it as the ioback source
  // so its (possibly binary) data routes to the separate bleIoNotif queue, drained via bleNotificationsIo().
  @JavascriptInterface
  public String bleSubscribeIo(String serviceUuid, String charUuid) {
    try { ioChar = java.util.UUID.fromString(charUuid); } catch (Exception e) { return "err:" + e.getMessage(); }
    return enableNotify(serviceUuid, charUuid);
  }

  // Drain accumulated status notifications as a JSON array of strings (clears the buffer).
  @JavascriptInterface
  public String bleNotifications() {
    StringBuilder sb = new StringBuilder("["); boolean first = true; String s;
    while ((s = bleNotif.poll()) != null) { if (!first) sb.append(","); sb.append(JSONObject.quote(s)); first = false; }
    return sb.append("]").toString();
  }

  // Drain accumulated ioback notifications as a JSON array of base64 strings (binary-safe; JS decodes).
  @JavascriptInterface
  public String bleNotificationsIo() {
    StringBuilder sb = new StringBuilder("["); boolean first = true; String s;
    while ((s = bleIoNotif.poll()) != null) { if (!first) sb.append(","); sb.append(JSONObject.quote(s)); first = false; }
    return sb.append("]").toString();
  }

  @JavascriptInterface
  public int bleMtuSize() { return bleMtu; }

  // --- Wi-Fi Direct (Wi-Fi P2P) fast path -------------------------------------------------------
  // BLE bootstraps + hands the dongle the group creds; this is the ordered/reliable TCP channel for
  // bulk data (screenshots, file contents). Phone = Group Owner, dongle = legacy STA. All the real
  // work lives in WifiP2pLink; these are the frozen @JavascriptInterface wrappers JS drives.
  private WifiP2pLink wifiLink;
  private synchronized WifiP2pLink wifi() { if (wifiLink == null) wifiLink = new WifiP2pLink(ctx); return wifiLink; }

  @JavascriptInterface public String  wifiP2pStart()                    { return wifi().start(); }
  @JavascriptInterface public String  wifiP2pInfo()                     { return wifi().info(); }
  @JavascriptInterface public boolean wifiP2pSockConnected()            { return wifi().sockConnected(); }
  @JavascriptInterface public String  wifiP2pWrite(String base64Payload){ return wifi().write(base64Payload); }
  @JavascriptInterface public String  wifiP2pReadIo()                   { return wifi().readIo(); }
  @JavascriptInterface public void    wifiP2pStop()                     { wifi().stop(); }

  @JavascriptInterface
  public void bleDisconnect() {
    try { if (gatt != null) { gatt.disconnect(); gatt.close(); gatt = null; } } catch (Exception e) {}
    gattState = "idle"; writeState = "idle"; bleNotif.clear(); bleIoNotif.clear(); ioChar = null;
  }

  /** Start the always-on device link (idempotent). */
  @JavascriptInterface
  public void startControlLink() {
    try {
      Intent svc = new Intent(ctx, DeviceControlService.class).setAction(DeviceControlService.ACTION_START);
      if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(svc); else ctx.startService(svc);
    } catch (Exception e) {}
  }

  /** Yield (or reclaim) the single Portal dongle. The DeviceControlService relay owns the dongle at all
   *  times EXCEPT while the in-app Portal/Adopt screen is open driving BLE directly: that screen calls
   *  yield(true) on mount so the service drops its link + idles, and yield(false) on unmount so the
   *  service resumes driving. Tied to the screen, NOT to app foreground/background or lock. */
  @JavascriptInterface
  public void portalServiceYield(boolean yield) { DeviceControlService.portalYielded = yield; }

  /** Queue a one-shot mesh-provisioning write for the connected Portal. `json` is the config bundle
   *  { olm_server, olm_id, olm_secret, olm_org, wifi_ssid, wifi_pass } — olm_* from the core's
   *  provision-mesh endpoint, wifi_* entered by the user. The relay worker writes it over BLE and the
   *  dongle saves it to NVS + joins the mesh. Returns "queued". */
  @JavascriptInterface
  public String portalProvision(String json) { DeviceControlService.portalPendingCfg = json; return "queued"; }

  /** Re-apply wake-word config immediately (after changing it in-app). Pokes the control service, whose
   *  onStartCommand re-runs WakeWord.refresh with the new phrase/enabled state. */
  @JavascriptInterface
  public void refreshWake() { startControlLink(); }

  /** True when the user has turned on the asmltr accessibility service (screen control). */
  @JavascriptInterface
  public boolean isScreenControlEnabled() {
    try {
      String flat = Settings.Secure.getString(ctx.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
      return flat != null && flat.contains(ctx.getPackageName() + "/") && flat.contains("AsmltrAccessibilityService");
    } catch (Exception e) { return false; }
  }

  /** Open Settings → Accessibility so the user can enable screen control. */
  @JavascriptInterface
  public void openAccessibilitySettings() {
    try {
      Intent i = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
      i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); ctx.startActivity(i);
    } catch (Exception e) {}
  }

  /** Ask the OS to exempt us from battery optimization so the link isn't suspended in Doze. */
  @JavascriptInterface
  public void requestBatteryExemption() {
    try {
      if (Build.VERSION.SDK_INT >= 23) {
        android.os.PowerManager pm = (android.os.PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        if (pm != null && !pm.isIgnoringBatteryOptimizations(ctx.getPackageName())) {
          Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + ctx.getPackageName()));
          i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); ctx.startActivity(i);
        }
      }
    } catch (Exception e) {}
  }

  @JavascriptInterface
  public int getAppVersion() {
    try { return ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0).versionCode; }
    catch (Exception e) { return 0; }
  }

  /** True once the user has granted "draw over other apps" — required for the persistent overlay. */
  @JavascriptInterface
  public boolean canDrawOverlay() {
    return Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(ctx);
  }

  /** Route the user to grant the overlay permission (so the assistant can float over other apps). */
  @JavascriptInterface
  public void requestOverlayPermission() {
    if (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(ctx)) {
      Intent i = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + ctx.getPackageName()));
      i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      ctx.startActivity(i);
    }
  }

  /** Manually surface the floating overlay (e.g. a "test overlay" button in the app). */
  @JavascriptInterface
  public void openOverlay() {
    if (!canDrawOverlay()) { requestOverlayPermission(); return; }
    Intent i = new Intent(ctx, OverlayService.class).setAction("com.asmltr.assistant.SHOW");
    if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i); else ctx.startService(i);
  }

  /** Download `url` and install it via a PackageInstaller session. If the app can't yet install
   *  unknown apps, route the user to grant that first (they re-tap Update after). */
  @JavascriptInterface
  public void installUpdate(final String url) {
    if (Build.VERSION.SDK_INT >= 26 && !ctx.getPackageManager().canRequestPackageInstalls()) {
      Intent s = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + ctx.getPackageName()));
      s.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      ctx.startActivity(s);
      return;
    }
    new Thread(new Runnable() { public void run() {
      try {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setInstanceFollowRedirects(true); c.connect();
        InputStream in = c.getInputStream();
        PackageInstaller pi = ctx.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        int sid = pi.createSession(params);
        PackageInstaller.Session session = pi.openSession(sid);
        OutputStream out = session.openWrite("asmltr", 0, -1);
        byte[] b = new byte[65536]; int n; while ((n = in.read(b)) > 0) out.write(b, 0, n);
        session.fsync(out); out.close(); in.close(); c.disconnect();
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 31) flags |= PendingIntent.FLAG_MUTABLE;
        Intent cb = new Intent(ctx, InstallReceiver.class);
        PendingIntent pending = PendingIntent.getBroadcast(ctx, sid, cb, flags);
        session.commit(pending.getIntentSender());
      } catch (Exception e) { /* toast handled by the receiver on failure paths */ }
    } }).start();
  }

  // ── Notification reader (Part B) config bridge ───────────────────────────────
  /** Persist the notification-reader settings (written from the app's Notifications settings UI). */
  @JavascriptInterface
  public void saveNotifyConfig(boolean enabled, boolean headphonesOnly, int threshold, String deniedCsv, String btCsv,
                               boolean holdWhenBusy, boolean respectDnd, boolean holdForNav) {
    SharedPreferences.Editor e = ctx.getSharedPreferences("asmltr", Context.MODE_PRIVATE).edit();
    e.putBoolean("notif_enabled", enabled);
    e.putBoolean("notif_headphones_only", headphonesOnly);
    e.putInt("notif_threshold", threshold);
    e.putString("notif_apps_denied", deniedCsv == null ? "" : deniedCsv);
    e.putString("notif_bt_devices", btCsv == null ? "" : btCsv);
    // Interruption policy: hold rather than barge in, and what counts as "busy".
    e.putBoolean("notif_hold_busy", holdWhenBusy);
    e.putBoolean("notif_respect_dnd", respectDnd);
    e.putBoolean("notif_hold_nav", holdForNav);
    e.apply();
  }

  /** Drop a sample line into the held queue and raise the badge — so the corner UI (tap to read, drag
   *  to the ✕ to discard) can be exercised without staging a real phone call. */
  @JavascriptInterface
  public void testHeldBadge() {
    try { ReadAloud.hold(ctx, "This is a held notification. Tap the eyes to hear what came in, or drag them to the X to dismiss.", "asmltr"); }
    catch (Throwable t) {}
  }

  /** Why the reader would hold right now ("clear", "a call is in progress", "Do Not Disturb is on", …).
   *  Shown in Settings so the gate is legible instead of mysterious. */
  @JavascriptInterface
  public String speakGateStatus() {
    try {
      SharedPreferences p = ctx.getSharedPreferences("asmltr", Context.MODE_PRIVATE);
      int g = SpeakGate.check(ctx, p.getBoolean("notif_respect_dnd", true), p.getBoolean("notif_hold_nav", true));
      JSONObject o = new JSONObject();
      o.put("state", g == SpeakGate.OK ? "ok" : g == SpeakGate.WAIT ? "wait" : "hold");
      o.put("reason", SpeakGate.reason());
      o.put("held", NotifQueue.size(ctx));
      return o.toString();
    } catch (Throwable t) { return "{}"; }
  }

  @JavascriptInterface
  public String getNotifyConfig() {
    SharedPreferences p = ctx.getSharedPreferences("asmltr", Context.MODE_PRIVATE);
    try {
      JSONObject o = new JSONObject();
      o.put("enabled", p.getBoolean("notif_enabled", false));
      o.put("headphones_only", p.getBoolean("notif_headphones_only", true));
      o.put("threshold", p.getInt("notif_threshold", 40));
      o.put("apps_denied", p.getString("notif_apps_denied", ""));
      o.put("bt_devices", p.getString("notif_bt_devices", ""));
      o.put("hold_when_busy", p.getBoolean("notif_hold_busy", true));
      o.put("respect_dnd", p.getBoolean("notif_respect_dnd", true));
      o.put("hold_for_nav", p.getBoolean("notif_hold_nav", true));
      o.put("held", NotifQueue.size(ctx));
      o.put("access_granted", isNotificationAccessGranted());
      return o.toString();
    } catch (Exception ex) { return "{}"; }
  }

  /** Has the user granted Notification access (the once-off system consent the listener needs)? */
  @JavascriptInterface
  public boolean isNotificationAccessGranted() {
    try {
      String flat = Settings.Secure.getString(ctx.getContentResolver(), "enabled_notification_listeners");
      return flat != null && flat.contains(ctx.getPackageName());
    } catch (Throwable t) { return false; }
  }

  /** Route the user to the system Notification-access screen to grant/revoke the listener. */
  @JavascriptInterface
  public void openNotificationAccessSettings() {
    try {
      Intent i = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
      i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      ctx.startActivity(i);
    } catch (Throwable t) {}
  }

  /**
   * Play a mic cue natively. The WebView's WebAudio beep plays as MEDIA, which is inaudible while the
   * SCO/call route is up for headset capture — so the "listening"/"stopped" tones vanished exactly
   * when we started using the earbud mic. Chime follows the active route instead.
   * kind: "listen" | "stop" | "kill".
   */
  @JavascriptInterface
  public void cue(String kind) {
    try {
      if ("stop".equals(kind)) Chime.stop(ctx);
      else if ("kill".equals(kind)) Chime.kill(ctx);
      else Chime.listen(ctx);
    } catch (Throwable t) {}
  }

  /**
   * Force capture onto the Bluetooth headset mic, and report whether it took.
   *
   * Chromium on Android does not enumerate per-device microphones — getUserMedia sees essentially
   * one "default" input — so a deviceId picked in JS cannot select the earbud mic. The route has to
   * be set at the AudioManager level instead: nominate the SCO device as the communication device and
   * the capture that follows comes from the headset.
   *
   * Returns false when no Bluetooth headset is available, so the caller can carry on with the phone
   * mic rather than failing the turn.
   */
  @JavascriptInterface
  public boolean useHeadsetMic() {
    try {
      AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
      if (am == null) return false;
      if (android.os.Build.VERSION.SDK_INT >= 31) {
        for (android.media.AudioDeviceInfo d : am.getAvailableCommunicationDevices()) {
          if (d.getType() == android.media.AudioDeviceInfo.TYPE_BLUETOOTH_SCO) {
            return am.setCommunicationDevice(d);
          }
        }
        return false;
      }
      if (!am.isBluetoothScoAvailableOffCall()) return false;
      am.setMode(AudioManager.MODE_IN_COMMUNICATION);
      am.startBluetoothSco();
      am.setBluetoothScoOn(true);
      return true;
    } catch (Throwable t) { return false; }
  }

  /** True once the Bluetooth SCO route is actually live — setCommunicationDevice() returns before the
   *  link is up, and capture opened too early lands on the phone mic instead. */
  @JavascriptInterface
  public boolean headsetMicActive() {
    try {
      AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
      if (am == null) return false;
      if (android.os.Build.VERSION.SDK_INT >= 31) {
        android.media.AudioDeviceInfo d = am.getCommunicationDevice();
        return d != null && d.getType() == android.media.AudioDeviceInfo.TYPE_BLUETOOTH_SCO;
      }
      return am.isBluetoothScoOn();
    } catch (Throwable t) { return false; }
  }

  /**
   * Drop the SCO/communication route the moment we stop capturing.
   *
   * Recording from the earbud mic brings the SCO (call) link up, and Android leaves it up for ~20s
   * after the mic closes. The spoken reply would play into that dead narrowband channel and be
   * inaudible until it expires. Clearing the communication device hands the route straight back to
   * A2DP so the reply lands on media audio.
   */
  @JavascriptInterface
  public void releaseCommunicationRoute() {
    try {
      AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
      if (am == null) return;
      if (android.os.Build.VERSION.SDK_INT >= 31) {
        am.clearCommunicationDevice();
      } else {
        am.stopBluetoothSco();
        am.setBluetoothScoOn(false);
        am.setMode(AudioManager.MODE_NORMAL);
      }
    } catch (Throwable t) {}
  }

  /** Connected audio output routes (for the BT-device picker). JSON array of { name, address, type }. */
  @JavascriptInterface
  public String listAudioDevices() {
    JSONArray arr = new JSONArray();
    try {
      AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
      if (am != null) for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
        int t = d.getType();
        String type = t == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP ? "bluetooth"
            : t == AudioDeviceInfo.TYPE_BLUETOOTH_SCO ? "bluetooth"
            : (t == AudioDeviceInfo.TYPE_WIRED_HEADPHONES || t == AudioDeviceInfo.TYPE_WIRED_HEADSET || t == AudioDeviceInfo.TYPE_USB_HEADSET) ? "wired" : null;
        if (type == null) continue;
        JSONObject o = new JSONObject();
        o.put("name", d.getProductName() == null ? "audio device" : d.getProductName().toString());
        o.put("address", d.getAddress() == null ? "" : d.getAddress());
        o.put("type", type);
        arr.put(o);
      }
    } catch (Throwable t) {}
    return arr.toString();
  }
}
