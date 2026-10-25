// Shared helpers for the Crosswalk analyst UI. Nothing here touches document, window or
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

// ---------- numbers ----------

export function fmtNum(n, digits = 0) {
  if (n === null || n === undefined || n === "" || Number.isNaN(Number(n))) return "";
  return Number(n).toLocaleString("en-GB", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

/** A fraction as a signed percentage: 0.082 -> "+8.2%". */
export function fmtPct(x, digits = 1, signed = true) {
  if (x === null || x === undefined || Number.isNaN(Number(x))) return "";
  const v = Number(x) * 100;
  const s = fmtNum(Math.abs(v), digits);
  if (v < 0 && s !== fmtNum(0, digits)) return `-${s}%`;
  return `${signed ? "+" : ""}${s}%`;
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
  return `${fmtNum(n)} ${Number(n) === 1 ? one : many}`;
}

// ---------- time: one zone everywhere (SGT, Asia/Singapore, UTC+8) ----------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "+0800" -> "+08:00" so Date can parse the gateway's timestamps everywhere. */
export function parseTime(t) {
  if (t === null || t === undefined || t === "") return null;
  if (typeof t === "number") return new Date(t);
  const s = String(t).replace(/([+-]\d{2})(\d{2})$/u, "$1:$2");
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

const pad = (n) => String(n).padStart(2, "0");

/** The SGT wall-clock parts of an instant (fixed +8 h; Singapore has no daylight saving). */
function sgtParts(d) {
  const x = new Date(d.getTime() + 8 * 3600 * 1000);
  return { y: x.getUTCFullYear(), mo: x.getUTCMonth(), d: x.getUTCDate(), h: x.getUTCHours(), mi: x.getUTCMinutes(), s: x.getUTCSeconds() };
}

/** "25 Oct 2026 16:00:20 SGT" from an ISO instant or the server's "2026-10-25 16:00:20 SGT". */
export function fmtSgt(t, { seconds = true, year = true } = {}) {
  if (t === null || t === undefined || t === "") return "";
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) SGT$/u.exec(String(t));
  let p;
  if (m) p = { y: Number(m[1]), mo: Number(m[2]) - 1, d: Number(m[3]), h: Number(m[4]), mi: Number(m[5]), s: Number(m[6]) };
  else {
    const d = parseTime(t);
    if (!d) return "";
    p = sgtParts(d);
  }
  return `${p.d} ${MONTHS[p.mo]}${year ? ` ${p.y}` : ""} ${pad(p.h)}:${pad(p.mi)}${seconds ? `:${pad(p.s)}` : ""} SGT`;
}

/** The SGT clock time only ("16:00:20"). */
export function fmtClock(t) {
  const m = /^\d{4}-\d{2}-\d{2} (\d{2}:\d{2}:\d{2}) SGT$/u.exec(String(t ?? ""));
  if (m) return m[1];
  const d = parseTime(t);
  if (!d) return "";
  const p = sgtParts(d);
  return `${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`;
}

// ---------- domain words ----------

/** "CY2025Q1" -> "Q1 2025". */
export function quarterWords(q) {
  const m = /^CY(\d{4})Q([1-4])$/u.exec(String(q ?? ""));
  return m ? `Q${m[2]} ${m[1]}` : String(q ?? "");
}

const TAG_SHORT = { Revenues: "Revenues", RevenueFromContractWithCustomerExcludingAssessedTax: "RFC", RegulatedAndUnregulatedOperatingRevenue: "RUOR" };

/** The short name of a revenue tag (RFC, RUOR) with the full tag as a tooltip. */
export function tagShort(tag) {
  const t = String(tag ?? "");
  const s = TAG_SHORT[t] ?? t;
  return s === t ? `<span class="tagname">${esc(t)}</span>` : `<abbr class="tagname" title="${esc(t)}">${esc(s)}</abbr>`;
}

export const TOOL_WORDS = {
  search_catalogue: "Search the catalogue",
  probe_source: "Probe a source's shape",
  propose_keys: "Propose join keys",
  measure_key: "Measure a key in Lightning SQL",
  register_source: "Register a source in Zetaris",
  compile_usl: "Compile the USL and run live DQ",
  answer: "Answer from the cached views",
  not_tested: "List what was not tested",
  finalize: "Write the note",
};

export function toolWord(tool) {
  return TOOL_WORDS[tool] ?? String(tool ?? "").replaceAll("_", " ");
}

/** "cold" / "warm" with what it means. */
export function modeWords(mode) {
  return mode === "warm" ? "Warm run" : mode === "cold" ? "Cold run" : "Run";
}

/** A run as a person reads it: "Cold run, Q1 2025, 25 Oct 2026 16:00 SGT". No id. */
export function runWords(r) {
  if (!r) return "";
  const when = fmtSgt(r.started_at_sgt ?? r.started_at, { seconds: false });
  return `${modeWords(r.mode)}, ${quarterWords(r.quarter)}${when ? `, ${when}` : ""}`;
}

/** An engineering id: hidden unless "Show engineering detail" is on. */
export function eng(html) {
  return `<span class="eng">${html}</span>`;
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

export const STREAM_EVENTS = ["stream", "run_started", "chunk_start", "planner", "tool", "chunk_end", "run_finished", "run_failed"];

/**
 * One run's event stream (GET /api/runs/:id/events): live while the run is running, replayed from
 * the saved run otherwise. The first event, "stream", says which. onEvent(type, data); onEnd() when
 * the server closes the stream. Returns the close function.
 */
export function openRunStream(runId, { delayMs = 0, onEvent, onEnd } = {}) {
  if (typeof EventSource === "undefined") return () => {};
  const src = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events${delayMs ? `?delay_ms=${delayMs}` : ""}`);
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    src.close();
    onEnd?.();
  };
  for (const t of STREAM_EVENTS) {
    src.addEventListener(t, (ev) => {
      let data = {};
      try {
        data = JSON.parse(ev.data);
      } catch {
        data = {};
      }
      onEvent?.(t, data);
      if (t === "run_finished" || t === "run_failed") end();
    });
  }
  // The server ends a stream by closing it; EventSource reports that as an error and would retry.
  src.addEventListener("error", () => end());
  return () => {
    ended = true;
    src.close();
  };
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
