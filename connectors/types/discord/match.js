'use strict';
/**
 * Fuzzy, order-insensitive matching for channel and guild lookup.
 *
 * The first cut of the read ops matched names by substring for `-q` and by exact equality for
 * resolving a target, which meant `history "shop floor"` failed against `#shop-floor`, word order
 * mattered, a typo missed, and an emoji prefix on a channel name defeated both. Nobody types a
 * channel name the way Discord stores it.
 *
 * What this is: lexical scoring over a name, its guild-qualified form, and its topic. Exact beats
 * prefix, prefix beats "all my words appear somewhere", that beats a subsequence, and edit distance
 * catches the rest. Scoring the topic as well is what makes "where do we talk about the plating
 * tank" land on a channel whose name says none of that.
 *
 * What this is not: embeddings. "printer jam" will not find `#bigpam-z` unless one of those words
 * appears in its name or topic. If real semantic recall is wanted, that is a model and a cache and
 * it belongs behind this interface, not in place of it.
 */

/**
 * Discord names carry separators and decoration that a human never types: `🔧shop-floor`,
 * `team_notes`, `ops.alerts`. Fold all of it to lowercase words so comparison happens on the part
 * someone actually said.
 */
function normalize(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{20E3}]/gu, ' ') // emoji + variation selectors
    .replace(/^[^a-z0-9]+/, '')            // a leading #, ・, | and friends
    .replace(/[-_./|·:,]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const tokens = (s) => normalize(s).split(' ').filter(Boolean);

/** Levenshtein, two rows. Inputs here are channel names, so the quadratic cost is irrelevant. */
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** Do the characters of `q` appear in `hay` in order? Catches "shpflr" for "shop floor". */
function isSubsequence(q, hay) {
  if (!q.length) return false;
  let i = 0;
  for (let j = 0; j < hay.length && i < q.length; j++) if (hay[j] === q[i]) i++;
  return i === q.length;
}

/**
 * How well does one string answer the query, 0 to 1. The tiers are ordered so a better kind of match
 * always outranks a worse one regardless of length, which is what keeps `#shop` from beating
 * `#shop-floor` for the query "shop floor".
 */
function scoreString(query, candidate) {
  const q = normalize(query);
  const c = normalize(candidate);
  if (!q || !c) return 0;
  if (q === c) return 1;
  if (c.startsWith(q)) return 0.92;
  if (c.endsWith(q)) return 0.88;

  const qt = q.split(' ').filter(Boolean);
  const ct = c.split(' ').filter(Boolean);
  if (qt.length > 1) {
    // Every word I typed is in there somewhere, order be damned: "floor shop" finds "shop-floor".
    const every = qt.every((t) => ct.some((x) => x === t || x.startsWith(t)));
    if (every) return 0.85;
  }
  if (c.includes(q)) return 0.8;

  // One typed word matching one whole word is worth more than a loose substring: "shop" in
  // "shop-floor" should beat "hop" in "workshop-photos".
  const wordHit = qt.filter((t) => ct.some((x) => x === t)).length;
  if (wordHit) return 0.6 + 0.15 * (wordHit / qt.length);

  const qc = q.replace(/ /g, '');
  const cc = c.replace(/ /g, '');
  if (cc.includes(qc)) return 0.7;
  if (isSubsequence(qc, cc)) return 0.55;

  // Typos, scored against the closer of the whole string and its best single word so a short query
  // is not punished for a long candidate.
  const whole = 1 - editDistance(qc, cc) / Math.max(qc.length, cc.length);
  const best = ct.reduce((m, x) => Math.max(m, 1 - editDistance(qc, x) / Math.max(qc.length, x.length)), 0);
  const d = Math.max(whole, best);
  return d >= 0.7 ? 0.35 + (d - 0.7) * 0.5 : 0;   // below 0.7 similarity it is not the same word
}

/**
 * Score a channel. The name carries the query; guild#name lets someone disambiguate in one string;
 * the topic is scored at a discount so a topic hit surfaces the channel without ever outranking a
 * channel whose name actually says it.
 */
function scoreChannel(query, ch, guild) {
  const name = ch.name || (ch.recipient && ch.recipient.username) || '';
  const nameScore = scoreString(query, name);
  // guild#name is a DISAMBIGUATOR ("Shop#general" against "Radiator#general"), not a way to select a
  // whole server. It only counts when the query has more than one word AND the channel name itself
  // carries part of it. Without both guards, a guild called Shop made every channel in it score 0.90
  // for the query "shop", which buried the channel actually called shop-floor.
  const qMulti = tokens(query).length > 1;
  const guildForm = guild && qMulti && nameScore > 0 ? scoreString(query, `${guild.name} ${name}`) * 0.98 : 0;
  const parts = [
    { on: 'name', score: nameScore },
    { on: 'guild#name', score: guildForm },
    { on: 'topic', score: ch.topic ? scoreString(query, ch.topic) * 0.6 : 0 },
  ];
  parts.sort((a, b) => b.score - a.score);
  return { score: parts[0].score, matched_on: parts[0].score > 0 ? parts[0].on : null };
}

function scoreGuild(query, g) {
  return { score: scoreString(query, g.name || ''), matched_on: 'name' };
}

/** Anything below this is noise, not a weak match. */
const THRESHOLD = 0.45;

/**
 * Pick one winner from scored candidates, or refuse. A winner has to be both over the bar and
 * clearly ahead of the runner-up; a near tie is the caller's to break, because silently choosing
 * between two plausible channels reads the wrong room.
 */
function pickBest(scored, { threshold = THRESHOLD, margin = 0.1 } = {}) {
  const ranked = [...scored].filter((s) => s.score >= threshold).sort((a, b) => b.score - a.score);
  if (!ranked.length) return { best: null, ranked: [], reason: 'none' };
  if (ranked.length === 1) return { best: ranked[0], ranked, reason: 'only' };
  if (ranked[0].score === 1 && ranked[1].score < 1) return { best: ranked[0], ranked, reason: 'exact' };
  if (ranked[0].score - ranked[1].score >= margin) return { best: ranked[0], ranked, reason: 'margin' };
  return { best: null, ranked, reason: 'tie' };
}

module.exports = { normalize, tokens, editDistance, isSubsequence, scoreString, scoreChannel, scoreGuild, pickBest, THRESHOLD };
