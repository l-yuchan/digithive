import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, loadConfig } from "../src/server/main";

test("new agents can publish whiteboard briefings but cannot run deterministic composition", () => {
  // Given the real runtime registry used by agent execution.
  const root = mkdtempSync(join(tmpdir(), "agent-tool-contract-"));
  const harness = createHarness(
    loadConfig({
      HARNESS_DB: join(root, "db.sqlite"),
      HARNESS_WORKSPACE: join(root, "workspace"),
      MODEL_BASE_URL: "http://127.0.0.1:1/v1",
    }),
  );
  try {
    // When the registered agent tool names are inspected.
    const names = harness.work.tools.tools.map((tool) => tool.name);
    // Then the whiteboard path is available and the legacy shortcut is absent.
    expect(names).toContain("briefing_publish");
    expect(names).toContain("whiteboard_read");
    expect(names).not.toContain("briefing_compose");
  } finally {
    harness.close();
    rmSync(root, { recursive: true, force: true });
  }
});
