import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The app's workflow scripts ship in `jobs/`, beside `src/`: they are product
 * files, never server code. The container copies them to `/app/jobs` and runs with
 * `HARNESS_SCRIPTS_ROOT=/app/jobs`, so a script's own `../.digithive/sdk.ts`
 * import resolves to the generated SDK exactly like it does in the checkout.
 *
 * While the scripts root does happen to be the checkout's `jobs/` parent, the
 * install is a no-op: a local run must never overwrite the files under version
 * control. Anywhere else (tests, a fresh root) the shipped files are planted.
 */
export const JOB_SOURCE_ROOT = resolve(import.meta.dir, "..", "..", "jobs");

/** The app's own script jobs, planted under the scripts root at every start. */
export const JOB_FILES = ["collection.ts", "briefing.ts"] as const;
export type JobFile = (typeof JOB_FILES)[number];

function sourceOf(file: JobFile): string {
  return readFileSync(join(JOB_SOURCE_ROOT, file), "utf8");
}

/** Copies a job only when its content differs. Returns the paths that changed. */
export function installJobs(scriptsRoot: string): string[] {
  const target = join(scriptsRoot, "jobs");
  if (resolve(target) === JOB_SOURCE_ROOT) return [];
  mkdirSync(target, { recursive: true });
  const written: string[] = [];
  for (const file of JOB_FILES) {
    const path = join(target, file);
    const content = sourceOf(file);
    if (existsSync(path) && readFileSync(path, "utf8") === content) continue;
    copyFileSync(join(JOB_SOURCE_ROOT, file), path);
    written.push(path);
  }
  return written;
}
