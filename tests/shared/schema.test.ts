import { describe, expect, test } from "bun:test";
import { createEntryRequestSchema, promoteRequestSchema } from "../../src/shared/schema";

describe("shared request schemas", () => {
  test("accepts matching entry context and optional scope", () => {
    const parsed = createEntryRequestSchema.parse({
      kind: "fact",
      text: "Decision recorded",
      context: { kind: "fact", decided_at: null },
      scope: "work",
    });
    expect(parsed.scope).toBe("work");
  });

  test("rejects mismatched entry context", () => {
    expect(createEntryRequestSchema.safeParse({
      kind: "fact",
      text: "Decision recorded",
      context: { kind: "interest", why_it_matters: null, known_obstacle: null, interruption: "when_strong" },
    }).success).toBe(false);
  });

  test("requires scope when promoting to delegation", () => {
    expect(promoteRequestSchema.safeParse({ to: "delegation" }).success).toBe(false);
    expect(promoteRequestSchema.safeParse({ to: "delegation", scope: "bounded task" }).success).toBe(true);
  });
});
