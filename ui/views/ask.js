// The Ask screen: the demo question (cold) and the warm question as presets, a question box that
// accepts only the one shape Crosswalk answers (the quarter is the only free part), and the saved
// runs to open. Asking starts a model run (POST /api/ask) and opens its live Discovery timeline.
// parseQuestion and the renderers are pure.

import { api, esc, fmtNum, quarterWords, renderError, runWords } from "../lib.js";

export const DEMO_QUESTION = "Which investor-owned electric utilities served states with FEMA major-disaster declarations in Q1 2025, what did the weather at their stations do that quarter, and did their revenue hold up year on year?";

export function questionFor(quarter) {
  const m = /^CY(\d{4})Q([1-4])$/u.exec(quarter);
  return m ? DEMO_QUESTION.replace("Q1 2025", `Q${m[2]} ${m[1]}`) : DEMO_QUESTION;
}

export const PRESETS = [
  { id: "cold", quarter: "CY2025Q1", mode: "cold", title: "Demo question, cold", note: "Starts with no remembered keys: the agent searches, probes, proposes and measures every key." },
  { id: "warm", quarter: "CY2024Q1", mode: "warm", title: "Warm question: the same for Q1 2024", note: "Reuses the keys verified earlier (their measure steps are skipped and counted) and registers in Zetaris any source the quarter still lacks." },
];

/**
 * The supported shape: the demo question with any quarter "Q<n> <yyyy>" (2000-2099). Returns
 * {ok, quarter} or {ok: false, reason}. The words around the quarter must be the demo question's.
 */
export function parseQuestion(text) {
  const t = String(text ?? "").trim().replace(/\s+/gu, " ");
  if (!t) return { ok: false, reason: "Type the question, or pick one of the two above." };
  const quarters = [...t.matchAll(/\bQ([1-4]) (20\d{2})\b/gu)];
  if (quarters.length !== 1) return { ok: false, reason: "Name exactly one quarter, written like Q1 2025." };
  const q = quarters[0];
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/gu, "").replace(/\s+/gu, " ").trim();
  const asked = norm(t.replace(q[0], "QUARTER"));
  const shape = norm(DEMO_QUESTION.replace("Q1 2025", "QUARTER"));
  if (asked !== shape) return { ok: false, reason: "Crosswalk answers one shape of question: the one below, with your quarter. Change only the quarter." };
  return { ok: true, quarter: `CY${q[2]}Q${q[1]}` };
}

function savedFor(runs, quarter, mode) {
  return runs.find((r) => r.quarter === quarter && r.mode === mode) ?? null;
}

export function renderPreset(p, saved, busy) {
  return `<article class="panel ask__preset" data-preset="${esc(p.id)}">
    <h2 class="panel__h">${esc(p.title)}</h2>
    <p class="ask__q"><q>${esc(questionFor(p.quarter))}</q></p>
    <p class="small muted">${esc(p.note)}</p>
    <div class="ask__btns">
      <button type="button" class="btn btn--primary" data-ask="${esc(p.id)}"${busy ? " disabled" : ""}>Ask now (runs the local model, about 3-5 minutes)</button>
      ${saved ? `<a class="btn" href="#/timeline/${esc(saved.run_id)}">Replay the saved run</a><span class="small muted">${esc(runWords(saved))}, ${esc(fmtNum(saved.wall_s, 1))} s</span>` : `<span class="small muted">No saved run of this question yet.</span>`}
    </div>
  </article>`;
}

export function renderRuns(runs) {
  if (!runs.length) return `<p class="muted">No saved run yet.</p>`;
  return `<div class="table-wrap"><table class="runs">
    <thead><tr><th scope="col">Run</th><th scope="col">Question quarter</th><th scope="col" class="r">Wall</th><th scope="col" class="r">Utilities</th><th scope="col" class="r">Keys</th><th scope="col" class="r">Measure steps skipped</th><th scope="col">Open</th></tr></thead>
    <tbody>${runs
      .slice(0, 12)
      .map(
        (r) => `<tr><td>${esc(runWords(r))} <span class="eng"><code>${esc(r.run_id)}</code></span></td><td>${esc(quarterWords(r.quarter))}</td><td class="r tnum">${esc(fmtNum(r.wall_s, 1))} s</td><td class="r tnum">${esc(fmtNum(r.utilities))}</td><td class="r tnum">${esc(fmtNum(r.keys))}</td><td class="r tnum">${esc(fmtNum(r.skipped))}</td><td class="runs__open"><a href="#/timeline/${esc(r.run_id)}">Discovery</a> <a href="#/joinmap/${esc(r.run_id)}">Join map</a> <a href="#/answer/${esc(r.run_id)}">Answer</a></td></tr>`,
      )
      .join("")}</tbody>
  </table></div>`;
}

export function mount(el, ctx) {
  ctx.setTitle?.("Ask");
  let alive = true;
  const paint = () => {
    const runs = ctx.runs();
    const running = ctx.running();
    el.innerHTML = `<section class="ask">
      <h1 class="view-h">Ask <span class="view-h__sub">one cross-agency question: FEMA disasters, NOAA weather and SEC revenue, joined by keys the agent measures itself</span></h1>
      ${running ? `<p class="msg" role="status">A run is in progress (${esc(runWords(running))}). <a href="#/timeline/${esc(running.run_id)}">Watch it live</a>.</p>` : ""}
      <div class="ask__grid">${PRESETS.map((p) => renderPreset(p, savedFor(runs, p.quarter, p.mode), !!running)).join("")}</div>
      <form class="panel ask__free" data-free novalidate>
        <h2 class="panel__h"><label for="q">Your quarter</label> <span class="panel__note">the same question for any quarter; the agent registers in Zetaris what that quarter needs</span></h2>
        <textarea id="q" name="q" rows="3" spellcheck="false">${esc(DEMO_QUESTION)}</textarea>
        <div class="ask__btns">
          <fieldset class="ask__mode"><legend class="sr-only">Memory</legend>
            <label><input type="radio" name="mode" value="warm" checked> Warm: reuse keys verified earlier</label>
            <label><input type="radio" name="mode" value="cold"> Cold: measure every key again</label>
          </fieldset>
          <button type="submit" class="btn btn--primary"${running ? " disabled" : ""}>Ask now</button>
        </div>
        <p class="ask__check small" data-check aria-live="polite"></p>
      </form>
      <div data-msg></div>
      <div class="panel"><h2 class="panel__h">Saved runs <span class="panel__note">open any of them; a saved run is shown as a replay</span></h2>${renderRuns(runs)}</div>
    </section>`;
    const form = el.querySelector("[data-free]");
    const box = form.querySelector("textarea");
    const check = form.querySelector("[data-check]");
    const show = () => {
      const p = parseQuestion(box.value);
      check.textContent = p.ok ? `Understood: ${quarterWords(p.quarter)}, compared with the same quarter a year earlier.` : p.reason;
      check.dataset.ok = p.ok ? "1" : "0";
      return p;
    };
    show();
    box.addEventListener("input", show);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const p = show();
      if (!p.ok) return;
      start(p.quarter, form.querySelector("input[name=mode]:checked")?.value ?? "warm");
    });
    el.querySelectorAll("[data-ask]").forEach((b) =>
      b.addEventListener("click", () => {
        const p = PRESETS.find((x) => x.id === b.getAttribute("data-ask"));
        if (p) start(p.quarter, p.mode);
      }),
    );
  };
  const start = async (quarter, mode) => {
    const msg = el.querySelector("[data-msg]");
    msg.innerHTML = `<p class="msg" role="status">Starting a ${esc(mode)} run for ${esc(quarterWords(quarter))}…</p>`;
    const r = await api("/api/ask", { body: { quarter, mode } });
    if (!alive) return;
    if (!r.ok) {
      msg.innerHTML = renderError(r);
      return;
    }
    await ctx.reloadRuns();
    location.hash = `#/timeline/${r.data.run_id}`;
  };
  paint();
  return () => {
    alive = false;
  };
}
