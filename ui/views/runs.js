// Saved runs: the list from GET /api/runs, one run's run.json from GET /api/run/:id (cached, with
// the live status of its recast conflicts from GET /api/conflicts overlaid), and the "current run"
// the screens share (the last one opened, kept per browser tab).

import { api, rememberEvidence, sessionGet, sessionSet } from "../lib.js";

const CURRENT = "won.currentRun";
const cache = new Map();

export function currentRunId() {
  return sessionGet(CURRENT);
}

export function setCurrentRun(id) {
  if (typeof id === "string" && id) sessionSet(CURRENT, id);
}

/** The run list, newest first, whatever the server's envelope ({runs:[...]} or a bare array). */
export async function listRuns() {
  const r = await api("/api/runs");
  if (!r.ok) return { ok: false, res: r, runs: [] };
  const d = r.data;
  const runs = Array.isArray(d) ? d : Array.isArray(d?.runs) ? d.runs : [];
  runs.sort((a, b) => String(b.started_at ?? "").localeCompare(String(a.started_at ?? "")));
  return { ok: true, res: r, runs };
}

/** The live recast conflicts by id (GET /api/conflicts): an analyst override changes them after the run was saved. */
export async function liveConflicts() {
  const r = await api("/api/conflicts");
  const list = r.ok && Array.isArray(r.data?.conflicts) ? r.data.conflicts : [];
  return new Map(list.filter((c) => c && typeof c.id === "string").map((c) => [c.id, c]));
}

/** Overlays the live status, chosen value and override of each conflict on the run's saved copy. */
export function overlayConflicts(run, live) {
  const list = Array.isArray(run?.card?.recast_conflicts) ? run.card.recast_conflicts : [];
  if (!list.length || !run?.card) return run;
  run.card.recast_conflicts = list.map((c) => {
    const l = live.get(c.id);
    return l ? { ...c, status: l.status, chosen: l.chosen, chosen_val: l.chosen_val, override: l.override ?? null } : c;
  });
  return run;
}

/** One saved run (run.json); its evidence records are remembered so the drawer can show them offline. */
export async function loadRun(id) {
  if (!id) return { ok: false, status: 0, data: { error: "no run id" } };
  if (cache.has(id)) return { ok: true, status: 200, data: cache.get(id) };
  const r = await api(`/api/run/${encodeURIComponent(id)}`);
  if (r.ok && r.data && typeof r.data === "object") {
    if (Array.isArray(r.data.card?.recast_conflicts) && r.data.card.recast_conflicts.length) overlayConflicts(r.data, await liveConflicts());
    cache.set(id, r.data);
    rememberEvidence(r.data.evidence);
  }
  return r;
}

export function forgetRun(id) {
  cache.delete(id);
}

/** The run to show when a screen is opened without one: the current run if it is still saved, else the newest saved run. */
export async function pickRunId(explicit) {
  if (explicit) return explicit;
  const { runs } = await listRuns();
  const cur = currentRunId();
  if (cur && runs.some((r) => r.run_id === cur)) return cur;
  return runs[0]?.run_id ?? null;
}

/** The evidence ids behind each card section, from the checklist (the canonical map) with a claims-text fallback. */
export function sectionEvidence(run) {
  const by = {};
  for (const c of Array.isArray(run?.checklist) ? run.checklist : []) by[c.id] = Array.isArray(c.evidenceIds) ? c.evidenceIds : [];
  const claims = Array.isArray(run?.card?.claims) ? run.card.claims : [];
  const find = (re) => claims.filter((c) => re.test(String(c.text ?? ""))).flatMap((c) => c.evidenceIds ?? []);
  const pick = (ids, re) => (ids && ids.length ? ids : find(re));
  return {
    utility: pick(by.utility_resolved, /^SEC submissions profile|^Seed list/u),
    tag: pick(by.tag_chosen, /^Revenue tag|^tag:/u),
    growth: pick(by.revenue_like_for_like, /^companyconcept|like-for-like growth/u),
    peers: pick(by.peers_loaded, /^Peer set|^frames_seeds/u),
    weather: pick([...(by.weather_target ?? []), ...(by.weather_peers ?? [])], /^Degree.day/u),
    dq: pick(run?.card?.dq?.evidenceIds, /^DQ gate|^Onboarding DQ/u),
    attribution: pick(by.attribution_done, /^Attribution/u),
    verdict: pick(by.claim_tested, /^Claim "/u),
    not_tested: pick(by.not_tested_listed, /^Not tested/u),
    memo: pick(by.memo_written, /^Memo written/u),
  };
}
