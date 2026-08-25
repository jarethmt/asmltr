'use strict';
/**
 * Raw bytes on routes that historically carried a file as base64 inside a JSON body.
 *
 * Why: `app.use(express.json({ limit: '10mb' }))` bounds every JSON body on the core, and base64
 * spends 4 bytes per 3 of file, so a route that takes `data_base64` caps at roughly 7.5 MiB of
 * actual file no matter what the proxy in front allows. Measured against that parser: a 7,864,000
 * byte file is accepted and a 7,900,000 byte file is not. Raising the JSON limit is the wrong fix,
 * because the base64 shape also means the browser holds the file as a string while the body holds a
 * second copy of it, and the server holds a third when it decodes.
 *
 * The shape here is the one `/v2/recordings` and `/v2/backups/import` already use: the body IS the
 * file, and the metadata that used to sit beside it in the JSON object moves to the query string.
 * The JSON form keeps working, so no existing client breaks.
 */
const express = require('express');

/** Ceiling for a raw body. Matches the two routes that already accept raw bytes. */
function rawLimit() { return process.env.ASMLTR_RAW_BODY_LIMIT || '1024mb'; }

const isJson = (req) => /^application\/json\b/i.test(req.headers['content-type'] || '');

/**
 * Route middleware. Claims every body express.json did not, so `req.body` is a Buffer for a raw
 * request and the parsed object for a JSON one. Registered per route rather than app-wide: a
 * blanket raw parser would buffer bodies for routes that never wanted them.
 *
 * A body over the limit is answered as JSON naming the limit. The default express error handler
 * sends an HTML stack trace, and #91 was hard to diagnose precisely because the failure never named
 * a size anywhere the client could see it.
 */
function rawBody() {
  const mw = express.raw({ type: (req) => !isJson(req), limit: rawLimit() });
  return (req, res, next) => mw(req, res, (err) => {
    if (!err) return next();
    if (err.type === 'entity.too.large') {
      return res.status(413).json({
        error: `body is larger than ${rawLimit()} (raise ASMLTR_RAW_BODY_LIMIT). A reverse proxy in front can impose a lower limit of its own.`,
      });
    }
    return next(err);
  });
}

/**
 * The bytes a request carries, whichever shape it used.
 *
 * raw  → `req.body` is a Buffer and the metadata is in the query string.
 * JSON → the metadata is the body, and the file (if any) is base64 under `base64Field`.
 *
 * `buffer` is null when the request carried no file at all, which the JSON form allows: a silo write
 * can send `content` as text instead. Callers decide whether that is an error.
 */
function fileFrom(req, base64Field) {
  if (Buffer.isBuffer(req.body)) return { buffer: req.body, meta: req.query || {}, shape: 'raw' };
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const b64 = body[base64Field];
  if (typeof b64 !== 'string' || !b64) return { buffer: null, meta: body, shape: 'json' };
  return { buffer: Buffer.from(b64, 'base64'), meta: body, shape: 'json' };
}

module.exports = { rawBody, fileFrom, rawLimit };
