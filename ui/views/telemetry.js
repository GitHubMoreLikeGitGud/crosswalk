// The telemetry footer for the run on screen (GET /api/runs/:id/telemetry): chunks, skipped measure
// steps, tokens, tok/s, wall time, the model and its think setting, cloud model calls. With no run
// (the Ask screen) it shows the newest saved run from GET /api/telemetry. renderFooter is pure.

import { api, esc, fmtNum, runWords } from "../lib.js";

const NOT_MEASURED = `<span class="nm">not measured</span>`;

function item(k, v, note = "", title = "", cls = "") {
  return `<div class="tele__item${cls ? ` ${cls}` : ""}"${title ? ` title="${esc(title)}"` : ""}><span class="tele__k">${esc(k)}</span><span class="tele__v">${v}</span>${note ? `<span class="tele__n">${note}</span>` : ""}</div>`;
}

const n = (x, d = 0) => (typeof x === "number" && Number.isFinite(x) ? `<span class="tnum">${esc(fmtNum(x, d))}</span>` : NOT_MEASURED);

/** Pure: the footer from a telemetry view ({run_id, quarter, mode, chunks, ...}); label names the run. */
export function renderFooter(t, label = "", empty = "") {
  if (!t || typeof t !== "object") return `<div class="tele">${item("Telemetry", empty ? `<span class="nm">${esc(empty)}</span>` : NOT_MEASURED)}</div>`;
  const L = t.labels ?? {};
  const tok = t.tokens ?? {};
  const tps = t.tokens_per_s ?? {};
  const parts = [];
  if (label) parts.push(item("Showing", esc(label), "", label, "tele__item--showing"));
  parts.push(item("Chunks", `${n(t.chunks)}${typeof t.max_chunks === "number" ? `<span class="tele__of"> of ${esc(fmtNum(t.max_chunks))}</span>` : ""}`, "planner context windows"));
  parts.push(item("Skipped", n(t.skipped_chunks), "measure steps, verified earlier", L.skipped_chunks ?? t.skipped_note ?? ""));
  const total = typeof tok.total === "number" ? tok.total : [tok.planner_in, tok.planner_out, tok.memo_in, tok.memo_out].every((x) => typeof x === "number") ? tok.planner_in + tok.planner_out + tok.memo_in + tok.memo_out : null;
  parts.push(item("Tokens", n(total), `<span class="label">measured</span> ${esc(fmtNum(tok.planner_in))} in / ${esc(fmtNum(tok.planner_out))} out`, L.tokens ?? ""));
  parts.push(item("Tok/s", n(tps.planner_median, 1), "<span class=\"label\">measured</span> median", L.tokens_per_s ?? ""));
  parts.push(item("Wall", typeof t.wall_s === "number" ? `<span class="tnum">${esc(fmtNum(t.wall_s, 1))}</span> s` : NOT_MEASURED, "<span class=\"label\">measured</span>", L.wall ?? ""));
  parts.push(item("Model", esc(t.model ?? "unknown"), `think ${t.think === true ? "on" : t.think === false ? "off" : "?"}, local`, "NVIDIA Nemotron 3 Nano 4B through Ollama on the loopback address"));
  parts.push(item("Planner", typeof t.planner_calls === "number" ? `${n(t.planner_valid)}<span class="tele__of"> / ${esc(fmtNum(t.planner_calls))} valid</span>` : NOT_MEASURED, typeof t.fallback_steps === "number" ? `${esc(fmtNum(t.fallback_steps))} host fallback steps` : ""));
  parts.push(item("Cloud model calls", n(t.cloud_model_calls ?? 0), "", "Zero by construction: the model client refuses any host that is not loopback"));
  return `<div class="tele">${parts.join("")}</div>`;
}

let el = null;
let shown = null;

async function load(runId) {
  if (!el) return;
  shown = runId;
  if (runId) {
    const r = await api(`/api/runs/${encodeURIComponent(runId)}/telemetry`);
    if (shown !== runId) return;
    el.innerHTML = r.ok && r.status !== 202 ? renderFooter(r.data, runWords(r.data)) : renderFooter(null, "", "counted when the run is saved");
  } else {
    const r = await api("/api/telemetry");
    if (shown !== runId) return;
    el.innerHTML = r.ok && r.data?.latest ? renderFooter(r.data.latest, `newest saved run: ${runWords(r.data.latest)}`) : renderFooter(null);
  }
}

/** The footer shows the run a screen is looking at; null shows the newest saved run. */
export function setFooterRun(runId) {
  load(runId ?? null);
}

export function mountFooter(target) {
  el = target;
}
