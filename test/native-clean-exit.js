'use strict';

// better-sqlite3 keeps native Statement objects alive for the life of a test file's process (a store
// like core/src/sessions.js holds ~20 module-level prepared statements). When `node --test` tears the
// worker's V8 environment down with them still live, each Statement destructor calls the addon's
// RemoveEnvironmentCleanupHook against an environment that is already gone and aborts with
// "Assertion failed: (env) != nullptr" — an intermittent CI crash that fails a file whose every test
// passed (Node 24 + better-sqlite3 11.x; the stack is Statement::~Statement → RemoveEnvironmentCleanupHook).
//
// Closing the db does not help: the abort is the C++ wrapper's destructor at heap teardown, which GC
// controls, not the sqlite handle. 'beforeExit' fires after the test runner has finished and set
// process.exitCode, but before that teardown runs; exiting there terminates the process first, so the
// destructors never run. process.exitCode carries a real test failure through, so this changes only the
// exit path, not the pass/fail result. Call it once from any test that imports a better-sqlite3 store.
let armed = false;
function armCleanNativeExit() {
  if (armed) return;
  armed = true;
  process.on('beforeExit', () => process.exit(process.exitCode || 0));
}

module.exports = { armCleanNativeExit };
