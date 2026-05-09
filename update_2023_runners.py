#!/usr/bin/env python3
"""Backfill runner names per leg in splits_2023.csv from EQTiming startlist.

The 2023 result endpoint doesn't expose per-leg runners, but the startlist
records `StafettDeltakere` for each team — a dict keyed by `Sortering` (etappe
number) with Fornavn/Etternavn. This script merges those names into the CSV.
"""
import csv
import json
import ssl
import urllib.request
from pathlib import Path

import certifi

ROOT = Path(__file__).parent
SRC = ROOT / "splits_2023.csv"
OUT = ROOT / "splits_2023.csv"  # rewrite in place
EVENTID = 61907

ctx = ssl.create_default_context(cafile=certifi.where())


def fetch_startlist() -> dict[int, dict[int, str]]:
    url = f"https://live.eqtiming.com/api/startlist/{EVENTID}?count=10000&startAt=1"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60, context=ctx) as r:
        data = json.loads(r.read())
    items = data.get("Items") or {}
    if isinstance(items, dict):
        items = list(items.values())
    runners: dict[int, dict[int, str]] = {}
    for it in items:
        bib = it.get("Startnummer")
        sd = it.get("StafettDeltakere") or {}
        if not bib or not sd:
            continue
        per_leg: dict[int, str] = {}
        for v in sd.values():
            try:
                et = int(v.get("Sortering", 0))
            except (TypeError, ValueError):
                continue
            if 1 <= et <= 15:
                name = f"{(v.get('Fornavn') or '').strip()} {(v.get('Etternavn') or '').strip()}".strip()
                if name:
                    per_leg[et] = name
        if per_leg:
            runners[bib] = per_leg
    return runners


def main() -> int:
    runners = fetch_startlist()
    print(f"loaded runners for {len(runners)} teams")

    rows = list(csv.DictReader(SRC.open()))
    fields = list(rows[0].keys()) if rows else []
    if "runner" not in fields:
        fields.append("runner")
    updated = 0
    for r in rows:
        try:
            bib = int(r["bib"])
            et = int(r["etappe_no"])
        except (TypeError, ValueError, KeyError):
            continue
        if r.get("runner"):
            continue  # already set, skip
        name = runners.get(bib, {}).get(et)
        if name:
            r["runner"] = name
            updated += 1
    print(f"backfilled {updated} runner cells")

    with OUT.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)
    print(f"wrote {len(rows)} rows -> {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
