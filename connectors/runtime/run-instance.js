#!/usr/bin/env node
'use strict';
require('../../shared/loadenv'); // child process: load <repo>/.env (secret provider, etc.)
/**
 * asmltr connector runtime harness — runs ONE connector instance as its own
 * process. The manager spawns this with the instance's type/id/name/config in
 * env. Loads the type plugin, builds ctx, start()s it, and shuts it down cleanly
 * on SIGTERM/SIGINT.
 *
 * Env: ASMLTR_CONNECTOR_TYPE, _ID, _NAME, _CONFIG(json), ASMLTR_CORE_URL,
 *      ASMLTR_COLLECTOR_URL, ASMLTR_INSIGHTS_TOKEN
 */

const path = require('path');
const { buildContext } = require('../sdk');

const type = process.env.ASMLTR_CONNECTOR_TYPE;
const instanceId = process.env.ASMLTR_CONNECTOR_ID;
const instanceName = process.env.ASMLTR_CONNECTOR_NAME || instanceId;
const config = JSON.parse(process.env.ASMLTR_CONNECTOR_CONFIG || '{}');
const coreUrl = process.env.ASMLTR_CORE_URL || 'http://127.0.0.1:3023/v2/handle';
const collectorUrl = process.env.ASMLTR_COLLECTOR_URL || 'http://127.0.0.1:3017/ingest';
const token = process.env.ASMLTR_INSIGHTS_TOKEN || '';

if (!type || !instanceId) {
  console.error('run-instance: ASMLTR_CONNECTOR_TYPE and _ID are required');
  process.exit(2);
}

async function main() {
  let plugin;
  try {
    const found = require('../../shared/plugin-dirs').resolveType(type);
    if (!found) throw new Error(`type '${type}' not found under connectors/types or integrations/types`);
    plugin = require(found.path);
  } catch (e) {
    console.error(`run-instance: cannot load type '${type}':`, e.message);
    process.exit(2);
  }
  if (typeof plugin.start !== 'function') {
    console.error(`run-instance: type '${type}' has no start(ctx)`);
    process.exit(2);
  }

  const abort = new AbortController();
  const ctx = buildContext({ instanceId, instanceName, type, config, coreUrl, collectorUrl, token, signal: abort.signal });

  let handle;
  try {
    handle = await plugin.start(ctx);
  } catch (e) {
    console.error(`run-instance: ${type}:${instanceName} start failed:`, e.message);
    process.exit(1);
  }
  ctx.log('started');

  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    ctx.log(`shutting down (${sig})`);
    // Hard deadline: never hang on a stuck handle.stop() (e.g. an HTTP server that won't
    // close because of open keep-alive sockets). Orphaned children hold the channel
    // connection with STALE code after a restart, which strands updates.
    setTimeout(() => process.exit(0), 2000).unref();
    abort.abort();
    try { if (handle && handle.stop) await handle.stop(); } catch (e) { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // simple liveness ping to stdout so the manager can scrape health if desired
  if (handle && handle.health) {
    setInterval(() => { /* health available via handle; manager uses process liveness + logs */ }, 60000);
  }
}

main().catch((e) => { console.error('run-instance fatal:', e); process.exit(1); });
