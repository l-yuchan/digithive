/**
 * The generated script SDK lives beside the jobs that import it and is never tracked,
 * so a fresh checkout has none. The app writes it at startup; `lint`, `typecheck` and
 * `test` run on a checkout that has not started the app, so they call this first.
 *
 * Every job under `jobs/` imports `./.digithive/sdk.ts` and this writes exactly the
 * `SCRIPT_SDK_SOURCE` the runtime writes. The example copy under `scripts/jobs/` sits
 * outside the lint roots and is typed by the tracked stand-in beside it.
 */
import { join } from "node:path";
import { jobSdkFilePath, syncJobSdkFile } from "./generated";

const root = join(import.meta.dir, "..", "..");
const jobs = join(root, "jobs");
syncJobSdkFile(jobs);
console.log(`script sdk: ${jobSdkFilePath(jobs)}`);
