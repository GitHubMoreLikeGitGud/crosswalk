// One time zone on every screen (SPEC D20): Singapore time, UTC+08:00, no daylight saving.
// Pure functions of the timestamp they are given; nothing here reads the clock.

const SGT_OFFSET_MS = 8 * 3_600_000;

/** "2026-10-25 14:57:17 SGT" for an ISO timestamp with any offset; null when absent or unparseable. */
export function sgt(iso: string | null | undefined): string | null {
  if (!iso) return null;
  // The gateway writes offsets without a colon (+0800); Date.parse wants +08:00.
  const fixed = /[+-]\d{4}$/u.test(iso) ? `${iso.slice(0, -2)}:${iso.slice(-2)}` : iso;
  const t = Date.parse(fixed);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t + SGT_OFFSET_MS).toISOString();
  return `${d.slice(0, 10)} ${d.slice(11, 19)} SGT`;
}

/** Milliseconds as seconds with one decimal (wall times on the footer). */
export function seconds(ms: number | null | undefined): number | null {
  return typeof ms === "number" && Number.isFinite(ms) ? Math.round(ms / 100) / 10 : null;
}
