# Holmenkollstafetten DB

> Six years. Twenty-five thousand teams. Three hundred thousand splits.
> One stubbornly steep climb to Besserud.

A self-hosted analytics dashboard for **Holmenkollstafetten** — Oslo's 18.5 km, 15-leg relay across the city — built from scraped split data spanning 2019, 2022–2026.

```
                                                                       ╱ Besserud
                                          Slemdal                    ╱
                                         ╱─── 7. brattest opp ────╲ ╱
                              Vinderen ╱                          ╲
                       Forskningsv. ╱                              ╲ Gressbanen
              Wilh. Færden ╱                                        ╲
        Wolffs ╱                                                     ╲ Holmen
   Louises ╱                                                          ╲
Knud K. ╱                                                              ╲
 START                                                                  ╲ Frognerparken
                                                                         ╲
                                                                          ╲ Nordraaks
                                                                  Bislett ╱
                                                       Camilla C. ╱
                                                     Arno Bergs ╱
                                                          Dumpa
```

## What's inside

A complete pipeline — from raw chip-mat reads to a polished React dashboard:

- **Scrapers** for two timing platforms (UltimateLIVE + EQTiming), six event years, ~25 500 teams.
- **Per-leg splits** derived from cumulative finish times — including runner names where the registration data preserved them.
- **Course profile** with GPS coordinates extracted from the timing system, plotted on Leaflet.
- **Single-page React app** (no build step — ESM via importmaps + htm), served as static files.
- **Recharts** for line/bar/histogram visualisations.
- **react-window** virtualisation so 25k team rows scroll smoothly on a Macbook fan-free.

## Data coverage

| Year | Teams | Splits | Source |
|-----:|------:|-------:|--------|
| 2019 | 3 467 | 51 994 | EQTiming |
| 2022 | 3 149 | 47 163 | EQTiming |
| 2023 | 4 093 | 61 372 | EQTiming |
| 2024 | 4 708 | 70 426 | UltimateLIVE |
| 2025 | 4 955 | 74 242 | UltimateLIVE |
| 2026 | 5 194 | 77 257 | UltimateLIVE (race day) |
| **Σ** | **25 566** | **382 454** | — |

> 2014–2016 deliberately excluded: the leg 14/15 finish moved from Maratonporten to Bislettgata, so splits aren't comparable to the modern course.
> 2020–2021 cancelled due to COVID.

## Features

- **Lag** — virtualised browser of all 25k+ teams. Filter by year/class/company. Click a team for its full split breakdown, percentile per leg, and a same-team-across-years overlay.
- **Etapper** — magazine-style profile of each leg: all-time top 10, year-by-year record holders, percentile evolution, and a stacked-year split distribution. Optional class filter.
- **Etappe-søk** — searchable leaderboard for any single leg, by team or runner. Live percentile (vs that year, vs all years).
- **Rute** — Leaflet course map with the actual 16 chip-mat coordinates and a per-leg drilldown.
- **Sammenligning** — side-by-side comparison of arbitrarily many teams: split times, rank progression (overall and in class), pace evolution. Search-and-add by name, runner, or filter.

## Stack

- **Frontend**: React 18 + Recharts + Leaflet + react-window — all loaded as ESM via `importmap`. No bundler.
- **Markup**: HTM (`htm.bind(React.createElement)`) — JSX-flavoured tagged-template syntax, zero transpile.
- **Typography**: Fraunces (display, variable serif) + DM Sans (body) + JetBrains Mono (data).
- **Backend**: there isn't one. `python3 -m http.server 8080` over a directory of pre-baked JSON.
- **Pipeline**: `scrape_*.py` → `splits_<year>.csv` → `prepare_data.py` → `web/data/*.json`.

## Run it locally

```bash
git clone https://github.com/bendiknordeng/holmenkollstafetten.git
cd holmenkollstafetten/web
python3 -m http.server 8080
# open http://localhost:8080
```

That's it. The JSON dataset is committed; no scraping required.

## Re-scrape (optional)

```bash
# UltimateLIVE (2024+)
python3 scrape_all_splits.py 2026 --workers 8

# EQTiming (2019, 2022, 2023)
python3 scrape_eqtiming.py 2022 56848

# Rebuild the JSON the frontend reads
python3 prepare_data.py
```

`scrape_all_splits.py` brute-forces the bib range; `scrape_eqtiming.py` walks the (class × station) cartesian. Both resume from existing CSVs.

## Layout

```
.
├── web/                    # Static frontend (host this)
│   ├── index.html
│   ├── app.js              # ~2500 LOC, single file React app
│   ├── app.css
│   └── data/               # Pre-baked JSON (~10 MB)
├── scrape_all_splits.py    # UltimateLIVE scraper (brute-force bibs)
├── scrape_eqtiming.py      # EQTiming scraper (class × station)
├── prepare_data.py         # CSV → JSON for the frontend
├── splits_<year>.csv       # Raw scrape per year
└── etappe_*.csv            # Course metadata (distances, GPS)
```

## Notes on the data

- **Split times are derived** from cumulative checkpoint times (`tid_total[N] − tid_total[N−1]`). The raw `split` column from UltimateLIVE was column-misaligned in some payloads, so we recompute. Negative diffs (chip read order glitches) are filtered to null.
- **Runner names**: ~50% coverage on EQTiming years (depends on whether teams registered runners pre-race). 90%+ on UltimateLIVE years. Backfilled from `StafettDeltakere` startlist where available.
- **Class names** normalised to canonical codes (B1, B2, F1, F6 …) with consistent display names — raw data has up to four different spellings of "A1 - Bedriftslag/mosjonslag".

## License

Personal project — data belongs to **Idrettsklubben Tjalve** and the timing providers. Code is available under MIT.

---

*Built over an evening for personal curiosity after running leg 9.*
