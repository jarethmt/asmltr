// asmltr Portal — the generic-driver relay (docs/PORTAL-DRIVE.md §2).
//
// A deliberately dead-simple HTTP relay that BOTH ends poll — no cross-process connector plumbing,
// since the driving asmltr instance and the phone app already speak to core over HTTP:
//   • the driver (Eve)  : POST /v2/portal/:id/exec   (queue a command)  +  GET …/io (drain the return)
//   • the phone app     : GET  /v2/portal/:id/exec/next (pop a command) +  POST …/io (post the host's bytes)
// The app is the BLE bridge to the dongle; it writes exec commands to the `exec` characteristic and
// streams the dongle's `ioback` notifications back here. `:id` is the Portal's device id (or BT addr).
const recipes = require('./recipes');

const execQ   = new Map();   // id -> [ { mode, data(base64), ts } ]
const ioBuf   = new Map();   // id -> [ Buffer ]
const present = new Map();   // id -> { paired, present, name, host_os, ts }

function pushExec(id, mode, dataB64) {
  if (!execQ.has(id)) execQ.set(id, []);
  execQ.get(id).push({ mode: mode === 'cdc' ? 'cdc' : 'hid', data: dataB64 || '', ts: Date.now() });
}
function nextExec(id) { const q = execQ.get(id); return (q && q.length) ? q.shift() : null; }

function appendIo(id, dataB64) { if (!ioBuf.has(id)) ioBuf.set(id, []); if (dataB64) ioBuf.get(id).push(Buffer.from(dataB64, 'base64')); }
function drainIo(id) { const a = ioBuf.get(id) || []; ioBuf.set(id, []); return Buffer.concat(a).toString('base64'); }

function setPresent(id, p) { present.set(id, { paired: !!p.paired, present: p.present !== false, name: p.name || null, host_os: p.host_os || null, ts: Date.now() }); }
function getPresent(id) { return present.get(id) || { paired: false, present: false }; }

module.exports = { pushExec, nextExec, appendIo, drainIo, setPresent, getPresent, recipes };
