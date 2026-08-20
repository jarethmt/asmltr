'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const grok = require('../core/src/engines/grok');

function effortOf(args) {
  const i = args.indexOf('--effort');
  return i >= 0 ? args[i + 1] : null;
}
test('buildArgs always passes --effort', () => {
  const args = grok.buildArgs({ prompt: 'hi' });
  assert.ok(args.includes('--effort'));
  assert.ok(['low', 'medium', 'high', 'xhigh'].includes(effortOf(args)));
});

test('effortForTurn defaults to high; env and explicit override; email is xhigh', () => {
  const prev = process.env.ASMLTR_GROK_EFFORT;
  delete process.env.ASMLTR_GROK_EFFORT;
  try {
    assert.equal(grok.effortForTurn({}), 'high');
    assert.equal(grok.effortForTurn({ effort: 'medium' }), 'medium');
    assert.equal(grok.effortForTurn({ channel: 'email' }), 'xhigh');
    process.env.ASMLTR_GROK_EFFORT = 'low';
    assert.equal(grok.effortForTurn({ channel: 'email' }), 'xhigh');
    assert.equal(grok.effortForTurn({}), 'low');
  } finally {
    if (prev === undefined) delete process.env.ASMLTR_GROK_EFFORT;
    else process.env.ASMLTR_GROK_EFFORT = prev;
  }
});

test('email is xhigh and buildArgs has no --max-turns', () => {
  const prev = process.env.ASMLTR_GROK_EFFORT;
  delete process.env.ASMLTR_GROK_EFFORT;
  try {
    const args = grok.buildArgs({ prompt: 'hi', channel: 'email' });
    assert.equal(effortOf(args), 'xhigh');
    assert.equal(args.includes('--max-turns'), false);
  } finally {
    if (prev === undefined) delete process.env.ASMLTR_GROK_EFFORT;
    else process.env.ASMLTR_GROK_EFFORT = prev;
  }
});

test('buildArgs does not pass Grok 4.6 context or output-length flags', () => {
  const args = grok.buildArgs({ prompt: 'hi', effort: 'xhigh' });
  assert.equal(args.includes('--context'), false);
  assert.equal(args.some((a) => /context/i.test(a) && a.startsWith('--')), false);
  assert.equal(args.some((a) => /output-length|max-output/i.test(a)), false);
});
