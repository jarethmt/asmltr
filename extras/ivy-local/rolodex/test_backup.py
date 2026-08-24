#!/usr/bin/env python3
"""Tests for daily contacts.json backup rotation (max 5)."""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

import backup


def _dump(path: Path, n: int) -> None:
    payload = {
        "count": n,
        "results": [
            {
                "resourceName": f"people/{i}",
                "displayName": f"Person {i}",
                "emails": [],
                "phones": [],
                "organization": None,
                "source": "contact",
            }
            for i in range(n)
        ],
    }
    path.write_text(json.dumps(payload), encoding="utf-8")
    os.chmod(path, 0o600)


class BackupTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.src = self.root / "contacts.json"
        self.dest = self.root / "backups"
        _dump(self.src, 3)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_first_snapshot_writes_day_file(self) -> None:
        result = backup.snapshot(self.src, self.dest, day="20260819")
        self.assertTrue(result["ok"])
        self.assertFalse(result["skipped"])
        dest = self.dest / "contacts-20260819.json"
        self.assertTrue(dest.is_file())
        self.assertEqual(oct(dest.stat().st_mode & 0o777), "0o600")
        self.assertEqual(oct(self.dest.stat().st_mode & 0o777), "0o700")
        self.assertEqual(result["contacts"], 3)
        self.assertEqual(result["copies"], 1)

    def test_second_same_day_does_not_overwrite(self) -> None:
        backup.snapshot(self.src, self.dest, day="20260819")
        _dump(self.src, 9)
        result = backup.snapshot(self.src, self.dest, day="20260819")
        self.assertTrue(result["ok"])
        self.assertTrue(result["skipped"])
        self.assertEqual(backup.contact_count(self.dest / "contacts-20260819.json"), 3)

    def test_overwrite_replaces_same_day(self) -> None:
        backup.snapshot(self.src, self.dest, day="20260819")
        _dump(self.src, 9)
        result = backup.snapshot(self.src, self.dest, day="20260819", overwrite=True)
        self.assertFalse(result["skipped"])
        self.assertEqual(result["contacts"], 9)

    def test_prune_never_keeps_more_than_five(self) -> None:
        for i, day in enumerate(("20260815", "20260816", "20260817", "20260818", "20260819", "20260820")):
            _dump(self.src, i + 1)
            backup.snapshot(self.src, self.dest, day=day)
        files = backup.list_backup_files(self.dest)
        self.assertEqual(len(files), 5)
        names = [path.name for path in files]
        self.assertEqual(
            names,
            [
                "contacts-20260820.json",
                "contacts-20260819.json",
                "contacts-20260818.json",
                "contacts-20260817.json",
                "contacts-20260816.json",
            ],
        )
        self.assertFalse((self.dest / "contacts-20260815.json").exists())

    def test_keep_argument_cannot_exceed_five(self) -> None:
        for day in ("20260815", "20260816", "20260817", "20260818", "20260819", "20260820"):
            backup.snapshot(self.src, self.dest, day=day, keep=99)
        self.assertEqual(len(backup.list_backup_files(self.dest)), 5)

    def test_find_contact_exact_name(self) -> None:
        rows = backup.load_results(self.src)
        hit = backup.find_contact(rows, name="person 1")
        self.assertIsNotNone(hit)
        assert hit is not None
        self.assertEqual(hit["resourceName"], "people/1")
        self.assertIsNone(backup.find_contact(rows, name="missing"))

    def test_resolve_backup_newest_default(self) -> None:
        backup.snapshot(self.src, self.dest, day="20260818")
        backup.snapshot(self.src, self.dest, day="20260819")
        newest = backup.resolve_backup(self.dest)
        self.assertEqual(newest.name, "contacts-20260819.json")
        by_day = backup.resolve_backup(self.dest, "20260818")
        self.assertEqual(by_day.name, "contacts-20260818.json")

    def test_missing_src_fails(self) -> None:
        result = backup.snapshot(self.root / "nope.json", self.dest, day="20260819")
        self.assertFalse(result["ok"])


if __name__ == "__main__":
    unittest.main()
