# Holmenkollstafetten DB

> Six years. Twenty-five thousand teams. Three hundred thousand splits.
> One stubbornly steep climb to Besserud.

A self-hosted analytics dashboard for **Holmenkollstafetten** — Oslo's 18.5 km, 15-leg relay across the city — covering 2019, 2022–2026.

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

## Run it

```bash
git clone https://github.com/bendiknordeng/holmenkollstafetten.git
cd holmenkollstafetten/web
python3 -m http.server 8080
# open http://localhost:8080
```

Static files only — no build step, no backend, no install. The dataset is pre-baked as JSON.

## Features

- **Lag** — virtualised browser of all 25k+ teams. Filter by year, class, company. Click a team for its full split breakdown, percentile per leg, and a same-team-across-years overlay.
- **Etapper** — magazine-style profile of each leg: all-time top 10, year-by-year record holders, percentile evolution, stacked-year split distribution. Optional class filter.
- **Etappe-søk** — searchable leaderboard for any single leg, by team or runner. Live percentile (vs that year, vs all years).
- **Rute** — Leaflet course map plotted from the actual 16 chip-mat coordinates, with per-leg drilldown.
- **Sammenligning** — side-by-side comparison of arbitrarily many teams: split times, rank progression (overall and in class), pace evolution. Search-and-add by name, runner, or filter.

## Data coverage

| Year | Teams | Splits |
|-----:|------:|-------:|
| 2019 | 3 467 | 51 994 |
| 2022 | 3 149 | 47 163 |
| 2023 | 4 093 | 61 372 |
| 2024 | 4 708 | 70 426 |
| 2025 | 4 955 | 74 242 |
| 2026 | 5 194 | 77 257 |
| **Σ** | **25 566** | **382 454** |

> 2014–2016 deliberately excluded: the leg 14/15 finish moved from Maratonporten to Bislettgata, so splits aren't comparable to the modern course.
> 2020–2021 cancelled due to COVID.

## Stack

- **React 18 + Recharts + Leaflet + react-window** — all loaded as ESM via `<script type="importmap">`. No bundler.
- **HTM** (`htm.bind(React.createElement)`) — JSX-flavoured tagged-template syntax, zero transpile.
- **Typography** — Fraunces (display, variable serif) + DM Sans (body) + JetBrains Mono (data).
- **Backend** — there isn't one. `python3 -m http.server` over a directory of pre-baked JSON.

## Layout

```
web/
├── index.html        # importmap + root mount
├── app.js            # ~2500 LOC, single-file React app
├── app.css
└── data/             # pre-baked JSON (~10 MB)
    ├── meta.json
    ├── teams.json
    ├── splits.json
    ├── stats_overall.json
    ├── stats_klasse.json
    └── team_rank.json
```

## Notes on the data

- **Splits are derived** from cumulative checkpoint times (`tid_total[N] − tid_total[N−1]`). Negative diffs (chip read order glitches) are filtered to null.
- **Runner names**: ~50% coverage on EQTiming years (depends on whether teams registered runners pre-race). 90%+ on UltimateLIVE years. Backfilled from `StafettDeltakere` startlist where available.
- **Class names** normalised to canonical codes (B1, B2, F1, F6 …) — raw data has up to four different spellings of "A1 - Bedriftslag/mosjonslag".

## License

Personal project. Data belongs to **Idrettsklubben Tjalve** and the timing providers (UltimateLIVE, EQTiming). Code is MIT.

---

*Built over an evening for personal curiosity after running leg 9.*
