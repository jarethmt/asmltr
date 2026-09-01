'use strict';

function cloneArgv(full, dir) {
  return ['clone', '--quiet', '--depth', '1', `https://github.com/${full}.git`, dir];
}

/** Git HTTPS wants Basic x-access-token, not API Bearer. Never put the PAT on argv. */
function gitAuthHeader(pat) {
  const token = String(pat || '').trim();
  if (!token) return '';
  return 'Authorization: Basic ' + Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
}

function cloneGitEnv(pat, baseEnv) {
  const env = { ...(baseEnv || process.env), GIT_TERMINAL_PROMPT: '0' };
  const header = gitAuthHeader(pat);
  if (header) {
    // Wipe host gh/git helpers so this clone is the connector PAT, not ~/.gitconfig.
    env.GIT_CONFIG_COUNT = '3';
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraHeader';
    env.GIT_CONFIG_VALUE_0 = header;
    env.GIT_CONFIG_KEY_1 = 'credential.helper';
    env.GIT_CONFIG_VALUE_1 = '';
    env.GIT_CONFIG_KEY_2 = 'credential.https://github.com.helper';
    env.GIT_CONFIG_VALUE_2 = '';
  }
  return env;
}

function githubIdentityPrompt({ name, acct, patKey, issueNumber, full }) {
  return `GITHUB IDENTITY (CRITICAL): on this repo you act ONLY as ${acct}. The host's default gh/git auth may be a DIFFERENT, unauthorized account — NEVER use it here. For ANY GitHub operation, authenticate as ${acct} using this connector's PAT from the secret store key '${patKey}' (do not print the token, do not put it on a command line, do not export a token into the environment or argv). If you cannot authenticate as ${acct}, do NOT fall back to another account — say so and stop.`;
}

module.exports = { cloneArgv, cloneGitEnv, gitAuthHeader, githubIdentityPrompt };
