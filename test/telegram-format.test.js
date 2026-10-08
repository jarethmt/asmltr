'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  renderToHtml, splitHtml, toTelegramChunks, toPlainChunks, htmlToPlain, escapeHtml,
} = require('../shared/telegram-format.js');

test('escapes HTML-active characters in plain text', () => {
  assert.equal(renderToHtml('a < b && c > d'), 'a &lt; b &amp;&amp; c &gt; d');
});

test('bold, italic, strikethrough', () => {
  assert.equal(renderToHtml('**bold**'), '<b>bold</b>');
  assert.equal(renderToHtml('*italic*'), '<i>italic</i>');
  assert.equal(renderToHtml('~~gone~~'), '<s>gone</s>');
});

test('bold is not eaten by the single-asterisk italic rule', () => {
  assert.equal(renderToHtml('**really**'), '<b>really</b>');
});

test('snake_case identifiers are not italicized', () => {
  assert.equal(renderToHtml('call ctx_core_handle now'), 'call ctx_core_handle now');
});

test('underscore italic still works at word boundaries', () => {
  assert.equal(renderToHtml('_word_'), '<i>word</i>');
});

test('inline code is escaped and not emphasis-formatted', () => {
  assert.equal(renderToHtml('`a*b<c`'), '<code>a*b&lt;c</code>');
});

test('fenced code block with language', () => {
  const out = renderToHtml('```js\nconst x = 1 < 2;\n```');
  assert.equal(out, '<pre><code class="language-js">const x = 1 &lt; 2;</code></pre>');
});

test('fenced code block without language', () => {
  assert.equal(renderToHtml('```\nraw & <tag>\n```'), '<pre>raw &amp; &lt;tag&gt;</pre>');
});

test('unterminated fence is still captured, not dropped', () => {
  const out = renderToHtml('```\nhalf');
  assert.match(out, /^<pre>half<\/pre>$/);
});

test('headings degrade to bold lines', () => {
  assert.equal(renderToHtml('## Summary'), '<b>Summary</b>');
});

test('bullet list becomes bullet lines', () => {
  assert.equal(renderToHtml('- one\n- two'), '• one\n• two');
});

test('numbered list keeps its number', () => {
  assert.equal(renderToHtml('1. first\n2. second'), '1. first\n2. second');
});

test('task list checkboxes render as symbols', () => {
  assert.equal(renderToHtml('- [ ] todo\n- [x] done'), '• ☐ todo\n• ☑ done');
});

test('links become anchor tags', () => {
  assert.equal(renderToHtml('[site](https://x.y/z)'), '<a href="https://x.y/z">site</a>');
});

test('blockquote run wraps once', () => {
  assert.equal(renderToHtml('> a\n> b'), '<blockquote>a\nb</blockquote>');
});

test('horizontal rule becomes a dashed line', () => {
  assert.equal(renderToHtml('---'), '─'.repeat(12));
});

test('pipe table renders as a monospace pre block', () => {
  const md = '| Part | Price |\n|---|---|\n| MCU | $60 |\n| IMU | $20 |';
  const out = renderToHtml(md);
  assert.match(out, /^<pre>/);
  assert.match(out, /<\/pre>$/);
  assert.ok(out.includes('Part'));
  assert.ok(out.includes('MCU'));
  // table cells are stripped of markdown and escaped, no stray pipes rendered as columns markers
  assert.ok(!out.includes('|'));
});

test('table cell markdown markers are stripped (monospace cannot carry tags)', () => {
  const md = '| Col |\n|---|\n| **bold** |';
  const out = renderToHtml(md);
  assert.ok(out.includes('bold'));
  assert.ok(!out.includes('**'));
});

test('a realistic mixed reply renders without raw markers leaking', () => {
  const md = [
    '## Plan',
    '',
    'Use **HTML** rendering with a `fallback`.',
    '',
    '- step one',
    '- step two',
    '',
    '```js',
    'send(x);',
    '```',
  ].join('\n');
  const out = renderToHtml(md);
  assert.ok(!out.includes('**'));
  assert.ok(!out.includes('## '));
  assert.ok(out.includes('<b>Plan</b>'));
  assert.ok(out.includes('<b>HTML</b>'));
  assert.ok(out.includes('<code>fallback</code>'));
  assert.ok(out.includes('<pre><code class="language-js">send(x);</code></pre>'));
});

// --- chunking -------------------------------------------------------------

test('short html is returned as a single chunk', () => {
  assert.deepEqual(splitHtml('<b>hi</b>', 100), ['<b>hi</b>']);
});

test('split never leaves an open <pre> in a chunk', () => {
  const body = Array.from({ length: 50 }, (_v, i) => `line ${i}`).join('\n');
  const html = `<pre>${body}</pre>`;
  const chunks = splitHtml(html, 120);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    const opens = (c.match(/<pre>/g) || []).length;
    const closes = (c.match(/<\/pre>/g) || []).length;
    assert.equal(opens, closes, `balanced <pre> in chunk: ${c}`);
    assert.ok(c.length <= 120, `chunk within max: ${c.length}`);
  }
});

test('split re-opens a blockquote across a boundary', () => {
  const body = Array.from({ length: 30 }, (_v, i) => `q ${i}`).join('\n');
  const html = `<blockquote>${body}</blockquote>`;
  const chunks = splitHtml(html, 80);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.equal((c.match(/<blockquote>/g) || []).length, (c.match(/<\/blockquote>/g) || []).length);
  }
});

test('a single over-long line is hard-split', () => {
  const html = 'x'.repeat(250);
  const chunks = splitHtml(html, 100);
  assert.ok(chunks.every((c) => c.length <= 100));
  assert.equal(chunks.join(''), html);
});

test('toTelegramChunks composes render + split', () => {
  const chunks = toTelegramChunks('**bold** and more', 100);
  assert.deepEqual(chunks, ['<b>bold</b> and more']);
});

test('toPlainChunks preserves the original text for the fallback path', () => {
  assert.deepEqual(toPlainChunks('**raw** stays', 100), ['**raw** stays']);
  const long = 'y'.repeat(250);
  assert.deepEqual(toPlainChunks(long, 100).join(''), long);
});

test('escapeHtml is exported and minimal', () => {
  assert.equal(escapeHtml('<a> & <b>'), '&lt;a&gt; &amp; &lt;b&gt;');
});

test('htmlToPlain strips tags and unescapes entities for the per-chunk fallback', () => {
  assert.equal(htmlToPlain('<b>a</b> &lt;x&gt; &amp; <code>y</code>'), 'a <x> & y');
});
