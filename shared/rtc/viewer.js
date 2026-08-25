/**
 * asmltr remote-desktop VIEWER — the one implementation, shared by every surface.
 *
 * This logic previously existed only inside the mobile app's page, which is why the web console had
 * no way to see a machine at all. It is deliberately DOM-free: it owns signaling, ICE, the peer
 * connection and the control channel, and hands the caller a MediaStream plus status callbacks. The
 * caller owns all rendering — a <video> in a Vue panel, a full-screen page on a phone, anything.
 *
 * The viewer is always the ANSWERER: the host makes the offer once the broker relays `connect`.
 *
 * Usage:
 *   const v = createViewer({ brokerUrl, token, clientId })
 *   v.on('stream', (mediaStream) => { videoEl.srcObject = mediaStream })
 *   v.on('status', (text, level) => ...)          // level: 'on' | 'warn' | 'off'
 *   await v.list()                                 // hosts this credential may view
 *   await v.connect(hostId, { control: true })
 *   v.sendInput({ t: 'move', x: 0.5, y: 0.5 })     // no-op unless the session carries control
 *   v.disconnect()
 *
 * ES module — imported by the dashboard's bundler and loaded directly by the mobile page as
 * <script type="module">. Deliberately NOT UMD: a bundler cannot statically resolve named exports
 * out of a UMD wrapper, and silently falling back to a copy per surface is the exact drift this
 * module exists to prevent.
 */
export function createViewer(opts) {
  const cfg = {
    brokerUrl: String(opts.brokerUrl || '').replace(/\/+$/, ''),
    token: opts.token || '',
    clientId: opts.clientId || ('viewer-' + Math.random().toString(36).slice(2, 10)),
  };

  const handlers = {};                 // event -> fn
  const emit = (ev, ...a) => { const f = handlers[ev]; if (f) { try { f(...a); } catch (_) {} } };
  const status = (text, level) => emit('status', text, level || 'warn');

  // Every async step re-checks its generation and bails if a teardown happened meanwhile. Without
  // this, a slow SDP exchange from an abandoned session can resurrect itself over a newer one.
  let gen = 0;
  let sess = null;                     // { id, control, pc, es, hostId }
  let pendingIce = [];                 // remote candidates that arrived before the remote SDP
  let readyResolve = null;

  async function rdMsg(body) {
    const res = await fetch(cfg.brokerUrl + '/rd/msg', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ token: cfg.token, ...body }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) throw new Error(json.error || `broker ${res.status}`);
    return json;
  }

  async function fetchIce() {
    try {
      const r = await fetch(cfg.brokerUrl + '/rd/ice-config?token=' + encodeURIComponent(cfg.token));
      const j = await r.json();
      return (j && j.iceServers) || [{ urls: ['stun:stun.l.google.com:19302'] }];
    } catch (_) { return [{ urls: ['stun:stun.l.google.com:19302'] }]; }
  }

  function openStream(myGen) {
    const url = cfg.brokerUrl + '/rd/stream?token=' + encodeURIComponent(cfg.token)
      + '&role=viewer&client_id=' + encodeURIComponent(cfg.clientId);
    const es = new EventSource(url);
    es.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch (_) { return; } onSignal(m, myGen); };
    es.onerror = () => { if (myGen === gen && sess) status('signaling dropped — reconnecting…', 'warn'); };
    return es;
  }

  function waitReady() {
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => { readyResolve = null; reject(new Error('broker stream timeout')); }, 10000);
      readyResolve = () => { clearTimeout(to); readyResolve = null; resolve(); };
    });
  }

  async function onSignal(m, myGen) {
    if (myGen !== gen) return;
    const t = String(m.type || '');
    if (t === 'ready') { if (readyResolve) readyResolve(); return; }
    if (!sess || m.session_id !== sess.id) return;
    if (t === 'sdp') return onRemoteSdp(m.sdp, myGen);
    if (t === 'ice') return onRemoteIce(m.candidate, myGen);
    if (t === 'bye') {
      status(m.reason === 'revoked' ? 'access revoked' : m.reason === 'killed' ? 'session ended by an operator' : 'host ended the session', 'off');
      emit('ended', m.reason || 'closed');
      return disconnect();
    }
  }

  async function onRemoteSdp(desc, myGen) {
    if (!sess || !desc) return;
    try {
      const offer = (desc && desc.type && desc.sdp) ? desc : { type: 'offer', sdp: desc };
      await sess.pc.setRemoteDescription(offer);
      if (myGen !== gen) return;
      for (const c of pendingIce) { try { await sess.pc.addIceCandidate(c); } catch (_) {} }
      pendingIce = [];
      const answer = await sess.pc.createAnswer();
      if (myGen !== gen) return;
      await sess.pc.setLocalDescription(answer);
      if (myGen !== gen) return;
      // role is REQUIRED: a host and the owner's own devices can share one trust identity, so the
      // broker cannot infer relay direction from the credential. We must declare we are the viewer.
      await rdMsg({ type: 'sdp', session_id: sess.id, role: 'viewer', sdp: { type: answer.type, sdp: answer.sdp } });
    } catch (e) { if (myGen === gen) status('sdp error: ' + e.message, 'warn'); }
  }

  async function onRemoteIce(cand, myGen) {
    if (!sess || !cand) return;
    if (!sess.pc.remoteDescription || !sess.pc.remoteDescription.type) { pendingIce.push(cand); return; }
    try { await sess.pc.addIceCandidate(cand); } catch (_) { if (myGen !== gen) return; }
  }

  function wirePeer(pc, sessionId, myGen) {
    pc.onicecandidate = (e) => {
      if (e.candidate && myGen === gen) {
        rdMsg({ type: 'ice', session_id: sessionId, role: 'viewer', candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate }).catch(() => {});
      }
    };
    pc.ontrack = (e) => {
      if (myGen !== gen) return;
      const stream = (e.streams && e.streams[0]) || new MediaStream([e.track]);
      emit('stream', stream);
      status('connected', 'on');
    };
    pc.onconnectionstatechange = () => {
      if (myGen !== gen) return;
      const st = pc.connectionState;
      emit('state', st);
      if (st === 'failed') status('connection failed (no route between peers)', 'off');
      else if (st === 'disconnected') status('connection lost', 'warn');
    };
    // The HOST opens the control channel, so we listen rather than create — creating one here
    // races the host's and leaves input on a channel nobody reads.
    pc.ondatachannel = (e) => {
      if (myGen !== gen || !e.channel || e.channel.label !== 'control') return;
      sess.dc = e.channel;
      e.channel.onopen = () => emit('control', true);
      e.channel.onclose = () => emit('control', false);
    };
  }

  /** Hosts this credential may view. The broker filters by grant, so an unauthorized machine is
   *  absent entirely rather than merely un-connectable. */
  async function list() { return (await rdMsg({ type: 'list' })).hosts || []; }

  async function connect(hostId, { control = false } = {}) {
    disconnect();
    const myGen = ++gen;
    pendingIce = [];
    status('connecting…', 'warn');
    let es;
    try {
      es = openStream(myGen);
      await waitReady();
      if (myGen !== gen) { try { es.close(); } catch (_) {} return null; }
      const iceServers = await fetchIce();
      if (myGen !== gen) { try { es.close(); } catch (_) {} return null; }
      const r = await rdMsg({ type: 'connect', host_id: hostId, want: { control: !!control }, client_id: cfg.clientId });
      if (myGen !== gen) { try { es.close(); } catch (_) {} return null; }
      const pc = new RTCPeerConnection({ iceServers });
      sess = { id: r.session_id, control: !!r.control, pc, es, hostId, dc: null };
      wirePeer(pc, r.session_id, myGen);
      if (control && !r.control) status('connected (view-only — no control grant)', 'on');
      emit('session', { id: r.session_id, control: !!r.control, hostId });
      return sess;                      // the host now offers; onRemoteSdp answers
    } catch (e) {
      try { if (es) es.close(); } catch (_) {}
      if (myGen === gen) { status('✗ ' + e.message, 'off'); disconnect(); }
      throw e;
    }
  }

  function disconnect(notifyBroker = true) {
    gen++;                              // invalidate every in-flight async step
    const s = sess; sess = null; pendingIce = [];
    if (!s) return;
    if (notifyBroker && s.id) rdMsg({ type: 'bye', session_id: s.id }).catch(() => {});
    try { if (s.dc) s.dc.close(); } catch (_) {}
    try { s.pc.close(); } catch (_) {}
    try { s.es.close(); } catch (_) {}
    emit('control', false);
  }

  /** Send an input event. Silently a no-op without a control grant — the host re-checks anyway. */
  function sendInput(evt) {
    if (!sess || !sess.dc || sess.dc.readyState !== 'open') return false;
    try { sess.dc.send(JSON.stringify(evt)); return true; } catch (_) { return false; }
  }

  return {
    on(ev, fn) { handlers[ev] = fn; return this; },
    list, connect, disconnect, sendInput,
    get session() { return sess ? { id: sess.id, control: sess.control, hostId: sess.hostId } : null; },
    setToken(t) { cfg.token = t || ''; },
  };
}

