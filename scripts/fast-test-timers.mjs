/**
 * Test-only timing shim.
 *
 * The HID drivers encode real hardware settle and poll delays — hundreds of
 * milliseconds up to two seconds, often retried — because a physical mouse
 * needs that long to answer. A fake device in a test answers synchronously, so
 * those waits are pure idle time: one file alone (`mchose/hid.test.ts`) spent
 * ~190 s of the suite's wall clock asleep.
 *
 * Node runs every test file in its own worker whose argv[1] is the test file,
 * so this collapses `setTimeout` delays for that worker. A handful of tests
 * deliberately assert *real* elapsed timing (a minimum gap between writes, a
 * calibration settle window, a telemetry quiet period); collapsing timers there
 * would be wrong, so those files keep real timers via the list below. If you
 * add a test that measures elapsed time, add it here too.
 *
 * Loaded from the `test` script via `--import`. It only ever touches test
 * worker processes, never the runner, and never production code.
 */
import { sep } from "node:path";

/** Test files that assert real elapsed timing and must keep real timers. */
const TIMING_ASSERTING = [
  // Receiver writes must keep a minimum real gap between overlapping calls.
  "attackshark/hid.test.ts",
  // Magnetic-button calibration follows live readings across a settle window.
  "gwolves/magnetic.test.ts",
  // Telemetry must stay quiet for a real interval before it is accepted.
  "pulsar/pulsar-areson-hid.test.ts",
];

/** Longest delay a mocked timer is allowed to take. */
const MAX_DELAY_MS = 1;

const testFile = (process.argv[1] ?? "").split(sep).join("/");
const isWorker = testFile.endsWith(".test.ts");
const assertsTiming = TIMING_ASSERTING.some((suffix) => testFile.endsWith(suffix));

if (isWorker && !assertsTiming) {
  const realSetTimeout = globalThis.setTimeout.bind(globalThis);
  globalThis.setTimeout = (callback, delay = 0, ...args) =>
    realSetTimeout(callback, typeof delay === "number" ? Math.min(delay, MAX_DELAY_MS) : delay, ...args);
}
