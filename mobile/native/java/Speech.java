package com.asmltr.assistant;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.audiofx.Visualizer;
import android.os.Build;
import android.speech.tts.TextToSpeech;
import android.util.Base64;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Locale;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;

/**
 * Native read-aloud that uses the ASSISTANT's configured voice. Headless speak paths (the control link
 * reading an asmltr-notify `speak` frame, and the notification reader) must sound like the user's chosen
 * TTS — ElevenLabs / OpenAI voice + model — not Android's built-in robot engine. So we synthesize through
 * the connector's `/gw/tts` (which honors the persisted provider/voice/model) and play the returned clip;
 * the OS TextToSpeech engine is only a fallback when the server can't be reached (offline / no key).
 *
 * **Audio focus.** Every spoken clip is bracketed by a TRANSIENT_MAY_DUCK focus request, which is what
 * makes music drop to a murmur underneath instead of fighting the synopsis. It is also the last line of
 * the politeness gate: if the system refuses focus, something is using the audio route in a way we must
 * not interrupt, and the caller queues the text instead of speaking it. Losing focus mid-clip (an
 * incoming call, a navigation prompt) aborts playback and reports BUSY so the text can be held.
 */
public class Speech {
  private static TextToSpeech tts;               // lazy fallback engine
  private static volatile boolean ttsReady = false;

  /** Result of a blocking speak. */
  public static final int SPOKE = 0;    // it was read aloud, start to finish
  public static final int BUSY = 1;     // focus denied or lost — nothing (useful) was heard
  public static final int FAILED = 2;   // nothing to say / no way to say it

  /** Where the live playback envelope goes while a clip plays — whichever eyes are on screen. */
  public interface AmpSink { void amp(float v); }
  private static volatile AmpSink sink;
  public static void setAmpSink(AmpSink s) { sink = s; }

  private static volatile MediaPlayer playing;   // the clip currently on the speaker
  private static volatile boolean aborted;       // set when focus is lost under us
  /** One voice at a time. Several paths can speak (the reader, the control link's notify frame, the
   *  badge flushing a backlog) and without this they overlap into an unintelligible duet — each one
   *  holds its own audio focus, so the system happily lets both through. */
  private static final ReentrantLock VOICE = new ReentrantLock(true);

  /** Fire-and-forget speak in the configured voice. `requireHeadphones` gates on a BT/wired route. */
  public static void speak(final Context ctx, final String base, final String token, final String text, final boolean requireHeadphones) {
    if (text == null || text.trim().isEmpty()) return;
    if (requireHeadphones && !headphonesConnected(ctx)) return;
    new Thread(() -> speakBlocking(ctx, base, token, text), "asmltr-speech").start();
  }

  /**
   * Speak and wait. MUST be called off the main thread. Returns SPOKE / BUSY / FAILED so the caller can
   * decide whether the message was actually delivered or needs holding.
   */
  public static int speakBlocking(Context ctx, String base, String token, String text) {
    if (text == null || text.trim().isEmpty()) return FAILED;
    // Wait for whoever is already talking. A minute is generous for one synopsis; past that, something
    // is wedged and the caller is better off holding this line than queueing behind it forever.
    boolean held = false;
    try { held = VOICE.tryLock(60, TimeUnit.SECONDS); } catch (InterruptedException e) { return BUSY; }
    if (!held) { android.util.Log.d("AsmltrNotif", "speech: another utterance is still playing — holding"); return BUSY; }
    try {
      Object focus = requestFocus(ctx);
      if (focus == null) { android.util.Log.d("AsmltrNotif", "speech: audio focus DENIED — holding instead of speaking"); return BUSY; }
      aborted = false;
      try {
        byte[] audio = synth(base, token, text);
        if (aborted) return BUSY;
        if (audio != null && audio.length > 0) {
          boolean played = playClip(ctx, audio);
          if (aborted) return BUSY;
          if (played) return SPOKE;
        }
        if (aborted) return BUSY;
        return nativeSpeakBlocking(ctx, text) ? SPOKE : FAILED;   // fallback: OS engine
      } finally { abandonFocus(ctx, focus); }
    } finally { VOICE.unlock(); }
  }

  /** Cut a clip short (focus loss, or the user interrupting). */
  public static void stop() {
    aborted = true;
    MediaPlayer mp = playing;
    try { if (mp != null) mp.stop(); } catch (Throwable t) {}
    try { if (tts != null) tts.stop(); } catch (Throwable t) {}
  }

  public static boolean headphonesConnected(Context ctx) {
    try {
      AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
      if (am == null) return false;
      for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
        int t = d.getType();
        if (t == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP || t == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
            || t == AudioDeviceInfo.TYPE_WIRED_HEADPHONES || t == AudioDeviceInfo.TYPE_WIRED_HEADSET
            || t == AudioDeviceInfo.TYPE_USB_HEADSET) return true;
      }
    } catch (Throwable t) {}
    return false;
  }

  // ── audio focus ─────────────────────────────────────────────────────────────

  private static final AudioManager.OnAudioFocusChangeListener FOCUS_LISTENER = change -> {
    // CAN_DUCK is us being asked to duck — we're a short spoken line, let it ride. A real LOSS (a call
    // takes over) or LOSS_TRANSIENT (a navigation prompt) means stop talking immediately.
    if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
      android.util.Log.d("AsmltrNotif", "speech: lost audio focus mid-clip — stopping");
      stop();
    }
  };

  /** Take TRANSIENT_MAY_DUCK focus (so music quiets under us). Returns a token to hand back, or null. */
  private static Object requestFocus(Context ctx) {
    try {
      AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
      if (am == null) return null;
      AudioAttributes attrs = new AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_MEDIA)                      // keep the A2DP media route
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build();
      if (Build.VERSION.SDK_INT >= 26) {
        AudioFocusRequest req = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
            .setAudioAttributes(attrs)
            .setWillPauseWhenDucked(false)
            .setOnAudioFocusChangeListener(FOCUS_LISTENER)
            .build();
        return am.requestAudioFocus(req) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED ? req : null;
      }
      int r = am.requestAudioFocus(FOCUS_LISTENER, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK);
      return r == AudioManager.AUDIOFOCUS_REQUEST_GRANTED ? Boolean.TRUE : null;
    } catch (Throwable t) { return null; }
  }

  private static void abandonFocus(Context ctx, Object token) {
    try {
      AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
      if (am == null) return;
      if (Build.VERSION.SDK_INT >= 26 && token instanceof AudioFocusRequest) am.abandonAudioFocusRequest((AudioFocusRequest) token);
      else am.abandonAudioFocus(FOCUS_LISTENER);
    } catch (Throwable t) {}
  }

  // ── synthesis + playback ────────────────────────────────────────────────────

  /** POST /gw/tts { token, text } → { ok, mime, b64 }. Returns decoded audio bytes, or null on failure. */
  private static byte[] synth(String base, String token, String text) {
    if (base == null || base.isEmpty()) return null;
    HttpURLConnection c = null;
    try {
      c = (HttpURLConnection) new URL(base + "/gw/tts").openConnection();
      c.setRequestMethod("POST");
      c.setConnectTimeout(8000); c.setReadTimeout(30000);
      c.setDoOutput(true);
      c.setRequestProperty("Content-Type", "application/json");
      JSONObject body = new JSONObject(); body.put("token", token); body.put("text", text);
      try (OutputStream os = c.getOutputStream()) { os.write(body.toString().getBytes("UTF-8")); }
      if (c.getResponseCode() < 200 || c.getResponseCode() >= 300) return null;
      java.io.InputStream is = c.getInputStream();
      java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
      byte[] buf = new byte[8192]; int n; while ((n = is.read(buf)) > 0) bo.write(buf, 0, n);
      JSONObject r = new JSONObject(bo.toString("UTF-8"));
      String b64 = r.optString("b64", "");
      if (b64.isEmpty()) return null;
      return Base64.decode(b64, Base64.DEFAULT);
    } catch (Throwable t) { return null; }
    finally { if (c != null) c.disconnect(); }
  }

  /** Write the clip to a temp file and play it on the MEDIA route (→ Bluetooth A2DP). Blocks until done. */
  private static boolean playClip(Context ctx, byte[] audio) {
    File f = null;
    try {
      f = File.createTempFile("asmltr-tts", ".audio", ctx.getCacheDir());
      try (FileOutputStream fos = new FileOutputStream(f)) { fos.write(audio); }
      final MediaPlayer mp = new MediaPlayer();
      mp.setAudioAttributes(new AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_MEDIA)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build());
      mp.setDataSource(f.getAbsolutePath());
      final Object lock = new Object();
      final boolean[] done = { false };
      mp.setOnCompletionListener(m -> { synchronized (lock) { done[0] = true; lock.notifyAll(); } });
      mp.setOnErrorListener((m, w, e) -> { synchronized (lock) { done[0] = true; lock.notifyAll(); } return true; });
      mp.prepare();
      playing = mp;
      if (aborted) { try { mp.release(); } catch (Throwable t) {} playing = null; return false; }
      Visualizer viz = attachVisualizer(mp);
      mp.start();
      synchronized (lock) { while (!done[0]) { try { lock.wait(30000); } catch (InterruptedException e) { break; } if (!mp.isPlaying()) break; } }
      releaseVisualizer(viz);
      playing = null;
      try { mp.release(); } catch (Throwable t) {}
      try { AmpSink s = sink; if (s != null) s.amp(0f); } catch (Throwable t) {}   // settle the face
      return true;
    } catch (Throwable t) { playing = null; return false; }
    finally { if (f != null) try { f.delete(); } catch (Throwable t) {} }
  }

  /**
   * Tap the clip's own audio session so the eyes can move with the actual speech rather than a guess.
   * Without this the notification overlays have NO signal at all — native MediaPlayer does the playing
   * and the WebView never hears about it, which is why they only ever animated idly while talking.
   *
   * Uses the smallest capture buffer at ~20 Hz, which is plenty for an envelope and cheap enough to run
   * on a foreground service. Requires RECORD_AUDIO (already held for the assistant mic). Entirely
   * best-effort: some devices refuse a Visualizer, and the face just falls back to its synthesised
   * breathing rather than failing the readout.
   */
  private static Visualizer attachVisualizer(MediaPlayer mp) {
    try {
      if (sink == null) return null;
      Visualizer v = new Visualizer(mp.getAudioSessionId());
      v.setCaptureSize(Visualizer.getCaptureSizeRange()[0]);
      int rate = Math.min(20000, Visualizer.getMaxCaptureRate());
      v.setDataCaptureListener(new Visualizer.OnDataCaptureListener() {
        @Override public void onWaveFormDataCapture(Visualizer vv, byte[] wave, int samplingRate) {
          AmpSink s = sink;
          if (s == null || wave == null || wave.length == 0) return;
          // 8-bit PCM centred on 128 → RMS → a 0..1 envelope. The x2.6 lift maps ordinary speech level
          // into the top of the range; without it the face barely twitches on normal dialogue.
          long sum = 0;
          for (int i = 0; i < wave.length; i++) { int d = (wave[i] & 0xFF) - 128; sum += (long) d * d; }
          double rms = Math.sqrt((double) sum / wave.length) / 128.0;
          float amp = (float) Math.max(0, Math.min(1, rms * 2.6));
          try { s.amp(amp); } catch (Throwable t) {}
        }
        @Override public void onFftDataCapture(Visualizer vv, byte[] fft, int samplingRate) {}
      }, rate, true, false);
      v.setEnabled(true);
      return v;
    } catch (Throwable t) { android.util.Log.d("AsmltrNotif", "visualizer unavailable: " + t); return null; }
  }

  private static void releaseVisualizer(Visualizer v) {
    if (v == null) return;
    try { v.setEnabled(false); } catch (Throwable t) {}
    try { v.release(); } catch (Throwable t) {}
  }

  /** OS-engine fallback, blocking so the caller keeps audio focus (and the ducking) until it finishes. */
  private static synchronized boolean nativeSpeakBlocking(Context ctx, final String text) {
    if (tts == null) tts = new TextToSpeech(ctx.getApplicationContext(), s -> {
      if (s == TextToSpeech.SUCCESS) { try { tts.setLanguage(Locale.getDefault()); } catch (Throwable t) {} ttsReady = true; }
    });
    for (int i = 0; i < 20 && !ttsReady; i++) { try { Thread.sleep(100); } catch (InterruptedException e) { break; } }
    if (!ttsReady) return false;
    try { tts.speak(text, TextToSpeech.QUEUE_ADD, null, "asmltr-" + System.currentTimeMillis()); } catch (Throwable t) { return false; }
    // Wait it out (cap ~60s) so focus is held for the whole utterance rather than dropped immediately.
    for (int i = 0; i < 600; i++) {
      if (aborted) return false;
      try { if (!tts.isSpeaking() && i > 3) break; } catch (Throwable t) { break; }
      try { Thread.sleep(100); } catch (InterruptedException e) { break; }
    }
    return !aborted;
  }
}
