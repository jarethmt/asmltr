#!/usr/bin/env node
'use strict';
require('../../../shared/loadenv');
/**
 * Seed the trust store from a JSON file ($ASMLTR_TRUST_SEED or ./seed.json).
 * The trust store is DEFAULT-DENY — only seeded principals get access.
 * Idempotent: seeds only when the principals table is empty (use --force to wipe + reseed).
 * If no seed file exists, the store simply starts empty; add principals via the Access UI/API.
 * See seed.example.json for the shape (example friend principal; default_tier is schema only).
 */
const fs = require('fs');
const path = require('path');
const store = require('./store');

const SEED_FILE = process.env.ASMLTR_TRUST_SEED || path.join(__dirname, 'seed.json');

function run({ force } = {}) {
  const existing = store.principals.list();
  if (existing.length && !force) {
    console.log(`trust store already has ${existing.length} principals — skipping (use --force to reseed)`);
    return;
  }
  if (force) {
    for (const p of existing) store.principals.remove(p.id);
    for (const r of store.roles.list()) store.roles.remove(r.id);
    console.log('wiped existing principals + roles');
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  } catch (e) {
    console.log(`no trust seed at ${SEED_FILE} (${e.code || e.message}) — starting empty (default-deny). Add principals via the Access UI/API.`);
    return;
  }

  for (const r of (data.roles || [])) {
    store.roles.upsert({
      id: r.id, name: r.name || r.id,
      allow: r.allow || [], requires_approval: r.requires_approval || [], forbidden: r.forbidden || [],
      bypass_moderation: !!r.bypass_moderation, strict_mode: !!r.strict_mode, notes: r.notes || '',
    });
  }

  let n = 0;
  for (const p of (data.principals || [])) {
    store.principals.create({
      id: p.id, display_name: p.display_name || p.id,
      default_tier: p.default_tier || 0, revoked: !!p.revoked, notes: p.notes || '',
    });
    for (const idf of (p.identifiers || [])) store.identifiers.add(p.id, idf.surface, String(idf.value));
    for (const g of (p.grants || [])) {
      store.grants.create({
        principal_id: p.id, role_id: g.role_id || null,
        scope_surface: g.scope_surface || null, scope_id: g.scope_id || null,
        allow: g.allow || [], requires_approval: g.requires_approval || [], forbidden: g.forbidden || [],
        bypass_moderation: !!g.bypass_moderation, strict_mode: !!g.strict_mode,
      });
    }
    n++;
  }
  console.log(`seeded ${n} principals + ${(data.roles || []).length} roles from ${SEED_FILE}`);
}

if (require.main === module) run({ force: process.argv.includes('--force') });
module.exports = { run };
