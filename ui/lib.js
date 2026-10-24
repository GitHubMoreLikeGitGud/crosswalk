// Shared helpers for the Weather-or-Not analyst UI. Nothing here touches document, window or
// EventSource at import time, so the view modules can be imported in Node for render tests.

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };

/** Every piece of data that reaches HTML goes through this (text and attribute values). */
export function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"'`]/gu, (c) => ESC[c]);
}
export const esc = escapeHtml;

/** A URL is shown as a link only when it is plain http(s). */
export function safeUrl(u) {
  return typeof u === "string" && /^https?:\/\/[^\s"'<>]+$/iu.test(u) ? u : null;
}

/** An id that may wrap only at its hyphens (run, evidence, memory and contract ids). */
export function idHtml(id) {
  return esc(id).replaceAll("-", "-<wbr>");
}

// ---------- numbers ----------

export function fmtNum(n, digits = 0) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "";
  return Number(n).toLocaleString("en-GB", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

/** A fraction as a signed percentage: 0.082 -> "+8.2%". */
export function fmtPct(x, digits = 1, signed = true) {
  if (x === null || x === undefined || Number.isNaN(Number(x))) return "";
  const v = Number(x) * 100;
  const s = fmtNum(Math.abs(v), digits);
  if (v < 0) return `-${s}%`;
  return `${signed ? "+" : ""}${s}%`;
}

/** "(range +1.6% to +14.0%)" from two fractions. */
export function fmtRange(lo, hi, digits = 1) {
  if (lo === null || lo === undefined || hi === null || hi === undefined) return "";
  return `(range ${fmtPct(lo, digits)} to ${fmtPct(hi, digits)})`;
}

/** USD in millions: 3765000000 -> "3,765.0 M". */
export function fmtMillions(v, digits = 1) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "";
  return `${fmtNum(Number(v) / 1e6, digits)} M`;
}

export function fmtMs(ms) {
  if (ms === null || ms === undefined || Number.isNaN(Number(ms))) return "";
  const n = Number(ms);
  return n >= 1000 ? `${fmtNum(n / 1000, 1)} s` : `${fmtNum(n)} ms`;
}

export function plural(n, one, many = `${one}s`) {
  return `${fmtNum(n)} ${n === 1 ? one : many}`;
}

// ---------- time ----------

/** "+0800" -> "+08:00" so Date can parse the gateway's timestamps everywhere. */
export function parseTime(t) {
  if (t === null || t === undefined || t === "") return null;
  if (typeof t === "number") return new Date(t);
  const s = String(t).replace(/([+-]\d{2})(\d{2})$/u, "$1:$2");
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

const pad = (n) => String(n).padStart(2, "0");

/** The browser's time zone at that moment, as a short name ("SGT", "GMT+8"). */
export function zoneName(d = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZoneName: "short" }).formatToParts(d).find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

/** Local date and time, e.g. "24 Oct 20:46 GMT+8". */
export function fmtTime(t, withSeconds = false) {
  const d = parseTime(t);
  if (!d) return "";
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()];
  const zone = zoneName(d);
  return `${d.getDate()} ${mon} ${pad(d.getHours())}:${pad(d.getMinutes())}${withSeconds ? `:${pad(d.getSeconds())}` : ""}${zone ? ` ${zone}` : ""}`;
}

/** The clock time only ("16:29:35"). */
export function fmtClock(t) {
  const d = parseTime(t);
  return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : "";
}

/** Local date and time with the year ("24 Oct 2026 20:46 GMT+8"), for times that may span years. */
export function fmtTimeYear(t, withSeconds = false) {
  const d = parseTime(t);
  if (!d) return "";
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()];
  const zone = zoneName(d);
  return `${d.getDate()} ${mon} ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}${withSeconds ? `:${pad(d.getSeconds())}` : ""}${zone ? ` ${zone}` : ""}`;
}

/**
 * A source time as the source states it: a date stamped at midnight UTC (a filing date, a quarter
 * end) stays a date ("2025-03-31"); anything else is a local date and time with the year.
 */
export function fmtSourceTime(t) {
  if (t === null || t === undefined || t === "") return "";
  const s = String(t);
  if (/^\d{4}-\d{2}-\d{2}$/u.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}T00:00(?::00(?:\.0+)?)?Z$/u.test(s)) return s.slice(0, 10);
  return fmtTimeYear(s) || s;
}

// ---------- domain words ----------

const TAG_SHORT = { Revenues: "Revenues", RevenueFromContractWithCustomerExcludingAssessedTax: "RFC", RegulatedAndUnregulatedOperatingRevenue: "RUOR" };

/** The short name of a revenue tag (RFC, RUOR) with the full tag as a tooltip. */
export function tagShort(tag) {
  const t = String(tag ?? "");
  const s = TAG_SHORT[t] ?? t;
  return s === t ? `<span class="tagname">${esc(t)}</span>` : `<abbr class="tagname" title="${esc(t)}">${esc(s)}</abbr>`;
}

export const TOOL_WORDS = {
  resolve_utility: "Resolve the utility",
  probe_revenue_tag: "Probe the revenue tag",
  register_frames: "Register a frames period in Zetaris",
  get_revenue: "Read like-for-like revenue",
  get_peers: "Load the peer set",
  get_weather: "Compute degree days in Lightning SQL",
  dq_gate: "Run the data-quality gate",
  attribute: "Attribute the change",
  not_tested: "List what was not tested",
  finalize: "Test the claim and write the memo",
};

export function toolWord(tool) {
  return TOOL_WORDS[tool] ?? String(tool ?? "").replaceAll("_", " ");
}

/** Cosmetic: a word, a hyphen, a space, a word -> word-word (render time only; the saved text is untouched). */
export function hyphenJoin(text) {
  return String(text ?? "").replace(/(\w)- (\w)/gu, "$1-$2");
}

// ---------- chips ----------

const VERDICT_CLASS = { supported: "good", partly_supported: "mid", not_supported: "bad", withheld: "neutral", untested: "neutral" };

/** The claim verdict as a chip: colour plus the word, never colour alone. */
export function verdictChip(verdict, opts = {}) {
  const v = String(verdict ?? "").toLowerCase();
  const cls = VERDICT_CLASS[v] ?? "neutral";
  return `<span class="chip chip--${cls}${opts.large ? " chip--lg" : ""}" data-verdict="${esc(v)}">${esc(v.replaceAll("_", " ") || "no verdict")}</span>`;
}

const CONF_CLASS = { high: "good", medium: "mid", low: "bad", withheld: "neutral" };

export function confidenceChip(level, opts = {}) {
  const c = String(level ?? "").toLowerCase();
  return `<span class="chip chip--${CONF_CLASS[c] ?? "neutral"}${opts.large ? " chip--lg" : ""}" data-confidence="${esc(c)}">${opts.bare ? "" : "confidence "}${esc(c || "not stated")}</span>`;
}

export function dqChip(label) {
  const l = String(label ?? "").toLowerCase();
  const cls = l === "pass" ? "good" : l === "withheld" || l === "fail" ? "bad" : "neutral";
  return `<span class="chip chip--${cls}" data-dq="${esc(l)}">DQ ${esc(l || "not run")}</span>`;
}

/** A plain neutral tag, e.g. "replay", "model memo". */
export function tag(text, kind = "neutral") {
  return `<span class="tag tag--${esc(kind)}">${esc(text)}</span>`;
}

// ---------- evidence ids and chips ----------

const RUN_OF_EV = /^ev-(r\d{8}T\d{6}[0-9a-f]{4})-(\d{2,4})$/u;
const EV_RE_SRC = "ev-r\\d{8}T\\d{6}[0-9a-f]{4}-\\d{2,4}";

/** The run an evidence id belongs to (ids embed it), else the given fallback. */
export function runOfEvidence(id, fallback = null) {
  const m = RUN_OF_EV.exec(String(id ?? ""));
  return m ? m[1] : fallback;
}

/** Short label for a chip: the record number within its run. */
export function evShort(id) {
  const m = RUN_OF_EV.exec(String(id ?? ""));
  return m ? m[2] : String(id ?? "");
}

export const EV_KIND_WORD = { zetaris_sql: "SQL", dq: "DQ", tool: "Tool", model: "Model", memory: "Memory", registrar: "Registrar", world_model: "World" };
export const EV_KIND_LONG = {
  zetaris_sql: "Lightning SQL through Zetaris",
  dq: "Zetaris data-quality rule",
  tool: "deterministic tool output",
  model: "local model call (NVIDIA Nemotron 3 Nano 4B via Ollama)",
  memory: "H-MEM memory",
  registrar: "Zetaris registrar contract",
  world_model: "World Model",
};

const knownEvidence = new Map();

/** Remembers each record (so chips can say what they cite and the drawer can render saved runs offline). */
export function rememberEvidence(records) {
  for (const r of Array.isArray(records) ? records : []) {
    if (r && typeof r.id === "string") knownEvidence.set(r.id, r);
  }
}

export function evidenceRecord(id) {
  return knownEvidence.get(id) ?? null;
}

/** Chips rendered before their records were known (a live run) get their kind once the run is saved. */
export function refreshChipKinds(root) {
  for (const b of root.querySelectorAll(".ev[data-ev]")) {
    const rec = knownEvidence.get(b.getAttribute("data-ev"));
    if (!rec?.kind || b.getAttribute("data-kind") === rec.kind) continue;
    b.setAttribute("data-kind", rec.kind);
    const k = b.querySelector(".ev__k");
    if (k) k.textContent = EV_KIND_WORD[rec.kind] ?? "Record";
    const claim = typeof rec.claim === "string" ? rec.claim : "";
    const title = `Evidence ${evShort(rec.id)}${rec.template_id ? ` (${rec.template_id})` : ""}, ${EV_KIND_LONG[rec.kind] ?? rec.kind}${claim ? `: ${claim.length > 200 ? `${claim.slice(0, 200)}…` : claim}` : ""}`;
    b.setAttribute("title", title);
    b.setAttribute("aria-label", title);
  }
}

function kindOf(id, hint) {
  return knownEvidence.get(id)?.kind ?? hint ?? null;
}

function chip(id, run, hint) {
  const rec = knownEvidence.get(id);
  const kind = kindOf(id, hint);
  const word = EV_KIND_WORD[kind] ?? "Record";
  const n = evShort(id);
  const claim = typeof rec?.claim === "string" ? rec.claim : "";
  const title = `Evidence ${n}${rec?.template_id ? ` (${rec.template_id})` : ""}${kind ? `, ${EV_KIND_LONG[kind] ?? kind}` : ""}${claim ? `: ${claim.length > 200 ? `${claim.slice(0, 200)}…` : claim}` : ""}`;
  return `<button type="button" class="ev" data-ev="${esc(id)}" data-run="${esc(runOfEvidence(id, run) ?? "")}" data-kind="${esc(kind ?? "unknown")}" title="${esc(title)}" aria-label="${esc(title)}"><span class="ev__k" aria-hidden="true">${esc(word)}</span><span class="ev__n" aria-hidden="true">${esc(n)}</span></button>`;
}

/**
 * Evidence chips for one claim. Each chip is a button naming what it cites; clicking any opens
 * the drawer with every id of the group, starting at the one clicked. `max` folds a long list.
 */
export function evidenceChips(runId, ids, opts = {}) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).filter((x) => typeof x === "string" && x))];
  if (!list.length) return `<span class="evs evs--none">${opts.noneText !== undefined ? esc(opts.noneText) : "no evidence id"}</span>`;
  const run = runId ?? runOfEvidence(list[0]);
  const max = typeof opts.max === "number" && opts.max > 0 && list.length > opts.max + 1 ? opts.max : list.length;
  let chips = list.slice(0, max).map((id) => chip(id, run, opts.kind)).join("");
  if (max < list.length) chips += `<button type="button" class="ev ev--more" data-ev="${esc(list[max])}" data-run="${esc(runOfEvidence(list[max], run) ?? "")}" aria-label="${esc(`${list.length - max} more evidence records`)}">+${esc(list.length - max)} more</button>`;
  return `<span class="evs" data-run="${esc(run ?? "")}" data-ids="${esc(list.join(" "))}">${chips}</span>`;
}

/**
 * A cited number: the figure is itself the button that opens the evidence drawer for its ids.
 * `label` says what the number is (for the aria-label); `cls` adds a size class.
 */
export function numBtn(runId, ids, html, label, cls = "") {
  const list = [...new Set((Array.isArray(ids) ? ids : []).filter(Boolean))];
  const run = runId ?? runOfEvidence(list[0]);
  if (!list.length) return `<span class="num num--uncited${cls ? ` ${cls}` : ""}" title="no evidence id recorded">${html}</span>`;
  return `<button type="button" class="num${cls ? ` ${cls}` : ""}" data-ev="${esc(list[0])}" data-run="${esc(run ?? "")}" data-ids="${esc(list.join(" "))}" aria-label="${esc(label)}: open the evidence (${list.length} record${list.length === 1 ? "" : "s"})">${html}</button>`;
}

/** Escaped text with evidence ids inside it turned into chips (for server-written trace lines). */
export function linkEvidenceIds(text) {
  const parts = String(text ?? "").split(new RegExp(`(${EV_RE_SRC})`, "u"));
  return parts.map((p, i) => (i % 2 ? evidenceChips(null, [p]) : esc(p))).join("");
}

/** A fact line without its trailing "[ev-…, ev-…]" list (the chips beside it carry those ids). */
export function stripEvidenceRefs(text) {
  return String(text ?? "").replace(new RegExp(`\\s*\\[${EV_RE_SRC}(?:,\\s*${EV_RE_SRC})*\\]`, "gu"), "");
}

/** Memory ids inside text ("mem-62") become buttons that open the why trace. */
export function linkMemoryIds(text) {
  const parts = String(text ?? "").split(/(mem-\d+)/u);
  return parts.map((p, i) => (i % 2 ? `<button type="button" class="memid" data-why="${esc(p)}">${esc(p)}</button>` : esc(p))).join("");
}

// ---------- misc rendering ----------

/** Visible field, or a marked "missing" for a required one that is absent. */
export function fieldOrMissing(value, render = (v) => esc(v)) {
  if (value === undefined || value === null || value === "") return `<span class="missing">missing</span>`;
  return render(value);
}

export function errorText(res) {
  const d = res?.data;
  const msg = d && typeof d === "object" && typeof d.error === "string" ? d.error : `request failed (${res?.status ?? "network"})`;
  const kind = res?.status === 403 ? "Refused" : res?.status === 409 ? "Busy" : res?.status === 404 ? "Not found" : "Error";
  return `${kind}${res?.status ? ` ${res.status}` : ""}: ${msg}`;
}

export function renderError(res) {
  return `<p class="msg msg--error" role="alert">${esc(errorText(res))}</p>`;
}

// ---------- network ----------

/** JSON in and out. Resolves to { ok, status, data } so callers can show 403 and 409 bodies. */
export async function api(path, { method = "GET", body } = {}) {
  const init = { method, headers: { accept: "application/json" } };
  if (body !== undefined) {
    init.method = method === "GET" ? "POST" : method;
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  try {
    const res = await fetch(path, init);
    let data = null;
    const text = await res.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { error: text.slice(0, 300), code: "not_json" };
      }
    }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: `the agent server did not answer (${e?.message ?? e})`, code: "network" } };
  }
}

/** Plain text (the memo.md). */
export async function apiText(path) {
  try {
    const res = await fetch(path, { headers: { accept: "text/markdown, text/plain" } });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } catch (e) {
    return { ok: false, status: 0, text: "", error: e?.message ?? String(e) };
  }
}

// ---------- server-sent events: one EventSource per page ----------

let source = null;
const handlers = new Map();
const connListeners = new Set();
let connState = "connecting";

export const KNOWN_EVENTS = ["run_started", "chunk_start", "planner", "tool", "chunk_end", "run_finished", "run_failed", "override"];

function dispatch(type, ev) {
  let data = {};
  try {
    data = JSON.parse(ev.data);
  } catch {
    data = {};
  }
  for (const fn of handlers.get(type) ?? []) {
    try {
      fn(data, type, ev.lastEventId);
    } catch (e) {
      console.error(`handler for ${type} failed`, e);
    }
  }
  for (const fn of handlers.get("*") ?? []) {
    try {
      fn(data, type, ev.lastEventId);
    } catch (e) {
      console.error("handler for * failed", e);
    }
  }
}

function setConn(s) {
  connState = s;
  for (const fn of connListeners) fn(s);
}

function ensureSource() {
  if (source || typeof EventSource === "undefined") return;
  source = new EventSource("/api/events");
  for (const t of KNOWN_EVENTS) source.addEventListener(t, (ev) => dispatch(t, ev));
  source.addEventListener("open", () => setConn("live"));
  source.addEventListener("error", () => setConn(source && source.readyState === 2 ? "closed" : "reconnecting"));
}

/** Subscribe to an SSE event type ("*" for every known type). Returns the unsubscribe function. */
export function on(type, fn) {
  ensureSource();
  if (!handlers.has(type)) handlers.set(type, new Set());
  handlers.get(type).add(fn);
  return () => handlers.get(type)?.delete(fn);
}

export function onConnection(fn) {
  ensureSource();
  connListeners.add(fn);
  fn(connState);
  return () => connListeners.delete(fn);
}

// ---------- session memory (per-viewer conveniences only) ----------

export function sessionSet(key, value) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* storage can be unavailable; the UI works without it */
  }
}

export function sessionGet(key) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export const ANALYST = "analyst";
