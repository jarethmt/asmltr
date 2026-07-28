'use strict';
/**
 * settleDelivery — collapse an upstream fetch's HTTP ok + the parsed connector body into ONE
 * delivery result whose HTTP `status` can never disagree with its `ok`.
 *
 * The unified send/read plumbing hops core → manager → connector, and each hop used to derive the
 * HTTP status from the raw upstream `fetchOk` while letting the returned `ok` come from the merged
 * connector body. Those two are independent, so a response could carry `502` (fetch-level) with a
 * body of `{ ok: true, messageId }` (connector-level) at the same time. A caller that checks the
 * HTTP status then reports a false failure for a message that was actually delivered — Telegram
 * assigns a `messageId` only on a real send — and may double-send on a "retry."
 *
 * The connector's own `ok` is authoritative when present (it reflects whether the send happened);
 * fall back to the transport `fetchOk` only when the body carried no boolean `ok`. Status is then a
 * pure function of that resolved `ok`, so both signals always agree.
 */
function settleDelivery(fetchOk, body, extra = {}) {
  const j = body && typeof body === 'object' ? body : {};
  const ok = typeof j.ok === 'boolean' ? j.ok : !!fetchOk;
  // `ok` and `status` are written LAST so the merged body can never clobber them back into disagreement.
  return { ...extra, ...j, ok, status: ok ? 200 : 502 };
}

module.exports = { settleDelivery };
