import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinTools } from "../src/tools/builtins";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("workspace tools reject traversal and symlinks without changing outside files", async () => {
  const root = mkdtempSync(join(tmpdir(), "workspace-boundary-"));
  roots.push(root);
  const base = join(root, "run");
  const outside = join(root, "run-other");
  mkdirSync(base);
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "private");
  symlinkSync(outside, join(base, "link"), process.platform === "win32" ? "junction" : "dir");
  const tools = builtinTools({ root });
  for (const name of ["workspace_read", "workspace_write"]) {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error("missing workspace tool");
    for (const path of ["../run-other/secret.txt", "link/secret.txt", "link/new.txt", "../run-other/new.txt", outside]) {
      await expect(tool.execute({ path, text: "overwrite" }, { runId: "run" })).rejects.toThrow("path_outside_workspace");
    }
  }
  expect(await Bun.file(join(outside, "secret.txt")).text()).toBe("private");
  expect(existsSync(join(outside, "new.txt"))).toBe(false);
});

test("workspace tools round-trip a nested file within a newly created run", async () => {
  const root = mkdtempSync(join(tmpdir(), "workspace-valid-"));
  roots.push(root);
  const tools = builtinTools({ root });
  const write = tools.find((tool) => tool.name === "workspace_write");
  const read = tools.find((tool) => tool.name === "workspace_read");
  if (!write || !read) throw new Error("missing workspace tools");
  await write.execute({ path: "nested/note.txt", text: "memo" }, { runId: "new-run" });
  expect(await read.execute({ path: "nested/note.txt" }, { runId: "new-run" })).toBe("memo");
});
