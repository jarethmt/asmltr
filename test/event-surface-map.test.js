'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { SURFACES, surfaceFor, buildEvent } = require('../shared/events.js');

// The invariant this file exists to protect:
//
//   Every connector's `meta.type` MUST resolve to a valid telemetry surface.
//
// `connectors/sdk` builds each connector's ctx.emit with `{ surface: <type> }` as the default, and
// buildEvent() REJECTS an unknown surface. So a connector type that isn't a surface (and has no
// entry in CHANNEL_SURFACE) has every event it emits thrown away. That is not a hypothetical: the
// `android` connector shipped that way and its turns reported 0 tokens for weeks while running a
// ~1M-token context. `device` and `remote-desktop` had the same latent defect.
//
// Two hand-maintained lists that must agree, with nothing enforcing it, WILL drift again the next
// time someone adds a connector. This test is the enforcement.

const TYPES_DIR = path.join(__dirname, '..', 'connectors', 'types');

function connectorTypes() {
  return fs.readdirSync(TYPES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => fs.existsSync(path.join(TYPES_DIR, name, 'index.js')));
}

test('every connector type resolves to a valid telemetry surface', () => {
  const types = connectorTypes();
  assert.ok(types.length > 0, 'expected to discover at least one connector type');

  const broken = types.filter((t) => !SURFACES.includes(surfaceFor(t)));
  assert.deepEqual(broken, [],
    `these connector types resolve to no valid surface, so ALL their events are silently dropped: ` +
    `${broken.join(', ')}. Fix by adding the type to SURFACES (if it is its own user-facing surface) ` +
    `or to CHANNEL_SURFACE in shared/events.js (if it rolls up under an existing one).`);
});

test('a connector declaring meta.type can actually emit', () => {
  // Exercises the real path: the default surface connectors/sdk injects is the connector's type.
  for (const type of connectorTypes()) {
    assert.doesNotThrow(
      () => buildEvent({ surface: type, event_type: 'inbound', source: `connector:${type}` }),
      `connector type '${type}' cannot emit — buildEvent rejects its default surface`);
  }
});

test('android maps onto the same surface its own emits already hardcode', () => {
  // The connector hardcodes surface:'assistant-native' on its in-connector emits. If core's
  // channel-derived events landed anywhere else, one conversation would split across two surfaces
  // in the Usage view — which is the bug this mapping exists to prevent.
  assert.equal(surfaceFor('android'), 'assistant-native');
  assert.equal(surfaceFor('device'), 'assistant-native');
});

test('non-connector core producers emit too', () => {
  // `notify` is not a connector — it is core's /v2/notify delivery ladder, which recorded with
  // surface:'notify' and was therefore dropped exactly like android was.
  assert.equal(surfaceFor('notify'), 'core');
  assert.doesNotThrow(() => buildEvent({
    surface: 'notify', session_id: 'notify', event_type: 'outbound', identity: 'notify', source: 'core',
  }));
});

test('surfaceFor is identity for surfaces that need no mapping', () => {
  for (const s of ['discord', 'telegram', 'email', 'mcp', 'github', 'claude-code', 'core', 'system']) {
    assert.equal(surfaceFor(s), s, `${s} should map to itself`);
  }
});

test('an unmappable surface is still rejected (the map is not a bypass)', () => {
  assert.throws(() => buildEvent({ surface: 'totally-made-up', event_type: 'inbound' }), /unknown surface/);
});

test('a normalized event carries the mapped surface, not the raw channel', () => {
  const evt = buildEvent({ surface: 'android', event_type: 'token-usage', tokens_in: 1234, tokens_out: 56 });
  assert.equal(evt.surface, 'assistant-native');
  assert.equal(evt.tokens_in, 1234);
  assert.equal(evt.tokens_out, 56);
});
