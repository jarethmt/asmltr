#!/usr/bin/env python3
"""Stdio MCP: Rolodex cache.

Reads ~/.asmltr/rolodex-cache/contacts.json (refreshed from ROLODEX_URL /export).
Writes (create / add-phone / delete) go to the live localhost API, then update that row.
Daily copies of contacts.json live in backups/ (max 5, not a lookup store).
Aliases stay in that cache dir and are never overwritten by sync.
Eve: skip extras/ivy-local unless you want these extras.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from mcp.server import MCPServer

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))
import backup as rolodex_backup

CACHE_DIR = Path(os.environ.get("ROLODEX_CACHE") or (Path.home() / ".asmltr" / "rolodex-cache")).expanduser()
CONTACTS_PATH = CACHE_DIR / "contacts.json"
ALIASES_PATH = CACHE_DIR / "aliases.json"
BACKUP_DIR = rolodex_backup.backup_dir(CACHE_DIR)
SYNC_SCRIPT = _SCRIPT_DIR / "sync.sh"
ROLODEX_API = (os.environ.get("ROLODEX_URL") or "http://127.0.0.1:8081").rstrip("/")
ET = ZoneInfo("America/New_York")

mcp = MCPServer("rolodex")

# Owner disclosure. Full text: Self silo memory/identity/privacy.md
DISCLOSURE = {
    "rule": "Do not give company or contact info on public channels, or to anyone who is not the owner, unless a programmed email routine or a command the owner gave directly.",
    "source": "memory/identity/privacy.md",
}


def _dumps(payload: Any) -> str:
    return json.dumps(payload, indent=2, ensure_ascii=False)


def _lookup_payload(payload: Any) -> str:
    """Attach the disclosure gate to every contact record returned to the model."""
    if isinstance(payload, str):
        if payload.startswith("Error:"):
            return payload
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError:
            return payload
    if isinstance(payload, dict):
        out = dict(payload)
        out["disclosure"] = dict(DISCLOSURE)
        return _dumps(out)
    return _dumps(payload)


def _load_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as fh:
        return json.load(fh)


def _load_contacts() -> list[dict[str, Any]] | str:
    if not CONTACTS_PATH.is_file():
        return "Error: contacts.json missing. Run rolodex_sync (or wait for the scheduled timer)."
    try:
        data = _load_json(CONTACTS_PATH)
    except (OSError, json.JSONDecodeError) as exc:
        return f"Error: contacts.json unreadable ({type(exc).__name__})"
    if isinstance(data, list):
        results = data
    elif isinstance(data, dict):
        results = data.get("results")
    else:
        results = None
    if not isinstance(results, list):
        return "Error: contacts.json has no results list"
    return [row for row in results if isinstance(row, dict)]


def _load_aliases() -> dict[str, dict[str, Any]] | str:
    if not ALIASES_PATH.is_file():
        return {}
    try:
        data = _load_json(ALIASES_PATH)
    except (OSError, json.JSONDecodeError) as exc:
        return f"Error: aliases.json unreadable ({type(exc).__name__})"
    if not isinstance(data, dict):
        return "Error: aliases.json must be an object"
    out: dict[str, dict[str, Any]] = {}
    for key, value in data.items():
        if isinstance(key, str) and isinstance(value, dict):
            out[key.casefold()] = value
    return out


def _save_aliases(aliases: dict[str, dict[str, Any]]) -> str | None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = ALIASES_PATH.with_name(f"aliases.json.tmp.{os.getpid()}")
    try:
        tmp.write_text(_dumps(aliases) + "\n", encoding="utf-8")
        os.chmod(tmp, 0o600)
        os.replace(tmp, ALIASES_PATH)
        os.chmod(ALIASES_PATH, 0o600)
    except OSError as exc:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        return f"Error: could not write aliases.json ({type(exc).__name__})"
    return None


def _digits(value: str) -> str:
    return "".join(ch for ch in value if ch.isdigit())


def _contact_matches(row: dict[str, Any], needle: str) -> bool:
    if needle in (row.get("displayName") or "").casefold():
        return True
    org = row.get("organization")
    if isinstance(org, str) and needle in org.casefold():
        return True
    for email in row.get("emails") or []:
        if isinstance(email, str) and needle in email.casefold():
            return True
    needle_digits = _digits(needle)
    for phone in row.get("phones") or []:
        if not isinstance(phone, str):
            continue
        if needle in phone.casefold():
            return True
        if needle_digits and needle_digits in _digits(phone):
            return True
    return False


def _prefs_for(resource: str, aliases: dict[str, dict[str, Any]]) -> dict[str, Any]:
    extra: dict[str, Any] = {}
    keys: list[str] = []
    for key, rec in aliases.items():
        if (rec.get("resourceName") or "") == resource:
            keys.append(key)
            email = (rec.get("preferredEmail") or "").strip()
            phone = (rec.get("preferredPhone") or "").strip()
            aka = (rec.get("alsoKnownAs") or "").strip()
            notes = (rec.get("notes") or "").strip()
            if email and "preferredEmail" not in extra:
                extra["preferredEmail"] = email
            if phone and "preferredPhone" not in extra:
                extra["preferredPhone"] = phone
            if aka and "alsoKnownAs" not in extra:
                extra["alsoKnownAs"] = aka
            if notes and "notes" not in extra:
                extra["notes"] = notes
    if keys:
        extra["aliases"] = keys
    return extra


def _decorate(row: dict[str, Any], aliases: dict[str, dict[str, Any]]) -> dict[str, Any]:
    out = dict(row)
    resource = out.get("resourceName") or ""
    if resource:
        out.update(_prefs_for(resource, aliases))
    return out


def _find_by_resource(contacts: list[dict[str, Any]], resource: str) -> dict[str, Any] | None:
    for row in contacts:
        if row.get("resourceName") == resource:
            return row
    return None


def _search_contacts(contacts: list[dict[str, Any]], query: str) -> list[dict[str, Any]]:
    needle = query.casefold()
    hits = [row for row in contacts if _contact_matches(row, needle)]
    exact = [row for row in hits if (row.get("displayName") or "").casefold() == needle]
    if exact:
        seen = {id(row) for row in exact}
        return exact + [row for row in hits if id(row) not in seen]
    return hits


def _mtime_et(path: Path) -> str | None:
    if not path.is_file():
        return None
    ts = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).astimezone(ET)
    return ts.isoformat(timespec="seconds")


def _pick_one(
    contacts: list[dict[str, Any]],
    aliases: dict[str, dict[str, Any]],
    name: str | None,
    resource_name: str | None,
) -> dict[str, Any] | str:
    resource = (resource_name or "").strip()
    label = (name or "").strip()
    if not resource and not label:
        return "Error: provide name or resourceName"
    if not resource and (label.startswith("people/") or label.startswith("otherContacts/")):
        resource, label = label, ""

    alias_key = None
    if not resource and label:
        key = label.casefold()
        rec = aliases.get(key)
        if rec:
            alias_key = key
            resource = (rec.get("resourceName") or "").strip()
            if not resource:
                return f"Error: alias {key!r} has no resourceName"

    if resource:
        row = _find_by_resource(contacts, resource)
        if row is None:
            payload = {
                "error": "not found",
                "resourceName": resource,
                "name": label or None,
            }
            if alias_key:
                payload["alias"] = alias_key
            return _dumps(payload)
        out = _decorate(row, aliases)
        if alias_key:
            out["alias"] = alias_key
        return out

    hits = _search_contacts(contacts, label)
    if not hits:
        return _dumps({"error": "not found", "name": label})
    needle = label.casefold()
    chosen = hits[0]
    for row in hits:
        if (row.get("displayName") or "").casefold() == needle:
            chosen = row
            break
    return _decorate(chosen, aliases)


@mcp.tool()
def rolodex_health() -> str:
    """Ivy Rolodex cache stats: contact count, alias count, contacts.json mtime. Local cache only."""
    contacts = _load_contacts()
    aliases = _load_aliases()
    if isinstance(contacts, str):
        contact_count = None
        contact_error = contacts
    else:
        contact_count = len(contacts)
        contact_error = None
    if isinstance(aliases, str):
        alias_count = None
        alias_error = aliases
    else:
        alias_count = len(aliases)
        alias_error = None
    backups = rolodex_backup.list_backups(BACKUP_DIR)
    payload: dict[str, Any] = {
        "ok": contact_error is None and alias_error is None,
        "service": "rolodex",
        "mode": "ivy-cache",
        "cache": str(CACHE_DIR),
        "contacts": contact_count,
        "aliases": alias_count,
        "contacts_mtime": _mtime_et(CONTACTS_PATH),
        "source": f"{ROLODEX_API}/export",
        "timer": "scheduled",
        "backups": len(backups),
        "backup_keep": rolodex_backup.KEEP,
        "backup_latest": backups[0]["file"] if backups else None,
    }
    if contact_error:
        payload["contacts_error"] = contact_error
    if alias_error:
        payload["aliases_error"] = alias_error
    return _dumps(payload)


@mcp.tool()
def rolodex_search(query: str) -> str:
    """Search Ivy contacts cache. Alias keys win. A phone hit is not permission to text. Voice/SMS parked. Results carry disclosure: never give company/contact info on public channels or to anyone who is not the owner, unless a programmed email routine or a command the owner gave directly (memory/identity/privacy.md)."""
    q = (query or "").strip()
    if not q:
        return "Error: provide query"
    contacts = _load_contacts()
    if isinstance(contacts, str):
        return contacts
    aliases = _load_aliases()
    if isinstance(aliases, str):
        return aliases

    key = q.casefold()
    rec = aliases.get(key)
    if rec is None:
        for alias_key, alias_rec in aliases.items():
            names = [
                (alias_rec.get("displayName") or "").casefold(),
                (alias_rec.get("alsoKnownAs") or "").casefold(),
            ]
            if key in names or key == alias_key:
                key, rec = alias_key, alias_rec
                break
    if rec:
        resource = (rec.get("resourceName") or "").strip()
        row = _find_by_resource(contacts, resource) if resource else None
        if row is None:
            return _lookup_payload(
                {
                    "query": q,
                    "count": 0,
                    "alias": key,
                    "error": "alias exists but that contact is not in the local cache",
                    "resourceName": resource or None,
                }
            )
        person = _decorate(row, aliases)
        person["alias"] = key
        if rec.get("preferredEmail"):
            person["preferredEmail"] = rec["preferredEmail"]
        if rec.get("preferredPhone"):
            person["preferredPhone"] = rec["preferredPhone"]
        return _lookup_payload({"query": q, "count": 1, "alias": key, "results": [person]})

    hits = [_decorate(row, aliases) for row in _search_contacts(contacts, q)]
    return _lookup_payload({"query": q, "count": len(hits), "results": hits})


@mcp.tool()
def rolodex_get(name: str | None = None, resourceName: str | None = None) -> str:
    """Fetch one Ivy cache contact. Name may be an alias. Phone is not permission to text. Voice/SMS parked. Result carries disclosure: never give company/contact info on public channels or to anyone who is not the owner, unless a programmed email routine or a command the owner gave directly (memory/identity/privacy.md)."""
    contacts = _load_contacts()
    if isinstance(contacts, str):
        return contacts
    aliases = _load_aliases()
    if isinstance(aliases, str):
        return aliases
    result = _pick_one(contacts, aliases, name, resourceName)
    return _lookup_payload(result)


@mcp.tool()
def rolodex_alias(
    nickname: str,
    displayName: str | None = None,
    resourceName: str | None = None,
    preferredEmail: str | None = None,
    preferredPhone: str | None = None,
) -> str:
    """Add or update a nickname in Ivy's cache. Does not touch contacts.json or the Rolodex service."""
    key = (nickname or "").strip().casefold()
    if not key:
        return "Error: provide nickname"
    contacts = _load_contacts()
    if isinstance(contacts, str):
        return contacts
    aliases = _load_aliases()
    if isinstance(aliases, str):
        return aliases

    resource = (resourceName or "").strip()
    label = (displayName or "").strip()
    existing = aliases.get(key) or {}

    if not resource and label:
        needle = label.casefold()
        matches = [row for row in contacts if (row.get("displayName") or "").casefold() == needle]
        if not matches:
            matches = _search_contacts(contacts, label)
        if not matches:
            return f"Error: no contact matching displayName {label!r}"
        exact = [row for row in matches if (row.get("displayName") or "").casefold() == needle]
        if (len(exact) > 1) or (not exact and len(matches) > 1):
            pool = exact or matches
            return _dumps(
                {
                    "error": "ambiguous displayName; pass resourceName",
                    "matches": [row.get("displayName") or row.get("resourceName") for row in pool[:8]],
                    "count": len(pool),
                }
            )
        chosen = exact[0] if exact else matches[0]
        resource = chosen.get("resourceName") or ""
        if not label:
            label = chosen.get("displayName") or ""

    if not resource:
        resource = (existing.get("resourceName") or "").strip()
    if not resource:
        return "Error: provide displayName or resourceName"

    row = _find_by_resource(contacts, resource)
    if row is None:
        return f"Error: resourceName {resource!r} is not in the local cache"

    record: dict[str, Any] = {
        "displayName": label or row.get("displayName") or existing.get("displayName"),
        "resourceName": resource,
    }
    email = (preferredEmail or "").strip() or (existing.get("preferredEmail") or "").strip()
    phone = (preferredPhone or "").strip() or (existing.get("preferredPhone") or "").strip()
    if email:
        record["preferredEmail"] = email
    if phone:
        record["preferredPhone"] = phone

    aliases[key] = record
    err = _save_aliases(aliases)
    if err:
        return err
    return _lookup_payload({"ok": True, "nickname": key, "alias": record})


def _snapshot_today() -> dict[str, Any]:
    """First contacts.json copy of the ET day wins. Never more than 5."""
    try:
        return rolodex_backup.snapshot(CONTACTS_PATH, BACKUP_DIR)
    except OSError as exc:
        return {"ok": False, "error": type(exc).__name__}


def _api_get(path: str, params: dict[str, str] | None = None) -> tuple[dict[str, Any], int]:
    qs = urllib.parse.urlencode({k: v for k, v in (params or {}).items() if v})
    url = f"{ROLODEX_API}{path}" + (f"?{qs}" if qs else "")
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.loads(resp.read().decode("utf-8") or "{}")
            return body if isinstance(body, dict) else {"error": "bad response"}, resp.status
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            body = json.loads(raw or "{}")
        except json.JSONDecodeError:
            body = {"error": raw or f"http {exc.code}"}
        if not isinstance(body, dict):
            body = {"error": raw or f"http {exc.code}"}
        return body, exc.code
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return {"error": f"rolodex unreachable ({type(exc).__name__})"}, 502


def _api_post(path: str, payload: dict[str, Any]) -> tuple[dict[str, Any], int]:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{ROLODEX_API}{path}",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.loads(resp.read().decode("utf-8") or "{}")
            return body if isinstance(body, dict) else {"error": "bad response"}, resp.status
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            body = json.loads(raw or "{}")
        except json.JSONDecodeError:
            body = {"error": raw or f"http {exc.code}"}
        if not isinstance(body, dict):
            body = {"error": raw or f"http {exc.code}"}
        return body, exc.code
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return {"error": f"rolodex unreachable ({type(exc).__name__})"}, 502


def _save_contacts_list(rows: list[dict[str, Any]]) -> str | None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    payload = {"count": len(rows), "results": rows}
    tmp = CONTACTS_PATH.with_name(f"contacts.json.tmp.{os.getpid()}")
    try:
        tmp.write_text(_dumps(payload) + "\n", encoding="utf-8")
        os.chmod(tmp, 0o600)
        os.replace(tmp, CONTACTS_PATH)
        os.chmod(CONTACTS_PATH, 0o600)
    except OSError as exc:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        return f"Error: could not update contacts.json ({type(exc).__name__})"
    return None


def _upsert_cache(person: dict[str, Any]) -> None:
    resource = person.get("resourceName")
    if not resource:
        return
    contacts = _load_contacts()
    if isinstance(contacts, str):
        return
    row = {
        "resourceName": resource,
        "displayName": person.get("displayName"),
        "emails": person.get("emails") or [],
        "phones": person.get("phones") or [],
        "organization": person.get("organization"),
        "source": person.get("source") or "contact",
    }
    replaced = False
    for i, existing in enumerate(contacts):
        if existing.get("resourceName") == resource:
            contacts[i] = row
            replaced = True
            break
    if not replaced:
        contacts.append(row)
    _save_contacts_list(contacts)


@mcp.tool()
def rolodex_create(
    displayName: str | None = None,
    phone: str | None = None,
    email: str | None = None,
    organization: str | None = None,
    phoneType: str | None = None,
    givenName: str | None = None,
    familyName: str | None = None,
) -> str:
    """Create a Google contact (live write). Syncs that row into the local cache."""
    payload = {
        "displayName": (displayName or "").strip(),
        "givenName": (givenName or "").strip(),
        "familyName": (familyName or "").strip(),
        "phone": (phone or "").strip(),
        "phoneType": (phoneType or "mobile").strip() or "mobile",
        "email": (email or "").strip(),
        "organization": (organization or "").strip(),
    }
    if not any(payload[k] for k in ("displayName", "givenName", "familyName", "phone", "email")):
        return "Error: provide a name, phone, or email"
    _snapshot_today()
    body, status = _api_post("/create", payload)
    if status != 200:
        return _dumps({"ok": False, "status": status, **body})
    _upsert_cache(body)
    return _lookup_payload(body)


@mcp.tool()
def rolodex_add_phone(
    phone: str,
    name: str | None = None,
    resourceName: str | None = None,
    phoneType: str | None = None,
) -> str:
    """Add a phone number to an existing Google contact. Writes through to Google, then the cache."""
    number = (phone or "").strip()
    if not number:
        return "Error: provide phone"
    payload = {
        "phone": number,
        "phoneType": (phoneType or "mobile").strip() or "mobile",
        "name": (name or "").strip(),
        "resourceName": (resourceName or "").strip(),
    }
    if not payload["name"] and not payload["resourceName"]:
        return "Error: provide name or resourceName"
    _snapshot_today()
    body, status = _api_post("/add-phone", payload)
    if status != 200:
        return _dumps({"ok": False, "status": status, **body})
    _upsert_cache(body)
    return _lookup_payload(body)


@mcp.tool()
def rolodex_add_email(
    email: str,
    name: str | None = None,
    resourceName: str | None = None,
    emailType: str | None = None,
) -> str:
    """Add an email to an existing Google contact. Writes through to Google, then the cache."""
    mail = (email or "").strip()
    if not mail:
        return "Error: provide email"
    payload = {
        "email": mail,
        "emailType": (emailType or "").strip(),
        "name": (name or "").strip(),
        "resourceName": (resourceName or "").strip(),
    }
    if not payload["name"] and not payload["resourceName"]:
        return "Error: provide name or resourceName"
    _snapshot_today()
    body, status = _api_post("/add-email", payload)
    if status != 200:
        return _dumps({"ok": False, "status": status, **body})
    _upsert_cache(body)
    return _lookup_payload(body)


def _drop_cache(resource: str) -> None:
    contacts = _load_contacts()
    if isinstance(contacts, str) or not resource:
        return
    kept = [row for row in contacts if row.get("resourceName") != resource]
    if len(kept) != len(contacts):
        _save_contacts_list(kept)


@mcp.tool()
def rolodex_delete(name: str | None = None, resourceName: str | None = None) -> str:
    """Delete a Google My Contact (live write). Drops that row from the local cache."""
    payload = {
        "name": (name or "").strip(),
        "resourceName": (resourceName or "").strip(),
    }
    if not payload["name"] and not payload["resourceName"]:
        return "Error: provide name or resourceName"
    _snapshot_today()
    body, status = _api_post("/delete", payload)
    if status != 200:
        return _dumps({"ok": False, "status": status, **body})
    _drop_cache(str(body.get("resourceName") or payload["resourceName"]))
    return _lookup_payload(body)


@mcp.tool()
def rolodex_sync() -> str:
    """Refresh Ivy contacts.json from localhost Rolodex GET /export. Never writes aliases.json. Snapshots today's backup if that day is empty."""
    if not SYNC_SCRIPT.is_file():
        return f"Error: sync script missing at {SYNC_SCRIPT}"
    try:
        completed = subprocess.run(
            [str(SYNC_SCRIPT)],
            capture_output=True,
            text=True,
            timeout=210,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return "Error: sync timed out (aliases.json not touched)"
    except OSError as exc:
        return f"Error: could not start sync ({type(exc).__name__})"

    if completed.returncode != 0:
        err = (completed.stderr or completed.stdout or "").strip() or f"exit {completed.returncode}"
        return f"Error: sync failed (exit {completed.returncode}): {err}"

    contacts = _load_contacts()
    aliases = _load_aliases()
    backups = rolodex_backup.list_backups(BACKUP_DIR)
    return _dumps(
        {
            "ok": True,
            "message": (completed.stdout or "").strip(),
            "contacts": len(contacts) if isinstance(contacts, list) else None,
            "aliases": len(aliases) if isinstance(aliases, dict) else None,
            "contacts_mtime": _mtime_et(CONTACTS_PATH),
            "backups": len(backups),
            "backup_latest": backups[0]["file"] if backups else None,
        }
    )


@mcp.tool()
def rolodex_backups() -> str:
    """List rotating contacts.json copies (filename, day, count). Max 5. No contact payloads."""
    backups = rolodex_backup.list_backups(BACKUP_DIR)
    return _dumps(
        {
            "ok": True,
            "dir": str(BACKUP_DIR),
            "keep": rolodex_backup.KEEP,
            "copies": len(backups),
            "backups": backups,
        }
    )


def _live_my_contact(name: str) -> dict[str, Any] | None:
    body, status = _api_get("/search", {"q": name})
    if status != 200:
        return None
    needle = name.casefold()
    for row in body.get("results") or []:
        if not isinstance(row, dict):
            continue
        if row.get("source") != "contact":
            continue
        if (row.get("displayName") or "").casefold() == needle:
            return row
    return None


@mcp.tool()
def rolodex_restore(
    name: str | None = None,
    resourceName: str | None = None,
    backup: str | None = None,
) -> str:
    """Recreate one My Contact in Google from a local daily backup. Does not bulk-restore the dump."""
    label = (name or "").strip()
    resource = (resourceName or "").strip()
    if not label and not resource:
        return "Error: provide name or resourceName"
    try:
        path = rolodex_backup.resolve_backup(BACKUP_DIR, backup)
        rows = rolodex_backup.load_results(path)
    except FileNotFoundError as exc:
        return f"Error: {exc}"
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        return f"Error: backup unreadable ({type(exc).__name__})"

    row = rolodex_backup.find_contact(rows, name=label, resource_name=resource)
    if row is None:
        return _dumps(
            {
                "ok": False,
                "error": "not found in backup",
                "name": label or None,
                "resourceName": resource or None,
                "backup": path.name,
            }
        )
    if (row.get("source") or "contact") != "contact":
        return _dumps(
            {
                "ok": False,
                "error": "backup row is not a My Contact",
                "backup": path.name,
                "source": row.get("source"),
            }
        )

    display = (row.get("displayName") or label or "").strip()
    phones = [p for p in (row.get("phones") or []) if isinstance(p, str) and p.strip()]
    emails = [e for e in (row.get("emails") or []) if isinstance(e, str) and e.strip()]
    org = (row.get("organization") or "").strip()

    if display:
        existing = _live_my_contact(display)
        if existing:
            return _lookup_payload(
                {
                    "ok": False,
                    "error": "already in Google",
                    "backup": path.name,
                    "resourceName": existing.get("resourceName"),
                    "displayName": existing.get("displayName"),
                }
            )

    create_body = {
        "displayName": display,
        "phone": phones[0] if phones else "",
        "email": emails[0] if emails else "",
        "organization": org,
        "phoneType": "mobile",
    }
    if not any(create_body[k] for k in ("displayName", "phone", "email")):
        return "Error: backup row has no name, phone, or email"
    body, status = _api_post("/create", create_body)
    if status != 200:
        return _dumps({"ok": False, "status": status, "backup": path.name, **body})

    created = dict(body)
    extra_phones: list[str] = []
    new_resource = str(created.get("resourceName") or "")
    for number in phones[1:]:
        extra, extra_status = _api_post(
            "/add-phone",
            {"phone": number, "resourceName": new_resource, "phoneType": "mobile"},
        )
        if extra_status == 200:
            created = extra
            extra_phones.append(number)
    _upsert_cache(created)
    return _lookup_payload(
        {
            "ok": True,
            "restored": True,
            "backup": path.name,
            "addedPhones": 1 + len(extra_phones) if phones else 0,
            "addedEmails": 1 if emails else 0,
            **created,
        }
    )


if __name__ == "__main__":
    mcp.run()
