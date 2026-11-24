import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const outdir = resolve(root, "web/dist");

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const result = await Bun.build({
  entrypoints: [resolve(root, "web/src/main.tsx")],
  outdir,
  target: "browser",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
});

if (!result.success) {
  for (const entry of result.logs) console.error(entry);
  process.exit(1);
}

await Bun.write(resolve(outdir, "index.html"), await Bun.file(resolve(root, "web/index.html")).text());
await Bun.write(resolve(outdir, "styles.css"), await Bun.file(resolve(root, "web/src/styles.css")).text());

console.log(`web built: ${result.outputs.map((output) => output.path).join(", ")}`);
