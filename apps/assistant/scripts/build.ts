const result = await Bun.build({
  entrypoints: ["scripts/doctor.ts", "src/server/main.ts"],
  outdir: "dist",
  target: "bun",
});

if (!result.success) {
  for (const message of result.logs) {
    console.error(message.message);
  }
  process.exitCode = 1;
} else {
  console.log(`Built ${result.outputs.length} runnable preflight artifact(s).`);
}
