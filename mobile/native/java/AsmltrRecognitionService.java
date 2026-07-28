package com.asmltr.assistant;
import android.content.Intent;
import android.speech.RecognitionService;
/** Stub RecognitionService — required for the app to be eligible as the default assistant.
 *  Real speech recognition happens in the WebView (getUserMedia → connector /gw/transcribe). */
public class AsmltrRecognitionService extends RecognitionService {
  @Override protected void onStartListening(Intent recognizerIntent, Callback listener) { }
  @Override protected void onCancel(Callback listener) { }
  @Override protected void onStopListening(Callback listener) { }
}
