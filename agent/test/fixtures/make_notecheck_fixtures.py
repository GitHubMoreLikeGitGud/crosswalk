"""Known-answer fixture generator for the note word verifier (task C6, agent/src/llm/noteCheck.ts).

Writes crosswalk-notecheck.json next to this file. Every expected value is computed here, in Python,
from the rules in docs/cursor-tasks/C6-note-word-verifier.md, independently of the TypeScript under
test. Every utility, ticker, name, count and change below is synthetic.

Run from the repository root:  python agent/test/fixtures/make_notecheck_fixtures.py
"""

from __future__ import annotations

import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent

NOTE_MAX_WORDS = 250
NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven",
                "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"]
N = r"(\d+|" + "|".join(NUMBER_WORDS) + r")"
VERDICT_FILLERS = ["keys", "key", "join", "were", "are", "is", "was", "with", "of", "the", "them", "measured", "as", "matches"]
VERDICT_RE = re.compile(r"(?<![\w.])" + N + r"((?:\s+(?:" + "|".join(VERDICT_FILLERS) + r")){0,3})\s+(verified|partially|partial|rejected)\b", re.I)
COUNT_RE = re.compile(r"(?<![\w.])" + N + r"((?:\s+[A-Za-z][A-Za-z-]*){0,2}?)\s+(utilities|states|declarations)\b", re.I)
DIRECTION_RE = re.compile(r"\b(rose|grew|increased|gained|fell|declined|decreased|dropped|held)\b|\b(up|down)(?=\s+[-+]?\d)", re.I)
OF_BEFORE = re.compile(r"\bof\s+$", re.I)
REVENUE_CONTEXT = re.compile(r"\brevenues?\b", re.I)
NOT_REVENUE_CONTEXT = re.compile(r"\b(degree|degrees|weather|temperature)\b", re.I)
SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+|\n+")
POSITIVE = {"rose", "grew", "increased", "gained", "up"}
NEGATIVE = {"fell", "declined", "decreased", "dropped", "down"}
KIND_ORDER = {"verdict_count": 0, "count": 1, "direction": 2}


def split_sentences(text: str) -> list[str]:
    return [s.strip() for s in SENTENCE_SPLIT.split(text) if s.strip()]


def number_value(token: str) -> int:
    t = token.lower()
    return int(t) if t.isdigit() else NUMBER_WORDS.index(t)


def label(u: dict) -> str:
    return u["ticker"] if u["ticker"] else u["name"]


def mentions(sentence: str, utilities: list[dict]) -> list[tuple[int, int]]:
    """(start, utility index) of every ticker (two or more characters, case-sensitive) and name (any case) mention."""
    out = []
    for i, u in enumerate(utilities):
        pats = []
        if u["ticker"] and len(u["ticker"]) >= 2:
            pats.append(re.compile(r"(?<![A-Za-z0-9])" + re.escape(u["ticker"]) + r"(?![A-Za-z0-9])"))
        pats.append(re.compile(r"(?<![A-Za-z0-9])" + re.escape(u["name"]) + r"(?![A-Za-z0-9])", re.I))
        for p in pats:
            out.extend((m.start(), i) for m in p.finditer(sentence))
    return sorted(set(out))


def before(ms: list[tuple[int, int]], pos: int) -> int | None:
    cands = [m for m in ms if m[0] < pos]
    if not cands:
        return None
    best = max(c[0] for c in cands)
    return min(c[1] for c in cands if c[0] == best)


def after(ms: list[tuple[int, int]], pos: int) -> int | None:
    cands = [m for m in ms if m[0] > pos]
    if not cands:
        return None
    best = min(c[0] for c in cands)
    return min(c[1] for c in cands if c[0] == best)


def direction_of(change: float | None) -> str:
    if change is None:
        return "not compared"
    return "rose" if change > 0 else "fell" if change < 0 else "unchanged"


def satisfies(word: str, change: float | None) -> bool:
    if change is None:
        return False
    if word in POSITIVE:
        return change > 0
    if word in NEGATIVE:
        return change < 0
    return change >= 0  # held


def check_note_words(text: str, facts: dict) -> list[dict]:
    utilities = facts["utilities"]
    issues = []
    for si, s in enumerate(split_sentences(text)):
        ms = mentions(s, utilities)
        for m in VERDICT_RE.finditer(s):
            if OF_BEFORE.search(s[: m.start()]):
                continue
            verdict = "PARTIAL" if m.group(3).lower().startswith("partial") else m.group(3).upper()
            claimed = number_value(m.group(1))
            actual = facts["verdicts"][verdict]
            if claimed != actual:
                issues.append((si, m.start(), "verdict_count", {"subject": verdict, "claimed": m.group(1).lower(), "expected": str(actual)}))
        for m in COUNT_RE.finditer(s):
            if OF_BEFORE.search(s[: m.start()]):
                continue
            noun = m.group(3).lower()
            claimed = number_value(m.group(1))
            ui = before(ms, m.start()) if noun in ("declarations", "states") else None
            if ui is None:
                subject, actual = noun, facts["totals"][noun]
            else:
                subject, actual = f"{label(utilities[ui])}:{noun}", utilities[ui][noun]
            if claimed != actual:
                issues.append((si, m.start(), "count", {"subject": subject, "claimed": m.group(1).lower(), "expected": str(actual)}))
        if REVENUE_CONTEXT.search(s) and not NOT_REVENUE_CONTEXT.search(s):
            for m in DIRECTION_RE.finditer(s):
                word = (m.group(1) or m.group(2)).lower()
                ui = before(ms, m.start())
                listed = sorted({i for st, i in ms if st > m.start()}) if ui is None else []
                if ui is None and len(listed) >= 2:
                    # Review correction: a direction word followed by several utilities ("held up ... with AAA, BBB
                    # and CCC") is a claim about each of them, not about the first one named; a named utility whose
                    # revenue was not compared fails the word, as it does when it is the only one attached.
                    bad = [label(utilities[i]) for i in listed if not satisfies(word, utilities[i]["revenue_change"])]
                    if bad:
                        issues.append((si, m.start(), "direction", {"subject": "listed", "claimed": word, "expected": ", ".join(bad)}))
                    continue
                if ui is None:
                    ui = after(ms, m.start())
                if ui is not None:
                    u = utilities[ui]
                    if not satisfies(word, u["revenue_change"]):
                        issues.append((si, m.start(), "direction", {"subject": label(u), "claimed": word, "expected": direction_of(u["revenue_change"])}))
                else:
                    bad = [label(u) for u in utilities if u["revenue_change"] is not None and not satisfies(word, u["revenue_change"])]
                    if bad:
                        issues.append((si, m.start(), "direction", {"subject": "all", "claimed": word, "expected": ", ".join(bad)}))
    issues.sort(key=lambda x: (x[0], x[1], KIND_ORDER[x[2]]))
    return [{"kind": k, "sentence": si, **d} for si, _, k, d in issues]


def repair_feedback(issues: list[dict]) -> str:
    if not issues:
        return ""
    lines = ["Your previous draft contradicts the tool outputs:"]
    for i in issues:
        n = i["sentence"] + 1
        if i["kind"] == "verdict_count":
            lines.append(f"- sentence {n}: you wrote {i['claimed']} {i['subject']} keys; the join map has {i['expected']}.")
        elif i["kind"] == "count":
            lines.append(f"- sentence {n}: you wrote {i['claimed']} {i['subject']}; the answer has {i['expected']}.")
        else:
            lines.append(f"- sentence {n}: \"{i['claimed']}\" for {i['subject']} contradicts the revenue change ({i['expected']}).")
    return "\n".join(lines)


def cap_words(paragraphs: list[str], max_words: int = NOTE_MAX_WORDS) -> str:
    kept: list[list[str]] = []
    total = 0
    stop = False
    first_sentence = None
    for p in paragraphs:
        cur: list[str] = []
        for s in split_sentences(p):
            if first_sentence is None:
                first_sentence = s
            w = len(s.split())
            if stop or total + w > max_words:
                stop = True
                break
            cur.append(s)
            total += w
        kept.append(cur)
        if stop:
            break
    if total == 0 and first_sentence is not None:
        return " ".join(first_sentence.split()[:max_words])
    return "\n\n".join(" ".join(c) for c in kept if c)


FACTS = {
    "verdicts": {"VERIFIED": 5, "PARTIAL": 1, "REJECTED": 1},
    "utilities": [
        {"ticker": "AAA", "name": "Alpha Power Co", "revenue_change": 0.087, "declarations": 2, "states": 2},
        {"ticker": "BBB", "name": "Bravo Electric Inc", "revenue_change": -0.0655, "declarations": 1, "states": 1},
        {"ticker": "CCC", "name": "Charlie Utilities Corp", "revenue_change": -0.0011, "declarations": 1, "states": 1},
        {"ticker": "DDD", "name": "Delta Grid Holdings", "revenue_change": None, "declarations": 1, "states": 1},
        {"ticker": "E", "name": "Echo Energy Inc", "revenue_change": 0.1222, "declarations": 1, "states": 1},
        {"ticker": None, "name": "Foxtrot Light Co", "revenue_change": 0.0, "declarations": 1, "states": 1},
    ],
    "totals": {"utilities": 6, "states": 4, "declarations": 4},
}

TEXTS = [
    ("clean", "The join map has five verified keys, one partial key and one rejected key. AAA revenue rose 8.7% and BBB revenue fell 6.6%. 6 utilities served 4 states with 4 declarations."),
    ("verdict_count_wrong", "The join map shows four keys with verified results."),
    ("verdict_count_digits", "5 keys were verified and 2 were rejected."),
    ("collective_held", "Their revenue held up year on year."),
    ("served_states_wrong", "The answer lists the 12 served states."),
    ("per_utility_counts", "AAA had 2 declarations in two states. BBB had 3 declarations."),
    ("of_excluded", "The cik key matched 42 of 43 VERIFIED, and the control 0 of 43 rejected."),
    ("decimal_excluded", "The SIC key reached a rate of 0.977 verified by rows."),
    ("up_down", "AAA revenue up 8.7%, CCC revenue down 0.1%. BBB revenue up 6.6%."),
    ("weather_sentence_skipped", "BBB degree days rose 3.0% while its revenue fell."),
    ("not_compared", "DDD revenue rose against a year earlier."),
    ("name_and_single_letter_ticker", "Echo Energy Inc revenue grew 12.2%. E revenue fell."),
    ("nearest_after", "Revenue fell at BBB."),
    ("number_word_states", "Declarations hit seven states."),
    ("partially", "Two keys partially matched."),
    ("second_sentence_index", "AAA revenue rose 8.7%. BBB revenue rose 6.6%."),
    ("held_zero_change", "Foxtrot Light Co revenue held at the same level, and CCC revenue held too."),
    ("utilities_always_total", "AAA is one of 6 utilities; BBB leads 9 utilities."),
    ("revenue_words_without_revenue", "AAA rose in the rankings."),
    ("mixed_kinds_same_sentence", "Three keys were verified across 5 utilities, and revenue rose."),
    # Review correction (second pass): a direction word followed by several utilities is checked against each of them.
    ("listed_after_held", "Their revenue held up year on year with AAA +8.7%, BBB -6.6% and CCC -0.1%."),
    ("listed_after_all_true", "Revenue rose year on year at AAA (+8.7%) and Echo Energy Inc (+12.2%)."),
    ("listed_after_not_compared", "Revenue rose at AAA and DDD."),
]

CAP_CASES = [
    {"name": "under_cap", "paragraphs": ["One two three. Four five.", "Six seven eight."], "max": 250},
    {"name": "cut_at_sentence", "paragraphs": ["Alpha beta gamma delta. Epsilon zeta eta theta iota.", "Kappa lambda mu nu xi omicron pi rho sigma tau."], "max": 12},
    {"name": "stop_after_first_misfit", "paragraphs": ["Short one. A much longer sentence that will not fit at all here. Tiny."], "max": 6},
    {"name": "first_sentence_too_long", "paragraphs": ["one two three four five six seven eight nine ten eleven twelve."], "max": 5},
    {"name": "empty", "paragraphs": [], "max": 250},
    {"name": "blank_paragraph_dropped", "paragraphs": ["", "Only this sentence."], "max": 250},
    {"name": "decimal_not_split", "paragraphs": ["AAA rose 8.7% to 5.4 billion. Next sentence here."], "max": 7},
    {"name": "default_cap_long", "paragraphs": [" ".join(f"Sentence number {i} has exactly seven words." for i in range(1, 50))], "max": None},
]


def main() -> None:
    cases = [{"name": n, "text": t, "expected": check_note_words(t, FACTS)} for n, t in TEXTS]
    caps = []
    for c in CAP_CASES:
        expected = cap_words(c["paragraphs"]) if c["max"] is None else cap_words(c["paragraphs"], c["max"])
        caps.append({**c, "expected": expected, "expected_words": len(expected.split()) if expected.strip() else 0})
    feedback = [
        {"name": "none", "issues": [], "expected": repair_feedback([])},
        {"name": "from_cases", "issues": [i for c in cases for i in c["expected"]][:6]},
    ]
    feedback[1]["expected"] = repair_feedback(feedback[1]["issues"])
    sentences = [{"text": t, "expected": split_sentences(t)} for t in (
        "AAA rose 8.7%. BBB fell 6.6%! Did CCC hold? Yes.",
        "Line one\nLine two.  Line three.",
        "Rate 0.977 and 1.000 stay in one sentence.",
        "",
    )]
    payload = {
        "synthetic": True,
        "note": "every utility, ticker, name, count and change is synthetic; expected values computed by this generator from the C6 rules",
        "max_words": NOTE_MAX_WORDS,
        "facts": FACTS,
        "sentences": sentences,
        "checks": cases,
        "cap": caps,
        "feedback": feedback,
    }
    path = HERE / "crosswalk-notecheck.json"
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {path.name}: {len(cases)} check cases ({sum(len(c['expected']) for c in cases)} issues), {len(caps)} cap cases")


if __name__ == "__main__":
    main()
