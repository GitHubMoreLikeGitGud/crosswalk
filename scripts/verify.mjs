// One command for the README's "Verify in 3 minutes" box (no Zetaris, no GPU, no model):
// the agent tests and type check, the UI tests, the three Meterless conformance suites and the
// gateway tests, then one summary of the counts. From agent/ after `npm ci`:
//   npm run verify
// or from the repository root: node scripts/verify.mjs
// Needs Node 22.12 or newer, Python 3.12 (`python` on PATH, or the PYTHON variable) and git.
// The gateway tests use the virtual environment .venv at the repository root, created when absent.
// `npm install` in the vendored engines rewrites the licence field of their lock files; the files
// under engines/ that this run changed are restored afterwards with git checkout (the same step as
// in the box), and files that were already modified before the run are left alone.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const win = process.platform === "win32";
const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };
const strip = (s) => s.replace(/\u001b\[[0-9;]*m/g, "");
const results = [];
let failed = false;

function run(label, cmd, args, cwd, { shell = false } = {}) {
  process.stdout.write(`- ${label} ... `);
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { cwd, env, shell, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const out = strip(`${r.stdout ?? ""}${r.stderr ?? ""}`);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const ok = r.status === 0;
  console.log(`${ok ? "ok" : "FAILED"} (${secs} s)`);
  if (!ok) {
    failed = true;
    console.log(out.split("\n").slice(-40).join("\n"));
    if (r.error) console.log(String(r.error));
  }
  return { ok, out };
}

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failed = true;
}

function git(args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return r.status === 0 ? r.stdout : null;
}

const started = Date.now();
const commit = (git(["rev-parse", "--short", "HEAD"]) ?? "").trim() || "not a git checkout";
console.log(`Crosswalk verify, commit ${commit}, Node ${process.version}, ${process.platform}`);

// 1. Agent: vitest and the whole-tree type check.
const agent = join(root, "agent");
{
  const { ok, out } = run("agent tests (npm test)", "npm", ["test"], agent, { shell: true });
  const files = out.match(/Test Files\s+(\d+) passed \((\d+)\)/);
  const tests = out.match(/Tests\s+(\d+) passed \((\d+)\)/);
  record("agent tests", ok && !!tests, tests ? `${tests[1]} passed (${tests[2]}) in ${files ? files[1] : "?"} files` : "no count found");
  const tc = run("agent type check (npm run typecheck)", "npm", ["run", "typecheck"], agent, { shell: true });
  record("agent type check", tc.ok, tc.ok ? "tsc exit 0" : "tsc failed");
}

// 2. UI: node's own test runner, no dependencies.
{
  const dir = join(root, "ui", "test");
  const files = readdirSync(dir).filter((f) => f.endsWith(".test.mjs")).map((f) => join("ui", "test", f));
  const { ok, out } = run("UI tests (node --test)", process.execPath, ["--test", ...files], root);
  const tests = out.match(/# tests (\d+)/), pass = out.match(/# pass (\d+)/), fail = out.match(/# fail (\d+)/);
  record("UI tests", ok && !!pass, pass ? `tests ${tests?.[1]}, pass ${pass[1]}, fail ${fail?.[1]}` : "no count found");
}

// 3. Meterless conformance on the vendored engines.
{
  const dirty = (s) => new Set((s ?? "").split("\n").filter(Boolean).map((l) => l.slice(3).trim()));
  const before = dirty(git(["status", "--porcelain", "--", "engines"]));
  const suites = [
    ["hmem", "H-MEM conformance", false],
    ["markovian", "Markovian conformance", false],
    ["world-model", "World Model conformance", true],
  ];
  for (const [engine, name, idempotency] of suites) {
    const ref = join(root, "engines", engine, "reference");
    const inst = run(`${name}: npm install`, "npm", ["install", "--no-audit", "--no-fund"], ref, { shell: true });
    if (!inst.ok) { record(name, false, "npm install failed"); continue; }
    const { ok, out } = run(`${name}: runner`, "npx", ["tsx", "../conformance/runner.ts"], ref, { shell: true });
    const m = out.match(/(\d+)\/(\d+) checks passed/);
    let detail = m ? `${m[1]}/${m[2]} checks passed` : "no count found";
    let good = ok && !!m && m[1] === m[2];
    if (idempotency) {
      const idem = run(`${name}: idempotency check`, "npx", ["tsx", "scripts/idempotency-check.ts"], ref, { shell: true });
      const empty = /diff: empty/.test(idem.out);
      detail += empty ? "; idempotency diff: empty" : "; idempotency diff NOT empty";
      good = good && idem.ok && empty;
    }
    record(name, good, detail);
  }
  {
    // The Crosswalk H-MEM subclass through the engine's own runner (the CI step of the same name).
    env.HMEM_IMPL = join(agent, "src", "memory", "hmemFacade.ts");
    const { ok, out } = run("H-MEM conformance with the Crosswalk subclass", "npx", ["tsx", "../engines/hmem/conformance/runner.ts"], agent, { shell: true });
    delete env.HMEM_IMPL;
    const m = out.match(/(\d+)\/(\d+) checks passed/);
    record("H-MEM, Crosswalk subclass", ok && !!m && m[1] === m[2], m ? `${m[1]}/${m[2]} checks passed` : "no count found");
  }
  const after = git(["status", "--porcelain", "--", "engines"]);
  if (after === null) {
    console.log("- not a git checkout: the lock files under engines/ were not restored");
  } else {
    const changed = [...dirty(after)].filter((f) => !before.has(f));
    if (changed.length) git(["checkout", "--", ...changed]);
    const left = dirty(git(["status", "--porcelain", "--", "engines"]));
    const notRestored = [...left].filter((f) => !before.has(f));
    record("engines/ restored", notRestored.length === 0, `${changed.length} file(s) rewritten by npm install, restored; git status of engines/ ${left.size === 0 ? "clean" : `${left.size} file(s) modified before this run, left alone`}`);
  }
}

// 4. Gateway: pytest in .venv (the two live tests skip without a Zetaris).
{
  const venvPy = join(root, ".venv", win ? "Scripts" : "bin", win ? "python.exe" : "python");
  let ready = existsSync(venvPy);
  if (!ready) {
    const base = process.env.PYTHON || (win ? "python" : "python3");
    ready = run(`gateway: create .venv with ${base}`, base, ["-m", "venv", ".venv"], root).ok;
  }
  if (!ready) {
    record("gateway tests", false, "no Python virtual environment");
  } else {
    const pip = run("gateway: pip install -r gateway/requirements-dev.txt", venvPy, ["-m", "pip", "install", "-q", "--disable-pip-version-check", "-r", join("gateway", "requirements-dev.txt")], root);
    if (!pip.ok) {
      record("gateway tests", false, "pip install failed");
    } else {
      const { ok, out } = run("gateway tests (pytest)", venvPy, ["-X", "utf8", "-m", "pytest", join("gateway", "tests"), "-q"], root);
      const m = out.match(/(\d+) passed(?:, (\d+) skipped)?/);
      record("gateway tests", ok && !!m, m ? `${m[1]} passed, ${m[2] ?? 0} skipped` : "no count found");
    }
  }
}

const wall = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\nSummary, commit ${commit}:`);
const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  ${r.detail}`);
console.log(`  wall ${wall} s`);
process.exit(failed ? 1 : 0);
