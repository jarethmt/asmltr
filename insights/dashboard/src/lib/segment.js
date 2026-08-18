// Merge grok/web SSE segment chunks into the in-flight turn reply.
// Segments may be growing prefixes (replace) or tail fragments (append).
export function applySegment(reply, t) {
  if (!t) return reply || ''
  if (!reply) return t
  if (t.startsWith(reply)) return t
  return reply + t
}
