// Merge grok/web SSE segment chunks into the in-flight turn reply.
// Segments may be growing prefixes (replace) or tail fragments (append).
// Do not trim. Space-only chunks after a period must survive ("time. " + "The").
// Grok often emits the next sentence with no leading space because the space was
// its own token (or never arrived). Insert one space when appending after .!? so
// live matches stored: "time." + "The" → "time. The", not "time.The".
//
// Completed status/narration vs the real answer is a different seam. Discord
// treats a new completed block as replacing the prior pending one (last block
// is the answer). Web must do the same: do not glue two drafts into one bubble.
// "time."+"The" is token glue, not this — those pieces are too short to be blocks.
export function joinText(prev, next) {
  if (next == null || next === '') return prev || ''
  if (prev == null || prev === '') return next
  if (/^\s/.test(next) || /\s$/.test(prev)) return prev + next
  if (/[.!?]["')\]]*$/.test(prev) && /^[A-Za-z0-9“"'(]/.test(next)) return prev + ' ' + next
  return prev + next
}

/** Finished narration/answer block, not a token piece like "The" or " I'll". */
export function isCompleteBlock(s) {
  const t = String(s || '').trim()
  if (t.length < 20) return false
  return t.split(/\s+/).filter(Boolean).length >= 4
}

export function applySegment(reply, t) {
  if (t == null || t === '') return reply || ''
  if (reply == null || reply === '') return t
  if (t.startsWith(reply)) return t
  if (isCompleteBlock(reply) && isCompleteBlock(t)) return t
  return joinText(reply, t)
}
