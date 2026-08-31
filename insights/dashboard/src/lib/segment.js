// Merge grok/web SSE segment chunks into the in-flight turn reply.
// Segments may be growing prefixes (replace) or tail fragments (append).
// Do not trim. Space-only chunks after a period must survive ("time. " + "The").
// Do not invent a space after .!? — if grok omitted it, live stays honest
// ("time." + "The" → "time.The"). Same joinText as persist.
//
// Completed status/narration vs the real answer is a different seam. Discord
// treats a new completed block as replacing the prior pending one (last block
// is the answer). Web must do the same: do not glue two drafts into one bubble.
// "time."+"The" is token glue, not this — those pieces are too short to be blocks.
export function joinText(prev, next) {
  if (next == null || next === '') return prev || ''
  if (prev == null || prev === '') return next
  // Either side may already carry adjoining whitespace. Never invent a space.
  return prev + next
}

/** Finished narration/answer block, not a token piece like "The" or " I'll". */
export function isCompleteBlock(s) {
  const t = String(s || '').trim()
  if (t.length < 20) return false
  return t.split(/\s+/).filter(Boolean).length >= 4
}

// lastBlock: Grok-only. Growing snapshots still replace via startsWith on every engine
// (Claude deltas do not look like that). Two finished blocks replacing each other is
// Grok status→answer. Claude narrate→tool→answer must APPEND, not collapse.
export function applySegment(reply, t, opts = {}) {
  if (t == null || t === '') return reply || ''
  if (reply == null || reply === '') return t
  if (t.startsWith(reply)) return t
  if (opts.lastBlock && isCompleteBlock(reply) && isCompleteBlock(t)) return t
  return joinText(reply, t)
}

/**
 * onDone used to keep whichever string was longer. That undoes a live
 * replace when persist still has a glued draft+answer, and it also keeps
 * a longer live mash when persist already stored the last block only.
 * Last finished block wins. Token glue ("time."+"The") is unchanged.
 */
export function preferLastBlock(stored, live) {
  const s = stored == null ? '' : String(stored)
  const l = live == null ? '' : String(live)
  if (!s) return l
  if (!l) return s
  if (s === l) return s
  if (l.endsWith(s) && isCompleteBlock(s) && l.length > s.length) return s
  if (s.endsWith(l) && isCompleteBlock(l) && s.length > l.length) return l
  if (isCompleteBlock(s) && isCompleteBlock(l)) {
    if (s.includes(l) && s.length > l.length) return l
    if (l.includes(s) && l.length > s.length) return s
    return applySegment(l, s)
  }
  return s
}
