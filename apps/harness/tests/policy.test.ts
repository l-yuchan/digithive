import { describe, expect, test } from "bun:test";
import { BASE_POLICY, decide, decideWithSaved, matches } from "../src/core/policy";

describe("policy", () => {
  test("last matching rule wins", () => {
    const rules = [
      { action: "shell", resource: "*", effect: "ask" as const },
      { action: "shell", resource: "git status *", effect: "allow" as const },
    ];
    expect(decide(rules, { action: "shell", resource: "git status --short" })).toBe("allow");
    expect(decide(rules, { action: "shell", resource: "rm -rf /" })).toBe("ask");
  });

  test("no matching rule asks instead of silently allowing", () => {
    expect(decide([], { action: "write", resource: "/tmp/a" })).toBe("ask");
    expect(decide([{ action: "read", resource: "*", effect: "allow" }], { action: "write", resource: "/tmp/a" })).toBe("ask");
  });

  test("wildcards match whole values, and ? matches exactly one character", () => {
    expect(matches("*", "anything/at/all")).toBe(true);
    expect(matches("packages/*.md", "packages/a/b.md")).toBe(true);
    expect(matches("a?.txt", "ab.txt")).toBe(true);
    expect(matches("a?.txt", "abc.txt")).toBe(false);
  });

  test("a saved approval can never widen a configured deny", () => {
    const configured = [{ action: "shell", resource: "rm *", effect: "deny" as const }];
    const saved = [{ action: "shell", resource: "*", effect: "allow" as const }];
    expect(decideWithSaved(configured, saved, { action: "shell", resource: "rm -rf /tmp" })).toEqual({
      decision: "deny",
      by: "policy",
    });
  });

  test("a saved approval is used when policy has no stronger rule", () => {
    const configured = [{ action: "*", resource: "*", effect: "ask" as const }];
    const saved = [{ action: "shell", resource: "git status *", effect: "allow" as const }];
    expect(decideWithSaved(configured, saved, { action: "shell", resource: "git status --short" })).toEqual({
      decision: "allow",
      by: "saved",
    });
    expect(decideWithSaved(configured, saved, { action: "shell", resource: "git push" }).decision).toBe("ask");
  });

  test("base policy asks before reading env files", () => {
    expect(decide(BASE_POLICY, { action: "read", resource: "config/.env" })).toBe("ask");
    expect(decide(BASE_POLICY, { action: "read", resource: "config/.env.example" })).toBe("allow");
    expect(decide(BASE_POLICY, { action: "write", resource: "/tmp/x" })).toBe("allow");
  });
});
