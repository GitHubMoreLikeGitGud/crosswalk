// The committed redacted demo run (docs/demo-run/, scripts/make_demo_run.py): listed by the run store only while
// the data directory holds no run, marked source "demo", with synthetic values, and unchanged under the answer gate.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { replayAnswer, type SavedRunForGate } from "../src/eval/gateReplay.ts";
import type { RunResult } from "../src/loop/investigate.ts";
import { DEMO_RUNS_DIR, RunStore } from "../src/ops/runStore.ts";

describe("the committed demo run", () => {
  it("is listed, as source demo, while the data directory has no run of its own", () => {
    const store = new RunStore(mkdtempSync(join(tmpdir(), "cw-runs-")), DEMO_RUNS_DIR);
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ quarter: "CY2025Q1", mode: "cold", source: "demo", utilities: 12 });
    expect(store.servingDemo()).toBe(true);
    expect(store.latestId("CY2025Q1", "cold")).toBe(list[0]!.run_id);
    const run = store.load(list[0]!.run_id) as unknown as { fixture: { synthetic_values: boolean }; answer: { rows: unknown[] } };
    expect(run.fixture.synthetic_values).toBe(true);
    expect(run.answer.rows).toHaveLength(12);
  });
  it("disappears once the store saves a run of its own", () => {
    const store = new RunStore(mkdtempSync(join(tmpdir(), "cw-runs-")), DEMO_RUNS_DIR);
    const demo = store.load(store.list()[0]!.run_id)!;
    store.save({ ...(demo as unknown as RunResult), run_id: "r-own" }, { source: "test" });
    expect(store.list().map((r) => r.run_id)).toEqual(["r-own"]);
    expect(store.servingDemo()).toBe(false);
  });
  it("is not listed without a demo directory", () => {
    expect(new RunStore(mkdtempSync(join(tmpdir(), "cw-runs-"))).list()).toEqual([]);
  });
  it("its answer is unchanged when replayed under the answer gate", async () => {
    const store = new RunStore(mkdtempSync(join(tmpdir(), "cw-runs-")), DEMO_RUNS_DIR);
    const run = store.load(store.list()[0]!.run_id) as unknown as SavedRunForGate;
    const { gate, saved, replayed } = await replayAnswer(run);
    expect([gate.fema.ok, gate.revenue.ok]).toEqual([true, true]);
    expect(replayed).toEqual(saved);
  });
});
