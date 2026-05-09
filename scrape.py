#!/usr/bin/env python3
"""Scrape Holmenkollstafetten team total times from sportsidioten.no.

Usage: python3 scrape.py
Writes results.csv with columns: year, class, rank, team, time, time_seconds.
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
OUT = Path(__file__).parent / "results.csv"

# Index pages per year to discover class result URLs.
INDEX_URLS = {
    2026: "https://www.sportsidioten.no/lop/holmenkollstafetten-2026/",
    2025: "https://www.sportsidioten.no/resultater/holmenkollstafetten-2025/",
    2024: "https://www.sportsidioten.no/lop/resultater-holmenkollstafetten-2024/",
    2023: "https://www.sportsidioten.no/lop/holmenkollstafetten-2023/",
}


def fetch(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30, context=SSL_CTX) as r:
        return r.read().decode("utf-8", errors="replace")


def discover_class_urls(index_html: str, year: int) -> list[str]:
    pattern = re.compile(rf'href="(https?://(?:www\.)?sportsidioten\.no/resultater/[^"]*-{year}[^"]*/)"')
    urls = set()
    for m in pattern.finditer(index_html):
        u = m.group(1)
        if "/feed/" in u or "/wp-json/" in u:
            continue
        urls.add(u)
    rel = re.compile(rf'href="(/resultater/[^"]*-{year}[^"]*/)"')
    for m in rel.finditer(index_html):
        urls.add("https://www.sportsidioten.no" + m.group(1))
    # Dedupe by canonical slug (strip "resultater-" prefix and host).
    canon: dict[str, str] = {}
    for u in urls:
        slug = u.rstrip("/").rsplit("/", 1)[-1]
        slug = re.sub(r"^resultater-", "", slug)
        canon.setdefault(slug, u)
    return sorted(canon.values())


def class_name_from_slug(url: str, year: int) -> str:
    slug = url.rstrip("/").rsplit("/", 1)[-1]
    slug = re.sub(rf"-?holmenkollstafetten-{year}-?\d*$", "", slug)
    slug = re.sub(r"^resultater-", "", slug)
    return slug.replace("-", " ").strip()


TIME_RE = re.compile(r"^(\d+:)?\d{1,2}:\d{2}(?:\.\d+)?$")


def parse_time_to_seconds(t: str) -> float | None:
    if not TIME_RE.match(t):
        return None
    parts = t.split(":")
    if len(parts) == 2:
        m, s = parts
        return int(m) * 60 + float(s)
    h, m, s = parts
    return int(h) * 3600 + int(m) * 60 + float(s)


def parse_results_table(page_html: str) -> list[tuple[int, str, str]]:
    # Find first table on page (sportsidioten layout).
    table_match = re.search(r"<table[\s\S]*?</table>", page_html)
    if not table_match:
        return []
    table_html = table_match.group(0)
    rows = re.findall(r"<tr[\s\S]*?</tr>", table_html)
    out = []
    for row in rows:
        # Try col-* class layout first (sportsidioten 2023 style).
        col_cells = re.findall(r'<t[dh][^>]*class="(col-[^"]*)"[^>]*>([\s\S]*?)</t[dh]>', row)
        if col_cells:
            named: dict[str, str] = {}
            for col, content in col_cells:
                text = html.unescape(re.sub(r"<[^>]+>", "", content)).strip()
                named[col] = text
            if "col-rank" not in named or not named["col-rank"].isdigit():
                continue
            rank = int(named["col-rank"])
            raw_name = named.get("col-name", "")
            bib_match = re.match(r"^(\d+)\.\s*(.*)", raw_name)
            bib = bib_match.group(1) if bib_match else ""
            team = bib_match.group(2) if bib_match else raw_name
            # 2023 layout crams "team city class" into one cell with NBSP/newlines.
            team = team.split("\xa0")[0].split("\n")[0].strip()
            t_raw = named.get("col-time", "")
            team_time = t_raw.split()[0] if t_raw else ""
            out.append((rank, team, team_time, bib))
            continue
        # Fall back to positional layout (sportsidioten 2024+ style).
        pos_cells = re.findall(r"<t[dh][^>]*>([\s\S]*?)</t[dh]>", row)
        if len(pos_cells) < 3:
            continue
        clean = [html.unescape(re.sub(r"<[^>]+>", "", c)).strip() for c in pos_cells]
        if not clean[0].isdigit():
            continue
        rank = int(clean[0])
        # 2025 expanded layout: rank, race_no, team, (empty), company, (empty), time, behind, [icon].
        # Detect by checking if cell 1 looks like a bib number and cell 2 is non-numeric.
        if len(clean) >= 7 and clean[1].isdigit() and clean[2] and not clean[2].isdigit():
            bib = clean[1]
            team_name = clean[2]
            company = clean[4] if len(clean) > 4 else ""
            # Combine team + company for uniqueness across companies sharing nicknames.
            team = f"{team_name} ({company})" if company and company != team_name else team_name
            team_time = next(
                (c.split()[0] for c in clean[6:] if c and TIME_RE.match(c.split()[0])),
                "",
            )
            out.append((rank, team, team_time, bib))
            continue
        team = clean[1]
        team_time = next((c.split()[0] for c in clean[2:] if TIME_RE.match(c.split()[0] if c else "")), "")
        if not team_time:
            team_time = clean[-1].split()[0] if clean[-1] else ""
        out.append((rank, team, team_time, ""))
    return out


def main() -> int:
    rows: list[dict] = []
    for year, index_url in INDEX_URLS.items():
        print(f"== {year} ==", file=sys.stderr)
        try:
            index_html = fetch(index_url)
        except Exception as e:
            print(f"  index fetch failed: {e}", file=sys.stderr)
            continue
        class_urls = discover_class_urls(index_html, year)
        print(f"  {len(class_urls)} classes", file=sys.stderr)
        for u in class_urls:
            cls = class_name_from_slug(u, year)
            try:
                page = fetch(u)
            except Exception as e:
                print(f"  {cls}: fetch failed: {e}", file=sys.stderr)
                continue
            data = parse_results_table(page)
            print(f"  {cls}: {len(data)} rows", file=sys.stderr)
            for rank, team, t, bib in data:
                rows.append(
                    {
                        "year": year,
                        "class": cls,
                        "rank": rank,
                        "bib": bib,
                        "team": team,
                        "time": t,
                        "time_seconds": parse_time_to_seconds(t) or "",
                        "source_url": u,
                    }
                )
            time.sleep(0.4)

    with OUT.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=["year", "class", "rank", "bib", "team", "time", "time_seconds", "source_url"],
        )
        writer.writeheader()
        writer.writerows(rows)
    print(f"Wrote {len(rows)} rows to {OUT}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
