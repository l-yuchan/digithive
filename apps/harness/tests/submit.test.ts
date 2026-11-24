import { describe, expect, test } from "bun:test";
import { shouldSubmit } from "../web/src/composer/submit";

describe("composer submit rules", () => {
  test("Enter submits", () => {
    expect(shouldSubmit({ key: "Enter", shiftKey: false })).toBe(true);
  });

  test("Shift+Enter inserts a newline instead of sending", () => {
    expect(shouldSubmit({ key: "Enter", shiftKey: true })).toBe(false);
  });

  test("Enter during a Korean IME composition never submits", () => {
    expect(shouldSubmit({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
    expect(
      shouldSubmit({ key: "Enter", shiftKey: false, nativeEvent: { isComposing: true } }),
    ).toBe(false);
    expect(shouldSubmit({ key: "Enter", shiftKey: false, keyCode: 229 })).toBe(false);
  });

  test("other keys never submit", () => {
    expect(shouldSubmit({ key: "a", shiftKey: false })).toBe(false);
    expect(shouldSubmit({ key: "Escape", shiftKey: false })).toBe(false);
  });
});
