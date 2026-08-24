'use strict';
/**
 * Node 24.19.0 ObjectWrap dtor calls RemoveEnvironmentCleanupHook during GC
 * when Environment::GetCurrent() is nullptr. better-sqlite3 Statement is an
 * ObjectWrap; a throwaway db.prepare() collected during grok heap growth
 * ABRTs the process. Post-listen GC still has env==nullptr — keep-until-listen
 * was insufficient.
 *
 * Keep and reuse Statements for the process lifetime. Cache by SQL string
 * (per Database) so the same query reuses one Statement and we do not leak
 * an unbounded array of duplicates. armed stays true; disarm() is a no-op.
 */
const keep = new Map(); // sql -> Statement (inspectable union of SQL strings)
const byDb = new WeakMap(); // Database -> Map(sql -> Statement)
let armed = true;

function cacheFor(db) {
  let m = byDb.get(db);
  if (!m) {
    m = new Map();
    byDb.set(db, m);
  }
  return m;
}

function wrapBetterSqlite3(exported) {
  if (!exported || typeof exported !== 'function' || exported.__asmltrStmtKeep) return exported;
  const orig = exported.prototype && exported.prototype.prepare;
  if (typeof orig !== 'function') return exported;
  exported.prototype.prepare = function prepareWrapped(sql) {
    const key = String(sql);
    const cache = cacheFor(this);
    const hit = cache.get(key);
    if (hit) return hit;
    const stmt = orig.call(this, sql);
    if (armed && stmt) {
      cache.set(key, stmt);
      keep.set(key, stmt);
    }
    return stmt;
  };
  const origPragma = exported.prototype.pragma;
  if (typeof origPragma === 'function') {
    exported.prototype.pragma = function pragmaWrapped(source, options) {
      return origPragma.call(this, source, options);
    };
  }
  exported.__asmltrStmtKeep = true;
  return exported;
}

const Module = require('module');
const origLoad = Module._load;
Module._load = function asmltrStmtKeepLoad(request, parent, isMain) {
  const exported = origLoad.apply(this, arguments);
  if (request === 'better-sqlite3') wrapBetterSqlite3(exported);
  return exported;
};

try {
  const resolved = require.resolve('better-sqlite3');
  const cached = require.cache[resolved];
  if (cached && cached.exports) wrapBetterSqlite3(cached.exports);
} catch (_) {}

function disarm() { /* never: post-listen GC during grok heap growth still has env==nullptr */ }

module.exports = { keep, disarm };
