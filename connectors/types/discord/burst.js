'use strict';

// People send one thought as several messages. Discord has no structural marker for that, unlike a
// Telegram album's shared media_group_id, so the connector infers it from timing: wait for the channel
// to go quiet, then run one turn. That part already worked.
//
// What did not work is what happened to the messages the wait superseded. `scheduleReply` kept a
// single pending entry per channel and replaced it on each new message, so the earlier ones reached
// neither `handleMessage` (their timer was cleared) nor `observe()` (the dispatcher routes a message
// to one or the other, and skips observe for anything addressed enough to schedule a reply). For a
// run of addressed messages, every one except the last was dropped from the session the model sees,
// while the prompt told the model the channel's back-and-forth was already in its history. In an
// owner DM every message is addressed by definition, so every DM burst lost all but its final line.
// Issue #174.
//
// This holds the superseded messages instead of discarding them and hands the whole run to the one
// turn. The quiet window, the single dispatch and the reply target are unchanged; only the content
// the turn carries is. Same shape as connectors/types/telegram/media-group.js, applied to text on a
// surface that has to guess at the grouping rather than being told.
class BurstCoalescer {
  // onFlush({ parts, trigger, forced, count, dropped }) fires once per channel, after the quiet
  // window. `trigger` is the LAST message, which stays the thing the reply answers and threads
  // against. `parts` is every message of the run in arrival order, oldest first.
  constructor({ windowMs = 3000, maxParts = 20, onFlush }) {
    if (typeof onFlush !== 'function') throw new TypeError('onFlush must be a function');
    this.windowMs = windowMs;
    this.maxParts = maxParts;
    this.onFlush = onFlush;
    this.pending = new Map(); // channel id -> accumulator
  }

  // A burst is bounded so a busy channel cannot grow one without end. Once maxParts is reached the
  // OLDEST part is dropped rather than the newest: the newest is the message being answered, and
  // what a long run loses is its beginning, which the count reports so the loss is not silent.
  add(cid, message, forced) {
    let b = this.pending.get(cid);
    if (!b) {
      b = { parts: [], forced: false, dropped: 0, timer: null };
      this.pending.set(cid, b);
    }
    b.parts.push(message);
    while (b.parts.length > this.maxParts) { b.parts.shift(); b.dropped += 1; }
    // `forced` (a silence-mode @mention) is sticky across the window, as it was before: one mention
    // inside the run makes the whole run answerable.
    b.forced = b.forced || !!forced;

    if (b.timer) clearTimeout(b.timer);
    b.timer = setTimeout(() => this.flush(cid), this.windowMs);
    if (b.timer.unref) b.timer.unref();
  }

  // Emit the accumulated run now (the timer also calls this). Safe for an unknown or flushed id.
  flush(cid) {
    const b = this.pending.get(cid);
    if (!b) return;
    this.pending.delete(cid);
    if (b.timer) clearTimeout(b.timer);
    if (!b.parts.length) return;
    this.onFlush({
      parts: b.parts,
      trigger: b.parts[b.parts.length - 1],
      forced: b.forced,
      count: b.parts.length,
      dropped: b.dropped,
    });
  }

  // Drop every pending run without flushing (connector shutdown).
  stop() {
    for (const b of this.pending.values()) { if (b.timer) clearTimeout(b.timer); }
    this.pending.clear();
  }
}

/**
 * Render a run of messages as the text of one turn.
 *
 * Single author: the lines joined in order, which is how the person meant it to read. More than one
 * author: each line attributed, because a run of messages from two people is not one person's
 * thought and collapsing it unattributed would put words in someone's mouth.
 *
 * @param {object[]} parts   messages, oldest first
 * @param {function} render  (message) => string, the per-message text the caller already builds
 *                           (cleanContent plus any reply reference)
 */
function burstText(parts, render) {
  const authors = new Set(parts.map((m) => (m.author && m.author.id) || null));
  const attribute = authors.size > 1;
  return parts
    .map((m) => {
      const body = render(m);
      if (!attribute) return body;
      const who = (m.author && m.author.username) || 'someone';
      return `${who}: ${body}`;
    })
    .filter((s) => s && s.trim())
    .join('\n');
}

module.exports = { BurstCoalescer, burstText };
