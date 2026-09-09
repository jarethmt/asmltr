'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/**
 * The [[MOOD:x]] expression sentinel, as the core streams it.
 *
 * This guards the OUTPUT path for every channel, not just the one with a face. A session is reachable
 * from Discord, Telegram, email and GitHub, so a tag fragment escaping here becomes literal
 * "[[MOOD:happy]]" in someone's inbox, and gets read aloud by TTS. Two bugs found by these cases
 * before the change ever ran:
 *   · the head-cut was applied only while the tag was still "pending", so the final flush re-emitted
 *     the tag's tail (stream indices count VISIBLE characters, not raw ones);
 *   · the partial-match guard had no trailing \]?\]?, so a tag arriving one character at a time died
 *     on its own closing brackets and streamed out as plain text.
 *
 * The logic under test is mirrored from core/src/server.js. `sourceMatches` below fails loudly if the
 * two drift apart, so this can't quietly rot into testing a stale copy.
 */

const MOOD_RE = /^\s*\[\[MOOD:([a-z]+)\]\]\s*/i;
const MOOD_PARTIAL = /^\s*\[\[?M?O?O?D?:?[A-Za-z]*\]?\]?$/;

/** Mirrors _pushDelta + _flushStream. Returns the mood and the text a connector actually receives. */
function stream(chunks, { mustRedact = false } = {}) {
  let raw = '', emitted = 0, pending = true, cut = 0, mood = null, out = '';
  const visible = () => {
    if (pending) {
      const m = raw.match(MOOD_RE);
      if (m) { pending = false; cut = m[0].length; mood = m[1].toLowerCase(); }
      else if (raw.length < 24 && MOOD_PARTIAL.test(raw)) return null;
      else pending = false;
    }
    return cut ? raw.slice(cut) : raw;
  };
  const push = (chunk) => {
    raw += chunk;
    const vis = visible();
    if (vis === null) return;
    let end = vis.length;
    if (mustRedact) { const b = Math.max(vis.lastIndexOf(' '), vis.lastIndexOf('\n')); end = b >= 0 ? b + 1 : emitted; }
    if (end > emitted) { out += vis.slice(emitted, end); emitted = end; }
  };
  for (const c of chunks) push(c);
  const vis = visible() ?? raw;                 // a held partial that never completed is just text
  if (vis.length > emitted) out += vis.slice(emitted);
  return { mood, out };
}

test('extracts the mood and strips the tag, however the deltas split', () => {
  assert.deepStrictEqual(stream(['[[MOOD:happy]]Hello there']), { mood: 'happy', out: 'Hello there' });
  assert.deepStrictEqual(stream('[[MOOD:curious]]Hi'.split('')), { mood: 'curious', out: 'Hi' });
  assert.deepStrictEqual(stream(['[[MO', 'OD:conc', 'erned]]Bad', ' news']), { mood: 'concerned', out: 'Bad news' });
  assert.deepStrictEqual(stream(['[[MOOD:sleepy]]\n\nzzz']), { mood: 'sleepy', out: 'zzz' });
  assert.deepStrictEqual(stream(['[[mood:HAPPY]]yo']), { mood: 'happy', out: 'yo' });
});

test('the tag never survives into the emitted text', () => {
  for (const chunks of [['[[MOOD:happy]]Hello there'], '[[MOOD:happy]]Hello'.split(''), ['[[MOOD:angry]]', 'x']]) {
    const { out } = stream(chunks);
    assert.ok(!/\[\[MOOD/i.test(out), `tag leaked into: ${JSON.stringify(out)}`);
    assert.ok(!out.includes(']]'), `tag fragment leaked into: ${JSON.stringify(out)}`);
  }
});

test('ordinary replies are untouched — nothing lost, nothing held forever', () => {
  const cases = [
    ['Hello ', 'world'],                 // plain prose
    ['[see docs](https://x)'],           // markdown link — starts with a bracket
    ['[[NO_REPLY]]'],                    // the other sentinel must pass through intact
    ['[x] done'],                        // checkbox
    ['[[1,2],[3,4]]'],                   // nested array in code
    ['[[MOODY blues and a longer sentence]]'],
    ['Sure. [[MOOD:happy]] ok'],         // a tag NOT at the start is content, not a sentinel
    [''],
  ];
  for (const chunks of cases) {
    const { mood, out } = stream(chunks);
    assert.strictEqual(mood, null, `spurious mood from ${JSON.stringify(chunks)}`);
    assert.strictEqual(out, chunks.join(''), `text altered: ${JSON.stringify(chunks)}`);
  }
});

test('holds correctly on the redacting path too (non-full-trust recipients)', () => {
  assert.deepStrictEqual(stream(['[[MOOD:happy]]Hello there '], { mustRedact: true }),
    { mood: 'happy', out: 'Hello there ' });
});

test('the regexes here still match the ones in core/src/server.js', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'src', 'server.js'), 'utf8');
  assert.ok(src.includes(String(MOOD_RE)), 'MOOD_RE drifted from the core');
  assert.ok(src.includes(String(MOOD_PARTIAL)), 'MOOD_PARTIAL drifted from the core');
});
