import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sdkFilePath, syncSdkFile } from "../sdk/generated";

/**
 * The app's workflow scripts ship in `jobs/`, beside `src/`: they are product
 * files, never server code. An `@builtin/` path runs that shipped file itself, and
 * any other path runs its installed copy under `<scriptsRoot>/jobs/`.
 *
 * Such a job imports the generated SDK from its own directory, `./.digithive/sdk.ts`.
 * The SDK is therefore planted beside the job — under `jobs/` — never one level up.
 * An install that reached only `<scriptsRoot>/.digithive` left every job failing to
 * start with "Cannot find module '../.digithive/sdk.ts'", the import of a layout
 * where jobs sat one directory higher.
 *
 * The container runs with `HARNESS_SCRIPTS_ROOT=/app/jobs`, which is exactly the
 * shipped directory: job and SDK are copied into the image together. Anywhere else
 * (a local run, tests) the shipped files are planted under `<scriptsRoot>/jobs/`.
 * The files under version control are never overwritten.
 */
export const JOB_SOURCE_ROOT = resolve(import.meta.dir, "..", "..", "jobs");

/** The app's own script jobs, planted under the scripts root at every start. */
export const JOB_FILES = ["collection.ts", "briefing.ts"] as const;
export type JobFile = (typeof JOB_FILES)[number];

function sourceOf(file: JobFile): string {
  return readFileSync(join(JOB_SOURCE_ROOT, file), "utf8");
}

/** Every directory a job's `./.digithive/sdk.ts` import resolves under. */
export function sdkRootsFor(scriptsRoot: string): string[] {
  return [...new Set([join(scriptsRoot, "jobs"), JOB_SOURCE_ROOT].map((root) => resolve(root)))];
}

/** Writes the generated SDK wherever a job's import can land. Returns the new paths. */
function plantSdk(scriptsRoot: string): string[] {
  const source = readFileSync(sdkFilePath(scriptsRoot), "utf8");
  const written: string[] = [];
  for (const root of sdkRootsFor(scriptsRoot)) {
    const path = sdkFilePath(root);
    if (existsSync(path) && readFileSync(path, "utf8") === source) continue;
    mkdirSync(join(root, ".digithive"), { recursive: true });
    writeFileSync(path, source, "utf8");
    written.push(path);
  }
  return written;
}

/**
 * Copies a job only when its content differs. Returns the paths that changed.
 * The SDK is written first: it is what the copied job imports.
 */
export function installJobs(scriptsRoot: string): string[] {
  syncSdkFile(scriptsRoot);
  const target = join(scriptsRoot, "jobs");
  if (resolve(target) === JOB_SOURCE_ROOT) return plantSdk(scriptsRoot);
  mkdirSync(target, { recursive: true });
  const written: string[] = [];
  for (const file of JOB_FILES) {
    const path = join(target, file);
    const content = sourceOf(file);
    if (existsSync(path) && readFileSync(path, "utf8") === content) continue;
    copyFileSync(join(JOB_SOURCE_ROOT, file), path);
    written.push(path);
  }
  return [...plantSdk(scriptsRoot), ...written];
}
