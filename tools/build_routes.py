#!/usr/bin/env python3
"""
Build per-etappe polyline routes and elevation profiles from GPX traces.

Inputs
------
- data-source/gpx/etappe-{N}.gpx  — coords (with optional <ele>)
- data-source/elevations.json     — fallback ele arrays for stages whose
                                    GPX lacks <ele>, keyed by stage number
                                    and aligned by trkpt index

Outputs
-------
- docs/data/etappe_routes.json    — { "N": [[lat, lon], ...] }
- docs/data/etappe_elevation.json — { "N": { "points": [[dist_m, ele_m], ...],
                                              "gain": m, "loss": m,
                                              "min": m, "max": m,
                                              "length_m": m } }

Polylines are Ramer-Douglas-Peucker simplified at ~3 m. Elevation profiles
keep full resolution but with cumulative distance computed at full precision.
"""

from __future__ import annotations

import json
import math
import os
import xml.etree.ElementTree as ET
from typing import Dict, List, Optional, Tuple

BASE = os.path.dirname(__file__)
GPX_DIR = os.path.join(BASE, "..", "data-source", "gpx")
ELE_FALLBACK = os.path.join(BASE, "..", "data-source", "elevations.json")
ROUTES_OUT = os.path.join(BASE, "..", "docs", "data", "etappe_routes.json")
ELE_OUT = os.path.join(BASE, "..", "docs", "data", "etappe_elevation.json")


def parse_gpx(path: str) -> List[Tuple[float, float, Optional[float]]]:
    tree = ET.parse(path)
    root = tree.getroot()
    pts: List[Tuple[float, float, Optional[float]]] = []
    for trkpt in root.iter("{http://www.topografix.com/GPX/1/1}trkpt"):
        lat = float(trkpt.attrib["lat"])
        lon = float(trkpt.attrib["lon"])
        ele_el = trkpt.find("{http://www.topografix.com/GPX/1/1}ele")
        ele = float(ele_el.text) if ele_el is not None and ele_el.text else None
        pts.append((lat, lon, ele))
    return pts


def haversine_m(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    R = 6_371_000.0
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def perpendicular_distance_m(p, a, b):
    if a == b:
        return haversine_m(p, a)
    lat0 = math.radians(a[0])
    mx = 111_320.0 * math.cos(lat0)
    my = 110_540.0
    bx = (b[1] - a[1]) * mx
    by = (b[0] - a[0]) * my
    px = (p[1] - a[1]) * mx
    py = (p[0] - a[0]) * my
    seglen2 = bx * bx + by * by
    if seglen2 == 0:
        return math.hypot(px, py)
    t = max(0.0, min(1.0, (px * bx + py * by) / seglen2))
    cx, cy = t * bx, t * by
    return math.hypot(px - cx, py - cy)


def rdp(points: List[Tuple[float, float]], eps_m: float) -> List[Tuple[float, float]]:
    if len(points) < 3:
        return list(points)
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        i, j = stack.pop()
        if j - i < 2:
            continue
        dmax, idx = 0.0, -1
        for k in range(i + 1, j):
            d = perpendicular_distance_m(points[k], points[i], points[j])
            if d > dmax:
                dmax, idx = d, k
        if dmax > eps_m and idx != -1:
            keep[idx] = True
            stack.append((i, idx))
            stack.append((idx, j))
    return [p for p, k in zip(points, keep) if k]


def cumulative_distances(pts: List[Tuple[float, float, Optional[float]]]) -> List[float]:
    d = [0.0]
    for i in range(1, len(pts)):
        d.append(d[-1] + haversine_m((pts[i - 1][0], pts[i - 1][1]), (pts[i][0], pts[i][1])))
    return d


def smooth_ele(ele: List[float], window: int = 5) -> List[float]:
    """Centered moving average to take the edge off GPS jitter."""
    if len(ele) < 3:
        return list(ele)
    half = window // 2
    out = []
    for i in range(len(ele)):
        lo, hi = max(0, i - half), min(len(ele), i + half + 1)
        out.append(sum(ele[lo:hi]) / (hi - lo))
    return out


def downsample_profile(profile: List[List[float]], target: int = 80) -> List[List[float]]:
    """Keep first and last, plus uniformly-spaced indices in between."""
    n = len(profile)
    if n <= target:
        return profile
    step = (n - 1) / (target - 1)
    out = []
    for i in range(target):
        idx = round(i * step)
        out.append(profile[min(idx, n - 1)])
    return out


def round_coords(points: List[Tuple[float, float]]) -> List[List[float]]:
    return [[round(lat, 6), round(lon, 6)] for lat, lon in points]


def main() -> None:
    ele_fallback: Dict[str, List[float]] = {}
    if os.path.exists(ELE_FALLBACK):
        with open(ELE_FALLBACK) as f:
            ele_fallback = json.load(f)

    routes: Dict[str, List[List[float]]] = {}
    elevations: Dict[str, dict] = {}

    for n in range(1, 16):
        path = os.path.join(GPX_DIR, f"etappe-{n}.gpx")
        if not os.path.exists(path):
            print(f"  skip etappe {n}: {path} missing")
            continue
        pts = parse_gpx(path)

        # Inject elevation fallback if GPX lacks it. If counts differ slightly,
        # resample the fallback to match the GPX trkpt count by nearest index.
        if all(p[2] is None for p in pts) and str(n) in ele_fallback:
            fallback = ele_fallback[str(n)]
            if not fallback:
                pass
            elif len(fallback) == len(pts):
                pts = [(p[0], p[1], fallback[i]) for i, p in enumerate(pts)]
            else:
                ratio_diff = abs(len(fallback) - len(pts)) / max(len(pts), 1)
                if ratio_diff <= 0.05:
                    # Linear resample by index.
                    scale = (len(fallback) - 1) / max(len(pts) - 1, 1)
                    pts = [
                        (p[0], p[1], fallback[min(round(i * scale), len(fallback) - 1)])
                        for i, p in enumerate(pts)
                    ]
                    print(
                        f"  note etappe {n}: resampled fallback "
                        f"{len(fallback)} -> {len(pts)} pts"
                    )
                else:
                    print(
                        f"  warn etappe {n}: fallback ele has {len(fallback)} pts, "
                        f"GPX has {len(pts)}; skipping"
                    )

        # Routes: simplify on lat/lon only.
        latlon = [(p[0], p[1]) for p in pts]
        simplified = rdp(latlon, eps_m=3.0)
        routes[str(n)] = round_coords(simplified)

        # Elevation profile: keep all points but downsample to a UI-friendly count.
        if any(p[2] is not None for p in pts):
            cumd = cumulative_distances(pts)
            ele_raw = [p[2] if p[2] is not None else float("nan") for p in pts]
            ele = smooth_ele([e for e in ele_raw if not math.isnan(e)], window=5)
            # Re-align ele with full point list if there were Nones (shouldn't happen here).
            profile = [[round(cumd[i], 1), round(ele[i], 1)] for i in range(len(pts))]
            profile = downsample_profile(profile, target=80)
            valid_ele = [e for _, e in profile]
            gain = 0.0
            loss = 0.0
            for i in range(1, len(valid_ele)):
                d = valid_ele[i] - valid_ele[i - 1]
                if d > 0:
                    gain += d
                else:
                    loss -= d
            elevations[str(n)] = {
                "points": profile,
                "gain": round(gain, 1),
                "loss": round(loss, 1),
                "min": round(min(valid_ele), 1),
                "max": round(max(valid_ele), 1),
                "length_m": round(cumd[-1], 1),
            }

        ele_note = " +ele" if str(n) in elevations else ""
        print(f"  etappe {n:>2}: {len(pts):>4} pts -> {len(simplified):>4} pts{ele_note}")

    os.makedirs(os.path.dirname(ROUTES_OUT), exist_ok=True)
    with open(ROUTES_OUT, "w") as f:
        json.dump(routes, f, separators=(",", ":"))
    with open(ELE_OUT, "w") as f:
        json.dump(elevations, f, separators=(",", ":"))

    print(f"\nwrote {ROUTES_OUT} ({os.path.getsize(ROUTES_OUT)} bytes)")
    print(f"wrote {ELE_OUT} ({os.path.getsize(ELE_OUT)} bytes)")


if __name__ == "__main__":
    main()
