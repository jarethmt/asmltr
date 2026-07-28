package com.asmltr.assistant;
import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
/** The app shell — loads the embedded dashboard. Exposes AsmltrNative so config persists to
 *  SharedPreferences, which the system overlay session (a different WebView origin) reads. */
public class MainActivity extends BridgeActivity {
  @Override public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(new String[]{ Manifest.permission.RECORD_AUDIO }, 7);
    }
    getBridge().getWebView().addJavascriptInterface(new NativeConfig(this), "AsmltrNative");
  }
}
