// Shared SSE reader for webChat.send and voice.speak.
// Frames are `\n\n`-separated `data: {...}` lines. A final frame with no
// trailing blank line (common when the core closes the stream on `done`) is
// flushed after the reader reports done.

export function consumeSseBuffer(buf, dispatch, { flush = false } = {}) {
  let idx
  while ((idx = buf.indexOf('\n\n')) !== -1) {
    const raw = buf.slice(0, idx)
    buf = buf.slice(idx + 2)
    dispatchSseFrame(raw, dispatch)
  }
  if (flush && buf.includes('data:')) {
    dispatchSseFrame(buf, dispatch)
    buf = ''
  }
  return buf
}

function dispatchSseFrame(raw, dispatch) {
  const line = String(raw).split('\n').find((l) => l.startsWith('data:'))
  if (!line) return
  let f
  try { f = JSON.parse(line.slice(5).trim()) } catch { return }
  dispatch(f)
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
