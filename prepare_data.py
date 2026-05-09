#!/usr/bin/env python3
"""Build a compact JSON dataset for the web frontend from splits_*.csv.

Output (web/data/):
  - teams.json     : list of [tid, year, bib, team, bedrift, klasse, total_sec, finished]
  - splits.json    : list of [tid, etappe, split_sec, total_sec]   (one row per leg)
  - meta.json      : klasser, etapper, years, generated_at
  - stats.json     : per (etappe, year) precomputed: sorted split_sec for percentiles,
                     min/median/max, count.
                     Plus per (etappe, year, klasse) the same aggregates.

The frontend builds in-browser indices: by team, by klasse, by etappe. We keep
JSON because the data is small enough (~200k rows × ~30 bytes ≈ 6 MB) and
gzip via http.server cuts that further when served with a small wrapper.
"""
import csv
import json
import statistics
import sys
from pathlib import Path

ROOT = Path(__file__).parent
WEB = ROOT / "web" / "data"
WEB.mkdir(parents=True, exist_ok=True)
ETAPPE_DIST = {}
for r in csv.DictReader((ROOT / "etappe_distances.csv").open()):
    ETAPPE_DIST[int(r["etappe"])] = float(r["distance_m"])

ETAPPE_COORDS = []  # 16 entries: start + 15 etappe-end checkpoints
coords_path = ROOT / "etappe_coords.csv"
if coords_path.exists():
    for r in csv.DictReader(coords_path.open()):
        ETAPPE_COORDS.append({
            "idx": int(r["point_idx"]),
            "navn": r["navn"],
            "lat": float(r["lat"]),
            "lon": float(r["lon"]),
        })


CANONICAL_KLASSE_NAMES = {
    "": "(ukjent)",
    "A1": "A1 - Bedriftslag/mosjonslag flertall menn",
    "A2": "A2 - Bedriftslag/mosjonslag flertall kvinner",
    "A1-B": "A1-B - Byggebransjen for Kreftforeningen",
    "A1-C": "A1-C - Finansbransjen for Kreftforeningen",
    "A2-B": "A2-B - Byggebransjen for Kreftforeningen",
    "A2-C": "A2-C - Finansbransjen for Kreftforeningen",
    "A3": "A3 - Lag tilsluttet andre særforbund",
    "A4": "A4 - Klasse for 55+",
    "A6": "A6 - Ideelle organisasjoner",
    "B1": "B1 - Menn bedrift",
    "B2": "B2 - Menn veteran bedrift",
    "B4": "B4 - Kvinner bedrift",
    "B5": "B5 - Kvinner veteran bedrift",
    "F1": "F1 - Menn elite",
    "F2": "F2 - Menn senior",
    "F3": "F3 - Menn junior (U23)",
    "F4": "F4 - Menn veteran",
    "F5": "F5 - Menn superveteran",
    "F6": "F6 - Kvinner elite",
    "F7": "F7 - Kvinner senior",
    "F8": "F8 - Kvinner junior (U23)",
    "F9": "F9 - Kvinner veteran",
    "F10": "F10 - Kvinner superveteran",
    "M1": "M1 - Militære forlegninger",
    "S1": "S1 - Menn studenter",
    "S2": "S2 - Kvinner studenter",
    "P": "P - Para",
}


def canonicalize_klasse(raw: str) -> str:
    """Map raw klasse name to canonical key (e.g., "B1 Menn Bedrift" -> "B1").

    Uses the first whitespace-separated token. "Para" is the only token-less
    name in our data.
    """
    s = (raw or "").strip()
    if not s:
        return ""
    if s.lower().startswith("para"):
        return "P"
    return s.split()[0]


def to_int(v):
    try:
        return int(v)
    except (ValueError, TypeError):
        return None


def to_float(v):
    try:
        return float(v)
    except (ValueError, TypeError):
        return None


def main() -> int:
    teams: list[dict] = []
    splits: list[list] = []
    klasser_set: set[str] = set()
    years: set[int] = set()
    by_team: dict[tuple[int, int], dict] = {}

    for csv_path in sorted(ROOT.glob("splits_*.csv")):
        year = int(csv_path.stem.split("_")[1])
        years.add(year)
        print(f"reading {csv_path.name}...", file=sys.stderr)
        n_rows = 0
        for r in csv.DictReader(csv_path.open()):
            bib = to_int(r.get("bib"))
            etappe = to_int(r.get("etappe_no"))
            split_sec = to_float(r.get("split_seconds"))
            total_sec = to_float(r.get("tid_total_seconds"))
            if bib is None or etappe is None:
                continue
            tkey = (year, bib)
            if tkey not in by_team:
                code = canonicalize_klasse(r.get("klasse") or "")
                by_team[tkey] = {
                    "year": year,
                    "bib": bib,
                    "team": (r.get("team") or "").strip(),
                    "bedrift": (r.get("bedrift") or "").strip(),
                    "klasse": CANONICAL_KLASSE_NAMES.get(code, code or "(ukjent)"),
                    "etappes": {},
                }
            by_team[tkey]["etappes"][etappe] = {
                "split_sec": split_sec,
                "total_sec": total_sec,
                "runner": (r.get("runner") or "").strip(),
            }
            klasser_set.add(by_team[tkey]["klasse"])
            n_rows += 1
        print(f"  rows: {n_rows}, teams cumulative: {len(by_team)}", file=sys.stderr)

    # Assign team ids and finalise teams + splits arrays.
    klasser = sorted(klasser_set)
    klasse_idx = {k: i for i, k in enumerate(klasser)}
    teams_arr = []
    splits_arr = []
    for tid, ((year, bib), meta) in enumerate(sorted(by_team.items())):
        # Total time is ONLY etappe 15 cumulative (full finish). Partials
        # remain null so they don't pollute "fastest" sorts.
        last_et = max(meta["etappes"].keys()) if meta["etappes"] else 0
        total = meta["etappes"].get(15, {}).get("total_sec")
        finished = total is not None
        teams_arr.append(
            [
                tid,
                year,
                bib,
                meta["team"],
                meta["bedrift"],
                klasse_idx.get(meta["klasse"], -1),
                total,
                int(finished),
            ]
        )
        # Derive split_sec from cumulative tid_total diffs (the scraper
        # mis-aligned columns for some events, so we don't trust split_sec
        # directly).
        sorted_ets = sorted(meta["etappes"].keys())
        prev_total = 0.0
        for et in sorted_ets:
            ed = meta["etappes"][et]
            total = ed["total_sec"]
            split = None
            if total is not None:
                split = total - prev_total
                if split < 0 or split > 7200:
                    split = None
                prev_total = total
            splits_arr.append([tid, et, split, total, ed["runner"] or ""])

    # Precompute per-etappe-per-year stats (sorted split_sec for percentile lookup).
    by_year_etappe: dict[tuple[int, int], list[float]] = {}
    by_year_etappe_klasse: dict[tuple[int, int, int], list[float]] = {}
    for tid, etappe, split_sec, _, _ in splits_arr:
        if split_sec is None:
            continue
        team = teams_arr[tid]
        year = team[1]
        klasse_id = team[5]
        by_year_etappe.setdefault((year, etappe), []).append(split_sec)
        by_year_etappe_klasse.setdefault((year, etappe, klasse_id), []).append(split_sec)

    stats_overall = {}
    for (year, etappe), arr in by_year_etappe.items():
        arr_sorted = sorted(arr)
        stats_overall[f"{year}-{etappe}"] = {
            "n": len(arr_sorted),
            "min": arr_sorted[0],
            "max": arr_sorted[-1],
            "median": statistics.median(arr_sorted),
            "p10": arr_sorted[int(len(arr_sorted) * 0.10)],
            "p25": arr_sorted[int(len(arr_sorted) * 0.25)],
            "p75": arr_sorted[int(len(arr_sorted) * 0.75)],
            "p90": arr_sorted[int(len(arr_sorted) * 0.90)],
            "sorted": arr_sorted,
        }

    stats_klasse = {}
    for (year, etappe, klasse_id), arr in by_year_etappe_klasse.items():
        if klasse_id < 0:
            continue
        arr_sorted = sorted(arr)
        stats_klasse[f"{year}-{etappe}-{klasse_id}"] = {
            "n": len(arr_sorted),
            "min": arr_sorted[0],
            "max": arr_sorted[-1],
            "median": statistics.median(arr_sorted),
        }

    # Per-team total rank within (year, klasse) for context.
    by_year_klasse_total: dict[tuple[int, int], list[tuple[float, int]]] = {}
    for t in teams_arr:
        tid, year, bib, name, bedrift, klasse_id, total, finished = t
        if total is None or not finished:
            continue
        by_year_klasse_total.setdefault((year, klasse_id), []).append((total, tid))
    team_rank_in_klasse = {}
    for (year, klasse_id), arr in by_year_klasse_total.items():
        arr.sort()
        for rank, (_t, tid) in enumerate(arr, start=1):
            team_rank_in_klasse[tid] = [rank, len(arr)]
    # Append rank info as a parallel array tid -> [rank, klasse_count].
    rank_arr = [team_rank_in_klasse.get(t[0], [None, None]) for t in teams_arr]

    meta_out = {
        "klasser": klasser,
        "etappe_distances": ETAPPE_DIST,
        "etappe_coords": ETAPPE_COORDS,
        "years": sorted(years),
        "n_teams": len(teams_arr),
        "n_splits": len(splits_arr),
    }

    (WEB / "meta.json").write_text(json.dumps(meta_out, ensure_ascii=False))
    # Use compact JSON without spaces.
    (WEB / "teams.json").write_text(json.dumps(teams_arr, ensure_ascii=False, separators=(",", ":")))
    (WEB / "splits.json").write_text(json.dumps(splits_arr, ensure_ascii=False, separators=(",", ":")))
    (WEB / "team_rank.json").write_text(json.dumps(rank_arr, ensure_ascii=False, separators=(",", ":")))
    (WEB / "stats_overall.json").write_text(json.dumps(stats_overall, ensure_ascii=False, separators=(",", ":")))
    (WEB / "stats_klasse.json").write_text(json.dumps(stats_klasse, ensure_ascii=False, separators=(",", ":")))

    print(f"wrote {len(teams_arr)} teams, {len(splits_arr)} splits", file=sys.stderr)
    for f in sorted(WEB.glob("*.json")):
        print(f"  {f.name}: {f.stat().st_size / 1024:.0f} KB", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
