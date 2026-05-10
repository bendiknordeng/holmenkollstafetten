import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import { FixedSizeList } from "react-window";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
  Cell,
  ReferenceLine,
  LineChart,
  Line,
} from "recharts";
import htm from "htm";
import L from "leaflet";

const html = htm.bind(React.createElement);

// ---- Data loading ---------------------------------------------------------

const TEAM_FIELDS = ["tid", "year", "bib", "team", "bedrift", "klasse_id", "total_sec", "finished"];
// teams.json: array of [tid, year, bib, team, bedrift, klasse_id, total_sec, finished]
// splits.json: array of [tid, etappe, split_sec, total_sec, runner]

async function loadAll() {
  const [meta, teams, splits, teamRank, statsOverall, statsKlasse] = await Promise.all(
    [
      "data/meta.json",
      "data/teams.json",
      "data/splits.json",
      "data/team_rank.json",
      "data/stats_overall.json",
      "data/stats_klasse.json",
    ].map((u) => fetch(u).then((r) => r.json())),
  );
  return { meta, teams, splits, teamRank, statsOverall, statsKlasse };
}

// ---- Helpers --------------------------------------------------------------

function fmtTime(sec) {
  if (sec == null || isNaN(sec)) return "—";
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtPace(sec, distMeters) {
  if (sec == null || !distMeters) return "—";
  const paceSec = (sec / distMeters) * 1000; // sec per km
  const m = Math.floor(paceSec / 60);
  const s = Math.round(paceSec % 60);
  return `${m}:${String(s).padStart(2, "0")}/km`;
}

function percentileOf(sortedArr, value) {
  // returns percentile rank 0..100 (0 = fastest, 100 = slowest).
  if (!sortedArr || !sortedArr.length || value == null) return null;
  // binary search
  let lo = 0, hi = sortedArr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedArr[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return Math.round((lo / sortedArr.length) * 100);
}

function rankOf(sortedArr, value) {
  if (!sortedArr || !sortedArr.length || value == null) return null;
  let lo = 0, hi = sortedArr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedArr[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1;
}

function usePersistedState(key, init) {
  const [v, setV] = useState(() => {
    try {
      const raw = typeof window !== "undefined" ? window.localStorage.getItem(key) : null;
      if (raw != null) return JSON.parse(raw);
    } catch {}
    return typeof init === "function" ? init() : init;
  });
  useEffect(() => {
    try { window.localStorage.setItem(key, JSON.stringify(v)); } catch {}
  }, [key, v]);
  return [v, setV];
}

function useIsMobile(breakpoint = 820) {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(`(max-width: ${breakpoint}px)`).matches : false,
  );
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const onChange = (e) => setIsMobile(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [breakpoint]);
  return isMobile;
}

function pillClass(pct) {
  if (pct == null) return "";
  if (pct <= 25) return "top";
  if (pct <= 75) return "mid";
  return "low";
}

function wordBoundaryMatch(hay, q) {
  // Substring match restricted to word-start boundaries so "EY" doesn't
  // match the "ey" inside "McKinsey".
  if (!q) return true;
  let from = 0;
  while (from <= hay.length - q.length) {
    const idx = hay.indexOf(q, from);
    if (idx < 0) return false;
    if (idx === 0) return true;
    const prev = hay.charAt(idx - 1);
    if (!/[a-zæøåéü0-9]/i.test(prev)) return true;
    from = idx + 1;
  }
  return false;
}

function normalizeName(name) {
  // Keeps lag-numbers ("Vidar 1" vs "Vidar 2") so different squads remain
  // distinct, but strips class qualifiers + punctuation. Result example:
  // "EY BIL AI & Data 1" → "ey bil ai data 1".
  return (name || "")
    .toLowerCase()
    .replace(/[()]/g, " ")
    .replace(/\s+(menn|kvinner|herrer|damer|veteran|elite|junior|senior|mix|mixed|men|women)\b/g, " ")
    .replace(/[^a-zæøåéü0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const ETAPPE_DISTANCES_M = {
  1: 1100, 2: 1070, 3: 595, 4: 1920, 5: 1210, 6: 1250, 7: 1770, 8: 1780,
  9: 625, 10: 2860, 11: 1520, 12: 350, 13: 1080, 14: 710, 15: 535,
};

function totalDistAtEtappe(et) {
  let s = 0;
  for (let i = 1; i <= et; i++) s += ETAPPE_DISTANCES_M[i] || 0;
  return s;
}

const ETAPPE_PROFILES = {
  1: { karakter: "Gradvis brattere motbakke, så bratt nedover", profil: "🟧 stigende" },
  2: { karakter: "Downhill, deretter motbakke", profil: "🔄 vekslende" },
  3: { karakter: "Rolig, lite høydeendring", profil: "▬ flat" },
  4: { karakter: "Berg-og-dal, bratteste etappe", profil: "🔄 vekslende" },
  5: { karakter: "Stigende start, rolig avslutning", profil: "🟧 stigende" },
  6: { karakter: "Jevn god stigning mellomdel", profil: "🟧 stigende" },
  7: { karakter: "Kontinuerlig oppover til høyeste punkt", profil: "🟥 brattest opp" },
  8: { karakter: "1,5 km nedover fra Besserud, så flat", profil: "🟦 utfor" },
  9: { karakter: "Flat med liten nedgang", profil: "▬ flat" },
  10: { karakter: "Lang utforbakke, kuperte siste km", profil: "🟦 lang utfor" },
  11: { karakter: "Opp, nedover gjennom park, opp på slutten", profil: "🔄 vekslende" },
  12: { karakter: "Kort, flat, skarp 90° sving", profil: "⚡ sprinter" },
  13: { karakter: "Trappa — ujevn stigning", profil: "🟧 stigende" },
  14: { karakter: "Flat med slak nedgang", profil: "▬ flat" },
  15: { karakter: "Skarp innspurt på Bislett-banen", profil: "🏁 finish" },
};

const ETAPPE_NAMES = {
  1: "Knud Knudsens pl. → Louises gate",
  2: "Louises gate → Wolffs gate",
  3: "Wolffs gate → Wilh. Færdens vei",
  4: "Wilh. Færdens vei → Forskningsv.",
  5: "Forskningsveien → Holmenveien",
  6: "Holmenveien → Slemdal skole",
  7: "Slemdal skole → Besserud T",
  8: "Besserud T → Gressbanen",
  9: "Gressbanen → Holmendammen",
  10: "Holmendammen → Frognerparken",
  11: "Frognerparken → Nordraaks gt.",
  12: "Nordraaks gt. → Arno Bergs pl.",
  13: "Arno Bergs pl. → Camilla Colletts vei",
  14: "Camilla Colletts vei → Bislettgata",
  15: "Bislettgata → Bislett",
};

// ---- Components -----------------------------------------------------------

function ColumnFilter({ label, values, counts, selected, setSelected, sortNumeric }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const sorted = useMemo(() => {
    const arr = [...values];
    arr.sort((a, b) => {
      if (sortNumeric) return Number(a) - Number(b);
      return String(a).localeCompare(String(b), "no");
    });
    return arr;
  }, [values, sortNumeric]);

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    if (!qq) return sorted;
    return sorted.filter((v) => String(v).toLowerCase().includes(qq));
  }, [sorted, q]);

  const sel = new Set(selected);
  const toggle = (v) => {
    const next = new Set(sel);
    if (next.has(v)) next.delete(v); else next.add(v);
    setSelected([...next]);
  };

  return html`
    <span ref=${ref} style=${{ position: "relative", display: "inline-flex", alignItems: "center" }} onClick=${(e) => e.stopPropagation()}>
      <span
        className=${"col-filter-trigger" + (selected.length ? " active" : "")}
        onClick=${() => setOpen((o) => !o)}
      >
        ${label}
        ${selected.length ? html`<span className="badge">${selected.length}</span>` : null}
        <span className="arrow">▼</span>
      </span>
      ${open
        ? html`
            <div className="col-filter-pop" onClick=${(e) => e.stopPropagation()}>
              <div className="head">
                <input
                  type="text"
                  placeholder="filtrer…"
                  value=${q}
                  onInput=${(e) => setQ(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="actions">
                <button className="subtle" onClick=${() => setSelected([...filtered])}>Velg synlige</button>
                <button className="subtle" onClick=${() => setSelected([])}>Ingen</button>
              </div>
              <div className="body">
                ${filtered.map((v) => html`
                  <label className="row" key=${v}>
                    <input type="checkbox" checked=${sel.has(v)} onChange=${() => toggle(v)} />
                    <span>${v === "" ? "(tom)" : v}</span>
                    ${counts ? html`<span className="count">${counts[v] || 0}</span>` : null}
                  </label>
                `)}
              </div>
            </div>
          `
        : null}
    </span>
  `;
}

function MultiSearchInput({ values, setValues, placeholder }) {
  const [draft, setDraft] = useState("");
  const submit = () => {
    const v = draft.trim();
    if (!v) return;
    if (values.includes(v)) {
      setDraft("");
      return;
    }
    setValues([...values, v]);
    setDraft("");
  };
  const remove = (i) => setValues(values.filter((_, j) => j !== i));
  return html`
    <div style=${{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <input
        type="text"
        placeholder=${placeholder}
        value=${draft}
        onInput=${(e) => setDraft(e.target.value)}
        onKeyDown=${(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          } else if (e.key === "Backspace" && !draft && values.length) {
            remove(values.length - 1);
          }
        }}
      />
      ${values.length
        ? html`
            <div className="chips">
              ${values.map(
                (v, i) => html`
                  <span key=${v} className="chip" style=${{ display: "inline-flex", alignItems: "center", gap: "6px", cursor: "pointer" }} onClick=${() => remove(i)}>
                    ${v} <span style=${{ color: "var(--muted)" }}>✕</span>
                  </span>
                `,
              )}
              <button className="subtle" onClick=${() => setValues([])}>Fjern alle</button>
            </div>
          `
        : null}
    </div>
  `;
}

function Topbar({ view, setView, n, compareCount, hasSidebar, sidebarOpen, setSidebarOpen, isMobile }) {
  return html`
    <div className="topbar">
      ${isMobile && hasSidebar ? html`
        <button
          aria-label="Filtre"
          className="hamburger"
          onClick=${() => setSidebarOpen(!sidebarOpen)}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h18" />
            <path d="M6 12h12" />
            <path d="M10 18h4" />
          </svg>
        </button>
      ` : null}
      <h1>HK<em>Split</em> <span className="small">Holmenkollstafetten · ${n.toLocaleString("no")} lag · 2019–2026</span></h1>
      <div className="spacer"></div>
      ${compareCount > 0
        ? html`
            <div className="compare-counter" onClick=${() => setView("compare")}>
              <span>Sammenlign</span>
              <span className="num">${compareCount}</span>
            </div>
          `
        : null}
      <div className="tabs">
        <button className=${view === "teams" ? "active" : ""} onClick=${() => setView("teams")}>Lag</button>
        <button className=${view === "etapper" ? "active" : ""} onClick=${() => setView("etapper")}>Etapper</button>
        <button className=${view === "etappesok" ? "active" : ""} onClick=${() => setView("etappesok")}>Etappe-søk</button>
        <button className=${view === "rute" ? "active" : ""} onClick=${() => setView("rute")}>Rute</button>
        <button className=${view === "compare" ? "active" : ""} onClick=${() => setView("compare")}>Sammenligning${compareCount ? ` (${compareCount})` : ""}</button>
      </div>
    </div>
  `;
}

const COMPARE_PALETTE = [
  "#f4cf3a", // saffron
  "#6cc270", // green
  "#e4574a", // red
  "#5fa8d3", // sky
  "#d99c5b", // amber
  "#b78fff", // lavender
  "#ff8aa6", // rose
  "#7be0d6", // teal
];

function colorForCompareIdx(i) {
  return COMPARE_PALETTE[i % COMPARE_PALETTE.length];
}

function Sidebar({ filters, setFilters, klasser, years, klasseCounts }) {
  const [klasseQ, setKlasseQ] = useState("");
  const filteredKlasser = useMemo(() => {
    const q = klasseQ.toLowerCase();
    return klasser
      .map((k, i) => [k, i])
      .filter(([k]) => !q || k.toLowerCase().includes(q));
  }, [klasseQ, klasser]);

  const toggleYear = (y) => {
    const set = new Set(filters.years);
    set.has(y) ? set.delete(y) : set.add(y);
    setFilters({ ...filters, years: [...set] });
  };
  const toggleKlasse = (i) => {
    const set = new Set(filters.klasser);
    set.has(i) ? set.delete(i) : set.add(i);
    setFilters({ ...filters, klasser: [...set] });
  };

  return html`
    <div className="sidebar">
      <div className="field">
        <label>Søk i</label>
        <div className="chips" style=${{ marginBottom: "4px" }}>
          <button
            className=${"subtle " + (filters.qField === "team" ? "active" : "")}
            onClick=${() => setFilters({ ...filters, qField: "team" })}
          >Lag</button>
          <button
            className=${"subtle " + (filters.qField === "bedrift" ? "active" : "")}
            onClick=${() => setFilters({ ...filters, qField: "bedrift" })}
          >Bedrift</button>
          <button
            className=${"subtle " + (filters.qField === "both" ? "active" : "")}
            onClick=${() => setFilters({ ...filters, qField: "both" })}
          >Begge</button>
        </div>
        <input
          type="text"
          placeholder=${filters.qField === "team" ? "Lagnavn…" : filters.qField === "bedrift" ? "Bedriftsnavn…" : "Lag eller bedrift…"}
          value=${(filters.q && filters.q[0]) || ""}
          onInput=${(e) => setFilters({ ...filters, q: e.target.value ? [e.target.value] : [] })}
        />
      </div>
      <div className="field">
        <label>År</label>
        <div className="chips">
          ${years.map(
            (y) => html`
              <button
                key=${y}
                className=${"subtle " + (filters.years.includes(y) ? "active" : "")}
                onClick=${() => toggleYear(y)}
              >
                ${y}
              </button>
            `,
          )}
        </div>
      </div>
      <div className="field">
        <label>Klasse (${filters.klasser.length || "alle"})</label>
        <input
          type="text"
          placeholder="filtrer klasser…"
          value=${klasseQ}
          onInput=${(e) => setKlasseQ(e.target.value)}
        />
        <div className="filter-list">
          ${filteredKlasser.map(
            ([k, i]) => {
              const parts = (k || "").split(/[\s-]/);
              const code = parts[0] && /^[A-Z][A-Z0-9-]*$/.test(parts[0]) ? parts[0] : null;
              const rest = code ? k.replace(/^[A-Z][A-Z0-9-]*\s*-?\s*/, "") : (k || "(ukjent)");
              return html`
                <label className="row" key=${i}>
                  <input
                    type="checkbox"
                    checked=${filters.klasser.includes(i)}
                    onChange=${() => toggleKlasse(i)}
                  />
                  ${code ? html`<span className="code">${code}</span>` : null}
                  <span className="name">${rest || k || "(ukjent)"}</span>
                  <span className="count">${klasseCounts[i] || 0}</span>
                </label>
              `;
            },
          )}
        </div>
      </div>
    </div>
  `;
}

const SORT_KEYS = {
  total: (a, b) => (a[6] ?? Infinity) - (b[6] ?? Infinity),
  team: (a, b) => (a[3] || "").localeCompare(b[3] || "", "no"),
  year: (a, b) => b[1] - a[1] || (a[6] ?? Infinity) - (b[6] ?? Infinity),
  klasse: (a, b, kl) => (kl[a[5]] || "").localeCompare(kl[b[5]] || "", "no"),
};

function TeamsView({ db, filters, setFilters, selected, setSelected, compareTids, toggleCompare, splitsByTid }) {
  const { teams, meta, teamRank } = db;
  const [sortBy, setSortBy] = useState("total");
  const compareSet = useMemo(() => new Set(compareTids), [compareTids]);
  const isMobile = useIsMobile();

  const colFacets = useMemo(() => {
    const yearCount = new Map();
    const bedriftCount = new Map();
    const klasseCount = new Map();
    for (const t of teams) {
      yearCount.set(t[1], (yearCount.get(t[1]) || 0) + 1);
      const b = t[4] || "";
      bedriftCount.set(b, (bedriftCount.get(b) || 0) + 1);
      const k = meta.klasser[t[5]] || "";
      klasseCount.set(k, (klasseCount.get(k) || 0) + 1);
    }
    const obj = (m) => Object.fromEntries(m);
    return {
      years: [...yearCount.keys()],
      yearCounts: obj(yearCount),
      bedrifter: [...bedriftCount.keys()],
      bedriftCounts: obj(bedriftCount),
      klasser: [...klasseCount.keys()],
      klasseCounts: obj(klasseCount),
    };
  }, [teams, meta.klasser]);

  const klasseNameToId = useMemo(() => {
    const m = new Map();
    meta.klasser.forEach((n, i) => m.set(n, i));
    return m;
  }, [meta.klasser]);
  const filtered = useMemo(() => {
    const queries = filters.q.map((q) => q.toLowerCase()).filter(Boolean);
    const yearSet = filters.years.length ? new Set(filters.years) : null;
    const klasseSet = filters.klasser.length ? new Set(filters.klasser) : null;
    const bedriftSet = (filters.bedrifter && filters.bedrifter.length) ? new Set(filters.bedrifter) : null;
    let out = teams.filter((t) => {
      if (yearSet && !yearSet.has(t[1])) return false;
      if (klasseSet && !klasseSet.has(t[5])) return false;
      if (bedriftSet && !bedriftSet.has(t[4] || "")) return false;
      if (filters.onlyFinished && !t[7]) return false;
      if (queries.length) {
        const fld = filters.qField || "team";
        const hay = (
          fld === "team" ? (t[3] || "")
          : fld === "bedrift" ? (t[4] || "")
          : (t[3] || "") + " " + (t[4] || "")
        ).toLowerCase();
        if (!queries.some((q) => wordBoundaryMatch(hay, q))) return false;
      }
      return true;
    });
    out = out.slice().sort((a, b) => SORT_KEYS[sortBy](a, b, meta.klasser));
    return out;
  }, [teams, filters, sortBy, meta.klasser, splitsByTid]);

  const cols = "32px 60px 60px 2fr 1fr 1.2fr 100px 100px";
  const itemSize = isMobile ? 68 : 38;

  const RowDesktop = ({ index, style }) => {
    const t = filtered[index];
    const [tid, year, bib, team, bedrift, kid, total, finished] = t;
    const rank = teamRank[tid];
    const isComp = compareSet.has(tid);
    return html`
      <div
        style=${{ ...style, gridTemplateColumns: cols }}
        className=${"table-row" + (selected === tid ? " selected" : "") + (isComp ? " compared" : "")}
        onClick=${() => setSelected(tid)}
      >
        <div className="cell" onClick=${(e) => { e.stopPropagation(); toggleCompare(tid); }}>
          <span className=${"compare-toggle" + (isComp ? " on" : "")} title=${isComp ? "Fjern fra sammenligning" : "Legg til i sammenligning"}>${isComp ? "✓" : "+"}</span>
        </div>
        <div className="cell mono"><span className=${"chip year-" + year}>${year}</span></div>
        <div className="cell mono muted">${bib}</div>
        <div className="cell">${team || "(ukjent)"}</div>
        <div className="cell muted">${bedrift || "—"}</div>
        <div className="cell muted" style=${{ fontSize: "12px" }}>${meta.klasser[kid] || "—"}</div>
        <div className="cell mono right">${fmtTime(total)}</div>
        <div className="cell mono right">${rank?.[0] ? `${rank[0]} / ${rank[1]}` : "—"}</div>
      </div>
    `;
  };

  const RowMobile = ({ index, style }) => {
    const t = filtered[index];
    const [tid, year, bib, team, bedrift, kid, total, finished] = t;
    const rank = teamRank[tid];
    const isComp = compareSet.has(tid);
    const klasseCode = (meta.klasser[kid] || "").split(" ")[0] || "";
    return html`
      <div
        style=${{ ...style, display: "grid", gridTemplateColumns: "30px 1fr auto", gap: "10px", padding: "8px 12px", alignItems: "center", borderBottom: "1px solid var(--border)", cursor: "pointer", boxSizing: "border-box" }}
        className=${"table-row" + (selected === tid ? " selected" : "") + (isComp ? " compared" : "")}
        onClick=${() => setSelected(tid)}
      >
        <div onClick=${(e) => { e.stopPropagation(); toggleCompare(tid); }}>
          <span className=${"compare-toggle" + (isComp ? " on" : "")}>${isComp ? "✓" : "+"}</span>
        </div>
        <div style=${{ minWidth: 0 }}>
          <div style=${{ fontSize: "13px", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>${team || "(ukjent)"}</div>
          <div style=${{ fontSize: "11px", color: "var(--muted)", marginTop: "2px", display: "flex", gap: "6px", alignItems: "center" }}>
            <span className=${"chip year-" + year} style=${{ fontSize: "10px", height: "16px", padding: "0 6px" }}>${year}</span>
            ${klasseCode ? html`<span style=${{ fontFamily: "JetBrains Mono, monospace" }}>${klasseCode}</span>` : null}
            ${bedrift ? html`<span style=${{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>· ${bedrift}</span>` : null}
          </div>
        </div>
        <div style=${{ textAlign: "right", flexShrink: 0 }}>
          <div style=${{ fontFamily: "JetBrains Mono, monospace", fontWeight: 700, fontSize: "14px" }}>${fmtTime(total)}</div>
          <div style=${{ fontFamily: "JetBrains Mono, monospace", fontSize: "10px", color: "var(--muted)", marginTop: "2px" }}>${rank?.[0] ? `#${rank[0]}` : "—"}</div>
        </div>
      </div>
    `;
  };

  const Row = isMobile ? RowMobile : RowDesktop;

  return html`
    <div className="content" style=${{ padding: 0 }}>
      <div className="table-wrap">
        <div className="table-header" style=${{ gridTemplateColumns: cols, overflow: "visible", display: isMobile ? "none" : undefined }}>
          <div>
            ${(() => {
              const allInCompare = filtered.length > 0 && filtered.every((t) => compareSet.has(t[0]));
              const someInCompare = filtered.some((t) => compareSet.has(t[0]));
              const onClick = (e) => {
                e.stopPropagation();
                if (filtered.length === 0) return;
                if (allInCompare) {
                  for (const t of filtered) toggleCompare(t[0]);
                } else {
                  for (const t of filtered) if (!compareSet.has(t[0])) toggleCompare(t[0]);
                }
              };
              return html`
                <span
                  className=${"compare-toggle" + (allInCompare ? " on" : "")}
                  onClick=${onClick}
                  title=${allInCompare ? `Fjern alle ${filtered.length} fra sammenligning` : `Legg til alle ${filtered.length} i sammenligning`}
                  style=${{ cursor: "pointer" }}
                >${allInCompare ? "−" : someInCompare ? "±" : "+"}</span>
              `;
            })()}
          </div>
          <div>
            <${ColumnFilter}
              label=${html`<span onClick=${() => setSortBy("year")}>År</span>`}
              values=${colFacets.years}
              counts=${colFacets.yearCounts}
              selected=${filters.years}
              setSelected=${(v) => setFilters({ ...filters, years: v })}
              sortNumeric=${true}
            />
          </div>
          <div>Bib</div>
          <div onClick=${() => setSortBy("team")}>Lag</div>
          <div>
            <${ColumnFilter}
              label=${html`<span>Bedrift</span>`}
              values=${colFacets.bedrifter}
              counts=${colFacets.bedriftCounts}
              selected=${filters.bedrifter || []}
              setSelected=${(v) => setFilters({ ...filters, bedrifter: v })}
            />
          </div>
          <div>
            <${ColumnFilter}
              label=${html`<span onClick=${() => setSortBy("klasse")}>Klasse</span>`}
              values=${colFacets.klasser}
              counts=${colFacets.klasseCounts}
              selected=${(filters.klasser || []).map((id) => meta.klasser[id])}
              setSelected=${(v) => setFilters({ ...filters, klasser: v.map((n) => klasseNameToId.get(n)).filter((x) => x != null) })}
            />
          </div>
          <div className="right" onClick=${() => setSortBy("total")}>Tid</div>
          <div className="right">Rang i klasse</div>
        </div>
        <div style=${{ flex: 1, minHeight: 0 }}>
          ${filtered.length === 0
            ? html`<div className="empty">Ingen lag matcher filtrene.</div>`
            : html`
                <${AutoSizedList}
                  itemCount=${filtered.length}
                  itemSize=${itemSize}
                  Row=${Row}
                />
              `}
        </div>
      </div>
    </div>
  `;
}

function AutoSizedList({ itemCount, itemSize, Row }) {
  const ref = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      setSize({ w: e.contentRect.width, h: e.contentRect.height });
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return html`
    <div ref=${ref} style=${{ width: "100%", height: "100%" }}>
      ${size.h > 0 &&
      html`
        <${FixedSizeList}
          height=${size.h}
          width=${size.w}
          itemCount=${itemCount}
          itemSize=${itemSize}
        >
          ${Row}
        <//>
      `}
    </div>
  `;
}

function TeamDetail({ db, tid, splitsByTid, sameTeamIndex, setSelected, statsAllYears, cumIndex, compareTids, toggleCompare }) {
  const isComp = compareTids?.includes(tid);
  const isMobile = useIsMobile();
  const { teams, meta, teamRank, statsOverall, statsKlasse } = db;
  const team = teams[tid];
  if (!team) return null;
  const [, year, bib, name, bedrift, kid, total, finished] = team;
  const klasse = meta.klasser[kid] || "";
  const rank = teamRank[tid];
  const splits = splitsByTid.get(tid) || [];
  const dist = meta.etappe_distances || {};

  const rows = splits.map((s) => {
    const [, etappe, split_sec, total_sec, runner] = s;
    const sk = `${year}-${etappe}`;
    const stat = statsOverall[sk];
    const pctYear = stat ? percentileOf(stat.sorted, split_sec) : null;
    const rkYear = stat ? rankOf(stat.sorted, split_sec) : null;
    const allArr = statsAllYears?.[etappe];
    const pctAll = allArr ? percentileOf(allArr, split_sec) : null;
    const rkAll = allArr ? rankOf(allArr, split_sec) : null;
    const klSk = `${year}-${etappe}-${kid}`;
    const klStat = statsKlasse[klSk];
    const dMeters = dist[etappe];
    return { etappe, split_sec, total_sec, runner, pctYear, rkYear, pctAll, rkAll, n: stat?.n, nAll: allArr?.length, klMedian: klStat?.median, dMeters };
  });

  // Rank progression per etappe (in klasse + overall).
  const progression = useMemo(() => {
    if (!cumIndex) return [];
    const out = [];
    for (const s of splits) {
      const [, etappe, , total_sec] = s;
      if (total_sec == null) continue;
      const allArr = cumIndex.all.get(`${year}-${etappe}`);
      const klArr = cumIndex.klasse.get(`${year}-${kid}-${etappe}`);
      const rkAll = allArr ? rankOf(allArr, total_sec) : null;
      const nAll = allArr?.length;
      const rkKl = klArr ? rankOf(klArr, total_sec) : null;
      const nKl = klArr?.length;
      const dist = totalDistAtEtappe(etappe);
      const paceSec = dist ? (total_sec / dist) * 1000 : null;
      out.push({
        etappe,
        rankAll: rkAll,
        rankKlasse: rkKl,
        nAll,
        nKl,
        cumPaceSec: paceSec,
      });
    }
    return out;
  }, [cumIndex, splits, year, kid]);

  // Build cross-year average split by etappe for a context line.
  const crossYears = useMemo(() => {
    const out = [];
    for (let e = 1; e <= 15; e++) {
      const sample = rows.find((r) => r.etappe === e);
      if (!sample) {
        out.push({ etappe: e, split: null, median: null });
        continue;
      }
      const stat = statsOverall[`${year}-${e}`];
      out.push({
        etappe: e,
        split: sample.split_sec,
        median: stat?.median ?? null,
      });
    }
    return out;
  }, [rows, year, statsOverall]);

  return html`
    <${React.Fragment}>
    <div className="detail">
      <div style=${{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px" }}>
        <div style=${{ flex: 1, minWidth: 0 }}>
          <h2>${name}</h2>
          <div className="sub">
            <span className=${"chip year-" + year}>${year}</span>
            ${"  "}bib ${bib}${bedrift ? ` · ${bedrift}` : ""}${klasse ? ` · ${klasse}` : ""}
          </div>
        </div>
        <div style=${{ display: "flex", gap: "6px" }}>
          <button
            className=${isComp ? "primary" : "subtle"}
            onClick=${() => toggleCompare?.(tid)}
            title="Sammenlign med andre lag"
          >
            ${isComp ? "✓ I sammenligning" : "+ Legg til"}
          </button>
          <button className="subtle" onClick=${() => setSelected(null)}>Lukk ✕</button>
        </div>
      </div>
      <div className="grid">
        <div className="stat" key="t"><div className="label">Totaltid</div><div className="value">${fmtTime(total)}</div></div>
        <div className="stat" key="r">
          <div className="label">Rang i klasse</div>
          <div className="value">${rank?.[0] ? `${rank[0]} / ${rank[1]}` : "—"}</div>
        </div>
        <div className="stat" key="e">
          <div className="label">Etapper fullført</div>
          <div className="value">${splits.length} / 15</div>
        </div>
        <div className="stat" key="s">
          <div className="label">Snittfart total</div>
          <div className="value">${fmtPace(total, 18495)}</div>
        </div>
      </div>
      ${isMobile
        ? html`
            <div className="etappe-cards">
              ${rows.map((r) => html`
                <div className="etappe-card" key=${r.etappe}>
                  <div className="etappe-card-head">
                    <div className="etappe-card-num">${r.etappe}</div>
                    <div className="etappe-card-title">
                      <div className="etappe-card-name">${ETAPPE_NAMES[r.etappe] || ""}</div>
                      <div className="etappe-card-runner">${r.runner || html`<span style=${{ fontStyle: "italic", color: "var(--muted)" }}>(ukjent løper)</span>`}</div>
                    </div>
                    <div className="etappe-card-time">
                      <div className="t">${fmtTime(r.split_sec)}</div>
                      <div className="p">${fmtPace(r.split_sec, r.dMeters)}${r.dMeters ? ` · ${r.dMeters} m` : ""}</div>
                    </div>
                  </div>
                  <div className="etappe-card-stats">
                    <div className="s">
                      <div className="lbl">Rang ${year}</div>
                      <div className="val">${r.rkYear ? `${r.rkYear} / ${r.n}` : "—"}</div>
                    </div>
                    <div className="s">
                      <div className="lbl">Pct ${year}</div>
                      <div className="val">${r.pctYear != null ? html`<span className=${"percent-pill " + pillClass(r.pctYear)}>${r.pctYear}%</span>` : "—"}</div>
                    </div>
                    <div className="s">
                      <div className="lbl">Rang alle år</div>
                      <div className="val">${r.rkAll ? `${r.rkAll} / ${r.nAll}` : "—"}</div>
                    </div>
                    <div className="s">
                      <div className="lbl">Pct alle år</div>
                      <div className="val">${r.pctAll != null ? html`<span className=${"percent-pill " + pillClass(r.pctAll)}>${r.pctAll}%</span>` : "—"}</div>
                    </div>
                    <div className="s">
                      <div className="lbl">Klassemedian</div>
                      <div className="val muted">${fmtTime(r.klMedian)}</div>
                    </div>
                  </div>
                </div>
              `)}
            </div>
          `
        : html`
            <table className="etappes-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Etappe</th>
                  <th>Løper</th>
                  <th className="right">Dist.</th>
                  <th className="right">Tid</th>
                  <th className="right">Fart</th>
                  <th className="right">Rang ${year}</th>
                  <th className="right">Percentil ${year}</th>
                  <th className="right">Rang alle år</th>
                  <th className="right">Percentil alle år</th>
                  <th className="right">Klassemedian</th>
                </tr>
              </thead>
              <tbody>
                ${rows.map(
                  (r) => html`
                    <tr key=${r.etappe}>
                      <td>${r.etappe}</td>
                      <td className="team-name" style=${{ color: "var(--muted)", fontSize: "12px" }}>${ETAPPE_NAMES[r.etappe] || ""}</td>
                      <td className="team-name">${r.runner || "—"}</td>
                      <td className="right muted" style=${{ fontSize: "12px" }}>${r.dMeters ? r.dMeters + " m" : "—"}</td>
                      <td className="right">${fmtTime(r.split_sec)}</td>
                      <td className="right muted" style=${{ fontSize: "12px" }}>${fmtPace(r.split_sec, r.dMeters)}</td>
                      <td className="right">${r.rkYear ? `${r.rkYear} / ${r.n}` : "—"}</td>
                      <td className="right">
                        ${r.pctYear != null
                          ? html`<span className=${"percent-pill " + pillClass(r.pctYear)}>${r.pctYear}%</span>`
                          : "—"}
                      </td>
                      <td className="right">${r.rkAll ? `${r.rkAll} / ${r.nAll}` : "—"}</td>
                      <td className="right">
                        ${r.pctAll != null
                          ? html`<span className=${"percent-pill " + pillClass(r.pctAll)}>${r.pctAll}%</span>`
                          : "—"}
                      </td>
                      <td className="right muted">${fmtTime(r.klMedian)}</td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          `}
    </div>
    <div className="chart-wrap">
      <h3>Etappetid vs ${year} median</h3>
      <${ResponsiveContainer} width="100%" height=${280}>
        <${BarChart} data=${crossYears} margin=${{ top: 10, right: 20, left: 0, bottom: 0 }}>
          <${CartesianGrid} stroke="#30363d" strokeDasharray="3 3" />
          <${XAxis} dataKey="etappe" stroke="#8b949e" fontSize=${12} />
          <${YAxis} stroke="#8b949e" fontSize=${12} tickFormatter=${(v) => fmtTime(v)} />
          <${Tooltip}
            formatter=${(v) => fmtTime(v)}
            contentStyle=${{ background: "#161b22", border: "1px solid #30363d" }}
          />
          <${Legend} />
          <${Bar} dataKey="split" name="Lagets tid" fill="#58a6ff" />
          <${Bar} dataKey="median" name=${`${year} median`} fill="#f0b429" />
        <//>
      <//>
    </div>
    ${progression.length
      ? html`
          <div className="chart-wrap">
            <h3>Plassering gjennom løpet (${year})</h3>
            <${ResponsiveContainer} width="100%" height=${280}>
              <${LineChart} data=${progression}>
                <${CartesianGrid} stroke="#30363d" strokeDasharray="3 3" />
                <${XAxis} dataKey="etappe" stroke="#8b949e" label=${{ value: "Etappe", position: "insideBottom", offset: -2, fill: "#8b949e" }} />
                <${YAxis} stroke="#8b949e" reversed=${true} label=${{ value: "Rang (lavere = bedre)", angle: -90, position: "insideLeft", fill: "#8b949e" }} />
                <${Tooltip}
                  contentStyle=${{ background: "#161b22", border: "1px solid #30363d" }}
                  formatter=${(v, name, p) => {
                    if (name === "I klasse") return [`${v} / ${p.payload.nKl}`, name];
                    if (name === "Totalt") return [`${v} / ${p.payload.nAll}`, name];
                    return [v, name];
                  }}
                />
                <${Legend} />
                <${Line} type="monotone" dataKey="rankKlasse" stroke="#3fb950" name="I klasse" strokeWidth=${2} />
                <${Line} type="monotone" dataKey="rankAll" stroke="#58a6ff" name="Totalt" strokeWidth=${2} />
              <//>
            <//>
          </div>
          <div className="chart-wrap">
            <h3>Snitt-fart akkumulert (${year})</h3>
            <${ResponsiveContainer} width="100%" height=${240}>
              <${LineChart} data=${progression}>
                <${CartesianGrid} stroke="#30363d" strokeDasharray="3 3" />
                <${XAxis} dataKey="etappe" stroke="#8b949e" />
                <${YAxis}
                  stroke="#8b949e"
                  domain=${["dataMin - 10", "dataMax + 10"]}
                  tickFormatter=${(v) => {
                    const m = Math.floor(v / 60);
                    const s = Math.round(v % 60);
                    return `${m}:${String(s).padStart(2, "0")}`;
                  }}
                  label=${{ value: "min/km", angle: -90, position: "insideLeft", fill: "#8b949e" }}
                />
                <${Tooltip}
                  contentStyle=${{ background: "#161b22", border: "1px solid #30363d" }}
                  formatter=${(v) => {
                    const m = Math.floor(v / 60);
                    const s = Math.round(v % 60);
                    return [`${m}:${String(s).padStart(2, "0")}/km`, "Snittfart"];
                  }}
                />
                <${Line} type="monotone" dataKey="cumPaceSec" stroke="#f0b429" strokeWidth=${2} dot=${false} />
              <//>
            <//>
          </div>
        `
      : null}
    <${SameTeamPanel}
      tid=${tid}
      db=${db}
      splitsByTid=${splitsByTid}
      sameTeamIndex=${sameTeamIndex}
      setSelected=${setSelected}
      toggleCompare=${toggleCompare}
      compareTids=${compareTids}
    />
    <//>
  `;
}

function SameTeamPanel({ tid, db, splitsByTid, sameTeamIndex, setSelected, toggleCompare, compareTids, setView }) {
  const { teams, meta } = db;
  const team = teams[tid];
  if (!team) return null;
  const norm = normalizeName(team[3]);
  const sibTids = (sameTeamIndex.get(norm) || []).filter((t) => t !== tid);
  if (!sibTids.length) return null;

  // Build cross-year etappe comparison.
  const allYearsData = useMemo(() => {
    const allTids = [tid, ...sibTids];
    const out = [];
    for (let e = 1; e <= 15; e++) {
      const row = { etappe: e };
      for (const t of allTids) {
        const team = teams[t];
        const splits = splitsByTid.get(t) || [];
        const s = splits.find((x) => x[1] === e);
        if (s && s[2] != null) row[`y${team[1]}`] = s[2];
      }
      out.push(row);
    }
    return out;
  }, [tid, sibTids, splitsByTid, teams]);

  const yearColors = { 2023: "#d29922", 2024: "#f85149", 2025: "#3fb950", 2026: "#58a6ff" };

  const allTids = [tid, ...sibTids];
  const allInCompare = allTids.every((t) => compareTids?.includes(t));
  const addAll = () => {
    if (!toggleCompare) return;
    for (const t of allTids) {
      if (!compareTids?.includes(t)) toggleCompare(t);
    }
  };

  return html`
    <div className="detail">
      <div style=${{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px" }}>
        <div style=${{ flex: 1 }}>
          <div className="kicker">På tvers av år</div>
          <h2>Samme lag <em>tidligere år</em></h2>
          <div className="sub">Match basert på normalisert lagnavn: «${norm}»</div>
        </div>
        ${toggleCompare
          ? html`
              <button
                className=${allInCompare ? "subtle" : "primary"}
                onClick=${addAll}
                disabled=${allInCompare}
              >
                ${allInCompare ? "Alle i sammenligning" : `+ Legg til alle ${allTids.length} år`}
              </button>
            `
          : null}
      </div>
      <table className="etappes-table">
        <thead>
          <tr>
            <th>År</th>
            <th>Lagnavn</th>
            <th>Klasse</th>
            <th className="right">Totaltid</th>
            <th className="right">Rang i klasse</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${[tid, ...sibTids]
            .map((t) => teams[t])
            .sort((a, b) => b[1] - a[1])
            .map((t) => {
              const rank = db.teamRank[t[0]];
              return html`
                <tr key=${t[0]}>
                  <td><span className=${"chip year-" + t[1]}>${t[1]}</span></td>
                  <td className="team-name">${t[3]}</td>
                  <td className="team-name" style=${{ color: "var(--muted)", fontSize: "12px" }}>${meta.klasser[t[5]] || ""}</td>
                  <td className="right">${fmtTime(t[6])}</td>
                  <td className="right">${rank?.[0] ? `${rank[0]} / ${rank[1]}` : "—"}</td>
                  <td className="right">
                    ${t[0] !== tid
                      ? html`<button className="subtle" onClick=${() => setSelected(t[0])}>Vis</button>`
                      : html`<span className="cell muted">valgt</span>`}
                  </td>
                </tr>
              `;
            })}
        </tbody>
      </table>
    </div>
    <div className="chart-wrap">
      <h3>Splits per etappe på tvers av år</h3>
      <${ResponsiveContainer} width="100%" height=${320}>
        <${LineChart} data=${allYearsData}>
          <${CartesianGrid} stroke="#30363d" strokeDasharray="3 3" />
          <${XAxis} dataKey="etappe" stroke="#8b949e" />
          <${YAxis} stroke="#8b949e" tickFormatter=${(v) => fmtTime(v)} />
          <${Tooltip}
            formatter=${(v) => fmtTime(v)}
            contentStyle=${{ background: "#161b22", border: "1px solid #30363d" }}
          />
          <${Legend} />
          ${[tid, ...sibTids]
            .map((t) => teams[t])
            .sort((a, b) => a[1] - b[1])
            .map(
              (t) => html`
                <${Line}
                  key=${t[0]}
                  type="monotone"
                  dataKey=${`y${t[1]}`}
                  name=${t[1].toString()}
                  stroke=${yearColors[t[1]]}
                  strokeWidth=${t[0] === tid ? 3 : 1.5}
                  dot=${false}
                />
              `,
            )}
        <//>
      <//>
    </div>
  `;
}

function EtappeKlasseFilter({ klasseFacets, klasseSel, setKlasseSel, toggleKlasse, totalCount }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    if (!qq) return klasseFacets;
    return klasseFacets.filter((f) => f.code.toLowerCase().includes(qq) || f.name.toLowerCase().includes(qq));
  }, [klasseFacets, q]);

  const selSet = new Set(klasseSel);
  const selectedCount = klasseSel.length;
  const summary = selectedCount === 0
    ? `Alle klasser · ${totalCount.toLocaleString("no")} løp`
    : selectedCount === 1
      ? klasseFacets.find((f) => f.id === klasseSel[0])?.name || "1 klasse"
      : `${selectedCount} klasser valgt`;

  return html`
    <div ref=${ref} style=${{ position: "relative", display: "flex", flexDirection: "column", gap: "6px" }}>
      <button
        className=${selectedCount > 0 ? "primary" : ""}
        onClick=${() => setOpen((o) => !o)}
        style=${{ height: "32px", padding: "0 12px", display: "inline-flex", alignItems: "center", gap: "8px", fontSize: "12px", justifyContent: "space-between", width: "100%" }}
      >
        <span style=${{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>${summary}</span>
        <span style=${{ fontSize: "10px", opacity: 0.7 }}>▼</span>
      </button>
      ${selectedCount > 0 ? html`
        <button className="subtle danger" onClick=${() => setKlasseSel([])} style=${{ height: "26px", padding: "0 10px", fontSize: "11px", alignSelf: "flex-start" }}>Tøm valg</button>
      ` : null}
      ${open ? html`
        <div style=${{ position: "absolute", top: "calc(100% + 4px)", left: 0, width: "100%", maxHeight: "420px", display: "flex", flexDirection: "column", background: "var(--panel)", border: "1px solid var(--border-strong)", borderRadius: "5px", boxShadow: "var(--shadow)", zIndex: 30 }}>
          <div style=${{ padding: "8px 10px", borderBottom: "1px solid var(--border)" }}>
            <input type="text" placeholder="filtrer klasser…" value=${q} onInput=${(e) => setQ(e.target.value)} autoFocus style=${{ width: "100%", fontSize: "12px" }} />
          </div>
          <div style=${{ padding: "6px 10px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "11px", color: "var(--muted)" }}>
            <span>${filtered.length} klasser</span>
            <div style=${{ display: "flex", gap: "4px" }}>
              <button className="subtle" onClick=${() => setKlasseSel(filtered.map((f) => f.id))} style=${{ padding: "2px 8px", fontSize: "11px" }}>Velg synlige</button>
              <button className="subtle" onClick=${() => setKlasseSel([])} style=${{ padding: "2px 8px", fontSize: "11px" }}>Ingen</button>
            </div>
          </div>
          <div style=${{ overflow: "auto", flex: 1 }}>
            ${filtered.map((f) => html`
              <label
                key=${f.id}
                onClick=${(e) => { e.preventDefault(); toggleKlasse(f.id); }}
                style=${{
                  display: "grid",
                  gridTemplateColumns: "20px 50px 1fr 50px",
                  gap: "8px", alignItems: "center",
                  padding: "6px 10px", cursor: "pointer",
                  fontSize: "12px",
                  background: selSet.has(f.id) ? "rgba(244,207,58,0.08)" : "transparent",
                }}
              >
                <input type="checkbox" checked=${selSet.has(f.id)} readOnly />
                <span style=${{ fontFamily: "JetBrains Mono, monospace", fontWeight: 700, color: "var(--accent)" }}>${f.code}</span>
                <span style=${{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>${f.name.replace(/^[A-Z][A-Z0-9-]*\s*-?\s*/, "") || f.name}</span>
                <span style=${{ textAlign: "right", color: "var(--muted)", fontFamily: "JetBrains Mono, monospace", fontSize: "11px" }}>${f.n}</span>
              </label>
            `)}
          </div>
        </div>
      ` : null}
    </div>
  `;
}

function EtapperView({ db, splitsByTid, statsAllYears, setView, setSelected, setEtappePreselect }) {
  const { teams, meta, statsOverall } = db;
  const [etappe, setEtappe] = usePersistedState("hk:etapper:etappe", 7);
  const [klasseSel, setKlasseSel] = usePersistedState("hk:etapper:klasseSel", []);

  const rawEntries = useMemo(() => {
    const out = [];
    for (let tid = 0; tid < teams.length; tid++) {
      const t = teams[tid];
      const splits = splitsByTid.get(tid);
      if (!splits) continue;
      const s = splits.find((x) => x[1] === etappe);
      if (!s || s[2] == null) continue;
      out.push({ tid, year: t[1], split: s[2], runner: s[4] || "", team: t[3], klasse: t[5] });
    }
    out.sort((a, b) => a.split - b.split);
    return out;
  }, [etappe, splitsByTid, teams]);

  const klasseSet = useMemo(() => (klasseSel.length ? new Set(klasseSel) : null), [klasseSel]);
  const allEntries = useMemo(
    () => (klasseSet ? rawEntries.filter((e) => klasseSet.has(e.klasse)) : rawEntries),
    [rawEntries, klasseSet],
  );

  // Klasser available + counts for this etappe (built from rawEntries).
  const klasseFacets = useMemo(() => {
    const c = new Map();
    for (const e of rawEntries) c.set(e.klasse, (c.get(e.klasse) || 0) + 1);
    return [...c.entries()]
      .map(([id, n]) => ({ id, n, name: meta.klasser[id] || "(ukjent)", code: (meta.klasser[id] || "").split(" ")[0] || "—" }))
      .sort((a, b) => a.code.localeCompare(b.code, "no"));
  }, [rawEntries, meta.klasser]);

  const top10AllTime = allEntries.slice(0, 10);

  const fastestPerYear = useMemo(() => {
    const m = new Map();
    for (const e of allEntries) if (!m.has(e.year)) m.set(e.year, e);
    return [...m.values()].sort((a, b) => a.year - b.year);
  }, [allEntries]);

  const allTimeStats = useMemo(() => {
    if (!allEntries.length) return null;
    const sorted = allEntries.map((e) => e.split).sort((a, b) => a - b);
    return {
      n: sorted.length,
      min: sorted[0],
      median: sorted[Math.floor(sorted.length / 2)],
    };
  }, [allEntries]);

  const yearStats = useMemo(() => {
    if (!klasseSet) {
      return meta.years
        .map((y) => {
          const s = statsOverall[`${y}-${etappe}`];
          if (!s) return null;
          return { year: y, n: s.n, min: s.min, p10: s.p10, median: s.median, p90: s.p90, max: s.max };
        })
        .filter(Boolean);
    }
    // Recompute from filtered entries grouped by year.
    const byY = {};
    for (const e of allEntries) {
      (byY[e.year] = byY[e.year] || []).push(e.split);
    }
    return meta.years
      .map((y) => {
        const arr = byY[y];
        if (!arr || !arr.length) return null;
        arr.sort((a, b) => a - b);
        const pick = (p) => arr[Math.floor(arr.length * p)];
        return { year: y, n: arr.length, min: arr[0], p10: pick(0.1), median: pick(0.5), p90: pick(0.9), max: arr[arr.length - 1] };
      })
      .filter(Boolean);
  }, [klasseSet, meta.years, statsOverall, etappe, allEntries]);

  const histograms = useMemo(() => {
    if (!allEntries.length) return { bins: [] };
    const splits = allEntries.map((e) => e.split);
    const min = Math.min(...splits), max = Math.max(...splits);
    const NB = 24;
    const w = (max - min) / NB || 1;
    const yc = {};
    for (const y of meta.years) yc[y] = Array(NB).fill(0);
    for (const e of allEntries) {
      let idx = Math.floor((e.split - min) / w);
      if (idx < 0) idx = 0; if (idx >= NB) idx = NB - 1;
      if (yc[e.year]) yc[e.year][idx]++;
    }
    const bins = Array.from({ length: NB }, (_, i) => {
      const row = { bucket: min + (i + 0.5) * w };
      for (const y of meta.years) row[`y${y}`] = yc[y][i];
      return row;
    });
    return { bins };
  }, [meta.years, allEntries]);

  const toggleKlasse = (id) => {
    const s = new Set(klasseSel);
    s.has(id) ? s.delete(id) : s.add(id);
    setKlasseSel([...s]);
  };

  const dist = meta.etappe_distances[etappe];
  const profile = ETAPPE_PROFILES[etappe] || {};
  const cardColor = (year) => `var(--c-${year})`;

  return html`
    <${React.Fragment}>
    <div className="sidebar" style=${{ gap: "20px" }}>
      <div className="field">
        <label>Etappe</label>
        <div style=${{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: "4px" }}>
          ${[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15].map((e) => html`
            <button
              key=${e}
              onClick=${() => setEtappe(e)}
              style=${{
                height: "34px",
                padding: 0,
                border: etappe === e ? "1px solid var(--accent)" : "1px solid var(--border)",
                background: etappe === e ? "var(--accent)" : "var(--bg)",
                color: etappe === e ? "var(--bg)" : "var(--text)",
                fontWeight: etappe === e ? 700 : 500,
                fontSize: "13px",
                fontFamily: "JetBrains Mono, monospace",
                borderRadius: "4px",
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                lineHeight: 1,
              }}
            >${e}</button>
          `)}
        </div>
        <div style=${{ display: "flex", gap: "6px", marginTop: "8px" }}>
          <button onClick=${() => setEtappe(Math.max(1, etappe - 1))} disabled=${etappe === 1} style=${{ flex: 1, height: "28px", fontSize: "12px" }}>‹ forrige</button>
          <button onClick=${() => setEtappe(Math.min(15, etappe + 1))} disabled=${etappe === 15} style=${{ flex: 1, height: "28px", fontSize: "12px" }}>neste ›</button>
        </div>
      </div>
      <div className="field">
        <label>Profil</label>
        <span style=${{ height: "26px", display: "inline-flex", alignItems: "center", padding: "0 12px", background: "var(--bg)", border: "1px solid var(--border-strong)", borderRadius: "999px", fontSize: "11px", fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--accent-warm)", alignSelf: "flex-start" }}>
          ${profile.profil || "—"}
        </span>
        <div style=${{ color: "var(--muted)", fontStyle: "italic", fontSize: "12px", marginTop: "8px", lineHeight: 1.4 }}>${profile.karakter || ""}</div>
      </div>
      ${klasseFacets.length > 1 ? html`
        <div className="field">
          <label>Klasser</label>
          <${EtappeKlasseFilter} klasseFacets=${klasseFacets} klasseSel=${klasseSel} setKlasseSel=${setKlasseSel} toggleKlasse=${toggleKlasse} totalCount=${rawEntries.length} />
        </div>
      ` : null}
    </div>

    <div style=${{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "auto" }}>
      <div className="etapper-hero" style=${{ padding: "20px 28px 24px", borderBottom: "1px solid var(--border)", background: "linear-gradient(135deg, var(--panel) 0%, var(--bg-2) 100%)", position: "relative" }}>
        <div aria-hidden="true" style=${{ position: "absolute", right: 0, top: 0, bottom: 0, width: "320px", overflow: "hidden", pointerEvents: "none", zIndex: 0 }}>
          <div style=${{ position: "absolute", right: "-30px", top: "-60px", fontFamily: "Fraunces, serif", fontWeight: 900, fontSize: "320px", color: "rgba(244,207,58,0.05)", lineHeight: 0.8, userSelect: "none" }}>${etappe}</div>
        </div>
        <div style=${{ position: "relative", zIndex: 1 }}>
          <div className="kicker">Etappe ${etappe} · ${dist} m</div>
          <h2 style=${{ fontFamily: "Fraunces, serif", fontWeight: 700, fontSize: "44px", margin: "8px 0 0", letterSpacing: "-0.02em", lineHeight: 1.05 }}>
            ${ETAPPE_NAMES[etappe]?.split(" → ")[0] || ""} <em style=${{ color: "var(--accent)", fontWeight: 500, fontStyle: "italic" }}>→</em> ${ETAPPE_NAMES[etappe]?.split(" → ")[1] || ""}
          </h2>
          <div style=${{ color: "var(--muted)", fontStyle: "italic", fontSize: "14px", marginTop: "6px", marginBottom: "16px", maxWidth: "640px" }}>${profile.karakter || ""}</div>
          <div style=${{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "10px", marginTop: "20px" }}>
            <div style=${{ padding: "12px 16px", background: "rgba(244,207,58,0.06)", border: "1px solid var(--accent)", borderRadius: "5px" }}>
              <div className="kicker">Distanse</div>
              <div style=${{ fontFamily: "Fraunces, serif", fontWeight: 700, fontSize: "32px", lineHeight: 1, color: "var(--accent)" }}>${dist}<span style=${{ fontSize: "16px", color: "var(--muted)", marginLeft: "4px" }}>m</span></div>
            </div>
            ${allTimeStats ? html`
              <div style=${{ padding: "12px 16px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "5px" }}>
                <div className="kicker">All-time rekord</div>
                <div style=${{ fontFamily: "Fraunces, serif", fontWeight: 700, fontSize: "32px", lineHeight: 1 }}>${fmtTime(allTimeStats.min)}</div>
                <div style=${{ fontFamily: "JetBrains Mono, monospace", fontSize: "11px", color: "var(--muted)", marginTop: "4px" }}>${fmtPace(allTimeStats.min, dist)}</div>
              </div>
              <div style=${{ padding: "12px 16px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "5px" }}>
                <div className="kicker">Median</div>
                <div style=${{ fontFamily: "Fraunces, serif", fontWeight: 700, fontSize: "32px", lineHeight: 1 }}>${fmtTime(allTimeStats.median)}</div>
                <div style=${{ fontFamily: "JetBrains Mono, monospace", fontSize: "11px", color: "var(--muted)", marginTop: "4px" }}>${fmtPace(allTimeStats.median, dist)}</div>
              </div>
              <div style=${{ padding: "12px 16px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "5px" }}>
                <div className="kicker">Antall løp</div>
                <div style=${{ fontFamily: "Fraunces, serif", fontWeight: 700, fontSize: "32px", lineHeight: 1 }}>${allTimeStats.n.toLocaleString("no")}</div>
                <div style=${{ fontFamily: "JetBrains Mono, monospace", fontSize: "11px", color: "var(--muted)", marginTop: "4px" }}>over ${meta.years.length} år</div>
              </div>
            ` : null}
          </div>
          <button className="primary" style=${{ marginTop: "20px" }} onClick=${() => { setEtappePreselect && setEtappePreselect(etappe); setView("etappesok"); }}>Utforsk alle løp på etappe ${etappe} →</button>
        </div>
      </div>

      <div className="etapper-grid-2" style=${{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: "20px", padding: "20px 28px" }}>
        <div className="detail">
          <div className="kicker">All-time topp 10</div>
          <h2 style=${{ marginTop: "4px" }}>Raskeste <em style=${{ color: "var(--accent)" }}>noensinne</em></h2>
          <table className="etappes-table" style=${{ marginTop: "12px" }}>
            <thead>
              <tr>
                <th style=${{ width: "32px" }}>#</th>
                <th>Lag · løper</th>
                <th>År</th>
                <th className="right">Tid</th>
                <th className="right">Pace</th>
              </tr>
            </thead>
            <tbody>
              ${top10AllTime.map((e, i) => html`
                <tr key=${e.tid + "-" + i} onClick=${() => { setSelected(e.tid); setView("teams"); }} style=${{ cursor: "pointer" }}>
                  <td style=${{ fontFamily: "Fraunces, serif", fontWeight: 700, fontSize: "16px", color: i === 0 ? "var(--accent)" : "var(--muted)" }}>${i + 1}</td>
                  <td className="team-name">
                    <div style=${{ fontWeight: 500 }}>${e.team}</div>
                    <div style=${{ fontSize: "11px", color: "var(--muted)", fontFamily: "DM Sans, sans-serif" }}>${e.runner || "—"}</div>
                  </td>
                  <td><span className=${"chip year-" + e.year}>${e.year}</span></td>
                  <td className="right" style=${{ fontWeight: i === 0 ? 700 : 400, color: i === 0 ? "var(--accent)" : "var(--text)" }}>${fmtTime(e.split)}</td>
                  <td className="right muted" style=${{ fontSize: "11px" }}>${fmtPace(e.split, dist)}</td>
                </tr>
              `)}
            </tbody>
          </table>
        </div>

        <div className="detail">
          <div className="kicker">Per år · raskeste</div>
          <h2 style=${{ marginTop: "4px" }}>År for <em style=${{ color: "var(--accent)" }}>år</em></h2>
          <div style=${{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "12px" }}>
            ${fastestPerYear.map((e) => {
              const delta = allTimeStats ? e.split - allTimeStats.min : 0;
              const isRec = delta === 0;
              return html`
                <div key=${e.year} onClick=${() => { setSelected(e.tid); setView("teams"); }} style=${{ display: "grid", gridTemplateColumns: "60px 1fr auto auto", alignItems: "center", gap: "12px", padding: "10px 14px", background: "var(--bg)", border: "1px solid var(--border)", borderLeft: `3px solid ${cardColor(e.year)}`, borderRadius: "4px", cursor: "pointer" }}>
                  <span style=${{ fontFamily: "Fraunces, serif", fontWeight: 700, fontSize: "20px", color: cardColor(e.year) }}>${e.year}</span>
                  <div style=${{ overflow: "hidden" }}>
                    <div style=${{ fontWeight: 500, fontSize: "13px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>${e.team}</div>
                    <div style=${{ fontSize: "11px", color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>${e.runner || "—"}</div>
                  </div>
                  <span style=${{ fontFamily: "JetBrains Mono, monospace", fontWeight: 700, fontSize: "16px" }}>${fmtTime(e.split)}</span>
                  <span style=${{ fontFamily: "JetBrains Mono, monospace", fontSize: "11px", color: isRec ? "var(--accent)" : "var(--muted)", fontWeight: isRec ? 700 : 400, minWidth: "44px", textAlign: "right" }}>
                    ${isRec ? "REKORD" : `+${fmtTime(delta)}`}
                  </span>
                </div>
              `;
            })}
          </div>
        </div>
      </div>

      <div className="etapper-grid-2" style=${{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: "20px", padding: "0 28px 24px" }}>
        <div className="chart-wrap">
          <h3>Rekord + percentiler <em>per år</em></h3>
          <${ResponsiveContainer} width="100%" height=${300}>
            <${LineChart} data=${yearStats}>
              <${CartesianGrid} stroke="#2c261d" strokeDasharray="3 3" />
              <${XAxis} dataKey="year" stroke="#978a72" fontSize=${11} />
              <${YAxis} stroke="#978a72" fontSize=${11} tickFormatter=${(v) => fmtTime(v)} />
              <${Tooltip} formatter=${(v) => fmtTime(v)} contentStyle=${{ background: "#1a1610", border: "1px solid #3a3324", borderRadius: 4 }} />
              <${Legend} wrapperStyle=${{ fontSize: 11 }} />
              <${Line} type="monotone" dataKey="min" stroke="#6cc270" name="Rekord" strokeWidth=${2.5} dot=${{ r: 3 }} />
              <${Line} type="monotone" dataKey="p10" stroke="#5fa8d3" name="P10" strokeWidth=${1.5} dot=${false} />
              <${Line} type="monotone" dataKey="median" stroke="#f4cf3a" name="Median" strokeWidth=${2.5} dot=${{ r: 3 }} />
              <${Line} type="monotone" dataKey="p90" stroke="#d29922" name="P90" strokeWidth=${1.5} dot=${false} />
              <${Line} type="monotone" dataKey="max" stroke="#e4574a" name="Tregest" strokeWidth=${1.5} dot=${false} />
            <//>
          <//>
        </div>

        <div className="chart-wrap">
          <h3>Fordeling <em>over år</em> (stablet)</h3>
          <${ResponsiveContainer} width="100%" height=${300}>
            <${BarChart} data=${histograms.bins}>
              <${CartesianGrid} stroke="#2c261d" strokeDasharray="3 3" />
              <${XAxis} dataKey="bucket" stroke="#978a72" fontSize=${10} tickFormatter=${(v) => fmtTime(v)} />
              <${YAxis} stroke="#978a72" fontSize=${10} />
              <${Tooltip} formatter=${(v, n) => [`${v} løp`, n.replace("y", "")]} labelFormatter=${(l) => "ca. " + fmtTime(l)} contentStyle=${{ background: "#1a1610", border: "1px solid #3a3324", borderRadius: 4 }} />
              <${Legend} wrapperStyle=${{ fontSize: 11 }} />
              ${meta.years.map((y) => html`<${Bar} key=${y} dataKey=${`y${y}`} stackId="a" fill=${cardColor(y)} name=${String(y)} />`)}
            <//>
          <//>
        </div>
      </div>
    </div>
    <//>
  `;
}

function EtappeSokView({ db, splitsByTid, setSelected, setView, statsAllYears, compareTids, toggleCompare, etappePreselect, clearPreselect }) {
  const { teams, meta, statsOverall } = db;
  const compareSet = useMemo(() => new Set(compareTids), [compareTids]);
  const isMobile = useIsMobile();
  const [etappe, setEtappe] = usePersistedState("hk:etappesok:etappe", 7);
  useEffect(() => {
    if (etappePreselect != null) {
      setEtappe(etappePreselect);
      clearPreselect && clearPreselect();
    }
  }, [etappePreselect]);
  const [yearSel, setYearSel] = usePersistedState("hk:etappesok:yearSel", []);
  const [klasseSel, setKlasseSel] = usePersistedState("hk:etappesok:klasseSel", []);
  const [q, setQ] = useState("");
  const [klasseQ, setKlasseQ] = useState("");
  const [sortDesc, setSortDesc] = usePersistedState("hk:etappesok:sortDesc", false);

  const filteredKlasser = useMemo(() => {
    const qq = klasseQ.toLowerCase();
    return meta.klasser
      .map((k, i) => [k, i])
      .filter(([k]) => !qq || (k || "").toLowerCase().includes(qq));
  }, [klasseQ, meta.klasser]);

  // Build all (team, split) entries for current etappe.
  const entries = useMemo(() => {
    const yearSet = yearSel.length ? new Set(yearSel) : null;
    const klasseSet = klasseSel.length ? new Set(klasseSel) : null;
    const qq = q.trim().toLowerCase();
    const out = [];
    for (let tid = 0; tid < teams.length; tid++) {
      const t = teams[tid];
      if (yearSet && !yearSet.has(t[1])) continue;
      if (klasseSet && !klasseSet.has(t[5])) continue;
      const splits = splitsByTid.get(tid);
      if (!splits) continue;
      const s = splits.find((x) => x[1] === etappe);
      if (!s || s[2] == null) continue;
      const runner = s[4] || "";
      if (qq) {
        const hay = (t[3] + " " + t[4] + " " + runner + " " + t[2]).toLowerCase();
        if (!hay.includes(qq)) continue;
      }
      out.push({ tid, year: t[1], team: t[3], bedrift: t[4], klasse: t[5], split: s[2], total: s[3], runner });
    }
    out.sort((a, b) => (sortDesc ? b.split - a.split : a.split - b.split));
    return out;
  }, [teams, splitsByTid, etappe, yearSel, klasseSel, q, sortDesc]);

  const stat = useMemo(() => {
    // Combine across selected years for current etappe.
    const yearsToUse = yearSel.length ? yearSel : meta.years;
    const arr = [];
    for (const y of yearsToUse) {
      const s = statsOverall[`${y}-${etappe}`];
      if (s?.sorted) arr.push(...s.sorted);
    }
    arr.sort((a, b) => a - b);
    return arr;
  }, [yearSel, etappe, meta.years, statsOverall]);

  const Row = ({ index, style }) => {
    const r = entries[index];
    const pct = stat.length ? Math.round((index / entries.length) * 100) : null;
    return html`
      <div
        style=${style}
        className="table-row"
        onClick=${() => {
          setSelected(r.tid);
          setView("teams");
        }}
      >
        <div className="cell mono right">${index + 1}</div>
        <div className="cell mono"><span className=${"chip year-" + r.year}>${r.year}</span></div>
        <div className="cell">${r.team}</div>
        <div className="cell muted">${r.runner || "—"}</div>
        <div className="cell muted">${meta.klasser[r.klasse] || "—"}</div>
        <div className="cell mono right">${fmtTime(r.split)}</div>
        <div className="cell mono right">${fmtTime(r.total)}</div>
      </div>
    `;
  };

  const toggleYear = (y) => {
    const set = new Set(yearSel);
    set.has(y) ? set.delete(y) : set.add(y);
    setYearSel([...set]);
  };
  const toggleKlasse = (i) => {
    const set = new Set(klasseSel);
    set.has(i) ? set.delete(i) : set.add(i);
    setKlasseSel([...set]);
  };

  const etappeSelect = html`
    <select value=${etappe} onChange=${(e) => setEtappe(parseInt(e.target.value, 10))}>
      ${[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15].map((e) => html`<option key=${e} value=${e}>${e}: ${ETAPPE_NAMES[e]}</option>`)}
    </select>
  `;

  return html`
    <${React.Fragment}>
      <div className="sidebar">
        ${!isMobile ? html`
          <div className="field">
            <label>Etappe</label>
            ${etappeSelect}
            <div style=${{ fontSize: "12px", color: "var(--muted)", marginTop: "4px" }}>${meta.etappe_distances[etappe]} m</div>
          </div>
        ` : null}
        <div className="field">
          <label>År ${yearSel.length ? `(${yearSel.length})` : "(alle)"}</label>
          <div className="chips">
            ${meta.years.map(
              (y) => html`
                <button key=${y} className=${"subtle " + (yearSel.includes(y) ? "active" : "")} onClick=${() => toggleYear(y)}>${y}</button>
              `,
            )}
          </div>
        </div>
        <div className="field">
          <label>Søk</label>
          <input
            type="text"
            placeholder="lag, løper, bedrift, bib…"
            value=${q}
            onInput=${(e) => setQ(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Klasse ${klasseSel.length ? `(${klasseSel.length})` : "(alle)"}</label>
          <input type="text" placeholder="filtrer klasser…" value=${klasseQ} onInput=${(e) => setKlasseQ(e.target.value)} />
          <div className="filter-list">
            ${filteredKlasser.map(
              ([k, i]) => html`
                <label className="row" key=${i}>
                  <input type="checkbox" checked=${klasseSel.includes(i)} onChange=${() => toggleKlasse(i)} />
                  <span>${k || "(ukjent)"}</span>
                </label>
              `,
            )}
          </div>
        </div>
        <div className="field">
          <label>Sortering</label>
          <button className="subtle" onClick=${() => setSortDesc((s) => !s)}>${sortDesc ? "Tregest først" : "Raskest først"}</button>
        </div>
      </div>
      <div className="content" style=${{ padding: 0, display: "flex", flexDirection: "column" }}>
        ${isMobile ? html`
          <div
            className="field"
            style=${{
              margin: 0,
              padding: "10px 12px",
              background: "var(--bg-2)",
              borderBottom: "1px solid var(--border)",
              position: "sticky",
              top: 0,
              zIndex: 4,
              gap: "4px",
            }}
          >
            <label style=${{ margin: 0 }}>Etappe</label>
            ${etappeSelect}
          </div>
        ` : null}
        ${isMobile
          ? html`
              <div className="etappesok-summary-mobile">
                <div className="ess-meta">
                  ${meta.etappe_distances[etappe]} m · ${entries.length.toLocaleString("no")} løp · median ${stat.length ? fmtPace(stat[Math.floor(stat.length / 2)], meta.etappe_distances[etappe]) : "—"}
                </div>
                ${stat.length
                  ? html`
                      <div className="ess-stats">
                        <div className="ess-stat">
                          <div className="lbl">Raskest</div>
                          <div className="val">${fmtTime(stat[0])}</div>
                        </div>
                        <div className="ess-stat">
                          <div className="lbl">Median</div>
                          <div className="val">${fmtTime(stat[Math.floor(stat.length / 2)])}</div>
                        </div>
                        <div className="ess-stat">
                          <div className="lbl">Tregest</div>
                          <div className="val">${fmtTime(stat[stat.length - 1])}</div>
                        </div>
                        <div className="ess-stat">
                          <div className="lbl">Antall</div>
                          <div className="val">${stat.length.toLocaleString("no")}</div>
                        </div>
                      </div>
                    `
                  : null}
              </div>
            `
          : html`
              <div className="detail" style=${{ margin: "12px" }}>
                <h2>Etappe ${etappe} · ${ETAPPE_NAMES[etappe]}</h2>
                <div className="sub">${meta.etappe_distances[etappe]} m · ${entries.length.toLocaleString("no")} løp etappen i utvalget · median pace ${stat.length ? fmtPace(stat[Math.floor(stat.length / 2)], meta.etappe_distances[etappe]) : "—"}</div>
                ${stat.length
                  ? html`
                      <div className="grid">
                        <div className="stat" key="r">
                          <div className="label">Raskest</div>
                          <div className="value">${fmtTime(stat[0])}</div>
                        </div>
                        <div className="stat" key="m">
                          <div className="label">Median</div>
                          <div className="value">${fmtTime(stat[Math.floor(stat.length / 2)])}</div>
                        </div>
                        <div className="stat" key="t">
                          <div className="label">Tregest</div>
                          <div className="value">${fmtTime(stat[stat.length - 1])}</div>
                        </div>
                        <div className="stat" key="n">
                          <div className="label">Antall</div>
                          <div className="value">${stat.length.toLocaleString("no")}</div>
                        </div>
                      </div>
                    `
                  : null}
              </div>
            `}
        <div className="table-wrap" style=${{ flex: 1, minHeight: 0 }}>
          <div className="table-header" style=${{ gridTemplateColumns: "32px 50px 60px 1.6fr 1.2fr 1fr 80px 95px 80px 80px 80px", display: isMobile ? "none" : undefined }}>
            <div></div>
            <div className="right">#</div>
            <div>År</div>
            <div>Lag</div>
            <div>Løper</div>
            <div>Klasse</div>
            <div className="right">Tid</div>
            <div className="right">Pace</div>
            <div className="right">Pct år</div>
            <div className="right">Pct alle</div>
            <div className="right">Total ved start</div>
          </div>
          <div style=${{ flex: 1, minHeight: 0 }}>
            ${entries.length === 0
              ? html`<div className="empty">Ingen treff.</div>`
              : html`
                  <${AutoSizedList} itemCount=${entries.length} itemSize=${isMobile ? 96 : 38} Row=${(p) => {
                    const r = entries[p.index];
                    const dist = meta.etappe_distances[etappe];
                    const yearArr = statsOverall[`${r.year}-${etappe}`]?.sorted;
                    const pctYear = yearArr ? percentileOf(yearArr, r.split) : null;
                    const allArr = statsAllYears?.[etappe];
                    const pctAll = allArr ? percentileOf(allArr, r.split) : null;
                    const isComp = compareSet.has(r.tid);
                    if (isMobile) {
                      const klasseCode = (meta.klasser[r.klasse] || "").split(" ")[0] || "";
                      return html`
                        <div
                          style=${{ ...p.style, display: "grid", gridTemplateColumns: "26px 1fr auto", gap: "10px", padding: "10px 12px", alignItems: "start", borderBottom: "1px solid var(--border)", cursor: "pointer", boxSizing: "border-box" }}
                          className=${isComp ? "table-row compared" : "table-row"}
                          onClick=${() => { setSelected(r.tid); setView("teams"); }}
                        >
                          <div style=${{ paddingTop: "2px" }} onClick=${(e) => { e.stopPropagation(); toggleCompare(r.tid); }}>
                            <span className=${"compare-toggle" + (isComp ? " on" : "")}>${isComp ? "✓" : "+"}</span>
                          </div>
                          <div style=${{ minWidth: 0, display: "flex", flexDirection: "column", gap: "3px" }}>
                            <div style=${{ display: "flex", alignItems: "center", gap: "6px" }}>
                              <span style=${{ fontFamily: "JetBrains Mono, monospace", fontWeight: 700, fontSize: "12px", color: "var(--muted)" }}>#${p.index + 1}</span>
                              <span style=${{ fontSize: "14px", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>${r.team}</span>
                            </div>
                            <div style=${{ fontSize: "12.5px", color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              ${r.runner || html`<span style=${{ color: "var(--muted)", fontStyle: "italic" }}>(ukjent løper)</span>`}
                            </div>
                            <div style=${{ display: "flex", gap: "6px", alignItems: "center", fontSize: "11px", color: "var(--muted)", overflow: "hidden" }}>
                              <span className=${"chip year-" + r.year} style=${{ fontSize: "10px", height: "16px", padding: "0 6px" }}>${r.year}</span>
                              ${klasseCode ? html`<span style=${{ fontFamily: "JetBrains Mono, monospace" }}>${klasseCode}</span>` : null}
                              <span style=${{ fontFamily: "JetBrains Mono, monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>· ${fmtPace(r.split, dist)}</span>
                            </div>
                          </div>
                          <div style=${{ textAlign: "right", flexShrink: 0, display: "flex", flexDirection: "column", gap: "4px", alignItems: "flex-end" }}>
                            <div style=${{ fontFamily: "JetBrains Mono, monospace", fontWeight: 700, fontSize: "16px", lineHeight: 1 }}>${fmtTime(r.split)}</div>
                            ${pctYear != null ? html`<span className=${"percent-pill " + pillClass(pctYear)} style=${{ fontSize: "10px" }}>${pctYear}% år</span>` : null}
                            ${pctAll != null ? html`<span className=${"percent-pill " + pillClass(pctAll)} style=${{ fontSize: "10px" }}>${pctAll}% alle</span>` : null}
                          </div>
                        </div>
                      `;
                    }
                    return html`
                      <div
                        style=${{ ...p.style, display: "grid", gridTemplateColumns: "32px 50px 60px 1.6fr 1.2fr 1fr 80px 95px 80px 80px 80px", gap: "8px", padding: "0 12px", alignItems: "center", borderBottom: "1px solid var(--border)", cursor: "pointer" }}
                        className=${isComp ? "table-row compared" : "table-row"}
                        onClick=${() => {
                          setSelected(r.tid);
                          setView("teams");
                        }}
                      >
                        <div className="cell" onClick=${(e) => { e.stopPropagation(); toggleCompare(r.tid); }}>
                          <span className=${"compare-toggle" + (isComp ? " on" : "")}>${isComp ? "✓" : "+"}</span>
                        </div>
                        <div className="cell mono right">${p.index + 1}</div>
                        <div className="cell mono"><span className=${"chip year-" + r.year}>${r.year}</span></div>
                        <div className="cell">${r.team}</div>
                        <div className="cell muted">${r.runner || "—"}</div>
                        <div className="cell muted" style=${{ fontSize: "12px" }}>${meta.klasser[r.klasse] || "—"}</div>
                        <div className="cell mono right">${fmtTime(r.split)}</div>
                        <div className="cell mono right muted">${fmtPace(r.split, dist)}</div>
                        <div className="cell right">${pctYear != null ? html`<span className=${"percent-pill " + pillClass(pctYear)}>${pctYear}%</span>` : "—"}</div>
                        <div className="cell right">${pctAll != null ? html`<span className=${"percent-pill " + pillClass(pctAll)}>${pctAll}%</span>` : "—"}</div>
                        <div className="cell mono right muted">${fmtTime(r.total - r.split)}</div>
                      </div>
                    `;
                  }} />
                `}
          </div>
        </div>
      </div>
    <//>
  `;
}

function ClasseFilterChips({ klasser, klasseSel, toggleK }) {
  const [showAll, setShowAll] = useState(false);
  const sel = new Set(klasseSel);
  return html`
    <div style=${{ display: "flex", gap: "4px", alignItems: "center", flexWrap: "wrap" }}>
      <span style=${{ fontSize: "10px", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 700 }}>Klasse:</span>
      ${klasser.map((k, i) => {
        if (!k) return null;
        const code = k.split(" ")[0];
        const isOn = sel.has(i);
        if (!showAll && !isOn && klasseSel.length === 0 && i > 0 && code !== "B1" && code !== "B2" && code !== "F1" && code !== "F6" && code !== "A1" && code !== "A2" && code !== "S1" && code !== "S2") return null;
        return html`
          <button
            key=${i}
            className=${"subtle " + (isOn ? "active" : "")}
            onMouseDown=${(e) => { e.preventDefault(); toggleK(i); }}
            title=${k}
          >${code}</button>
        `;
      })}
      <button
        className="subtle"
        style=${{ fontSize: "10px" }}
        onMouseDown=${(e) => { e.preventDefault(); setShowAll((s) => !s); }}
      >${showAll ? "−" : "alle…"}</button>
      ${klasseSel.length ? html`<button className="subtle danger" onMouseDown=${(e) => { e.preventDefault(); klasseSel.forEach(toggleK); }}>×</button>` : null}
    </div>
  `;
}

function TeamChipList({ items, toggleCompare }) {
  const isMobile = useIsMobile();
  const [expanded, setExpanded] = useState(false);

  if (isMobile && !expanded && items.length > 0) {
    return html`
      <div
        className="compare-team-list compact"
        onClick=${() => setExpanded(true)}
        role="button"
      >
        <div className="compact-summary">
          <span className="compact-count">${items.length} lag valgt</span>
          <div className="compact-swatches">
            ${items.slice(0, 10).map(
              (it) => html`
                <span
                  key=${it.key}
                  className="swatch-dot"
                  style=${{ background: it.color }}
                  title=${`${it.team[3]} · ${it.team[1]}`}
                ></span>
              `,
            )}
            ${items.length > 10
              ? html`<span className="compact-more">+${items.length - 10}</span>`
              : null}
          </div>
        </div>
        <span className="compact-chevron">▾</span>
      </div>
    `;
  }

  const desktopLimit = 16;
  const visible = isMobile || expanded ? items : items.slice(0, desktopLimit);
  const hiddenCount = items.length - visible.length;

  return html`
    <div className="compare-team-list">
      ${isMobile
        ? html`<button
            className="subtle compact-collapse"
            onClick=${() => setExpanded(false)}
          >− Skjul</button>`
        : null}
      ${visible.map(
        (it) => html`
          <div className="compare-team-card" key=${it.key} style=${{ "--swatch": it.color }}>
            <span className="swatch" style=${{ background: it.color }}></span>
            <span className="name">${it.team[3]}</span>
            <span className="y">${it.team[1]} · ${fmtTime(it.team[6])}</span>
            <span className="x" onClick=${() => toggleCompare(it.tid)}>✕</span>
          </div>
        `,
      )}
      ${hiddenCount > 0
        ? html`<button className="subtle" onClick=${() => setExpanded(true)}>+ ${hiddenCount} flere</button>`
        : !isMobile && items.length > desktopLimit
          ? html`<button className="subtle" onClick=${() => setExpanded(false)}>Skjul</button>`
          : null}
    </div>
  `;
}

function AddTeamSearch({ db, splitsByTid, compareTids, toggleCompare }) {
  const { teams, meta } = db;
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [yearSel, setYearSel] = useState([]);
  const [klasseSel, setKlasseSel] = useState([]);
  const compareSet = useMemo(() => new Set(compareTids), [compareTids]);
  const isMobile = useIsMobile();

  // Match returns flat list of tids first, then we group by normalized name.
  const { flatTids, groups } = useMemo(() => {
    const qq = q.trim().toLowerCase();
    const hasFilters = qq.length >= 2 || yearSel.length > 0 || klasseSel.length > 0;
    if (!hasFilters) return { flatTids: [], groups: [] };
    const yearSet = yearSel.length ? new Set(yearSel) : null;
    const klasseSet = klasseSel.length ? new Set(klasseSel) : null;
    const flat = [];
    for (let tid = 0; tid < teams.length; tid++) {
      const t = teams[tid];
      if (yearSet && !yearSet.has(t[1])) continue;
      if (klasseSet && !klasseSet.has(t[5])) continue;
      if (qq) {
        const splits = splitsByTid.get(tid) || [];
        const runners = splits.map((s) => s[4]).filter(Boolean).join(" ");
        const hay = (t[3] + " " + t[4] + " " + t[2] + " " + runners).toLowerCase();
        if (!hay.includes(qq)) continue;
      }
      flat.push(tid);
      if (flat.length >= 5000) break;
    }
    // Group by normalized name.
    const groupMap = new Map();
    for (const tid of flat) {
      const t = teams[tid];
      const norm = normalizeName(t[3]) || `__${tid}`;
      let g = groupMap.get(norm);
      if (!g) {
        g = { key: norm, name: t[3], tids: [] };
        groupMap.set(norm, g);
      }
      g.tids.push(tid);
    }
    // Sort groups: most years first.
    const groupArr = [...groupMap.values()].sort((a, b) => b.tids.length - a.tids.length);
    return { flatTids: flat, groups: groupArr };
  }, [q, teams, splitsByTid, yearSel, klasseSel]);

  const toggleY = (y) => {
    const s = new Set(yearSel);
    s.has(y) ? s.delete(y) : s.add(y);
    setYearSel([...s]);
  };
  const toggleK = (k) => {
    const s = new Set(klasseSel);
    s.has(k) ? s.delete(k) : s.add(k);
    setKlasseSel([...s]);
  };

  const addAll = () => {
    if (flatTids.length === 0) return;
    for (const tid of flatTids) {
      if (!compareSet.has(tid)) toggleCompare(tid);
    }
    setQ("");
    setOpen(false);
  };

  const addGroup = (g) => {
    for (const tid of g.tids) {
      if (!compareSet.has(tid)) toggleCompare(tid);
    }
  };

  return html`
    <div className="add-team-search" style=${{ width: isMobile ? "100%" : "auto", flex: isMobile ? "1 1 0" : undefined, minWidth: 0 }}>
      <span className="ats-icon" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="7" cy="7" r="5"/>
          <line x1="10.6" y1="10.6" x2="14" y2="14"/>
        </svg>
      </span>
      <input
        type="text"
        placeholder=${isMobile ? "Søk og legg til lag…" : "Søk og legg til (Enter = legg til alle treff)…"}
        value=${q}
        onInput=${(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus=${() => setOpen(true)}
        onBlur=${() => setTimeout(() => setOpen(false), 200)}
        onKeyDown=${(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            addAll();
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        style=${{ width: isMobile ? "100%" : "360px" }}
      />
      ${q
        ? html`<button
            type="button"
            className="ats-clear"
            onMouseDown=${(e) => { e.preventDefault(); setQ(""); }}
            aria-label="Tøm søk"
          >✕</button>`
        : null}
      ${open && (flatTids.length > 0 || q.length >= 2 || yearSel.length || klasseSel.length)
        ? html`
            <div style=${{
              position: "absolute",
              top: "calc(100% + 4px)",
              left: isMobile ? "0" : "auto",
              right: isMobile ? "0" : 0,
              width: isMobile ? "auto" : "min(720px, calc(100vw - 60px))",
              maxHeight: isMobile ? "60vh" : "520px",
              overflow: "auto",
              background: "var(--panel)",
              border: "1px solid var(--border-strong)",
              borderRadius: "4px",
              boxShadow: "var(--shadow)",
              zIndex: 60,
              WebkitOverflowScrolling: "touch",
            }}>
              <div style=${{ padding: "8px 12px", borderBottom: "1px solid var(--border-strong)", background: "var(--bg-2)", display: "flex", flexDirection: "column", gap: "8px" }}>
                <div style=${{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "12px" }}>
                  <span style=${{ color: "var(--muted)", fontFamily: "JetBrains Mono, monospace" }}>
                    ${flatTids.length} treff · ${groups.length} unike lag
                  </span>
                  <button
                    className=${flatTids.length > 0 ? "primary subtle" : "subtle"}
                    disabled=${flatTids.length === 0}
                    onMouseDown=${(e) => { e.preventDefault(); addAll(); }}
                    style=${{ fontSize: "11px" }}
                  >
                    + Legg til alle ${flatTids.length}
                  </button>
                </div>
                <div style=${{ display: "flex", gap: "4px", alignItems: "center", flexWrap: "wrap" }}>
                  <span style=${{ fontSize: "10px", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 700 }}>År:</span>
                  ${meta.years.map((y) => html`
                    <button
                      key=${y}
                      className=${"subtle " + (yearSel.includes(y) ? "active" : "")}
                      onMouseDown=${(e) => { e.preventDefault(); toggleY(y); }}
                    >${y}</button>
                  `)}
                  ${yearSel.length ? html`<button className="subtle danger" onMouseDown=${(e) => { e.preventDefault(); setYearSel([]); }}>×</button>` : null}
                </div>
                <${ClasseFilterChips} klasser=${meta.klasser} klasseSel=${klasseSel} toggleK=${toggleK} />
              </div>
              ${groups.length === 0
                ? html`<div style=${{ padding: "16px", color: "var(--muted)", fontStyle: "italic" }}>Ingen treff</div>`
                : groups.map((g) => {
                    const allInComp = g.tids.every((t) => compareSet.has(t));
                    const someInComp = g.tids.some((t) => compareSet.has(t));
                    return html`
                      <div
                        key=${g.key}
                        onMouseDown=${(e) => { e.preventDefault(); addGroup(g); }}
                        style=${{
                          padding: "8px 12px",
                          borderBottom: "1px solid var(--border)",
                          cursor: "pointer",
                          display: "grid",
                          gridTemplateColumns: isMobile ? "1fr 30px" : "1fr auto 30px",
                          gap: "10px",
                          alignItems: "center",
                          fontSize: "13px",
                          background: allInComp ? "rgba(108,194,112,0.10)" : someInComp ? "rgba(244,207,58,0.06)" : "transparent",
                        }}
                      >
                        <div style=${{ display: "flex", flexDirection: "column", gap: "4px", overflow: "hidden", minWidth: 0 }}>
                          <span style=${{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>${g.name}</span>
                          <span style=${{ color: "var(--muted)", fontSize: "11px", fontFamily: "JetBrains Mono, monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            ${g.tids.map((tid) => {
                              const t = teams[tid];
                              const splits = splitsByTid.get(tid) || [];
                              const qq = q.toLowerCase();
                              const matchedRunner = splits.find((s) => s[4]?.toLowerCase().includes(qq));
                              return matchedRunner ? `${t[1]}: ${matchedRunner[4]} (e${matchedRunner[1]})` : `${t[1]} · ${meta.klasser[t[5]] || ""}`;
                            }).join(" · ")}
                          </span>
                          ${isMobile ? html`
                            <div className="chips" style=${{ flexWrap: "wrap", marginTop: "2px" }}>
                              ${g.tids.slice(0, 6).map((tid) => {
                                const t = teams[tid];
                                const isC = compareSet.has(tid);
                                return html`
                                  <span
                                    key=${tid}
                                    className=${"chip year-" + t[1]}
                                    onMouseDown=${(e) => { e.preventDefault(); e.stopPropagation(); toggleCompare(tid); }}
                                    style=${{ cursor: "pointer", opacity: isC ? 1 : 0.55, fontWeight: isC ? 700 : 400 }}
                                    title=${`${t[3]} (${t[1]}) — ${fmtTime(t[6])}`}
                                  >
                                    ${t[1]}${isC ? " ✓" : ""}
                                  </span>
                                `;
                              })}
                              ${g.tids.length > 6
                                ? html`<span className="chip" style=${{ color: "var(--muted)" }}>+${g.tids.length - 6}</span>`
                                : null}
                            </div>
                          ` : null}
                        </div>
                        ${!isMobile ? html`
                          <div className="chips" style=${{ maxWidth: "240px", flexWrap: "wrap", justifyContent: "flex-end" }}>
                            ${g.tids.slice(0, 6).map((tid) => {
                              const t = teams[tid];
                              const isC = compareSet.has(tid);
                              return html`
                                <span
                                  key=${tid}
                                  className=${"chip year-" + t[1]}
                                  onMouseDown=${(e) => { e.preventDefault(); e.stopPropagation(); toggleCompare(tid); }}
                                  style=${{ cursor: "pointer", opacity: isC ? 1 : 0.55, fontWeight: isC ? 700 : 400 }}
                                  title=${`${t[3]} (${t[1]}) — ${fmtTime(t[6])}`}
                                >
                                  ${t[1]}${isC ? " ✓" : ""}
                                </span>
                              `;
                            })}
                            ${g.tids.length > 6
                              ? html`<span className="chip" style=${{ color: "var(--muted)" }}>+${g.tids.length - 6}</span>`
                              : null}
                          </div>
                        ` : null}
                        <span className=${"compare-toggle" + (allInComp ? " on" : "")}>${allInComp ? "✓" : "+"}</span>
                      </div>
                    `;
                  })}
            </div>
          `
        : null}
    </div>
  `;
}

function MapView({ db, statsAllYears, splitsByTid, setView, setSelected, setEtappePreselect }) {
  const { meta } = db;
  const coords = meta.etappe_coords || [];
  const [activeEt, setActiveEt] = useState(null);
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const segLayerRef = useRef(null);
  const markersRef = useRef([]);

  // Initialize map once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, {
      zoomControl: true,
      preferCanvas: true,
    });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap",
      maxZoom: 19,
    }).addTo(map);

    const latlngs = coords.map((c) => [c.lat, c.lon]);
    if (latlngs.length) {
      map.fitBounds(latlngs, { padding: [40, 40] });
    }

    // Full route polyline
    L.polyline(latlngs, {
      color: "#5e5444",
      weight: 4,
      opacity: 0.55,
    }).addTo(map);

    // Markers
    coords.forEach((c, i) => {
      const isStart = i === 0;
      const isFinish = i === coords.length - 1;
      const cls = isStart ? "etappe-marker start" : isFinish ? "etappe-marker finish" : "etappe-marker";
      const label = isStart ? "S" : isFinish ? "M" : String(i);
      const icon = L.divIcon({
        className: "",
        iconSize: [28, 28],
        iconAnchor: [14, 14],
        html: `<div class="${cls}" data-idx="${i}">${label}</div>`,
      });
      const m = L.marker([c.lat, c.lon], { icon });
      m.bindTooltip(c.navn, { direction: "top", offset: [0, -14] });
      m.on("click", () => {
        // Etappe number = i (i=0 is start, i=1 is end of etappe 1, etc.)
        setActiveEt(i === 0 ? 1 : i);
      });
      m.addTo(map);
      markersRef.current.push(m);
    });

    mapRef.current = map;
    // Resize observer to keep tiles aligned when sidebar opens.
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(containerRef.current);
    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      markersRef.current = [];
    };
  }, [coords]);

  // Highlight selected etappe segment
  useEffect(() => {
    if (!mapRef.current) return;
    if (segLayerRef.current) {
      mapRef.current.removeLayer(segLayerRef.current);
      segLayerRef.current = null;
    }
    if (activeEt == null) return;
    const a = coords[activeEt - 1];
    const b = coords[activeEt];
    if (!a || !b) return;
    segLayerRef.current = L.polyline(
      [
        [a.lat, a.lon],
        [b.lat, b.lon],
      ],
      { color: "#f4cf3a", weight: 7, opacity: 0.95 },
    ).addTo(mapRef.current);
    mapRef.current.fitBounds(
      [
        [a.lat, a.lon],
        [b.lat, b.lon],
      ],
      { padding: [80, 80], maxZoom: 16 },
    );
  }, [activeEt, coords]);

  // Selected etappe quick stats per year
  const stats = useMemo(() => {
    if (activeEt == null) return null;
    const out = [];
    for (const y of meta.years) {
      const s = db.statsOverall[`${y}-${activeEt}`];
      if (s) out.push({ y, n: s.n, min: s.min, median: s.median, max: s.max });
    }
    const all = statsAllYears?.[activeEt] || [];
    return {
      perYear: out,
      allTime: all.length ? { n: all.length, min: all[0], median: all[Math.floor(all.length / 2)], max: all[all.length - 1] } : null,
    };
  }, [activeEt, meta.years, db.statsOverall, statsAllYears]);

  return html`
    <div className="map-view" style=${{ display: "flex", flexDirection: "row" }}>
      <div className="map-side">
        <div className="kicker">Holmenkollstafetten · 18.5 km</div>
        <h2 style=${{ fontFamily: "Fraunces, serif", fontWeight: 700, fontSize: "20px", margin: "4px 0 14px", letterSpacing: "-0.01em" }}>
          Ruta <em style=${{ color: "var(--accent)" }}>etappe for etappe</em>
        </h2>
        <div className="etappe-row" onClick=${() => setActiveEt(null)} style=${activeEt == null ? { background: "var(--panel)", borderLeft: "3px solid var(--accent)" } : {}}>
          <div className="num" style=${{ color: "var(--muted)" }}>•</div>
          <div className="info"><div className="name">Hele løypa</div><div className="desc">15 etapper · 16 målestasjoner</div></div>
          <div className="dist">18,5 km</div>
        </div>
        ${[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15].map((e) => {
          const a = coords[e - 1], b = coords[e];
          if (!a || !b) return null;
          return html`
            <div
              key=${e}
              className=${"etappe-row" + (activeEt === e ? " active" : "")}
              onClick=${() => setActiveEt(e)}
            >
              <div className="num">${e}</div>
              <div className="info">
                <div className="name">${a.navn} → ${b.navn}</div>
                <div className="desc">${ETAPPE_NAMES[e] || ""}</div>
              </div>
              <div className="dist">${meta.etappe_distances[e]} m</div>
            </div>
          `;
        })}
      </div>
      <div style=${{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <div ref=${containerRef} className="map-canvas"></div>
        ${activeEt != null && stats
          ? html`
              <div style=${{ padding: "20px 24px", borderTop: "1px solid var(--border)", background: "linear-gradient(to bottom, var(--bg-2), var(--bg))" }}>
                <div style=${{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: "16px" }}>
                  <div>
                    <div className="kicker">Etappe ${activeEt} · ${ETAPPE_NAMES[activeEt] || ""}</div>
                    <h2 style=${{ fontFamily: "Fraunces, serif", fontWeight: 700, fontSize: "26px", margin: "4px 0 0", letterSpacing: "-0.01em" }}>
                      ${meta.etappe_distances[activeEt]} m <em style=${{ color: "var(--accent)", fontStyle: "italic", fontWeight: 500 }}>raskeste tider</em>
                    </h2>
                  </div>
                  <button
                    className="primary"
                    onClick=${() => { setEtappePreselect && setEtappePreselect(activeEt); setView("etappesok"); }}
                  >
                    Vis alle løp på etappe ${activeEt} →
                  </button>
                </div>
                ${stats.allTime
                  ? html`
                      <div style=${{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "12px" }}>
                        <div style=${{
                          display: "grid",
                          gridTemplateColumns: "auto 1fr auto auto",
                          gap: "16px",
                          alignItems: "center",
                          padding: "14px 18px",
                          background: "var(--panel)",
                          border: "1px solid var(--border-strong)",
                          borderLeft: "4px solid var(--accent)",
                          borderRadius: "5px",
                        }}>
                          <div style=${{ fontFamily: "Fraunces, serif", fontStyle: "italic", fontWeight: 700, fontSize: "13px", color: "var(--accent)", letterSpacing: "0.05em", textTransform: "uppercase" }}>Rekord</div>
                          <div style=${{ fontFamily: "Fraunces, serif", fontWeight: 700, fontSize: "30px", letterSpacing: "-0.01em" }}>
                            ${fmtTime(stats.allTime.min)}
                          </div>
                          <div style=${{ fontFamily: "JetBrains Mono, monospace", fontSize: "11px", color: "var(--muted)", textAlign: "right" }}>
                            <div>Median ${fmtTime(stats.allTime.median)}</div>
                            <div style=${{ marginTop: "2px" }}>P10 / P90 spread</div>
                          </div>
                          <div style=${{ fontFamily: "JetBrains Mono, monospace", fontSize: "11px", color: "var(--muted)", textAlign: "right" }}>
                            ${stats.allTime.n.toLocaleString("no")} løp
                          </div>
                        </div>
                      </div>
                    `
                  : null}
                <div style=${{
                  display: "grid",
                  gridTemplateColumns: `repeat(${stats.perYear.length}, 1fr)`,
                  gap: "8px",
                }}>
                  ${stats.perYear.map((s) => {
                    const recordDelta = stats.allTime ? s.min - stats.allTime.min : 0;
                    const isRecordYear = stats.allTime && s.min === stats.allTime.min;
                    return html`
                      <div key=${s.y} style=${{
                        padding: "10px 14px",
                        background: "var(--bg-2)",
                        border: "1px solid var(--border)",
                        borderLeft: `3px solid var(--c-${s.y})`,
                        borderRadius: "4px",
                        position: "relative",
                      }}>
                        <div style=${{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                          <span style=${{ fontFamily: "Fraunces, serif", fontWeight: 700, fontSize: "16px", color: `var(--c-${s.y})` }}>${s.y}</span>
                          ${isRecordYear ? html`<span style=${{ fontSize: "9px", letterSpacing: "0.1em", color: "var(--accent)", fontWeight: 700, textTransform: "uppercase" }}>Rekord</span>` : null}
                        </div>
                        <div style=${{ fontFamily: "JetBrains Mono, monospace", fontSize: "20px", fontWeight: 700, marginTop: "4px", lineHeight: 1 }}>
                          ${fmtTime(s.min)}
                        </div>
                        <div style=${{ fontFamily: "JetBrains Mono, monospace", fontSize: "10px", color: "var(--muted)", marginTop: "6px" }}>
                          ${recordDelta > 0 ? `+${fmtTime(recordDelta)}` : "—"} vs rekord
                        </div>
                        <div style=${{ fontFamily: "JetBrains Mono, monospace", fontSize: "10px", color: "var(--muted)", marginTop: "1px" }}>
                          median ${fmtTime(s.median)} · ${s.n} løp
                        </div>
                      </div>
                    `;
                  })}
                </div>
              </div>
            `
          : null}
      </div>
    </div>
  `;
}

function RecentComparesPanel({ title, recents, teams, restoreCompare, removeRecentCompare, compact }) {
  if (!recents || recents.length === 0) return null;
  return html`
    <div className=${"recent-compares" + (compact ? " compact" : "")}>
      <div className="rc-title">${title}</div>
      <div className="rc-list">
        ${recents.map((s) => {
          const previewNames = s.tids.slice(0, 3).map((tid) => teams[tid]?.[3]).filter(Boolean);
          const yearChips = s.tids
            .map((tid) => teams[tid]?.[1])
            .filter((y) => y != null);
          const uniqYears = [...new Set(yearChips)].sort();
          return html`
            <div className="rc-card" key=${s.ts}>
              <button
                className="rc-restore"
                onClick=${() => restoreCompare(s.tids)}
                title="Last inn denne sammenligningen"
              >
                <div className="rc-count">${s.tids.length} lag</div>
                <div className="rc-summary">
                  ${previewNames.join(" · ")}${s.tids.length > 3 ? ` +${s.tids.length - 3}` : ""}
                </div>
                <div className="rc-years">
                  ${uniqYears.map((y) => html`<span key=${y} className=${"chip year-" + y}>${y}</span>`)}
                </div>
              </button>
              <button
                className="rc-remove"
                onClick=${(e) => { e.stopPropagation(); removeRecentCompare(s.ts); }}
                title="Fjern fra historikken"
              >✕</button>
            </div>
          `;
        })}
      </div>
    </div>
  `;
}

function CompareView({ db, splitsByTid, compareTids, toggleCompare, clearCompare, cumIndex, statsAllYears, setSelected, setView, recentCompares, restoreCompare, removeRecentCompare }) {
  const { teams, meta } = db;
  const isMobile = useIsMobile();
  const otherRecents = useMemo(() => {
    const cur = [...compareTids].sort((a, b) => a - b).join(",");
    return (recentCompares || []).filter(
      (s) => [...s.tids].sort((a, b) => a - b).join(",") !== cur,
    );
  }, [recentCompares, compareTids]);
  const items = compareTids.map((tid, i) => ({
    tid,
    team: teams[tid],
    splits: splitsByTid.get(tid) || [],
    color: colorForCompareIdx(i),
    key: `t${tid}`,
  }));

  // Build per-etappe data with one column per team for splits + cumulative.
  const splitData = useMemo(() => {
    const rows = [];
    for (let e = 1; e <= 15; e++) {
      const r = { etappe: e };
      for (const it of items) {
        const s = it.splits.find((x) => x[1] === e);
        r[it.key] = s?.[2] ?? null;
        r[it.key + "_cum"] = s?.[3] ?? null;
      }
      rows.push(r);
    }
    return rows;
  }, [items]);

  // For each etappe, find the selected team with the fastest split.
  const dreamLineup = useMemo(() => {
    const out = [];
    for (let e = 1; e <= 15; e++) {
      let best = null;
      for (const it of items) {
        const s = it.splits.find((x) => x[1] === e);
        if (!s || s[2] == null) continue;
        if (!best || s[2] < best.split) {
          best = { etappe: e, item: it, split: s[2], runner: s[4] || "" };
        }
      }
      out.push(best || { etappe: e, item: null, split: null, runner: "" });
    }
    return out;
  }, [items]);

  const dreamComplete = dreamLineup.every((b) => b.split != null);
  const dreamTotal = dreamLineup.reduce((sum, b) => sum + (b.split || 0), 0);
  const actualBestTotal = useMemo(() => {
    const totals = items.map((it) => it.team[6]).filter((t) => t != null);
    return totals.length ? Math.min(...totals) : null;
  }, [items]);

  const winsByTeam = useMemo(() => {
    const m = new Map();
    for (const b of dreamLineup) {
      if (!b.item) continue;
      m.set(b.item.key, (m.get(b.item.key) || 0) + 1);
    }
    return items
      .map((it) => ({ item: it, wins: m.get(it.key) || 0 }))
      .filter((x) => x.wins > 0)
      .sort((a, b) => b.wins - a.wins);
  }, [dreamLineup, items]);

  // Rank progression per team across etapper (overall).
  const rankData = useMemo(() => {
    if (!cumIndex) return [];
    const rows = [];
    for (let e = 1; e <= 15; e++) {
      const r = { etappe: e };
      for (const it of items) {
        const t = it.team;
        const s = it.splits.find((x) => x[1] === e);
        if (!s || s[3] == null) continue;
        const allArr = cumIndex.all.get(`${t[1]}-${e}`);
        const klArr = cumIndex.klasse.get(`${t[1]}-${t[5]}-${e}`);
        if (allArr) r[it.key + "_all"] = rankOf(allArr, s[3]);
        if (klArr) r[it.key + "_kl"] = rankOf(klArr, s[3]);
      }
      rows.push(r);
    }
    return rows;
  }, [items, cumIndex]);

  if (compareTids.length === 0) {
    return html`
      <div style=${{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "auto" }}>
        <div className="compare-header">
          <div>
            <div className="kicker">Sammenligning · 0 lag</div>
            <h2>Side mot <em>side</em></h2>
          </div>
          <${AddTeamSearch} db=${db} splitsByTid=${splitsByTid} compareTids=${compareTids} toggleCompare=${toggleCompare} />
        </div>
        ${otherRecents.length
          ? html`
              <${RecentComparesPanel}
                title="Siste sammenligninger"
                recents=${otherRecents}
                teams=${teams}
                restoreCompare=${restoreCompare}
                removeRecentCompare=${removeRecentCompare}
              />
            `
          : null}
        <div className="empty">
          <div className="kicker">Tom sammenligning</div>
          Søk over, eller trykk + i lagslisten / etappe-søk for å legge til.
        </div>
      </div>
    `;
  }

  const compactHeader = isMobile;

  return html`
    <div style=${{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "auto" }}>
      ${compactHeader
        ? html`
            <div className="compare-header compact">
              <${AddTeamSearch} db=${db} splitsByTid=${splitsByTid} compareTids=${compareTids} toggleCompare=${toggleCompare} />
              <button
                className="icon-btn danger compact-clear"
                onClick=${clearCompare}
                title="Tøm alle"
                aria-label="Tøm alle"
              >✕</button>
            </div>
          `
        : html`
            <div className="compare-header">
              <div>
                <div className="kicker">Sammenligning · ${items.length} lag</div>
                <h2>Side mot <em>side</em></h2>
              </div>
              <div style=${{ display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap", minWidth: 0 }}>
                <${AddTeamSearch} db=${db} splitsByTid=${splitsByTid} compareTids=${compareTids} toggleCompare=${toggleCompare} />
                <button className="subtle danger" onClick=${clearCompare}>Tøm alle</button>
              </div>
            </div>
          `}
      <${TeamChipList} items=${items} toggleCompare=${toggleCompare} />
      ${otherRecents.length
        ? html`
            <${RecentComparesPanel}
              title="Bytt til tidligere sammenligning"
              recents=${otherRecents}
              teams=${teams}
              restoreCompare=${restoreCompare}
              removeRecentCompare=${removeRecentCompare}
              compact=${true}
            />
          `
        : null}
      <div className="content" style=${{ padding: "20px" }}>
        <div className="detail">
          <div className="kicker">Sammendrag</div>
          <h2>Totaltid + plassering</h2>
          <div className="grid" style=${{ gridTemplateColumns: `repeat(auto-fit, minmax(200px, 1fr))` }}>
            ${[...items]
              .filter((it) => it.team[6] != null)
              .sort((a, b) => a.team[6] - b.team[6])
              .concat([...items].filter((it) => it.team[6] == null))
              .map((it, i) => {
                const t = it.team;
                const rankKl = db.teamRank[t[0]];
                const allArr = cumIndex?.all.get(`${t[1]}-15`);
                const rankAll = allArr && t[6] != null ? rankOf(allArr, t[6]) : null;
                const order = i + 1;
                return html`
                  <div className="stat" key=${it.key} style=${{ borderLeftColor: it.color, position: "relative" }}>
                    <span style=${{ position: "absolute", top: "8px", right: "10px", fontFamily: "Fraunces, serif", fontSize: "20px", fontWeight: 700, color: "var(--muted)", lineHeight: 1 }}>${order}</span>
                    <div className="label" style=${{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingRight: "24px" }} title=${t[3]}>${t[3]} · ${t[1]}</div>
                    <div className="value">${fmtTime(t[6])}</div>
                    <div style=${{ fontSize: "11px", color: "var(--muted)", marginTop: "4px", fontFamily: "JetBrains Mono, monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      ${rankAll != null ? `#${rankAll} totalt` : "—"}${rankKl?.[0] ? ` · #${rankKl[0]}/${rankKl[1]} ${meta.klasser[t[5]]?.split(" ")[0] || ""}` : ""}
                    </div>
                  </div>
                `;
              })}
          </div>
        </div>

        <div className="detail dream-card">
          <div className="kicker">Drømmelag · best-of-valgte</div>
          <h2>Toppet lag <em>blant valgte</em></h2>

          <div className="dream-summary">
            <div className="dream-total">
              <div className="lbl">Drømmetid</div>
              <div className="val">${fmtTime(dreamComplete ? dreamTotal : null)}</div>
              ${dreamComplete && actualBestTotal != null && actualBestTotal > dreamTotal
                ? html`<div className="delta">−${fmtTime(actualBestTotal - dreamTotal)} vs raskeste i utvalget</div>`
                : !dreamComplete
                  ? html`<div className="delta muted">Mangler splits på noen etapper</div>`
                  : html`<div className="delta muted">Lik raskeste i utvalget</div>`}
            </div>
            ${winsByTeam.length
              ? html`
                  <div className="dream-wins">
                    <div className="lbl">Etappevinnere</div>
                    <div className="dream-wins-row">
                      ${winsByTeam.map(
                        (w) => html`
                          <span
                            className="dream-win-chip"
                            key=${w.item.key}
                            style=${{ borderLeftColor: w.item.color }}
                            title=${`${w.item.team[3]} (${w.item.team[1]})`}
                          >
                            <span className="name">${w.item.team[3]}</span>
                            <span className=${"chip year-" + w.item.team[1]}>${w.item.team[1]}</span>
                            <span className="count">${w.wins}</span>
                          </span>
                        `,
                      )}
                    </div>
                  </div>
                `
              : null}
          </div>

          <div className="dream-stages">
            ${dreamLineup.map((b) => {
              const dist = meta.etappe_distances[b.etappe];
              return html`
                <div
                  className=${"dream-stage" + (b.item ? "" : " empty")}
                  key=${b.etappe}
                  style=${{ borderLeftColor: b.item?.color || "var(--border-strong)" }}
                  onClick=${() => b.item && setSelected(b.item.tid)}
                >
                  <div className="num">${b.etappe}</div>
                  <div className="info">
                    <div className="stage-name">${ETAPPE_NAMES[b.etappe] || ""}</div>
                    ${b.item
                      ? html`
                          <div className="team">
                            <span className="t-name" title=${b.item.team[3]}>${b.item.team[3]}</span>
                            <span className=${"chip year-" + b.item.team[1]}>${b.item.team[1]}</span>
                          </div>
                          <div className="runner">${b.runner || html`<span className="muted">(ukjent løper)</span>`}</div>
                        `
                      : html`<div className="muted">Ingen split i utvalget</div>`}
                  </div>
                  <div className="time">
                    <div className="t">${fmtTime(b.split)}</div>
                    <div className="p">${fmtPace(b.split, dist)}</div>
                  </div>
                </div>
              `;
            })}
          </div>
        </div>

        <div className="chart-wrap">
          <h3>Etappe-splits <em>side om side</em></h3>
          <${ResponsiveContainer} width="100%" height=${320}>
            <${LineChart} data=${splitData} margin=${{ top: 8, right: 24, left: 0, bottom: 4 }}>
              <${CartesianGrid} stroke="#2c261d" strokeDasharray="3 3" />
              <${XAxis} dataKey="etappe" stroke="#978a72" fontSize=${11} tickLine=${false} />
              <${YAxis} stroke="#978a72" fontSize=${11} tickFormatter=${(v) => fmtTime(v)} tickLine=${false} />
              <${Tooltip}
                formatter=${(v) => fmtTime(v)}
                contentStyle=${{ background: "#1a1610", border: "1px solid #3a3324", borderRadius: 4 }}
                labelFormatter=${(l) => `Etappe ${l}`}
              />
              ${items.length <= 12 ? html`<${Legend} wrapperStyle=${{ fontSize: 12 }} />` : null}
              ${items.map(
                (it) => html`
                  <${Line}
                    key=${it.key}
                    type="monotone"
                    dataKey=${it.key}
                    name=${`${it.team[3]} (${it.team[1]})`}
                    stroke=${it.color}
                    strokeWidth=${items.length > 30 ? 1 : 2}
                    dot=${items.length > 20 ? false : { r: 3 }}
                    activeDot=${{ r: 5 }}
                    isAnimationActive=${items.length <= 30}
                  />
                `,
              )}
            <//>
          <//>
        </div>

        ${cumIndex
          ? html`
              <div className="chart-wrap">
                <h3>Plassering gjennom <em>løpet</em> (totalt)</h3>
                <${ResponsiveContainer} width="100%" height=${320}>
                  <${LineChart} data=${rankData}>
                    <${CartesianGrid} stroke="#2c261d" strokeDasharray="3 3" />
                    <${XAxis} dataKey="etappe" stroke="#978a72" fontSize=${11} />
                    <${YAxis} stroke="#978a72" fontSize=${11} reversed=${true} />
                    <${Tooltip}
                      contentStyle=${{ background: "#1a1610", border: "1px solid #3a3324", borderRadius: 4 }}
                      labelFormatter=${(l) => `Etappe ${l}`}
                    />
                    ${items.length <= 12 ? html`<${Legend} wrapperStyle=${{ fontSize: 12 }} />` : null}
                    ${items.map(
                      (it) => html`
                        <${Line}
                          key=${it.key}
                          type="monotone"
                          dataKey=${it.key + "_all"}
                          name=${`${it.team[3]} (${it.team[1]})`}
                          stroke=${it.color}
                          strokeWidth=${items.length > 30 ? 1 : 2}
                          dot=${items.length > 20 ? false : { r: 3 }}
                          isAnimationActive=${items.length <= 30}
                        />
                      `,
                    )}
                  <//>
                <//>
              </div>
              <div className="chart-wrap">
                <h3>Plassering i <em>klasse</em></h3>
                <${ResponsiveContainer} width="100%" height=${320}>
                  <${LineChart} data=${rankData}>
                    <${CartesianGrid} stroke="#2c261d" strokeDasharray="3 3" />
                    <${XAxis} dataKey="etappe" stroke="#978a72" fontSize=${11} />
                    <${YAxis} stroke="#978a72" fontSize=${11} reversed=${true} />
                    <${Tooltip}
                      contentStyle=${{ background: "#1a1610", border: "1px solid #3a3324", borderRadius: 4 }}
                      labelFormatter=${(l) => `Etappe ${l}`}
                    />
                    ${items.length <= 12 ? html`<${Legend} wrapperStyle=${{ fontSize: 12 }} />` : null}
                    ${items.map(
                      (it) => html`
                        <${Line}
                          key=${it.key}
                          type="monotone"
                          dataKey=${it.key + "_kl"}
                          name=${`${it.team[3]} (${it.team[1]})`}
                          stroke=${it.color}
                          strokeWidth=${items.length > 30 ? 1 : 2}
                          dot=${items.length > 20 ? false : { r: 3 }}
                          isAnimationActive=${items.length <= 30}
                        />
                      `,
                    )}
                  <//>
                <//>
              </div>
            `
          : null}

        <div className="detail">
          <div className="kicker">Etappetider</div>
          <h2>Per etappe</h2>
          <div style=${{ overflowX: "auto", marginTop: "8px" }}>
          <table className="etappes-table" style=${{ minWidth: "max-content" }}>
            <thead>
              <tr>
                <th>#</th>
                <th>Etappe</th>
                ${items.map((it) => html`<th key=${it.key} className="right" style=${{ color: it.color }}>${it.team[3]} <span style=${{ color: "var(--muted)", fontWeight: 400 }}>(${it.team[1]})</span></th>`)}
              </tr>
            </thead>
            <tbody>
              ${splitData.map(
                (row) => html`
                  <tr key=${row.etappe}>
                    <td>${row.etappe}</td>
                    <td className="team-name" style=${{ color: "var(--muted)", fontSize: "12px" }}>${ETAPPE_NAMES[row.etappe] || ""}</td>
                    ${items.map((it) => {
                      const v = row[it.key];
                      // Determine fastest in this row
                      const vals = items.map((x) => row[x.key]).filter((y) => y != null);
                      const minV = vals.length ? Math.min(...vals) : null;
                      const isFastest = v != null && v === minV && vals.length > 1;
                      return html`
                        <td key=${it.key} className="right" style=${{ color: isFastest ? it.color : undefined, fontWeight: isFastest ? 700 : 400 }}>
                          ${fmtTime(v)}
                        </td>
                      `;
                    })}
                  </tr>
                `,
              )}
              <tr style=${{ borderTop: "2px solid var(--accent)" }}>
                <td></td>
                <td style=${{ fontWeight: 700 }}>TOTAL</td>
                ${items.map((it) => {
                  const total = it.team[6];
                  const totals = items.map((x) => x.team[6]).filter((y) => y != null);
                  const minT = totals.length ? Math.min(...totals) : null;
                  const isFastest = total != null && total === minT && totals.length > 1;
                  return html`
                    <td key=${it.key} className="right" style=${{ color: isFastest ? it.color : undefined, fontWeight: 700 }}>
                      ${fmtTime(total)}
                    </td>
                  `;
                })}
              </tr>
            </tbody>
          </table>
          </div>
        </div>
      </div>
    </div>
  `;
}

function App() {
  const [db, setDb] = useState(null);
  const [view, setView] = usePersistedState("hk:view", "teams");
  const [filters, setFilters] = usePersistedState("hk:filters", {
    q: [],
    qField: "team",
    years: [],
    klasser: [],
    onlyFinished: false,
  });
  const [selected, setSelected] = useState(null);
  const [compareTids, setCompareTids] = usePersistedState("hk:compare", []);
  const [recentCompares, setRecentCompares] = usePersistedState("hk:recentCompares", []);
  const [etappePreselect, setEtappePreselect] = useState(null);
  const isMobile = useIsMobile();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Auto-close sidebar when switching tabs on mobile.
  useEffect(() => { if (isMobile) setSidebarOpen(false); }, [view, isMobile]);
  const hasSidebar = view === "teams" || view === "etappesok" || view === "etapper";
  const toggleCompare = useCallback(
    (tid) =>
      setCompareTids((cur) => (cur.includes(tid) ? cur.filter((t) => t !== tid) : [...cur, tid])),
    [setCompareTids],
  );
  // Auto-snapshot the current compare set into recent comparisons (debounced).
  useEffect(() => {
    if (compareTids.length < 2) return;
    const t = setTimeout(() => {
      const sortedKey = [...compareTids].sort((a, b) => a - b).join(",");
      setRecentCompares((prev) => {
        const filtered = (prev || []).filter(
          (s) => [...s.tids].sort((a, b) => a - b).join(",") !== sortedKey,
        );
        return [{ tids: [...compareTids], ts: Date.now() }, ...filtered].slice(0, 6);
      });
    }, 1500);
    return () => clearTimeout(t);
  }, [compareTids, setRecentCompares]);
  const restoreCompare = useCallback(
    (tids) => setCompareTids([...tids]),
    [setCompareTids],
  );
  const removeRecentCompare = useCallback(
    (ts) => setRecentCompares((prev) => (prev || []).filter((s) => s.ts !== ts)),
    [setRecentCompares],
  );
  const clearCompare = useCallback(() => setCompareTids([]), []);

  useEffect(() => {
    loadAll().then(setDb);
  }, []);

  // Build splits index by tid once db loads.
  const splitsByTid = useMemo(() => {
    if (!db) return new Map();
    const m = new Map();
    for (const s of db.splits) {
      const arr = m.get(s[0]) || [];
      arr.push(s);
      m.set(s[0], arr);
    }
    for (const arr of m.values()) arr.sort((a, b) => a[1] - b[1]);
    return m;
  }, [db]);

  const klasseCounts = useMemo(() => {
    if (!db) return {};
    const c = {};
    for (const t of db.teams) c[t[5]] = (c[t[5]] || 0) + 1;
    return c;
  }, [db]);

  // Cumulative time indices per (year, etappe) and (year, klasse, etappe) for
  // rank-progression lookups.
  const cumIndex = useMemo(() => {
    if (!db) return null;
    const all = new Map();
    const klasse = new Map();
    for (const s of db.splits) {
      const tid = s[0];
      const et = s[1];
      const cum = s[3];
      if (cum == null) continue;
      const t = db.teams[tid];
      const k1 = `${t[1]}-${et}`;
      const k2 = `${t[1]}-${t[5]}-${et}`;
      let arr1 = all.get(k1);
      if (!arr1) {
        arr1 = [];
        all.set(k1, arr1);
      }
      arr1.push(cum);
      let arr2 = klasse.get(k2);
      if (!arr2) {
        arr2 = [];
        klasse.set(k2, arr2);
      }
      arr2.push(cum);
    }
    for (const arr of all.values()) arr.sort((a, b) => a - b);
    for (const arr of klasse.values()) arr.sort((a, b) => a - b);
    return { all, klasse };
  }, [db]);

  // Merged-across-years sorted split arrays per etappe for "overall" percentile.
  const statsAllYears = useMemo(() => {
    if (!db) return {};
    const out = {};
    for (let e = 1; e <= 15; e++) {
      const merged = [];
      for (const y of db.meta.years) {
        const s = db.statsOverall[`${y}-${e}`];
        if (s?.sorted) merged.push(...s.sorted);
      }
      merged.sort((a, b) => a - b);
      out[e] = merged;
    }
    return out;
  }, [db]);

  const sameTeamIndex = useMemo(() => {
    if (!db) return new Map();
    const m = new Map();
    for (const t of db.teams) {
      const norm = normalizeName(t[3]);
      if (!norm) continue;
      const arr = m.get(norm) || [];
      arr.push(t[0]);
      m.set(norm, arr);
    }
    return m;
  }, [db]);

  if (!db) return html`
    <div className="splash" role="status" aria-live="polite">
      <div className="splash-card">
        <div className="splash-brand">HK<em>Split</em></div>
        <div className="splash-kicker">Holmenkollstafetten · 18,5 km · 15 etapper</div>
        <svg className="splash-profile" viewBox="0 0 360 80" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id="splash-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#f4cf3a" stopOpacity="0.22" />
              <stop offset="100%" stopColor="#f4cf3a" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path
            d="M 0 64 L 24 56 L 48 58 L 72 56 L 96 50 L 120 38 L 144 24 L 168 12 L 192 18 L 216 28 L 240 40 L 264 56 L 288 60 L 312 56 L 336 58 L 360 64 L 360 80 L 0 80 Z"
            fill="url(#splash-fill)"
          />
          <line x1="0" y1="79" x2="360" y2="79" stroke="#3a3324" strokeWidth="1" strokeDasharray="2 4" />
          <path
            id="splash-course"
            className="splash-line"
            d="M 0 64 L 24 56 L 48 58 L 72 56 L 96 50 L 120 38 L 144 24 L 168 12 L 192 18 L 216 28 L 240 40 L 264 56 L 288 60 L 312 56 L 336 58 L 360 64"
            fill="none"
            stroke="#f4cf3a"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          ${[0, 24, 48, 72, 96, 120, 144, 168, 192, 216, 240, 264, 288, 312, 336, 360].map(
            (x, i) => html`<circle key=${i} cx=${x} cy=${[64,56,58,56,50,38,24,12,18,28,40,56,60,56,58,64][i]} r="1.6" fill="#5e5444" />`,
          )}
          <circle className="splash-peak" cx="168" cy="12" r="3" fill="none" stroke="#f4cf3a" strokeWidth="1" />
          <text x="168" y="6" textAnchor="middle" fontSize="6" fill="#978a72" fontFamily="JetBrains Mono, monospace" letterSpacing="1">BESSERUD</text>
          <circle className="splash-runner" r="3.2" fill="#f4cf3a">
            <animateMotion dur="3.4s" repeatCount="indefinite" begin="1.6s">
              <mpath href="#splash-course" />
            </animateMotion>
          </circle>
        </svg>
        <div className="splash-status">Laster datasett</div>
        <div className="splash-bar"><span /></div>
        <div className="splash-meta">25 566 lag · 382 454 splits · 2019, 2022–2026</div>
      </div>
    </div>
  `;

  return html`
    <div className="app">
      <${Topbar}
        view=${view}
        setView=${setView}
        n=${db.meta.n_teams}
        compareCount=${compareTids.length}
        isMobile=${isMobile}
        hasSidebar=${hasSidebar}
        sidebarOpen=${sidebarOpen}
        setSidebarOpen=${setSidebarOpen}
      />
      ${isMobile && sidebarOpen && hasSidebar ? html`
        <div className="sidebar-backdrop" onClick=${() => setSidebarOpen(false)}></div>
      ` : null}
      <div className=${"main" + (isMobile && sidebarOpen ? " sidebar-mobile-open" : "")}>
        ${view === "teams"
          ? html`
              <${Sidebar}
                filters=${filters}
                setFilters=${setFilters}
                klasser=${db.meta.klasser}
                years=${db.meta.years}
                klasseCounts=${klasseCounts}
              />
              <div className="content" style=${{ padding: 0, display: "flex", flexDirection: "column" }}>
                <div style=${{ flex: selected != null ? 0.4 : 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column" }}>
                  <${TeamsView}
                    db=${db}
                    filters=${filters}
                    setFilters=${setFilters}
                    selected=${selected}
                    setSelected=${setSelected}
                    compareTids=${compareTids}
                    toggleCompare=${toggleCompare}
                    splitsByTid=${splitsByTid}
                  />
                </div>
                ${selected != null
                  ? html`
                      <div style=${{ flex: 0.6, minHeight: 0, overflow: "auto", padding: "16px", borderTop: "1px solid var(--border)" }}>
                        <${TeamDetail}
                          db=${db}
                          tid=${selected}
                          splitsByTid=${splitsByTid}
                          sameTeamIndex=${sameTeamIndex}
                          setSelected=${setSelected}
                          statsAllYears=${statsAllYears}
                          cumIndex=${cumIndex}
                          compareTids=${compareTids}
                          toggleCompare=${toggleCompare}
                        />
                      </div>
                    `
                  : null}
              </div>
            `
          : view === "etapper"
          ? html`<${EtapperView} db=${db} splitsByTid=${splitsByTid} statsAllYears=${statsAllYears} setView=${setView} setSelected=${setSelected} setEtappePreselect=${setEtappePreselect} />`
          : view === "etappesok"
          ? html`<${EtappeSokView} db=${db} splitsByTid=${splitsByTid} setSelected=${setSelected} setView=${setView} statsAllYears=${statsAllYears} compareTids=${compareTids} toggleCompare=${toggleCompare} etappePreselect=${etappePreselect} clearPreselect=${() => setEtappePreselect(null)} />`
          : view === "rute"
          ? html`<${MapView} db=${db} statsAllYears=${statsAllYears} splitsByTid=${splitsByTid} setView=${setView} setSelected=${setSelected} setEtappePreselect=${setEtappePreselect} />`
          : html`<${CompareView} db=${db} splitsByTid=${splitsByTid} compareTids=${compareTids} toggleCompare=${toggleCompare} clearCompare=${clearCompare} cumIndex=${cumIndex} statsAllYears=${statsAllYears} setSelected=${setSelected} setView=${setView} recentCompares=${recentCompares} restoreCompare=${restoreCompare} removeRecentCompare=${removeRecentCompare} />`}
      </div>
    </div>
  `;
}

createRoot(document.getElementById("root")).render(html`<${App} />`);
