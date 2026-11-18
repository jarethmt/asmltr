// asmltr Portal — dedicated drive-only listener (docs/portal/drive.md §2, phone-bypass transport).
//
// A minimal, token-gated HTTP surface exposing ONLY the two endpoints the mesh drive agent polls:
//   GET  /v2/portal/:id/exec/next   (long-poll)
//   POST /v2/portal/:id/io
// It shares the core's in-process `portalDrive` state — the SAME exec queue the driver (Eve) pushes
// to on the main core port — so a command pushed on :3023 is consumed by the dongle polling here.
// Bound to 127.0.0.1; a Pangolin newt resource forwards the overlay → this port, granted only to the
// dongle client. The rest of the core API stays entirely off the mesh, and every request needs the
// Bearer the dongle carries in NVS. This is the phone-free rail of the dual-transport drive stack.
const express = require('express');

function startDriveListener(portalDrive, { port, token, host = '127.0.0.1', log = console } = {}) {
  if (!token) { console.warn('[portal-drive] ASMLTR_PORTAL_DRIVE_TOKEN unset — drive listener NOT started'); return null; }

  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // Bearer gate — length-checked equality (avoids an early-exit timing oracle on the common-prefix case).
  app.use((req, res, next) => {
    const m = (req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    const given = m ? m[1] : '';
    let ok = given.length === token.length;
    for (let i = 0; i < token.length; i++) ok = ok && given[i] === token[i];
    if (!ok) return res.status(401).json({ error: 'unauthorized' });
    next();
  });

  app.get('/v2/portal/:id/exec/next', async (req, res) => {
    const wait = Math.min(parseInt(req.query.wait || '0', 10) || 0, 30);
    if (wait > 0) return res.json((await portalDrive.waitExec(req.params.id, wait * 1000)) || {});
    res.json(portalDrive.nextExec(req.params.id) || {});
  });
  app.post('/v2/portal/:id/io', (req, res) => {
    portalDrive.appendIo(req.params.id, (req.body || {}).data);
    res.json({ ok: true });
  });

  const server = app.listen(port, host, () =>
    (log.log || console.log)(`[portal-drive] drive-only listener on http://${host}:${port} (mesh-exposed, Bearer-gated)`));
  server.requestTimeout = 0; server.headersTimeout = 0; server.timeout = 0;   // long-poll holds open
  return server;
}

module.exports = { startDriveListener };
