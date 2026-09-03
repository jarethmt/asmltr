'use strict';
/**
 * Secret redaction for PUBLIC output surfaces.
 *
 * Tool output (file contents, command results, `git remote` URLs, `grep` of env
 * files) can contain live credentials. On a surface visible to anyone who isn't a
 * full-permission user — a GitHub issue comment, a public Discord channel — that
 * output must be scrubbed before it's posted. (Private surfaces restricted to a
 * full-trust user — the owner's DM, the operator TUI — keep raw output for debugging;
 * the CALLER decides whether to apply this based on the surface's audience.)
 *
 * Masks the secret VALUE, keeps surrounding text legible. Conservative on the
 * key=value rule (skips obvious non-secrets: $vars, getenv(...), placeholders).
 */

const SAFE = /^(?:\$|`?\$\(|getenv|process\.env|os\.environ|example|your[_-]?|<|\{\{|placeholder|redacted|«|true|false|null|undefined|none|\d{1,4})$/i;

const RULES = [
  // High-signal whole-token matches → replace the whole thing.
  { rx: /\bghp_[A-Za-z0-9]{30,}\b/g, repl: () => '«REDACTED:github-pat»' },
  { rx: /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g, repl: () => '«REDACTED:github-pat»' },
  { rx: /\bgho_[A-Za-z0-9]{30,}\b/g, repl: () => '«REDACTED:github-token»' },
  { rx: /\bghs_[A-Za-z0-9]{20,}\b/g, repl: () => '«REDACTED:github-token»' },
  { rx: /\bxai-[A-Za-z0-9]{20,}\b/g, repl: () => '«REDACTED:xai-key»' },
  { rx: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, repl: () => '«REDACTED:jwt»' },
  { rx: /\bBearer\s+[A-Za-z0-9._\-+/=]{16,}/gi, repl: () => 'Bearer «REDACTED»' },
  { rx: /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{20,}\b/g, repl: () => '«REDACTED:discord-bot»' },
  { rx: /((?:^|[\s"'`>([{,])GH_TOKEN\s*[:=]\s*["'`]?)([^\s"'`<>]{8,})/g, repl: (m, pre, val) => pre + '«REDACTED»' },
  { rx: /\bsk-[A-Za-z0-9]{20,}\b/g, repl: () => '«REDACTED:openai-key»' },
  { rx: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, repl: () => '«REDACTED:slack-token»' },
  { rx: /\bAKIA[0-9A-Z]{16}\b/g, repl: () => '«REDACTED:aws-key»' },
  { rx: /\b\d{8,12}:[A-Za-z0-9_-]{35}\b/g, repl: () => '«REDACTED:telegram-token»' },
  { rx: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, repl: () => '«REDACTED:private-key»' },
  // Credentials embedded in a URL: scheme://user:PASSWORD@host  → mask the password.
  { rx: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)([^\s@/]{4,})(@)/gi, repl: (m, pre, _v, at) => pre + '«REDACTED»' + at },
  // KEY=value / key: value where the key name looks secret and the value is non-trivial.
  { rx: /((?:^|[\s"'`>([{,])[A-Za-z0-9_.-]*(?:passwd|password|pwd|secret|api[_-]?key|access[_-]?key|auth[_-]?key|client_secret|priv(?:ate)?[_-]?key|centrifugo[_a-z]*key|db_password|mysql_pass(?:word)?)\s*[:=]>?\s*["'`]?)([^\s"'`<>]{6,})/gi,
    repl: (m, pre, val) => (SAFE.test(val) ? m : pre + '«REDACTED»') },
  // PHP define('SECRET_NAME', 'value') — WordPress wp-config style (comma-separated).
  { rx: /(\bdefine\s*\(\s*["'][A-Za-z0-9_]*(?:password|passwd|pwd|secret|salt|api[_-]?key|auth[_-]?key|token)[A-Za-z0-9_]*["']\s*,\s*["'])([^"']{6,})(["'])/gi,
    repl: (m, pre, val, q) => (SAFE.test(val) || /^(?:put your|unique phrase|example|change ?me|your |insert )/i.test(val) ? m : pre + '«REDACTED»' + q) },
  // Bare env assignment of a long opaque value: FOO_KEY=deadbeef…(hex) or base64.
  { rx: /((?:^|[\s>])[A-Z][A-Z0-9_]{3,}=)([A-Fa-f0-9]{24,}|[A-Za-z0-9+/]{32,}={0,2})\b/gm,
    repl: (m, pre, _v) => pre + '«REDACTED»' },
];

/**
 * @param {string} input
 * @returns {{ text: string, count: number }} redacted text + number of redactions
 */
function redactSecrets(input) {
  if (input == null) return { text: input, count: 0 };
  let text = String(input);
  let count = 0;
  for (const { rx, repl } of RULES) {
    text = text.replace(rx, (...args) => {
      const out = repl(...args);
      if (out !== args[0]) count += 1;
      return out;
    });
  }
  return { text, count };
}

module.exports = { redactSecrets };
