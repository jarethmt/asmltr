// Shared SSE frame parser for webChat.send and voice.speak.
// Frames are `\n\n`-separated `data: {...}` lines. A final frame with no
// trailing blank line (common when the core closes the stream on `done`) is
// flushed after the reader reports done.

export function parseSseFrames(buf) {
  const frames = []
  let idx
  while ((idx = buf.indexOf('\n\n')) !== -1) {
    const raw = buf.slice(0, idx)
    buf = buf.slice(idx + 2)
    const f = parseSseDataLine(raw)
    if (f) frames.push(f)
  }
  return { frames, rest: buf }
}

function parseSseDataLine(raw) {
  const line = String(raw).split('\n').find((l) => l.startsWith('data:'))
  if (!line) return null
  try { return JSON.parse(line.slice(5).trim()) } catch { return null }
}

export function consumeSseBuffer(buf, dispatch, { flush = false } = {}) {
  const { frames, rest } = parseSseFrames(buf)
  for (const f of frames) dispatch(f)
  if (flush && rest.includes('data:')) {
    const f = parseSseDataLine(rest)
    if (f) dispatch(f)
    return ''
  }
  return rest
}

export async function readSseStream(reader, dispatch) {
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    buf = consumeSseBuffer(buf, dispatch)
  }
  buf += dec.decode()
  consumeSseBuffer(buf, dispatch, { flush: true })
}
