package com.asmltr.assistant;

import android.animation.ValueAnimator;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.TextView;

/**
 * The held-notifications badge — the same eyes as the read-aloud toast, parked in a screen corner with
 * an "!" instead of speaking over you.
 *
 * It appears whenever SpeakGate holds a synopsis (a call, Do Not Disturb, navigation) and stays until
 * you deal with it:
 *   • **Tap** → read the whole backlog aloud, in order, in the configured voice.
 *   • **Drag to the ✕** (which fades in at the bottom while you drag) → discard the backlog unheard.
 *   • **Fling it off any edge** → same thing, for when the ✕ is more ceremony than you want.
 *   • **Drag anywhere else** → it snaps to the nearest side and remembers that spot.
 *
 * Two windows, both small on purpose: a full-screen overlay would swallow touches on its transparent
 * margins and make the app underneath untappable (the lesson from the assistant panel). Touch is handled
 * natively rather than in JS so tap-vs-drag uses the platform's own slop threshold and the coordinates
 * are real device pixels.
 */
public class NotifBadgeOverlay {
  private static final Handler H = new Handler(Looper.getMainLooper());
  private static final int BADGE_DP = 104;
  private static final int TRASH_DP = 72;

  private static WindowManager wm;
  private static DragLayout root;
  private static WebView web;
  private static WindowManager.LayoutParams lp;
  private static View trash;
  private static boolean trashHot = false;

  // ── lifecycle ───────────────────────────────────────────────────────────────

  /** Show (or refresh) the badge with `count` held notifications. Safe to call from any thread. */
  public static void show(final Context ctx, final int count) {
    final Context app = ctx.getApplicationContext();
    H.post(() -> {
      try {
        if (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(app)) {
          android.util.Log.w("AsmltrNotif", "held " + count + " notification(s) but can't draw the badge — overlay permission not granted");
          return;
        }
        if (root != null) { setCount(count); setState("idle"); return; }

        WindowManager w = (WindowManager) app.getSystemService(Context.WINDOW_SERVICE);
        if (w == null) return;

        WebView v = new WebView(app);
        v.setBackgroundColor(Color.TRANSPARENT);
        WebSettings s = v.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        v.loadUrl("file:///android_asset/public/notif-badge.html?n=" + count);

        DragLayout r = new DragLayout(app);
        r.addView(v, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        WindowManager.LayoutParams p = new WindowManager.LayoutParams();
        p.type = Build.VERSION.SDK_INT >= 26
            ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            : WindowManager.LayoutParams.TYPE_PHONE;
        p.format = PixelFormat.TRANSLUCENT;
        p.width = dp(app, BADGE_DP);
        p.height = dp(app, BADGE_DP);
        p.gravity = Gravity.TOP | Gravity.START;
        // NOT_FOCUSABLE keeps the keyboard/input focus with the app behind; NOT_TOUCH_MODAL lets touches
        // outside this little window through. Touches INSIDE still reach us — that's the tap target.
        p.flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
            | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
            | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
            | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS;

        SharedPreferences prefs = app.getSharedPreferences("asmltr", Context.MODE_PRIVATE);
        int[] screen = screen(app);
        p.x = prefs.getInt("notif_badge_x", screen[0] - dp(app, BADGE_DP) - dp(app, 4));  // upper-RIGHT by default
        p.y = prefs.getInt("notif_badge_y", dp(app, 84));
        clamp(app, p);

        w.addView(r, p);
        wm = w; root = r; web = v; lp = p;
      } catch (Throwable t) { android.util.Log.w("AsmltrNotif", "badge failed: " + t); }
    });
  }

  /** Put the badge back after a process restart, if anything is still held. */
  static void restore(Context ctx) {
    try { int n = NotifQueue.size(ctx); if (n > 0) show(ctx, n); } catch (Throwable t) {}
  }

  public static void hide(Context ctx) {
    H.post(NotifBadgeOverlay::removeNow);
  }

  private static void removeNow() {
    removeTrash();
    try { if (root != null && wm != null) wm.removeViewImmediate(root); } catch (Throwable t) {}
    try { if (web != null) web.destroy(); } catch (Throwable t) {}
    root = null; web = null; lp = null;
  }

  // ── visual state pushed into the WebView ────────────────────────────────────

  static void setCount(final int n) {
    H.post(() -> { try { if (web != null) web.evaluateJavascript("window.setCount&&setCount(" + n + ")", null); } catch (Throwable t) {} });
  }

  /** Feed the playback envelope to the badge's face while it reads the backlog aloud. */
  private static long lastAmpAt = 0;
  static void pushAmp(final float v) {
    long now = android.os.SystemClock.uptimeMillis();
    if (now - lastAmpAt < 66) return;
    lastAmpAt = now;
    H.post(() -> { try { if (web != null) web.evaluateJavascript("window.setAmp&&setAmp(" + v + ")", null); } catch (Throwable t) {} });
  }

  /** "idle" · "reading" · "busy" (a shake — you tapped, but a call is still up) · "drag". */
  static void setState(final String state) {
    H.post(() -> { try { if (web != null) web.evaluateJavascript("window.setState&&setState('" + Uri.encode(state) + "')", null); } catch (Throwable t) {} });
  }

  // ── touch: tap vs drag vs discard ───────────────────────────────────────────

  private static class DragLayout extends FrameLayout {
    private float downRawX, downRawY;
    private int startX, startY, slop;
    private boolean dragging;

    DragLayout(Context c) { super(c); slop = ViewConfiguration.get(c).getScaledTouchSlop(); }

    // The WebView is decoration; every touch belongs to the drag/tap handler.
    @Override public boolean onInterceptTouchEvent(MotionEvent ev) { return true; }

    @Override public boolean onTouchEvent(MotionEvent ev) {
      if (lp == null || wm == null) return false;
      switch (ev.getActionMasked()) {
        case MotionEvent.ACTION_DOWN:
          downRawX = ev.getRawX(); downRawY = ev.getRawY();
          startX = lp.x; startY = lp.y; dragging = false;
          return true;
        case MotionEvent.ACTION_MOVE: {
          float dx = ev.getRawX() - downRawX, dy = ev.getRawY() - downRawY;
          if (!dragging && Math.hypot(dx, dy) > slop) { dragging = true; setState("drag"); showTrash(getContext()); }
          if (dragging) {
            lp.x = startX + (int) dx; lp.y = startY + (int) dy;
            try { wm.updateViewLayout(this, lp); } catch (Throwable t) {}
            highlightTrash(getContext(), overTrash(getContext()));
          }
          return true;
        }
        case MotionEvent.ACTION_UP:
        case MotionEvent.ACTION_CANCEL: {
          Context c = getContext().getApplicationContext();
          if (!dragging) { setState("reading"); readAll(c); return true; }
          boolean discard = overTrash(c) || offScreen(c);
          removeTrash();
          if (discard) { dismissAll(c); return true; }
          snapToEdge(c);
          setState("idle");
          return true;
        }
      }
      return true;
    }
  }

  /** Tap → read everything held, on a background thread (speech blocks). */
  private static void readAll(final Context app) {
    new Thread(() -> ReadAloud.flush(app), "asmltr-badge-read").start();
  }

  /** Drag-to-✕ / fling-off-screen → drop the backlog unheard. */
  private static void dismissAll(final Context app) {
    int n = NotifQueue.size(app);
    NotifQueue.clear(app);
    android.util.Log.d("AsmltrNotif", "badge dismissed — discarded " + n + " held notification(s)");
    removeNow();
  }

  private static void snapToEdge(Context app) {
    if (lp == null || root == null) return;
    int[] screen = screen(app);
    int w = dp(app, BADGE_DP), margin = dp(app, 4);
    int left = margin, right = screen[0] - w - margin;
    final int target = (lp.x + w / 2) < screen[0] / 2 ? left : right;
    final int from = lp.x;
    try {
      ValueAnimator a = ValueAnimator.ofInt(from, target);
      a.setDuration(180);
      a.addUpdateListener(an -> {
        if (lp == null || root == null || wm == null) return;
        lp.x = (int) an.getAnimatedValue();
        try { wm.updateViewLayout(root, lp); } catch (Throwable t) {}
      });
      a.start();
    } catch (Throwable t) { lp.x = target; try { wm.updateViewLayout(root, lp); } catch (Throwable e) {} }
    clamp(app, lp);
    try {
      app.getSharedPreferences("asmltr", Context.MODE_PRIVATE).edit()
          .putInt("notif_badge_x", target).putInt("notif_badge_y", lp.y).apply();
    } catch (Throwable t) {}
  }

  // ── the ✕ drop target ───────────────────────────────────────────────────────

  private static void showTrash(Context ctx) {
    final Context app = ctx.getApplicationContext();
    if (trash != null || wm == null) return;
    try {
      TextView t = new TextView(app);
      t.setText("✕");
      t.setTextSize(26);
      t.setTextColor(0xFFF3F4F6);
      t.setGravity(Gravity.CENTER);
      t.setBackground(trashBg(app, false));
      t.setAlpha(0f);

      WindowManager.LayoutParams p = new WindowManager.LayoutParams();
      p.type = Build.VERSION.SDK_INT >= 26
          ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
          : WindowManager.LayoutParams.TYPE_PHONE;
      p.format = PixelFormat.TRANSLUCENT;
      p.width = dp(app, TRASH_DP); p.height = dp(app, TRASH_DP);
      p.gravity = Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL;
      p.y = dp(app, 96);
      p.flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
          | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE      // it's a target, not a button
          | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
          | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN;
      wm.addView(t, p);
      t.animate().alpha(1f).setDuration(140).start();
      trash = t; trashHot = false;
    } catch (Throwable e) { trash = null; }
  }

  private static void removeTrash() {
    try { if (trash != null && wm != null) wm.removeViewImmediate(trash); } catch (Throwable t) {}
    trash = null; trashHot = false;
  }

  private static void highlightTrash(Context ctx, boolean hot) {
    if (trash == null || hot == trashHot) return;
    trashHot = hot;
    try {
      trash.setBackground(trashBg(ctx.getApplicationContext(), hot));
      trash.animate().scaleX(hot ? 1.25f : 1f).scaleY(hot ? 1.25f : 1f).setDuration(120).start();
    } catch (Throwable t) {}
  }

  private static GradientDrawable trashBg(Context app, boolean hot) {
    GradientDrawable g = new GradientDrawable();
    g.setShape(GradientDrawable.OVAL);
    g.setColor(hot ? 0xEE9D2463 : 0xCC1B1B26);                       // magenta when armed, charcoal at rest
    g.setStroke(dp(app, 2), hot ? 0xFFEC4899 : 0x668B5CF6);          // violet rim → magenta
    return g;
  }

  /** Is the badge sitting over the ✕? Compared centre-to-centre, with a forgiving radius. */
  private static boolean overTrash(Context ctx) {
    if (trash == null || lp == null) return false;
    Context app = ctx.getApplicationContext();
    int[] screen = screen(app);
    int bw = dp(app, BADGE_DP);
    float bx = lp.x + bw / 2f, by = lp.y + bw / 2f;
    float tx = screen[0] / 2f, ty = screen[1] - dp(app, 96) - dp(app, TRASH_DP) / 2f;
    return Math.hypot(bx - tx, by - ty) < dp(app, 88);
  }

  /** Flung far enough past an edge that the intent is clearly "get rid of it". */
  private static boolean offScreen(Context ctx) {
    if (lp == null) return false;
    Context app = ctx.getApplicationContext();
    int[] screen = screen(app);
    int w = dp(app, BADGE_DP);
    float cx = lp.x + w / 2f, cy = lp.y + w / 2f;
    return cx < w * 0.15f || cx > screen[0] - w * 0.15f || cy < 0 || cy > screen[1];
  }

  // ── geometry helpers ────────────────────────────────────────────────────────

  private static void clamp(Context app, WindowManager.LayoutParams p) {
    int[] screen = screen(app);
    int w = dp(app, BADGE_DP);
    if (p.x < 0) p.x = 0;
    if (p.x > screen[0] - w) p.x = screen[0] - w;
    if (p.y < dp(app, 28)) p.y = dp(app, 28);                      // clear of the status bar
    if (p.y > screen[1] - w - dp(app, 28)) p.y = screen[1] - w - dp(app, 28);
  }

  private static int[] screen(Context app) {
    try {
      WindowManager w = (WindowManager) app.getSystemService(Context.WINDOW_SERVICE);
      DisplayMetrics dm = new DisplayMetrics();
      w.getDefaultDisplay().getRealMetrics(dm);
      if (dm.widthPixels > 0) return new int[] { dm.widthPixels, dm.heightPixels };
    } catch (Throwable t) {}
    DisplayMetrics dm = app.getResources().getDisplayMetrics();
    return new int[] { dm.widthPixels, dm.heightPixels };
  }

  private static int dp(Context c, int v) {
    return Math.round(v * c.getResources().getDisplayMetrics().density);
  }
}
