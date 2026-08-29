package com.asmltr.assistant;
import android.annotation.SuppressLint;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.service.voice.VoiceInteractionSession;
import android.view.View;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import org.json.JSONObject;

/** The assist gesture entrypoint. Preferred path: hand off to {@link OverlayService} — a persistent
 *  foreground overlay that survives swipe-home and keeps reading replies while minimized — then close
 *  this session window. Fallback (overlay permission not yet granted): host the WebView in the session's
 *  own window, as before, so behaviour is never worse than a plain assist popup. */
public class AsmltrSession extends VoiceInteractionSession {
  private WebView web;
  public AsmltrSession(Context context) { super(context); }

  private boolean canOverlay() {
    return Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(getContext());
  }

  @Override public void onShow(Bundle args, int showFlags) {
    super.onShow(args, showFlags);
    if (canOverlay()) {
      Intent i = new Intent(getContext(), OverlayService.class).setAction(OverlayService.ACTION_LISTEN);
      try {
        if (Build.VERSION.SDK_INT >= 26) getContext().startForegroundService(i); else getContext().startService(i);
        hide(); // the overlay lives in the service now; don't show a session window
        return;
      } catch (Exception e) { /* rare FGS-from-background block → fall through to the in-session overlay */ }
    }
    // fallback: run the overlay in this session window
    // Same toggle semantics as the overlay path: press again to stop listening / interrupt TTS.
    if (web != null) web.evaluateJavascript(
      "window.__ASMLTR_ASSIST=true;"
      + " if(window.asmltrAssist){window.asmltrAssist();}"
      + " else if(window.asmltrStartListening){window.asmltrStartListening();}", null);
  }

  private String configJs() {
    SharedPreferences p = getContext().getSharedPreferences("asmltr", Context.MODE_PRIVATE);
    JSONObject o = new JSONObject();
    try {
      o.put("baseUrl", p.getString("baseUrl", ""));
      o.put("token", p.getString("token", ""));
      o.put("name", p.getString("name", "assistant"));
      o.put("deviceId", NativeConfig.deviceId(getContext()));
    } catch (Exception e) {}
    return "window.__ASMLTR_NATIVE_CFG=" + o.toString() + ";";
  }

  @SuppressLint("SetJavaScriptEnabled")
  @Override public View onCreateContentView() {
    if (canOverlay()) return new View(getContext()); // won't be shown; overlay service owns the UI
    web = new WebView(getContext());
    web.setBackgroundColor(android.graphics.Color.TRANSPARENT);
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setMediaPlaybackRequiresUserGesture(false);
    web.addJavascriptInterface(new NativeConfig(getContext()), "AsmltrNative");
    web.addJavascriptInterface(new DeviceTools(getContext()), "AsmltrDevice");
    web.addJavascriptInterface(new Object() {
      @android.webkit.JavascriptInterface public void setMinimized(boolean m) {}
      @android.webkit.JavascriptInterface public void close() { web.post(new Runnable() { public void run() { hide(); } }); }
    }, "AsmltrOverlay");
    web.setWebChromeClient(new WebChromeClient() {
      @Override public void onPermissionRequest(PermissionRequest request) { request.grant(request.getResources()); }
    });
    final String cfg = configJs();
    web.setWebViewClient(new WebViewClient() {
      @Override public void onPageStarted(WebView v, String url, Bitmap fav) { v.evaluateJavascript(cfg, null); }
    });
    web.loadUrl("file:///android_asset/public/assistant.html?overlay=1");
    return web;
  }
}
