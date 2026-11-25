import { describe, expect, test } from "bun:test";
import { createStaleGate } from "../web/src/buildCheck";

// A server left running across a rebuild serves the id it read at boot, so the
// mismatch never clears. Reloading on every check spun the real tab (measured at
// 93 navigations in 4 seconds), so the gate allows exactly one reload per page.
describe("createStaleGate", () => {
  test("reloads once and then stays quiet while the mismatch persists", () => {
    let reloads = 0;
    const gate = createStaleGate(() => {
      reloads += 1;
    });

    const fired: boolean[] = [];
    for (let i = 0; i < 20; i += 1) fired.push(gate.offer("served-newer"));

    expect(reloads).toBe(1);
    expect(fired.filter(Boolean)).toHaveLength(1);
    expect(gate.stopped).toBe(true);
  });

  test("an unknown served build is never a reload signal", () => {
    let reloads = 0;
    const gate = createStaleGate(() => {
      reloads += 1;
    });

    for (let i = 0; i < 5; i += 1) expect(gate.offer("unknown")).toBe(false);
    expect(reloads).toBe(0);
    expect(gate.stopped).toBe(false);
  });

  test("a stopped gate ignores later offers", () => {
    let reloads = 0;
    const gate = createStaleGate(() => {
      reloads += 1;
    });
    gate.stop();
    expect(gate.offer("served-newer")).toBe(false);
    expect(reloads).toBe(0);
  });
});
