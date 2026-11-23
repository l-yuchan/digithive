set -euo pipefail
ROOT=/tmp/dg-qa
rm -rf "$ROOT"
mkdir -p "$ROOT/ctx" "$ROOT/work/inputs/transform" "$ROOT/work/inputs/escape" "$ROOT/work/inputs/spin"

cat > "$ROOT/work/inputs/transform/main.ts" <<'TS'
const flag = process.argv[2];
const value = process.argv[3] ?? "";
const text = (flag === "--uppercase" ? value.toUpperCase() : value) + "\n";
await Bun.write("/out/result.txt", text);
console.log("TRANSFORMED " + text.trim().length);
TS

cat > "$ROOT/work/inputs/escape/main.ts" <<'TS'
const result: Record<string, unknown> = {
  uid: typeof process.getuid === "function" ? process.getuid() : -1,
};
try {
  await Bun.file("/etc/shadow").text();
  result.secret_read = "allowed";
} catch {
  result.secret_read = "blocked";
}
try {
  const response = await fetch("https://example.com", { signal: AbortSignal.timeout(3000) });
  result.network = response.ok ? "allowed" : "blocked";
} catch {
  result.network = "blocked";
}
try {
  await Bun.write("/root/probe", "x");
  result.rootfs_write = "allowed";
} catch {
  result.rootfs_write = "blocked";
}
console.log(JSON.stringify(result));
TS

cat > "$ROOT/work/inputs/spin/main.ts" <<'TS'
console.log("SPIN_START");
while (true) {
  // deliberately unbounded: the runner must terminate this container on timeout
}
TS

printf 'canary-content-unchanged\n' > "$ROOT/work/host-canary.txt"
sha256sum "$ROOT/work/host-canary.txt" | tee "$ROOT/canary-before.txt"
docker ps -a --format '{{.Names}}' | sort > "$ROOT/containers-before.txt"
docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^dg-' | sort > "$ROOT/images-before.txt" || true
echo PREPARED
