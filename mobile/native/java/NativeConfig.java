package com.asmltr.assistant;
import android.content.Context;
import android.content.SharedPreferences;
import android.webkit.JavascriptInterface;
/** Bridge exposed to BOTH the app WebView and the overlay-session WebView so connector config lives in
 *  one place (SharedPreferences). Merge semantics: only non-empty fields overwrite (so saving just the
 *  dashboard URL from the launcher never wipes an already-set token). */
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
}
