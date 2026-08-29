package com.asmltr.assistant;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;

/**
 * Native audio cues. The web overlay's WebAudio "listen" beep is inaudible when the overlay wakes from
 * CLOSED (wake word / headset button): the WebView isn't alive yet and the Bluetooth A2DP route isn't
 * warm, so the first tone is dropped/clipped. This plays the cue natively from the always-on service —
 * which already holds a warm audio route — with a short silent primer to spin up the A2DP link first,
 * so it lands on Bluetooth headphones even with the screen off and nothing on screen.
 *
 * Dependency-free: a generated PCM sine pair written to a one-shot AudioTrack on the MEDIA route (which
 * is what A2DP carries). Mirrors the web cue: rising 440→660 = "listening", falling 660→440 = "stopped".
 */
public class Chime {
  private static final int SR = 44100;

  /** Rising two-tone "now listening" cue. */
  public static void listen(Context ctx) { play(ctx, 440, 660); }
  /** Falling two-tone "stopped, mic off" cue. */
  public static void stop(Context ctx) { play(ctx, 660, 440); }
  /** Low descending "thunk" — turn killed. */
  public static void kill(Context ctx) { play(ctx, 330, 220); }

  /**
   * True while a communication (SCO) route is up — i.e. we're capturing from the headset mic.
   * MEDIA-usage audio is displaced while SCO holds the route, so a cue played as MEDIA is simply
   * never heard. Voice-communication usage rides the SCO link instead.
   */
  private static boolean onCommRoute(Context ctx) {
    try {
      AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
      if (am == null) return false;
      if (android.os.Build.VERSION.SDK_INT >= 31) return am.getCommunicationDevice() != null
          && am.getCommunicationDevice().getType() == android.media.AudioDeviceInfo.TYPE_BLUETOOTH_SCO;
      return am.isBluetoothScoOn();
    } catch (Throwable t) { return false; }
  }

  private static void play(final Context ctx, final int f1, final int f2) {
    new Thread(() -> {
      try {
        final boolean comm = onCommRoute(ctx);
        // 0.30s silent primer (warm the idle A2DP route) + two 0.12s tones with a small gap.
        short[] buf = build(f1, f2);
        AudioTrack track = new AudioTrack.Builder()
            .setAudioAttributes(new AudioAttributes.Builder()
                // On the SCO/call route MEDIA is inaudible — follow the route the mic put us on.
                .setUsage(comm ? AudioAttributes.USAGE_VOICE_COMMUNICATION : AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build())
            .setAudioFormat(new AudioFormat.Builder()
                .setSampleRate(SR)
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                .build())
            .setBufferSizeInBytes(buf.length * 2)
            .setTransferMode(AudioTrack.MODE_STATIC)
            .build();
        track.write(buf, 0, buf.length);
        track.setNotificationMarkerPosition(buf.length);
        track.setPlaybackPositionUpdateListener(new AudioTrack.OnPlaybackPositionUpdateListener() {
          @Override public void onMarkerReached(AudioTrack t) { try { t.stop(); t.release(); } catch (Throwable x) {} }
          @Override public void onPeriodicNotification(AudioTrack t) {}
        });
        track.play();
      } catch (Throwable t) { /* a cue is best-effort — never crash the service */ }
    }, "asmltr-chime").start();
  }

  private static short[] build(int f1, int f2) {
    int primer = (int) (SR * 0.30);   // silent — warms the BT route before the first audible sample
    int tone = (int) (SR * 0.12);
    int gap = (int) (SR * 0.02);
    short[] out = new short[primer + tone + gap + tone];
    int i = primer;                    // leave the primer as zeros (silence)
    writeTone(out, i, tone, f1); i += tone + gap;
    writeTone(out, i, tone, f2);
    return out;
  }

  // A single sine tone with 6ms linear fades in/out (kills the click at edges).
  private static void writeTone(short[] out, int off, int n, int freq) {
    int fade = (int) (SR * 0.006);
    for (int k = 0; k < n && off + k < out.length; k++) {
      double amp = 0.35;
      if (k < fade) amp *= (double) k / fade;
      else if (k > n - fade) amp *= (double) (n - k) / fade;
      out[off + k] = (short) (Math.sin(2 * Math.PI * freq * k / SR) * amp * Short.MAX_VALUE);
    }
  }
}
