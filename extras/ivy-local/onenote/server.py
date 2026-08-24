#!/usr/bin/env python3
"""Stdio MCP server: OneNote via Microsoft Graph.

Secrets live at ~/.asmltr/onenote/{token.json,.client.json} (mode 600). Never print them.
Override with ONENOTE_HOME. Optional ownership_site in .client.json (or ONENOTE_OWNERSHIP_SITE)
selects a SharePoint site; if unset, Graph calls use /me/onenote only.
Eve: skip extras/ivy-local unless you want these extras.
"""

from __future__ import annotations

import html
import json
import logging
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from mcp.server import MCPServer

logger = logging.getLogger(__name__)

def _onenote_home() -> Path:
    override = (os.environ.get("ONENOTE_HOME") or "").strip()
    if override:
        return Path(override).expanduser()
    return Path.home() / ".asmltr" / "onenote"


ROOT = _onenote_home()
CLIENT_PATH = ROOT / ".client.json"
TOKEN_PATH = ROOT / "token.json"
PENDING_PATH = ROOT / ".device-pending.json"
GRAPH = "https://graph.microsoft.com/v1.0"
LOGIN_BASE = "https://login.microsoftonline.com"
SCOPES = ("Notes.ReadWrite", "Notes.ReadWrite.All", "Files.ReadWrite.All", "Sites.ReadWrite.All", "User.Read", "offline_access")
SCOPE_STR = " ".join(SCOPES)
DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
USER_AGENT = "OneNote-MCP/1.0"
ET = ZoneInfo("America/New_York")
LIST_CAP = 200
REFRESH_SKEW = 120
DEFAULT_LOGIN_WAIT = 180

mcp = MCPServer("onenote")

_io_lock = threading.Lock()
_poll_lock = threading.Lock()
_poll_thread: threading.Thread | None = None


def _dumps(payload: Any) -> str:
    return json.dumps(payload, indent=2, ensure_ascii=False)


def _now() -> float:
    return time.time()


def _iso_et(ts: float | None = None) -> str:
    when = datetime.fromtimestamp(ts if ts is not None else _now(), tz=timezone.utc).astimezone(ET)
    return when.isoformat(timespec="seconds")


def _safe_error(exc: object) -> str:
    """Failure text that never includes tokens, device codes, or bearer headers."""
    text = str(exc)
    lowered = text.lower()
    needles = (
        "access_token",
        "refresh_token",
        "id_token",
        "device_code",
        "authorization:",
        "bearer ",
        "client_secret",
    )
    if any(n in lowered for n in needles):
        return "request failed (details omitted)"
    return text


def _has_mail_scope(scope: str | None) -> bool:
    if not scope:
        return False
    for part in scope.replace(",", " ").split():
        name = part.rsplit("/", 1)[-1].lower()
        if name.startswith("mail."):
            return True
    return False


def _write_secret(path: Path, payload: dict[str, Any]) -> None:
    tmp = path.with_name(f"{path.name}.tmp.{os.getpid()}")
    try:
        tmp.write_text(_dumps(payload) + "\n", encoding="utf-8")
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
        os.chmod(path, 0o600)
    except Exception:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def _load_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as fh:
        return json.load(fh)


def _load_client() -> dict[str, str] | str:
    if not CLIENT_PATH.is_file():
        return "Error: .client.json missing. Put the Entra application (client) id there."
    try:
        data = _load_json(CLIENT_PATH)
    except (OSError, json.JSONDecodeError) as exc:
        return f"Error: .client.json unreadable ({type(exc).__name__})"
    if not isinstance(data, dict):
        return "Error: .client.json must be an object"
    client_id = str(data.get("client_id") or "").strip()
    tenant = str(data.get("tenant") or "common").strip() or "common"
    if not client_id:
        return (
            "Error: .client.json has an empty client_id. "
            "Register an Entra app for this install and put the Application (client) ID in "
            f"{CLIENT_PATH} (mode 600)."
        )
    return {"client_id": client_id, "tenant": tenant}


def _authority(tenant: str) -> str:
    return f"{LOGIN_BASE}/{urllib.parse.quote(tenant, safe='')}"


def _http(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    form: dict[str, str] | None = None,
    data: bytes | None = None,
    content_type: str | None = None,
    accept: str | None = "application/json",
) -> tuple[int, dict[str, str], bytes]:
    hdrs = {"User-Agent": USER_AGENT}
    if accept:
        hdrs["Accept"] = accept
    if headers:
        hdrs.update(headers)
    body: bytes | None = data
    if form is not None:
        body = urllib.parse.urlencode(form).encode("utf-8")
        hdrs["Content-Type"] = "application/x-www-form-urlencoded"
    elif data is not None and content_type:
        hdrs["Content-Type"] = content_type
    req = urllib.request.Request(url, data=body, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return int(resp.status), {k.lower(): v for k, v in resp.headers.items()}, resp.read()
    except urllib.error.HTTPError as exc:
        raw = exc.read() if exc.fp else b""
        return int(exc.code), {k.lower(): v for k, v in (exc.headers.items() if exc.headers else [])}, raw


def _json_body(raw: bytes) -> Any:
    if not raw:
        return None
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None


def _graph_error(status: int, raw: bytes) -> str:
    parsed = _json_body(raw)
    if isinstance(parsed, dict):
        err = parsed.get("error")
        if isinstance(err, dict):
            msg = err.get("message") or err.get("code") or "graph error"
            return f"Error: Graph {status}: {_safe_error(msg)}"
        if isinstance(err, str):
            desc = parsed.get("error_description") or err
            return f"Error: {status}: {_safe_error(desc)}"
    return f"Error: Graph HTTP {status}"


def _token_public_fields(token: dict[str, Any]) -> dict[str, Any]:
    exp = token.get("expires_at")
    return {
        "token_present": True,
        "expires_at": _iso_et(exp) if isinstance(exp, (int, float)) else None,
        "scope": token.get("scope"),
    }


def _load_token() -> dict[str, Any] | None:
    if not TOKEN_PATH.is_file():
        return None
    try:
        data = _load_json(TOKEN_PATH)
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    if not data.get("access_token") and not data.get("refresh_token"):
        return None
    return data


def _save_token(payload: dict[str, Any]) -> str | None:
    scope = str(payload.get("scope") or SCOPE_STR)
    if _has_mail_scope(scope):
        return "Error: token included a Mail.* scope; refusing to store it. Check the Entra app permissions."
    expires_in = int(payload.get("expires_in") or 3600)
    record = {
        "token_type": payload.get("token_type") or "Bearer",
        "scope": scope,
        "expires_at": int(_now()) + max(expires_in - 5, 60),
        "access_token": payload.get("access_token"),
        "refresh_token": payload.get("refresh_token") or (_load_token() or {}).get("refresh_token"),
    }
    if not record["access_token"]:
        return "Error: token response missing access_token"
    try:
        _write_secret(TOKEN_PATH, record)
    except OSError as exc:
        return f"Error: could not write token.json ({type(exc).__name__})"
    return None


def _load_pending() -> dict[str, Any] | None:
    if not PENDING_PATH.is_file():
        return None
    try:
        data = _load_json(PENDING_PATH)
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict) or not data.get("device_code"):
        return None
    expires_at = data.get("expires_at")
    if isinstance(expires_at, (int, float)) and expires_at <= _now():
        try:
            PENDING_PATH.unlink(missing_ok=True)
        except OSError:
            pass
        return None
    return data


def _save_pending(data: dict[str, Any]) -> None:
    _write_secret(PENDING_PATH, data)


def _clear_pending() -> None:
    try:
        PENDING_PATH.unlink(missing_ok=True)
    except OSError:
        pass


def _pending_public(pending: dict[str, Any]) -> dict[str, Any]:
    exp = pending.get("expires_at")
    out: dict[str, Any] = {
        "user_code": pending.get("user_code"),
        "verification_uri": pending.get("verification_uri") or "https://www.microsoft.com/devicelogin",
        "message": pending.get("message")
        or (
            "Open the verification URL, enter the user code, and sign in as the notebook owner. "
            "This server polls until you finish or the code expires."
        ),
    }
    if isinstance(exp, (int, float)):
        out["expires_at"] = _iso_et(exp)
        out["expires_in_seconds"] = max(0, int(exp - _now()))
    return out


def _form_token(client: dict[str, str], form: dict[str, str]) -> tuple[int, Any]:
    url = f"{_authority(client['tenant'])}/oauth2/v2.0/token"
    status, _hdrs, raw = _http("POST", url, form=form, accept="application/json")
    return status, _json_body(raw)


def _refresh_token(client: dict[str, str], token: dict[str, Any]) -> dict[str, Any] | str:
    refresh = token.get("refresh_token")
    if not refresh:
        return "Error: no refresh token; call onenote_login"
    status, parsed = _form_token(
        client,
        {
            "client_id": client["client_id"],
            "grant_type": "refresh_token",
            "refresh_token": str(refresh),
            "scope": SCOPE_STR,
        },
    )
    if status != 200 or not isinstance(parsed, dict) or not parsed.get("access_token"):
        desc = ""
        if isinstance(parsed, dict):
            desc = str(parsed.get("error_description") or parsed.get("error") or "")
        extra = _safe_error(": " + desc) if desc else ""
        return f"Error: refresh failed ({status}{extra}). Call onenote_login."
    if _has_mail_scope(str(parsed.get("scope") or "")):
        return "Error: refreshed token included a Mail.* scope; refusing to store it."
    err = _save_token(parsed)
    if err:
        return err
    saved = _load_token()
    return saved if saved else "Error: token saved but could not be re-read"


def _access_token() -> str | dict[str, Any]:
    client = _load_client()
    if isinstance(client, str):
        return client
    with _io_lock:
        token = _load_token()
        if token is None:
            return "Error: not signed in. Call onenote_login."
        exp = token.get("expires_at")
        if isinstance(exp, (int, float)) and exp - REFRESH_SKEW <= _now():
            refreshed = _refresh_token(client, token)
            if isinstance(refreshed, str):
                return refreshed
            token = refreshed
        access = token.get("access_token")
        if not access:
            return "Error: token.json has no access token. Call onenote_login."
        return {"access_token": str(access), "client": client, "token": token}


def _graph(
    method: str,
    path: str,
    *,
    params: dict[str, str] | None = None,
    data: bytes | None = None,
    content_type: str | None = None,
    accept: str | None = "application/json",
    raw: bool = False,
) -> Any:
    auth = _access_token()
    if isinstance(auth, str):
        return auth
    url = path if path.startswith("http") else GRAPH + path
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    headers = {"Authorization": f"Bearer {auth['access_token']}"}
    status, _hdrs, body = _http(
        method,
        url,
        headers=headers,
        data=data,
        content_type=content_type,
        accept=accept,
    )
    if status == 401:
        with _io_lock:
            refreshed = _refresh_token(auth["client"], auth["token"])
        if isinstance(refreshed, str):
            return refreshed
        headers = {"Authorization": f"Bearer {refreshed['access_token']}"}
        status, _hdrs, body = _http(
            method,
            url,
            headers=headers,
            data=data,
            content_type=content_type,
            accept=accept,
        )
    if status >= 400:
        return _graph_error(status, body)
    if raw:
        return body
    if status in (202, 204) or not body:
        return {"ok": True, "status": status}
    parsed = _json_body(body)
    if parsed is None and body:
        return "Error: Graph returned non-JSON"
    return parsed


def _graph_list(path: str, params: dict[str, str] | None = None, cap: int = LIST_CAP) -> list[dict[str, Any]] | str:
    items: list[dict[str, Any]] = []
    url: str | None = path
    query = params
    while url and len(items) < cap:
        payload = _graph("GET", url, params=query)
        query = None
        if isinstance(payload, str):
            return payload
        if not isinstance(payload, dict):
            return "Error: unexpected Graph list payload"
        for row in payload.get("value") or []:
            if isinstance(row, dict):
                items.append(row)
            if len(items) >= cap:
                break
        nxt = payload.get("@odata.nextLink")
        url = nxt if isinstance(nxt, str) and nxt else None
    return items


def _enc_id(value: str) -> str:
    return urllib.parse.quote(value, safe="")


def _ownership_site() -> str:
    env = (os.environ.get("ONENOTE_OWNERSHIP_SITE") or os.environ.get("OWNERSHIP_SITE") or "").strip()
    if env:
        return env
    if not CLIENT_PATH.is_file():
        return ""
    try:
        data = _load_json(CLIENT_PATH)
    except (OSError, json.JSONDecodeError):
        return ""
    if not isinstance(data, dict):
        return ""
    return str(data.get("ownership_site") or data.get("OWNERSHIP_SITE") or "").strip()


def _onenote_roots() -> list[str]:
    roots = ["/me/onenote"]
    site = _ownership_site()
    if site:
        roots.append(f"/sites/{_enc_id(site)}/onenote")
    return roots


def _graph_onenote(method: str, rest: str, **kwargs: Any) -> Any:
    """Call Graph OneNote. Try /me, then Ownership Notebook on SharePoint if that 404s."""
    if not rest.startswith("/"):
        rest = "/" + rest
    last: Any = None
    for root in _onenote_roots():
        result = _graph(method, root + rest, **kwargs)
        if isinstance(result, str) and ("404" in result or "does not exist" in result.lower()):
            last = result
            continue
        return result
    return last if last is not None else "Error: OneNote resource not found"



class _TextExtractor(HTMLParser):
    _block = {
        "p", "div", "br", "li", "tr",
        "h1", "h2", "h3", "h4", "h5", "h6",
        "title", "section", "article", "blockquote",
    }

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in ("script", "style"):
            self._skip += 1
        elif tag in self._block:
            self._parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in ("script", "style") and self._skip:
            self._skip -= 1
        elif tag in self._block and tag != "br":
            self._parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self._skip and data:
            self._parts.append(data)

    def text(self) -> str:
        joined = "".join(self._parts)
        lines = [" ".join(line.split()) for line in joined.splitlines()]
        out: list[str] = []
        blank = False
        for line in lines:
            if not line:
                if out and not blank:
                    out.append("")
                blank = True
            else:
                out.append(line)
                blank = False
        return "\n".join(out).strip()


def _html_to_text(raw: str) -> str:
    parser = _TextExtractor()
    try:
        parser.feed(raw)
        parser.close()
    except Exception:
        return html.unescape(raw)
    return parser.text()


def _page_html(title: str, html_body: str | None, text_body: str | None) -> str:
    title_esc = html.escape((title or "Untitled").strip() or "Untitled")
    raw_html = (html_body or "").strip()
    raw_text = (text_body or "").strip()
    if raw_html:
        lowered = raw_html[:20].lower()
        if lowered.startswith("<!doctype") or lowered.startswith("<html"):
            return raw_html
        inner = raw_html
    elif raw_text:
        parts: list[str] = []
        for para in raw_text.split("\n\n"):
            line = html.escape(para).replace("\n", "<br/>")
            parts.append(f"<p>{line}</p>" if line.strip() else "<p></p>")
        inner = "".join(parts) or "<p></p>"
    else:
        return "Error: provide html or text body"
    created = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    return (
        '<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml">'
        f"<head><title>{title_esc}</title>"
        f'<meta name="created" content="{created}"/></head>'
        f"<body>{inner}</body></html>"
    )


def _me() -> dict[str, Any] | str:
    payload = _graph("GET", "/me", params={"$select": "displayName,userPrincipalName,mail,id"})
    if isinstance(payload, str):
        return payload
    if not isinstance(payload, dict):
        return "Error: unexpected /me payload"
    return {
        "displayName": payload.get("displayName"),
        "userPrincipalName": payload.get("userPrincipalName") or payload.get("mail"),
        "id": payload.get("id"),
    }


def _start_device_flow(client: dict[str, str]) -> dict[str, Any] | str:
    url = f"{_authority(client['tenant'])}/oauth2/v2.0/devicecode"
    status, _hdrs, raw = _http(
        "POST",
        url,
        form={"client_id": client["client_id"], "scope": SCOPE_STR},
    )
    parsed = _json_body(raw)
    if status != 200 or not isinstance(parsed, dict) or not parsed.get("device_code"):
        desc = ""
        if isinstance(parsed, dict):
            desc = str(parsed.get("error_description") or parsed.get("error") or "")
        extra = _safe_error(": " + desc) if desc else ""
        return f"Error: device-code start failed ({status}{extra})"
    if _has_mail_scope(SCOPE_STR):
        return "Error: refusing to request a Mail.* scope"
    expires_in = int(parsed.get("expires_in") or 900)
    interval = int(parsed.get("interval") or 5)
    pending = {
        "device_code": parsed.get("device_code"),
        "user_code": parsed.get("user_code"),
        "verification_uri": parsed.get("verification_uri") or "https://www.microsoft.com/devicelogin",
        "message": parsed.get("message"),
        "interval": max(interval, 5),
        "expires_at": int(_now()) + expires_in,
        "tenant": client["tenant"],
        "client_id": client["client_id"],
    }
    try:
        _save_pending(pending)
    except OSError as exc:
        return f"Error: could not write pending login state ({type(exc).__name__})"
    return pending


def _poll_once(client: dict[str, str], pending: dict[str, Any]) -> dict[str, Any] | str | None:
    """Return token dict on success, error string on hard fail, None if still pending."""
    status, parsed = _form_token(
        client,
        {
            "client_id": client["client_id"],
            "grant_type": DEVICE_GRANT,
            "device_code": str(pending.get("device_code") or ""),
        },
    )
    if status == 200 and isinstance(parsed, dict) and parsed.get("access_token"):
        if _has_mail_scope(str(parsed.get("scope") or "")):
            _clear_pending()
            return "Error: token included a Mail.* scope; refusing to store it."
        err = _save_token(parsed)
        _clear_pending()
        if err:
            return err
        return parsed
    err_code = ""
    desc = ""
    if isinstance(parsed, dict):
        err_code = str(parsed.get("error") or "")
        desc = str(parsed.get("error_description") or "")
    if err_code in {"authorization_pending", "slow_down"}:
        return None
    saved = _load_token()
    if saved and err_code in {"expired_token", "bad_verification_code", "invalid_grant"}:
        _clear_pending()
        return saved
    if err_code == "expired_token":
        _clear_pending()
        return "Error: device code expired. Call onenote_login again."
    if err_code == "authorization_declined":
        _clear_pending()
        return "Error: sign-in was declined."
    if err_code == "bad_verification_code":
        _clear_pending()
        return "Error: device code was not recognized. Call onenote_login again."
    if status in (400, 401) and err_code:
        if saved:
            _clear_pending()
            return saved
        _clear_pending()
        extra = _safe_error(err_code + (": " + desc if desc else ""))
        return f"Error: login failed ({extra})"
    if status >= 500:
        return None
    saved = _load_token()
    if saved:
        _clear_pending()
        return saved
    _clear_pending()
    extra = _safe_error(": " + desc) if desc else ""
    return f"Error: login poll failed ({status}{extra})"


def _poll_until(timeout_seconds: float) -> dict[str, Any] | str | None:
    deadline = _now() + max(timeout_seconds, 0)
    interval = 5.0
    while _now() <= deadline:
        client = _load_client()
        if isinstance(client, str):
            return client
        pending = _load_pending()
        if pending is None:
            token = _load_token()
            if token:
                return token
            return None
        interval = float(pending.get("interval") or interval)
        result = _poll_once(client, pending)
        if result is None:
            sleep_for = interval
            if _now() + sleep_for > deadline:
                break
            time.sleep(sleep_for)
            continue
        return result
    return None


def _background_poll() -> None:
    try:
        _poll_until(900)
    except Exception:
        logger.exception("device-code background poll failed")


def _ensure_poller() -> None:
    global _poll_thread
    with _poll_lock:
        if _poll_thread is not None and _poll_thread.is_alive():
            return
        _poll_thread = threading.Thread(target=_background_poll, name="onenote-device-poll", daemon=True)
        _poll_thread.start()


@mcp.tool()
def onenote_health() -> str:
    """Token valid? Who is signed in (display name / UPN). Never returns tokens."""
    client = _load_client()
    payload: dict[str, Any] = {
        "ok": False,
        "service": "onenote",
        "graph": GRAPH,
        "scopes": list(SCOPES),
        "client_configured": not isinstance(client, str),
        "tenant": client.get("tenant") if isinstance(client, dict) else None,
    }
    if isinstance(client, str):
        payload["error"] = client
        return _dumps(payload)

    pending = _load_pending()
    if pending:
        payload["login_pending"] = _pending_public(pending)

    token = _load_token()
    if token is None and not pending:
        payload["error"] = "not signed in; call onenote_login"
        payload["token_present"] = False
        return _dumps(payload)

    if token is not None:
        payload.update(_token_public_fields(token))
        me = _me()
        if isinstance(me, str):
            payload["error"] = me
            payload["token_valid"] = False
            return _dumps(payload)
        payload["ok"] = True
        payload["token_valid"] = True
        payload["signed_in"] = {
            "displayName": me.get("displayName"),
            "userPrincipalName": me.get("userPrincipalName"),
        }
        return _dumps(payload)

    payload["token_present"] = False
    payload["token_valid"] = False
    payload["error"] = "login pending; finish device sign-in"
    return _dumps(payload)


@mcp.tool()
def onenote_login(wait: bool = True, timeout_seconds: int = DEFAULT_LOGIN_WAIT) -> str:
    """Start Microsoft device-code login. Returns user_code + verification_uri, then polls until done or timeout. Never returns tokens."""
    client = _load_client()
    if isinstance(client, str):
        return client

    existing = _load_token()
    if existing is not None:
        me = _me()
        if not isinstance(me, str):
            return _dumps(
                {
                    "ok": True,
                    "already_signed_in": True,
                    "signed_in": {
                        "displayName": me.get("displayName"),
                        "userPrincipalName": me.get("userPrincipalName"),
                    },
                }
            )

    pending = _load_pending()
    started_new = False
    if pending is None:
        pending = _start_device_flow(client)
        if isinstance(pending, str):
            return pending
        started_new = True

    public = _pending_public(pending)
    if not wait:
        _ensure_poller()
        return _dumps(
            {
                "ok": False,
                "status": "pending",
                "started_new": started_new,
                **public,
                "hint": "Sign in at verification_uri with user_code. Polling continues in the background. Call onenote_health or onenote_login(wait=true) after you finish.",
            }
        )

    result = _poll_until(max(5, int(timeout_seconds)))
    if isinstance(result, str):
        return _dumps({"ok": False, "status": "error", "error": result, **public})
    if isinstance(result, dict) and result.get("access_token"):
        me = _me()
        signed = me if isinstance(me, dict) else None
        out: dict[str, Any] = {
            "ok": True,
            "status": "authenticated",
            "user_code": public.get("user_code"),
            "verification_uri": public.get("verification_uri"),
        }
        if signed:
            out["signed_in"] = {
                "displayName": signed.get("displayName"),
                "userPrincipalName": signed.get("userPrincipalName"),
            }
        elif isinstance(me, str):
            out["signed_in_error"] = me
        return _dumps(out)

    still = _load_pending()
    if still:
        _ensure_poller()
    pub = _pending_public(still) if still else public
    return _dumps(
        {
            "ok": False,
            "status": "pending",
            "started_new": started_new,
            **pub,
            "hint": "Timed out waiting. Finish signing in at verification_uri, then call onenote_login again (or onenote_health). Background polling continues until the code expires.",
        }
    )


@mcp.tool()
def onenote_notebooks() -> str:
    """List OneNote notebooks (id, name, lastModified)."""
    rows = []
    seen: set[str] = set()
    last_err = None
    for root in _onenote_roots():
        chunk = _graph_list(
            f"{root}/notebooks",
            {"$select": "id,displayName,lastModifiedDateTime,createdDateTime", "$orderby": "lastModifiedDateTime desc"},
        )
        if isinstance(chunk, str):
            last_err = chunk
            continue
        for row in chunk:
            rid = str(row.get("id") or "")
            if rid and rid in seen:
                continue
            if rid:
                seen.add(rid)
            rows.append(row)
    if not rows and last_err:
        return last_err
    notebooks = [
        {
            "id": row.get("id"),
            "name": row.get("displayName"),
            "lastModified": row.get("lastModifiedDateTime"),
        }
        for row in rows
    ]
    return _dumps({"count": len(notebooks), "notebooks": notebooks})


@mcp.tool()
def onenote_sections(notebook_id: str) -> str:
    """List sections in a notebook (notebook_id)."""
    nid = (notebook_id or "").strip()
    if not nid:
        return "Error: provide notebook_id"
    payload = _graph_onenote(
        "GET",
        f"/notebooks/{_enc_id(nid)}/sections",
        params={"$select": "id,displayName,lastModifiedDateTime,createdDateTime"},
    )
    if isinstance(payload, str):
        return payload
    if isinstance(payload, dict):
        rows = [r for r in (payload.get("value") or []) if isinstance(r, dict)]
    elif isinstance(payload, list):
        rows = payload
    else:
        return "Error: unexpected sections payload"
    sections = [
        {
            "id": row.get("id"),
            "name": row.get("displayName"),
            "lastModified": row.get("lastModifiedDateTime"),
        }
        for row in rows
    ]
    return _dumps({"notebook_id": nid, "count": len(sections), "sections": sections})


@mcp.tool()
def onenote_pages(section_id: str | None = None, query: str | None = None) -> str:
    """List pages in a section (section_id) or search pages by title (query). Graph page-body search was retired; query matches titles."""
    sid = (section_id or "").strip()
    q = (query or "").strip()
    if not sid and not q:
        return "Error: provide section_id or query"
    params = {
        "$select": "id,title,lastModifiedDateTime,createdDateTime,parentSection",
        "$orderby": "lastModifiedDateTime desc",
        "$top": "50",
    }
    rows: list[dict[str, Any]] | str
    if sid:
        payload = _graph_onenote("GET", f"/sections/{_enc_id(sid)}/pages", params=params)
        if isinstance(payload, str):
            return payload
        if isinstance(payload, dict):
            rows = [r for r in (payload.get("value") or []) if isinstance(r, dict)]
        elif isinstance(payload, list):
            rows = payload
        else:
            return "Error: unexpected pages payload"
    else:
        rows = []
        seen: set[str] = set()
        last_err = None
        for root in _onenote_roots():
            chunk = _graph_list(f"{root}/pages", params)
            if isinstance(chunk, str):
                last_err = chunk
                continue
            for row in chunk:
                rid = str(row.get("id") or "")
                if rid and rid in seen:
                    continue
                if rid:
                    seen.add(rid)
                rows.append(row)
        if not rows and last_err:
            return last_err
    if isinstance(rows, str):
        return rows
    needle = q.casefold()
    pages: list[dict[str, Any]] = []
    for row in rows:
        title = row.get("title") or ""
        if needle and needle not in str(title).casefold():
            continue
        parent = row.get("parentSection") if isinstance(row.get("parentSection"), dict) else {}
        pages.append(
            {
                "id": row.get("id"),
                "title": title,
                "lastModified": row.get("lastModifiedDateTime"),
                "section_id": parent.get("id") if isinstance(parent, dict) else sid or None,
            }
        )
    return _dumps(
        {
            "section_id": sid or None,
            "query": q or None,
            "count": len(pages),
            "search": "title" if q else None,
            "pages": pages,
        }
    )


@mcp.tool()
def onenote_get(page_id: str, include_html: bool = False) -> str:
    """Get one page by page_id (title + text content; HTML stripped to readable text). Set include_html to also return the raw HTML."""
    pid = (page_id or "").strip()
    if not pid:
        return "Error: provide page_id"
    meta = _graph_onenote(
        "GET",
        f"/pages/{_enc_id(pid)}",
        params={"$select": "id,title,lastModifiedDateTime,createdDateTime,parentSection"},
    )
    if isinstance(meta, str):
        return meta
    if not isinstance(meta, dict):
        return "Error: unexpected page metadata"
    content = _graph_onenote(
        "GET",
        f"/pages/{_enc_id(pid)}/content",
        accept="text/html",
        raw=True,
    )
    if isinstance(content, str) and content.startswith("Error:"):
        return content
    if not isinstance(content, (bytes, bytearray)):
        return "Error: page content was not HTML"
    try:
        html_doc = bytes(content).decode("utf-8")
    except UnicodeDecodeError:
        html_doc = bytes(content).decode("utf-8", errors="replace")
    parent = meta.get("parentSection") if isinstance(meta.get("parentSection"), dict) else {}
    payload = {
        "id": meta.get("id") or pid,
        "title": meta.get("title"),
        "lastModified": meta.get("lastModifiedDateTime"),
        "section_id": parent.get("id") if isinstance(parent, dict) else None,
        "text": _html_to_text(html_doc),
    }
    if include_html:
        payload["html"] = html_doc
    return _dumps(payload)


@mcp.tool()
def onenote_create(section_id: str, title: str, html: str | None = None, text: str | None = None) -> str:
    """Create a page in a section. Provide html or plain text body (one of them)."""
    sid = (section_id or "").strip()
    if not sid:
        return "Error: provide section_id"
    page = _page_html(title, html, text)
    if page.startswith("Error:"):
        return page
    created = _graph_onenote(
        "POST",
        f"/sections/{_enc_id(sid)}/pages",
        data=page.encode("utf-8"),
        content_type="text/html; charset=utf-8",
    )
    if isinstance(created, str):
        return created
    if not isinstance(created, dict):
        return "Error: unexpected create response"
    return _dumps(
        {
            "ok": True,
            "id": created.get("id"),
            "title": created.get("title") or title,
            "lastModified": created.get("lastModifiedDateTime"),
            "section_id": sid,
        }
    )


@mcp.tool()
def onenote_update(
    page_id: str,
    html: str | None = None,
    text: str | None = None,
    changes_json: str | None = None,
) -> str:
    """Edit an existing page. Prefer changes_json (Graph PATCH array: target, action, content). Or replace the body with html or text."""
    pid = (page_id or "").strip()
    if not pid:
        return "Error: provide page_id"
    raw_changes = (changes_json or "").strip()
    if raw_changes:
        try:
            changes = json.loads(raw_changes)
        except json.JSONDecodeError as exc:
            return f"Error: changes_json is not valid JSON ({exc})"
        if not isinstance(changes, list) or not changes:
            return "Error: changes_json must be a non-empty JSON array of {target, action, content}"
        for i, item in enumerate(changes):
            if not isinstance(item, dict) or not item.get("target") or not item.get("action"):
                return f"Error: change {i} needs target and action"
    elif html or text:
        body = (html or "").strip()
        if not body:
            parts: list[str] = []
            for para in (text or "").split("\n\n"):
                line = html.escape(para).replace("\n", "<br/>")
                parts.append(f"<p>{line}</p>" if line.strip() else "<p></p>")
            body = "".join(parts) or "<p></p>"
        changes = [{"target": "body", "action": "replace", "content": body}]
    else:
        return "Error: provide changes_json, or html/text to replace the body"
    updated = _graph_onenote(
        "PATCH",
        f"/pages/{_enc_id(pid)}/content",
        data=json.dumps(changes).encode("utf-8"),
        content_type="application/json",
    )
    if isinstance(updated, str):
        return updated
    return _dumps({"ok": True, "id": pid, "changes": len(changes)})



if __name__ == "__main__":
    logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="%(name)s %(levelname)s %(message)s")
    mcp.run()
