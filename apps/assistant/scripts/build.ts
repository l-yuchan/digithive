const result = await Bun.build({
  entrypoints: ["scripts/doctor.ts", "src/server/main.ts", "scripts/worker.ts", "src/web/app.ts"],
  outdir: "dist",
  target: "bun",
});

const assets = Bun.build({
  entrypoints: ["src/web/app.ts", "src/web/files.ts", "src/web/memory.ts", "src/web/connections.ts"],
  outdir: "dist/public",
  target: "browser",
  naming: "[name].js",
});

const built = await Promise.all([result, assets]);
await Bun.write("dist/public/styles.css", Bun.file("src/web/styles.css"));

if (built.some((bundle) => !bundle.success)) {
  for (const bundle of built) {
    for (const message of bundle.logs) {
      console.error(message.message);
    }
  }
  process.exitCode = 1;
} else {
  const count = built.reduce((total, bundle) => total + bundle.outputs.length, 0);
  console.log(`Built ${count} artifact(s) plus styles.css.`);
}
