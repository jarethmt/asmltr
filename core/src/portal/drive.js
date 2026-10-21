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
const waiters = new Map();   // id -> [ wake fns ] — long-poll (held GET) subscribers, woken on pushExec

function pushExec(id, mode, dataB64) {
  if (!execQ.has(id)) execQ.set(id, []);
  execQ.get(id).push({ mode: mode === 'cdc' ? 'cdc' : 'hid', data: dataB64 || '', ts: Date.now() });
  const ws = waiters.get(id);           // wake one waiting long-poll so a backgrounded relay reacts instantly
  if (ws && ws.length) { const w = ws.shift(); try { w(); } catch (_) { /* */ } }
}
function nextExec(id) { const q = execQ.get(id); return (q && q.length) ? q.shift() : null; }

// Long-poll variant: resolve with the next command as soon as one is queued, or null after timeoutMs.
// Lets the native background relay hold ONE idle request open (battery-cheap) instead of tight polling.
function waitExec(id, timeoutMs) {
  const immediate = nextExec(id);
  if (immediate) return Promise.resolve(immediate);
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => {
      if (done) return; done = true;
      const arr = waiters.get(id); if (arr) { const i = arr.indexOf(wake); if (i >= 0) arr.splice(i, 1); }
      resolve(val);
    };
    const wake = () => finish(nextExec(id));
    if (!waiters.has(id)) waiters.set(id, []);
    waiters.get(id).push(wake);
    setTimeout(() => finish(null), Math.max(1000, timeoutMs | 0));
  });
}

function appendIo(id, dataB64) { if (!ioBuf.has(id)) ioBuf.set(id, []); if (dataB64) ioBuf.get(id).push(Buffer.from(dataB64, 'base64')); }
function drainIo(id) { const a = ioBuf.get(id) || []; ioBuf.set(id, []); return Buffer.concat(a).toString('base64'); }

function setPresent(id, p) { present.set(id, { paired: !!p.paired, present: p.present !== false, name: p.name || null, host_os: p.host_os || null, ts: Date.now() }); }
function getPresent(id) { return present.get(id) || { paired: false, present: false }; }

module.exports = { pushExec, nextExec, waitExec, appendIo, drainIo, setPresent, getPresent, recipes };
