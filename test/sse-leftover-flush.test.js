'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const sseUrl = pathToFileURL(
  path.join(__dirname, '../insights/dashboard/src/services/sse.js')
).href;

function fakeReader(chunks) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    async read() {
      if (i >= chunks.length) return { value: undefined, done: true };
      const c = chunks[i++];
      return { value: typeof c === 'string' ? enc.encode(c) : c, done: false };
    }
  };
}

test('leftover data: done without trailing blank line still fires onDone', async () => {
  const { readSseStream } = await import(sseUrl);
  const seen = [];
  let doneActions = null;
  await readSseStream(
    fakeReader([
      'data: {"type":"delta","text":"hi"}\n\n',
      'data: {"type":"done","actions":[]}'
    ]),
    (f) => {
      seen.push(f.type);
      if (f.type === 'done') doneActions = f.actions || [];
    }
  );
  assert.deepEqual(seen, ['delta', 'done']);
  assert.deepEqual(doneActions, []);
});

test('parseSseFrames leaves an undelimited last frame in rest', async () => {
  const { parseSseFrames } = await import(sseUrl);
  const { frames, rest } = parseSseFrames(
    'data: {"type":"delta","text":"a"}\n\ndata: {"type":"done","actions":[]}'
  );
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, 'delta');
  assert.equal(rest, 'data: {"type":"done","actions":[]}');
});

test('consumeSseBuffer flush parses a lone leftover data: line', async () => {
  const { consumeSseBuffer } = await import(sseUrl);
  const frames = [];
  const leftover = consumeSseBuffer(
    'data: {"type":"done","actions":[]}',
    (f) => frames.push(f),
    { flush: true }
  );
  assert.equal(leftover, '');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, 'done');
  assert.deepEqual(frames[0].actions, []);
});

test('delimited frames still dispatch without needing flush', async () => {
  const { consumeSseBuffer } = await import(sseUrl);
  const frames = [];
  const leftover = consumeSseBuffer(
    'data: {"type":"delta","text":"a"}\n\ndata: {"type":"done","actions":[]}\n\n',
    (f) => frames.push(f.type)
  );
  assert.equal(leftover, '');
  assert.deepEqual(frames, ['delta', 'done']);
});
