import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { EVENT_KINDS } from "../src/events/log";

/**
 * The event log accepts any string, so nothing forced its declared list to match
 * what is written: retired kinds sat next to live ones with no marker. This test
 * reads the source and keeps the list honest in both directions.
 *
 * Every declared kind is either written somewhere in `src` or listed in the
 * "Legacy kinds" section of the declaration, and a kind listed there must really
 * be gone. Non-event dotted literals (capabilities, file names) never equal a
 * declared kind, so they do not confuse the scan.
 */
function sourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

const declaration = join(import.meta.dir, "..", "src", "events", "log.ts");

function writtenKinds(): Set<string> {
  const found = new Set<string>();
  for (const file of sourceFiles(join(import.meta.dir, "..", "src"))) {
    if (file === declaration) continue;
    for (const match of readFileSync(file, "utf8").matchAll(/"([a-z_]+(?:\.[a-z_]+)+)"/g)) {
      const literal = match[1];
      if (literal !== undefined) found.add(literal);
    }
  }
  return found;
}

function legacySection(): Set<string> {
  const [, section] = readFileSync(declaration, "utf8").split("// Legacy kinds:");
  return new Set([...(section ?? "").matchAll(/"([a-z_.]+)"/g)].map((match) => match[1] ?? ""));
}

test("every declared kind is either written in src or marked legacy", () => {
  const written = writtenKinds();
  const legacy = legacySection();
  const unaccounted = EVENT_KINDS.filter((kind) => !written.has(kind) && !legacy.has(kind));
  expect(unaccounted).toEqual([]);
});

test("a kind marked legacy is not written anywhere", () => {
  const written = writtenKinds();
  const stillWritten = [...legacySection()].filter((kind) => written.has(kind));
  expect(stillWritten).toEqual([]);
});
