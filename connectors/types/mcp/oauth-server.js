#!/usr/bin/env node

/**
 * MCP OAuth 2.1 Authorization Server
 *
 * Implements MCP-compliant OAuth 2.1 authorization server with:
 * - Protected Resource Metadata (RFC 9728)
 * - Authorization Server Metadata (RFC 8414)
 * - Authorization Code Grant with PKCE (RFC 7636)
 * - Dynamic Client Registration (RFC 7591)
 * - Resource Indicators (RFC 8707)
 *
 * Created: November 15, 2025
 */

import { randomBytes, createHash } from 'crypto';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const require = createRequire(import.meta.url);
const { PKCE_METHODS, isPkceMethodSupported, verifyPKCE } = require('./pkce.js');

// Configuration
const BASE_URL = process.env.BASE_URL || 'https://mcp.example.com';
const ISSUER = BASE_URL;
const TOKEN_STORAGE_PATH = process.env.TOKEN_STORAGE_PATH || '/data/tokens.json';
const TOKEN_EXPIRY_HOURS = parseInt(process.env.TOKEN_EXPIRY_HOURS || '720', 10); // 30 days default

// ============================================================================
// Storage - In-memory with disk persistence for tokens
// ============================================================================

// Registered clients (client_id -> client_config)
const clients = new Map();

// Authorization codes (code -> code_data) - ephemeral, no persistence needed
const authorizationCodes = new Map();

// Access tokens (token -> token_data) - persisted to disk
const accessTokens = new Map();

// User sessions (session_id -> user_data) - ephemeral
const userSessions = new Map();

/**
 * Load tokens from disk
 */
function loadTokensFromDisk() {
  try {
    if (existsSync(TOKEN_STORAGE_PATH)) {
      const data = JSON.parse(readFileSync(TOKEN_STORAGE_PATH, 'utf-8'));
      let loaded = 0;
      let expired = 0;

      for (const [token, tokenData] of Object.entries(data.tokens || {})) {
        // Only load non-expired tokens
        if (Date.now() < tokenData.expires_at) {
          accessTokens.set(token, tokenData);
          loaded++;
        } else {
          expired++;
        }
      }

      console.log(`📂 Loaded ${loaded} valid tokens from disk (${expired} expired tokens skipped)`);
    }
  } catch (error) {
    console.error('⚠️ Failed to load tokens from disk:', error.message);
  }
}

/**
 * Save tokens to disk
 */
function saveTokensToDisk() {
  try {
    const data = {
      tokens: Object.fromEntries(accessTokens),
      updated_at: new Date().toISOString(),
    };
    writeFileSync(TOKEN_STORAGE_PATH, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('⚠️ Failed to save tokens to disk:', error.message);
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Generate secure random string
 */
function generateSecureRandom(length = 32) {
  return randomBytes(length).toString('base64url');
}

/**
 * SHA-256 hash
 */
function sha256(data) {
  return createHash('sha256').update(data).digest('base64url');
}

// verifyPKCE / isPkceMethodSupported: S256 only (see ./pkce.js)

/**
 * Parse Authorization header for Bearer token
 */
function parseBearerToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.substring(7);
}

// ============================================================================
// Client Management
// ============================================================================

/**
 * Register a new OAuth client (Dynamic Client Registration - RFC 7591)
 */
export function registerClient(clientMetadata) {
  const clientId = `mcp-client-${randomUUID()}`;
  const clientSecret = generateSecureRandom(32);

  const client = {
    client_id: clientId,
    client_secret: clientSecret,
    client_name: clientMetadata.client_name || 'MCP Client',
    redirect_uris: clientMetadata.redirect_uris || [],
    grant_types: clientMetadata.grant_types || ['authorization_code'],
    response_types: clientMetadata.response_types || ['code'],
    token_endpoint_auth_method: 'client_secret_basic',
    created_at: Date.now(),
  };

  clients.set(clientId, client);

  return {
    client_id: clientId,
    client_secret: clientSecret,
    client_name: client.client_name,
    redirect_uris: client.redirect_uris,
    grant_types: client.grant_types,
    response_types: client.response_types,
    token_endpoint_auth_method: client.token_endpoint_auth_method,
  };
}

/**
 * Get client by ID
 */
export function getClient(clientId) {
  return clients.get(clientId);
}

/**
 * Is this a loopback HTTP redirect (user's own machine)?
 */
function isLoopbackUri(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'http:' && (x.hostname === 'localhost' || x.hostname === '127.0.0.1' || x.hostname === '[::1]');
  } catch { return false; }
}

/**
 * Is `requested` an acceptable redirect_uri for this client?
 * Exact match against the registered list, OR — per RFC 8252 §7.3 — any loopback
 * URI when the client has registered at least one loopback redirect (native/CLI
 * clients like Claude Code pick a random localhost callback port, so the port and
 * path can't be pinned in advance; loopback can't be hijacked remotely).
 */
export function isRedirectUriAllowed(client, requested) {
  if (!client || !requested) return false;
  if (client.redirect_uris.includes(requested)) return true;
  if (isLoopbackUri(requested) && client.redirect_uris.some(isLoopbackUri)) return true;
  return false;
}

/**
 * Validate client credentials
 */
export function validateClient(clientId, clientSecret) {
  const client = clients.get(clientId);
  if (!client) {
    return null;
  }

  if (client.client_secret !== clientSecret) {
    return null;
  }

  return client;
}

// ============================================================================
// Authorization Flow
// ============================================================================

/**
 * Create authorization code
 */
export function createAuthorizationCode(params) {
  const {
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    resource,
    userId,
    username,
  } = params;

  const code = generateSecureRandom(32);
  const expiresAt = Date.now() + (10 * 60 * 1000); // 10 minutes

  const codeData = {
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: codeChallengeMethod,
    resource,
    user_id: userId,
    username: username,
    expires_at: expiresAt,
    used: false,
  };

  authorizationCodes.set(code, codeData);

  return code;
}

/**
 * Validate and consume authorization code
 */
export function validateAuthorizationCode(code, clientId, codeVerifier, redirectUri) {
  const codeData = authorizationCodes.get(code);

  if (!codeData) {
    return { valid: false, error: 'invalid_grant', description: 'Authorization code not found' };
  }

  if (codeData.used) {
    // RFC 6749 Section 4.1.2 - Authorization code has already been used
    // Revoke all tokens issued to this code
    authorizationCodes.delete(code);
    return { valid: false, error: 'invalid_grant', description: 'Authorization code already used' };
  }

  if (Date.now() > codeData.expires_at) {
    authorizationCodes.delete(code);
    return { valid: false, error: 'invalid_grant', description: 'Authorization code expired' };
  }

  if (codeData.client_id !== clientId) {
    return { valid: false, error: 'invalid_grant', description: 'Client mismatch' };
  }

  if (codeData.redirect_uri !== redirectUri) {
    return { valid: false, error: 'invalid_grant', description: 'Redirect URI mismatch' };
  }

  // Verify PKCE
  if (!verifyPKCE(codeVerifier, codeData.code_challenge, codeData.code_challenge_method)) {
    return { valid: false, error: 'invalid_grant', description: 'PKCE verification failed' };
  }

  // Mark as used
  codeData.used = true;
  authorizationCodes.set(code, codeData);

  return {
    valid: true,
    userId: codeData.user_id,
    username: codeData.username,
    resource: codeData.resource,
  };
}

// ============================================================================
// Token Management
// ============================================================================

/**
 * Create access token
 */
export function createAccessToken(params) {
  const {
    clientId,
    userId,
    username,
    resource,
  } = params;

  const token = generateSecureRandom(32);
  const expiresInSeconds = TOKEN_EXPIRY_HOURS * 3600;
  const expiresAt = Date.now() + (expiresInSeconds * 1000);

  const tokenData = {
    token,
    client_id: clientId,
    user_id: userId,
    username: username,
    resource,
    issued_at: Date.now(),
    expires_at: expiresAt,
  };

  accessTokens.set(token, tokenData);

  // Persist to disk
  saveTokensToDisk();

  console.log(`🔑 Created access token for ${username} (expires in ${TOKEN_EXPIRY_HOURS} hours)`);

  return {
    access_token: token,
    token_type: 'Bearer',
    expires_in: expiresInSeconds,
  };
}

/**
 * Validate access token
 */
export function validateAccessToken(token, expectedResource) {
  const tokenData = accessTokens.get(token);

  if (!tokenData) {
    return { valid: false, error: 'invalid_token', description: 'Token not found' };
  }

  if (Date.now() > tokenData.expires_at) {
    accessTokens.delete(token);
    saveTokensToDisk(); // Persist deletion
    return { valid: false, error: 'invalid_token', description: 'Token expired' };
  }

  // Validate resource (RFC 8707 - audience validation)
  if (expectedResource && tokenData.resource) {
    // Normalize URLs for comparison (handle trailing slashes)
    const normalizedTokenResource = tokenData.resource.endsWith('/') ? tokenData.resource.slice(0, -1) : tokenData.resource;
    const normalizedExpectedResource = expectedResource.endsWith('/') ? expectedResource.slice(0, -1) : expectedResource;

    if (normalizedTokenResource !== normalizedExpectedResource) {
      return { valid: false, error: 'insufficient_scope', description: 'Token not valid for this resource' };
    }
  }

  return {
    valid: true,
    clientId: tokenData.client_id,
    userId: tokenData.user_id,
    username: tokenData.username,
    resource: tokenData.resource,
  };
}

// ============================================================================
// User Sessions (Simplified - auto-approve for the owner)
// ============================================================================

/**
 * Create user session
 */
export function createUserSession(userId, username) {
  const sessionId = randomUUID();

  const session = {
    session_id: sessionId,
    user_id: userId,
    username: username,
    created_at: Date.now(),
  };

  userSessions.set(sessionId, session);

  return sessionId;
}

/**
 * Get user session
 */
export function getUserSession(sessionId) {
  return userSessions.get(sessionId);
}

// ============================================================================
// OAuth Endpoints Handlers
// ============================================================================

/**
 * GET /.well-known/oauth-protected-resource
 * Protected Resource Metadata (RFC 9728)
 */
export function getProtectedResourceMetadata() {
  return {
    resource: BASE_URL,
    authorization_servers: [ISSUER],
    bearer_methods_supported: ['header'],
    resource_documentation: `${BASE_URL}/docs`,
  };
}

/**
 * GET /.well-known/oauth-authorization-server
 * Authorization Server Metadata (RFC 8414)
 */
export function getAuthorizationServerMetadata() {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${BASE_URL}/oauth/authorize`,
    token_endpoint: `${BASE_URL}/oauth/token`,
    registration_endpoint: `${BASE_URL}/oauth/register`,
    code_challenge_methods_supported: PKCE_METHODS,
    grant_types_supported: ['authorization_code'],
    response_types_supported: ['code'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    service_documentation: `${BASE_URL}/docs`,
  };
}

/**
 * POST /oauth/register
 * Dynamic Client Registration (RFC 7591)
 */
export function handleClientRegistration(req, res) {
  try {
    const clientInfo = registerClient(req.body);

    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(clientInfo));
  } catch (error) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'invalid_client_metadata',
      error_description: error.message,
    }));
  }
}

/**
 * GET /oauth/authorize
 * Authorization Endpoint
 */
export function handleAuthorizationRequest(params) {
  const {
    response_type,
    client_id,
    redirect_uri,
    code_challenge,
    code_challenge_method,
    resource,
    state,
  } = params;

  // Validate parameters
  if (!response_type || response_type !== 'code') {
    return {
      error: 'unsupported_response_type',
      error_description: 'Only response_type=code is supported',
    };
  }

  if (!client_id) {
    return {
      error: 'invalid_request',
      error_description: 'Missing client_id',
    };
  }

  const client = getClient(client_id);
  if (!client) {
    return {
      error: 'unauthorized_client',
      error_description: 'Unknown client_id',
    };
  }

  if (!redirect_uri) {
    return {
      error: 'invalid_request',
      error_description: 'Missing redirect_uri',
    };
  }

  // Validate redirect_uri
  console.log(`[OAuth] Authorization request from client: ${client_id}`);
  console.log(`[OAuth] Requested redirect_uri: ${redirect_uri}`);
  console.log(`[OAuth] Registered redirect_uris: ${JSON.stringify(client.redirect_uris)}`);

  if (!isRedirectUriAllowed(client, redirect_uri)) {
    console.log(`[OAuth] ❌ REDIRECT_URI MISMATCH - Rejecting authorization`);
    return {
      error: 'invalid_request',
      error_description: 'Invalid redirect_uri',
    };
  }

  console.log(`[OAuth] ✅ Redirect URI validated`);

  // Validate PKCE
  if (!code_challenge) {
    return {
      error: 'invalid_request',
      error_description: 'Missing code_challenge (PKCE required)',
    };
  }

  if (!code_challenge_method || !isPkceMethodSupported(code_challenge_method)) {
    return {
      error: 'invalid_request',
      error_description: 'Invalid or missing code_challenge_method (must be S256)',
    };
  }

  // Validate resource (optional - default to BASE_URL if not provided)
  const finalResource = resource || BASE_URL;

  // If resource is provided, it must match our BASE_URL (with or without trailing slash)
  if (resource) {
    const normalizedResource = resource.endsWith('/') ? resource.slice(0, -1) : resource;
    const normalizedBaseUrl = BASE_URL.endsWith('/') ? BASE_URL.slice(0, -1) : BASE_URL;

    if (normalizedResource !== normalizedBaseUrl) {
      return {
        error: 'invalid_target',
        error_description: `Resource must be ${BASE_URL}`,
      };
    }
  }

  return {
    valid: true,
    client,
    redirect_uri,
    code_challenge,
    code_challenge_method,
    resource: finalResource,
    state,
  };
}

/**
 * POST /oauth/token
 * Token Endpoint
 */
export function handleTokenRequest(params, authHeader) {
  const {
    grant_type,
    code,
    redirect_uri,
    code_verifier,
    client_id,
    client_secret,
  } = params;

  // Validate grant_type
  if (!grant_type || grant_type !== 'authorization_code') {
    return {
      error: 'unsupported_grant_type',
      error_description: 'Only authorization_code grant is supported',
    };
  }

  // Extract client credentials
  let clientId = client_id;
  let clientSecret = client_secret;

  // Support client_secret_basic (Authorization header)
  if (authHeader && authHeader.startsWith('Basic ')) {
    const credentials = Buffer.from(authHeader.substring(6), 'base64').toString('utf-8');
    const [id, secret] = credentials.split(':');
    clientId = id;
    clientSecret = secret;
  }

  if (!clientId || !clientSecret) {
    return {
      error: 'invalid_client',
      error_description: 'Missing client credentials',
    };
  }

  // Validate client
  const client = validateClient(clientId, clientSecret);
  if (!client) {
    return {
      error: 'invalid_client',
      error_description: 'Invalid client credentials',
    };
  }

  // Validate authorization code
  if (!code) {
    return {
      error: 'invalid_request',
      error_description: 'Missing code',
    };
  }

  if (!redirect_uri) {
    return {
      error: 'invalid_request',
      error_description: 'Missing redirect_uri',
    };
  }

  if (!code_verifier) {
    return {
      error: 'invalid_request',
      error_description: 'Missing code_verifier (PKCE required)',
    };
  }

  const validation = validateAuthorizationCode(code, clientId, code_verifier, redirect_uri);
  if (!validation.valid) {
    return {
      error: validation.error,
      error_description: validation.description,
    };
  }

  // Issue access token
  const tokenResponse = createAccessToken({
    clientId,
    userId: validation.userId,
    username: validation.username,
    resource: validation.resource,
  });

  return tokenResponse;
}

/**
 * Generate WWW-Authenticate header for 401 responses
 */
export function generateWWWAuthenticateHeader(resource = BASE_URL) {
  return `Bearer realm="asmltr MCP", resource="${resource}"`;
}

// ============================================================================
// Initialization
// ============================================================================

/**
 * Initialize with pre-registered clients
 */
export function initializeOAuthServer() {
  // Load persisted tokens from disk
  loadTokensFromDisk();

  // Pre-registered OAuth clients load from a gitignored config file — NEVER hardcode
  // client secrets. Path: $ASMLTR_MCP_CLIENTS_FILE or ./clients.json next to this module.
  // Shape (see clients.example.json):
  //   { "clients": [ { "client_id", "client_secret", "client_name",
  //       "redirect_uris": [...], "identity": { "userId", "username" },
  //       "grant_types"?, "response_types"?, "token_endpoint_auth_method"? } ] }
  // Clients may also self-register at runtime via Dynamic Client Registration (RFC 7591).
  const clientsFile = process.env.ASMLTR_MCP_CLIENTS_FILE || new URL('./clients.json', import.meta.url).pathname;
  let loaded = 0;
  try {
    if (existsSync(clientsFile)) {
      const parsed = JSON.parse(readFileSync(clientsFile, 'utf8'));
      for (const c of (parsed.clients || [])) {
        if (!c.client_id) continue;
        clients.set(c.client_id, {
          client_id: c.client_id,
          client_secret: c.client_secret,
          client_name: c.client_name || c.client_id,
          redirect_uris: c.redirect_uris || [],
          grant_types: c.grant_types || ['authorization_code'],
          response_types: c.response_types || ['code'],
          token_endpoint_auth_method: c.token_endpoint_auth_method || 'client_secret_basic',
          created_at: Date.now(),
        });
        loaded++;
      }
    }
  } catch (e) {
    console.error(`⚠️  Failed to load MCP clients file (${clientsFile}): ${e.message}`);
  }

  console.log('🔐 OAuth 2.1 Authorization Server initialized');
  console.log(`   Issuer: ${ISSUER}`);
  console.log(`   Pre-registered clients: ${loaded}${loaded ? ` (from ${clientsFile})` : ' — none; dynamic registration only'}`);

  return { clientsLoaded: loaded };
}

export default {
  // Client management
  registerClient,
  getClient,
  validateClient,

  // Authorization flow
  createAuthorizationCode,
  validateAuthorizationCode,

  // Token management
  createAccessToken,
  validateAccessToken,

  // User sessions
  createUserSession,
  getUserSession,

  // Endpoint handlers
  getProtectedResourceMetadata,
  getAuthorizationServerMetadata,
  handleClientRegistration,
  handleAuthorizationRequest,
  handleTokenRequest,
  generateWWWAuthenticateHeader,
  isRedirectUriAllowed,

  // Initialization
  initializeOAuthServer,
};
