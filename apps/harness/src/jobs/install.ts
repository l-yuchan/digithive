import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** The job sources ship in the app's `jobs/` directory, beside `src/` and `scripts/`. */
export const JOB_SOURCE_ROOT = resolve(import.meta.dir, "..", "..", "jobs");

/** The app's own script jobs, installed under the scripts root at every start. */
export const JOB_FILES = ["collection.ts", "briefing.ts"] as const;
export type JobFile = (typeof JOB_FILES)[number];

/**
 * A job script reaches the app only through the SDK and the bridge, and it lives
 * one directory below the scripts root, so its `../.digithive/sdk.ts` import is
 * already correct wherever the root is — unless the root is the app directory
 * itself, where that relative import would climb out of the scripts root. In that
 * case the copy is written with the SDK's absolute path instead.
 */
function sourceFor(scriptsRoot: string, file: JobFile): string {
  const source = readFileSync(join(JOB_SOURCE_ROOT, file), "utf8");
  const sdk = join(scriptsRoot, ".digithive", "sdk.ts");
  // `<root>/../.digithive/sdk.ts` is the same file only when the root is the app root.
  return resolve(scriptsRoot) === resolve(JOB_SOURCE_ROOT, "..")
    ? source
    : source.replace('"../.digithive/sdk.ts"', JSON.stringify(sdk.split("\\").join("/")));
}

/** Rewrites a job only when its content changed, so a stable root stays quiet. */
export function installJobs(scriptsRoot: string): string[] {
  const target = join(scriptsRoot, "jobs");
  mkdirSync(target, { recursive: true });
  const written: string[] = [];
  for (const file of JOB_FILES) {
    const path = join(target, file);
    const content = sourceFor(scriptsRoot, file);
    if (existsSync(path) && readFileSync(path, "utf8") === content) continue;
    writeFileSync(path, content, "utf8");
    written.push(path);
  }
  return written;
}
