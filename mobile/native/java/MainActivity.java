package com.asmltr.assistant;
import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import com.getcapacitor.BridgeActivity;

/** The app shell — loads the dashboard (web brain launcher). Exposes AsmltrNative so the in-app
 *  assistant Settings can persist connector config to SharedPreferences, which the system overlay
 *  session (a different WebView origin) reads. */
public class MainActivity extends BridgeActivity {
  @Override public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(new String[]{ Manifest.permission.RECORD_AUDIO }, 7);
    }
    getBridge().getWebView().addJavascriptInterface(new NativeBridge(), "AsmltrNative");
  }
  class NativeBridge {
    @JavascriptInterface
    public void saveConfig(String baseUrl, String token, String name) {
      getSharedPreferences("asmltr", Context.MODE_PRIVATE).edit()
        .putString("baseUrl", baseUrl).putString("token", token).putString("name", name).apply();
    }
  }
}
