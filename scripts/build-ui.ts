import { mkdir } from "node:fs/promises";

const output = "public";
await mkdir(output, { recursive: true });
const result = await Bun.build({
  entrypoints: ["src/frontend/app.ts"],
  outdir: output,
  naming: "app.js",
  target: "browser",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exitCode = 1;
}
