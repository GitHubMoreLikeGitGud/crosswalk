// Moves the wall clock forward for a whole test run (the CI step "clock moved forward"; SPEC L7).
// Date.now(), new Date() and Date() without arguments return the real time plus CW_FAKE_CLOCK_DAYS
// days (default 400); a Date built from a given value is unchanged. A test that compares against
// today's date fails under it; tests that inject their dates pass. Loaded with
//   NODE_OPTIONS=--import ../.github/scripts/fake-date.mjs   (from agent/)
// which every test worker process inherits.

const days = Number(process.env.CW_FAKE_CLOCK_DAYS ?? 400);
const offset = Number.isFinite(days) ? days * 86_400_000 : 0;
const RealDate = Date;
const shiftedNow = () => RealDate.now() + offset;

globalThis.Date = new Proxy(RealDate, {
  construct(target, args, newTarget) {
    return Reflect.construct(target, args.length === 0 ? [shiftedNow()] : args, newTarget);
  },
  apply() {
    return new RealDate(shiftedNow()).toString();
  },
  get(target, prop, receiver) {
    if (prop === "now") return shiftedNow;
    return Reflect.get(target, prop, receiver);
  },
});
