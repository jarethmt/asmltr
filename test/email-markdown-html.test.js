'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  escapeHtml,
  stripDiscordChrome,
  markdownToHtml,
  wrapEmailHtml,
  emailHtmlFromMarkdown,
  buildMailContent,
  LETTER_ONLY_EXTRA,
} = require('../connectors/types/email');

test('bold italic headings render as tags', () => {
  const h = markdownToHtml('# Hello\n\n## Sub\n\n### Small\n\nThis is **bold** and *italic* and __also bold__ and _also italic_.');
  assert.match(h, /<h1[^>]*>Hello<\/h1>/);
  assert.match(h, /<h2[^>]*>Sub<\/h2>/);
  assert.match(h, /<h3[^>]*>Small<\/h3>/);
  assert.match(h, /<strong>bold<\/strong>/);
  assert.match(h, /<em>italic<\/em>/);
  assert.match(h, /<strong>also bold<\/strong>/);
  assert.match(h, /<em>also italic<\/em>/);
});

test('raw script is escaped, not a tag', () => {
  const h = markdownToHtml('Hello <script>alert(1)</script>');
  assert.doesNotMatch(h, /<script>/i);
  assert.match(h, /&lt;script&gt;/);
});

test('javascript URL is not an href', () => {
  const h = markdownToHtml('Click [here](javascript:alert(1)) please');
  assert.doesNotMatch(h, /href\s*=/i);
  assert.doesNotMatch(h, /javascript/i);
  assert.match(h, /here/);
});

test('http links become underlined anchors', () => {
  const h = markdownToHtml('See [docs](https://example.com/path)');
  assert.match(h, /<a href="https:\/\/example.com\/path"[^>]*>docs<\/a>/);
  assert.match(h, /text-decoration:underline/);
});

test('Discord -# line unwraps inner text and drops chips', () => {
  const stripped = stripDiscordChrome('-# Working\nHello\n-# Still working\nWorld 💭 done');
  assert.match(stripped, /Working/);
  assert.match(stripped, /Still working/);
  assert.doesNotMatch(stripped, /💭/);
  assert.doesNotMatch(stripped, /^-#/m);
  assert.match(stripped, /Hello/);
  assert.match(stripped, /World/);
  assert.equal(stripDiscordChrome('-# *(paid link)*').trim(), '(paid link)');
  const html = emailHtmlFromMarkdown('-# Working\nDear reader\n');
  assert.match(html, /Working/);
  assert.match(html, /Dear reader/);
  assert.match(html, /<span style="font-size:12px;font-style:italic;color:#555;">Working<\/span>/);
  assert.doesNotMatch(html, /-#/);
});

test('(paid link) and Associate sentence get small italic', () => {
  const h = markdownToHtml('Buy this (paid link). As an Amazon Associate I earn from qualifying purchases.');
  assert.match(h, /font-size:12px;font-style:italic;color:#555/);
  assert.match(h, /<span style="font-size:12px;font-style:italic;color:#555;">\(paid link\)<\/span>/);
  assert.match(h, /<span style="font-size:12px;font-style:italic;color:#555;">As an Amazon Associate I earn from qualifying purchases\.<\/span>/);
});

test('emailHtmlFromMarkdown returns a full html document with a body', () => {
  const doc = emailHtmlFromMarkdown('Hi **there**');
  assert.match(doc, /<!DOCTYPE html>/i);
  assert.match(doc, /<html[\s>]/i);
  assert.match(doc, /<body[\s>]/i);
  assert.match(doc, /<\/body>/i);
  assert.match(doc, /Georgia/);
  assert.match(doc, /<strong>there<\/strong>/);
});

test('buildMailContent returns multipart text plus html', () => {
  const c = buildMailContent('Hello **world**', '\n\n—\nGaia');
  assert.equal(c.text, 'Hello **world**\n\n—\nGaia');
  assert.ok(c.html);
  assert.match(c.html, /<strong>world<\/strong>/);
  assert.match(c.html, /<html/i);
  assert.match(c.html, /<body/i);
});

test('escapeHtml and wrapEmailHtml helpers', () => {
  assert.equal(escapeHtml('&<>"\''), '&amp;&lt;&gt;&quot;&#39;');
  const doc = wrapEmailHtml('<p>z</p>');
  assert.match(doc, /<html[\s>]/i);
  assert.match(doc, /<body[^>]*>/);
  assert.match(doc, /<p>z<\/p>/);
  assert.doesNotMatch(doc, /<script/i);
});

test('lists blockquotes code and hard breaks', () => {
  const h = markdownToHtml('Line one\nLine two\n\n- apples\n- pears\n\n1. first\n2. second\n\n> quoted\n\nUse `code` and:\n\n```\nconst x = 1;\n```\n');
  assert.match(h, /Line one<br>Line two/);
  assert.match(h, /<ul[^>]*>/);
  assert.match(h, /<li[^>]*>apples<\/li>/);
  assert.match(h, /<ol[^>]*>/);
  assert.match(h, /<li[^>]*>first<\/li>/);
  assert.match(h, /<blockquote[^>]*>quoted<\/blockquote>/);
  assert.match(h, /<code[^>]*>code<\/code>/);
  assert.match(h, /<pre[^>]*>[\s\S]*const x = 1;/);
});

test('-# *(paid link)* under a URL survives as small italic', () => {
  const src = 'https://example.com/dp/B0FAKE0000\n-# *(paid link)*';
  const h = emailHtmlFromMarkdown(src);
  assert.match(h, /https:\/\/example.com\/dp\/B0FAKE0000/);
  assert.match(h, /<span style="font-size:12px;font-style:italic;color:#555;">\(paid link\)<\/span>/);
  assert.doesNotMatch(h, /-#/);
  assert.doesNotMatch(h, /<em>\(paid link\)<\/em>/);
});

test('-# Associate sentence survives as small italic', () => {
  const src = '-# *As an Amazon Associate I earn from qualifying purchases.*';
  const h = emailHtmlFromMarkdown(src);
  assert.match(h, /<span style="font-size:12px;font-style:italic;color:#555;">As an Amazon Associate I earn from qualifying purchases\.<\/span>/);
  assert.doesNotMatch(h, /-#/);
  assert.doesNotMatch(h, /<em>As an Amazon Associate I earn from qualifying purchases\.<\/em>/);
});

test('italic-wrapped disclosure forms are small italic, not just em', () => {
  const h = markdownToHtml('See *(paid link)* and *As an Amazon Associate I earn from qualifying purchases.*');
  assert.match(h, /<span style="font-size:12px;font-style:italic;color:#555;">\(paid link\)<\/span>/);
  assert.match(h, /<span style="font-size:12px;font-style:italic;color:#555;">As an Amazon Associate I earn from qualifying purchases\.<\/span>/);
  assert.doesNotMatch(h, /<em>\(paid link\)<\/em>/);
});

test('AI Assistant attribution line is 12px italic; line above is not', () => {
  const h = markdownToHtml('Hello\nAI Assistant to Alex');
  assert.match(h, /Hello/);
  assert.match(h, /<span style="font-size:12px;font-style:italic;color:#555;">AI Assistant to Alex<\/span>/);
  assert.doesNotMatch(h, /<span style="font-size:12px;font-style:italic;color:#555;">Hello<\/span>/);
  const nameLine = emailHtmlFromMarkdown('Gaia 🔶🌿\n\nAI Assistant to Alex');
  assert.match(nameLine, /Gaia/);
  assert.doesNotMatch(nameLine, /<span style="font-size:12px;font-style:italic;color:#555;">Gaia/);
});

test('consecutive blank lines are kept as &nbsp; paragraphs, not collapsed', () => {
  const h = markdownToHtml('above\n\n\nGaia\nAI Assistant to Alex\n\n\nbelow');
  const spacers = h.match(/<p style="margin:0;padding:0;line-height:1.5;">&nbsp;<\/p>/g) || [];
  assert.equal(spacers.length, 4);
  assert.match(h, /Gaia<br><span style="font-size:12px;font-style:italic;color:#555;">AI Assistant to Alex<\/span>/);
});

test('markdown link in the pitch line becomes an href', () => {
  const h = markdownToHtml('[Example Co](https://example.com) can build an AI assistant like this for your team.');
  assert.match(h, /<a href="https:\/\/example.com"[^>]*>Example Co<\/a>/);
});

test('pitch line is 12px not italic; assistant line stays italic', () => {
  const h = markdownToHtml(
    'Gaia\nAI Assistant to Alex\n\n[Example Co](https://example.com) can build an AI assistant like this for your team.',
  );
  assert.match(h, /<span style="font-size:12px;font-style:italic;color:#555;">AI Assistant to Alex<\/span>/);
  assert.match(h, /<span style="font-size:12px;font-weight:bold;color:#555;"><a href="https:\/\/example.com"/);
  assert.doesNotMatch(h, /<span style="font-size:12px;font-style:italic;color:#555;"><a href="https:\/\/example.com"/);
});

test('https markdown image becomes an img; javascript URL does not', () => {
  const h = markdownToHtml('![cube](https://example.com/sig.png)\n[Example Co](https://example.com) can build an AI assistant like this for your team.');
  assert.match(h, /<img src="https:\/\/example.com\/sig.png" alt="cube"/);
  assert.match(h, /width="96"/);
  assert.match(h, /margin:0;padding:0;line-height:0/);
  assert.doesNotMatch(h, /<img[^>]*><br>/);
  const bad = markdownToHtml('![x](javascript:alert(1))');
  assert.doesNotMatch(bad, /<img/i);
  assert.doesNotMatch(bad, /javascript/i);
});

test('cid markdown image is mailed src, not an http link', () => {
  const h = markdownToHtml('![Gaia](cid:assistant-sig)\n[Example Co](https://example.com) can build an AI assistant like this for your team.');
  assert.match(h, /<img src="cid:assistant-sig" alt="Gaia"/);
  assert.doesNotMatch(h, /<a href="cid:/);
});

test('signature image sits after two blanks and immediately above the pitch', () => {
  const h = markdownToHtml(
    'Gaia\nAI Assistant to Alex\n\n\n![Gaia](https://example.com/sig.png)\n[Example Co](https://example.com) can build an AI assistant like this for your team.',
  );
  const spacers = h.match(/<p style="margin:0;padding:0;line-height:1.5;">&nbsp;<\/p>/g) || [];
  assert.equal(spacers.length, 2);
  assert.match(
    h,
    /AI Assistant to Alex<\/span><\/p>\n<p style="margin:0;padding:0;line-height:1.5;">&nbsp;<\/p>\n<p style="margin:0;padding:0;line-height:1.5;">&nbsp;<\/p>\n<p style="margin:0;padding:0;line-height:0;"><img src="https:\/\/example.com\/sig.png"/,
  );
  assert.match(
    h,
    /<img src="https:\/\/example.com\/sig.png"[^>]*><\/p>\n<p style="margin:0 0 12px;"><span style="font-size:12px;font-weight:bold;color:#555;"><a href="https:\/\/example.com"/,
  );
});

test('letter-only extra is the suffix of the extra string', () => {
  const src = fs.readFileSync(path.join(__dirname, '../connectors/types/email/index.js'), 'utf8');
  assert.equal(
    LETTER_ONLY_EXTRA,
    'Write the letter only. The first line of the mailed body is the greeting or the first sentence to the reader. No notes-to-self, no photo captions, no I\'ll-send plans above that.',
  );
  assert.match(src, /Write the letter only\. The first line of the mailed body is the greeting/);
  const adds = [...src.matchAll(/extra \+= [^;]+;/g)].map((m) => m[0]);
  assert.ok(adds.length >= 1);
  assert.match(adds[adds.length - 1], /LETTER_ONLY_EXTRA/);
  const extraTail = src.indexOf("extra += ' ' + LETTER_ONLY_EXTRA");
  const markdownIdx = src.lastIndexOf('You may use standard markdown');
  assert.ok(extraTail > markdownIdx);
});
