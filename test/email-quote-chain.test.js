'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildMailContent,
  formatQuoteAttr,
  sanitizeQuoteHtml,
} = require('../connectors/types/email');

const SIG = '\n\n\nGaia 🔶🌿\nAI Assistant to Alex Example\n\n[Example Co](https://example.com) can build an AI assistant like this for your team.\n';
const QUOTE = {
  fromName: 'Alex Example',
  fromAddr: 'owner@example.com',
  date: '2026-08-26T19:22:00.000Z', // 15:22 EDT
  text: 'Please look at *_domainkey* and *foo* in this inbound.',
};

test('reply with last inbound → quote after conversion, markdown not applied to inbound', () => {
  const c = buildMailContent('Hello **world**', SIG, { subject: 'Re: Rhino', quote: QUOTE });
  assert.match(c.html, /gmail_quote/);
  assert.match(c.html, /<strong>world<\/strong>/);
  const above = c.html.slice(0, c.html.indexOf('gmail_quote'));
  assert.match(above, /<strong>world<\/strong>/);
  assert.doesNotMatch(c.html.slice(c.html.indexOf('gmail_quote')), /<em>foo<\/em>/);
  assert.match(c.text, /> Please look at \*_domainkey\*/);
});

test('quoted inbound stays after conversion, markdown not applied to inbound', () => {
  const c = buildMailContent('A loaf on the sill.\n', SIG, { subject: 'Re: Owner Test', quote: QUOTE });
  assert.match(c.html, /gmail_quote/);
  assert.match(c.html, /gmail_attr/);
  const above = c.html.slice(0, c.html.indexOf('gmail_quote'));
  assert.match(above, /loaf/);
  assert.match(above, /font-weight:bold;color:#555/);
  assert.match(c.html, /\*_domainkey\*/);
  assert.doesNotMatch(c.html.slice(c.html.indexOf('gmail_quote')), /<em>foo<\/em>/);
  assert.doesNotMatch(c.html.slice(c.html.indexOf('gmail_quote')), /<strong>/);
  assert.match(c.text, /> Please look at \*_domainkey\*/);
  const sigAt = c.text.indexOf('Gaia');
  const gtAt = c.text.indexOf('\n>');
  assert.ok(sigAt > 0 && gtAt > sigAt);
  assert.match(c.html, /On .* at \d{1,2}:\d{2} (AM|PM)/);
  assert.match(formatQuoteAttr(QUOTE), /Alex Example <owner@example\.com>/);
});

test('no stored inbound → no quote', () => {
  const c = buildMailContent('Hi', SIG, { subject: 'Test', quote: null });
  assert.doesNotMatch(c.html, /gmail_quote/);
});

test('attachments stay off buildMailContent', () => {
  const c = buildMailContent('Hi', SIG, { subject: 'Test', quote: QUOTE });
  assert.equal(c.attachments, undefined);
});

test('sanitizeQuoteHtml keeps nested gmail_quote, drops img/script/cid', () => {
  const raw = '<html><body><p>Hello</p><img src="cid:photo@x" alt="x"><script>alert(1)</script>'
    + '<div class="gmail_quote"><blockquote class="gmail_quote">older</blockquote></div>'
    + '</body></html>';
  const out = sanitizeQuoteHtml(raw);
  assert.match(out, /<p>Hello<\/p>/);
  assert.match(out, /gmail_quote/);
  assert.match(out, />older</);
  assert.doesNotMatch(out, /<img/i);
  assert.doesNotMatch(out, /<script/i);
  assert.doesNotMatch(out, /cid:/i);
});

test('wraps inbound HTML after signature, not through markdown', () => {
  const quote = {
    ...QUOTE,
    html: '<p>Cleveland then</p><img src="https://example.com/x.jpg"><div class="gmail_quote">nested</div>',
  };
  const c = buildMailContent('New letter.\n', SIG, { subject: 'Re: Owner Test', quote });
  const qat = c.html.indexOf('gmail_quote');
  const above = c.html.slice(0, qat);
  assert.match(above, /New letter/);
  assert.match(above, /Gaia/);
  assert.match(c.html.slice(qat), /Cleveland then/);
  assert.match(c.html.slice(qat), /nested/);
  assert.doesNotMatch(c.html.slice(qat), /<img/i);
  assert.ok(c.html.lastIndexOf('</body>') > qat);
});
