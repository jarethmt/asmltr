'use strict';
/** asmltr connector manager — instance registry (SQLite). */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DB_PATH = process.env.ASMLTR_CONNECTORS_DB || path.join(__dirname, 'data', 'connectors.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS instances (
    id          TEXT PRIMARY KEY,
    type        TEXT NOT NULL,
    name        TEXT NOT NULL,
    config_json TEXT NOT NULL DEFAULT '{}',
    enabled     INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
`);

// A channel may RIDE ON an integration (docs/INTEGRATIONS.md T4): the integration is the
// authenticated link to the account, the connector is the optional "and it answers on its own"
// behaviour layered on top. Nullable and additive — a connector with inline config keeps working
// untouched, which is what makes this migration safe to ship to live instances.
try { db.exec('ALTER TABLE instances ADD COLUMN integration_id TEXT'); } catch (_) { /* already present */ }

const _all = db.prepare('SELECT * FROM instances ORDER BY created_at');
const _get = db.prepare('SELECT * FROM instances WHERE id = ?');
const _ins = db.prepare('INSERT INTO instances (id,type,name,config_json,enabled,integration_id,created_at,updated_at) VALUES (@id,@type,@name,@config_json,@enabled,@integration_id,@now,@now)');
const _del = db.prepare('DELETE FROM instances WHERE id = ?');

function hydrate(row) {
  if (!row) return null;
  return { id: row.id, type: row.type, name: row.name, config: JSON.parse(row.config_json), enabled: !!row.enabled, integration_id: row.integration_id || null, created_at: row.created_at, updated_at: row.updated_at };
}

function list() { return _all.all().map(hydrate); }
function get(id) { return hydrate(_get.get(id)); }

function create({ type, name, config = {}, enabled = false, integration_id = null }) {
  const id = crypto.randomUUID();
  const now = Date.now();
  _ins.run({ id, type, name: name || type, config_json: JSON.stringify(config), enabled: enabled ? 1 : 0, integration_id: integration_id || null, now });
  return get(id);
}

function update(id, fields) {
  const row = get(id);
  if (!row) return null;
  const name = fields.name != null ? fields.name : row.name;
  const config = fields.config != null ? fields.config : row.config;
  const enabled = fields.enabled != null ? (fields.enabled ? 1 : 0) : (row.enabled ? 1 : 0);
  // `integration_id: null` is a meaningful value (detach), so distinguish "absent" from "null".
  const integration_id = Object.prototype.hasOwnProperty.call(fields, 'integration_id')
    ? (fields.integration_id || null) : row.integration_id;
  db.prepare('UPDATE instances SET name=?, config_json=?, enabled=?, integration_id=?, updated_at=? WHERE id=?')
    .run(name, JSON.stringify(config), enabled, integration_id, Date.now(), id);
  return get(id);
}

function remove(id) { return _del.run(id).changes > 0; }

module.exports = { db, list, get, create, update, remove, DB_PATH };
