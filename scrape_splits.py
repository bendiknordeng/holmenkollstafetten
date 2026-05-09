#!/usr/bin/env python3
"""Scrape per-etappe splits from live.ultimate.dk for given (eventid, bib) pairs.

For each team it returns 15 rows: etappe name, cumulative time, leg split time,
pace, overall + class ranks (after leg, and on the leg itself), and clock time.

Usage:
    python3 scrape_splits.py        # uses TARGETS below
"""
import csv
import html
import re
import ssl
import sys
import time
import urllib.request
from pathlib import Path

try:
    import certifi

    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL_CTX = ssl._create_unverified_context()

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
OUT_DIR = Path(__file__).parent

# eventid per year on live.ultimate.dk.
EVENTIDS = {
    2024: 6082,
    2025: 6587,
    2026: 7129,
}


def fetch(url: str, retries: int = 4) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=45, context=SSL_CTX) as r:
                return r.read().decode("utf-8", errors="replace")
        except Exception as e:
            last_err = e
            time.sleep(2 + attempt * 2)
    raise last_err if last_err else RuntimeError("fetch failed")


def fetch_participant(eventid: int, bib: int) -> str:
    return fetch(
        f"https://live.ultimate.dk/desktop/front/data.php?eventid={eventid}"
        f"&mode=participantinfo&pid={bib}&language=no"
    )


SPLIT_HEADERS = (
    "punkt",
    "tid",
    "hastighet",
    "o/a",
    "klasse",
    "split",
    "hastighet_split",
    "o/a_split",
    "klasse_split",
    "klokketid",
)


def parse_team_meta(payload: str) -> dict:
    # Team name appears in participant_value_big near top.
    m = re.search(r'class="participant_value_big">([^<]+)</span>', payload)
    team = html.unescape(m.group(1)).strip() if m else ""
    bedrift_m = re.search(r'class="participant_hdr_small">bedrift</td>\s*<td[^>]*>([^<]*)</td>', payload)
    bedrift = html.unescape(bedrift_m.group(1)).strip() if bedrift_m else ""
    return {"team": team, "bedrift": bedrift}


def parse_splits(payload: str) -> list[dict]:
    """Extract the splits table.

    Each row in the splits table has 11 cells (after header repeats). We pick
    the table that mentions "punkt" + "split" headers, then parse rows.
    """
    tables = re.findall(r"<table[\s\S]*?</table>", payload)
    splits_table = None
    for t in tables:
        if "punkt" in t.lower() and "split" in t.lower() and "klokketid" in t.lower():
            splits_table = t
            break
    if not splits_table:
        return []
    rows = re.findall(r"<tr[\s\S]*?</tr>", splits_table)
    out: list[dict] = []
    for row in rows:
        cells = re.findall(r"<t[dh][^>]*>([\s\S]*?)</t[dh]>", row)
        clean = [html.unescape(re.sub(r"<[^>]+>", "", c)).replace("\xa0", " ").strip() for c in cells]
        # Header rows contain "punkt" or are empty. Skip non-data rows.
        if not clean or clean[0].lower() in ("", "punkt"):
            continue
        # Data rows in the observed structure: 10 columns matching SPLIT_HEADERS
        # but with extra empty cells in some templates. Filter empties.
        data = [c for c in clean if c]
        if len(data) < 6:
            continue
        # Heuristic: first cell should look like "<name>-<n> ()".
        if not re.match(r".+-\d+", data[0]):
            continue
        # Extract etappe number from name pattern.
        # Format: "<etappe name>-<n> (<runner name>)" — runner only present in
        # 2026 live data; older years show "()" and runner is unknown.
        m = re.match(r"(.+)-(\d+)\s*\(([^)]*)\)", data[0])
        if not m:
            m2 = re.match(r"(.+)-(\d+)", data[0])
            etappe_name = m2.group(1).strip()
            etappe_no = int(m2.group(2))
            runner = ""
        else:
            etappe_name = m.group(1).strip()
            etappe_no = int(m.group(2))
            runner = m.group(3).strip()
        # Map remaining 9 columns to our header set.
        # Observed order: tid, pace_total, oa_total, klasse_total, split, pace_split, oa_split, klasse_split, klokketid
        if len(data) < 10:
            # Pad missing columns with empty strings to keep schema stable.
            data = data + [""] * (10 - len(data))
        rec = {
            "etappe_no": etappe_no,
            "etappe_name": etappe_name,
            "runner": runner,
            "tid_total": data[1],
            "pace_total": data[2],
            "oa_total": data[3],
            "klasse_total": data[4],
            "split": data[5],
            "pace_split": data[6],
            "oa_split": data[7],
            "klasse_split": data[8],
            "klokketid": data[9],
        }
        out.append(rec)
    return out


TIME_RE = re.compile(r"^(?:\d+:)?\d{1,2}:\d{2}(?:\.\d+)?$")


def time_to_seconds(t: str) -> float | None:
    if not t or not TIME_RE.match(t):
        return None
    parts = t.split(":")
    if len(parts) == 2:
        m, s = parts
        return int(m) * 60 + float(s)
    h, m, s = parts
    return int(h) * 3600 + int(m) * 60 + float(s)


def scrape_team(year: int, bib: int) -> list[dict]:
    eventid = EVENTIDS[year]
    payload = fetch_participant(eventid, bib)
    meta = parse_team_meta(payload)
    splits = parse_splits(payload)
    rows = []
    for s in splits:
        rows.append(
            {
                "year": year,
                "bib": bib,
                "team": meta["team"],
                "bedrift": meta["bedrift"],
                **s,
                "split_seconds": time_to_seconds(s["split"]) or "",
                "tid_total_seconds": time_to_seconds(s["tid_total"]) or "",
            }
        )
    return rows


def main(targets: list[tuple[int, int]]) -> int:
    all_rows: list[dict] = []
    for year, bib in targets:
        try:
            rows = scrape_team(year, bib)
            print(f"{year}/{bib}: {len(rows)} legs", file=sys.stderr)
            all_rows.extend(rows)
        except Exception as e:
            print(f"{year}/{bib}: ERROR {e}", file=sys.stderr)
        time.sleep(0.6)

    out = OUT_DIR / "splits.csv"
    if not all_rows:
        print("no rows scraped", file=sys.stderr)
        return 1
    with out.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(all_rows[0].keys()))
        w.writeheader()
        w.writerows(all_rows)
    print(f"wrote {len(all_rows)} rows -> {out}", file=sys.stderr)
    return 0


def discover_ey_bibs(year: int) -> list[int]:
    eventid = EVENTIDS[year]
    payload = fetch(
        f"https://live.ultimate.dk/desktop/front/data.php?eventid={eventid}"
        f"&mode=search&searchmode=quick&search_quick=EY&language=no"
    )
    bibs: list[int] = []
    for m in re.finditer(
        r'<tr id="search_row_(\d+)"[\s\S]*?onclick="doParticipantInfo\(\d+\);">\d+</td>\s*<td[^>]*onclick="doParticipantInfo\(\d+\);">([^<]+)</td>',
        payload,
    ):
        bib = int(m.group(1))
        team = html.unescape(m.group(2)).strip()
        if team.startswith("EY") or " EY " in team:
            bibs.append(bib)
    return bibs


if __name__ == "__main__":
    targets: list[tuple[int, int]] = []
    for year in (2024, 2025, 2026):
        try:
            for bib in discover_ey_bibs(year):
                targets.append((year, bib))
        except Exception as e:
            print(f"discover {year}: ERROR {e}", file=sys.stderr)
    print(f"{len(targets)} targets to scrape", file=sys.stderr)
    raise SystemExit(main(targets))
