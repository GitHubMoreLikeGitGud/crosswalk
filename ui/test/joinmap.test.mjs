// Known-answer tests for the Join map screen's pure render helpers.
// Fixtures are synthetic views built from the server's joinMapView; do not regenerate them here.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { esc } from "../lib.js";
import {
  proposerWords,
  rateText,
  renderJoinGraph,
  renderJoinMap,
  renderJoinTable,
  renderSummary,
  transformWords,
  verdictClass,
} from "../views/joinmap.js";

const here = dirname(fileURLToPath(import.meta.url));
const cold = JSON.parse(readFileSync(join(here, "fixtures/joinmap-cold.json"), "utf8"));
const warm = JSON.parse(readFileSync(join(here, "fixtures/joinmap-warm.json"), "utf8"));

function stripEng(html) {
  return String(html).replace(/<[^>]*\bclass="[^"]*\beng\b[^"]*"[^>]*>[\s\S]*?<\/[^>]+>/gu, "");
}

test("transformWords: closed set and unknowns", () => {
  assert.equal(transformWords("identity"), "as is");
  assert.equal(transformWords("upper"), "upper-cased");
  assert.equal(transformWords("lpad10"), "padded to 10 digits with leading zeros");
  assert.equal(transformWords("substr(4,2)"), "characters 4 to 5");
  assert.equal(transformWords("strip_prefix"), "prefix removed");
  assert.equal(transformWords("strip_prefix('US-')"), "prefix removed");
  assert.equal(transformWords("yyyymmdd_to_date"), "read as a date");
  assert.equal(transformWords("iso_to_quarter"), "bucketed to a calendar quarter");
  assert.equal(transformWords("weird_thing"), "weird_thing");
});

test("proposerWords: model and baseline synonyms, deduped", () => {
  assert.equal(proposerWords(["planner", "baseline (queue)", "baseline"]), "the model, name-match baseline");
  assert.equal(proposerWords(["control"]), "control (deliberately without the transform)");
});

test("rateText: measured and not measured", () => {
  assert.equal(rateText(42, 43, 42 / 43, "rows"), "42 of 43 rows (97.7%)");
  assert.equal(rateText(3, 4, 0.75, "distinct values"), "3 of 4 distinct values (75.0%)");
  assert.equal(rateText(null, 43, 0.9, "rows"), "not measured");
  assert.equal(rateText(42, null, 0.9, "rows"), "not measured");
});

test("verdictClass", () => {
  assert.equal(verdictClass("VERIFIED"), "good");
  assert.equal(verdictClass("PARTIAL"), "mid");
  assert.equal(verdictClass("REJECTED"), "bad");
  assert.equal(verdictClass("OTHER"), "neutral");
  assert.equal(verdictClass(null), "neutral");
});

test("cold fixture: renderJoinTable rows, verdicts, orphans, closed SQL", () => {
  const html = renderJoinTable(cold);
  const bodies = html.match(/<tbody[\s\S]*?<\/tbody>/u)?.[0] ?? "";
  const trs = [...bodies.matchAll(/<tr\b/gu)];
  assert.equal(trs.length, cold.counts.keys);

  for (const row of cold.rows) {
    assert.match(html, new RegExp(row.verdict.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    const def = row.verdict_definition ?? cold.definitions[row.verdict];
    assert.ok(def, row.key);
    assert.ok(html.includes(esc(def)), `definition for ${row.key}`);
  }

  const partial = cold.rows.find((r) => r.verdict === "PARTIAL");
  assert.ok(partial);
  assert.ok(partial.orphans.length);
  for (const o of partial.orphans) assert.ok(html.includes(o), `orphan ${o}`);

  const details = [...html.matchAll(/<details(\s[^>]*)?>/gu)];
  assert.equal(details.length, cold.rows.length);
  for (const m of details) {
    assert.ok(!/\bopen\b/u.test(m[1] ?? ""), "details closed by default");
  }
  for (const row of cold.rows) {
    assert.ok(row.sql);
    assert.ok(html.includes(esc(row.sql)), `sql for ${row.key}`);
  }

  const good = (html.match(/chip--good/gu) || []).length;
  const mid = (html.match(/chip--mid/gu) || []).length;
  const bad = (html.match(/chip--bad/gu) || []).length;
  assert.equal(good + mid + bad, cold.counts.verified + cold.counts.partial + cold.counts.rejected);
  assert.equal(good, cold.counts.verified);
  assert.equal(mid, cold.counts.partial);
  assert.equal(bad, cold.counts.rejected);
});

test("warm fixture: recalled vs measured provenance and eng memory ids", () => {
  const html = renderJoinTable(warm);
  assert.match(html, /Recalled from memory/u);
  assert.match(html, /Measured in this run/u);
  for (const row of warm.rows) {
    if (row.recalled) {
      assert.ok(row.memory_id);
      assert.match(html, new RegExp(`class="[^"]*\\beng\\b[^"]*"[^>]*>[^<]*${row.memory_id}`, "u"));
    }
  }
  const measured = warm.rows.filter((r) => !r.recalled);
  assert.ok(measured.length >= 1);
  for (const row of measured) {
    assert.ok(html.includes("Measured in this run"));
  }
});

test("renderJoinGraph: lines, nodes, dashed REJECTED, aria-label", () => {
  const html = renderJoinGraph(cold);
  assert.match(html, /<svg\b/u);
  assert.match(html, /viewBox="0 0 960 400"/u);
  assert.match(html, /role="img"/u);

  const lines = (html.match(/<line\b/gu) || []).length;
  assert.equal(lines, cold.rows.length);

  const objects = new Set();
  for (const r of cold.rows) {
    objects.add(r.left.object);
    objects.add(r.right.object);
  }
  // One node rect per distinct object (rounded rectangles).
  const rects = (html.match(/<rect\b/gu) || []).length;
  assert.ok(rects >= objects.size);

  const rejected = cold.rows.filter((r) => r.verdict === "REJECTED");
  assert.ok(rejected.length);
  assert.match(html, /stroke-dasharray="6 4"/u);

  const aria = html.match(/aria-label="([^"]*)"/u)?.[1] ?? "";
  for (let i = 0; i < cold.rows.length; i++) {
    const r = cold.rows[i];
    assert.ok(aria.includes(`${i + 1}:`), `aria ${i + 1}`);
    assert.ok(aria.includes(r.left.ref), r.left.ref);
    assert.ok(aria.includes(r.right.ref), r.right.ref);
    assert.ok(aria.includes(r.verdict ?? ""), r.verdict);
  }
});

test("renderSummary: counts sentence and proposer table for both fixtures", () => {
  for (const data of [cold, warm]) {
    const html = renderSummary(data);
    const c = data.counts;
    assert.ok(html.includes(`${c.keys} keys: ${c.verified} VERIFIED, ${c.partial} PARTIAL, ${c.rejected} REJECTED`));
    assert.ok(html.includes(`${c.measured_in_run} measured in this run, ${c.recalled} recalled from memory`));
    assert.ok(html.includes("Who proposed the keys"));
    assert.ok(html.includes("The model (NVIDIA Nemotron 3 Nano 4B)"));
    assert.ok(html.includes("Name-match baseline (no model)"));
    for (const side of [data.proposals.model, data.proposals.baseline]) {
      if (!side) continue;
      assert.ok(html.includes(String(side.made)));
      assert.ok(html.includes(String(side.verified)));
      assert.ok(html.includes(String(side.partial)));
      assert.ok(html.includes(String(side.rejected)));
      assert.ok(html.includes(String(side.unmeasurable)));
    }
  }
});

test("escaping: label and orphans with <script> never emit a raw tag", () => {
  const row = {
    ...cold.rows[0],
    id: "esc1",
    key: "esc@test",
    label: `<script>alert(1)</script>`,
    orphans: [`<script>x</script>`, "OK"],
    sql: `SELECT 1 WHERE x < 2 AND y > 0`,
    sql_orphans: null,
    verdict: "PARTIAL",
    verdict_definition: cold.definitions.PARTIAL,
  };
  const data = { ...cold, rows: [row], counts: { ...cold.counts, keys: 1, verified: 0, partial: 1, rejected: 0, other: 0, measured_in_run: 1, recalled: 0 } };
  const html = renderJoinTable(data);
  assert.equal(html.includes("<script"), false);
  assert.ok(html.includes("&lt;script&gt;") || html.includes("&lt;script"));
});

test("engineering ids stay inside .eng", () => {
  const html = renderJoinMap(cold);
  const visible = stripEng(html);
  for (const row of cold.rows) {
    if (row.id) assert.equal(visible.includes(row.id), false, `id ${row.id} leaked`);
    assert.equal(visible.includes(row.key), false, `key ${row.key} leaked`);
  }
  for (const row of cold.rows) {
    if (row.id) assert.match(html, new RegExp(`class="[^"]*\\beng\\b[^"]*"[^>]*>[^<]*${row.id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"));
    assert.match(html, new RegExp(`class="[^"]*\\beng\\b[^"]*"[^>]*>[^<]*${row.key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"));
  }
});

test("review: keys between the same two tables are drawn as separate lines, and a generic label is not repeated", () => {
  const rows = [
    { id: "a", key: "x@all", label: "(a) first", left: { object: "cw.l", column: "c", ref: "cw.l.c" }, right: { object: "cw.r", column: "c", ref: "cw.r.c" }, verdict: "VERIFIED", orphans: [] },
    { id: "b", key: "y@all", label: "cw.l.c ~ cw.r.c under identity", left: { object: "cw.l", column: "c", ref: "cw.l.c" }, right: { object: "cw.r", column: "c", ref: "cw.r.c" }, verdict: "REJECTED", orphans: [] },
  ];
  const svg = renderJoinGraph({ rows });
  const coords = [...svg.matchAll(/<line x1="([\d.-]+)" y1="([\d.-]+)" x2="([\d.-]+)" y2="([\d.-]+)"/gu)].map((m) => m.slice(1).join(","));
  assert.equal(coords.length, 2);
  assert.notEqual(coords[0], coords[1]);
  const table = renderJoinTable({ rows, definitions: {} });
  assert.ok(table.includes("(a) first"));
  assert.ok(!table.includes("under identity"));
});

test("review: a key with unmatched rows but no orphan list says so instead of 'none'", () => {
  const control = cold.rows.find((r) => r.key.startsWith("cik_control"));
  assert.equal(control.matched_rows, 0);
  assert.deepEqual(control.orphans, []);
  const one = renderJoinTable({ rows: [control], definitions: {} });
  assert.ok(stripEng(one).includes("43 unmatched; not listed by this statement"));
  const full = { ...control, matched_rows: 43, left_rows: 43, orphans: [] };
  assert.ok(stripEng(renderJoinTable({ rows: [full], definitions: {} })).includes(">none<"));
});
