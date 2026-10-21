package com.asmltr.assistant;
import android.app.Activity;
import android.content.Context;
import android.content.pm.PackageManager;
import android.Manifest;
import android.net.wifi.p2p.WifiP2pConfig;
import android.net.wifi.p2p.WifiP2pGroup;
import android.net.wifi.p2p.WifiP2pInfo;
import android.net.wifi.p2p.WifiP2pManager;
import android.os.Build;
import android.util.Base64;
import org.json.JSONObject;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.security.SecureRandom;
import java.util.concurrent.ConcurrentLinkedQueue;

/** Wi-Fi Direct (Wi-Fi P2P) fast path for the Portal dongle. BLE stays bootstrap + fallback; this is
 *  the ordered/reliable bulk channel (screenshots, file contents) that lossy BLE notifications couldn't
 *  carry. Mirrors Riley's Power Wheels: the phone is the Group Owner, the dongle joins as a legacy STA
 *  using creds we generate here and the app hands over via BLE. A TCP ServerSocket on the GO (us) carries
 *  the drive protocol; the dongle dials in. Driven from NativeConfig's @JavascriptInterface wrappers so
 *  the remotely-loaded dashboard can reach it (Capacitor plugins don't bridge on a remote page).
 *
 *  TCP framing, both directions: [len:2 big-endian][payload]. app->dongle payload = [mode:1][data...];
 *  dongle->app payload = raw ioback bytes. We own the length header on both sides (JS passes raw payload). */
public class WifiP2pLink {
  private static final String NET_NAME   = "DIRECT-am-asmltr";  // frozen: the dongle joins this exact SSID
  private static final int    PORT       = 9790;
  private static final String DEFAULT_GO = "192.168.49.1";      // Android P2P GO address when none is reported
  private static final int    REQ_CODE   = 0x9790;

  private final Context ctx;
  private WifiP2pManager mgr;
  private WifiP2pManager.Channel channel;

  // State mirrors the BLE bridge pattern (volatile scalars + a drain queue) so JS can poll it.
  private volatile String  state = "idle";   // idle|creating|ready|error
  private volatile String  error = "";
  private volatile String  passphrase = "";
  private volatile String  ssid  = NET_NAME;
  private volatile String  goIp  = DEFAULT_GO;

  private volatile ServerSocket server;
  private volatile Socket       sock;
  private volatile OutputStream out;
  private volatile boolean      sockConnected = false;
  private volatile boolean      running = false;   // accept loop should keep going (false = stop() called)
  private Thread acceptThread;
  // Incoming frames, base64 (ioback may be binary e.g. JPEG) — same shape as bleIoNotif / bleNotificationsIo.
  private final ConcurrentLinkedQueue<String> wifiIoQueue = new ConcurrentLinkedQueue<>();

  public WifiP2pLink(Context c) { ctx = c; }

  // On API 33+ P2P needs NEARBY_WIFI_DEVICES (neverForLocation); below 33 it needs FINE_LOCATION.
  private boolean permsGranted() {
    String p = Build.VERSION.SDK_INT >= 33 ? Manifest.permission.NEARBY_WIFI_DEVICES
                                           : Manifest.permission.ACCESS_FINE_LOCATION;
    return ctx.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED;
  }

  // Fire the runtime prompt (needs an Activity context — the bridge is constructed with MainActivity).
  private void requestPerms() {
    if (!(ctx instanceof Activity)) return;
    String[] req = Build.VERSION.SDK_INT >= 33 ? new String[]{ Manifest.permission.NEARBY_WIFI_DEVICES }
                                               : new String[]{ Manifest.permission.ACCESS_FINE_LOCATION };
    try { ((Activity) ctx).requestPermissions(req, REQ_CODE); } catch (Exception e) {}
  }

  /** Idempotent. Ensure perms (prompt + return err:perm if not yet granted), init the manager, drop any
   *  stale group, generate a random passphrase, create a 2.4 GHz GO group (ESP32 is 2.4-only), and bring
   *  up the TCP server. Group creation + accept run async; JS polls info()/sockConnected(). */
  public synchronized String start() {
    try {
      if (!permsGranted()) { requestPerms(); return "err:perm"; }
      // WifiP2pConfig.Builder + createGroup(config) are API 29+. Below that we can't set band/creds.
      if (Build.VERSION.SDK_INT < 29) return "err:unsupported";
      if (mgr == null) {
        mgr = (WifiP2pManager) ctx.getSystemService(Context.WIFI_P2P_SERVICE);
        if (mgr == null) { state = "error"; error = "no-p2p"; return "err:no-p2p"; }
        channel = mgr.initialize(ctx, ctx.getMainLooper(), null);
      }
      if (channel == null) { state = "error"; error = "no-channel"; return "err:no-channel"; }

      // Tear down any socket/group we already own so a second call cleanly re-provisions.
      closeSockets();
      sockConnected = false;
      wifiIoQueue.clear();
      state = "creating"; error = "";
      passphrase = randomPass(12);
      ssid = NET_NAME; goIp = DEFAULT_GO;

      // Remove any stale group first, THEN create ours (chained through the listener; onFailure just
      // means no group existed, which is fine).
      mgr.removeGroup(channel, new WifiP2pManager.ActionListener() {
        @Override public void onSuccess() { createGroup(); }
        @Override public void onFailure(int reason) { createGroup(); }
      });

      // Server up-front so the dongle can connect the instant it associates.
      startServer();
      return "ok";
    } catch (SecurityException se) { state = "error"; error = "perm"; return "err:perm"; }
      catch (Exception e) { state = "error"; error = String.valueOf(e.getMessage()); return "err:" + e.getMessage(); }
  }

  private void createGroup() {
    try {
      WifiP2pConfig cfg = new WifiP2pConfig.Builder()
          .setNetworkName(NET_NAME)
          .setPassphrase(passphrase)
          .setGroupOperatingBand(WifiP2pConfig.GROUP_OWNER_BAND_2GHZ)  // 2.4 GHz — a 5 GHz group is uninvitable by the ESP32
          .build();
      mgr.createGroup(channel, cfg, new WifiP2pManager.ActionListener() {
        @Override public void onSuccess() { state = "ready"; refreshGroupInfo(); refreshConnInfo(); }
        @Override public void onFailure(int reason) { state = "error"; error = "create-group:" + reason; }
      });
    } catch (SecurityException se) { state = "error"; error = "perm"; }
      catch (Exception e) { state = "error"; error = String.valueOf(e.getMessage()); }
  }

  // Read the creds back from the framework in case it altered them (report the ACTUAL values to JS).
  private void refreshGroupInfo() {
    try {
      mgr.requestGroupInfo(channel, new WifiP2pManager.GroupInfoListener() {
        @Override public void onGroupInfoAvailable(WifiP2pGroup g) {
          if (g == null) return;
          try {
            String n = g.getNetworkName(); if (n != null && !n.isEmpty()) ssid = n;
            String p = g.getPassphrase();  if (p != null && !p.isEmpty()) passphrase = p;
          } catch (Exception e) {}
        }
      });
    } catch (Exception e) {}
  }

  // GO address is fixed at 192.168.49.1 in practice, but report what the framework says when available.
  private void refreshConnInfo() {
    try {
      mgr.requestConnectionInfo(channel, new WifiP2pManager.ConnectionInfoListener() {
        @Override public void onConnectionInfoAvailable(WifiP2pInfo info) {
          try {
            if (info != null && info.groupOwnerAddress != null) {
              String h = info.groupOwnerAddress.getHostAddress();
              if (h != null && !h.isEmpty()) goIp = h;
            }
          } catch (Exception e) {}
        }
      });
    } catch (Exception e) {}
  }

  private void startServer() {
    running = true;
    acceptThread = new Thread(new Runnable() { public void run() {
      ServerSocket ss;
      try {
        ss = new ServerSocket();
        ss.setReuseAddress(true);
        ss.bind(new InetSocketAddress("0.0.0.0", PORT));
        server = ss;
      } catch (Exception e) { error = "server:" + e.getMessage(); return; }
      // Accept in a loop so a dropped/reconnecting dongle is picked back up (one live connection at a time).
      while (running) {
        try {
          Socket s = ss.accept();
          s.setTcpNoDelay(true);  // small control frames — don't let Nagle add latency
          sock = s; out = s.getOutputStream();
          sockConnected = true;
          pump(s);                // blocks reading frames until the socket drops
        } catch (Exception e) {
          if (!running) break;    // stop() closed the ServerSocket to unblock us — exit quietly
        } finally {
          sockConnected = false;
        }
      }
    }}, "wifip2p-accept");
    acceptThread.setDaemon(true);
    acceptThread.start();
  }

  // Read [len:2 BE][payload] frames and enqueue each payload's base64. Any short read / framing error
  // (len out of 1..65535) drops the link and we fall back to re-accept.
  private void pump(Socket s) {
    try {
      InputStream in = s.getInputStream();
      byte[] hdr = new byte[2];
      while (running) {
        if (!readFull(in, hdr, 2)) break;
        int len = ((hdr[0] & 0xFF) << 8) | (hdr[1] & 0xFF);
        if (len <= 0 || len > 65535) break;
        byte[] payload = new byte[len];
        if (!readFull(in, payload, len)) break;
        wifiIoQueue.add(Base64.encodeToString(payload, Base64.NO_WRAP));
      }
    } catch (Exception e) {
    } finally {
      try { s.close(); } catch (Exception e) {}
      out = null;
    }
  }

  private static boolean readFull(InputStream in, byte[] buf, int n) throws java.io.IOException {
    int off = 0;
    while (off < n) {
      int r = in.read(buf, off, n - off);
      if (r <= 0) return false;   // peer closed / error
      off += r;
    }
    return true;
  }

  /** base64Payload decodes to [mode:1][data...]; we prepend the 2-byte BE length and write the frame. */
  public synchronized String write(String base64Payload) {
    try {
      OutputStream o = out;
      if (o == null || !sockConnected) return "err:not-connected";
      byte[] payload = Base64.decode(base64Payload, Base64.DEFAULT);
      int len = payload.length;
      if (len <= 0 || len > 65535) return "err:bad-len";
      byte[] frame = new byte[2 + len];
      frame[0] = (byte) ((len >> 8) & 0xFF);
      frame[1] = (byte) (len & 0xFF);
      System.arraycopy(payload, 0, frame, 2, len);
      o.write(frame); o.flush();
      return "ok";
    } catch (Exception e) { sockConnected = false; return "err:" + e.getMessage(); }
  }

  /** Drain incoming frames as a JSON array of base64 strings (same shape as bleNotificationsIo). */
  public String readIo() {
    StringBuilder sb = new StringBuilder("["); boolean first = true; String s;
    while ((s = wifiIoQueue.poll()) != null) { if (!first) sb.append(","); sb.append(JSONObject.quote(s)); first = false; }
    return sb.append("]").toString();
  }

  public boolean sockConnected() { return sockConnected && out != null; }

  public String info() {
    try {
      if ("ready".equals(state)) { refreshGroupInfo(); refreshConnInfo(); }  // keep reported creds/ip fresh
      JSONObject o = new JSONObject();
      o.put("state", state);
      o.put("ssid", ssid);
      o.put("pass", passphrase);
      o.put("goIp", goIp);
      o.put("port", PORT);
      o.put("error", error);
      return o.toString();
    } catch (Exception e) { return "{\"state\":\"error\"}"; }
  }

  public synchronized void stop() {
    running = false;
    closeSockets();        // closing the ServerSocket unblocks accept(); closing sock unblocks pump()
    sockConnected = false;
    wifiIoQueue.clear();
    try { if (mgr != null && channel != null) mgr.removeGroup(channel, null); } catch (Exception e) {}
    state = "idle"; error = "";
  }

  private void closeSockets() {
    try { Socket s = sock; sock = null; if (s != null) s.close(); } catch (Exception e) {}
    try { ServerSocket ss = server; server = null; if (ss != null) ss.close(); } catch (Exception e) {}
    out = null;
  }

  // WPA2 passphrase (8..63 chars); 12 alphanumeric is plenty and avoids charset edge cases on the ESP32.
  private static String randomPass(int n) {
    final String al = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    SecureRandom r = new SecureRandom();
    StringBuilder sb = new StringBuilder(n);
    for (int i = 0; i < n; i++) sb.append(al.charAt(r.nextInt(al.length())));
    return sb.toString();
  }
}
