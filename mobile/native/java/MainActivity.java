package com.asmltr.assistant;
import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.webkit.WebView;
import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.BridgeActivity;
/** The app shell — loads the embedded dashboard. Enables WebView WebAuthn so passkeys work in-app
 *  (paired with the /.well-known/assetlinks.json Digital Asset Links on the host), and exposes
 *  AsmltrNative so config persists to SharedPreferences for the system overlay session. */
public class MainActivity extends BridgeActivity {
  @Override public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(new String[]{ Manifest.permission.RECORD_AUDIO }, 7);
    }
    WebView wv = getBridge().getWebView();
    wv.addJavascriptInterface(new NativeConfig(this), "AsmltrNative");
    // Passkeys inside the WebView (Android 15+ System WebView). Requires the app to be associated with
    // the RP domain via Digital Asset Links (assetlinks.json).
    if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_AUTHENTICATION)) {
      WebSettingsCompat.setWebAuthenticationSupport(wv.getSettings(), WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_APP);
    }
  }
}
