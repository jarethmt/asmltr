package com.asmltr.assistant;
import android.annotation.SuppressLint;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.os.Bundle;
import android.service.voice.VoiceInteractionSession;
import android.view.View;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import org.json.JSONObject;

/** The floating overlay assistant (Google-Assistant-style). Drawn as the session's OWN window, so it
 *  appears over whatever app is in front. Loads the voice web brain in overlay mode; connector config
 *  is injected from SharedPreferences (written by the app's Settings via the AsmltrNative bridge). */
public class AsmltrSession extends VoiceInteractionSession {
  private WebView web;
  public AsmltrSession(Context context) { super(context); }

  private String configJs() {
    SharedPreferences p = getContext().getSharedPreferences("asmltr", Context.MODE_PRIVATE);
    JSONObject o = new JSONObject();
    try {
      o.put("baseUrl", p.getString("baseUrl", ""));
      o.put("token", p.getString("token", ""));
      o.put("name", p.getString("name", "assistant"));
    } catch (Exception e) {}
    // A distinct global (not clobbered by config.js) that app.js prefers.
    return "window.__ASMLTR_NATIVE_CFG=" + o.toString() + ";";
  }

  @SuppressLint("SetJavaScriptEnabled")
  @Override public View onCreateContentView() {
    web = new WebView(getContext());
    web.setBackgroundColor(android.graphics.Color.TRANSPARENT); // show the app behind the glass card
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setMediaPlaybackRequiresUserGesture(false); // let TTS/cues autoplay
    web.addJavascriptInterface(new NativeConfig(getContext()), "AsmltrNative"); // overlay ⚙ can persist config
    web.setWebChromeClient(new WebChromeClient() {
      @Override public void onPermissionRequest(PermissionRequest request) { request.grant(request.getResources()); } // mic in the overlay WebView
    });
    final String cfg = configJs();
    web.setWebViewClient(new WebViewClient() {
      @Override public void onPageStarted(WebView v, String url, Bitmap fav) { v.evaluateJavascript(cfg, null); }
    });
    web.loadUrl("file:///android_asset/public/assistant.html?overlay=1");
    return web;
  }

  @Override public void onShow(Bundle args, int showFlags) {
    super.onShow(args, showFlags);
    if (web != null) web.evaluateJavascript(
      "window.__ASMLTR_ASSIST=true; if(window.asmltrStartListening){window.asmltrStartListening();}", null);
  }
}
