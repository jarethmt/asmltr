'use strict';

/** Mid-turn inject `by`. Owner/bypass → operator; anyone else → discord:<author.id>. */
function injectBy(isOwner, authorId) {
  if (isOwner) return 'operator';
  return 'discord:' + String(authorId);
}

module.exports = { injectBy };
