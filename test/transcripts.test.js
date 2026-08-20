'use strict';
const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-transcripts-'));
process.env.ASMLTR_SILOS_ROOT = tmp;

const transcripts = require('../shared/transcripts');
const silo = require('../shared/silo');

after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
});

describe('transcripts', { concurrency: 1 }, () => {
  test('safeKey strips colons so conversation_key is a filename', () => {
    assert.equal(transcripts.safeKey('assistant-web:local:owner'), 'assistant-web-local-owner');
    assert.equal(transcripts.safeKey(''), 'unknown');
  });

  test('appendTurn writes user+assistant into Self silo memory/transcripts and last-topics', async () => {
    const ts = Date.UTC(2026, 7, 18, 18, 0, 0);
    const wrote = await transcripts.appendTurn({
      conversationKey: 'assistant-web:local:owner',
      channel: 'assistant-web',
      userText: 'I like Laphroaig 10 and a 12-year refill sherry cask.',
      assistantText: 'Islay peat plus sherry is a solid pairing.',
      ts,
    });
    assert.equal(wrote.transcript, 'memory/transcripts/assistant-web-local-owner.md');
    assert.equal(wrote.lastTopics, 'memory/last-topics.md');

    const self = silo.ensureSelf();
    const md = (await self.get(wrote.transcript)).toString('utf8');
    assert.ok(md.includes('Laphroaig 10'));
    assert.ok(md.includes('Islay peat plus sherry'));
    assert.ok(md.includes('**user:**'));
    assert.ok(md.includes('**assistant:**'));
    assert.ok(md.includes('assistant-web:local:owner'));

    const topics = (await self.get(wrote.lastTopics)).toString('utf8');
    assert.ok(topics.startsWith('# Last topics'));
    assert.ok(topics.includes('Laphroaig 10'));
    assert.ok(topics.includes('assistant-web:local:owner'));
  });

  test('appendTurn appends a second turn and keeps newest topic first', async () => {
    const ts = Date.UTC(2026, 7, 18, 18, 5, 0);
    await transcripts.appendTurn({
      conversationKey: 'assistant-web:local:owner',
      userText: 'Also curious about Caol Ila.',
      assistantText: 'Lighter peat, good contrast.',
      ts,
    });
    const self = silo.ensureSelf();
    const md = (await self.get('memory/transcripts/assistant-web-local-owner.md')).toString('utf8');
    assert.ok(md.includes('Laphroaig 10'));
    assert.ok(md.includes('Caol Ila'));
    const topics = (await self.get('memory/last-topics.md')).toString('utf8');
    const lines = topics.split('\n').filter((l) => l.startsWith('- '));
    assert.ok(lines[0].includes('Caol Ila'));
    assert.ok(lines.some((l) => l.includes('Laphroaig')));
  });

  test('recallForInject returns recent turns for a conversation, not the global last-topics index', async () => {
    const block = await transcripts.recallForInject({ conversationKey: 'assistant-web:local:owner' });
    assert.equal(block.includes('LAST TOPICS'), false);
    assert.ok(block.includes('Caol Ila'));
    assert.ok(block.includes('Laphroaig 10'));
    assert.ok(block.includes('RECENT TURNS FROM THIS CONVERSATION'));
    assert.ok(block.includes('**user:**'));
  });

  test('recallForInject does not leak another conversation_key', async () => {
    const secret = 'owner-private-telegram-payment-update-xyzzy';
    await transcripts.appendTurn({
      conversationKey: 'telegram:inst:owner',
      channel: 'telegram',
      userText: secret,
      assistantText: 'Noted.',
      ts: Date.UTC(2026, 7, 18, 19, 0, 0),
    });
    await transcripts.appendTurn({
      conversationKey: 'discord:inst:guild:99',
      channel: 'discord',
      userText: 'hello from a public channel',
      assistantText: 'hi',
      ts: Date.UTC(2026, 7, 18, 19, 1, 0),
    });

    const discord = await transcripts.recallForInject({ conversationKey: 'discord:inst:guild:99' });
    assert.ok(discord.includes('hello from a public channel'));
    assert.equal(discord.includes(secret), false);
    assert.equal(discord.includes('telegram:inst:owner'), false);
    assert.equal(discord.includes('Laphroaig'), false);

    const telegram = await transcripts.recallForInject({ conversationKey: 'telegram:inst:owner' });
    assert.ok(telegram.includes(secret));
    assert.equal(telegram.includes('hello from a public channel'), false);

    const topics = (await silo.ensureSelf().get('memory/last-topics.md')).toString('utf8');
    assert.ok(topics.includes(secret));
    assert.ok(topics.includes('hello from a public channel'));
  });

  test('appendTurn tags unsent drafts so memory does not claim they were delivered', async () => {
    const wrote = await transcripts.appendTurn({
      conversationKey: 'email:inst:thread-1',
      channel: 'email',
      userText: 'Please send this.',
      assistantText: 'I would have emailed this, but it is held.',
      drafted: true,
      ts: Date.UTC(2026, 7, 18, 20, 0, 0),
    });
    const md = (await silo.ensureSelf().get(wrote.transcript)).toString('utf8');
    assert.ok(md.includes('**assistant (unsent draft):**'));
    assert.equal(md.includes('**assistant:** I would have emailed'), false);
    const block = await transcripts.recallForInject({ conversationKey: 'email:inst:thread-1' });
    assert.ok(block.includes('unsent draft'));
  });

  test('appendTurn writes via Silo.put (driver), not raw fs append', async () => {
    const puts = [];
    const origPut = silo.Silo.prototype.put;
    silo.Silo.prototype.put = async function (p, data) {
      puts.push(String(p));
      return origPut.call(this, p, data);
    };
    try {
      await transcripts.appendTurn({
        conversationKey: 'mcp:inst:user:1',
        userText: 'driver-path check',
        assistantText: 'ok',
        ts: Date.UTC(2026, 7, 18, 21, 0, 0),
      });
    } finally {
      silo.Silo.prototype.put = origPut;
    }
    assert.ok(puts.includes('memory/transcripts/mcp-inst-user-1.md'));
    assert.ok(puts.includes('memory/last-topics.md'));
  });

  test('appendTurn plaintext is not on disk when Silo.put seals', async () => {
    const secret = 'sealed-owner-reply-should-not-be-plaintext';
    const origPut = silo.Silo.prototype.put;
    const origGet = silo.Silo.prototype.get;
    silo.Silo.prototype.put = async function (p, data) {
      const sealed = 'SEALED:' + Buffer.from(String(data)).toString('base64');
      return origPut.call(this, p, sealed);
    };
    silo.Silo.prototype.get = async function (p) {
      const raw = await origGet.call(this, p);
      const s = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
      if (s.startsWith('SEALED:')) return Buffer.from(s.slice(7), 'base64');
      return raw;
    };
    try {
      const wrote = await transcripts.appendTurn({
        conversationKey: 'telegram:vault:owner',
        userText: secret,
        assistantText: 'ok',
        ts: Date.UTC(2026, 7, 18, 22, 0, 0),
      });
      const onDisk = fs.readFileSync(path.join(silo.ensureSelf().dir, wrote.transcript), 'utf8');
      assert.ok(onDisk.startsWith('SEALED:'));
      assert.equal(onDisk.includes(secret), false);
      const viaDriver = (await silo.ensureSelf().get(wrote.transcript)).toString('utf8');
      assert.ok(viaDriver.includes(secret));
    } finally {
      silo.Silo.prototype.put = origPut;
      silo.Silo.prototype.get = origGet;
    }
  });

  test('recallForInject is empty when the silo has no transcript for that key', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-transcripts-empty-'));
    const prev = process.env.ASMLTR_SILOS_ROOT;
    process.env.ASMLTR_SILOS_ROOT = other;
    delete require.cache[require.resolve('../shared/silo')];
    delete require.cache[require.resolve('../shared/transcripts')];
    const fresh = require('../shared/transcripts');
    const block = await fresh.recallForInject({ conversationKey: 'no-such-key' });
    process.env.ASMLTR_SILOS_ROOT = prev;
    delete require.cache[require.resolve('../shared/silo')];
    delete require.cache[require.resolve('../shared/transcripts')];
    try { fs.rmSync(other, { recursive: true, force: true }); } catch (_) {}
    assert.equal(block, '');
  });
});
