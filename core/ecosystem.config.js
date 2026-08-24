// PM2 config for asmltr-core.
// MUST run on the host (not Docker). Grok engine: needs Node >= 24 (set interpreter
// or ASMLTR_NODE if system node is too old), grok CLI on PATH, ~/.grok/auth.json.
// Bind 127.0.0.1. Do NOT start the connector manager for a localhost-only core.
// Port/URLs come from the environment (see env.ivy.example); defaults below.
module.exports = {
  apps: [
    {
      name: 'asmltr-core',
      script: 'src/server.js',
      cwd: __dirname,
      interpreter: process.env.ASMLTR_NODE || process.execPath,
      instances: 1,
      autorestart: true,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        ASMLTR_CORE_PORT: process.env.ASMLTR_CORE_PORT || '3023',
        ASMLTR_COLLECTOR_URL: process.env.ASMLTR_COLLECTOR_URL || 'http://127.0.0.1:3017/ingest',
        ASMLTR_MANAGER_URL: process.env.ASMLTR_MANAGER_URL || 'http://127.0.0.1:3024',
        // NOTE: do NOT set XAI_API_KEY — grok stays on the CLI subscription.
      },
      // logs default to ~/.pm2/logs/asmltr-core-{out,error}.log
    },
  ],
};
