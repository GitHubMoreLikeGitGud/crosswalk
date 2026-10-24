// Ask: the utility picker (saved runs and the 43 seeds), period and claim, the live timeline of
// the run from server-sent events, and the saved runs to open. A saved run's own timeline is
// replayed here when no run is live.

import { api, confidenceChip, esc, fmtMs, fmtNum, fmtTime, refreshChipKinds, renderError, tag, verdictChip } from "../lib.js";
import { listRuns, loadRun, pickRunId, setCurrentRun } from "./runs.js";
import { mountStream, replayRows } from "./stream.js";

const PERIODS = [];
for (const y of [2025, 2024, 2023]) for (const q of [1, 2, 3]) PERIODS.push(`CY${y}Q${q}`);

const CLAIMS = ["colder weather", "favorable weather", "milder weather", "warmer weather", "unfavorable weather"];

let seedsCache = null;

/** The 43 seed utilities, from whichever path the server exposes them on; empty when none does. */
async function loadSeeds() {
  if (seedsCache) return seedsCache;
  for (const p of ["/api/seeds", "/seeds/utilities.json"]) {
    const r = await api(p);
    if (r.ok && r.data) {
      const list = Array.isArray(r.data) ? r.data : Array.isArray(r.data.utilities) ? r.data.utilities : [];
      if (list.length) {
        seedsCache = list;
        return list;
      }
    }
  }
  return [];
}

function utilityOptions(seeds, runs) {
  const seen = new Set();
  const withRun = new Set(runs.map((r) => r.cik));
  const opts = [];
  for (const s of seeds) {
    if (!s?.cik || seen.has(s.cik)) continue;
    seen.add(s.cik);
    opts.push({ cik: s.cik, name: s.name, ticker: s.ticker, hasRun: withRun.has(s.cik), flags: Array.isArray(s.flags) ? s.flags : [] });
  }
  for (const r of runs) {
    if (!r?.cik || seen.has(r.cik)) continue;
    seen.add(r.cik);
    opts.push({ cik: r.cik, name: r.utility ?? r.cik, ticker: null, hasRun: true, flags: [] });
  }
  opts.sort((a, b) => Number(b.hasRun) - Number(a.hasRun) || String(a.name).localeCompare(String(b.name)));
  return opts;
}

export function renderRunsTable(runs) {
  if (!runs.length) return `<p class="muted">No saved runs yet. Ask a question above, or run the CLI's <code>ask</code> command.</p>`;
  return `<div class="table-wrap"><table class="runs"><thead><tr><th scope="col">Started</th><th scope="col">Utility</th><th scope="col">Period</th><th scope="col">Claim</th><th scope="col">Verdict</th><th scope="col">Chunks</th><th scope="col">Wall</th><th scope="col">Memo</th><th scope="col"><span class="sr-only">Open</span></th></tr></thead><tbody>${runs
    .map(
      (r) => `<tr data-run-row="${esc(r.run_id)}"><td class="tnum">${esc(fmtTime(r.started_at))}</td><td><strong>${esc(r.utility ?? r.cik)}</strong><br><code class="small">${esc(r.cik)}</code></td><td class="tnum">${esc(r.period)}</td><td><q>${esc(r.claim)}</q></td><td>${verdictChip(r.verdict)} ${confidenceChip(r.confidence, { bare: true })}</td><td class="tnum">${esc(fmtNum(r.chunks))}</td><td class="tnum">${esc(fmtMs(r.wall_ms))}</td><td>${r.memo_source ? tag(`${r.memo_source} memo`, r.memo_source === "model" ? "model" : "neutral") : ""}</td><td><a class="btn btn--small" href="#/card/${esc(r.run_id)}">Open card</a> <button type="button" class="btn btn--small btn--ghost" data-replay="${esc(r.run_id)}">Timeline</button></td></tr>`,
    )
    .join("")}</tbody></table></div>`;
}

export function mount(el, ctx) {
  el.innerHTML = `
    <h1 class="view-h">Ask</h1>
    <div class="ask">
      <form class="panel ask__form" id="ask-form" aria-labelledby="ask-h">
        <h2 class="panel__h" id="ask-h">Why did this utility's revenue change?</h2>
        <p class="small muted">The agent reads the two quarters' revenue through Zetaris, computes degree days in Lightning SQL, loads the peer set, and splits the change into a weather part, an industry part and a remainder, each with a bootstrap range. Nothing is computed by the model.</p>
        <div class="field"><label class="field__label" for="utility">Utility</label><select id="utility" name="utility" required><option value="">Loading the utilities…</option></select><p class="small muted" id="utility-note"></p></div>
        <div class="field field--row">
          <div><label class="field__label" for="period">Period (quarter)</label><select id="period" name="period">${PERIODS.map((p) => `<option value="${p}"${p === "CY2025Q1" ? " selected" : ""}>${p}</option>`).join("")}</select><p class="small muted">Compared with the same quarter a year earlier. The frames API has no three-month fourth quarter.</p></div>
          <div><label class="field__label" for="max_chunks">Max chunks</label><input id="max_chunks" name="max_chunks" type="number" min="1" max="10" value="10" inputmode="numeric"></div>
        </div>
        <div class="field"><label class="field__label" for="claim">Management's claim (optional)</label><input id="claim" name="claim" type="text" list="claims" value="colder weather" maxlength="120" autocomplete="off"><datalist id="claims">${CLAIMS.map((c) => `<option value="${esc(c)}">`).join("")}</datalist><p class="small muted">The words from the filing or the call that credit the weather; the verdict tests them against the weather part.</p></div>
        <div class="act__buttons"><button type="submit" class="btn btn--primary" id="ask-go">Ask</button><span id="ask-status" class="small" role="status"></span></div>
        <div id="ask-msg"></div>
      </form>
      <section class="panel ask__live" aria-labelledby="live-h">
        <h2 class="panel__h" id="live-h">Investigation timeline <span class="panel__note" id="live-note">live from the agent's server-sent events</span></h2>
        <ol class="stream" id="stream" aria-label="Investigation steps"></ol>
        <p class="small muted">Planner lines quote the model's plan as written; only tool lines carry facts, each with its evidence. Chunk boundaries are the Markovian chain's: the next chunk sees only the carried state.</p>
      </section>
    </div>
    <section class="panel" aria-labelledby="runs-h">
      <h2 class="panel__h" id="runs-h">Saved runs <span class="panel__note">render fully with the model off</span></h2>
      <div id="runs"></div>
    </section>`;

  const stream = el.querySelector("#stream");
  const note = el.querySelector("#live-note");
  const status = el.querySelector("#ask-status");
  const msg = el.querySelector("#ask-msg");
  const select = el.querySelector("#utility");
  let liveRun = null;
  let runs = [];

  const showReplay = async (id) => {
    const r = await loadRun(id);
    if (!r.ok) {
      stream.innerHTML = `<li class="s s--fail"><span class="s__t"></span><span class="s__b">${esc(r.data?.error ?? "run not found")}</span></li>`;
      return;
    }
    stream.innerHTML = replayRows(r.data);
    note.textContent = `replayed from the saved run ${id} (${r.data.card?.utility?.name ?? r.data.cik}, ${r.data.period})`;
    stream.scrollTop = 0;
  };

  const refreshRuns = async () => {
    const res = await listRuns();
    runs = res.runs;
    el.querySelector("#runs").innerHTML = res.ok ? renderRunsTable(runs) : renderError(res.res);
    return runs;
  };

  (async () => {
    const [seeds] = await Promise.all([loadSeeds(), refreshRuns()]);
    const opts = utilityOptions(seeds, runs);
    if (!opts.length) {
      select.innerHTML = `<option value="">No utilities listed</option>`;
      el.querySelector("#utility-note").textContent = "The seed list is not served at /api/seeds or /seeds/utilities.json and no run is saved yet.";
    } else {
      select.innerHTML = opts.map((o) => `<option value="${esc(o.cik)}">${esc(o.name)}${o.ticker ? ` (${esc(o.ticker)})` : ""}, CIK ${esc(o.cik)}${o.hasRun ? ", has a saved run" : ""}${o.flags.length ? `, ${esc(o.flags.join(", "))}` : ""}</option>`).join("");
      const fe = opts.find((o) => o.cik === "0001031296");
      if (fe) select.value = fe.cik;
      el.querySelector("#utility-note").textContent = seeds.length ? `${opts.length} seed utilities; ${opts.filter((o) => o.hasRun).length} with a saved run.` : `Seed list not served; ${opts.length} utilities from the saved runs.`;
    }
    const id = await pickRunId(ctx.params.run);
    if (id && !liveRun) showReplay(id);
  })();

  const form = el.querySelector("#ask-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const cik = select.value;
    if (!cik) return;
    const body = { cik, period: el.querySelector("#period").value };
    const claim = el.querySelector("#claim").value.trim();
    if (claim) body.claim = claim;
    const mc = Number(el.querySelector("#max_chunks").value);
    if (Number.isInteger(mc) && mc > 0 && mc < 10) body.max_chunks = mc;
    const go = el.querySelector("#ask-go");
    go.disabled = true;
    status.textContent = "Starting the run…";
    msg.innerHTML = "";
    const r = await api("/api/ask", { body });
    go.disabled = false;
    if (r.status === 202 || (r.ok && r.data?.run_id)) {
      liveRun = r.data.run_id;
      setCurrentRun(liveRun);
      stream.innerHTML = "";
      note.textContent = `live, run ${liveRun}`;
      status.textContent = `Run ${liveRun} accepted; the steps appear below as they happen.`;
      ctx.announce(`Run ${liveRun} started`);
    } else if (r.status === 409) {
      status.textContent = "";
      msg.innerHTML = `<p class="msg msg--warn" role="alert">The agent is busy with run <code>${esc(r.data?.busy_run_id ?? "")}</code>; one model job runs at a time. <button type="button" class="btn btn--small" data-replay="${esc(r.data?.busy_run_id ?? "")}" data-follow="yes">Follow it</button></p>`;
    } else {
      status.textContent = "";
      msg.innerHTML = renderError(r);
    }
  });

  el.addEventListener("click", (e) => {
    const b = e.target instanceof Element ? e.target.closest("[data-replay]") : null;
    if (!b) return;
    const id = b.getAttribute("data-replay");
    if (!id) return;
    if (b.getAttribute("data-follow") === "yes") {
      liveRun = id;
      stream.innerHTML = "";
      note.textContent = `live, run ${id} (joined in progress)`;
      return;
    }
    liveRun = null;
    setCurrentRun(id);
    showReplay(id);
    stream.focus?.();
  });

  const off = mountStream(stream, {
    filter: (type, d) => {
      if (!liveRun) {
        if (type === "run_started" && d.run_id) {
          liveRun = d.run_id;
          stream.innerHTML = "";
          note.textContent = `live, run ${d.run_id}`;
          return true;
        }
        return false;
      }
      return !d.run_id || d.run_id === liveRun;
    },
    onEvent: (type, d) => {
      if (type === "run_finished") {
        const finished = d.run_id ?? liveRun;
        status.innerHTML = `Run <code>${esc(finished)}</code> finished. <a href="#/card/${esc(finished)}">Open the answer card</a>.`;
        ctx.announce("Run finished; the answer card is ready.");
        if (d.run_id) setCurrentRun(d.run_id);
        refreshRuns();
        // The saved run names each evidence record's kind; the live chips learn it now.
        if (finished) loadRun(finished).then((r) => r.ok && refreshChipKinds(stream));
        liveRun = null;
      } else if (type === "run_failed") {
        status.textContent = `Run failed: ${d.error ?? ""}`;
        liveRun = null;
      }
    },
  });
  ctx.setTitle("Ask");
  return () => off();
}
