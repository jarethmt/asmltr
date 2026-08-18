// Shared SSE frame parser for webChat.send and voice.speak.
// Frames are `\n\n`-separated `data: {...}` lines. Leftover flush runs ONLY
// after the reader is actually finished, and ONLY parses a leftover that is a
// complete `data: {...}` JSON line. Partial leftovers are ignored. We never
// invent a `done` frame or stop reading early.

function normalizeSse(buf) {
  return String(buf).replace(/\r\n/g, '\n')
}

export function parseSseFrames(buf) {
  buf = normalizeSse(buf)
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
  const payload = line.slice(5).trim()
  // Require a complete JSON object — a partial first delta like
  // `data: {"type":"delta","text":"I'll` must NOT become a frame.
  if (!payload.startsWith('{') || !payload.endsWith('}')) return null
  try { return JSON.parse(payload) } catch { return null }
}

export function consumeSseBuffer(buf, dispatch, { flush = false } = {}) {
  const { frames, rest } = parseSseFrames(buf)
  for (const f of frames) dispatch(f)
  if (!flush) return rest
  // Reader finished. Parse leftover only if it is complete `data: {...}` line(s).
  const leftover = rest.trim()
  if (leftover) {
    for (const line of leftover.split('\n')) {
      if (!line.startsWith('data:')) continue
      const f = parseSseDataLine(line)
      if (f) dispatch(f)
    }
  }
  return ''
}

export async function readSseStream(reader, dispatch) {
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (value) {
      buf += dec.decode(value, { stream: !done })
      // Never leftover-flush mid-stream — even if this chunk has no `\n\n`.
      buf = consumeSseBuffer(buf, dispatch)
    }
    if (done) break
  }
  buf += dec.decode()
  consumeSseBuffer(buf, dispatch, { flush: true })
}
