import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PressDetector } from "../dist/press.js";

const TIMING = { longPressMs: 40, doublePressMs: 25 };

function createDetector(timing = TIMING) {
  const presses = [];
  const detector = new PressDetector(timing, (press) => presses.push(press));
  return { detector, presses };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("PressDetector", () => {
  it("reports a tap as a single press once the double-press window closes", async () => {
    const { detector, presses } = createDetector();
    detector.handle("Press");
    detector.handle("Release");
    assert.deepEqual(presses, []);
    await wait(40);
    assert.deepEqual(presses, ["single"]);
  });

  it("reports two quick taps as one double press", async () => {
    const { detector, presses } = createDetector();
    detector.handle("Press");
    detector.handle("Release");
    await wait(5);
    detector.handle("Press");
    detector.handle("Release");
    await wait(60);
    assert.deepEqual(presses, ["double"]);
  });

  it("reports two slow taps as two single presses", async () => {
    const { detector, presses } = createDetector();
    for (let tap = 0; tap < 2; tap++) {
      detector.handle("Press");
      detector.handle("Release");
      await wait(40);
    }

    assert.deepEqual(presses, ["single", "single"]);
  });

  it("reports a hold as a long press while the button is still down, and ignores its release", async () => {
    const { detector, presses } = createDetector();
    detector.handle("Press");
    await wait(60);
    assert.deepEqual(presses, ["long"]);
    detector.handle("Release");
    await wait(40);
    assert.deepEqual(presses, ["long"]);
  });

  it("reports a tap followed by a hold as a long press only", async () => {
    const { detector, presses } = createDetector();
    detector.handle("Press");
    detector.handle("Release");
    await wait(5);
    detector.handle("Press");
    await wait(60);
    detector.handle("Release");
    await wait(40);
    assert.deepEqual(presses, ["long"]);
  });

  it("fires single presses on release when double press is off", () => {
    const { detector, presses } = createDetector({ longPressMs: 40, doublePressMs: 0 });
    detector.handle("Press");
    detector.handle("Release");
    detector.handle("MultiTap");
    assert.deepEqual(presses, ["single", "single"]);
  });

  it("accepts the bridge's own LongHold and MultiTap events", async () => {
    const { detector, presses } = createDetector();
    detector.handle("Press");
    detector.handle("LongHold");
    await wait(60);
    detector.handle("Release");
    detector.handle("MultiTap");
    assert.deepEqual(presses, ["long", "double"]);
  });

  it("ignores stray releases, unknown events, and presses cut off by a reset", async () => {
    const { detector, presses } = createDetector();
    detector.handle("Release");
    detector.handle("Wiggle");
    detector.handle("Press");
    detector.reset();
    detector.handle("Release");
    detector.handle("Press");
    detector.handle("Release");
    detector.reset();
    await wait(60);
    assert.deepEqual(presses, []);
  });

  it("survives a throwing listener", async () => {
    const detector = new PressDetector({ longPressMs: 40, doublePressMs: 0 }, () => {
      throw new Error("boom");
    });
    detector.handle("Press");
    assert.doesNotThrow(() => detector.handle("Release"));
  });
});
