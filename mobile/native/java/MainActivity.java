package com.asmltr.assistant;
import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
public class MainActivity extends BridgeActivity {
  @Override public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(new String[]{ Manifest.permission.RECORD_AUDIO }, 7);
    }
    handleAssist(getIntent());
  }
  @Override public void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); handleAssist(intent); }
  private void handleAssist(Intent intent) {
    if (intent == null || !intent.getBooleanExtra("asmltr_assist", false)) return;
    // Set a flag AND call directly — covers both orderings (page loaded before/after this runs).
    final String js = "window.__ASMLTR_ASSIST=true; if(window.asmltrStartListening){window.asmltrStartListening();}";
    getBridge().getWebView().postDelayed(() -> getBridge().getWebView().evaluateJavascript(js, null), 700);
  }
}
