// The Discovery timeline: the run's event stream (GET /api/runs/:id/events) as chunk rows, the
// model's choice at every step (its plan, never a fact), the tool rows with their time, host
// fallback steps with the reason, and the measure steps a warm run skipped because the key was
// verified earlier (with the memory that recalled it). Live while the run runs, replayed from the
// saved run otherwise; the banner follows the stream's own header. The row renderers are pure.

import { api, eng, esc, fmtClock, fmtMs, fmtNum, fmtSgt, openRunStream, plural, quarterWords, renderError, runWords, toolWord } from "../lib.js";
import { questionFor } from "./ask.js";

const EV_REF = /\s*\[ev-r\d{8}T\d{6}[0-9a-f]{4}-\d{2,4}(?:,\s*ev-r\d{8}T\d{6}[0-9a-f]{4}-\d{2,4})*\]/gu;

/** A tool's fact line without its trailing evidence-id list (those go to engineering detail). */
export function stripRefs(text) {
  return String(text ?? "").replace(EV_REF, "");
}

/** Pure: one timeline row for a stream event, or "" for an event the timeline does not show. */
export function renderEvent(type, d = {}) {
  switch (type) {
    case "run_started":
      return `<li class="tl tl--start"><span class="tl__k">Run started</span> ${esc(d.mode === "warm" ? "warm" : d.mode === "cold" ? "cold" : "")} for ${esc(quarterWords(d.quarter))}${d.started_at_sgt || d.started_at ? ` at ${esc(fmtSgt(d.started_at_sgt ?? d.started_at))}` : ""} ${eng(`<code>${esc(d.run_id)}</code>`)}</li>`;
    case "chunk_start":
      return `<li class="tl tl--chunk" data-chunk="${esc(d.chunk)}"><span class="tl__chunk">Chunk ${esc(d.chunk)}</span>${d.recorded_at_sgt ? ` <span class="tl__t">${esc(fmtClock(d.recorded_at_sgt))} SGT</span>` : ""} <span class="muted">carries ${esc(fmtNum(d.carryover_tokens))} tokens of state into the model <span class="label">estimated</span></span></li>`;
    case "planner":
      if (d.valid === false)
        return `<li class="tl tl--plan tl--bad"><span class="tl__who">Model</span> <span class="cross">reply invalid</span> after ${esc(plural(d.attempts ?? 1, "attempt"))}; the host runs the next checklist step itself. <span class="tl__meta">${esc(fmtNum(d.prompt_tokens))} prompt / ${esc(fmtNum(d.eval_tokens))} out tokens</span></li>`;
      return `<li class="tl tl--plan"><span class="tl__who">Model</span> chose <strong>${esc(toolWord(d.tool))}</strong> ${eng(`<code>${esc(d.tool)}</code>`)}${d.thought ? ` <q class="tl__thought">${esc(d.thought)}</q> <span class="tl__meta">its plan, not a fact</span>` : ""} <span class="tl__meta">${esc(fmtNum(d.prompt_tokens))} prompt / ${esc(fmtNum(d.eval_tokens))} out tokens${d.tokens_per_s ? `, ${esc(fmtNum(d.tokens_per_s))} tok/s` : ""} <span class="label">measured</span></span></li>`;
    case "tool": {
      const fb = d.source === "fallback";
      const ids = Array.isArray(d.evidence_ids) ? d.evidence_ids : [];
      const fact = stripRefs(d.fact);
      const mw = d.tool === "measure_key" ? measureWords(fact) : { text: fact, ids: "" };
      return `<li class="tl tl--tool${fb ? " tl--fallback" : ""}${d.ok === false ? " tl--bad" : ""}" data-tool="${esc(d.tool)}"><span class="tl__who">${fb ? "Host" : "Tool"}</span> <strong>${esc(toolWord(d.tool))}</strong> ${d.ok === false ? `<span class="cross">failed</span>` : `<span class="tick">done</span>`} <span class="tl__fact">${esc(mw.text)}</span>${mw.ids ? ` ${eng(`<code>${esc(mw.ids)}</code>`)}` : ""}${fb && d.fallback_reason ? ` <span class="tl__meta">host fallback step: ${esc(d.fallback_reason)}</span>` : ""} ${eng(`<code>${esc(d.tool)}</code> ${ids.map((x) => `<code>${esc(x)}</code>`).join(" ")}`)}<span class="tl__ms">${esc(fmtMs(d.latency_ms))}</span></li>`;
    }
    case "chunk_end":
      return `<li class="tl tl--chunkend"><span class="muted">Chunk ${esc(d.chunk)} ends; ${esc(fmtNum(d.state_tokens))} tokens of state carried <span class="label">estimated</span>${d.complete ? "; checklist complete" : ""}</span></li>`;
    case "run_finished":
      return `<li class="tl tl--done"><span class="tl__k">Run finished</span> ${esc(plural(d.chunks ?? 0, "chunk"))}, ${esc(fmtMs(d.wall_ms))}${typeof d.utilities === "number" ? `, ${esc(plural(d.utilities, "utility", "utilities"))} in the answer` : ""}${typeof d.keys === "number" ? `, ${esc(plural(d.keys, "key"))} in the join map` : ""}${typeof d.skipped_steps === "number" && d.skipped_steps ? `, ${esc(fmtNum(d.skipped_steps))} measure steps skipped` : ""}.</li>`;
    case "run_failed":
      return `<li class="tl tl--bad"><span class="cross">Run failed</span> ${esc(d.error ?? "")}</li>`;
    default:
      return "";
  }
}

const SKIP_NOTE = /^measure_key (\S+) skipped: (\S+) \((.+?) ~ (.+?), (.+?)\) (VERIFIED|PARTIAL|REJECTED) (\d+)\/(\d+)(?: as (\S+))?/u;

const KEY_NAMES = {
  cik: "SEC company number: submissions against frames",
  cik_control: "SEC company number without the zero padding (control)",
  loc: "frames location against the headquarters state",
  station: "seed weather stations against the GHCN station list",
  sic: "industry code against the SIC reference",
  fema_state: "FEMA declaration state against the states the utilities serve",
  fema_fips: "FEMA state FIPS code against the state reference",
};

/** A join-map key route in words: "pair:<l>~<r>|<t>" or "<name>@<scope>". */
export function keyWords(route) {
  const s = String(route ?? "");
  const p = /^pair:(.+)~(.+)\|(.+)$/u.exec(s);
  if (p) return `${p[1]} to ${p[2]} (${p[3]})`;
  const n = /^([a-z_]+)@([A-Za-z0-9]+)$/u.exec(s);
  if (n && KEY_NAMES[n[1]]) return `${KEY_NAMES[n[1]]}${n[2] === "all" ? "" : `, ${n[2].replace(/^CY(\d{4})Q(\d)$/u, "Q$2 $1")}`}`;
  return s;
}

const MEASURE_FACT = /^(\w+) (\S+): ([\d.]+) (VERIFIED|PARTIAL|REJECTED)(?:, orphan (.+))?$/u;

/** A measure_key fact in words, with the proposal id and route kept for engineering detail. */
export function measureWords(fact) {
  const m = MEASURE_FACT.exec(String(fact ?? "").trim());
  if (!m) return { text: String(fact ?? ""), ids: "" };
  const rate = `${(Number(m[3]) * 100).toFixed(1)}%`;
  return { text: `${keyWords(m[2])}: ${m[4]} at ${rate} of the left table's rows${m[5] ? `; first orphan ${m[5]}` : ""}`, ids: `${m[1]} ${m[2]}` };
}

/** Pure: a skipped measure step (run.skipped_steps[i]) as a timeline row. */
export function renderSkipped(s) {
  const m = SKIP_NOTE.exec(String(s?.note ?? ""));
  const what = m ? `<code>${esc(m[3])}</code> to <code>${esc(m[4])}</code> (${esc(m[5])}): ${esc(m[6])}, ${esc(m[7])} of ${esc(m[8])} rows when it was measured` : esc(s?.note ?? "");
  return `<li class="tl tl--skip"><span class="tl__who">Skipped</span> <strong>skipped: verified earlier, memory ${esc(s?.memoryId ?? "?")}</strong> <span class="tl__fact">${what}</span> ${m ? eng(`<code>${esc(m[1])}</code> <code>${esc(m[2])}</code>${m[9] ? ` measured as <code>${esc(m[9])}</code>` : ""}`) : ""}</li>`;
}

/** Pure: the block of skipped rows with its heading line. */
export function renderSkippedBlock(steps) {
  const list = Array.isArray(steps) ? steps : [];
  if (!list.length) return "";
  return `<li class="tl tl--skiphead"><span class="tl__k">${esc(plural(list.length, "measure step"))} not run</span> <span class="muted">each key below was measured as VERIFIED by an earlier run and recalled from memory, so this run spent no planner step and no Lightning statement on it</span></li>${list.map(renderSkipped).join("")}`;
}

/** Pure: the counts line above the timeline from the events seen and the skipped steps. */
export function summaryLine(counts, skipped) {
  return `${plural(counts.chunks, "chunk")}, ${plural(counts.tools, "tool step")} (${fmtNum(counts.fallback)} by the host after an invalid model reply), ${plural(counts.planner, "model choice")}, ${fmtNum(skipped)} measure step${skipped === 1 ? "" : "s"} skipped as verified earlier`;
}

/** Where the skipped block goes: after the key proposals, else before the first measurement, else before the USL. */
function insertSkipped(list, html) {
  if (!html || list.querySelector(".tl--skiphead")) return;
  const after = [...list.querySelectorAll('[data-tool="propose_keys"]')].pop();
  if (after) return after.insertAdjacentHTML("afterend", html);
  const before = list.querySelector('[data-tool="measure_key"]') ?? list.querySelector('[data-tool="compile_usl"]');
  if (before) return before.insertAdjacentHTML("beforebegin", html);
  list.insertAdjacentHTML("beforeend", html);
}

export function mount(el, ctx) {
  ctx.setTitle?.("Discovery");
  const meta = ctx.meta;
  el.innerHTML = `<section class="tlv">
    <h1 class="view-h">Discovery <span class="view-h__sub">what the agent searched, probed, proposed and measured, step by step</span></h1>
    <div class="panel tlv__head">
      <p class="tlv__q">${meta?.question || meta?.quarter ? `<q>${esc(meta.question ?? questionFor(meta.quarter))}</q>` : ""}</p>
      <p class="tlv__sum" data-sum>Loading the stream…</p>
      <div class="tlv__ctl" data-ctl hidden>
        <button type="button" class="btn btn--small" data-pace="0">Show the whole run</button>
        <button type="button" class="btn btn--small" data-pace="350">Replay step by step</button>
      </div>
    </div>
    <ol class="tll" data-list aria-live="off"></ol>
  </section>`;
  const list = el.querySelector("[data-list]");
  const sum = el.querySelector("[data-sum]");
  const ctl = el.querySelector("[data-ctl]");
  let close = null;
  let alive = true;
  let skipped = [];
  let counts;

  const refreshSummary = (done) => {
    sum.textContent = `${summaryLine(counts, skipped.length)}${done ? "." : " so far."}`;
  };

  const loadSkipped = async () => {
    const r = await api(`/api/runs/${encodeURIComponent(ctx.run)}?slim=1`);
    if (!alive || !r.ok || r.status === 202) return;
    skipped = Array.isArray(r.data?.skipped_steps) ? r.data.skipped_steps : [];
    insertSkipped(list, renderSkippedBlock(skipped));
  };

  const start = (delayMs) => {
    close?.();
    list.innerHTML = "";
    counts = { chunks: 0, tools: 0, fallback: 0, planner: 0 };
    skipped = [];
    let mode = null;
    close = openRunStream(ctx.run, {
      delayMs,
      onEvent: (type, d) => {
        if (!alive) return;
        if (type === "stream") {
          mode = d.mode === "live" ? "live" : "replay";
          if (mode === "live") ctx.setBanner("live", `${runWords(meta ?? d)}: the agent is measuring now; rows appear as each step finishes.`);
          else ctx.setBanner("replay", `${runWords(meta ?? d)}. Replayed from the saved run: nothing is being measured now.`);
          ctl.hidden = mode === "live";
          return;
        }
        if (type === "chunk_start") counts.chunks++;
        if (type === "tool") {
          counts.tools++;
          if (d.source === "fallback") counts.fallback++;
        }
        if (type === "planner") counts.planner++;
        const html = renderEvent(type, d);
        if (html) list.insertAdjacentHTML("beforeend", html);
        if (mode === "live") list.lastElementChild?.scrollIntoView({ block: "nearest" });
        refreshSummary(false);
      },
      onEnd: async () => {
        if (!alive) return;
        await loadSkipped();
        refreshSummary(true);
        if (mode === "live") {
          await ctx.reloadRuns?.();
          ctx.setBanner("replay", `${runWords(meta)} finished. A saved run now: nothing is being measured.`);
          ctx.setFooterRun?.(ctx.run);
        }
      },
    });
  };

  ctl.addEventListener("click", (e) => {
    const b = e.target instanceof Element ? e.target.closest("[data-pace]") : null;
    if (b) start(Number(b.getAttribute("data-pace")) || 0);
  });

  if (!ctx.run) {
    el.innerHTML = renderError({ status: 404, data: { error: "no saved run yet: ask a question first" } });
    return () => {};
  }
  start(0);
  return () => {
    alive = false;
    close?.();
  };
}
