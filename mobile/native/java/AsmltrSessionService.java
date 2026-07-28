package com.asmltr.assistant;
import android.os.Bundle;
import android.service.voice.VoiceInteractionSession;
import android.service.voice.VoiceInteractionSessionService;
public class AsmltrSessionService extends VoiceInteractionSessionService {
  @Override public VoiceInteractionSession onNewSession(Bundle args) { return new AsmltrSession(this); }
}
