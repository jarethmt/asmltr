// Merge grok/web SSE segment chunks into the in-flight turn reply.
// Segments may be growing prefixes (replace) or tail fragments (append).
// Do not trim. Space-only chunks after a period must survive ("time. " + "The").
// Grok often emits the next sentence with no leading space because the space was
// its own token (or never arrived). Insert one space when appending after .!? so
// live matches stored: "time." + "The" → "time. The", not "time.The".
export function joinText(prev, next) {
  if (next == null || next === '') return prev || ''
  if (prev == null || prev === '') return next
  if (/^\s/.test(next) || /\s$/.test(prev)) return prev + next
  if (/[.!?]["')\]]*$/.test(prev) && /^[A-Za-z0-9“"'(]/.test(next)) return prev + ' ' + next
  return prev + next
}

export function applySegment(reply, t) {
  if (t == null || t === '') return reply || ''
  if (reply == null || reply === '') return t
  if (t.startsWith(reply)) return t
  return joinText(reply, t)
}
