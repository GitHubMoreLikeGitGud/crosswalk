# Scout Intent injection fixtures (vendored)

`adversarial.jsonl` is copied unchanged from the Meterless repository, `engines/scout-intent/evals/regression-set/v1/injection/adversarial.jsonl`, at commit `1742dec56a66e58eef9dda2d2b865823758ca8cd` (the commit `engines/UPSTREAM.md` records). Licence: Apache-2.0, as for the other Meterless engines.

SHA-256 of the file: `106a8653267e658b7e299d451da30a01b35da185a86ddf0103069c4b6702db11`.

It holds 10 cases: 7 injections and 3 clean controls. `agent/test/guard.test.ts` runs the Weather-or-Not guard (a partial reimplementation of Scout's injection check, adapted from ClearShelf, same author) on all of them. The food-domain fixtures in `../food-injection.ts` are synthetic (carried over from ClearShelf, same author) and exercise the guard's decision-tampering family.
