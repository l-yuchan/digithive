import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { APP_VERSION, buildVersion } from "../web/src/version.ts";

const root = resolve(import.meta.dir, "..");
const outdir = resolve(root, "web/dist");
// One id per build: the browser compares it with /api/version and reloads when
// the server starts serving a different bundle.
const buildId = new Date().toISOString();

/**
 * The commit the bundle is built from. A container build context has no repository
 * metadata, so CD passes the commit as `GIT_COMMIT`; a local build falls back to git.
 * A short hash keeps the label readable in the tab. The env value accepts a full SHA.
 */
function buildCommit(): string {
  const supplied = (process.env["GIT_COMMIT"] ?? process.env["BUILD_COMMIT"] ?? "").trim();
  if (supplied.length > 0) return supplied.slice(0, 7);
  try {
    const result = Bun.spawnSync(["git", "rev-parse", "--short=7", "HEAD"], {
      cwd: root,
      stderr: "ignore",
    });
    if (result.exitCode === 0) {
      const hash = result.stdout.toString().trim();
      if (hash.length > 0) return hash;
    }
  } catch {
    // A source tarball or Docker context has no repository to ask.
  }
  return "unknown";
}

const version = buildVersion(APP_VERSION, buildCommit());

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const result = await Bun.build({
  entrypoints: [resolve(root, "web/src/main.tsx")],
  outdir,
  target: "browser",
  minify: true,
  define: {
    "process.env.NODE_ENV": '"production"',
    BUILD_ID: JSON.stringify(buildId),
    BUILD_VERSION: JSON.stringify(version),
  },
});

if (!result.success) {
  for (const entry of result.logs) console.error(entry);
  process.exit(1);
}

/**
 * The shell is also served behind every tab route ("/chat/<id>", "/workflows"), where a
 * relative asset path resolves inside the route and loads nothing, so web/index.html
 * references its assets from the server root. A preview opened from a different mount
 * rewrites those two references back to relative ones.
 */
await Bun.write(
  resolve(outdir, "index.html"),
  await Bun.file(resolve(root, "web/index.html")).text(),
);
if (process.env["PREVIEW_ASSETS"] === "1") {
  const shell = await Bun.file(resolve(outdir, "index.html")).text();
  await Bun.write(
    resolve(outdir, "index.html"),
    shell
      .replace('href="/styles.css"', 'href="./styles.css"')
      .replace('src="/main.js"', 'src="./main.js"'),
  );
}
await Bun.write(
  resolve(outdir, "styles.css"),
  await Bun.file(resolve(root, "web/src/styles.css")).text(),
);
await Bun.write(resolve(outdir, "sw.js"), await Bun.file(resolve(root, "web/sw.js")).text());
await Bun.write(resolve(outdir, "build.json"), JSON.stringify({ id: buildId, version }));

console.log(`web built: ${result.outputs.map((output) => output.path).join(", ")}`);
