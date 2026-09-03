'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cloneArgv, cloneGitEnv, gitAuthHeader, githubIdentityPrompt } = require('../connectors/types/github/clone-auth');

test('clone argv has no PAT', () => {
  const args = cloneArgv('acme/repo', '/tmp/acme__repo');
  const joined = args.join(' ');
  assert.equal(joined.includes('x-access-token'), false);
  assert.equal(joined.includes('ghs_'), false);
  assert.equal(joined.includes('@github.com'), false);
  assert.ok(args.includes('https://github.com/acme/repo.git'));
});

test('identity prompt has no PAT placeholder or GH_TOKEN=', () => {
  const p = githubIdentityPrompt({ acct: '@bot', patKey: 'my_pat_key', issueNumber: 1, full: 'acme/repo' });
  assert.equal(p.includes('GH_TOKEN='), false);
  assert.equal(p.includes('<pat>'), false);
  assert.match(p, /my_pat_key/);
});

test('clone env is Basic x-access-token, PAT not on argv, helpers wiped', () => {
  const pat = 'secret-pat-value';
  const env = cloneGitEnv(pat, {});
  assert.equal(env.GIT_CONFIG_VALUE_0.includes(pat), false);
  assert.equal(env.GIT_CONFIG_VALUE_0.startsWith('Authorization: Bearer'), false);
  assert.match(env.GIT_CONFIG_VALUE_0, /^Authorization: Basic /);
  const b64 = env.GIT_CONFIG_VALUE_0.slice('Authorization: Basic '.length);
  assert.equal(Buffer.from(b64, 'base64').toString('utf8'), 'x-access-token:secret-pat-value');
  assert.equal(gitAuthHeader(pat), env.GIT_CONFIG_VALUE_0);
  assert.equal(env.GIT_CONFIG_VALUE_1, '');
  assert.equal(env.GIT_CONFIG_VALUE_2, '');
  assert.equal(env.GIT_CONFIG_KEY_1, 'credential.helper');
  assert.equal(env.GIT_CONFIG_KEY_2, 'credential.https://github.com.helper');
  assert.equal(cloneArgv('a/b', '/x').join(' ').includes(pat), false);
});

test('blank PAT adds no extraHeader', () => {
  const env = cloneGitEnv('  ', {});
  assert.equal(env.GIT_CONFIG_VALUE_0, undefined);
  assert.equal(gitAuthHeader(''), '');
});
