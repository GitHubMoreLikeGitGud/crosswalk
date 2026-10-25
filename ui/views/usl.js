// The USL and DQ screen (GET /api/usl?run=<id>): the governed Zetaris semantic layer as an ERD-like
// list (tables, keys, foreign keys), the data-quality rules with their valid and invalid counts from
// onboarding (with its date) and the two rules the run executed live, and every invalid row
// explained in plain words. Each block says where its numbers come from. renderUsl is pure.

import { api, eng, esc, fmtMs, fmtNum, fmtSgt, renderError } from "../lib.js";

function ruleCells(x) {
  if (!x) return `<td class="r nm" colspan="3">not run</td>`;
  if (x.error) return `<td class="r" colspan="3"><span class="cross">error</span> ${esc(x.error)}</td>`;
  return `<td class="r tnum">${esc(fmtNum(x.valid))} of ${esc(fmtNum(x.total))}</td><td class="r tnum${Number(x.invalid) > 0 ? " bad-text" : ""}">${esc(fmtNum(x.invalid))}</td><td class="r tnum muted">${esc(fmtMs(x.elapsed_ms ?? (typeof x.elapsed_s === "number" ? x.elapsed_s * 1000 : null)))}</td>`;
}

/** One invalid row in plain words, from the rule, the row's values and the referenced table. */
export function invalidWords(inv, usl) {
  const v = inv.values ?? {};
  const fk = (usl.fks ?? []).find((f) => f.from === inv.rule);
  const [fromTable, col] = String(inv.rule ?? "").split(".");
  const toTable = fk?.to_table ?? String(fk?.to ?? "").split(".")[0];
  const ref = (usl.tables ?? []).find((t) => t.name === toTable);
  const who = v.name ? `${v.name}${v.ticker ? ` (${v.ticker})` : ""}` : `A row of ${fromTable}`;
  const val = col && v[col] !== undefined ? v[col] : null;
  const s1 = `${who} has ${col} ${val ?? "(empty)"}, and the ${toTable || "referenced"} table has no row with that value, so the rule "${inv.rule} must exist in ${fk?.to ?? toTable}" marks this row invalid.`;
  const s2 = ref?.description ? ` The ${toTable} table: ${ref.description}` : "";
  const s3 = " The row stays in the model and is named here; it is not dropped or patched.";
  return `${s1}${s2}${s3}`;
}

function tableCard(t) {
  const pk = new Set(t.pk ?? []);
  const fkCols = new Map((t.fks ?? []).map((f) => [f.column, f]));
  const cols = (t.columns ?? [])
    .map((c) => {
      const fk = fkCols.get(c.name);
      return `<li><code>${esc(c.name)}</code> <span class="muted small">${esc(c.type)}</span>${pk.has(c.name) ? ` <span class="key key--pk" title="primary key">PK</span>` : ""}${fk ? ` <span class="key key--fk" title="foreign key">FK</span> <span class="small">to <code>${esc(fk.references)}</code>${fk.transform && fk.transform !== "identity" ? ` (${esc(fk.transform)})` : ""}</span>` : ""}</li>`;
    })
    .join("");
  return `<article class="erd__t">
    <h3 class="erd__name">${esc(t.name)}</h3>
    <p class="erd__src small">from the cached view <code>${esc(t.source)}</code></p>
    <ul class="erd__cols">${cols}</ul>
    ${t.description ? `<p class="erd__desc small muted">${esc(t.description)}</p>` : ""}
    <details class="erd__q"><summary>Query it in Zetaris</summary><pre><code>${esc(t.query_in_zetaris)}</code></pre></details>
  </article>`;
}

/** Pure: the whole screen from the /api/usl payload. */
export function renderUsl(u) {
  if (!u) return "";
  const defs = u.definitions ?? {};
  const ob = u.onboarding_dq;
  const live = u.live_rules;
  const fks = Array.isArray(u.fks) ? u.fks : [];
  const liveNames = new Set((live?.rules ?? []).map((r) => r.rule));
  const invalid = Array.isArray(u.invalid_rows) ? u.invalid_rows : [];
  const obTotalInvalid = (ob?.rules ?? []).reduce((a, r) => a + (Number(r.invalid) || 0), 0);
  const edges = (u.erd?.edges ?? []).map((e) => `<li><code>${esc(e.label)}</code></li>`).join("");
  return `<section class="usl">
    <h1 class="view-h">USL and data quality <span class="view-h__sub">the governed semantic layer built from the verified keys</span></h1>
    <div class="panel usl__head">
      <p><strong>${esc(u.usl)}</strong> in <code>${esc(u.namespace)}</code>: ${esc(fmtNum((u.tables ?? []).length))} tables, ${esc(fmtNum(fks.length))} foreign keys, every one a join key measured in Lightning SQL before it was declared. Registered and cached first, then activated from the cached views.</p>
      ${u.description ? `<p class="small muted">${esc(u.description)}</p>` : ""}
      ${live ? `<p class="usl__live"><span class="chip chip--${live.status === "matches_governed" ? "good" : "mid"}">${esc(live.status === "matches_governed" ? "matches the governed USL" : String(live.status ?? "").replaceAll("_", " "))}</span> ${esc(live.note ?? "")}</p>` : ""}
    </div>

    <div class="usl__grid">
      <div class="panel">
        <h2 class="panel__h">Data-quality rules <span class="panel__note">one rule per foreign key: every value must exist in the table it points to</span></h2>
        <div class="table-wrap"><table class="dq">
          <thead>
            <tr><th scope="col" rowspan="2">Rule (foreign key)</th><th scope="colgroup" colspan="3" class="dq__grp">At onboarding${ob?.ran_at_sgt ? `, ${esc(fmtSgt(ob.ran_at_sgt))}` : ""}</th><th scope="colgroup" colspan="3" class="dq__grp">Live in this run${live?.at_sgt ? `, ${esc(fmtSgt(live.at_sgt))}` : ""}</th></tr>
            <tr><th scope="col" class="r">valid</th><th scope="col" class="r">invalid</th><th scope="col" class="r">time</th><th scope="col" class="r">valid</th><th scope="col" class="r">invalid</th><th scope="col" class="r">time</th></tr>
          </thead>
          <tbody>${fks
            .map((f) => `<tr${liveNames.has(f.from) ? ` class="dq__live"` : ""}><th scope="row"><code>${esc(f.from)}</code> <span class="muted">to</span> <code>${esc(f.to)}</code></th>${ruleCells(f.onboarding)}${ruleCells(f.live)}</tr>`)
            .join("")}</tbody>
        </table></div>
        <dl class="defs small">
          <div class="defs__row"><dt>At onboarding</dt><dd>${esc(defs.onboarding ?? "")}${ob ? ` Read from the saved results of ${esc(fmtSgt(ob.ran_at_sgt))}: ${esc(fmtNum((ob.rules ?? []).length))} rules, ${esc(fmtNum(obTotalInvalid))} invalid row${obTotalInvalid === 1 ? "" : "s"}.` : " No onboarding result is saved."}</dd></div>
          <div class="defs__row"><dt>Live in this run</dt><dd>${esc(defs.live ?? "")}${live ? ` ${esc(fmtNum((live.rules ?? []).length))} rules ran at ${esc(fmtSgt(live.at_sgt))}.` : " This run ran no live rule."}</dd></div>
          <div class="defs__row"><dt>Invalid</dt><dd>${esc(defs.dq_invalid ?? "")}</dd></div>
        </dl>
      </div>

      <div class="panel panel--alert-soft">
        <h2 class="panel__h">Invalid rows, in plain words</h2>
        ${
          invalid.length
            ? invalid
                .map(
                  (inv) => `<div class="inv">
          <p class="inv__words">${esc(invalidWords(inv, u))}</p>
          <div class="table-wrap"><table class="rows"><thead><tr>${(inv.columns ?? []).map((c) => `<th scope="col">${esc(c)}</th>`).join("")}</tr></thead><tbody><tr>${(inv.row ?? []).map((v) => `<td>${esc(v)}</td>`).join("")}</tr></tbody></table></div>
          <p class="small muted">Rule <code>${esc(inv.rule)}</code>, found at onboarding.</p>
        </div>`,
                )
                .join("")
            : `<p class="muted">No invalid row.</p>`
        }
      </div>
    </div>

    <div class="panel">
      <h2 class="panel__h">The governed model <span class="panel__note">${esc(defs.governed ?? "")}</span></h2>
      <div class="erd">${(u.tables ?? []).map(tableCard).join("")}</div>
      <h3 class="sub-h">Foreign keys</h3>
      <ul class="erd__edges">${edges}</ul>
      ${eng(`<p class="small">source of the live rules: ${esc(live?.source ?? "none")}; onboarding file: ${esc(ob?.source ?? "none")}</p>`)}
    </div>
  </section>`;
}

export function mount(el, ctx) {
  ctx.setTitle?.("USL and DQ");
  el.innerHTML = `<p class="muted">Loading the semantic layer…</p>`;
  let alive = true;
  (async () => {
    const r = await api(`/api/usl${ctx.run ? `?run=${encodeURIComponent(ctx.run)}` : ""}`);
    if (!alive) return;
    el.innerHTML = r.ok ? renderUsl(r.data) : renderError(r);
  })();
  return () => {
    alive = false;
  };
}
