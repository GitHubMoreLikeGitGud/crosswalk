"""Draws docs/architecture.svg (standard library only).

    python docs/architecture.py

docs/architecture.png is a 2x render of the SVG (3000 px wide).
Adapted from Weather-or-Not's figure script (same author, Apache-2.0); the content is Crosswalk's.
"""

from __future__ import annotations

from pathlib import Path
from xml.sax.saxutils import escape

W, H = 1500, 1150
FONT = "Segoe UI, Helvetica Neue, Arial, sans-serif"
INK, MUTED = "#1F2933", "#52606D"

# stroke, fill, tag colour
ZETARIS = ("#0E7C86", "#E7F4F5", "#0B6670")
METERLESS = ("#6B4FBB", "#F1EDFA", "#5A3FA8")
NVIDIA = ("#76B900", "#F2F8E6", "#4B7700")
CORE = ("#3B5B85", "#EAF0F7", "#2F4A6E")
ANALYST = ("#B26A00", "#FFF4E2", "#8A5200")
SOURCE = ("#8A8F98", "#F5F6F8", "#5F6670")

out: list[str] = []


def text(x, y, s, size=14, weight="normal", fill=INK, anchor="start", style="normal", spacing=0.0):
    ls = f' letter-spacing="{spacing}"' if spacing else ""
    out.append(
        f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" font-style="{style}" '
        f'fill="{fill}" text-anchor="{anchor}"{ls}>{escape(s)}</text>'
    )


def rect(x, y, w, h, stroke, fill, dash=False, r=10, sw=2.0):
    d = ' stroke-dasharray="7 5"' if dash else ""
    out.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"{d}/>')


def box(x, y, w, h, colours, title, lines, tag=None):
    stroke, fill, tagc = colours
    rect(x, y, w, h, stroke, fill)
    ty = y + 30
    if tag:
        text(x + 14, y + 22, tag, size=11, weight="bold", fill=tagc, spacing=1.2)
        ty = y + 45
    text(x + 14, ty, title, size=17, weight="bold")
    for i, line in enumerate(lines):
        strong = line.startswith("!")
        text(x + 14, ty + 23 + 19 * i, line.lstrip("!"), size=14, fill=INK if strong else MUTED,
             weight="bold" if strong else "normal")


def arrow(points, label=None, at=None, both=False, colour="#4A5563", anchor="start", lsize=12.5):
    pts = " ".join(f"{x},{y}" for x, y in points)
    start = ' marker-start="url(#arrow-start)"' if both else ""
    out.append(f'<polyline points="{pts}" fill="none" stroke="{colour}" stroke-width="2"{start} marker-end="url(#arrow)"/>')
    if label and at:
        text(at[0], at[1], label, size=lsize, fill=MUTED, anchor=anchor)


out.append(
    f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" '
    f'font-family="{FONT}" role="img" aria-labelledby="t d">'
)
out.append('<title id="t">Crosswalk architecture</title>')
out.append(
    '<desc id="d">OpenFEMA, SEC EDGAR, NOAA GHCN-Daily and the company_dns SIC list are read only through Zetaris Lightning: '
    'REST and filestore tables, cached SchemaStore views in the container cw, and the crosswalk_usl Unified Semantic Layer '
    'with foreign-key data-quality rules. A gateway exposes 59 named SQL templates and contract-checked registrar plans. '
    'In the agent server a Markovian discovery loop runs six discovery tools; Nemotron 3 Nano 4B on local Ollama chooses '
    'the next step and proposes join keys from a menu of probed columns, deterministic tools measure every key as a match '
    'rate in Lightning SQL, H-MEM keeps verified keys for the next question, the World Model keeps key edges with their '
    'measurement time, and every number cites the SQL that produced it. The analyst reads the discovery timeline, the '
    'join map, the semantic layer with its DQ results and the cited answer in the UI.</desc>'
)
out.append(
    '<defs>'
    '<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">'
    '<path d="M0,0 L10,5 L0,10 z" fill="#4A5563"/></marker>'
    '<marker id="arrow-start" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">'
    '<path d="M0,0 L10,5 L0,10 z" fill="#4A5563"/></marker>'
    '</defs>'
)
out.append(f'<rect width="{W}" height="{H}" fill="#FFFFFF"/>')

text(30, 46, "Crosswalk: measure how three agencies' data join, then answer from the joins", size=26, weight="bold")
text(30, 74, "One machine: Zetaris Lightning in local Docker, the gateway and the agent server on 127.0.0.1, Nemotron in local Ollama. No cloud model calls.",
     size=15, fill=MUTED)

# Containers first, so arrows and labels sit on top of them
rect(280, 110, 400, 700, ZETARIS[0], "#F6FBFB", dash=True, r=14)
rect(985, 110, 490, 790, "#9AA3AF", "#FAFAFC", dash=True, r=14)

# Public sources
text(30, 150, "PUBLIC SOURCES", size=11, weight="bold", fill=SOURCE[2], spacing=1.2)
box(30, 165, 226, 104, SOURCE, "OpenFEMA", ["disaster declarations (DR)", "and the dataset list", "public US federal data"])
box(30, 285, 226, 104, SOURCE, "SEC EDGAR", ["XBRL frames, submissions", "declared User-Agent;", "queried live, not redistributed"])
box(30, 405, 226, 104, SOURCE, "NOAA GHCN-Daily", ["station inventory, daily", "TMAX and TMIN parquet", "CC0-1.0 (cite NOAA NCEI)"])
box(30, 525, 226, 104, SOURCE, "company_dns", ["US SIC code list,", "1,005 codes", "service under Apache-2.0"])
text(30, 662, "Zetaris is the only", size=13, fill=MUTED, style="italic")
text(30, 680, "runtime path to them.", size=13, fill=MUTED, style="italic")

# Zetaris
text(300, 138, "ZETARIS", size=11, weight="bold", fill=ZETARIS[2], spacing=1.2)
text(300, 160, "Lightning 2.4.3.1, local Docker", size=17, weight="bold")
box(300, 175, 360, 148, ZETARIS, "REST tables, views cached",
    ["CW_FEMA.declarations_dr_<quarter>", "CW_FEMA.datasets_catalogue", "CW_SEC.frames_<tag>_<period>, submissions",
     "CW_DNS.sic_codes_v4_raw", "!flattened into the container cw"])
box(300, 340, 360, 128, ZETARIS, "FILESTORE tables, views cached",
    ["CW_GHCN station inventory (CSV,", "parsed by SUBSTR): 133,039 rows", "CW_GHCN.ghcn_<year>_<element> parquet",
     "!degree days computed in Lightning SQL"])
box(300, 485, 360, 170, ZETARIS, "crosswalk_usl",
    ["Unified Semantic Layer, 7 tables:", "state, sic_code, utility, utility_state,", "fema_declaration, station, revenue_quarter",
     "!6 foreign keys, each a measured join key", "!RUN DQ at onboarding: MGE Energy invalid", "!2 DQ rules run live on every question"])
text(300, 688, "Match rates are Lightning SQL over the", size=13, fill=MUTED, style="italic")
text(300, 706, "cached views; the agent never writes SQL.", size=13, fill=MUTED, style="italic")
text(300, 724, "The gateway's named templates do, and the", size=13, fill=MUTED, style="italic")
text(300, 742, "logged SQL text is the citation of every", size=13, fill=MUTED, style="italic")
text(300, 760, "number on the answer.", size=13, fill=MUTED, style="italic")
for y in (217, 337, 457, 577):
    out.append(f'<line x1="256" y1="{y}" x2="268" y2="{y}" stroke="#4A5563" stroke-width="2"/>')
out.append('<line x1="268" y1="217" x2="268" y2="577" stroke="#4A5563" stroke-width="2"/>')
arrow([(268, 250), (300, 250)])
arrow([(268, 404), (300, 404)])
arrow([(480, 323), (480, 340)])
arrow([(480, 468), (480, 485)], "ACTIVATE from the cached views", (495, 480), lsize=12)

# Gateway
box(730, 300, 226, 212, CORE, "Zetaris gateway",
    ["FastAPI + JDBC, 127.0.0.1:8803", "59 named SQL templates", "parameters checked against", "the manifest, the closed", "transform set and DESCRIBE",
     "!registrar plans under a", "!signed contract", "!every statement logged"])
arrow([(660, 420), (730, 420)], "JDBC", (705, 410), both=True, anchor="middle")
arrow([(956, 420), (1005, 420)], both=True)
text(843, 536, "template id + parameters in;", size=12.5, fill=MUTED, anchor="middle")
text(843, 553, "rows + SQL text back", size=12.5, fill=MUTED, anchor="middle")

# Agent server
text(1005, 138, "AGENT SERVER", size=11, weight="bold", fill="#5F6670", spacing=1.2)
text(1005, 160, "Node 22 + TypeScript, 127.0.0.1:8804", size=17, weight="bold")
box(1005, 175, 450, 186, METERLESS, "Markovian discovery loop",
    ["at most 12 chunks, carried state at most 800 tokens", "six discovery tools: search_catalogue, probe_source,",
     "propose_keys, measure_key, register_source, compile_usl", "then answer, not_tested, finalize", "!fixed order = a checklist; invalid reply: repair, then",
     "!the host takes the next step (a counted fallback)"],
    tag="METERLESS")
box(1005, 380, 220, 180, NVIDIA, "Nemotron 3 Nano 4B",
    ["local Ollama, loopback only", "picks the next step;", "proposes keys from a menu", "of probed columns", "!never computes a number", "!0 cloud model calls"],
    tag="NVIDIA")
box(1235, 380, 220, 180, CORE, "Deterministic tools",
    ["match-rate SQL, verdict rule", "(VERIFIED at 0.95, PARTIAL", "at 0.80), orphans", "name-and-statistics baseline", "USL renderer, the answer", "!every proposal measured"],
    tag="DETERMINISTIC")
box(1005, 579, 220, 162, METERLESS, "H-MEM",
    ["key_verified memories:", "a warm run skips their", "measure steps", "source_access memories", "known_to_fail as negatives"],
    tag="METERLESS")
box(1235, 579, 220, 162, METERLESS, "World Model",
    ["datasets, columns, utilities,", "states, declarations", "crosswalks_to edges with", "transform, rate and the", "time they were measured"],
    tag="METERLESS")
box(1005, 760, 450, 126, METERLESS, "Evidence store and signed registration",
    ["every number cites its Lightning SQL, rows, object,", "endpoint, licence, time, latency and cache state",
     "!register_source: HMAC-signed, single-use contract"],
    tag="SCOUT INTENT SUBSET, REIMPLEMENTED")
arrow([(1115, 361), (1115, 380)], both=True)
arrow([(1345, 361), (1345, 380)], both=True)
arrow([(1115, 560), (1115, 579)], both=True)
arrow([(1345, 560), (1345, 579)], both=True)
arrow([(1230, 741), (1230, 760)])

# Analyst
box(1005, 955, 450, 150, ANALYST, "Analyst UI",
    ["Ask; Discovery timeline (live over SSE, or REPLAY);", "Join map: both rates, the verdict in plain words,",
     "orphans by name; USL and DQ: the governed model", "and the invalid row; Answer: click any number for its SQL"],
    tag="ANALYST")
arrow([(1230, 955), (1230, 886)], both=True)
text(1242, 926, "one question at a time", size=12.5, fill=MUTED)

# The question, bottom left
box(30, 955, 640, 150, CORE, "The demo question",
    ["Which investor-owned electric utilities served states with FEMA", "major-disaster declarations in Q1 2025, what did the weather",
     "at their stations do, and did their revenue hold up year on year?", "!The FEMA join selects the utilities; none is hand-picked."],
    tag="QUESTION")

# Legend
lx, ly = 30, 1132
for label, (stroke, fill, _) in [("Zetaris", ZETARIS), ("Meterless", METERLESS), ("NVIDIA", NVIDIA),
                                 ("Crosswalk code, deterministic", CORE), ("Analyst", ANALYST), ("Public source", SOURCE)]:
    rect(lx, ly - 13, 16, 16, stroke, fill, r=4)
    text(lx + 24, ly, label, size=13, fill=MUTED)
    lx += 24 + int(len(label) * 5.9) + 34

out.append("</svg>")

if __name__ == "__main__":
    target = Path(__file__).with_name("architecture.svg")
    target.write_text("\n".join(out) + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {target} ({W}x{H})")
