package com.asmltr.assistant;
import android.Manifest;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.webkit.WebView;
import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.BridgeActivity;
import com.capacitorjs.community.plugins.bluetoothle.BluetoothLe;
/** The app shell — loads the embedded dashboard. Enables WebView WebAuthn so passkeys work in-app
 *  (paired with the /.well-known/assetlinks.json Digital Asset Links on the host), and exposes
 *  AsmltrNative so config persists to SharedPreferences for the system overlay session. */
public class MainActivity extends BridgeActivity {
  // True while the app UI is in the foreground. The native Portal relay (DeviceControlService) reads
  // this to decide ownership of the single dongle GATT: the WebView relay drives in the foreground,
  // the native service drives while backgrounded/locked. Volatile — written on the UI thread, read on
  // the service's relay worker thread.
  public static volatile boolean appForeground = false;

  @Override public void onCreate(Bundle savedInstanceState) {
    // Register the BLE plugin EXPLICITLY (before super builds the bridge). Auto-registration via
    // capacitor.plugins.json wasn't taking in this custom shell, so the native plugin never landed in
    // PluginHeaders and JS calls failed with "not implemented on android". Explicit = bulletproof.
    registerPlugin(BluetoothLe.class);
    super.onCreate(savedInstanceState);
    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(new String[]{ Manifest.permission.RECORD_AUDIO }, 7);
    }
    // Android 12+ gates Bluetooth behind a runtime grant. Without it Chromium's media stack won't touch
    // the BT adapter ("cr_media: BLUETOOTH_CONNECT permission is missing") and every capture lands on
    // the phone's built-in mic — so talking through the earbuds silently doesn't work.
    if (Build.VERSION.SDK_INT >= 31) {
      java.util.ArrayList<String> bt = new java.util.ArrayList<>();
      if (checkSelfPermission("android.permission.BLUETOOTH_CONNECT") != PackageManager.PERMISSION_GRANTED) bt.add("android.permission.BLUETOOTH_CONNECT");
      // BLUETOOTH_SCAN ("Nearby devices") is needed for the Portal BLE scan.
      if (checkSelfPermission("android.permission.BLUETOOTH_SCAN") != PackageManager.PERMISSION_GRANTED) bt.add("android.permission.BLUETOOTH_SCAN");
      if (!bt.isEmpty()) requestPermissions(bt.toArray(new String[0]), 9);
    }
    // One-time nudge for the "draw over other apps" grant so the persistent floating overlay can appear.
    SharedPreferences p = getSharedPreferences("asmltr", MODE_PRIVATE);
    if (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(this) && !p.getBoolean("overlayAsked", false)) {
      p.edit().putBoolean("overlayAsked", true).apply();
      try { startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getPackageName()))); } catch (Exception e) {}
    }
    // Android 13+ needs runtime notification permission for the ongoing foreground-service notifications.
    if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(new String[]{ "android.permission.POST_NOTIFICATIONS" }, 8);
    }
    NativeConfig nc = new NativeConfig(this);
    // Bring up the persistent control link (if configured) + one-time battery-exemption nudge so it
    // stays connected in the background / Doze.
    if (!p.getString("baseUrl", "").isEmpty() && !p.getString("token", "").isEmpty()) {
      nc.startControlLink();
      if (!p.getBoolean("batteryAsked", false)) { p.edit().putBoolean("batteryAsked", true).apply(); nc.requestBatteryExemption(); }
      // One-time offer to enable screen control (accessibility) — only if it's off and the user hasn't
      // already been asked (so a decline isn't nagged). They can still enable it later from settings.
      if (!nc.isScreenControlEnabled() && !p.getBoolean("a11yAsked", false)) {
        p.edit().putBoolean("a11yAsked", true).apply();
        nc.openAccessibilitySettings();
      }
    }
    WebView wv = getBridge().getWebView();
    wv.addJavascriptInterface(nc, "AsmltrNative");
    // Passkeys inside the WebView (Android 15+ System WebView). Requires the app to be associated with
    // the RP domain via Digital Asset Links (assetlinks.json).
    if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_AUTHENTICATION)) {
      WebSettingsCompat.setWebAuthenticationSupport(wv.getSettings(), WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_APP);
    }
  }

  // --- Portal relay foreground/background handoff (single dongle GATT, one owner at a time) ---------
  // Foreground: the WebView relay (portalRelay.js) owns the dongle; the native service idles + drops
  // its link. Background/locked: the native DeviceControlService relay takes over (the WebView's JS
  // timers are suspended then). The handoff is the fiddly part — a held GATT stops the dongle
  // advertising, so the outgoing owner MUST drop its connection before the incoming one can scan it.

  @Override public void onResume() {
    super.onResume();
    appForeground = true;   // the service's relay worker sees this and drops its own GATT, freeing the dongle
    portalRelayJs("window.__portalRelayResume&&window.__portalRelayResume()");  // WebView reclaims the GATT
  }

  @Override public void onPause() {
    appForeground = false;  // the native relay may now take the dongle
    // Drop the WebView relay's BLE link so the dongle re-advertises and the native service can grab it.
    portalRelayJs("window.__portalRelayPause&&window.__portalRelayPause()");
    super.onPause();
  }

  /** Run a one-liner against the dashboard WebView, tolerating an un-ready bridge (early lifecycle) and
   *  an older dashboard build that doesn't expose the hooks yet (the && guard makes the call a no-op). */
  private void portalRelayJs(String js) {
    try {
      if (getBridge() == null) return;
      final WebView wv = getBridge().getWebView();
      if (wv != null) wv.post(() -> { try { wv.evaluateJavascript(js, null); } catch (Exception e) {} });
    } catch (Exception e) {}
  }
}
