'use strict';

/**
 * Send-time markdown → sanitized email HTML.
 * Escape first, then apply markdown. Never pass model HTML through.
 */

const DISCLOSURE_STYLE = 'font-size:12px;font-style:italic;color:#555;';
const PITCH_STYLE = 'font-size:12px;font-weight:bold;color:#555;';
const DISCLOSURES = [
  '(paid link)',
  'As an Amazon Associate I earn from qualifying purchases.',
];

const STYLE = {
  h1: 'font-size:22px;font-weight:bold;margin:16px 0 8px;',
  h2: 'font-size:18px;font-weight:bold;margin:14px 0 8px;',
  h3: 'font-size:16px;font-weight:bold;margin:12px 0 6px;',
  h4: 'font-size:16px;font-weight:bold;margin:12px 0 6px;',
  p: 'margin:0 0 12px;',
  ul: 'padding-left:24px;margin:8px 0;',
  ol: 'padding-left:24px;margin:8px 0;',
  li: 'margin:4px 0;',
  code: 'background:#f4f4f4;padding:1px 4px;font-family:Consolas,Monaco,monospace;',
  pre: 'background:#f4f4f4;padding:12px;font-family:Consolas,Monaco,monospace;white-space:pre-wrap;',
  a: 'text-decoration:underline;',
  blockquote: 'margin:8px 0;padding-left:12px;border-left:3px solid #ccc;color:#555;',
};

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function unescapeHtml(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalizeNewlines(s) {
  return String(s == null ? '' : s).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** If the whole remainder is italicized, return the inner text (*foo* / _foo_ → foo). */
function unwrapWholeItalic(s) {
  const t = String(s == null ? '' : s).trim();
  const m = /^(\*|_)([\s\S]+)\1$/.exec(t);
  return m ? m[2] : t;
}

/**
 * Unwrap Discord subtext (-#) to inner text; drop leftover thought-balloon chips.
 * Does not delete the words. Former -# line indexes are returned so the HTML
 * converter can render those lines as Discord-like small italic.
 */
function unwrapDiscordLines(s) {
  const subtextLines = new Set();
  const lines = normalizeNewlines(s).split('\n').map((line, i) => {
    const cleaned = line.replace(/💭/g, '');
    const m = /^-#\s*(.*)$/.exec(cleaned);
    if (!m) return cleaned;
    subtextLines.add(i);
    return unwrapWholeItalic(m[1]);
  });
  return { text: lines.join('\n'), subtextLines };
}

function stripDiscordChrome(s) {
  return unwrapDiscordLines(s).text;
}

function safeHref(escapedUrl) {
  const raw = unescapeHtml(escapedUrl).trim();
  if (!/^(https?:|mailto:)/i.test(raw)) return null;
  return escapeHtml(raw);
}

/** Images may use https or a mailed CID. Never javascript: and never cid: on <a href>. */
function imageSrc(escapedUrl) {
  const raw = unescapeHtml(escapedUrl).trim();
  if (/^cid:[A-Za-z0-9._-]+$/i.test(raw)) return escapeHtml(raw);
  return safeHref(escapedUrl);
}

function disclosureSpan(phrase) {
  return `<span style="${DISCLOSURE_STYLE}">${phrase}</span>`;
}

function styleDisclosures(s) {
  let out = s;
  for (const phrase of DISCLOSURES) {
    const wrapped = disclosureSpan(phrase);
    const variants = [`<em>${phrase}</em>`, `*${phrase}*`, `_${phrase}_`];
    for (const v of variants) {
      if (out.includes(v)) out = out.split(v).join(wrapped);
    }
    const hole = `\u0000D${phrase}\u0000`;
    out = out.split(wrapped).join(hole);
    if (out.includes(phrase)) out = out.split(phrase).join(wrapped);
    out = out.split(hole).join(wrapped);
  }
  return out;
}

function applyBoldItalic(s) {
  s = s.replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^\n]+?)__/g, '<strong>$1</strong>');
  s = s.replace(/\*([^\n]+?)\*/g, '<em>$1</em>');
  s = s.replace(/(?<![A-Za-z0-9])_([^\n_]+?)_(?![A-Za-z0-9])/g, '<em>$1</em>');
  return s;
}

function replaceImages(s, stash) {
  return s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (full, alt, url) => {
    const href = imageSrc(url);
    if (!href) return full;
    return stash(
      `<img src="${href}" alt="${alt}" width="96" height="96" ` +
      'style="display:block;border:0;outline:none;width:96px;height:96px;">',
    );
  });
}

function isBareImageLine(escapedLine) {
  const raw = unescapeHtml(escapedLine).trim();
  return /^!\[[^\]]*\]\((https?:\/\/[^)]+|cid:[A-Za-z0-9._-]+)\)$/i.test(raw);
}

function replaceLinks(s, stash) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const open = s.indexOf('[', i);
    if (open < 0) { out += s.slice(i); break; }
    const mid = s.indexOf('](', open);
    if (mid < 0) { out += s.slice(i); break; }
    let depth = 1;
    let j = mid + 2;
    while (j < s.length && depth > 0) {
      if (s[j] === '(') depth += 1;
      else if (s[j] === ')') depth -= 1;
      j += 1;
    }
    if (depth !== 0) { out += s.slice(i); break; }
    out += s.slice(i, open);
    const text = s.slice(open + 1, mid);
    const url = s.slice(mid + 2, j - 1);
    const href = safeHref(url);
    const inner = applyBoldItalic(text);
    out += href ? stash(`<a href="${href}" style="${STYLE.a}">${inner}</a>`) : inner;
    i = j;
  }
  return out;
}

function applyInline(escaped) {
  const holes = [];
  const stash = (html) => {
    const i = holes.length;
    holes.push(html);
    return `\u0000H${i}\u0000`;
  };

  let s = escaped;
  s = s.replace(/`([^`]+)`/g, (_, code) => stash(`<code style="${STYLE.code}">${code}</code>`));
  s = replaceImages(s, stash);
  s = replaceLinks(s, stash);
  s = applyBoldItalic(s);
  s = s.replace(/\u0000H(\d+)\u0000/g, (_, i) => holes[Number(i)]);
  return styleDisclosures(s);
}

function isBlockStart(line) {
  if (/^```/.test(line)) return true;
  if (/^#{1,4} /.test(line)) return true;
  if (isBareImageLine(line)) return true;
  if (/^&gt;/.test(line)) return true;
  if (/^[-*+] /.test(line)) return true;
  if (/^\d+\. /.test(line)) return true;
  return false;
}

function tag(name, style, inner) {
  return `<${name} style="${style}">${inner}</${name}>`;
}

function lineNeedsSmallItalic(escapedLine, idx, subtextLines) {
  if (subtextLines && subtextLines.has(idx)) return true;
  const raw = unescapeHtml(escapedLine).trim();
  return /^AI Assistant to \S/i.test(raw);
}

function lineNeedsPitchSize(escapedLine) {
  const raw = unescapeHtml(escapedLine).trim();
  return /can build an AI assistant like this for your team/i.test(raw);
}

function formatLine(escapedLine, idx, subtextLines) {
  const html = applyInline(escapedLine);
  if (lineNeedsSmallItalic(escapedLine, idx, subtextLines)) {
    if (html.startsWith(`<span style="${DISCLOSURE_STYLE}">`) && html.endsWith('</span>')) return html;
    return `<span style="${DISCLOSURE_STYLE}">${html}</span>`;
  }
  if (lineNeedsPitchSize(escapedLine)) {
    return `<span style="${PITCH_STYLE}">${html}</span>`;
  }
  return html;
}

/** Inner HTML fragment. Escapes first, then applies markdown. */
function markdownToHtml(md, opts) {
  const subtextLines = (opts && opts.subtextLines) || new Set();
  const escaped = escapeHtml(normalizeNewlines(md));
  const lines = escaped.split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      const code = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      out.push(`<pre style="${STYLE.pre}"><code style="${STYLE.code}">${code.join('\n')}</code></pre>`);
      continue;
    }

    const hm = /^(#{1,4}) (.+)$/.exec(line);
    if (hm) {
      const level = hm[1].length;
      out.push(tag(`h${level}`, STYLE[`h${level}`], formatLine(hm[2].trim(), i, subtextLines)));
      i += 1;
      continue;
    }

    if (/^&gt;/.test(line)) {
      const quote = [];
      while (i < lines.length && /^&gt;/.test(lines[i])) {
        quote.push(lines[i].replace(/^&gt; ?/, ''));
        i += 1;
      }
      const inner = quote.map((q, k) => formatLine(q, i - quote.length + k, subtextLines)).join('<br>');
      out.push(tag('blockquote', STYLE.blockquote, inner));
      continue;
    }

    if (/^[-*+] /.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*+] /.test(lines[i])) {
        items.push(tag('li', STYLE.li, formatLine(lines[i].replace(/^[-*+] /, ''), i, subtextLines)));
        i += 1;
      }
      out.push(tag('ul', STYLE.ul, items.join('')));
      continue;
    }

    if (/^\d+\. /.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        items.push(tag('li', STYLE.li, formatLine(lines[i].replace(/^\d+\. /, ''), i, subtextLines)));
        i += 1;
      }
      out.push(tag('ol', STYLE.ol, items.join('')));
      continue;
    }

    if (isBareImageLine(line)) {
      out.push(tag('p', 'margin:0;padding:0;line-height:0;', formatLine(line, i, subtextLines)));
      i += 1;
      continue;
    }

    if (line.trim() === '') {
      // Keep consecutive blank source lines. Skipping them collapsed \n\n\n to one
      // paragraph gap, so Gmail showed a single break. &nbsp; so empty <p> is not dropped.
      let n = 0;
      while (i < lines.length && lines[i].trim() === '') {
        n += 1;
        i += 1;
      }
      for (let k = 0; k < n; k++) {
        out.push('<p style="margin:0;padding:0;line-height:1.5;">&nbsp;</p>');
      }
      continue;
    }

    const para = [];
    const paraIdx = [];
    while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i])) {
      para.push(lines[i]);
      paraIdx.push(i);
      i += 1;
    }
    const inner = para.map((ln, k) => formatLine(ln, paraIdx[k], subtextLines)).join('<br>');
    out.push(tag('p', STYLE.p, inner));
  }

  return out.join('\n');
}

function wrapEmailHtml(inner) {
  return (
    '<!DOCTYPE html>\n' +
    '<html>\n' +
    '<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '</head>\n' +
    '<body style="font-family:Georgia,serif;font-size:16px;line-height:1.5;color:#222;margin:0;padding:16px;">\n' +
    String(inner == null ? '' : inner) + '\n' +
    '</body>\n' +
    '</html>'
  );
}

function emailHtmlFromMarkdown(md) {
  const { text, subtextLines } = unwrapDiscordLines(md);
  return wrapEmailHtml(markdownToHtml(text, { subtextLines }));
}

module.exports = {
  escapeHtml,
  unwrapWholeItalic,
  unwrapDiscordLines,
  stripDiscordChrome,
  markdownToHtml,
  wrapEmailHtml,
  emailHtmlFromMarkdown,
};
