package com.asmltr.assistant;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.webkit.JavascriptInterface;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/** Bridge shared by the app + overlay WebViews: connector config (SharedPreferences, merge semantics)
 *  and the auto-update flow (report the installed versionCode, download a new APK, launch the system
 *  installer — Android never silently self-installs, so the user confirms the final "Update"). */
public class NativeConfig {
  private final Context ctx;
  public NativeConfig(Context c) { ctx = c; }

  @JavascriptInterface
  public void saveConfig(String baseUrl, String token, String name) {
    SharedPreferences.Editor e = ctx.getSharedPreferences("asmltr", Context.MODE_PRIVATE).edit();
    if (baseUrl != null && !baseUrl.isEmpty()) e.putString("baseUrl", baseUrl);
    if (token != null && !token.isEmpty()) e.putString("token", token);
    if (name != null && !name.isEmpty()) e.putString("name", name);
    e.apply();
  }

  @JavascriptInterface
  public int getAppVersion() {
    try { return ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0).versionCode; }
    catch (Exception e) { return 0; }
  }

  /** Download the APK at `url` then hand it to the system package installer (user confirms). */
  @JavascriptInterface
  public void installUpdate(final String url) {
    new Thread(new Runnable() { public void run() {
      try {
        File out = new File(ctx.getExternalFilesDir(null), "asmltr-update.apk");
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setInstanceFollowRedirects(true); c.connect();
        InputStream in = c.getInputStream(); FileOutputStream fo = new FileOutputStream(out);
        byte[] b = new byte[8192]; int n; while ((n = in.read(b)) > 0) fo.write(b, 0, n);
        fo.close(); in.close(); c.disconnect();
        Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".updateprovider", out);
        Intent i = new Intent(Intent.ACTION_VIEW);
        i.setDataAndType(uri, "application/vnd.android.package-archive");
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        ctx.startActivity(i);
      } catch (Exception e) { /* best-effort; the browser-download fallback still works */ }
    } }).start();
  }
}
