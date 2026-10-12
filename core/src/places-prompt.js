'use strict';
/**
 * The places block for the system prompt.
 *
 * `composeSystemPrompts` splits the prompt into a STABLE set (identity, channel, toolbelt,
 * uploads-instruction) cached across turns by `stableHash`, and a VOLATILE per-turn tail. The
 * directory belongs in the stable set: it changes when someone labels a place, not every turn, so it
 * costs tokens once and then rides the cached block.
 *
 * What goes in is deliberately narrow. The toolbelt block already tells a turn to run
 * `asmltr send <channel> <target>` with "target = id/alias" and never says which ids exist, so the
 * minimum useful content is the roles (what a place is FOR) and the named places with their ids.
 * Topics and notes stay out and live behind `asmltr places`, because every turn on every channel pays
 * for this block and a 300-channel server would otherwise bloat all of them.
 *
 * Bounded by ASMLTR_PLACES_PROMPT_MAX (default 40 rows) and switchable off entirely with
 * ASMLTR_PLACES_IN_PROMPT=off, so an operator who decides the tokens are not worth it keeps the
 * store and the CLI without the per-turn cost.
 */

const DEFAULT_MAX = 40;

const enabled = () => !/^(0|off|false|no)$/i.test(String(process.env.ASMLTR_PLACES_IN_PROMPT || 'on'));
const maxRows = () => {
  const n = Number(process.env.ASMLTR_PLACES_PROMPT_MAX);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX;
};

/**
 * Build the block. Returns '' when there is nothing worth saying, which keeps it out of the prompt
 * and out of `stableHash` entirely rather than contributing an empty heading.
 *
 * @param {object} store  anything exposing roles() and list() (core/src/places.js, or a stub)
 * @param {object} [o]    { surface } the channel this turn is on, listed first
 */
function buildPlacesBlock(store, o = {}) {
  if (!enabled() || !store) return '';
  let roles = [], all = [];
  // A directory that throws takes the turn with it. An empty block is the correct degradation.
  try { roles = store.roles() || []; } catch (_) { roles = []; }
  try { all = store.list() || []; } catch (_) { all = []; }
  if (!roles.length && !all.length) return '';

  const cap = maxRows();
  const lines = [];

  if (roles.length) {
    lines.push('Roles (what a place is for):');
    for (const r of roles.slice(0, cap)) {
      const where = r.parent_name ? `${r.parent_name}#${r.name || r.scope_id}` : (r.name || r.scope_id);
      lines.push(`• ${r.label} = ${r.surface} ${r.scope_id} (${where})${r.note ? ' — ' + r.note : ''}`);
    }
  }

  // Named places, the turn's own surface first: on Discord, Discord channels are the ones it is most
  // likely to be asked about. Unnamed rows are skipped; an id with no name teaches nothing.
  const named = all.filter((p) => p.name);
  const here = o.surface ? named.filter((p) => p.surface === o.surface) : [];
  const rest = o.surface ? named.filter((p) => p.surface !== o.surface) : named;
  const ordered = [...here, ...rest];
  const room = Math.max(0, cap - Math.min(roles.length, cap));
  const shown = ordered.slice(0, room);

  if (shown.length) {
    lines.push(lines.length ? '\nKnown places:' : 'Known places:');
    for (const p of shown) {
      const alias = p.aliases && p.aliases.length ? `  aliases: ${p.aliases.join(', ')}` : '';
      lines.push(`• ${p.surface} ${p.scope_id} = ${p.display}${alias}`);
    }
  }
  const hidden = ordered.length - shown.length;
  if (hidden > 0) lines.push(`• …and ${hidden} more (run \`asmltr places\` for the full directory)`);

  if (!lines.length) return '';
  return 'PLACES — the servers, channels and chats asmltr knows, by id:\n' + lines.join('\n') +
    '\nUse these ids as the `target` for `asmltr send <channel> <target>`. ' +
    '`asmltr places resolve "<name or role>"` resolves anything not listed here, and ' +
    '`asmltr places set` records a new alias or role so the next session does not have to rediscover it.';
}

module.exports = { buildPlacesBlock, DEFAULT_MAX, maxRows, enabled };
