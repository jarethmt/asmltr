package com.asmltr.assistant;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.service.voice.VoiceInteractionSession;
/** Fired by the assist gesture (earbud hold). We don't draw an overlay — we launch the app in
 *  listen mode and get out of the way. */
public class AsmltrSession extends VoiceInteractionSession {
  public AsmltrSession(Context context) { super(context); }
  @Override public void onShow(Bundle args, int showFlags) {
    super.onShow(args, showFlags);
    Intent i = new Intent(getContext(), MainActivity.class);
    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    i.putExtra("asmltr_assist", true);
    getContext().startActivity(i);
    hide();
  }
}
