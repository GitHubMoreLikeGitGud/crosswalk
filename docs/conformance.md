# Meterless conformance results

Run on 25 Oct 2026 against the engines vendored in `engines/` (upstream `Meterless/Meterless` commit `1742dec56a66e58eef9dda2d2b865823758ca8cd`, see [`engines/UPSTREAM.md`](../engines/UPSTREAM.md)), on a fresh clone of this repository at commit `078f890`. Windows 11, Node v22.13.1, Git Bash. Each engine was installed with `npm install` in its `reference/` folder, then run exactly as its conformance README says. `npm install` rewrites the licence field of the vendored lock files, so they were restored afterwards with `git checkout -- engines`; `git status --short engines` was empty at the end. The same commands run in CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)).

## Summary

| Check | Command (working directory) | Result | Exit code |
|---|---|---|---|
| H-MEM conformance, vendored reference | `npx tsx ../conformance/runner.ts` (`engines/hmem/reference`) | **13/13 checks passed** | 0 |
| Markovian conformance, vendored reference | `npx tsx ../conformance/runner.ts` (`engines/markovian/reference`) | **8/8 checks passed** | 0 |
| World Model conformance, vendored reference | `npx tsx ../conformance/runner.ts` (`engines/world-model/reference`) | **8/8 checks passed** | 0 |
| World Model idempotency check | `npx tsx scripts/idempotency-check.ts` (`engines/world-model/reference`) | **diff: empty** | 0 |
| **H-MEM conformance, Crosswalk subclass** | `HMEM_IMPL=<repo>/agent/src/memory/hmemFacade.ts npx tsx ../engines/hmem/conformance/runner.ts` (`agent`) | **13/13 checks passed**; the runner prints `implementation = .../agent/src/memory/hmemFacade.ts` | 0 |

`git diff -- engines/` is empty: the subclass and the wrappers live in `agent/src/` and change nothing under `engines/`.

## Output

### H-MEM (13 checks; the same 13 pass with the Crosswalk subclass)

```
  record-validation
    PASS rv-001 a record with no source is rejected by construction
    PASS rv-002 a record with a source is accepted
  feedback-deltas
    PASS fd-001 helpful adds exactly +0.05 confidence and +1 accessCount
    PASS fd-002 not_helpful subtracts exactly 0.03
    PASS fd-003 wrong subtracts exactly 0.20 and adds the review tag
    PASS fd-004 confidence clamps at 0 (wrong at 0.1)
    PASS fd-005 confidence clamps at 1 (helpful at 0.98)
  ranking-order
    PASS ro-001 superseded penalty dominates: a superseded record ranks below a fresh one with identical content relevance
    PASS ro-002 confidence multiplies the whole score: identical records rank by confidence
  sleep-guardrails
    PASS sg-001 old low-access plain record archives; dream-derived record with identical age does not
  conflict-gate
    PASS cg-001 auto-resolve marks the loser supersededBy and deletes nothing
  ledger-audit
    PASS la-001 create then feedback reconstructs: actions in order, previous and new confidence present
  dream-boundary
    PASS db-001 dream proposals never materialize before approval; approval creates a long_term record with lineage
  13/13 checks passed
```

### Markovian (8 checks)

```
  PASS eff-001 efficiency model reproduces the documented worked example: N=20 -> 86% (within 0.5%)
  PASS snap-001 run records carry a mandatory chunkConfig snapshot
  PASS snap-002 historical efficiency is computed against the run's own snapshot, not current config
  PASS ovl-001 overlap contract: implement [OVERLAP] or reject non-zero; accept-and-ignore fails
  PASS lab-001 token numbers are labeled: runs carry estimated or measured
  PASS ref-001 reflection failure does not fail the run
  PASS mrk-001 markers are cleaned from display content and drive completion
  PASS cfg-001 config bounds reject out-of-range values with a typed error, never silent truncation
  8/8 checks passed
```

### World Model (8 checks) and the idempotency check

```
  PASS sid-001 stable ids: diacritics and NBSP normalize identically (NFKD + strip marks)
  PASS sid-002 stable ids: distinct names stay distinct (no over-normalization)
  PASS band-001 merge bands at the boundaries: 0.85 auto, 0.84 review, 0.82 review, 0.81 new
  PASS prov-001 writes without provenance are rejected
  PASS idem-001 ingest idempotency: same batch twice produces an empty diff
  PASS idem-002 the idempotency check can fail: a mutated batch changes the shape
  PASS bitemp-001 bitemporal edges: a superseding edge closes the old one; point-in-time queries respect validity
  PASS audit-001 every mutation writes an audit entry in order
  8/8 checks passed

run 1: processed=3 clusters=1 changed=true
run 2: processed=0 skipped=3 changed=false
diff: empty
```

## What the Crosswalk code adds to each engine, and how the contract is kept

| Engine | Where | Addition | Contract kept |
|---|---|---|---|
| H-MEM | `agent/src/memory/hmemFacade.ts`, `seed.ts` | `key_verified` facts `{left, right, transform, rate, verdict, orphans, sql, run_id, validFrom, measured_as, history}` keyed by `{left, right, transform}` with period-specific view names generalised to their family (`cw.frames_<tag>_<period>`, `cw.fema_declarations_dr_<quarter>`); every measured key is remembered, only VERIFIED keys are recalled, and one recalled memory is one skipped measure step. `source_access` facts `{object, registered_at, rows, contract_id}` for views registered at run time. At boot the store is seeded from the Zetaris getting-started manifest and its issue notes, the Day-0 prechecks, and every catalogue `known_to_fail` entry as a negative memory. `why(memoryId)` returns the memory, its provenance and its ledger. | Every write goes through the reference store and ledger; `add`, `query` and `feedback` are not overridden; nothing is deleted. The engine's own runner loads the subclass through `HMEM_IMPL` and passes 13/13. |
| Markovian | `agent/src/loop/investigate.ts`, `generator.ts`, `tools.ts`, `checklist.ts`, `telemetry.ts` | One question is one chain: at most 12 chunks, `carryoverTokens` 800, up to three tool calls per chunk. The generator asks Nemotron for the next step among those the 10-item checklist allows, runs it through the host's `NEEDS_TOOL` executor, digests the result and plans again; an invalid reply gets one repair round (think off after an empty length-cut reply), a second failure makes the host take the next checklist step itself and labels it a fallback. Token numbers are labelled `measured` (Ollama counts) or `estimated` (chars/4). | The vendored orchestrator runs unchanged; the generator is the engine's own extension point. |
| World Model | `agent/src/world/` | Entities dataset, column, utility, state and declaration; edges `has_column`, `crosswalks_to` (transform, rate, verdict, valid from the measurement time), `serves` and `declared_in` (valid from the declaration date). `keyHistory(left, right)` and `utilityHistory(cik)` answer "what did we know, and since when" (`npm run cli -- known`). | Every write carries provenance and a source time; re-ingesting the same rows is idempotent, as the reference requires. |
| Scout Intent | `agent/src/contract/`, `gateway/contracts.py` | A partial reimplementation, labelled as such (no reference engine is vendored): HMAC-signed, single-use execution contracts that expire within 15 minutes, medium risk for every `register_source` call, verified by the Python gateway with a shared test vector. | An integrity check, not cryptographic-grade security. |
