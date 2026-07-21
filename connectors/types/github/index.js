'use strict';
/**
 * asmltr connector type: GITHUB (mention-driven, conversational).
 *
 * the assistant only wakes when a comment or issue body literally contains the mention
 * token (defaults to *<assistant-name>). It is NOT autonomous and never replies to anything
 * untagged. Each issue is a persistent session (conversation_key per issue →
 * the core resumes the SDK session forever), so re-invoking the trigger token on the same
 * issue continues the same conversation.
 *
 * On invocation it posts ONE comment and live-edits it as the turn streams
 * (thinking + tool steps in a collapsed <details>), then swaps in the final
 * answer. Self-loop safety: the comment ids the assistant creates are tracked and never
 * treated as triggers (so a human can post from the bot account too).
 *
 * Repo-aware: each repo is cloned locally and the session's working_dir is set
 * to the clone, so the model reasons about the ACTUAL code, not just issue text.
 *
 * Advisory only (v1): proposes changes; does NOT push commits, open PRs, or merge.
 *
 * conversation_key = github:<instanceId>:repo:<owner/repo>:issue:<n>
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const GH_API = 'https://api.github.com';
const NAME = process.env.ASSISTANT_NAME || 'Assistant'; // display name in comments/prompt
const { redactSecrets } = require('../../../shared/redact');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COLLECTOR_BASE = (process.env.ASMLTR_COLLECTOR_URL || 'http://127.0.0.1:3017/ingest').replace(/\/ingest\/?$/, '');

const meta = {
  type: 'github',
  displayName: 'GitHub',
  supportsMultiple: true,
  capabilities: { max_message_chars: 60000, supports_markdown: true, supports_code_blocks: true },
  credentialKeys: ['pat_bws_key'],
  identifierFormats: [{ surface: 'github', label: 'GitHub login', placeholder: 'octocat' }],
  configSchema: {
    type: 'object',
    required: ['repos', 'pat_bws_key'],
    properties: {
      repos: { type: 'array', title: 'Repositories', items: { type: 'object',
        properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] } },
      pat_bws_key: { type: 'string', title: 'PAT secret key', description: 'secret key name for this account\'s GitHub PAT, e.g. my_github_pat' },
      mention: { type: 'string', title: 'Trigger token', description: 'Literal token that wakes the assistant in an issue/comment. Blank → defaults to *<assistant-name> (e.g. @bot).' },
      poll_interval_ms: { type: 'integer', title: 'Poll interval (ms)', default: 20000 },
      workspace_dir: { type: 'string', title: 'Local clone workspace', default: '', description: 'Where repos are shallow-cloned. Empty = ~/.asmltr/github-repos' },
      clone_repos: { type: 'boolean', title: 'Clone repos for code-awareness', default: true },
      stream: { type: 'boolean', title: 'Live-stream the working comment', default: true },
      dry_run: { type: 'boolean', title: 'Dry run (log, don\'t post)', default: true },
    },
  },
};

async function gh(pat, method, urlPath, body) {
  const res = await fetch(GH_API + urlPath, {
    method,
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'asmltr-github-connector',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${urlPath} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? null : res.json();
}

function execp(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.join(' ')}: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

// --- live-trace rendering (GitHub markdown) ---------------------------------
// One-liner (collapse whitespace) for short fields like thinking + tool input.
function oneLine(s, n) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n); }
// Multi-line block for command/tool OUTPUT — preserve newlines, neutralize fence
// delimiters so file contents can't break the code fence, generous cap + marker.
function outBlock(s, n) {
  let str = String(s == null ? '' : s).replace(/\r/g, '').replace(/`{3,}/g, '``');
  if (str.length > n) str = str.slice(0, n) + `\n…(+${str.length - n} more chars)`;
  return str;
}
// Trace = TOOL steps only (thinking moved to its own dropdown). Crisp rows: a tool
// header + a nested collapsed dropdown holding the full output; errors flagged ⚠️.
function renderTrace(events) {
  const out = [];
  for (const e of events) {
    let pl = {}; try { pl = typeof e.payload === 'string' ? JSON.parse(e.payload) : (e.payload || {}); } catch {}
    if (e.event_type === 'tool') out.push(`🔧 **${pl.tool}** \`${oneLine(pl.input, 400)}\``);
    else if (e.event_type === 'tool_result') {
      const label = pl.is_error ? '⚠️ <b>error output</b>' : '📥 output';
      out.push(`<details><summary>${label}</summary>\n\n\`\`\`\n${outBlock(pl.output, 16000)}\n\`\`\`\n\n</details>`);
    }
  }
  return out;
}
// Thinking = extended-thinking events + the assistant's intermediate narration (the prose between
// tool calls). Shown collapsed at the TOP so the final answer stays clean.
function renderThinking(events, narration) {
  const out = [];
  for (const e of events) {
    if (e.event_type !== 'thinking') continue;
    let pl = {}; try { pl = typeof e.payload === 'string' ? JSON.parse(e.payload) : (e.payload || {}); } catch {}
    if (pl.text) out.push(`💭 _${oneLine(pl.text, 700)}_`);
  }
  for (const n of (narration || [])) { const s = oneLine(n, 700); if (s) out.push(`🗒️ ${s}`); }
  return out;
}
function details(summary, blocks, open, maxLen = 50000) {
  if (!blocks.length) return '';
  let body = blocks.join('\n\n');
  if (body.length > maxLen) body = body.slice(0, maxLen) + '\n\n…(truncated — full log in the asmltr watch view)';
  return `<details${open ? ' open' : ''}><summary>${summary}</summary>\n\n${body}\n\n</details>`;
}

const GH_MAX = 64000; // safety margin under GitHub's 65 535-char comment limit

// most-recent blocks that fit within `budget` (whole blocks, oldest→newest order kept)
function tailFit(blocks, budget) {
  let len = 0; const tail = [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (len + blocks[i].length + 2 > budget && tail.length) break;
    tail.unshift(blocks[i]); len += blocks[i].length + 2;
  }
  return { tail, omitted: blocks.length - tail.length };
}

// Streaming layout: 🧠 Thinking (collapsed, live) then 🔍 Trace (open, live tail).
function liveBody(thinkingBlocks, traceBlocks) {
  const { tail, omitted } = tailFit(traceBlocks, 50000);
  const tcount = omitted > 0 ? `latest ${tail.length} of ${traceBlocks.length}` : `${traceBlocks.length}`;
  let s = `🧠 **${NAME} is working…**`;
  if (thinkingBlocks.length) s += '\n\n' + details(`🧠 Thinking (${thinkingBlocks.length})`, tailFit(thinkingBlocks, 12000).tail, false, 999999);
  s += '\n\n' + details(`🔍 Trace (${tcount} step${traceBlocks.length === 1 ? '' : 's'})`, tail, true, 999999);
  return s;
}

// Final layout: pack head (🧠 Thinking + 💬 Response) into the main comment, then spill
// the 🔍 Trace across continuation comments. Never slices a nested block; caps at 4.
function packComments(head, traceBlocks) {
  const CAP = 4;
  if (head.length > GH_MAX) head = head.slice(0, GH_MAX - 200) + '\n…(truncated)';
  const bodies = []; let i = 0;
  while (i < traceBlocks.length && bodies.length < CAP) {
    const first = bodies.length === 0;
    const prefix = first ? head + '\n\n' : '';
    const budget = GH_MAX - prefix.length - 200;
    const chunk = []; let len = 0;
    while (i < traceBlocks.length && len + traceBlocks[i].length + 2 <= budget) { chunk.push(traceBlocks[i]); len += traceBlocks[i].length + 2; i++; }
    if (first && chunk.length === 0) { bodies.push(head); continue; }
    const summary = first ? `🔍 Trace (${traceBlocks.length} step${traceBlocks.length === 1 ? '' : 's'})` : `🔍 Trace — cont. ${bodies.length + 1}`;
    bodies.push(prefix + details(summary, chunk, false, 999999));
  }
  if (!bodies.length) bodies.push(head);
  if (i < traceBlocks.length) bodies[bodies.length - 1] += `\n\n_…${traceBlocks.length - i} more step(s) omitted — full log in the asmltr watch view._`;
  return bodies;
}

function start(ctx) {
  const cfg = ctx.config || {};
  const mention = cfg.mention || ('*' + (process.env.ASSISTANT_NAME || 'assistant').toLowerCase());
  // require no word-char before the token so emails ("me@example.com") don't trigger
  const mentionRe = new RegExp('(?<!\\w)' + mention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
  const dryRun = cfg.dry_run !== false;
  const doStream = cfg.stream !== false && !dryRun;
  const doClone = cfg.clone_repos !== false;
  const workspace = cfg.workspace_dir || process.env.ASMLTR_GITHUB_WORKSPACE || path.join(require('os').homedir(), '.asmltr', 'github-repos');
  const pollMs = cfg.poll_interval_ms || 20000;

  const statePath = path.join(__dirname, '..', '..', 'manager', 'data', `github-state-${ctx.instanceId}.json`);
  let state = { seen: [], mine: [], since: null };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(statePath, 'utf8')) }; } catch (_) {}
  const seen = new Set(state.seen);
  const mine = new Set(state.mine); // comment ids the assistant authored — never trigger on these
  let since = state.since || new Date().toISOString(); // first boot: only react to NEW activity
  const saveState = () => {
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      // bound the persisted sets so they don't grow forever
      fs.writeFileSync(statePath, JSON.stringify({ seen: [...seen].slice(-1000), mine: [...mine].slice(-1000), since }));
    } catch (_) {}
  };

  let pat = null;
  let botLogin = null; // the GitHub account this instance's PAT authenticates as
  let stopped = false;
  let timer = null;
  const inflight = new Map(); // commentId -> { full, issueNumber } for turns being streamed right now

  async function ensureClone(full) {
    if (!doClone) return undefined;
    const dir = path.join(workspace, full.replace('/', '__'));
    try {
      if (fs.existsSync(path.join(dir, '.git'))) {
        await execp('git', ['-C', dir, 'fetch', '--quiet', '--depth', '1', 'origin'], {}).catch(() => {});
        await execp('git', ['-C', dir, 'reset', '--hard', '--quiet', 'origin/HEAD'], {}).catch(() => {});
      } else {
        fs.mkdirSync(workspace, { recursive: true });
        const url = `https://x-access-token:${pat}@github.com/${full}.git`;
        await execp('git', ['clone', '--quiet', '--depth', '1', url, dir]);
        // scrub the token from the stored remote (use a credential-less URL going forward)
        await execp('git', ['-C', dir, 'remote', 'set-url', 'origin', `https://github.com/${full}.git`]).catch(() => {});
        ctx.log(`cloned ${full} → ${dir}`);
      }
      return dir;
    } catch (e) { ctx.log(`clone/refresh ${full} failed: ${e.message}`); return undefined; }
  }

  async function fetchSessionEvents(key, sinceId) {
    try {
      const res = await fetch(`${COLLECTOR_BASE}/api/events?session=${encodeURIComponent(key)}&limit=300`);
      const { events } = await res.json();
      return (events || []).filter((e) => e.id > sinceId).sort((a, b) => a.id - b.id);
    } catch (_) { return []; }
  }

  function systemExtra(full, issueNumber, author, hasClone) {
    const patKey = cfg.pat_bws_key;
    const acct = botLogin ? `@${botLogin}` : 'the connector bot account';
    return [
      `You are ${NAME} responding on a GitHub issue thread: repo \`${full}\`, issue #${issueNumber}, invoked via "${mention}" by @${author}.`,
      'Respond in GitHub-flavored markdown — concise, focused, skimmable.',
      hasClone
        ? `A current local clone of the repo is your working directory — READ and grep the actual code to ground your answer.`
        : `You do NOT have the repo checked out; reason from the issue text and say so if you'd need to see the code.`,
      `GITHUB IDENTITY (CRITICAL): on this repo you act ONLY as ${acct}. The host's default \`gh\`/git auth may be a DIFFERENT, unauthorized account — NEVER use it here. For ANY GitHub operation (gh CLI, REST API, git push), authenticate as ${acct} using this connector's PAT (secret key '${patKey}' in your configured secret store); export it as GH_TOKEN before the command, e.g. \`GH_TOKEN="<pat>" gh issue close ${issueNumber} --repo ${full}\`. If you cannot authenticate as ${acct}, do NOT fall back to another account — say so and stop.`,
      'SCOPE: you may do GitHub housekeeping the human explicitly asks for (close the issue, add a label, comment) — but ONLY as the account above. Code changes (commits, PRs, merges) are out of scope for now.',
      'If the request is ambiguous or you lack information, ASK one clear clarifying question and stop — the human will reply with another mention.',
      'This is a persistent multi-turn thread; you retain the prior context of this issue.',
    ].join('\n');
  }

  // Run one invocation: post a working comment, stream the turn into it, finalize.
  async function handleTrigger({ full, issueNumber, requestText, author }) {
    const key = `github:${ctx.instanceId}:repo:${full}:issue:${issueNumber}`;
    const issue = await gh(pat, 'GET', `/repos/${full}/issues/${issueNumber}`).catch(() => ({}));
    const cwd = await ensureClone(full);
    const text = [
      `GitHub issue #${issueNumber} in \`${full}\`: "${issue.title || ''}"`,
      issue.body ? `\nIssue body:\n${String(issue.body).slice(0, 6000)}` : '',
      `\n@${author} invoked you with:\n${requestText.replace(mentionRe, '').trim() || '(no extra text — please help with this issue)'}`,
    ].join('\n');
    const envelope = {
      channel: 'github', conversation_key: key, message_id: `gh-${issueNumber}-${Date.now()}`,
      sender: { raw_id: author, raw_username: author },
      content: { text },
      delivery: 'async', capabilities: meta.capabilities,
      public: true, // issue comments are world-readable to repo members
      channel_context: { full, issueNumber },
      working_dir: cwd,
      system_prompt_extra: systemExtra(full, issueNumber, author, !!cwd),
    };

    if (dryRun) {
      ctx.log(`[DRY-RUN] ${full}#${issueNumber} @${author}: handling (cwd=${cwd || 'none'})`);
      const actions = await ctx.core.handle(envelope).catch((e) => { ctx.log(`core failed: ${e.message}`); return []; });
      const reply = (actions || []).find((a) => a.type === 'reply');
      ctx.log(`[DRY-RUN] would post on ${full}#${issueNumber}:\n${reply ? reply.text.slice(0, 800) : '(no reply)'}`);
      return;
    }

    // baseline so the live trace only shows THIS turn's events
    const baseId = (await fetchSessionEvents(key, 0)).reduce((m, e) => Math.max(m, e.id), 0);
    const placeholder = await gh(pat, 'POST', `/repos/${full}/issues/${issueNumber}/comments`, { body: `🧠 **${NAME} is on it…**` });
    const commentId = placeholder.id;
    mine.add(commentId); saveState();
    inflight.set(commentId, { full, issueNumber }); // so a restart can finalize this comment instead of freezing it

    let done = false; let lastBody = '';
    const patchComment = async (rawBody) => {
      // PUBLIC surface — scrub any secrets that surfaced in tool output before posting
      const { text: body, count } = redactSecrets(rawBody);
      if (count) ctx.log(`[redact] masked ${count} secret(s) on ${full}#${issueNumber}`);
      if (body === lastBody) return;
      lastBody = body;
      await gh(pat, 'PATCH', `/repos/${full}/issues/comments/${commentId}`, { body }).catch((e) => ctx.log(`patch failed: ${e.message}`));
    };
    const streamer = (async () => {
      if (!doStream) return;
      while (!done) {
        await sleep(8000); // gentle cadence — long turns shouldn't trip GitHub's secondary edit limits
        const evts = await fetchSessionEvents(key, baseId);
        await patchComment(liveBody(renderThinking(evts, []), renderTrace(evts)));
      }
    })();

    let actions = [];
    try { actions = await ctx.core.handle(envelope); }
    catch (e) { actions = [{ type: 'reply', text: `⚠️ I hit an error: ${e.message}` }]; }
    finally { done = true; await streamer; }

    const reply = (actions || []).find((a) => a.type === 'reply');
    const evts = await fetchSessionEvents(key, baseId);
    // split the assistant's text into the FINAL answer (last block) vs intermediate narration
    // (earlier blocks) — narration goes up into the collapsed Thinking dropdown so the
    // Response section is just the answer.
    const segs = (reply && reply.segments) || [];
    const answer = (segs.length ? segs[segs.length - 1] : (reply ? reply.text : '')).trim() || '_(no response generated)_';
    const narration = segs.slice(0, -1);
    const thinkingBlocks = renderThinking(evts, narration);
    const head = (thinkingBlocks.length ? details(`🧠 Thinking (${thinkingBlocks.length})`, thinkingBlocks, false, 40000) + '\n\n' : '')
      + `### 💬 Response\n\n${answer}`;
    const bodies = packComments(head, renderTrace(evts));
    await patchComment(bodies[0]); // edit the placeholder into the main comment
    for (let k = 1; k < bodies.length; k++) {
      try {
        const c = await gh(pat, 'POST', `/repos/${full}/issues/${issueNumber}/comments`, { body: redactSecrets(bodies[k]).text });
        mine.add(c.id); // never trigger on the assistant's own continuation comments
      } catch (e) { ctx.log(`continuation comment failed: ${e.message}`); }
    }
    if (bodies.length > 1) saveState();
    inflight.delete(commentId);
    ctx.log(`answered ${full}#${issueNumber}${bodies.length > 1 ? ` (+${bodies.length - 1} trace comment(s))` : ''}`);
  }

  // Detect triggers across a repo's recent comments + recently-opened issue bodies.
  async function pollRepo(repo) {
    const full = `${repo.owner}/${repo.repo}`;
    const enc = encodeURIComponent(since);
    // 1) new/updated issue comments
    const comments = await gh(pat, 'GET', `/repos/${full}/issues/comments?since=${enc}&sort=updated&direction=asc&per_page=100`);
    for (const c of comments || []) {
      const tid = `c-${c.id}`;
      if (mine.has(c.id) || seen.has(tid)) continue;
      if (!mentionRe.test(c.body || '')) continue;
      const m = /\/issues\/(\d+)$/.exec(c.issue_url || '');
      if (!m) continue;
      seen.add(tid);
      ctx.emit({ event_type: 'inbound', session_id: `github:${ctx.instanceId}:repo:${full}:issue:${m[1]}`, identity: c.user.login, payload: { repo: full, issue: Number(m[1]) } });
      ctx.log(`trigger: ${full}#${m[1]} comment from @${c.user.login}`);
      try { await handleTrigger({ full, issueNumber: Number(m[1]), requestText: c.body || '', author: c.user.login }); }
      catch (e) { ctx.log(`${full}#${m[1]} failed: ${e.message}`); }
    }
    // 2) recently-updated open issues whose BODY carries the trigger token (e.g. a freshly opened issue)
    const issues = await gh(pat, 'GET', `/repos/${full}/issues?since=${enc}&state=open&sort=updated&direction=asc&per_page=50`);
    for (const issue of issues || []) {
      if (issue.pull_request) continue;
      const tid = `ib-${issue.id}`;
      if (seen.has(tid)) continue;
      if (!mentionRe.test(issue.body || '')) continue;
      seen.add(tid);
      ctx.log(`trigger: ${full}#${issue.number} issue body from @${issue.user.login}`);
      try { await handleTrigger({ full, issueNumber: issue.number, requestText: issue.body || '', author: issue.user.login }); }
      catch (e) { ctx.log(`${full}#${issue.number} failed: ${e.message}`); }
    }
  }

  async function tick() {
    if (stopped) return;
    const started = new Date().toISOString();
    for (const repo of cfg.repos || []) {
      try { await pollRepo(repo); } catch (e) { ctx.log(`poll ${repo.owner}/${repo.repo} failed: ${e.message}`); }
    }
    since = started; // next poll only needs activity since this poll began (dedup covers overlap)
    saveState();
  }

  (async () => {
    pat = await ctx.secrets.get(cfg.pat_bws_key);
    if (!pat) { ctx.log(`no PAT for '${cfg.pat_bws_key}' — github connector idle`); return; }
    botLogin = (await gh(pat, 'GET', '/user').catch(() => ({}))).login || null; // who the PAT acts as
    ctx.log(`github ready: ${(cfg.repos || []).map((r) => `${r.owner}/${r.repo}`).join(', ')} | as @${botLogin || '?'} | mention='${mention}' dry_run=${dryRun} stream=${doStream} clone=${doClone}`);
    await tick();
    timer = setInterval(tick, pollMs);
  })();

  return {
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      // finalize any comment we're mid-stream on, so a restart/deploy doesn't freeze it
      // on "the assistant is working…" forever (the core turn may keep running; re-invoke to resume).
      for (const [cid, { full }] of inflight) {
        await gh(pat, 'PATCH', `/repos/${full}/issues/comments/${cid}`, {
          body: '⚠️ _Eve was interrupted by a connector restart/deploy mid-turn. The backend may have finished underneath; re-invoke with the trigger token to resume this thread._',
        }).catch(() => {});
      }
      inflight.clear();
      saveState();
    },
    health() { return { repos: (cfg.repos || []).length, dry_run: dryRun, stream: doStream }; },
  };
}

module.exports = { meta, start };
