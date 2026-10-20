'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseCommand, buildCommandMenu } = require('../shared/commands.js');

test('parses a bare command', () => {
  assert.deepEqual(parseCommand('/help'), { name: 'help', args: '' });
});

test('lowercases the command name', () => {
  assert.deepEqual(parseCommand('/HELP'), { name: 'help', args: '' });
});

test('parses a command with arguments', () => {
  assert.deepEqual(parseCommand('/status verbose now'), { name: 'status', args: 'verbose now' });
});

test('strips a @botname suffix (group chats)', () => {
  assert.deepEqual(parseCommand('/stop@MyAsmltrBot'), { name: 'stop', args: '' });
  assert.deepEqual(parseCommand('/help@Bot extra'), { name: 'help', args: 'extra' });
});

test('tolerates leading/trailing whitespace', () => {
  assert.deepEqual(parseCommand('   /help  '), { name: 'help', args: '' });
});

test('non-commands return null', () => {
  assert.equal(parseCommand('hello there'), null);
  assert.equal(parseCommand('@help'), null);   // not Telegram command syntax
  assert.equal(parseCommand('!help'), null);   // not Telegram command syntax
  assert.equal(parseCommand('a /help mid-sentence'), null);
  assert.equal(parseCommand(''), null);
  assert.equal(parseCommand(null), null);
  assert.equal(parseCommand('/'), null);
});

test('a plain slash without a name is not a command', () => {
  assert.equal(parseCommand('/ leading space'), null);
});

test('buildCommandMenu maps specs and drops hidden', () => {
  const specs = [
    { name: 'help', description: 'Show commands' },
    { name: 'status', description: 'Connector status' },
    { name: 'secret', description: 'hidden one', hidden: true },
  ];
  assert.deepEqual(buildCommandMenu(specs), [
    { command: 'help', description: 'Show commands' },
    { command: 'status', description: 'Connector status' },
  ]);
});

test('buildCommandMenu clamps description length and tolerates empties', () => {
  assert.deepEqual(buildCommandMenu(null), []);
  const long = 'x'.repeat(300);
  assert.equal(buildCommandMenu([{ name: 'a', description: long }])[0].description.length, 256);
});
