#!/usr/bin/env python3
"""Scrape per-etappe splits from a Holmenkollstafetten event on live.eqtiming.com.

Usage:
    python3 scrape_eqtiming.py <year> <eventid>

Example:
    python3 scrape_eqtiming.py 2022 56848

Writes splits_<year>.csv with the same schema as scrape_all_splits.py.
"""
import csv
import json
import ssl
import sys
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


def fetch_json(url: str, retries: int = 4) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    last_err = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=45, context=SSL_CTX) as r:
                return json.loads(r.read().decode("utf-8", errors="replace"))
        except Exception as e:
            last_err = e
            time.sleep(1 + attempt * 2)
    raise last_err


def time_seconds(formatert: str):
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


def fetch_event_metadata(eventid: int):
    data = fetch_json(f"https://live.eqtiming.com/api/event/{eventid}")
    klasser = data["Klasser"]
    classes = [(int(k), v["Navn"]) for k, v in klasser.items()]
    sopp = data["StasjonsOppsett"]
    stations = []
    for k, v in sopp.items():
        et = v.get("Etappenummer", 0)
        if et < 1 or et > 15:
            continue
        stations.append((int(k), et, v.get("Navn", ""), v.get("Km", 0.0)))
    stations.sort(key=lambda s: s[1])

    # raceid (Etapper key) — the relay's main race id
    lk = data.get("LagKonkurranse") or []
    raceid = None
    if lk and lk[0].get("Etapper"):
        raceid = lk[0]["Etapper"][0]
    if raceid is None:
        # fallback: pick the first key in Etapper dict
        et = data.get("Etapper") or {}
        if et:
            raceid = int(next(iter(et.keys())))
    return data, classes, stations, raceid


def fetch_class_at_station(eventid: int, raceid: int, class_uid: int, station_uid: int):
    rows = []
    page = 1
    while True:
        url = (
            f"https://live.eqtiming.com/api/result/Class/{eventid}/{raceid}/{class_uid}"
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


def fetch_runners_per_team(eventid: int):
    """Returns {bib: {etappe_no: 'Fornavn Etternavn'}} from startlist."""
    data = fetch_json(f"https://live.eqtiming.com/api/startlist/{eventid}?count=20000&startAt=1")
    items = data.get("Items") or {}
    if isinstance(items, dict):
        items = list(items.values())
    out = {}
    for it in items:
        bib = it.get("Startnummer")
        sd = it.get("StafettDeltakere") or {}
        if not bib or not sd:
            continue
        per_leg = {}
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
            out[bib] = per_leg
    return out


def main(year: int, eventid: int):
    out_path = Path(__file__).parent / f"splits_{year}.csv"
    print(f"== {year} (eventid={eventid}) ==", file=sys.stderr)
    data, classes, stations, raceid = fetch_event_metadata(eventid)
    if raceid is None:
        print("  no raceid found — abort", file=sys.stderr)
        return 1
    print(f"  raceid={raceid}, {len(classes)} classes, {len(stations)} stations", file=sys.stderr)

    runners = {}
    try:
        runners = fetch_runners_per_team(eventid)
        print(f"  runners for {len(runners)} teams", file=sys.stderr)
    except Exception as e:
        print(f"  startlist fetch failed: {e}", file=sys.stderr)

    by_team = {}
    by_team_etappe = {}
    started = time.time()
    tasks = [(cu, cn, st_uid, et_no, st_navn) for cu, cn in classes for st_uid, et_no, st_navn, _ in stations]
    print(f"  {len(tasks)} (class, station) calls", file=sys.stderr)

    def task(args):
        cu, cn, st_uid, et_no, st_navn = args
        try:
            return cu, cn, st_uid, et_no, st_navn, fetch_class_at_station(eventid, raceid, cu, st_uid)
        except Exception as e:
            return cu, cn, st_uid, et_no, st_navn, e

    with ThreadPoolExecutor(max_workers=4) as ex:
        for i, fut in enumerate(as_completed([ex.submit(task, t) for t in tasks]), 1):
            cu, cn, st_uid, et_no, st_navn, items = fut.result()
            if isinstance(items, Exception):
                print(f"  class={cn} et={et_no}: ERROR {items}", file=sys.stderr)
                continue
            for it in items:
                deltaker = it.get("Deltaker") or {}
                bib = deltaker.get("Startnummer")
                if bib is None:
                    continue
                team_name = (deltaker.get("Utover") or {}).get("NavnFormatert", "")
                klubbnavn = deltaker.get("KlubbTeamFormatert") or ""
                klasse_navn = (deltaker.get("Klasse") or {}).get("Navn", cn)
                cum_time = it.get("Formatert", "")
                splitt = it.get("Splitt") or {}
                split_time = splitt.get("Formatert", "")
                pl = it.get("Plassering") or {}
                by_team.setdefault(bib, {"team": team_name, "klubb": klubbnavn, "klasse": klasse_navn})
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
    with out_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for bib, meta in by_team.items():
            for et in range(1, 16):
                rec = by_team_etappe.get((bib, et))
                if not rec:
                    continue
                w.writerow(
                    {
                        "year": year,
                        "bib": bib,
                        "team": meta["team"],
                        "bedrift": meta["klubb"],
                        "klasse": meta["klasse"],
                        "distance": "",
                        "runner": runners.get(bib, {}).get(et, ""),
                        "pace_total": "",
                        "pace_split": "",
                        "klokketid": "",
                        **rec,
                    }
                )
                n += 1
    print(f"  wrote {n} rows -> {out_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: scrape_eqtiming.py <year> <eventid>", file=sys.stderr)
        sys.exit(2)
    raise SystemExit(main(int(sys.argv[1]), int(sys.argv[2])))
