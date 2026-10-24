// The investigation timeline: chunk rows, planner steps (the model's plan, never a fact) and tool
// steps with their latency, both live from server-sent events and replayed from a saved run.
// renderStreamEvent and replayRows are pure.

import { esc, evidenceChips, fmtClock, fmtMs, fmtNum, on, stripEvidenceRefs, toolWord } from "../lib.js";

const LIVE_TYPES = ["run_started", "chunk_start", "planner", "tool", "chunk_end", "run_finished", "run_failed"];

/**
 * The row shown while something runs: a tool (get_weather gets its own words because the two
 * statements take ~18 s each) or, with tool null, the planner call in progress on the model.
 */
export function pendingRow(tool, startedAt) {
  const weather = tool === "get_weather";
  const text = tool === null ? "Planner call in progress" : weather ? "Computing degree days in Lightning SQL" : `Running ${toolWord(tool)}`;
  const note = tool === null ? "the model reads the carried state and the last tool result, then names the next step" : weather ? "two <code>weather_quarter</code> statements over the station union, about 18 s each" : "";
  return `<li class="s s--pending" data-pending="${esc(tool ?? "planner")}" role="status"><span class="s__t">${esc(fmtClock(startedAt))}</span><span class="s__b"><span class="s__spin" aria-hidden="true"></span><span class="s__k">${esc(text)}</span>${note ? ` <span class="s__m">${note}</span>` : ""} <span class="s__m s__elapsed" data-since="${esc(startedAt)}"></span></span></li>`;
}

function timeCell(at) {
  return at ? `<time class="s__t" datetime="${esc(at)}">${esc(fmtClock(at))}</time>` : `<span class="s__t"></span>`;
}

/** One timeline row, or "" for an event the timeline does not show. */
export function renderStreamEvent(type, d = {}, at = d.at) {
  const t = timeCell(at);
  const line = (cls, body, extra = "") => `<li class="s s--${cls}"${extra}>${t}${body}</li>`;
  switch (type) {
    case "run_started":
      return line("start", `<span class="s__b"><span class="s__k">Run started</span> ${d.utility ? esc(d.utility) : d.cik ? `CIK <code>${esc(d.cik)}</code>` : ""}${d.period ? `, ${esc(d.period)}` : ""}${d.claim ? `, claim <q>${esc(d.claim)}</q>` : ""}${d.run_id ? ` <span class="s__m">run <code>${esc(d.run_id)}</code></span>` : ""}</span>`);
    case "chunk_start":
      return line("chunk", `<span class="s__b"><span class="s__chunk">Chunk ${esc(d.chunk)}</span> starts with ${esc(fmtNum(d.carryover_tokens))} tokens of carried state <span class="label">estimated (chars/4)</span></span>`);
    case "planner":
      return line(
        d.valid === false ? "fail" : "plan",
        `<span class="s__b"><span class="s__k">Planner</span> ${d.valid === false ? `<span class="cross">reply invalid</span>` : `chose <code>${esc(d.tool ?? "no tool")}</code>`}${d.thought ? `<span class="s__plan"><span class="s__plank">Plan:</span> <q>${esc(d.thought)}</q> <span class="s__m">(the model's plan, not a fact)</span></span>` : ""} <span class="s__m">${esc(fmtNum(d.prompt_tokens))} prompt / ${esc(fmtNum(d.eval_tokens))} out tokens <span class="label">measured</span>${Number(d.attempts) > 1 ? `, ${esc(d.attempts)} attempts` : ""}${d.tokens_per_s ? `, ${esc(fmtNum(d.tokens_per_s))} tok/s` : ""}</span></span>`,
      );
    case "tool":
      return line(
        d.ok === false ? "fail" : d.source === "fallback" ? "fallback" : "tool",
        `<span class="s__b"><span class="s__k">${d.source === "fallback" ? "Host fallback step" : "Tool"}</span> <code>${esc(d.tool)}</code> <span class="s__word">${esc(toolWord(d.tool))}</span> ${d.ok === false ? `<span class="cross" aria-label="failed">failed</span>` : `<span class="tick" aria-label="succeeded">done</span>`} ${esc(stripEvidenceRefs(d.fact))} ${evidenceChips(d.run_id ?? null, d.evidence_ids, { max: 4 })}${d.fallback_reason ? ` <span class="s__m s__fb">fallback because ${esc(d.fallback_reason)}</span>` : ""} <span class="s__lat">${esc(fmtMs(d.latency_ms))}</span></span>`,
        ` data-tool-done="${esc(d.tool)}"`,
      );
    case "chunk_end":
      return line("chunk", `<span class="s__b"><span class="s__chunk">Chunk ${esc(d.chunk)} ends</span> state ${esc(fmtNum(d.state_tokens))} tokens <span class="label">estimated (chars/4)</span>${d.complete ? ", checklist complete" : ""}</span>`);
    case "run_finished":
      return line("done", `<span class="s__b"><span class="s__k">Run finished</span>${d.verdict ? ` claim ${esc(d.verdict)}` : ""}${d.confidence ? `, confidence ${esc(d.confidence)}` : ""}${d.chunks ? `, ${esc(d.chunks)} chunks` : ""}${d.wall_ms ? `, ${esc(fmtMs(d.wall_ms))}` : ""}${d.run_id ? ` <a class="s__open" href="#/card/${esc(d.run_id)}">Open the answer card</a>` : ""}</span>`);
    case "run_failed":
      return line("fail", `<span class="s__b"><span class="cross">Run failed</span> ${esc(d.error ?? "")}${d.run_id ? ` <span class="s__m">run <code>${esc(d.run_id)}</code></span>` : ""}</span>`);
    default:
      return "";
  }
}

/**
 * The saved run's timeline as rows: each chunk's planner calls (from run.planner_calls) and tool
 * steps (from run.timeline) in order, with the chunk boundaries from run.chunks.
 */
export function replayRows(run) {
  if (!run) return "";
  const planners = Array.isArray(run.planner_calls) ? run.planner_calls : [];
  const steps = Array.isArray(run.timeline) ? run.timeline : [];
  const chunks = Array.isArray(run.chunks) ? run.chunks : [];
  const out = [];
  out.push(renderStreamEvent("run_started", { run_id: run.run_id, utility: run.card?.utility?.name, cik: run.cik, period: run.period, claim: run.claim }, run.started_at));
  const chunkNos = [...new Set([...planners.map((p) => p.chunk), ...steps.map((s) => s.chunk)])].sort((a, b) => a - b);
  for (const n of chunkNos) {
    const c = chunks.find((x) => x.chunk === n);
    out.push(renderStreamEvent("chunk_start", { chunk: n, carryover_tokens: c?.carryover_in_tokens ?? 0 }, c?.started_at));
    const ps = planners.filter((p) => p.chunk === n);
    const ts = steps.filter((s) => s.chunk === n);
    // In a chunk the sequence is planner call, tool, planner call, tool; the fallback step has no planner call of its own.
    const max = Math.max(ps.length, ts.length);
    for (let i = 0; i < max; i++) {
      const p = ps[i];
      if (p) out.push(renderStreamEvent("planner", { chunk: n, call: p.call, valid: p.valid, attempts: p.attempts, tool: p.chosen?.tool ?? null, thought: p.thought, prompt_tokens: p.prompt_tokens, eval_tokens: p.eval_tokens, tokens_per_s: p.tokens_per_s }));
      const s = ts[i];
      if (s) out.push(renderStreamEvent("tool", { run_id: run.run_id, chunk: n, seq: s.seq, tool: s.tool, source: s.source, fallback_reason: s.fallback_reason, ok: s.ok, fact: s.fact, evidence_ids: s.evidence_ids, latency_ms: s.latency_ms }));
    }
    out.push(renderStreamEvent("chunk_end", { chunk: n, state_tokens: c?.carryover_out_tokens ?? null, complete: c?.task_complete === true }));
  }
  out.push(renderStreamEvent("run_finished", { run_id: run.run_id, verdict: run.card?.verdict?.verdict, confidence: run.card?.verdict?.confidence, chunks: run.markovian?.chunks ?? chunks.length, wall_ms: run.wall_ms }, run.finished_at));
  return out.join("");
}

/**
 * Appends live events to a list as they arrive and keeps the pending-tool row up to date. filter(type,
 * data) picks the events (a run id). Returns the unsubscribe function.
 */
export function mountStream(listEl, { filter = () => true, keep = 600, onEvent } = {}) {
  let pending = null;
  let timer = null;
  const tick = () => {
    const el = listEl.querySelector(".s__elapsed[data-since]");
    if (!el) return;
    const since = Date.parse(el.getAttribute("data-since"));
    if (!Number.isNaN(since)) el.textContent = `${fmtNum((Date.now() - since) / 1000, 0)} s so far`;
  };
  const clearPending = () => {
    listEl.querySelector("[data-pending]")?.remove();
    pending = null;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
  const offs = LIVE_TYPES.map((type) =>
    on(type, (d) => {
      if (!filter(type, d)) return;
      const at = d.at ?? new Date().toISOString();
      const atBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 40;
      clearPending();
      const html = renderStreamEvent(type, d, at);
      if (html) listEl.insertAdjacentHTML("beforeend", html);
      // What runs next: the chosen tool after a planner reply; the next planner call after a tool
      // result or at a chunk start; nothing once the run is over or a chunk has ended.
      let next;
      if (type === "planner" && d.valid !== false && d.tool && d.tool !== "finalize_noop") next = d.tool;
      else if (type === "tool" || type === "chunk_start" || type === "run_started" || (type === "planner" && d.valid === false)) next = null;
      if (next !== undefined) {
        pending = next ?? "planner";
        listEl.insertAdjacentHTML("beforeend", pendingRow(next, at));
        timer = setInterval(tick, 1000);
      }
      while (listEl.children.length > keep) listEl.firstElementChild.remove();
      if (atBottom) listEl.scrollTop = listEl.scrollHeight;
      onEvent?.(type, d);
    }),
  );
  return () => {
    offs.forEach((f) => f());
    if (timer) clearInterval(timer);
  };
}
