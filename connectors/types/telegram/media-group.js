'use strict';

// Telegram sends an album as separate updates that share a media_group_id, one per photo. Dispatching
// a vision turn per update pins a small box: 24 photos became 24 concurrent turns on 2026-08-18 and
// thrashed a 4GB host. This coalescer buffers the updates of one group and flushes a SINGLE dispatch
// once the group has been quiet for windowMs, so the album runs as one turn. Images past maxImages are
// left out of the vision payload (the connector still saves every file, so the model can read the rest
// from their paths).
class MediaGroupCoalescer {
  // onFlush({ route, attachments, savedNotes, caption, dropped, count }) fires once per group, after the
  // quiet window. windowMs is the debounce; each new part in the group resets it.
  constructor({ windowMs = 1500, maxImages = 10, onFlush }) {
    if (typeof onFlush !== 'function') throw new TypeError('onFlush must be a function');
    this.windowMs = windowMs;
    this.maxImages = maxImages;
    this.onFlush = onFlush;
    this.groups = new Map(); // media_group_id -> accumulator
  }

  // part: { attachments: [], savedNotes: [], caption: '', route: { chatId, userId, from, message_id } }.
  // The first part's route wins (album items carry the same chat/user; the caption rides one of them).
  add(groupId, part) {
    let g = this.groups.get(groupId);
    if (!g) {
      g = { attachments: [], savedNotes: [], captions: [], route: part.route, dropped: 0, count: 0, timer: null };
      this.groups.set(groupId, g);
    }
    g.count += 1;
    for (const a of part.attachments || []) {
      if (g.attachments.length < this.maxImages) g.attachments.push(a);
      else g.dropped += 1;
    }
    for (const n of part.savedNotes || []) g.savedNotes.push(n);
    if (part.caption && part.caption.trim()) g.captions.push(part.caption.trim());

    if (g.timer) clearTimeout(g.timer);
    g.timer = setTimeout(() => this.flush(groupId), this.windowMs);
    if (g.timer.unref) g.timer.unref();
  }

  // Emit the accumulated group now (the timer also calls this). Safe to call for an unknown/flushed id.
  flush(groupId) {
    const g = this.groups.get(groupId);
    if (!g) return;
    this.groups.delete(groupId);
    if (g.timer) clearTimeout(g.timer);
    this.onFlush({
      route: g.route,
      attachments: g.attachments,
      savedNotes: g.savedNotes,
      caption: g.captions[0] || '',
      dropped: g.dropped,
      count: g.count,
    });
  }

  // Drop every pending group without flushing (connector shutdown).
  stop() {
    for (const g of this.groups.values()) { if (g.timer) clearTimeout(g.timer); }
    this.groups.clear();
  }
}

module.exports = { MediaGroupCoalescer };
