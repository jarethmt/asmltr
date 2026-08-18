'use strict';
/**
 * Node 24.19.0 ObjectWrap dtor calls RemoveEnvironmentCleanupHook during GC
 * when Environment::GetCurrent() is nullptr (common while loading large
 * modules). better-sqlite3 Statement is an ObjectWrap; a throwaway
 * db.prepare()/db.pragma() collected mid-load ABRTs the process.
 *
 * Keep every Statement created during startup so V8 cannot collect it
 * until after listen. disarm() after listen so later prepares can GC
 * on the event loop (env is current then).
 */
const keep = [];
let armed = true;

function wrapBetterSqlite3(exported) {
  if (!exported || typeof exported !== 'function' || exported.__asmltrStmtKeep) return exported;
  const orig = exported.prototype && exported.prototype.prepare;
  if (typeof orig !== 'function') return exported;
  exported.prototype.prepare = function prepareWrapped(sql) {
    const stmt = orig.call(this, sql);
    if (armed && stmt) keep.push(stmt);
    return stmt;
  };
  const origPragma = exported.prototype.pragma;
  if (typeof origPragma === 'function') {
    exported.prototype.pragma = function pragmaWrapped(source, options) {
      const result = origPragma.call(this, source, options);
      return result;
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

function disarm() { armed = false; }

module.exports = { keep, disarm };
