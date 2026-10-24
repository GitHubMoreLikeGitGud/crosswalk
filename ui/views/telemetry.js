// The telemetry footer: model, think, planner calls and validity, fallback steps, measured vs naive
// prompt tokens per chunk (small inline bars), median tok/s, cloud model calls, refused hosts. From
// GET /api/telemetry (the latest run) or from the run a screen is showing. renderFooter is pure.

import { api, esc, fmtNum, on } from "../lib.js";

const NOT_MEASURED = `<span class="nm">not measured</span>`;

function item(k, v, note = "", title = "", cls = "") {
  return `<div class="tele__item${cls ? ` ${cls}` : ""}"${title ? ` title="${esc(title)}"` : ""}><span class="tele__k">${esc(k)}</span><span class="tele__v">${v}</span>${note ? `<span class="tele__n">${note}</span>` : ""}</div>`;
}

/** Per-chunk bars: measured prompt tokens (solid) against the naive full-history estimate (outline). */
export function renderChunkBars(chart) {
  const pts = (Array.isArray(chart) ? chart : []).filter((p) => p && Number.isFinite(Number(p.chunk)));
  if (!pts.length) return NOT_MEASURED;
  const max = Math.max(1, ...pts.flatMap((p) => [Number(p.markovian_prompt_tokens_measured) || 0, Number(p.naive_prompt_tokens_estimated) || 0]));
  const H = 26;
  const bw = 7;
  const gap = 3;
  const W = pts.length * (bw * 2 + gap + 4);
  let x = 0;
  const bars = pts
    .map((p) => {
      const m = Number(p.markovian_prompt_tokens_measured) || 0;
      const n = Number(p.naive_prompt_tokens_estimated) || 0;
      const hm = (m / max) * (H - 2);
      const hn = (n / max) * (H - 2);
      const s = `<rect class="bars__n" x="${x}" y="${(H - hn).toFixed(1)}" width="${bw}" height="${hn.toFixed(1)}"/><rect class="bars__m" x="${x + bw + 1}" y="${(H - hm).toFixed(1)}" width="${bw}" height="${hm.toFixed(1)}"/>`;
      x += bw * 2 + gap + 4;
      return s;
    })
    .join("");
  const label = `Prompt tokens per chunk: measured ${pts.map((p) => fmtNum(p.markovian_prompt_tokens_measured)).join(", ")}; the full-history baseline would be ${pts.map((p) => fmtNum(p.naive_prompt_tokens_estimated)).join(", ")} (estimated, chars/4)`;
  return `<svg class="bars" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(label)}">${bars}</svg>`;
}

/**
 * Pure: the footer from {summary, telemetry, chart, run_id} (the /api/telemetry envelope or a run.json,
 * which carries the same three fields).
 */
export function renderFooter(t, opts = {}) {
  if (!t || typeof t !== "object") return `<div class="tele">${item("Telemetry", NOT_MEASURED)}</div>`;
  const s = t.summary ?? {};
  const tm = t.telemetry ?? {};
  const chart = Array.isArray(t.chart) ? t.chart : [];
  const parts = [];
  parts.push(item("Model", esc(tm.model ?? t.model ?? "unknown"), `think ${tm.think === true ? "on" : tm.think === false ? "off" : "?"}, local Ollama`, "NVIDIA Nemotron 3 Nano 4B through Ollama on 127.0.0.1; every model URL is checked for a loopback host"));
  const calls = s.planner_calls;
  parts.push(item("Planner calls", calls === undefined ? NOT_MEASURED : `<span class="tnum">${esc(fmtNum(calls))}</span>`, calls === undefined ? "" : `${esc(fmtNum(s.planner_valid_first_try))} valid first try, ${esc(fmtNum(s.planner_repaired ?? 0))} repaired${s.planner_repairs_think_off ? ` (${esc(fmtNum(s.planner_repairs_think_off))} think off)` : ""}`, "A planner reply is valid when it parses and matches the schema; a repair round re-asks once with the errors named, with thinking off after an empty length-cut reply"));
  parts.push(item("Fallback steps", s.fallback_steps === undefined ? NOT_MEASURED : `<span class="tnum">${esc(fmtNum(s.fallback_steps))}</span>`, "run by the host", "When the planner fails twice the host runs the checklist's next step itself; the card is the same, the step is marked"));
  parts.push(item("Prompt per chunk", renderChunkBars(chart), chart.length ? `<span class="label">measured</span> vs <span class="label">naive est.</span>${typeof s.saving_vs_naive_estimated === "number" ? `, ${esc(fmtNum(s.saving_vs_naive_estimated * 100))}% less` : ""}` : "", "Solid bar: the Markovian prompt actually sent (measured by Ollama); outline bar: what a full-history prompt would have been (estimated, chars/4)", "tele__item--bars"));
  const tps = s.median_planner_tokens_per_s ?? tm.median_planner_tokens_per_s;
  parts.push(item("Median tok/s", tps ? `<span class="tnum">${esc(fmtNum(tps))}</span>` : NOT_MEASURED, tps ? `<span class="label">measured</span>${tm.memo_tokens_per_s ? `, memo ${esc(fmtNum(tm.memo_tokens_per_s))}` : ""}` : ""));
  parts.push(item("Cloud model calls", `<span class="tnum">${esc(fmtNum(tm.cloud_model_calls ?? 0))}</span>`, "", "Zero by construction: the model client refuses any host that is not loopback"));
  const refused = (Number(tm.refused_model_hosts) || 0) + (Number(tm.refused_gateway_hosts) || 0);
  parts.push(item("Refused hosts", `<span class="tnum">${esc(fmtNum(refused))}</span>`, tm.refused_model_hosts !== undefined ? `${esc(fmtNum(tm.refused_model_hosts))} model, ${esc(fmtNum(tm.refused_gateway_hosts ?? 0))} gateway` : ""));
  const which = opts.runId ?? t.run_id;
  if (which) parts.push(item("Run", `<code class="tele__run">${esc(which)}</code>`, opts.label ?? "latest run", ""));
  return `<div class="tele">${parts.join("")}</div>`;
}

let el = null;
let pinned = null;

async function loadLatest() {
  if (!el) return;
  const r = await api("/api/telemetry");
  el.innerHTML = r.ok ? renderFooter(r.data) : `<div class="tele">${item("Telemetry", `<span class="nm">${esc(r.data?.error ?? "not available")}</span>`)}</div>`;
}

/** The footer shows the run a screen is looking at; null goes back to the latest run. */
export function setFooterRun(run) {
  pinned = run ?? null;
  if (!el) return;
  if (pinned) el.innerHTML = renderFooter(pinned, { runId: pinned.run_id, label: "run shown" });
  else loadLatest();
}

/** Mounts the footer and refreshes it whenever a run finishes. Returns the unsubscribe function. */
export function mountFooter(target) {
  el = target;
  loadLatest();
  return on("run_finished", () => {
    pinned = null;
    loadLatest();
  });
}
