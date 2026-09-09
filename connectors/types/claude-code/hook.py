#!/usr/bin/env python3
"""
asmltr claude-code connector — Claude Code hook → asmltr event emitter.

Grok/Gemini/Codex: this file is Claude Code only. Interactive sessions for those engines are
`asmltr grok|gemini|codex` (cli/asmltr-engine.js). A Gemini or Codex native-hook port belongs
in its own script, not this one.

Claude Code fires hooks with a JSON payload on stdin (session_id, cwd, transcript_path,
hook_event_name, and event-specific fields). This script turns those into the SAME shared
events every other asmltr connector emits, POSTed to the collector's /ingest — so a terminal
claude session becomes a first-class session in the dashboard with a generated title, a live
"what it's doing" overview, token/tool counts, and attach info. No pane-scraping, no polling.

Wire it into ~/.claude/settings.json (see README) on: SessionStart, UserPromptSubmit,
PostToolUse, SessionEnd. It is passive (emits no stdout), never blocks meaningfully, and never
fails the session (all errors swallowed, always exits 0).

Session identity: a claude session lives in a screen/tmux PANE that you attach to, so we key by
the multiplexer session name when present (unifying with the tracker + `asmltr claude` wrapper);
otherwise we fall back to the claude session UUID.
"""
import sys, os, json, re, subprocess, urllib.request

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))


def load_env():
    """Pull the collector token/port from the repo .env (KEY=VALUE), env vars win."""
    cfg = {}
    try:
        with open(os.path.join(REPO, ".env"), "r") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                cfg[k.strip()] = v.strip().strip('"').strip("'")
    except Exception:
        pass
    cfg.update({k: v for k, v in os.environ.items() if k.startswith("ASMLTR_")})
    return cfg


def mux_session():
    """(multiplexer, session_name) for this pane, or (None, None) if not in one."""
    sty = os.environ.get("STY")  # screen: "<pid>.<name>"
    if sty:
        return "screen", re.sub(r"^\d+\.", "", sty)
    if os.environ.get("TMUX"):
        try:
            name = subprocess.run(["tmux", "display-message", "-p", "#S"],
                                  capture_output=True, text=True, timeout=1).stdout.strip()
            if name:
                return "tmux", name
        except Exception:
            pass
    return None, None


def last_turn_reply(transcript_path):
    """The assistant's TEXT for the just-completed turn, read from the Claude Code transcript JSONL.

    Claude Code has no hook that carries the assistant's response, so on the Stop (turn-boundary)
    hook we recover it from the transcript: walk backwards collecting assistant `text` blocks until
    the real user prompt that started the turn (tool_result 'user' messages belong to the same turn
    and are skipped). Returns the joined text, or None."""
    if not transcript_path:
        return None
    try:
        with open(transcript_path, "r") as f:
            lines = f.read().splitlines()
    except Exception:
        return None
    texts = []
    for line in reversed(lines):
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        typ = obj.get("type")
        content = (obj.get("message") or {}).get("content")
        if typ == "assistant":
            blocks = []
            if isinstance(content, list):
                for c in content:
                    if isinstance(c, dict) and c.get("type") == "text" and c.get("text"):
                        blocks.append(c["text"])
            elif isinstance(content, str):
                blocks.append(content)
            for b in reversed(blocks):  # walking backwards → append reversed, undo at the end
                texts.append(b)
        elif typ == "user":
            # A real prompt (string, or a list carrying a text block) ends the turn; a tool_result-
            # only 'user' message is mid-turn plumbing, so keep going.
            is_prompt = isinstance(content, str) or (
                isinstance(content, list)
                and any(isinstance(c, dict) and c.get("type") == "text" for c in content)
            )
            if is_prompt:
                break
    texts.reverse()
    out = "\n\n".join(t.strip() for t in texts if t and t.strip())
    return out or None


def main():
    # The asmltr core runs claude via the Agent SDK with IS_SANDBOX=1; if that path ever fires user
    # hooks, we must NOT emit — those turns are already tracked as their real channel session. This
    # hook is only for INTERACTIVE terminal claude sessions.
    if os.environ.get("IS_SANDBOX"):
        return
    try:
        data = json.load(sys.stdin)
    except Exception:
        return  # nothing parseable → do nothing

    cfg = load_env()
    token = cfg.get("ASMLTR_INSIGHTS_TOKEN", "")
    port = cfg.get("ASMLTR_INSIGHTS_PORT", "3017")
    url = cfg.get("ASMLTR_INSIGHTS_URL", f"http://127.0.0.1:{port}/ingest")
    identity = cfg.get("ASMLTR_TRACKER_IDENTITY") or os.environ.get("USER") or "root"

    event_name = data.get("hook_event_name", "")
    cwd = data.get("cwd") or None
    mux, mux_name = mux_session()
    sid = mux_name or data.get("session_id")  # pane name unifies with the tracker; else the uuid
    if not sid:
        return

    base = {"surface": "claude-code", "session_id": sid, "identity": identity, "source": "claude-code-hook"}
    events = []

    if event_name == "SessionStart":
        pid = None
        try:  # the claude pid is our nearest 'claude' ancestor
            p = os.getppid()
            for _ in range(6):
                comm = open(f"/proc/{p}/comm").read().strip()
                if comm == "claude":
                    pid = p
                    break
                p = int(open(f"/proc/{p}/stat").read().split()[3])
        except Exception:
            pass
        events.append({**base, "event_type": "session-start", "payload": {
            "working_dir": cwd, "multiplexer": mux, "tmux_target": mux_name, "pid": pid,
            "task": f"claude — {os.path.basename(cwd)}" if cwd else "claude",
        }})
    elif event_name == "UserPromptSubmit":
        prompt = (data.get("prompt") or "").strip()
        if not prompt:
            return
        events.append({**base, "event_type": "inbound", "payload": {"text": prompt[:4000], "working_dir": cwd}})
    elif event_name == "PostToolUse":
        tool = data.get("tool_name") or "tool"
        ti = data.get("tool_input")
        # cap the input so a big file write / long command can't blow the ingest body limit
        try:
            s = ti if isinstance(ti, str) else json.dumps(ti)
            if len(s) > 1500:
                s = s[:1500] + "…"
            ti = s
        except Exception:
            ti = None
        events.append({**base, "event_type": "tool", "payload": {"tool": tool, "input": ti}})
    elif event_name == "Stop":
        # Turn boundary — recover the assistant's response from the transcript and emit it as the
        # session's outbound (Claude Code has no hook that carries the reply text). Keeps the pane
        # 'active'; only SessionEnd ends it.
        reply = last_turn_reply(data.get("transcript_path"))
        if not reply:
            return
        if len(reply) > 8000:
            reply = reply[:8000] + "…"
        events.append({**base, "event_type": "outbound", "payload": {"text": reply}})
    elif event_name == "SessionEnd":
        events.append({**base, "event_type": "session-end", "payload": {}})
    else:
        return

    body = json.dumps(events if len(events) > 1 else events[0]).encode()
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"Content-Type": "application/json",
                                          **({"Authorization": f"Bearer {token}"} if token else {})})
    try:
        urllib.request.urlopen(req, timeout=2).read()
    except Exception:
        pass  # collector down / slow → never block or fail the claude session


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
