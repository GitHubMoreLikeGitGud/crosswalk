# Crosswalk demo video: narration script

Spoken by a synthetic text-to-speech voice. Times are the start of each line in `crosswalk-demo.mp4`; the burned-in captions and [`crosswalk-demo.srt`](crosswalk-demo.srt) use the same text. Shots are in [`shotlist.md`](shotlist.md).

**0:00.3** One question, three agencies: which utilities served states with FEMA major-disaster declarations in Q1 2025, what did the weather do, and did revenue hold up?

**0:11.4** Crosswalk's answer: 12 utilities in 7 declared states. Revenue rose for 9, fell for 2, and 1 is not comparable. Degree days rose at the stations of all 12.

**0:23.3** A solo entry from Singapore.

**0:25.9** On one PC, the analyst asks it cold: the agent starts with no remembered keys.

**0:33.8** It searches a fixed catalogue, then probes each cached Zetaris view: its columns, five rows, and distinct counts.

**0:46.1** Nemotron, running locally, proposes join keys from a menu of the probed columns. A name-matching baseline also proposes keys. Nothing is used until it is measured.

**0:59.7** Each proposal is measured in Lightning SQL. The SEC company number, padded to ten digits, matches 97.7% of rows: verified, with IDACORP the orphan.

**1:13.5** FEMA states against the states the utilities serve: 87.5%, partial. Alaska is the orphan.

**1:23.5** The control, without the padding, matches none: rejected.

**1:26.8** compile_usl renders the semantic layer from the verified keys. It matches the governed one, and two data-quality rules run live.

**1:42.0** The join map keeps every key: both rates, the verdict in plain words, and the orphans by name.

**1:48.4** MGE Energy is the one invalid row in the governed layer's data-quality check: its SIC code, 4900, is missing from the reference.

**1:58.6** Every number in the answer opens the Lightning SQL that produced it, with its rows, its time and its cache state.

**2:06.3** The same Zetaris instance: the registered sources, the crosswalk semantic layer with its keys, and its data-quality rules.

**2:18.4** Now the same question for Q1 2023, asked warm.

**2:28.7** The agent registers what that quarter lacks, live in Zetaris, under a signed contract: FEMA's declarations for the quarter, in 1.6 seconds.

**2:40.2** Then the year-earlier revenue frames, one tag at a time.

**2:50.3** Eight measure steps are skipped: those keys were verified by an earlier run and recalled from memory.

**2:56.8** Zetaris Lightning holds the sources, the cached views and the governed layer. Meterless gives the memory and the loop. Nemotron 3 Nano runs in Ollama on this PC.

**3:07.4** On the same probes, the baseline verified 25 of 30 proposals, and the model verified 3 of 11. The baseline wins. By hand, an expert verified the five keys in 179.5 seconds, faster, but with 24 decisions. The agent asks for none.

**3:24.7** Crosswalk. Every key measured before anything uses it.

## Where each spoken number comes from

| Spoken | Source |
| --- | --- |
| 12 utilities in 7 declared states; revenue rose for 9, fell for 2, 1 not comparable; degree days rose at the stations of all 12 | `README.md` (The demo result), `docs/eval-report.md` section 1 (the answer, identical in 6 cold runs); the cold run on camera gives the same 12 rows in every field (compared with run r20261025T1546471209) |
| 97.7% (company number padded to ten digits, IDACORP the orphan); 87.5% partial, Alaska the orphan; the control matches none | the cold run on camera (its timeline rows); `docs/eval-report.md` section 4 (42 / 43, 7 / 8, AK, 0 of 43 unpadded) |
| MGE Energy, SIC 4900, the one invalid row | `docs/demo-case.md`, `docs/eval-report.md` section 4, the USL and DQ screen on camera |
| FEMA's Q1 2023 declarations registered in 1.6 seconds | the warm run on camera (its register_source row, 1.6 s) |
| eight measure steps skipped | the warm run on camera (its timeline: 8 measure steps not run; its footer: 8 skipped) |
| 25 of 30 (baseline) and 3 of 11 (model) VERIFIED; the baseline wins | `docs/eval-report.md` section 2 (5 cold runs with the model) |
| 179.5 seconds and 24 decisions by hand; the agent asks for none | `docs/eval-report.md` section 4 (manual baseline). The 179.5 s is the session time of statements pre-written as gateway templates, not a person's time to write and read them; the spoken "an expert" says more than that section measures |
