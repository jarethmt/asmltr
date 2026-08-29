package com.asmltr.assistant;
import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.os.Build;
import android.os.IBinder;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import org.json.JSONObject;

/**
 * The TRUE persistent overlay: a foreground service that draws the assistant WebView in a
 * TYPE_APPLICATION_OVERLAY window. Unlike a VoiceInteractionSession (whose window dies on
 * swipe-home), this survives leaving the app — so a minimized bubble stays put and a reply keeps
 * being read aloud even when collapsed. Expanded → a full-screen focusable window (keyboard works,
 * hardware-back minimizes). Minimized → a tiny bottom-right window so the app behind stays usable.
 */
public class OverlayService extends Service {
  static final String ACTION_SHOW = "com.asmltr.assistant.SHOW";
  static final String ACTION_LISTEN = "com.asmltr.assistant.LISTEN";
  static final String ACTION_CLOSE = "com.asmltr.assistant.CLOSE";
  private static final String CH = "asmltr_overlay";
  private WindowManager wm;
  private FrameLayout root;
  private WebView web;
  private boolean added = false, minimized = false;
  // Expanded floating-panel geometry: bottom-centered, offset by drag, height reported by the web (so the
  // panel hugs the card content instead of being a fixed slab). dragY/panelH = -1 → uninitialized.
  private int dragX = 0, dragY = -1, panelH = -1;
  private android.os.PowerManager.WakeLock wakeLock; // held while listening/working → runs screen-off
  private android.media.AudioManager audioManager;   // audio focus: pause other players while open
  private android.media.AudioFocusRequest focusRequest;

  private int dp(int v) { return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()); }

  @Override public IBinder onBind(Intent i) { return null; }

  @Override public void onCreate() {
    super.onCreate();
    startForeground(42, buildNotification());
    wm = (WindowManager) getSystemService(WINDOW_SERVICE);
    takeAudioFocus();
    createWeb();
  }

  /**
   * Hold transient audio focus for as long as the assistant is open, so whatever is playing pauses
   * on open and resumes on close. This matters more than it looks on Bluetooth: capturing a turn
   * from the earbud mic brings up the SCO (call) link, and music left running gets dragged onto the
   * narrowband call channel — it keeps playing but sounds like a phone call. Pausing it sidesteps
   * that entirely, and the player restores itself when we abandon focus.
   *
   * GAIN_TRANSIENT (not TRANSIENT_EXCLUSIVE) is deliberate: it is the contract media players most
   * reliably auto-resume from.
   */
  private void takeAudioFocus() {
    try {
      audioManager = (android.media.AudioManager) getSystemService(Context.AUDIO_SERVICE);
      if (audioManager == null) return;
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        focusRequest = new android.media.AudioFocusRequest.Builder(android.media.AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
            .setAudioAttributes(new android.media.AudioAttributes.Builder()
                .setUsage(android.media.AudioAttributes.USAGE_ASSISTANT)
                .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SPEECH)
                .build())
            .setWillPauseWhenDucked(true)       // we want them paused, not ducked under us
            .setOnAudioFocusChangeListener(f -> {})
            .build();
        audioManager.requestAudioFocus(focusRequest);
      } else {
        audioManager.requestAudioFocus(null, android.media.AudioManager.STREAM_MUSIC,
            android.media.AudioManager.AUDIOFOCUS_GAIN_TRANSIENT);
      }
    } catch (Throwable t) {}
  }

  private void releaseAudioFocus() {
    try {
      if (audioManager == null) return;
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        if (focusRequest != null) audioManager.abandonAudioFocusRequest(focusRequest);
      } else {
        audioManager.abandonAudioFocus(null);
      }
    } catch (Throwable t) {}
    focusRequest = null;
  }

  @Override public int onStartCommand(Intent intent, int flags, int startId) {
    final String action = intent != null ? intent.getAction() : ACTION_SHOW;
    if (ACTION_CLOSE.equals(action)) { stopSelf(); return START_NOT_STICKY; }
    // Was the card already on screen? That distinguishes "waking from closed" from "pressed again
    // while the assistant is up", and the two need opposite cue handling.
    final boolean coldStart = !added;
    ensureAdded();
    setMinimizedInternal(false);
    // Native listen cue ONLY on a cold start: waking from closed, the WebView isn't alive and the BT
    // route isn't warm, so the page's own beep is inaudible. When the overlay is already up, the page
    // decides — a second press is a STOP, and firing the "listening" tone for it would be a lie.
    if (ACTION_LISTEN.equals(action) && coldStart) { try { Chime.listen(this); } catch (Throwable t) {} }
    if (web != null) web.post(new Runnable() { public void run() {
      // Assist gesture → asmltrAssist(), which TOGGLES: start when idle, abandon the turn while
      // listening, interrupt TTS while speaking. asmltrStartListening is the pre-toggle fallback.
      String js = ACTION_LISTEN.equals(action)
        ? "window.__ASMLTR_ASSIST=true; window.__ASMLTR_SKIP_CUE=" + coldStart + ";"
          + " if(window.asmltrExpand)window.asmltrExpand();"
          + " if(window.asmltrAssist)window.asmltrAssist(" + coldStart + ");"
          + " else if(window.asmltrStartListening)window.asmltrStartListening(" + coldStart + ");"
        : "if(window.asmltrExpand)window.asmltrExpand();";
      web.evaluateJavascript(js, null);
    } });
    return START_STICKY;
  }

  @SuppressLint("SetJavaScriptEnabled")
  private void createWeb() {
    root = new FrameLayout(this) {
      @Override public boolean dispatchKeyEvent(KeyEvent e) {
        // hardware back collapses the card instead of killing the overlay
        if (e.getKeyCode() == KeyEvent.KEYCODE_BACK && e.getAction() == KeyEvent.ACTION_UP && !minimized) {
          if (web != null) web.evaluateJavascript("if(window.asmltrMinimize)window.asmltrMinimize();", null);
          return true;
        }
        return super.dispatchKeyEvent(e);
      }
    };
    root.setBackgroundColor(Color.TRANSPARENT);
    web = new WebView(this);
    web.setBackgroundColor(Color.TRANSPARENT);
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setMediaPlaybackRequiresUserGesture(false); // TTS/cues autoplay
    web.addJavascriptInterface(new NativeConfig(this), "AsmltrNative");
    web.addJavascriptInterface(new DeviceTools(this), "AsmltrDevice"); // #77 phone control
    web.addJavascriptInterface(new OverlayBridge(), "AsmltrOverlay");
    web.setWebChromeClient(new WebChromeClient() {
      @Override public void onPermissionRequest(PermissionRequest r) { r.grant(r.getResources()); }
    });
    final String cfg = configJs();
    web.setWebViewClient(new WebViewClient() {
      @Override public void onPageStarted(WebView v, String url, Bitmap fav) { v.evaluateJavascript(cfg, null); }
    });
    web.loadUrl("file:///android_asset/public/assistant.html?overlay=1&native=1");
    root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
  }

  private WindowManager.LayoutParams params(boolean min) {
    int type = Build.VERSION.SDK_INT >= 26 ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY : WindowManager.LayoutParams.TYPE_PHONE;
    WindowManager.LayoutParams lp = new WindowManager.LayoutParams();
    lp.type = type; lp.format = PixelFormat.TRANSLUCENT;
    if (min) {
      // tiny corner window → the rest of the screen passes through to the app behind
      lp.width = dp(120); lp.height = dp(120);
      lp.gravity = Gravity.BOTTOM | Gravity.END;
      lp.flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN;
    } else {
      // Expanded = a floating PANEL sized to the card (NOT full-screen). FLAG_NOT_TOUCH_MODAL means
      // everything outside the panel passes through to the app behind. Bottom-centered so it grows upward
      // as content/keyboard change; drag nudges it via dragX/dragY offsets. Focusable → keyboard works.
      android.util.DisplayMetrics m = getResources().getDisplayMetrics();
      int panelW = Math.min(Math.round(m.widthPixels * 0.94f), dp(460));
      int maxH = Math.round(m.heightPixels * 0.85f);
      int h = panelH > 0 ? Math.min(panelH, maxH) : Math.round(m.heightPixels * 0.5f); // default until web reports
      if (dragY < 0) dragY = dp(12);
      int maxOffX = Math.max(0, (m.widthPixels - panelW) / 2);
      dragX = Math.max(-maxOffX, Math.min(dragX, maxOffX));
      dragY = Math.max(0, Math.min(dragY, Math.max(0, m.heightPixels - h)));
      lp.width = panelW; lp.height = h;
      lp.gravity = Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL; lp.x = dragX; lp.y = dragY;
      lp.flags = WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN;
      lp.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE;
    }
    return lp;
  }

  private void ensureAdded() {
    if (added) return;
    try { wm.addView(root, params(minimized)); added = true; }
    catch (Exception e) { /* SYSTEM_ALERT_WINDOW not granted → nothing to draw */ stopSelf(); }
  }

  private void setMinimizedInternal(boolean min) {
    minimized = min;
    if (added) try { wm.updateViewLayout(root, params(min)); } catch (Exception e) {}
  }

  /** JS → native overlay controls (called by the web brain in native mode). */
  private class OverlayBridge {
    @android.webkit.JavascriptInterface public void setMinimized(final boolean min) {
      if (root != null) root.post(new Runnable() { public void run() { setMinimizedInternal(min); } });
    }
    // Move the floating panel (grip drag). Deltas are device px in SCREEN space. Bottom-center gravity:
    // +x → right, +y(offset) → up, so a downward drag (dy>0) lowers the panel (dragY -= dy).
    @android.webkit.JavascriptInterface public void dragBy(final int dx, final int dy) {
      if (root == null) return;
      root.post(new Runnable() { public void run() {
        if (minimized || !added) return;
        dragX += dx; dragY -= dy;
        try { wm.updateViewLayout(root, params(false)); } catch (Exception e) {}
      } });
    }
    // The web reports the card's pixel height so the panel window hugs the content (not a fixed slab).
    @android.webkit.JavascriptInterface public void setPanelHeight(final int h) {
      if (root == null || h <= 0) return;
      root.post(new Runnable() { public void run() {
        if (minimized || !added) return;
        panelH = h;
        try { wm.updateViewLayout(root, params(false)); } catch (Exception e) {}
      } });
    }
    @android.webkit.JavascriptInterface public void close() {
      if (root != null) root.post(new Runnable() { public void run() { stopSelf(); } });
    }
    // Hold/release a partial wake lock while listening/working so the mic + audio keep running with the
    // screen off. Safety timeout so a stuck session can't drain the battery indefinitely.
    @android.webkit.JavascriptInterface public void setAwake(final boolean on) {
      if (root == null) return;
      root.post(new Runnable() { public void run() {
        try {
          if (on) {
            if (wakeLock == null) {
              android.os.PowerManager pm = (android.os.PowerManager) getSystemService(POWER_SERVICE);
              wakeLock = pm.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "asmltr:overlay");
              wakeLock.setReferenceCounted(false);
            }
            if (!wakeLock.isHeld()) wakeLock.acquire(10 * 60 * 1000L);
            if (web != null) web.resumeTimers(); // keep JS/VAD running while not visible
            try { WakeWord.pause(); } catch (Throwable t) {}   // free the mic for the turn recorder
          } else {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
            try { WakeWord.resume(); } catch (Throwable t) {}  // hand the mic back to the wake listener
          }
        } catch (Exception e) {}
      } });
    }
  }

  private String configJs() {
    SharedPreferences p = getSharedPreferences("asmltr", Context.MODE_PRIVATE);
    JSONObject o = new JSONObject();
    try {
      o.put("baseUrl", p.getString("baseUrl", ""));
      o.put("token", p.getString("token", ""));
      o.put("name", p.getString("name", "assistant"));
      o.put("deviceId", NativeConfig.deviceId(this));
    } catch (Exception e) {}
    return "window.__ASMLTR_NATIVE_CFG=" + o.toString() + ";";
  }

  private Notification buildNotification() {
    if (Build.VERSION.SDK_INT >= 26) {
      NotificationChannel c = new NotificationChannel(CH, "Assistant overlay", NotificationManager.IMPORTANCE_LOW);
      c.setShowBadge(false);
      ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(c);
    }
    Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CH) : new Notification.Builder(this);
    return b.setContentTitle("Assistant")
      .setContentText("Floating assistant is active")
      .setSmallIcon(android.R.drawable.ic_btn_speak_now)
      .setOngoing(true).build();
  }

  @Override public void onDestroy() {
    releaseAudioFocus();                       // → whatever we paused on open resumes now
    try { if (wakeLock != null && wakeLock.isHeld()) wakeLock.release(); } catch (Exception e) {}
    try { if (added && root != null) wm.removeView(root); } catch (Exception e) {}
    try { if (web != null) { web.loadUrl("about:blank"); web.destroy(); } } catch (Exception e) {}
    added = false;
    super.onDestroy();
  }
}
