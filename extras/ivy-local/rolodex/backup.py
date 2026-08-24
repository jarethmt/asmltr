#!/usr/bin/env python3
"""Daily rotating copies of contacts.json. Not a lookup store.

One file per America/New_York calendar day: backups/contacts-YYYYMMDD.json.
The first snapshot of the day wins, so a later sync after a write does not
clobber that day's rollback point. Never more than KEEP copies.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
KEEP = 5
NAME_RE = re.compile(r"^contacts-(\d{8})\.json$")


def cache_dir() -> Path:
    return Path(os.environ.get("ROLODEX_CACHE") or (Path.home() / ".asmltr" / "rolodex-cache")).expanduser()


def backup_dir(root: Path | None = None) -> Path:
    override = os.environ.get("ROLODEX_BACKUP_DIR")
    if override:
        return Path(override).expanduser()
    return (root or cache_dir()) / "backups"


def contacts_path(root: Path | None = None) -> Path:
    return (root or cache_dir()) / "contacts.json"


def today_et(now: datetime | None = None) -> str:
    ts = now or datetime.now(tz=ET)
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=ET)
    else:
        ts = ts.astimezone(ET)
    return ts.strftime("%Y%m%d")


def _ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path, 0o700)
    except OSError:
        pass


def list_backup_files(dest_dir: Path) -> list[Path]:
    if not dest_dir.is_dir():
        return []
    dated: list[tuple[str, Path]] = []
    for path in dest_dir.iterdir():
        if not path.is_file():
            continue
        match = NAME_RE.match(path.name)
        if match:
            dated.append((match.group(1), path))
    dated.sort(key=lambda item: item[0], reverse=True)
    return [path for _, path in dated]


def prune(dest_dir: Path, keep: int = KEEP) -> list[str]:
    keep = max(1, min(KEEP, keep))
    extra = list_backup_files(dest_dir)[keep:]
    removed: list[str] = []
    for path in extra:
        try:
            path.unlink()
            removed.append(path.name)
        except OSError:
            continue
    return removed


def contact_count(path: Path) -> int | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if isinstance(data, list):
        return len(data)
    if isinstance(data, dict):
        results = data.get("results")
        if isinstance(results, list):
            return len(results)
        count = data.get("count")
        if isinstance(count, int):
            return count
    return None


def load_results(path: Path) -> list[dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, list):
        rows = data
    elif isinstance(data, dict):
        rows = data.get("results")
    else:
        rows = None
    if not isinstance(rows, list):
        raise ValueError(f"{path.name} has no results list")
    return [row for row in rows if isinstance(row, dict)]


def list_backups(dest_dir: Path) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for path in list_backup_files(dest_dir):
        match = NAME_RE.match(path.name)
        item: dict[str, Any] = {
            "file": path.name,
            "day": match.group(1) if match else None,
            "contacts": contact_count(path),
            "bytes": path.stat().st_size,
        }
        out.append(item)
    return out


def resolve_backup(dest_dir: Path, backup: str | None = None) -> Path:
    files = list_backup_files(dest_dir)
    if not files:
        raise FileNotFoundError("no contacts backups")
    if not backup:
        return files[0]
    wanted = backup.strip()
    if wanted.endswith(".json"):
        name = Path(wanted).name
    else:
        digits = "".join(ch for ch in wanted if ch.isdigit())
        if len(digits) != 8:
            raise FileNotFoundError(f"backup not found: {backup}")
        name = f"contacts-{digits}.json"
    for path in files:
        if path.name == name:
            return path
    raise FileNotFoundError(f"backup not found: {backup}")


def find_contact(
    rows: list[dict[str, Any]],
    *,
    name: str | None = None,
    resource_name: str | None = None,
) -> dict[str, Any] | None:
    resource = (resource_name or "").strip()
    if resource:
        for row in rows:
            if row.get("resourceName") == resource:
                return row
        return None
    label = (name or "").strip().casefold()
    if not label:
        return None
    exact = [row for row in rows if (row.get("displayName") or "").casefold() == label]
    if exact:
        return exact[0]
    return None


def snapshot(
    src: Path,
    dest_dir: Path,
    *,
    day: str | None = None,
    keep: int = KEEP,
    overwrite: bool = False,
) -> dict[str, Any]:
    stamp = day or today_et()
    if not re.fullmatch(r"\d{8}", stamp):
        return {"ok": False, "error": "day must be YYYYMMDD"}
    _ensure_dir(dest_dir)
    dest = dest_dir / f"contacts-{stamp}.json"
    if dest.exists() and not overwrite:
        return {
            "ok": True,
            "skipped": True,
            "file": dest.name,
            "day": stamp,
            "path": str(dest),
            "keep": KEEP,
            "copies": len(list_backup_files(dest_dir)),
        }
    if not src.is_file():
        return {"ok": False, "error": "contacts.json missing"}
    tmp = dest.with_name(f".{dest.name}.tmp.{os.getpid()}")
    try:
        shutil.copyfile(src, tmp)
        os.chmod(tmp, 0o600)
        os.replace(tmp, dest)
        os.chmod(dest, 0o600)
    except OSError as exc:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        return {"ok": False, "error": f"could not write backup ({type(exc).__name__})"}
    removed = prune(dest_dir, keep=keep)
    copies = list_backup_files(dest_dir)
    return {
        "ok": True,
        "skipped": False,
        "file": dest.name,
        "day": stamp,
        "path": str(dest),
        "keep": KEEP,
        "copies": len(copies),
        "pruned": removed,
        "contacts": contact_count(dest),
    }


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    cmd = args[0] if args else "snapshot"
    root = cache_dir()
    dest = backup_dir(root)
    src = contacts_path(root)
    if cmd == "snapshot":
        payload = snapshot(src, dest)
    elif cmd == "list":
        payload = {
            "ok": True,
            "dir": str(dest),
            "keep": KEEP,
            "copies": len(list_backup_files(dest)),
            "backups": list_backups(dest),
        }
    elif cmd == "prune":
        removed = prune(dest)
        payload = {
            "ok": True,
            "dir": str(dest),
            "keep": KEEP,
            "pruned": removed,
            "copies": len(list_backup_files(dest)),
        }
    else:
        print("usage: backup.py [snapshot|list|prune]", file=sys.stderr)
        return 2
    print(json.dumps(payload, indent=2, ensure_ascii=False))
    return 0 if payload.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
