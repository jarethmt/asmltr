'use strict';
/**
 * Still-generation ask. Kind-word gate, then a YES/NO classify on the
 * moderation key (gpt-5-nano). Discord Generating-chip and grok xhigh consume
 * the verdict. Not a tool allow. Intent is NOT folded into moderate() today.
 *
 * If openai_api_key is missing, classifyRaw skips (logged once). Do not fall
 * back to grok complete(). Nano sees TEXT ONLY — never the still bytes, never
 * CHANNEL MEDIA paths. If a still arrived, one notice line: a photo was attached.
 */

const KIND_RE = /\b(?:pictures?|images?|graphics?|cartoons?|paintings?|drawings?|photos?|photographs?|pics?)\b/i;
const PHOTO_ATTACHED_NOTICE = 'A photo was attached this turn. Infer intent from the text plus that fact. You are not shown the photo.';

function mentionsImageKind(text) {
  return KIND_RE.test(String(text || ''));
}

/** Drop Discord CHANNEL MEDIA / grok promptBlock tails so paths never reach nano. */
function stripChannelMedia(text) {
  return String(text || '').replace(/\n\nCHANNEL MEDIA[\s\S]*$/i, '').trim();
}

function hasStillThisTurn({ images, mediaFiles, text } = {}) {
  if ((images || []).some((i) => i && (i.data || i.path))) return true;
  if ((mediaFiles || []).some((f) => f && f.kind === 'image')) return true;
  if (/\n\nCHANNEL MEDIA/i.test(String(text || ''))) return true;
  return false;
}

function pictureIntentClassifyText(userText, { photoAttached } = {}) {
  const text = stripChannelMedia(userText);
  if (photoAttached) return [text, PHOTO_ATTACHED_NOTICE].filter(Boolean).join('\n\n');
  return text;
}

function shouldClassifyPictureIntent(userText, { photoAttached } = {}) {
  if (photoAttached) return true;
  return mentionsImageKind(stripChannelMedia(userText));
}

function buildImageGenClassifyPrompt(text) {
  return [
    'Decide if the user wants a NEW still generated or an existing still edited this turn',
    '(draw, make, generate, composite, put someone into a photo, sit him on the bench in a photo, etc.).',
    'YES = they want image_gen or image_edit now.',
    'NO = they only mentioned a picture (talk about one, ask what is in a still,',
    'generate a report, "I liked the picture you made"). A "photo was attached" notice',
    'is NOT by itself YES — only the user text decides, plus that they attached one.',
    'You are not shown the photo. Reply with ONLY YES or NO on the first line.',
    '',
    String(text || '').slice(0, 4000),
  ].join('\n');
}

/** Fail closed (not a picture request) unless the reply leads with YES. */
function parseImageGenVerdict(out) {
  const s = String(out || '').replace(/[*_`#]+/g, ' ').trim();
  if (!s) return false;
  const head = s.split(/\n/)[0].trim();
  if (/^YES\b/i.test(head)) return true;
  if (/^NO\b/i.test(head)) return false;
  return false;
}

/**
 * @param {string} text
 * @param {(opts: object) => Promise<string>} completeFn engine.complete — caller supplies it
 *   so this file never imports an engine (no circular grok require).
 */
async function classifyImageGenAsk(text, completeFn) {
  if (!mentionsImageKind(text)) return false;
  if (typeof completeFn !== 'function') return false;
  try {
    const out = await completeFn({
      prompt: buildImageGenClassifyPrompt(text),
      appendSystemPrompt: 'You are ONLY a classifier. Reply YES or NO. No tools. No extra text.',
    });
    return parseImageGenVerdict(out);
  } catch (_) {
    return false;
  }
}

module.exports = {
  mentionsImageKind, buildImageGenClassifyPrompt, parseImageGenVerdict, classifyImageGenAsk, KIND_RE,
  stripChannelMedia, hasStillThisTurn, pictureIntentClassifyText, shouldClassifyPictureIntent,
  PHOTO_ATTACHED_NOTICE,
};
