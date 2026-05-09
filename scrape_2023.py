#!/usr/bin/env python3
"""Scrape per-etappe splits for ALL teams in 2023 from live.eqtiming.com.

2023 ran on EQTiming (event 61907) instead of ultimate.dk. This script walks
every (class, station) pair and merges the per-station results into a CSV
matching the schema produced by scrape_all_splits.py.
"""
import csv
import json
import ssl
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

try:
    import certifi

    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL_CTX = ssl._create_unverified_context()

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
OUT = Path(__file__).parent / "splits_2023.csv"
EVENTID = 61907
RACEID = 229017


def fetch_json(url: str, retries: int = 4) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=45, context=SSL_CTX) as r:
                return json.loads(r.read().decode("utf-8", errors="replace"))
        except Exception as e:
            last_err = e
            time.sleep(1 + attempt * 2)
    raise last_err if last_err else RuntimeError("fetch failed")


def time_seconds(formatert: str) -> float | None:
    if not formatert:
        return None
    parts = formatert.split(":")
    try:
        if len(parts) == 2:
            return int(parts[0]) * 60 + float(parts[1])
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
    except ValueError:
        return None
    return None


def fetch_event_metadata() -> tuple[list[tuple[int, str]], list[tuple[int, int, str, float]]]:
    data = fetch_json(f"https://live.eqtiming.com/api/event/{EVENTID}")
    klasser = data["Klasser"]
    classes = [(int(k), v["Navn"]) for k, v in klasser.items()]
    sopp = data["StasjonsOppsett"]
    stations: list[tuple[int, int, str, float]] = []
    for k, v in sopp.items():
        et = v.get("Etappenummer", 0)
        if et < 1 or et > 15:
            continue
        stations.append((int(k), et, v.get("Navn", ""), v.get("Km", 0.0)))
    stations.sort(key=lambda s: s[1])
    return classes, stations


def fetch_class_at_station(class_uid: int, station_uid: int) -> list[dict]:
    rows: list[dict] = []
    page = 1
    while True:
        url = (
            f"https://live.eqtiming.com/api/result/Class/{EVENTID}/{RACEID}/{class_uid}"
            f"?station={station_uid}&count=500&startAt={(page - 1) * 500 + 1}"
        )
        data = fetch_json(url)
        items = data.get("Items") or []
        if isinstance(items, dict):
            items = list(items.values())
        rows.extend(items)
        total = data.get("TotalItems", 0)
        if len(rows) >= total or not items:
            break
        page += 1
    return rows


def main() -> int:
    classes, stations = fetch_event_metadata()
    print(f"{len(classes)} classes, {len(stations)} stations", file=sys.stderr)

    # Map: (bib, etappe_no) -> partial row dict.
    # We accumulate from each station call.
    by_team: dict[int, dict] = {}
    by_team_etappe: dict[tuple[int, int], dict] = {}
    started = time.time()

    tasks = [(cu, cn, st_uid, et_no, st_navn) for cu, cn in classes for st_uid, et_no, st_navn, _ in stations]
    print(f"{len(tasks)} (class, station) calls", file=sys.stderr)

    def task(args):
        cu, cn, st_uid, et_no, st_navn = args
        try:
            return cu, cn, st_uid, et_no, st_navn, fetch_class_at_station(cu, st_uid)
        except Exception as e:
            return cu, cn, st_uid, et_no, st_navn, e

    with ThreadPoolExecutor(max_workers=4) as ex:
        for i, fut in enumerate(as_completed([ex.submit(task, t) for t in tasks]), 1):
            cu, cn, st_uid, et_no, st_navn, items = fut.result()
            if isinstance(items, Exception):
                print(f"  class={cu}/{cn} etappe={et_no} ERROR {items}", file=sys.stderr)
                continue
            for it in items:
                deltaker = it.get("Deltaker") or {}
                bib = deltaker.get("Startnummer")
                if bib is None:
                    continue
                team_name = (deltaker.get("Utover") or {}).get("NavnFormatert", "")
                klubbnavn = (deltaker.get("KlubbTeamFormatert") or "")
                klasse_navn = (deltaker.get("Klasse") or {}).get("Navn", cn)
                cum_time = it.get("Formatert", "")
                splitt = it.get("Splitt") or {}
                split_time = splitt.get("Formatert", "")
                pl = it.get("Plassering") or {}
                by_team.setdefault(
                    bib,
                    {
                        "team": team_name,
                        "klubb": klubbnavn,
                        "klasse": klasse_navn,
                    },
                )
                by_team_etappe[(bib, et_no)] = {
                    "etappe_no": et_no,
                    "etappe_name": st_navn,
                    "tid_total": cum_time,
                    "split": split_time,
                    "oa_total": pl.get("Total", ""),
                    "klasse_total": pl.get("Klasse", ""),
                    "oa_split": pl.get("SplittTotal", ""),
                    "klasse_split": pl.get("SplittKlasse", ""),
                    "tid_total_seconds": time_seconds(cum_time) or "",
                    "split_seconds": time_seconds(split_time) or "",
                }
            if i % 50 == 0:
                rate = i / (time.time() - started)
                eta = (len(tasks) - i) / max(rate, 0.01)
                print(f"  {i}/{len(tasks)}, rate={rate:.1f}/s, eta={eta/60:.1f}min, teams={len(by_team)}", file=sys.stderr)

    fieldnames = [
        "year", "bib", "team", "bedrift", "klasse", "distance",
        "etappe_no", "etappe_name", "runner",
        "tid_total", "pace_total", "oa_total", "klasse_total",
        "split", "pace_split", "oa_split", "klasse_split", "klokketid",
        "split_seconds", "tid_total_seconds",
    ]
    n = 0
    with OUT.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for bib, meta in by_team.items():
            for et in range(1, 16):
                key = (bib, et)
                rec = by_team_etappe.get(key)
                if not rec:
                    continue
                w.writerow(
                    {
                        "year": 2023,
                        "bib": bib,
                        "team": meta["team"],
                        "bedrift": meta["klubb"],
                        "klasse": meta["klasse"],
                        "distance": "",
                        "runner": "",
                        "pace_total": "",
                        "pace_split": "",
                        "klokketid": "",
                        **rec,
                    }
                )
                n += 1
    print(f"wrote {n} rows -> {OUT}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
