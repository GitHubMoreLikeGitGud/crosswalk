# Crosswalk demo video: narration script

Spoken by a synthetic text-to-speech voice. Times are the start of each line in `crosswalk-demo.mp4` (v4, 3:14.3); the burned-in captions and [`crosswalk-demo.srt`](crosswalk-demo.srt) use the same text. Shots are in [`shotlist.md`](shotlist.md).

**0:00.3** One question, three agencies: which utilities served states with FEMA major-disaster declarations in Q1 2025, what did the weather do, and did revenue hold up?

**0:11.4** Crosswalk's answer: 12 utilities in 7 declared states. Revenue rose for 9, fell for 2, and 1 is not comparable. Degree days rose at the stations of all 12.

**0:23.3** A solo entry from Singapore.

**0:25.9** On one PC, the analyst asks it cold: the agent starts with no remembered keys.

**0:31.9** It searches a fixed catalogue, then probes each cached Zetaris view: its columns, five rows, and distinct counts.

**0:39.3** Nemotron, running locally, proposes join keys from a menu of the probed columns. A name-matching baseline also proposes keys. Nothing is used until it is measured.

**0:50.9** Each proposal is measured in Lightning SQL. The SEC company number, padded to ten digits, matches 97.7% of rows: verified, with IDACORP the orphan.

**1:03.0** FEMA states against the states the utilities serve: 87.5%, partial. Alaska is the orphan.

**1:11.8** The control, without the padding, matches none: rejected.

**1:20.0** The join map keeps every key: both rates, the verdict in plain words, and the orphans by name.

**1:26.3** MGE Energy is the one invalid row in the governed layer's data-quality check: its SIC code, 4900, is missing from the reference.

**1:36.5** Every number in the answer opens the Lightning SQL that produced it, with its rows, its time and its cache state.

**1:44.2** The same Zetaris instance: the registered sources, the crosswalk semantic layer with its keys, and its data-quality rules.

**1:56.3** Now the same question for Q1 2023, asked warm.

**2:06.5** The agent registers what that quarter lacks, live in Zetaris, under a signed contract: FEMA's declarations for the quarter, in 1.6 seconds.

**2:18.1** Then the year-earlier revenue frames, one tag at a time.

**2:28.2** Eight measure steps are skipped: those keys were verified by an earlier run and recalled from memory.

**2:34.6** On the same probes, the baseline verified 25 of 30 proposals, and the model verified 3 of 11. The baseline wins. Run by hand from statements prepared in advance, the five keys took 27 statements, 2 lookups and 24 decisions. The agent asks for none.

**2:51.8** Zetaris Lightning holds the sources, the cached views and the governed layer. Meterless gives the memory and the loop. Nemotron 3 Nano runs in Ollama on this PC.

**3:02.6** Crosswalk's answer: 12 utilities in 7 declared states. Every join key behind it was measured first.

## What changed from v3

- The v3 closing line "Crosswalk. Every key measured before anything uses it." is gone. It claimed more than the code did when it was recorded (the answer did not read the verdicts then, and a warm run reuses keys measured on another quarter). v4 ends on the answer: the opening answer sentence again (the same take), then one new line, "Every join key behind it was measured first.", about the Q1 2025 answer on screen: the cold run measured every key it joins on before the answer step.
- The new line is the only new speech: the same synthetic voice and engine as every other line, at the rate of the original kit (1.1), placed at the level of the old closing line. Every other line is the v3 take, unchanged.
- The compile_usl line of v3 ("compile_usl renders the semantic layer from the verified keys. It matches the governed one, and two data-quality rules run live.") is cut with the log-wall footage it covered. The semantic layer and its data-quality rules are still spoken over the DQ screen and the Zetaris UI.
- The evaluation lines now come before the sponsor lines.

## Where each spoken number comes from

| Spoken | Source |
| --- | --- |
| 12 utilities in 7 declared states; revenue rose for 9, fell for 2, 1 not comparable; degree days rose at the stations of all 12 | `README.md` (The demo result), `docs/eval-report.md` section 1 (the answer, identical in 6 cold runs); the cold run on camera gives the same 12 rows in every field (compared with run r20261025T1546471209) |
| 97.7% (company number padded to ten digits, IDACORP the orphan); 87.5% partial, Alaska the orphan; the control matches none | the cold run on camera (its timeline rows); `README.md` Evaluation table (42 / 43, 7 / 8, AK), `README.md` Why it matters (0 of 43 unpadded) |
| MGE Energy, SIC 4900, the one invalid row | `docs/demo-case.md`, `README.md` (the DQ paragraph: 4900 is on SEC's own SIC list; the company_dns reference lacks it), the USL and DQ screen on camera |
| FEMA's Q1 2023 declarations registered in 1.6 seconds | the warm run on camera (its register_source row, 1.6 s) |
| eight measure steps skipped | the warm run on camera (its timeline: 8 measure steps not run; its footer: 8 skipped) |
| 25 of 30 (baseline) and 3 of 11 (model) VERIFIED; the baseline wins | `docs/eval-report.md` section 2 (5 cold runs with the model) |
| run by hand from statements prepared in advance: 27 statements, 2 lookups and 24 decisions; the agent asks for none | `docs/eval-report.md` section 4 (manual baseline: "27 statements ..., 2 lookups without a statement, 33.7 s of statement time, 24 decisions"; each statement a gateway reader template, so the SQL was not typed from scratch). No time is spoken: the session's 179.5 s is not a measure of how long a person would take |
| every join key behind the answer measured first | the cold run on camera: its join map measured all 11 keys in the run (0 skipped, footer) before its answer step; `README.md` Evaluation (the answer gate, added after recording, replays this run to the same 12 rows) |
