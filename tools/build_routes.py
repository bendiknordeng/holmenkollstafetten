#!/usr/bin/env python3
"""
Build per-etappe polyline route JSON from chip-mat-tagged GPX traces.

Source: GPX files exported from racedays.run / Strava, matched to the 15
Holmenkollstafetten stages by start/end coordinates against the chip-mat
positions in docs/data/meta.json.

Stage 2 (Louises gate -> Wolffs gate) had no GPX track available; the
front-end falls back to a straight line for any stage not in the output.

Output: docs/data/etappe_routes.json
        { "1": [[lat, lon], ...], "3": [[lat, lon], ...], ... }

Coordinates are simplified with Ramer-Douglas-Peucker (~3 m tolerance).
"""

from __future__ import annotations

import json
import math
import os
import xml.etree.ElementTree as ET
from typing import Dict, List, Tuple

GPX_DIR = os.path.join(os.path.dirname(__file__), "..", "data-source", "gpx")
OUT_PATH = os.path.join(os.path.dirname(__file__), "..", "docs", "data", "etappe_routes.json")

NS = {"gpx": "http://www.topografix.com/GPX/1/1"}


def parse_gpx(path: str) -> List[Tuple[float, float]]:
    tree = ET.parse(path)
    root = tree.getroot()
    pts: List[Tuple[float, float]] = []
    for trkpt in root.iter("{http://www.topografix.com/GPX/1/1}trkpt"):
        lat = float(trkpt.attrib["lat"])
        lon = float(trkpt.attrib["lon"])
        pts.append((lat, lon))
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
    """Approximate perpendicular distance from p to segment a-b in metres."""
    if a == b:
        return haversine_m(p, a)
    # Project to local equirectangular plane around a.
    lat0 = math.radians(a[0])
    mx = 111_320.0 * math.cos(lat0)
    my = 110_540.0
    ax, ay = 0.0, 0.0
    bx = (b[1] - a[1]) * mx
    by = (b[0] - a[0]) * my
    px = (p[1] - a[1]) * mx
    py = (p[0] - a[0]) * my
    dx, dy = bx - ax, by - ay
    seglen2 = dx * dx + dy * dy
    if seglen2 == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / seglen2))
    cx, cy = ax + t * dx, ay + t * dy
    return math.hypot(px - cx, py - cy)


def rdp(points: List[Tuple[float, float]], eps_m: float) -> List[Tuple[float, float]]:
    if len(points) < 3:
        return list(points)
    # iterative RDP to avoid recursion-depth issues on long traces
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


def dedupe_consecutive(points: List[Tuple[float, float]]) -> List[Tuple[float, float]]:
    out: List[Tuple[float, float]] = []
    for p in points:
        if not out or haversine_m(out[-1], p) > 0.5:
            out.append(p)
    return out


def round_coords(points: List[Tuple[float, float]]) -> List[List[float]]:
    return [[round(lat, 6), round(lon, 6)] for lat, lon in points]


def main() -> None:
    out: Dict[str, List[List[float]]] = {}
    stages = list(range(1, 16))
    for n in stages:
        path = os.path.join(GPX_DIR, f"etappe-{n}.gpx")
        if not os.path.exists(path):
            print(f"  skip etappe {n}: {path} missing")
            continue
        pts = parse_gpx(path)
        pts = dedupe_consecutive(pts)
        simplified = rdp(pts, eps_m=3.0)
        out[str(n)] = round_coords(simplified)
        print(f"  etappe {n:>2}: {len(pts):>4} pts -> {len(simplified):>4} pts")

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"\nwrote {OUT_PATH} ({os.path.getsize(OUT_PATH)} bytes)")


if __name__ == "__main__":
    main()
