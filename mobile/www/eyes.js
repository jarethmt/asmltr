/*
 * asmltr eyes — one expressive face, shared by every surface that shows it:
 * the assistant drawer, the read-aloud toast, and the held-notification badge.
 *
 * DESIGN NOTES (why it looks the way it does)
 *
 * · **Shape carries the emotion, not position.** Cozmo/Vector/EVE all use pupil-less eyes whose
 *   OUTLINE morphs — squashing to happy slits, cutting a lid angle for concern. Moving a dot around
 *   only ever reads as "tracking". Every expression here is a set of shape targets (height, width,
 *   per-corner radius, bottom arc, lid cut, tilt) that springs toward its goal.
 *
 * · **No specular highlight.** A hard white dot implies a glossy sphere lit from outside, which
 *   fights the idea that these are self-luminous. At the sizes we render (16–28px) it degrades into
 *   2–3px of mush anyway. Instead each eye is a vertical gradient — near-white at the top falling to
 *   full accent at the bottom — which reads as light coming from INSIDE the eye.
 *
 * · **Springs, not lerps.** Every animated value is a damped spring (Material 3 Expressive's motion
 *   physics, and it genuinely settles better). Overshoot is what makes a blink feel snappy and a
 *   state change feel alive rather than mechanical.
 *
 * · **Speech is gestural, not a pulse.** Amplitude alone produces a throbbing blob. Real speakers
 *   punctuate: they accent syllables, break gaze between clauses, blink on boundaries. So the
 *   envelope drives onset detection → micro-saccades on emphasis, and silence gaps → clause
 *   gestures (look away and back, a blink, a tilt). That is what makes it look like it is TALKING
 *   TO YOU rather than vibrating.
 *
 * · **Nothing is ever perfectly still.** A slow noise drift runs under everything. Perfect stillness
 *   is the single strongest "this is a cheap widget" tell.
 *
 * · **The glow is drawn in canvas, with margin.** A CSS `filter: blur()` bleeds ~3× its sigma past
 *   the element and gets clipped by the window — which is exactly why the old overlay looked cropped.
 *   Here the canvas reserves GLOW_PAD around the face and the caller sizes the window to match.
 *
 * USAGE
 *   const face = AsmltrEyes.mount(canvasEl, { palette: ['139,92,246','236,72,153'] });
 *   face.setState('speaking');   // idle · listening · thinking · speaking
 *   face.setAmp(0.7);            // 0..1 live audio envelope
 *   face.setMood('happy');       // neutral · happy · curious · concerned · sleepy
 *   face.blink(); face.gesture('glance'); face.destroy();
 */
(function (global) {
  'use strict';

  // Fraction of the canvas reserved around the face for glow bleed. The face is drawn into the
  // remaining centre, so the halo can never touch — let alone be cut by — the window edge.
  var GLOW_PAD = 0.19;

  // ── spring integrator ───────────────────────────────────────────────────────
  // Critically-ish damped by default. `s` = stiffness, `d` = damping.
  function Spring(value, s, d) {
    this.v = value; this.target = value; this.vel = 0;
    this.s = s == null ? 0.18 : s;
    this.d = d == null ? 0.72 : d;
  }
  Spring.prototype.to = function (t) { this.target = t; return this; };
  Spring.prototype.set = function (t) { this.v = this.target = t; this.vel = 0; return this; };
  Spring.prototype.step = function () {
    this.vel += (this.target - this.v) * this.s;
    this.vel *= this.d;
    this.v += this.vel;
    return this.v;
  };

  // Cheap smooth noise — sum of incommensurable sines. Deterministic, no allocation, and enough
  // texture that the face never sits perfectly still.
  function drift(t, seed) {
    return Math.sin(t * 0.0131 + seed) * 0.6
         + Math.sin(t * 0.0077 + seed * 2.3) * 0.3
         + Math.sin(t * 0.0289 + seed * 4.1) * 0.1;
  }

  // ── expression table ────────────────────────────────────────────────────────
  // Each entry is a set of shape targets. `open`/`wide` are multipliers on the base eye box; `arc`
  // bows the bottom edge upward (the happy squint); `lidOut`/`lidIn` drop the OUTER and INNER top
  // corners, MIRRORED across the two eyes — dropping outer corners reads as concern, inner corners as
  // anger, and both together as heavy lids. `tilt` rotates each eye about its own centre, mirrored.
  var MOODS = {
    neutral:   { open: 1.00, wide: 1.00, arc: 0.00, lidOut: 0.00, lidIn: 0.00, tilt: 0.00, rTop: 0.46, rBot: 0.46 },
    happy:     { open: 0.70, wide: 1.08, arc: 0.26, lidOut: 0.00, lidIn: 0.00, tilt: 0.00, rTop: 0.50, rBot: 0.50 },
    curious:   { open: 1.06, wide: 1.00, arc: 0.00, lidOut: 0.10, lidIn: 0.00, tilt: 0.10, rTop: 0.42, rBot: 0.46 },
    concerned: { open: 0.94, wide: 0.98, arc: 0.00, lidOut: 0.38, lidIn: 0.02, tilt: 0.00, rTop: 0.38, rBot: 0.48 },
    angry:     { open: 0.92, wide: 1.00, arc: 0.00, lidOut: 0.02, lidIn: 0.42, tilt: 0.00, rTop: 0.38, rBot: 0.48 },
    sleepy:    { open: 0.60, wide: 1.00, arc: 0.06, lidOut: 0.26, lidIn: 0.22, tilt: 0.00, rTop: 0.38, rBot: 0.46 }
  };

  // Per-state modifiers layered on top of the mood, plus the behavioural personality of each state.
  var STATES = {
    idle:      { open: 1.00, wide: 1.00, gaze: [0, 0],       glow: 0.55, bright: 0.00, breathe: 0.030 },
    listening: { open: 1.14, wide: 1.03, gaze: [0, -0.16],   glow: 0.95, bright: 0.55, breathe: 0.045 },
    thinking:  { open: 0.80, wide: 0.96, gaze: [-0.34, -0.30], glow: 0.70, bright: 0.10, breathe: 0.022 },
    speaking:  { open: 1.02, wide: 1.00, gaze: [0, 0],       glow: 1.00, bright: 0.28, breathe: 0.055 }
  };

  function Face(canvas, opts) {
    opts = opts || {};
    this.cv = canvas;
    this.cx = canvas.getContext('2d');
    this.pal = opts.palette || ['139,92,246', '236,72,153'];
    this.gap = opts.gap == null ? 0.22 : opts.gap;      // eye spacing, as a fraction of eye width
    this.scale = opts.scale == null ? 1 : opts.scale;
    this.showGlow = opts.glow !== false;

    this.state = 'idle';
    this.mood = 'neutral';
    this.t = 0;
    this.amp = 0; this.ampRaw = 0; this.ampAt = 0; this.ampAvg = 0;
    this.running = false;

    // animated values
    this.open   = new Spring(1, 0.30, 0.62);
    this.wide   = new Spring(1, 0.20, 0.72);
    this.arc    = new Spring(0, 0.16, 0.76);
    this.lidOut = new Spring(0, 0.16, 0.76);
    this.lidIn  = new Spring(0, 0.16, 0.76);
    this.tilt   = new Spring(0, 0.14, 0.78);
    this.lookX  = new Spring(0, 0.13, 0.76);
    this.lookY  = new Spring(0, 0.13, 0.76);
    this.glow   = new Spring(0.55, 0.10, 0.82);
    this.bright = new Spring(0, 0.12, 0.80);
    this.lean   = new Spring(0, 0.10, 0.80);   // whole-face tilt, in radians
    this.rTop   = new Spring(0.46, 0.16, 0.76);
    this.rBot   = new Spring(0.46, 0.16, 0.76);
    this.blinkV = 0;                            // 0 = open, 1 = shut

    // behaviour scheduling
    this.nextBlink = 60 + Math.random() * 120;
    this.nextIdle = 120 + Math.random() * 180;
    this.gazeGoal = { x: 0, y: 0 };
    this.silence = 0;
    this.sinceGesture = 0;
  }

  Face.prototype.setPalette = function (pal) { if (pal && pal.length) this.pal = pal; };
  Face.prototype.setState = function (s) { if (STATES[s]) this.state = s; };
  Face.prototype.setMood = function (m) { if (MOODS[m]) this.mood = m; };

  /** Feed the live envelope, 0..1 (mic while listening, TTS while speaking). */
  Face.prototype.setAmp = function (v) {
    v = Math.max(0, Math.min(1, v || 0));
    // Onset detection: a sharp rise above the running average is a syllable accent. That is the hook
    // the speech gestures hang off — it is what turns a pulse into articulation.
    if (v - this.ampAvg > 0.18 && this.state === 'speaking' && this.sinceGesture > 8) this.accent(v);
    this.ampRaw = v;
    this.ampAvg += (v - this.ampAvg) * 0.12;
    this.ampAt = Date.now();
  };

  // ── one-shot gestures ───────────────────────────────────────────────────────

  Face.prototype.blink = function (half) {
    this.blinkV = half ? 0.55 : 1;
    this.nextBlink = 70 + Math.random() * 150;
  };

  /** A syllable accent: a flick of the eyes plus a touch of widen. Small — it should register as
   *  emphasis, not as a jump. */
  Face.prototype.accent = function (v) {
    this.sinceGesture = 0;
    var k = 0.5 + v * 0.5;
    this.gazeGoal.x += (Math.random() * 2 - 1) * 0.10 * k;
    this.gazeGoal.y += (Math.random() * 2 - 1) * 0.07 * k;
    this.gazeGoal.x = Math.max(-0.5, Math.min(0.5, this.gazeGoal.x));
    this.gazeGoal.y = Math.max(-0.4, Math.min(0.4, this.gazeGoal.y));
    this.open.vel += 0.05 * k;                 // a tiny pop, via the spring's velocity
  };

  /** Between-clause behaviour. Speakers break gaze when they finish a thought; doing this on silence
   *  gaps is most of what sells "it is talking to me". */
  Face.prototype.gesture = function (kind) {
    this.sinceGesture = 0;
    if (!kind) {
      var r = Math.random();
      kind = r < 0.42 ? 'glance' : r < 0.68 ? 'blink' : r < 0.86 ? 'lean' : 'double';
    }
    if (kind === 'blink') this.blink();
    else if (kind === 'double') { this.blink(); this.pendingBlink = 12; }
    else if (kind === 'lean') this.lean.to((Math.random() * 2 - 1) * 0.075);
    else { // glance away, then back
      this.gazeGoal = { x: (Math.random() < 0.5 ? -1 : 1) * (0.24 + Math.random() * 0.2),
                        y: (Math.random() * 2 - 1) * 0.18 };
      this.returnGaze = 26 + Math.random() * 22;
    }
  };

  // ── frame ───────────────────────────────────────────────────────────────────

  Face.prototype.step = function () {
    var t = ++this.t;
    var st = STATES[this.state] || STATES.idle;
    var md = MOODS[this.mood] || MOODS.neutral;
    var fresh = Date.now() - this.ampAt < 250;

    // Envelope → smoothed amp. Active states track the real signal hard; resting states breathe.
    var target;
    if (this.state === 'speaking') target = fresh ? this.ampRaw : 0.12;
    else if (this.state === 'listening') target = fresh ? this.ampRaw * 0.9 : 0.10;
    else target = st.breathe + (Math.sin(t / 52) + 1) / 2 * st.breathe;
    this.amp += (target - this.amp) * (fresh ? 0.34 : 0.10);

    // Blink: decay shut→open, with the second half of a double-blink queued.
    if (this.blinkV > 0) { this.blinkV -= 0.16; if (this.blinkV < 0) this.blinkV = 0; }
    if (this.pendingBlink != null && --this.pendingBlink <= 0) { this.pendingBlink = null; this.blink(true); }
    if (--this.nextBlink <= 0) this.blink(Math.random() < 0.22);

    // Speech gestures. Silence between clauses is the cue; a long unbroken stretch also earns one so
    // the face does not lock up during a monologue.
    this.sinceGesture++;
    if (this.state === 'speaking') {
      if (this.ampRaw < 0.10) this.silence++; else this.silence = 0;
      if (this.silence === 14 && Math.random() < 0.75) this.gesture();
      else if (this.sinceGesture > 150 && Math.random() < 0.03) this.gesture();
    } else {
      this.silence = 0;
      if (--this.nextIdle <= 0) {
        this.nextIdle = (this.state === 'thinking' ? 70 : 140) + Math.random() * 190;
        // Idle wandering — and occasionally something with more personality than a look.
        if (Math.random() < 0.24) this.gesture(Math.random() < 0.5 ? 'lean' : 'blink');
        else this.gazeGoal = { x: (Math.random() * 2 - 1) * 0.3, y: (Math.random() * 2 - 1) * 0.22 };
      }
    }
    if (this.returnGaze != null && --this.returnGaze <= 0) { this.returnGaze = null; this.gazeGoal = { x: 0, y: 0 }; }

    // Gaze = scheduled goal + state bias + perpetual drift.
    this.lookX.to(this.gazeGoal.x + st.gaze[0] + drift(t, 1.7) * 0.035);
    this.lookY.to(this.gazeGoal.y + st.gaze[1] + drift(t, 4.2) * 0.028);

    // Shape targets: mood × state, with amplitude squashing the eyes as energy rises (an open mouth
    // narrows the eyes — borrowed straight from cartoon animation).
    var squash = this.amp * (this.state === 'speaking' ? 0.20 : 0.08);
    this.open.to(md.open * st.open * (1 - squash) + drift(t, 9.1) * 0.012);
    this.wide.to(md.wide * st.wide * (1 + squash * 0.55));
    this.arc.to(md.arc + (this.state === 'speaking' ? this.amp * 0.12 : 0));
    this.lidOut.to(md.lidOut); this.lidIn.to(md.lidIn);
    this.tilt.to(md.tilt);
    this.rTop.to(md.rTop); this.rBot.to(md.rBot);
    this.glow.to(st.glow * (0.72 + this.amp * 0.6));
    this.bright.to(st.bright + this.amp * (this.state === 'speaking' ? 0.35 : 0.12));
    this.lean.to(this.lean.target * 0.94 + drift(t, 6.3) * 0.006);   // leans decay back toward level

    this.open.step(); this.wide.step(); this.arc.step(); this.lidOut.step(); this.lidIn.step(); this.tilt.step();
    this.lookX.step(); this.lookY.step(); this.glow.step(); this.bright.step(); this.lean.step();
    this.rTop.step(); this.rBot.step();
  };

  // ── render ──────────────────────────────────────────────────────────────────

  /**
   * One eye: a rounded rect with per-corner radii, an upward-bowed bottom (the happy squint) and
   * independently droppable top corners (the lids).
   *
   * `side` is -1 for the left eye and +1 for the right, and it MIRRORS the lids — the left eye's outer
   * corner is its left one, the right eye's outer corner is its right one. Without this both eyes cut
   * the same side and the face reads as broken rather than expressive.
   */
  function eyePath(cx, w, h, rTopF, rBotF, arc, lidOut, lidIn, side) {
    var hw = w / 2, hh = h / 2, yB = hh;
    var dOut = lidOut * h, dIn = lidIn * h;
    var dL = side < 0 ? dOut : dIn;          // how far the LEFT top corner is pulled down
    var dR = side < 0 ? dIn : dOut;          // and the RIGHT
    var dMax = Math.max(dL, dR);

    // Vertical room actually left between the LOWEST lid corner and the bottom edge. Every radius and
    // the bottom bow are clamped against this, not against h. Otherwise a deep lid plus fat corner
    // radii make a side edge run backwards, the path self-intersects, and the non-zero winding rule
    // punches the crossed region back out — the black triangles.
    var room = Math.max(1, h - dMax);
    // rTop is additionally capped as a fraction of the WIDTH so a straight lid segment always survives.
    // At 0.46 x min(w,h) the two corner arcs left ~8% of the width straight, and an angled lid drawn
    // across 8% of the eye is invisible — which is why the expressions only ever read as the corners
    // starting at different heights. 0.34 x w keeps roughly a third of the top edge straight.
    var rTop = Math.min(rTopF * Math.min(w, h), w * 0.34, room * 0.5);
    var rBot = Math.min(rBotF * Math.min(w, h), hw, room * 0.5);
    var bow  = Math.min(arc * h, room * 0.55);

    var yL = -hh + dL, yR = -hh + dR;        // the lid line, meeting the left and right edges
    var slope = (yR - yL) / w;               // follow the lid when placing its tangent points

    cx.beginPath();
    // Up the left edge, then let arcTo round the corner INTO the angled lid. arcTo keeps the lid a real
    // straight edge at a real angle whatever the radius is. The previous version inset the top edge
    // horizontally by rTop, which at these radii left a straight segment ~8% of the eye's width — so
    // the angle had nowhere to show and only surfaced as two arcs starting at different heights.
    cx.moveTo(-hw, yB - rBot);
    cx.lineTo(-hw, yL + rTop);
    cx.arcTo(-hw, yL, -hw + rTop, yL + rTop * slope, rTop);
    cx.lineTo(hw - rTop, yR - rTop * slope);
    cx.arcTo(hw, yR, hw, yR + rTop, rTop);
    cx.lineTo(hw, yB - rBot);
    cx.arcTo(hw, yB, hw - rBot, yB, rBot);
    cx.quadraticCurveTo(0, yB - bow, -hw + rBot, yB);   // the bottom bow — the happy squint
    cx.arcTo(-hw, yB, -hw, yB - rBot, rBot);
    cx.closePath();
  }

  Face.prototype.render = function () {
    var cx = this.cx, cv = this.cv;
    var W = cv.width, H = cv.height;
    cx.clearRect(0, 0, W, H);

    var pad = Math.min(W, H) * GLOW_PAD;
    var boxW = W - pad * 2, boxH = H - pad * 2;
    var unit = Math.min(boxW / 2.25, boxH / 1.12);        // base eye height
    var eh0 = unit, ew0 = unit * 0.68;
    var gapPx = ew0 * (1 + this.gap * 2);

    var mx = W / 2, my = H / 2;
    var a = this.amp, pal = this.pal;

    // ambient glow — two drifting radial lobes, additive so they melt together. Drawn well inside the
    // reserved padding, so it fades to nothing long before the canvas edge.
    if (this.showGlow) {
      cx.globalCompositeOperation = 'lighter';
      var gr = Math.min(W, H) * (0.26 + this.glow.v * 0.12 + a * 0.07);
      for (var i = 0; i < 2; i++) {
        var ox = Math.sin(this.t / 58 + i * 2.4) * unit * (0.16 + a * 0.16);
        var oy = Math.cos(this.t / 71 + i * 1.9) * unit * (0.13 + a * 0.13);
        var g = cx.createRadialGradient(mx + ox, my + oy, gr * 0.05, mx + ox, my + oy, gr);
        var col = i ? pal[1] : pal[0];
        g.addColorStop(0, 'rgba(' + col + ',' + (0.50 * this.glow.v).toFixed(3) + ')');
        g.addColorStop(0.42, 'rgba(' + col + ',' + (0.17 * this.glow.v).toFixed(3) + ')');
        g.addColorStop(1, 'rgba(' + col + ',0)');
        cx.fillStyle = g;
        cx.fillRect(0, 0, W, H);
      }
      cx.globalCompositeOperation = 'source-over';
    }

    var eh = Math.max(eh0 * 0.06, eh0 * this.open.v * (1 - this.blinkV * 0.94));
    var ew = ew0 * this.wide.v;
    var lookPx = { x: this.lookX.v * ew0 * 0.9, y: this.lookY.v * eh0 * 0.45 };

    cx.save();
    cx.translate(mx + lookPx.x, my + lookPx.y);
    cx.rotate(this.lean.v);

    for (var e = 0; e < 2; e++) {
      var sign = e ? 1 : -1;
      cx.save();
      cx.translate(sign * gapPx / 2, 0);
      cx.rotate(sign * this.tilt.v);

      // Vertical gradient INSTEAD of a specular dot: bright, near-white core at the top falling to
      // saturated accent at the bottom. Reads as light from inside the eye.
      var br = this.bright.v;
      var top = 'rgba(' + mix(pal[0], '255,255,255', 0.55 + br * 0.42) + ',1)';
      var bot = 'rgba(' + mix(pal[0], pal[1], 0.30 + a * 0.22) + ',' + (0.90 + br * 0.1).toFixed(2) + ')';
      var lg = cx.createLinearGradient(0, -eh / 2, 0, eh / 2);
      lg.addColorStop(0, top);
      lg.addColorStop(0.55, 'rgba(' + mix(pal[0], '255,255,255', 0.12 + br * 0.25) + ',1)');
      lg.addColorStop(1, bot);

      cx.shadowColor = 'rgba(' + pal[0] + ',' + (0.85 * this.glow.v).toFixed(2) + ')';
      cx.shadowBlur = unit * (0.55 + a * 0.45);
      cx.fillStyle = lg;
      eyePath(cx, ew, eh, this.rTop.v, this.rBot.v, this.arc.v, this.lidOut.v, this.lidIn.v, sign);
      cx.fill();
      cx.shadowBlur = 0;
      cx.restore();
    }
    cx.restore();
  };

  /** Blend two "r,g,b" strings. */
  function mix(a, b, k) {
    var A = a.split(','), B = b.split(',');
    k = Math.max(0, Math.min(1, k));
    return [0, 1, 2].map(function (i) {
      return Math.round(+A[i] + (+B[i] - +A[i]) * k);
    }).join(',');
  }

  Face.prototype.resize = function () {
    var r = this.cv.getBoundingClientRect();
    var dpr = Math.min(global.devicePixelRatio || 1, 3);
    var w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (this.cv.width !== w || this.cv.height !== h) { this.cv.width = w; this.cv.height = h; }
  };

  Face.prototype.start = function () {
    if (this.running) return this;
    this.running = true;
    var self = this;
    (function loop() {
      if (!self.running) return;
      self.resize(); self.step(); self.render();
      global.requestAnimationFrame(loop);
    })();
    return this;
  };

  Face.prototype.destroy = function () { this.running = false; };

  global.AsmltrEyes = {
    mount: function (canvas, opts) { return new Face(canvas, opts).start(); },
    moods: Object.keys(MOODS),
    states: Object.keys(STATES)
  };
})(window);
