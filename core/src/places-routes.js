'use strict';
/**
 * HTTP for the places directory (core/src/places.js).
 *
 * Mounted rather than written inline in server.js for the same reason upload-routes.js is: requiring
 * server.js under `node --test` never exits, so routes that live only in that file cannot be tested.
 *
 *   GET    /v2/places                        ?surface= &kind= &role= &q=   → { places, roles, count }
 *   GET    /v2/places/resolve                ?ref= &surface=              → { ok, place, matched_on }
 *   GET    /v2/places/:surface/:scope_id                                   → one place, or 404
 *   POST   /v2/places                        { surface, scope_id, name, … } upsert
 *   POST   /v2/places/label                  { surface, scope_id, label, kind, note }
 *   DELETE /v2/places/:surface/label/:label
 *   DELETE /v2/places/:surface/:scope_id
 *   POST   /v2/places/refresh               { instance_id?, surface? }  ask connectors what they see
 *   POST   /v2/places/import                { file?, surface? }         read channel-aliases.json
 *
 * Reads are open, like /v2/drafts: a name directory is not an authority. Writes emit a `control`
 * event so the stream says which session labelled a place, which is the audit trail standing in for
 * a permission model while cross-channel data access is still ungated (#132).
 */

/**
 * @param {object} app      an express app
 * @param {object} [deps]   { record } telemetry sink; { places } to inject a store (tests)
 */
function mountPlaceRoutes(app, deps = {}) {
  const places = deps.places || require('./places');
  const feed = deps.feed || require('./places-feed');
  const record = typeof deps.record === 'function' ? deps.record : () => {};
  const CODES = { BAD_REQUEST: 400, NOT_FOUND: 404, AMBIGUOUS: 409 };

  // --- PLACES (directory of guilds/channels/chats; see core/src/places.js) -----
  // Read is open like /v2/drafts: this is a name directory, not an authority. Writes carry a `by` so
  // the audit event says which session labelled a place.
  app.get('/v2/places', (req, res) => {
    const q = req.query || {};
    res.json({
      places: places.list({ surface: q.surface, kind: q.kind, role: q.role, q: q.q }),
      roles: places.roles(),
      count: places.count(),
    });
  });
  app.get('/v2/places/resolve', (req, res) => {
    // GET with the reference in the query, so an agent can resolve without a body. Ambiguity is a 409
    // carrying the candidates: the caller has to choose, and it needs the list to choose from.
    try {
      const r = places.resolve(req.query.ref, req.query.surface || null);
      res.json({ ok: true, ...r });
    } catch (e) {
      const code = CODES[e.code] || 500;
      res.status(code).json({ ok: false, error: e.message, code: e.code || null, candidates: e.candidates || undefined });
    }
  });
  // POST, not GET: both reach out to connectors and write. Placed before the /:surface/:scope_id
  // routes so "refresh" and "import" can never be read as a surface name.
  app.post('/v2/places/refresh', async (req, res) => {
    const b = req.body || {};
    const r = await feed.refresh(places, { instance_id: b.instance_id, surface: b.surface });
    record({ surface: 'core', session_id: null, event_type: 'control', identity: String(b.by || 'operator'), source: 'core',
      payload: { action: 'place-refresh', guilds: r.guilds, channels: r.channels, instances: (r.instances || []).length } });
    // A refresh that reached nothing is still a 200 carrying ok:false: the caller asked a question
    // and got a complete answer, which is "no connector had anything to say".
    res.json(r);
  });
  app.post('/v2/places/import', (req, res) => {
    const b = req.body || {};
    // No `file` from the request. The path is server-side config only (ASMLTR_DISCORD_ALIASES_FILE),
    // because accepting one here is an arbitrary file read: the core runs as the user, so any caller
    // that can reach this port could name ~/.ssh/id_ed25519 or a vault token file. It does not even
    // need the file to parse, since JSON.parse echoes the first ~10 bytes of whatever it was given
    // ("Unexpected token 's', \"ssh-ed2551\"... is not valid JSON"), which makes the error message a
    // read oracle one request at a time. Flagged by the security review; verified by running it.
    const r = feed.importAliasFile(places, { surface: b.surface });
    record({ surface: 'core', session_id: null, event_type: 'control', identity: String(b.by || 'operator'), source: 'core',
      payload: { action: 'place-import', file: r.file, aliases: r.aliases, channels: r.channels } });
    res.json(r);
  });

  app.get('/v2/places/:surface/:scope_id', (req, res) => {
    const p = places.get(req.params.surface, req.params.scope_id);
    return p ? res.json(p) : res.status(404).json({ error: 'unknown place' });
  });
  app.post('/v2/places', (req, res) => {
    try {
      const p = places.upsert(req.body || {});
      record({ surface: 'core', session_id: null, event_type: 'control', identity: String((req.body || {}).by || 'operator'), source: 'core',
        payload: { action: 'place-upsert', surface: p.surface, scope_id: p.scope_id, name: p.name || null } });
      res.json({ ok: true, place: p });
    } catch (e) { res.status(e.code === 'BAD_REQUEST' ? 400 : 500).json({ ok: false, error: e.message, code: e.code || null }); }
  });
  app.post('/v2/places/label', (req, res) => {
    const b = req.body || {};
    try {
      const p = places.setLabel({ ...b, set_by: b.by || null });
      record({ surface: 'core', session_id: null, event_type: 'control', identity: String(b.by || 'operator'), source: 'core',
        payload: { action: 'place-label', surface: p.surface, scope_id: p.scope_id, label: String(b.label || '').toLowerCase(), kind: b.kind === 'role' ? 'role' : 'alias' } });
      res.json({ ok: true, place: p });
    } catch (e) { res.status(e.code === 'BAD_REQUEST' ? 400 : 500).json({ ok: false, error: e.message, code: e.code || null }); }
  });
  app.delete('/v2/places/:surface/label/:label', (req, res) => {
    const gone = places.unsetLabel(req.params.surface, req.params.label);
    if (gone) {
      record({ surface: 'core', session_id: null, event_type: 'control', identity: 'operator', source: 'core',
        payload: { action: 'place-unlabel', surface: req.params.surface, label: String(req.params.label).toLowerCase() } });
    }
    return gone ? res.json({ ok: true, removed: req.params.label }) : res.status(404).json({ error: 'unknown label' });
  });
  app.delete('/v2/places/:surface/:scope_id', (req, res) => {
    const gone = places.remove(req.params.surface, req.params.scope_id);
    return gone ? res.json({ ok: true }) : res.status(404).json({ error: 'unknown place' });
  });
}

module.exports = { mountPlaceRoutes };
