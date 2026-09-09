package com.asmltr.assistant;

import android.content.Context;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;

/**
 * Notification eyes — a tiny glowing "eyes" toast that floats over ANY app for a few seconds when the
 * notification reader (AsmltrNotificationService) speaks a synopsis aloud. Same visual language as the
 * in-app orb-face (public/notif-eyes.html), shown in a TYPE_APPLICATION_OVERLAY window so it appears
 * system-wide. Touch-transparent + non-focusable — it never steals input from the app behind it, and
 * auto-dismisses (duration scales with the message length).
 */
public class NotifEyesOverlay {
  private static final Handler H = new Handler(Looper.getMainLooper());
  private static WindowManager wm;
  private static View current;      // the floating WebView
  private static Runnable pending;  // scheduled auto-dismiss

  public static void show(Context ctx, String msg) {
    final Context app = ctx.getApplicationContext();
    final String text = msg == null ? "" : msg;
    H.post(() -> {
      try {
        // needs the draw-over-other-apps permission (the app already requests it for the assistant overlay)
        if (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(app)) return;
        removeNow(app);
        WindowManager w = (WindowManager) app.getSystemService(Context.WINDOW_SERVICE);
        if (w == null) return;

        WebView web = new WebView(app);
        web.setBackgroundColor(Color.TRANSPARENT);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        web.loadUrl("file:///android_asset/public/notif-eyes.html?msg=" + Uri.encode(text));

        WindowManager.LayoutParams lp = new WindowManager.LayoutParams();
        lp.type = Build.VERSION.SDK_INT >= 26
            ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            : WindowManager.LayoutParams.TYPE_PHONE;
        lp.format = PixelFormat.TRANSLUCENT;
        // A small square element that FLOATS over the screen (upper third) — deliberately not a full-width
        // top banner, so it reads as a little presence hovering there rather than a notification.
        lp.width = dp(app, 210);
        lp.height = dp(app, 210);
        lp.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
        lp.y = dp(app, 130); // float well below the status bar / notification shade
        lp.flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
            | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
            | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
            | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS;

        w.addView(web, lp);
        wm = w; current = web;

        // auto-dismiss: ~3.2s base + reading time, capped at 9s. Animate out, then remove.
        long dur = Math.min(9000L, 3200L + text.length() * 55L);
        pending = () -> hide(app);
        H.postDelayed(pending, dur);
      } catch (Throwable t) { /* overlay best-effort — never crash the reader */ }
    });
  }

  /** Feed the playback envelope to the face. Coalesced to ~15 Hz: the Visualizer fires at 20 Hz and a
   *  JS eval per frame on the overlay's WebView is more traffic than the animation can use. */
  private static long lastAmpAt = 0;
  static void pushAmp(final float v) {
    long now = android.os.SystemClock.uptimeMillis();
    if (now - lastAmpAt < 66) return;
    lastAmpAt = now;
    H.post(() -> {
      try { if (current instanceof WebView) ((WebView) current).evaluateJavascript("window.setAmp&&setAmp(" + v + ")", null); }
      catch (Throwable t) {}
    });
  }

  public static void hide(Context ctx) {
    final Context app = ctx.getApplicationContext();
    H.post(() -> {
      try { if (current instanceof WebView) ((WebView) current).evaluateJavascript("window.dismissEyes&&dismissEyes()", null); } catch (Throwable t) {}
      H.postDelayed(() -> removeNow(app), 480); // let the slide-out animation play
    });
  }

  private static void removeNow(Context app) {
    if (pending != null) { H.removeCallbacks(pending); pending = null; }
    try { if (current != null && wm != null) wm.removeViewImmediate(current); } catch (Throwable t) {}
    try { if (current instanceof WebView) ((WebView) current).destroy(); } catch (Throwable t) {}
    current = null;
  }

  private static int dp(Context c, int v) {
    return Math.round(v * c.getResources().getDisplayMetrics().density);
  }
}
