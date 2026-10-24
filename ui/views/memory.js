// Memory and why: the H-MEM memory ids of the run, the why trace of any memory, the restatement
// conflicts with both accession numbers and the rule (live status from GET /api/conflicts), and the
// analyst's override (signed contract, then POST /api/override, then an optional re-run).

import { api, esc, evidenceChips, fmtMillions, fmtTime, idHtml, linkEvidenceIds, linkMemoryIds, renderError, tagShort } from "../lib.js";
import { openDrawer, pushDrawer, updateDrawer } from "./drawer.js";
import { forgetRun, liveConflicts, loadRun, overlayConflicts, pickRunId, setCurrentRun } from "./runs.js";

/** The rule's wording without the repeated "R1:" prefix (the rule id is shown beside it). */
export function ruleWording(c) {
  const t = String(c?.rule_text ?? "");
  const p = `${c?.rule ?? ""}:`;
  return c?.rule && t.startsWith(p) ? t.slice(p.length).trim() : t;
}

/** A ledger entry's details as "key value" pairs (scalars; a filing side by its accession number). */
function detailText(d) {
  if (d === null || d === undefined) return "";
  if (typeof d !== "object") return String(d);
  const parts = [];
  for (const [k, v] of Object.entries(d)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "object") {
      if (v && typeof v.accn === "string") parts.push(`${k} ${v.accn}`);
      continue;
    }
    parts.push(`${k} ${v}`);
  }
  return parts.join(", ");
}

/** Pure: the why trace as the drawer or panel shows it. */
export function renderWhy(memId, t) {
  if (!t || typeof t !== "object") return `<p class="muted">No trace.</p>`;
  const lines = Array.isArray(t.lines) ? t.lines : [];
  const m = t.memory;
  const p = t.provenance;
  const ledger = Array.isArray(t.ledger) ? t.ledger : [];
  const conflicts = Array.isArray(t.conflicts) ? t.conflicts : [];
  const placeholder = p && /\{(tag|period|cik10|year)\}/u.test(String(p.zetaris_object ?? ""));
  return `<div class="why">
    <ol class="why__lines">${lines.map((l) => `<li>${linkEvidenceIds(l)}</li>`).join("")}</ol>
    ${m ? `<dl class="kv"><div class="kv__row"><dt>Memory</dt><dd><code>${esc(m.id ?? memId)}</code> ${esc(m.type ?? "")} <span class="muted">source ${esc(m.source ?? "")}, confidence ${esc(m.confidence ?? "")}</span></dd></div><div class="kv__row"><dt>Content</dt><dd>${esc(m.content ?? "")}</dd></div>${m.supersededBy ? `<div class="kv__row"><dt>Superseded by</dt><dd>${linkMemoryIds(m.supersededBy)} <span class="muted">(kept for the record, penalised in retrieval)</span></dd></div>` : ""}${t.related?.supersedes ? `<div class="kv__row"><dt>Supersedes</dt><dd>${linkMemoryIds(t.related.supersedes)}</dd></div>` : ""}</dl>` : ""}
    ${p ? `<h4>Provenance</h4>${placeholder ? `<p class="msg msg--warn">This memory was first learned before provenance refresh landed; its object name is a placeholder. The clean re-run replaces it.</p>` : ""}<dl class="kv">
      <div class="kv__row"><dt>Zetaris object</dt><dd><code>${esc(p.zetaris_object)}</code></dd></div>
      <div class="kv__row"><dt>Endpoint</dt><dd><code>${esc(p.endpoint)}</code></dd></div>
      ${p.accn ? `<div class="kv__row"><dt>Accession</dt><dd><code>${idHtml(p.accn)}</code>${p.filed ? ` filed ${esc(p.filed)}` : ""}</dd></div>` : ""}
      <div class="kv__row"><dt>Licence</dt><dd>${esc(p.licence)}</dd></div>
      <div class="kv__row"><dt>Retrieved</dt><dd>${esc(fmtTime(p.retrieved_at, true))} <span class="muted">(${esc(p.cache_state ?? "")}, ${esc(p.latency_ms)} ms, template <code>${esc(p.template_id)}</code>)</span></dd></div>
      <div class="kv__row"><dt>SQL sha256</dt><dd><code class="hash">${esc(p.sql_sha256)}</code></dd></div>
      <div class="kv__row"><dt>Evidence</dt><dd>${evidenceChips(p.run_id ?? null, p.evidence_id ? [p.evidence_id] : [])}</dd></div>
      ${Array.isArray(p.history) && p.history.length ? `<div class="kv__row"><dt>Earlier retrievals</dt><dd>${p.history.map((h) => `${esc(fmtTime(h.retrieved_at, true))} ${evidenceChips(h.run_id ?? null, h.evidence_id ? [h.evidence_id] : [])}`).join("<br>")}</dd></div>` : ""}
    </dl>` : ""}
    ${ledger.length ? `<h4>Trust ledger</h4><ol class="ledger">${ledger.map((e) => `<li class="ledger__item${e.actor === "analyst" ? " ledger__item--analyst" : ""}"><span class="ledger__t">${esc(fmtTime(e.at ?? e.timestamp, true))}</span><span class="ledger__action">${esc(String(e.action ?? e.type ?? "").replaceAll("_", " "))}</span><span class="ledger__text">${esc(e.actor ?? "")}${e.reason ? `: ${esc(e.reason)}` : ""}${detailText(e.details) ? ` <span class="muted">${esc(detailText(e.details))}</span>` : ""}</span></li>`).join("")}</ol>` : ""}
    ${conflicts.length ? `<h4>Conflicts this memory is in</h4><ul class="small">${conflicts.map((c) => `<li><code>${esc(c.id)}</code> ${esc(String(c.status ?? "").replaceAll("_", " "))}${c.override ? ` by ${esc(c.override.by)}: ${esc(c.override.reason)}` : ""}: ${esc(c.rule_text)}</li>`).join("")}</ul>` : ""}
  </div>`;
}

/** Opens the why trace of a memory id in the drawer (stacked when already open). */
export async function openWhy(memId, opts = {}) {
  const entry = (opts.push ? pushDrawer : openDrawer)({ title: `Why ${memId}`, kicker: "H-MEM trust ledger and provenance", html: `<p class="muted" role="status">Loading the trace…</p>` });
  const r = await api(`/api/why/${encodeURIComponent(memId)}`);
  updateDrawer(entry, { html: r.ok ? renderWhy(memId, r.data) : renderError(r) });
}

/** Pure: one conflict with its live status, the two sides, the rule, the override on record and the override form. */
export function conflictPanel(run, c) {
  const overridden = c.status === "overridden";
  const side = (k, label) => {
    const s = c[k] ?? {};
    return `<div class="side${c.chosen === k ? " side--chosen" : ""}"><span class="side__k">${esc(label)}${c.chosen === k ? ` <span class="side__use">in use</span>` : ""}</span><span class="fig">${esc(fmtMillions(s.val))}</span><br><code>${idHtml(s.accn)}</code><br><span class="muted">${esc(s.form)} fy${esc(s.fy)} ${esc(s.fp)}, filed ${esc(s.filed)}</span><br>memory ${linkMemoryIds(c[`${k}_memory`])}</div>`;
  };
  return `<article class="panel panel--alert conflict" id="conflict-${esc(c.id)}" data-conflict="${esc(c.id)}" aria-labelledby="c-${esc(c.id)}">
    <h3 class="panel__h" id="c-${esc(c.id)}">Conflict <code>${idHtml(c.id)}</code> <span class="panel__note">${esc(c.kind)} · ${esc(c.period)} under ${tagShort(c.tag)} · ${esc(String(c.scope ?? "").replaceAll("_", " "))}</span></h3>
    <div class="sides">
      ${side("own_filing", "Own filing")}
      <div class="sides__vs" aria-hidden="true">against</div>
      ${side("later_filing", "Later filing")}
    </div>
    <p><strong>Rule ${esc(c.rule)}</strong>: ${esc(ruleWording(c))}. Status <span class="chip ${overridden ? "chip--mid" : "chip--neutral"}" data-status="${esc(c.status)}">${esc(String(c.status ?? "").replaceAll("_", " "))}</span>, using the <strong>${esc(String(c.chosen ?? "").replaceAll("_", " "))}</strong> value ${esc(fmtMillions(c.chosen_val))}. Detected ${esc(fmtTime(c.detected_at, true))}${c.run_id ? ` in run <code>${idHtml(c.run_id)}</code>` : ""}. ${evidenceChips(run.run_id, c.evidence_ids)}</p>
    ${overridden && c.override ? `<p class="msg msg--warn">Overridden by ${esc(c.override.by)} at ${esc(fmtTime(c.override.at, true))}: ${esc(c.override.reason)}${c.override.contract_id ? ` (contract <code>${idHtml(c.override.contract_id)}</code>)` : ""}. The saved card still shows the rule's value; a re-run recomputes with the override.</p><p><button type="button" class="btn btn--primary" data-rerun="${esc(c.id)}">Re-run with the override</button> <span class="small muted">POSTs the same question again; get_revenue honours the overridden value.</span></p>` : ""}
    <form class="override" data-override="${esc(c.id)}" aria-label="Analyst override of ${esc(c.id)}">
      <h4 class="override__h">Analyst override <span class="muted">(a high-risk contract action, signed for the local demo identity "analyst")</span></h4>
      <fieldset class="field"><legend class="field__label">Value to use</legend>
        <label><input type="radio" name="chosen" value="own_filing"${c.chosen === "own_filing" ? " checked" : ""}> own filing, ${esc(fmtMillions(c.own_filing?.val))} (<code>${esc(c.own_filing?.accn)}</code>)</label><br>
        <label><input type="radio" name="chosen" value="later_filing"${c.chosen === "later_filing" ? " checked" : ""}> later filing, ${esc(fmtMillions(c.later_filing?.val))} (<code>${esc(c.later_filing?.accn)}</code>)</label>
      </fieldset>
      <div class="field"><label class="field__label" for="reason-${esc(c.id)}">Reason (recorded in the trust ledger)</label><textarea id="reason-${esc(c.id)}" name="reason" required minlength="8" maxlength="400" rows="2" placeholder="Why the analyst prefers this value"></textarea></div>
      <div class="act__buttons"><button type="submit" class="btn btn--primary">Sign and override</button><span class="small override__status" role="status"></span></div>
      <div class="override__out"></div>
    </form>
  </article>`;
}

/** Pure: the Memory and why screen for one run. */
export function renderMemory(run) {
  const ids = Array.isArray(run.memory?.ids) ? run.memory.ids : [];
  const conflicts = Array.isArray(run.card?.recast_conflicts) ? run.card.recast_conflicts : [];
  const skipped = Array.isArray(run.skipped_steps) ? run.skipped_steps : run.skipped_steps ? [run.skipped_steps] : [];
  return `
    <h1 class="view-h">Memory and why <span class="view-h__sub">${esc(run.card?.utility?.name ?? run.cik)}, ${esc(run.period)}, run <code>${idHtml(run.run_id)}</code></span></h1>
    <div class="mem-grid">
      <section class="panel" aria-labelledby="mem-h">
        <h2 class="panel__h" id="mem-h">Memories this run touched <span class="panel__note">${esc(ids.length)} of ${esc(run.memory?.facts_total ?? "?")} facts in H-MEM; ${esc(run.memory?.conflicts ?? 0)} conflict${run.memory?.conflicts === 1 ? "" : "s"} on record</span></h2>
        <p class="memids">${ids.map((id) => `<button type="button" class="memid memid--big" data-why="${esc(id)}">${esc(id)}</button>`).join(" ")}</p>
        ${skipped.length ? `<p class="small">Steps skipped because memory already held the answer: ${skipped.map((s) => `<strong>${esc(s.item)}</strong> from ${linkMemoryIds(s.memoryId)} (${esc(s.note)})`).join("; ")}.</p>` : `<p class="small muted">No step was skipped from memory in this run (a cold run).</p>`}
        <div class="why-pick"><label for="why-id">Why trace for</label><input id="why-id" type="text" value="${esc(ids[0] ?? "")}" pattern="mem-\\d+" placeholder="mem-62" aria-describedby="why-help"><button type="button" class="btn btn--small" id="why-go">Trace</button></div>
        <p class="small muted" id="why-help">The trace lists the memory's content, its Zetaris provenance (object, SQL hash, endpoint, licence, retrieval time), its trust-ledger history and any conflict it is in.</p>
        <div id="why-out" class="why-out" aria-live="polite"></div>
      </section>
      <section aria-labelledby="conf-h" id="conflicts">
        <h2 class="panel__h" id="conf-h">Restatement conflicts <span class="panel__note">${conflicts.length ? `${esc(conflicts.length)} on this card` : "none on this card"}</span></h2>
        ${conflicts.length ? conflicts.map((c) => conflictPanel(run, c)).join("") : `<p class="panel muted">No conflict: the comparative in the current filing equals the original, and no later filing restates the current quarter.</p>`}
      </section>
    </div>`;
}

export function mount(el, ctx) {
  el.innerHTML = `<p class="muted" role="status">Loading the run…</p>`;
  let run = null;
  (async () => {
    const id = await pickRunId(ctx.params.run);
    if (!id) {
      el.innerHTML = `<h1 class="view-h">Memory and why</h1><p class="msg msg--warn">No saved run yet. <a href="#/ask">Ask a question</a>.</p>`;
      return;
    }
    const r = await loadRun(id);
    if (!r.ok) {
      el.innerHTML = `<h1 class="view-h">Memory and why</h1>${renderError(r)}`;
      return;
    }
    run = r.data;
    setCurrentRun(id);
    if (ctx.params.run !== id) history.replaceState(null, "", `#/memory/${id}`);
    el.innerHTML = renderMemory(run);
    ctx.setTitle("Memory and why");
    ctx.setFooterRun(run);
    const first = run.memory?.ids?.[0];
    if (first) traceInto(first);
  })();

  async function traceInto(memId) {
    const out = el.querySelector("#why-out");
    if (!out) return;
    out.innerHTML = `<p class="muted">Loading the trace for ${esc(memId)}…</p>`;
    const r = await api(`/api/why/${encodeURIComponent(memId)}`);
    out.innerHTML = `<h3 class="sub-h">Why ${esc(memId)}</h3>${r.ok ? renderWhy(memId, r.data) : renderError(r)}`;
  }

  /** Repaints one conflict's panel from its live record (after an override here or elsewhere). */
  function repaint(conflict, extraHtml = "") {
    if (!run || !conflict?.id) return;
    const list = Array.isArray(run.card?.recast_conflicts) ? run.card.recast_conflicts : [];
    const i = list.findIndex((c) => c.id === conflict.id);
    const merged = i >= 0 ? { ...list[i], ...conflict } : conflict;
    if (i >= 0) list[i] = merged;
    const old = el.querySelector(`[data-conflict="${CSS.escape(conflict.id)}"]`);
    if (!old) return;
    old.outerHTML = conflictPanel(run, merged);
    const fresh = el.querySelector(`[data-conflict="${CSS.escape(conflict.id)}"]`);
    if (fresh && extraHtml) fresh.querySelector(".override__out").innerHTML = extraHtml;
    forgetRun(run.run_id);
  }

  const onClick = (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    if (t.closest("#why-go")) {
      const v = el.querySelector("#why-id").value.trim();
      if (/^mem-\d+$/u.test(v)) traceInto(v);
      return;
    }
    const rerun = t.closest("[data-rerun]");
    if (rerun) {
      e.preventDefault();
      rerunWithOverride(rerun);
    }
  };

  async function rerunWithOverride(btn) {
    if (!run) return;
    btn.disabled = true;
    const out = btn.closest("[data-conflict]")?.querySelector(".override__out") ?? btn.parentElement;
    const r = await api("/api/ask", { body: { cik: run.cik, period: run.period, claim: run.claim } });
    if (r.status === 202 || (r.ok && r.data?.run_id)) {
      setCurrentRun(r.data.run_id);
      out.insertAdjacentHTML("beforeend", `<p class="msg msg--ok">Re-run <code>${esc(r.data.run_id)}</code> started with the override in force. <a href="#/ask">Follow it on the Ask screen</a>.</p>`);
      location.hash = "#/ask";
    } else {
      btn.disabled = false;
      out.insertAdjacentHTML("beforeend", renderError(r));
    }
  }

  const onSubmit = async (e) => {
    const form = e.target instanceof HTMLFormElement ? e.target.closest("form[data-override]") : null;
    if (!form || !run) return;
    e.preventDefault();
    const conflictId = form.getAttribute("data-override");
    const chosen = form.querySelector('input[name="chosen"]:checked')?.value;
    const reason = form.querySelector('textarea[name="reason"]').value.trim();
    const status = form.querySelector(".override__status");
    const out = form.querySelector(".override__out");
    const go = form.querySelector('button[type="submit"]');
    if (!chosen || reason.length < 8) {
      status.textContent = "Choose a value and give a reason of at least 8 characters.";
      return;
    }
    go.disabled = true;
    out.innerHTML = "";
    status.textContent = "Signing the override_recast contract…";
    const params = { conflict_id: conflictId, chosen, reason };
    const signed = await api("/api/approvals/sign", { body: { action: "override_recast", params } });
    if (!signed.ok) {
      go.disabled = false;
      status.textContent = "";
      out.innerHTML = renderError(signed);
      return;
    }
    const contract = signed.data?.contract ?? signed.data;
    status.textContent = "Contract signed; applying the override…";
    const res = await api("/api/override", { body: { conflict_id: conflictId, chosen, reason, contract } });
    go.disabled = false;
    status.textContent = "";
    if (!res.ok) {
      out.innerHTML = `${renderError(res)}<p class="small muted">A refused contract is logged by the server; nothing was changed.</p>`;
      return;
    }
    const c = res.data?.conflict ?? res.data;
    repaint(
      c && typeof c === "object" && c.id ? c : { id: conflictId, status: "overridden", chosen },
      `<p class="msg msg--ok">Override recorded: conflict <code>${esc(c?.id ?? conflictId)}</code> now uses the <strong>${esc(String(c?.chosen ?? chosen).replaceAll("_", " "))}</strong> value${c?.chosen_val ? ` ${esc(fmtMillions(c.chosen_val))}` : ""}; status <strong>${esc(String(c?.status ?? "overridden").replaceAll("_", " "))}</strong>${res.data?.contract_id ?? c?.override?.contract_id ? `, contract <code>${idHtml(res.data?.contract_id ?? c.override.contract_id)}</code>` : ""}. The trust ledger records the analyst's action; the Re-run button above applies it.</p>`,
    );
    ctx.announce("Override recorded");
    el.querySelector(`[data-conflict="${CSS.escape(conflictId)}"] [data-rerun]`)?.focus();
  };

  // An override applied elsewhere (another tab, the CLI) reaches this screen as an SSE event.
  ctx.on("override", async (d) => {
    if (!run || !d?.conflict_id) return;
    const list = Array.isArray(run.card?.recast_conflicts) ? run.card.recast_conflicts : [];
    if (!list.some((c) => c.id === d.conflict_id)) return;
    const live = await liveConflicts();
    overlayConflicts(run, live);
    const c = live.get(d.conflict_id);
    if (c) repaint(c);
  });

  el.addEventListener("click", onClick);
  el.addEventListener("submit", onSubmit);
  return () => {
    el.removeEventListener("click", onClick);
    el.removeEventListener("submit", onSubmit);
  };
}
