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
 * On invocation it posts ONE comment: the final answer only (V36). A working
 * placeholder may appear while the turn runs, then is swapped for that answer.
 * Thinking and tool I/O stay in the operator watch view — never the issue.
 * Self-loop safety: comment ids the assistant creates are tracked and never
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

const GH_API = process.env.ASMLTR_GITHUB_API_BASE || 'https://api.github.com';
// Every GitHub request is time-boxed. Without this, a stalled connection (a network/proxy blip that
// never returns) hangs the poll `await` forever; over days those dead sockets exhaust undici's pool
// and the poller goes silently deaf while the process stays alive (the #34 "deaf but running" class).
const GH_FETCH_TIMEOUT_MS = Number(process.env.ASMLTR_GITHUB_FETCH_TIMEOUT_MS) || 15000;
const NAME = process.env.ASSISTANT_NAME || 'Assistant'; // display name in comments/prompt
const { cloneArgv, cloneGitEnv, githubIdentityPrompt } = require('./clone-auth');
const { workingPlaceholder, finalIssueComment } = require('./issue-comment');

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
      poll_interval_ms: { type: 'integer', title: 'Poll interval (ms)', default: 120000 },
      workspace_dir: { type: 'string', title: 'Local clone workspace', default: '', description: 'Where repos are shallow-cloned. Empty = ~/.asmltr/github-repos' },
      clone_repos: { type: 'boolean', title: 'Clone repos for code-awareness', default: true },
      stream: { type: 'boolean', title: 'Working placeholder, then final answer (never thinking/tools)', default: true },
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
    signal: AbortSignal.timeout(GH_FETCH_TIMEOUT_MS), // never hang forever on a stalled connection
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${urlPath} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? null : res.json();
}

function execp(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, timeout: 120000, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.join(' ')}: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
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
  const pollMs = cfg.poll_interval_ms || 120000;

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
        await execp('git', ['-C', dir, 'fetch', '--quiet', '--depth', '1', 'origin'], { env: cloneGitEnv(pat) }).catch(() => {});
        await execp('git', ['-C', dir, 'reset', '--hard', '--quiet', 'origin/HEAD'], { env: cloneGitEnv(pat) }).catch(() => {});
      } else {
        fs.mkdirSync(workspace, { recursive: true });
        await execp('git', cloneArgv(full, dir), { env: cloneGitEnv(pat) });
        // scrub the token from the stored remote (use a credential-less URL going forward)
        await execp('git', ['-C', dir, 'remote', 'set-url', 'origin', `https://github.com/${full}.git`]).catch(() => {});
        ctx.log(`cloned ${full} → ${dir}`);
      }
      return dir;
    } catch (e) { ctx.log(`clone/refresh ${full} failed: ${e.message}`); return undefined; }
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
      githubIdentityPrompt({ name: NAME, acct, patKey, issueNumber, full }),
      'SCOPE: you may do GitHub housekeeping the human explicitly asks for (close the issue, add a label, comment) — but ONLY as the account above. Code changes (commits, PRs, merges) are out of scope for now.',
      'If the request is ambiguous or you lack information, ASK one clear clarifying question and stop — the human will reply with another mention.',
      'This is a persistent multi-turn thread; you retain the prior context of this issue.',
    ].join('\n');
  }

  // Run one invocation: optional working placeholder, then ONE final-answer comment (V36).
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
      ctx.log(`[DRY-RUN] would post on ${full}#${issueNumber}:\n${finalIssueComment(actions).slice(0, 800)}`);
      return;
    }

    let commentId = null;
    if (doStream) {
      const placeholder = await gh(pat, 'POST', `/repos/${full}/issues/${issueNumber}/comments`, { body: workingPlaceholder(NAME) });
      commentId = placeholder.id;
      mine.add(commentId); saveState();
      inflight.set(commentId, { full, issueNumber });
    }

    let actions = [];
    try { actions = await ctx.core.handle(envelope); }
    catch (e) { actions = [{ type: 'reply', text: `⚠️ I hit an error: ${e.message}` }]; }

    const body = finalIssueComment(actions);
    if (commentId) {
      await gh(pat, 'PATCH', `/repos/${full}/issues/comments/${commentId}`, { body }).catch((e) => ctx.log(`patch failed: ${e.message}`));
      inflight.delete(commentId);
    } else {
      try {
        const c = await gh(pat, 'POST', `/repos/${full}/issues/${issueNumber}/comments`, { body });
        mine.add(c.id); saveState();
      } catch (e) { ctx.log(`comment failed: ${e.message}`); }
    }
    ctx.log(`answered ${full}#${issueNumber}`);
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
    // Liveness: reaching here means the poll cycle completed (the fetches returned/failed, didn't hang),
    // so the I/O loop is alive. A wedged tick never gets here → the manager surfaces heartbeat:stale (#34).
    try { ctx.heartbeat(); } catch (_) {}
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
          body: `⚠️ _${NAME} was interrupted by a connector restart/deploy mid-turn. The backend may have finished underneath; re-invoke with the trigger token to resume this thread._`,
        }).catch(() => {});
      }
      inflight.clear();
      saveState();
    },
    health() { return { repos: (cfg.repos || []).length, dry_run: dryRun, stream: doStream }; },
  };
}

module.exports = { meta, start, gh };
