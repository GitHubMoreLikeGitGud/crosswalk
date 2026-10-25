# Evaluation files

The report is [`../eval-report.md`](../eval-report.md). The JSON files in this folder are what it is generated from and what it measured on the side; none holds an SEC revenue value or an accession number (revenue appears only as a year-on-year change).

| File | What it holds | Written by |
|---|---|---|
| [`summary.json`](summary.json) | Everything the report prints, as data: the runs and their code, reproducibility (pairwise answer and join-map comparisons), the answer, model against baseline, outside checks, the manual baseline, agent against manual, the Nemotron ablation with the GPU samples' figures, timings per tool, per statement class and per template, what did not go well, not measured | `agent/src/eval/run.ts` from the saved runs |
| [`runs.json`](runs.json) | The seven Day-2 runs the report reads (id, label, the lane that ran it, setting, code commit) and the two Day-1 reference runs, with the code note and the hand-written lists of what did not go well and what was not measured | hand-written, read by `run.ts` |
| [`outside-checks.json`](outside-checks.json) | OpenFEMA fetched over HTTPS against the cached Zetaris views (rows, declarations, states, per-state counts) for CY2025Q1 and CY2024Q1, and two utilities' FY2024 10-K service states against the seed | `agent/src/eval/outside.ts` |
| [`sic-check.json`](sic-check.json) | SEC's own SIC code list (444 codes) against the company_dns list the SIC key and DQ rule read (1,005 codes): the 172 SEC codes company_dns lacks, 4900 among them, and the four seed SIC codes on each list | `scripts/sic_outside_check.py` |
| [`round3.md`](round3.md) | Round 3 (26 Oct), by hand: the Nemotron ablation at three runs per setting with Q8_0, the answer gate on thirteen live runs, the opaque-column experiment, and the cache-time fix | hand-written from the runs it lists |
| [`round3.json`](round3.json) | The data behind `round3.md`: per run, the id, setting, wall time, chunks, planner calls and rejected replies, fallback steps, tokens, tokens per second, model and baseline proposals, the join map's verdicts, the gate's decision per column, answer rows and identity with the reference, VRAM and the nvidia-smi peak and unload drops; for the opaque runs, each join-map row mapped back to the original columns | the round-3 analysis scripts, from the saved runs, the driver log and the nvidia-smi samples |
| [`manual-baseline.json`](manual-baseline.json) | The five keys found and verified by hand through the gateway: 29 steps (27 statements, 2 lookups) with parameters, elapsed ms, what each showed and the decision taken | `agent/src/eval/manual.ts` |

Regenerate the report and `summary.json` from the saved runs (no gateway or model call): `cd agent && npx tsx src/eval/run.ts --runs <dir of the ablation runs> --gpu <dir of its samples>`. The saved runs are not committed (they hold SEC values, which are queried live and not redistributed).
