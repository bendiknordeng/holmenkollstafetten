#!/usr/bin/env python3
"""Scrape per-etappe splits for ALL teams across multiple years from live.ultimate.dk.

For 2025 we use the bib list extracted from results.csv (sportsidioten populates
bib in the new layout). For 2024/2023/2026 bibs are not in results.csv so we
brute-force probe the bib range; an invalid bib returns a tiny payload.

Outputs one CSV per year so partial runs can resume cleanly.

Usage:
    python3 scrape_all_splits.py [year ...]   # default: all four years
"""
import argparse
import csv
import html
import re
import ssl
import sys
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

try:
    import certifi

    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL_CTX = ssl._create_unverified_context()

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
OUT_DIR = Path(__file__).parent

# 2023 ran on a different timing platform (live.eqtiming.com/61907) — not
# scraped here. Use a separate eqtiming scraper for 2023.
EVENTIDS = {
    2024: 6082,
    2025: 6587,
    2026: 7129,
}

# Heuristic max bib per event — calibrated from observed search results.
MAX_BIB = {
    2024: 13500,
    2025: 13500,
    2026: 14000,
}

INVALID_PAYLOAD_THRESHOLD = 4000  # bytes; valid teams emit ~20KB


def fetch(url: str, retries: int = 4) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=45, context=SSL_CTX) as r:
                return r.read().decode("utf-8", errors="replace")
        except Exception as e:
            last_err = e
            time.sleep(1 + attempt * 2)
    raise last_err if last_err else RuntimeError("fetch failed")


def fetch_participant(eventid: int, bib: int) -> str:
    return fetch(
        f"https://live.ultimate.dk/desktop/front/data.php?eventid={eventid}"
        f"&mode=participantinfo&pid={bib}&language=no"
    )


def parse_team_meta(payload: str) -> dict:
    m = re.search(r'class="participant_value_big">([^<]+)</span>', payload)
    team = html.unescape(m.group(1)).strip() if m else ""
    bedrift_m = re.search(r'class="participant_hdr_small">bedrift</td>\s*<td[^>]*>([^<]*)</td>', payload)
    bedrift = html.unescape(bedrift_m.group(1)).strip() if bedrift_m else ""
    klasse_m = re.search(r'class="participant_hdr_small">klasse</td>\s*<td[^>]*>([^<]*)</td>', payload)
    klasse = html.unescape(klasse_m.group(1)).strip() if klasse_m else ""
    distance_m = re.search(r'class="participant_hdr_small">distanse</td>\s*<td[^>]*>([^<]*)</td>', payload)
    distance = html.unescape(distance_m.group(1)).strip() if distance_m else ""
    return {"team": team, "bedrift": bedrift, "klasse": klasse, "distance": distance}


def parse_splits(payload: str) -> list[dict]:
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
        if not clean or clean[0].lower() in ("", "punkt"):
            continue
        data = [c for c in clean if c]
        if len(data) < 6 or not re.match(r".+-\d+", data[0]):
            continue
        m = re.match(r"(.+)-(\d+)\s*\(([^)]*)\)", data[0])
        if m:
            etappe_name = m.group(1).strip()
            etappe_no = int(m.group(2))
            runner = m.group(3).strip()
        else:
            m2 = re.match(r"(.+)-(\d+)", data[0])
            etappe_name = m2.group(1).strip()
            etappe_no = int(m2.group(2))
            runner = ""
        if len(data) < 10:
            data = data + [""] * (10 - len(data))
        out.append(
            {
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
        )
    return out


TIME_RE = re.compile(r"^(?:\d+:)?\d{1,2}:\d{2}(?:\.\d+)?$")


def time_to_seconds(t: str) -> float | None:
    if not t or not TIME_RE.match(t):
        return None
    parts = t.split(":")
    if len(parts) == 2:
        return int(parts[0]) * 60 + float(parts[1])
    return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])


_progress_lock = threading.Lock()
_progress_state = {"done": 0, "total": 0, "found": 0}


def scrape_one(year: int, bib: int) -> tuple[int, list[dict], str]:
    eventid = EVENTIDS[year]
    payload = fetch_participant(eventid, bib)
    if len(payload) < INVALID_PAYLOAD_THRESHOLD:
        return bib, [], ""
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
                "klasse": meta["klasse"],
                "distance": meta["distance"],
                **s,
                "split_seconds": time_to_seconds(s["split"]) or "",
                "tid_total_seconds": time_to_seconds(s["tid_total"]) or "",
            }
        )
    return bib, rows, meta["team"]


def existing_bibs(out_path: Path) -> set[int]:
    if not out_path.exists():
        return set()
    seen: set[int] = set()
    with out_path.open() as f:
        rdr = csv.DictReader(f)
        for r in rdr:
            try:
                seen.add(int(r["bib"]))
            except (KeyError, ValueError):
                pass
    return seen


def bibs_for_year(year: int) -> list[int]:
    """Return candidate bib list for a year.

    For 2025 we have a complete list from sportsidioten results.csv. For other
    years we probe the full bib range (1..MAX_BIB[year]).
    """
    return list(range(1, MAX_BIB[year] + 1))


def scrape_year(year: int, max_workers: int = 8) -> int:
    out = OUT_DIR / f"splits_{year}.csv"
    done = existing_bibs(out)
    todo = [b for b in bibs_for_year(year) if b not in done]
    print(f"== {year} ==  eventid={EVENTIDS[year]}  todo={len(todo)}  resume={len(done)}", file=sys.stderr)
    if not todo:
        return 0

    fieldnames = [
        "year", "bib", "team", "bedrift", "klasse", "distance",
        "etappe_no", "etappe_name", "runner",
        "tid_total", "pace_total", "oa_total", "klasse_total",
        "split", "pace_split", "oa_split", "klasse_split", "klokketid",
        "split_seconds", "tid_total_seconds",
    ]
    write_header = not out.exists()
    f = out.open("a", newline="", encoding="utf-8")
    writer = csv.DictWriter(f, fieldnames=fieldnames)
    if write_header:
        writer.writeheader()
    f.flush()

    found_teams = 0
    started = time.time()
    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        futures = {ex.submit(scrape_one, year, b): b for b in todo}
        for i, fut in enumerate(as_completed(futures), 1):
            try:
                bib, rows, name = fut.result()
            except Exception as e:
                print(f"  bib={futures[fut]} ERROR {e}", file=sys.stderr)
                continue
            if rows:
                writer.writerows(rows)
                f.flush()
                found_teams += 1
            if i % 200 == 0:
                rate = i / (time.time() - started)
                eta = (len(todo) - i) / max(rate, 0.01)
                print(
                    f"  {year}: {i}/{len(todo)} probed, {found_teams} teams kept, "
                    f"rate={rate:.1f}/s, eta={eta/60:.1f}min",
                    file=sys.stderr,
                )
    f.close()
    print(f"== {year} done == found {found_teams} new teams", file=sys.stderr)
    return found_teams


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("years", nargs="*", type=int, default=[2026, 2025, 2024])
    p.add_argument("--workers", type=int, default=8)
    args = p.parse_args()
    for y in args.years:
        if y not in EVENTIDS:
            print(f"skip {y}: no eventid", file=sys.stderr)
            continue
        scrape_year(y, max_workers=args.workers)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
