'use strict';
/**
 * asmltr connector type: MCP (Model Context Protocol).
 *
 * Ports an MCP server (HTTP/SSE + OAuth 2.1) onto the connector
 * platform. Transport + OAuth stay here (that's HOW MCP works): the SSE server,
 * the OAuth 2.1 authorization server (RFC 8414/9728/7636/8707, PKCE,
 * pre-registered clients, token validation) and the consent page are all carried
 * over unchanged from the prior MCP server implementation.
 *
 * The ONE behavioral change: `ask_oracle` no longer builds a hardcoded system
 * prompt (the MCP warning + client/owner boundary blocks) and POSTs the query
 * proxy. Instead it builds a normalized envelope and calls ctx.core.handle().
 * The core's trust framework + channel-awareness now own identity/authz/medium-
 * context, so NO systemPrompt is sent at all. Each OAuth client maps to a userId
 * (via its `identity` in clients.json) which flows through as the envelope sender
 * so the core resolves trust from it.
 *
 * conversation_key = mcp:<instanceId>:user:<userId>
 *
 * ESM/CJS: the MCP SDK + oauth-server.js are ESM; this plugin is CommonJS, so
 * `meta` is a plain synchronous CJS export (the manager reads it via require())
 * and everything ESM is loaded with dynamic import() inside start().
 *
 * Binds 127.0.0.1 on config.port (default 3018) — Traefik fronts the public
 * domain. BASE_URL comes from config.base_url.
 */

const { randomUUID, createHash } = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');
const NAME = process.env.ASSISTANT_NAME || 'the assistant'; // shown in the MCP tool description

const meta = {
  type: 'mcp',
  displayName: 'MCP (Model Context Protocol)',
  supportsMultiple: true,
  credentialKeys: [],
  identifierFormats: [{ surface: 'mcp', label: 'OAuth user id', placeholder: 'owner' }],
  configSchema: {
    type: 'object',
    properties: {
      port: { type: 'integer', title: 'HTTP port', default: 3018 },
      bind_host: { type: 'string', title: 'Bind address', default: '127.0.0.1' },
      base_url: { type: 'string', title: 'Public base URL', default: 'https://mcp.example.com' },
    },
  },
};

/**
 * Map a pre-registered OAuth client_id → { userId, username }.
 * Loaded from the same gitignored clients file the OAuth server uses (each client's
 * optional `identity` field). userId becomes clientIdentity.userId → the envelope
 * sender → the core's trust. Unknown clients resolve to 'unknown' (default-deny).
 */
let _clientIdentities = null;
function loadClientIdentities() {
  if (_clientIdentities) return _clientIdentities;
  _clientIdentities = new Map();
  try {
    const p = process.env.ASMLTR_MCP_CLIENTS_FILE || path.join(__dirname, 'clients.json');
    const parsed = JSON.parse(require('fs').readFileSync(p, 'utf8'));
    for (const c of (parsed.clients || [])) {
      const id = c.identity || {};
      _clientIdentities.set(c.client_id, {
        userId: id.userId || c.client_id,
        username: id.username || id.userId || c.client_id,
      });
    }
  } catch (_) { /* no file → all clients resolve unknown */ }
  return _clientIdentities;
}
function clientToIdentity(clientId) {
  return loadClientIdentities().get(clientId) || { userId: 'unknown', username: 'unknown' };
}

const ASK_ORACLE_TOOL = {
  name: 'ask_oracle',
  description: `Ask ${NAME}, an AI assistant with deep reasoning and research capabilities. Use this for:\n` +
    '- Information queries that require search, memory, or research\n' +
    '- Complex reasoning and analysis\n' +
    '- Accessing accumulated knowledge and context\n' +
    '- Technical questions and problem-solving\n' +
    '- Any task requiring in-depth thinking\n\n' +
    `Note: Responses may take 5-60 seconds as ${NAME} conducts thorough research.`,
  inputSchema: {
    type: 'object',
    properties: { question: { type: 'string', description: `The question or request to send to ${NAME}` } },
    required: ['question'],
  },
};

async function start(ctx) {
  const cfg = ctx.config || {};
  const PORT = cfg.port || 3018;
  // Bind 127.0.0.1 by default (the asmltr principle). For the public instance we
  // bind the docker-bridge gateway IP (e.g. 172.18.0.1) so Traefik — which lives
  // on that network — can reach us WITHOUT exposing the port on the host's public
  // NIC (the box has a public IP + ACCEPT iptables policy, so 0.0.0.0 would leak).
  const BIND = cfg.bind_host || '127.0.0.1';
  const BASE_URL = cfg.base_url || 'https://mcp.example.com';

  // oauth-server.js reads BASE_URL + TOKEN_STORAGE_PATH from env at module-load
  // time, so set them BEFORE importing it. One token store per instance.
  process.env.BASE_URL = BASE_URL;
  if (!process.env.TOKEN_STORAGE_PATH) {
    const dataDir = path.join(__dirname, '..', '..', 'manager', 'data');
    try { fs.mkdirSync(dataDir, { recursive: true }); } catch (_) {}
    process.env.TOKEN_STORAGE_PATH = path.join(dataDir, `mcp-tokens-${ctx.instanceId}.json`);
  }

  // --- ESM deps via dynamic import() ----------------------------------------
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { SSEServerTransport } = await import('@modelcontextprotocol/sdk/server/sse.js');
  const { CallToolRequestSchema, ListToolsRequestSchema } =
    await import('@modelcontextprotocol/sdk/types.js');
  const oauthServer = (await import('./oauth-server.js')).default;

  // init OAuth (loads persisted tokens + registers pre-registered clients)
  oauthServer.initializeOAuthServer();

  const sessions = new Map();      // transport.sessionId -> { mcpServer, transport, clientIdentity }
  const userToSession = new Map(); // userId -> transport.sessionId (one live SSE per user)
  let msgCounter = 0;

  /**
   * The behavioral change: route the question through asmltr-core instead of the
   * query proxy + hardcoded prompt. Returns the reply text.
   */
  async function askOracle(question, clientIdentity) {
    const convKey = `mcp:${ctx.instanceId}:user:${clientIdentity.userId}`;
    ctx.emit({
      event_type: 'inbound',
      session_id: convKey,
      identity: clientIdentity.userId,
      payload: { text: question.slice(0, 200) },
    });
    const actions = await ctx.core.handle({
      channel: 'mcp',
      conversation_key: convKey,
      message_id: String(Date.now()) + '-' + (++msgCounter),
      sender: { raw_id: clientIdentity.userId, raw_username: clientIdentity.username },
      content: { text: question },
      delivery: 'sync',
      public: false, // 1:1 authed client; redaction still applies if the client isn't full-trust
      context: { scope_name: 'MCP' },
    });
    const reply = (actions || []).find((a) => a.type === 'reply');
    if (!reply) throw new Error('no reply from core');
    return reply.text;
  }

  function createMCPServer(clientIdentity) {
    const server = new Server(
      { name: 'asmltr-mcp', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [ASK_ORACLE_TOOL] }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name !== 'ask_oracle') throw new Error(`Unknown tool: ${request.params.name}`);
      const question = request.params.arguments?.question;
      if (!question || typeof question !== 'string') {
        throw new Error('Question parameter is required and must be a string');
      }
      try {
        const reply = await askOracle(question, clientIdentity);
        return { content: [{ type: 'text', text: reply }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `Oracle Error: ${error.message}` }], isError: true };
      }
    });

    return server;
  }

  // --- HTTP server (OAuth + SSE) — binds 127.0.0.1 --------------------------
  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    ctx.log(`${req.method} ${url.pathname}`);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // --- OAuth 2.1 endpoints -------------------------------------------------
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(oauthServer.getProtectedResourceMetadata()));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(oauthServer.getAuthorizationServerMetadata()));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/oauth/register') {
      let body = '';
      req.on('data', (c) => body += c.toString());
      req.on('end', () => {
        try { req.body = JSON.parse(body); oauthServer.handleClientRegistration(req, res); }
        catch (_) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_request', error_description: 'Invalid JSON' }));
        }
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/oauth/authorize') {
      const params = Object.fromEntries(url.searchParams);
      const result = oauthServer.handleAuthorizationRequest(params);
      if (result.error) {
        const errorUrl = new URL(params.redirect_uri || 'about:blank');
        errorUrl.searchParams.set('error', result.error);
        errorUrl.searchParams.set('error_description', result.error_description);
        if (params.state) errorUrl.searchParams.set('state', params.state);
        res.writeHead(302, { Location: errorUrl.toString() });
        res.end();
        return;
      }
      const consentHtml = fs.readFileSync(path.join(__dirname, 'consent.html'), 'utf-8').replace(/__ASSISTANT__/g, NAME);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(consentHtml);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/oauth/approve') {
      let body = '';
      req.on('data', (c) => body += c.toString());
      req.on('end', async () => {
        try {
          const params = JSON.parse(body);
          if (!params.approved) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'access_denied', error_description: 'User denied authorization' }));
            return;
          }
          // client_id → userId mapping preserved verbatim from the original
          const { userId, username } = clientToIdentity(params.client_id);
          const code = oauthServer.createAuthorizationCode({
            clientId: params.client_id,
            redirectUri: params.redirect_uri,
            codeChallenge: params.code_challenge,
            codeChallengeMethod: params.code_challenge_method,
            resource: params.resource,
            userId,
            username,
          });
          const redirectUrl = new URL(params.redirect_uri);
          redirectUrl.searchParams.set('code', code);
          if (params.state) redirectUrl.searchParams.set('state', params.state);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ redirect_url: redirectUrl.toString() }));
        } catch (error) {
          ctx.log(`[oauth] approve error: ${error.message}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'server_error', error_description: error.message }));
        }
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/oauth/token') {
      let body = '';
      req.on('data', (c) => body += c.toString());
      req.on('end', () => {
        try {
          let params;
          const ct = req.headers['content-type'] || '';
          if (ct.includes('application/x-www-form-urlencoded')) params = Object.fromEntries(new URLSearchParams(body));
          else params = JSON.parse(body);
          const result = oauthServer.handleTokenRequest(params, req.headers.authorization);
          res.writeHead(result.error ? 400 : 200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (error) {
          ctx.log(`[oauth] token error: ${error.message}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'server_error', error_description: error.message }));
        }
      });
      return;
    }

    // --- health (no auth) ----------------------------------------------------
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok', service: 'asmltr-mcp', instance: ctx.instanceId,
        activeSessions: sessions.size, oauth: 'enabled',
      }));
      return;
    }

    // --- MCP endpoints (require OAuth bearer) --------------------------------
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;
    const requiresAuth = url.pathname === '/sse' || url.pathname === '/message' || url.pathname === '/' || url.pathname === '/mcp';

    if (requiresAuth && !token) {
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': oauthServer.generateWWWAuthenticateHeader(BASE_URL),
      });
      res.end(JSON.stringify({ error: 'unauthorized', error_description: 'Bearer token required. See WWW-Authenticate header for details.' }));
      return;
    }

    let clientIdentity = null;
    if (token) {
      const validation = oauthServer.validateAccessToken(token, BASE_URL);
      if (!validation.valid) {
        res.writeHead(401, {
          'Content-Type': 'application/json',
          'WWW-Authenticate': oauthServer.generateWWWAuthenticateHeader(BASE_URL),
        });
        res.end(JSON.stringify({ error: validation.error, error_description: validation.description }));
        return;
      }
      clientIdentity = { userId: validation.userId, username: validation.username };
      ctx.log(`[auth] ${clientIdentity.username} (${clientIdentity.userId})`);
    }

    // --- Streamable HTTP transport (modern clients, e.g. Claude Code) --------
    // The legacy HTTP+SSE transport (below) needs a persistent idle GET stream,
    // which modern fetch/undici-based MCP clients won't hold open (they reconnect
    // every ~3s and never complete a tool call). Streamable HTTP is request/response
    // over POST — each tool call's response returns on its own POST, no idle stream.
    // Stateless: identity comes from the OAuth token, conversation continuity from
    // the core's per-user conversation_key, so no Mcp-Session-Id tracking needed.
    if (url.pathname === '/mcp') {
      if (req.method === 'GET') { res.writeHead(405, { Allow: 'POST' }); res.end(); return; } // no server→client stream
      if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end(); return; }
      let body = '';
      req.on('data', (c) => { body += c.toString(); });
      req.on('end', async () => {
        let msg;
        try { msg = JSON.parse(body); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })); return; }
        // notifications (no id) are fire-and-forget
        if (msg.id === undefined || msg.id === null) { res.writeHead(202); res.end(); return; }
        const send = (payload) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...payload })); };
        const ok = (result) => send({ result });
        const err = (code, message) => send({ error: { code, message } });
        try {
          switch (msg.method) {
            case 'initialize':
              return ok({ protocolVersion: msg.params?.protocolVersion || '2024-11-05', serverInfo: { name: 'asmltr-mcp', version: '1.0.0' }, capabilities: { tools: {} } });
            case 'ping':
              return ok({});
            case 'tools/list':
              return ok({ tools: [ASK_ORACLE_TOOL] });
            case 'tools/call': {
              if (msg.params?.name !== 'ask_oracle') return err(-32602, `Unknown tool: ${msg.params?.name}`);
              const question = msg.params?.arguments?.question;
              if (!question || typeof question !== 'string') return err(-32602, 'Question parameter is required and must be a string');
              // ask_oracle can run for MINUTES (deep research). A single-shot JSON
              // response sends no bytes until done, which trips Claude Code's 60s
              // first-byte budget AND its 5-min idle abort. So stream the response as
              // SSE: headers immediately (beats first-byte), periodic progress (beats
              // idle — progress notifications reset Claude Code's idle timer), then the
              // final JSON-RPC result. (Spec: a POST may answer with text/event-stream.)
              res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
              const sse = (obj) => { try { res.write(`event: message\ndata: ${JSON.stringify(obj)}\n\n`); } catch (_) {} };
              try { res.write(': ack\n\n'); } catch (_) {} // first byte now → beats the 60s first-byte budget
              const progressToken = msg.params?._meta?.progressToken;
              ctx.log(`[mcp] ask_oracle stream (progressToken=${progressToken === undefined ? 'none' : progressToken})`);
              let n = 0;
              const hb = setInterval(() => {
                n += 1;
                if (progressToken !== undefined && progressToken !== null) {
                  sse({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress: n, message: `${NAME} is researching…` } });
                } else {
                  try { res.write(': keepalive\n\n'); } catch (_) {}
                }
              }, 20000);
              try {
                const reply = await askOracle(question, clientIdentity);
                sse({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: reply }] } });
              } catch (e) {
                sse({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `Oracle Error: ${e.message}` }], isError: true } });
              } finally {
                clearInterval(hb);
                try { res.end(); } catch (_) {}
              }
              return;
            }
            default:
              return err(-32601, `Method not found: ${msg.method}`);
          }
        } catch (e) { try { err(-32603, e.message); } catch (_) {} }
      });
      return;
    }

    const isSseRequest = req.method === 'GET' && (url.pathname === '/sse' || url.pathname === '/');
    if (isSseRequest) {
      // one live SSE per user — close any prior connection (conversation continuity
      // is the core's job via the stable conversation_key, not the SDK transport)
      const priorSid = userToSession.get(clientIdentity.userId);
      if (priorSid && sessions.has(priorSid)) {
        const prev = sessions.get(priorSid);
        clearInterval(prev.hb);
        try { await prev.transport.close(); } catch (_) {}
        sessions.delete(priorSid);
      }
      const mcpServer = createMCPServer(clientIdentity);
      const transport = new SSEServerTransport('/message', res);
      await mcpServer.connect(transport); // assigns transport.sessionId, advertised in the endpoint URL
      const sid = transport.sessionId;
      // KEEPALIVE — the client holds this GET stream open, POSTs tool calls to
      // /message?sessionId=<sid>, and reads responses back on THIS stream. An LLM
      // client has multi-second think-time before its first tools/call, so an idle
      // stream must be kept warm or the client/proxy drops it and the session is lost
      // (the delayed POST then 404s — the a client bug, 2026-06-24). Emit an SSE
      // comment heartbeat; ': ...' lines are valid SSE and ignored by clients.
      const HB_MS = Number(ctx.config.heartbeat_ms) || 10000;
      const hb = setInterval(() => { try { res.write(`: hb ${Date.now()}\n\n`); } catch (_) {} }, HB_MS);
      sessions.set(sid, { mcpServer, transport, clientIdentity, hb });
      userToSession.set(clientIdentity.userId, sid);
      transport.onclose = () => {
        clearInterval(hb);
        sessions.delete(sid);
        if (userToSession.get(clientIdentity.userId) === sid) userToSession.delete(clientIdentity.userId);
        ctx.log(`[sse] closed ${sid} (${clientIdentity.userId})`);
      };
      ctx.log(`[sse] open ${sid} (${clientIdentity.userId}, hb=${HB_MS}ms)`);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/message') {
      // route by the transport's sessionId (NOT "first session" — that mis-routes
      // when >1 client is connected, e.g. multiple clients at once)
      const sid = url.searchParams.get('sessionId');
      const session = sid ? sessions.get(sid) : null;
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }
      // a bearer token must not drive another user's session
      if (session.clientIdentity.userId !== clientIdentity.userId) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden', error_description: 'session belongs to a different identity' }));
        return;
      }
      await session.transport.handlePostMessage(req, res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(PORT, BIND, () => { httpServer.removeListener('error', reject); resolve(); });
  });
  ctx.log(`mcp connector started on ${BIND}:${PORT} (base_url=${BASE_URL})`);

  return {
    async stop() {
      for (const [, s] of sessions.entries()) { clearInterval(s.hb); try { await s.transport?.close(); } catch (_) {} }
      await new Promise((resolve) => httpServer.close(() => resolve()));
    },
    health() { return { port: PORT, base_url: BASE_URL, activeSessions: sessions.size }; },
  };
}

module.exports = { meta, start };
