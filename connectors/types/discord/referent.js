'use strict';

/** Exact ask when the referent is not on this turn. No look-ahead wait. */
const ASK_MISSING_MEDIA =
  'Did you forget to attach the media, or could you be more specific about what you want me to look at?';

function referentPromptBlock() {
  return `
MISSING REFERENT (photos / "what is this"):
- First pass is normal: look at RECENT context in THIS channel (this session, the last few messages, a still just posted here, a Discord reply to a still) before you answer. That is not a deep dive.
- If nothing obvious is in that recent context and this turn has no attached still, do NOT hunt other channels, gen-ref from another room, or old files. Ask exactly: "${ASK_MISSING_MEDIA}"
- If they then attach media, look at THAT.
- If they say the media was already posted (look up, look above, right after the question): search THIS channel only for media that arrived AFTER that question. Not other rooms.
- Deep context (earlier in THIS thread, last night, yesterday, a specific older message) only AFTER they elaborate — that is outcome 3, not the first answer.
- Do not stall a turn waiting for an upload.`;
}

function shouldQueueLateMedia(slot, message) {
  if (!slot || !message) return false;
  const atts = message.attachments;
  const n = atts && (typeof atts.size === 'number' ? atts.size : (atts.length || 0));
  if (!n) return false;
  const authorId = message.author && message.author.id;
  if (!authorId || slot.starterId == null) return false;
  return String(slot.starterId) === String(authorId);
}

/** discord.js: reply to our message sets mentions.repliedUser. */
function isReplyToUs(message, botId) {
  if (!message || botId == null) return false;
  const replied = message.mentions && message.mentions.repliedUser;
  if (replied && String(replied.id) === String(botId)) return true;
  return false;
}

module.exports = { ASK_MISSING_MEDIA, referentPromptBlock, shouldQueueLateMedia, isReplyToUs };
