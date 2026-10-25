// Per-job model settings: think on for planning, off for the memo (temperature 0, seed 7
// and num_ctx 8192 are set in ollama.ts). CW_THINK=off forces think off for every job.
// The host-RAM growth seen in the ClearShelf bench comes from the runner's prompt cache and
// happens in both think modes; think on roughly doubles each step, so this switch slows the
// growth but does not stop it. The RAM guard in ollama.ts is the protection.
// Starting values carried over from ClearShelf (same author, Apache-2.0); docs/nemotron-bench.md
// records what this entry measures. The planner output budget was raised from 2,048 to 3,072
// tokens after five live runs in which the model used the whole budget thinking on five
// planner calls and returned no JSON (D3); the repair round after such an empty reply runs
// with think off (generator.ts).

export type JobName = "planner" | "memo";

export interface JobSettings {
  think: boolean;
  num_predict: number;
}

export const ADOPTED_JOB_SETTINGS: Readonly<Record<JobName, Readonly<JobSettings>>> = {
  planner: { think: true, num_predict: 3072 },
  memo: { think: false, num_predict: 1024 },
};

export function jobSettings(job: JobName, env: Record<string, string | undefined> = process.env): JobSettings {
  const s = ADOPTED_JOB_SETTINGS[job];
  return env.CW_THINK === "off" ? { ...s, think: false } : { ...s };
}
