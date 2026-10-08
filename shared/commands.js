'use strict';
/**
 * asmltr shared slash-command parsing. Connector-agnostic so a later extraction of Discord's richer
 * command set can share one parser instead of each connector growing its own.
 *
 * A command spec is { name, description, hidden? }. The connector owns the handlers (they touch its
 * bot/ctx/state); this module only turns inbound text into a {name,args} and builds the menu payload
 * a surface registers (e.g. Telegram's setMyCommands).
 *
 * Telegram's convention is a leading-slash command delivered with a bot_command entity, optionally
 * suffixed with @botname in group chats, e.g. `/stop`, `/help@MyBot`, `/status extra args`. `@help`
 * and `!help` are NOT Telegram command syntax and are deliberately not parsed as commands here.
 */

/** Parse a leading-slash command. Returns { name, args } (name lowercased) or null if not a command. */
function parseCommand(text) {
  const m = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(String(text == null ? '' : text).trim());
  if (!m) return null;
  return { name: m[1].toLowerCase(), args: (m[2] || '').trim() };
}

/** Build a setMyCommands-style menu ([{command, description}]) from specs, dropping hidden ones. */
function buildCommandMenu(specs) {
  return (specs || [])
    .filter((s) => s && s.name && !s.hidden)
    .map((s) => ({ command: s.name, description: String(s.description || '').slice(0, 256) }));
}

module.exports = { parseCommand, buildCommandMenu };
