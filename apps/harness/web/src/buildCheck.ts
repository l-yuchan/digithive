import { z } from "zod";
import { getJson } from "./api";

const VersionSchema = z.object({ build: z.string() });

// Injected by the bundler (`define` in scripts/build-web.ts); absent when this
// module runs outside a build, so read it defensively.
function currentBuild(): string | null {
  return typeof BUILD_ID === "string" ? BUILD_ID : null;
}

/**
 * Decides whether a tab must reload, at most once per page life.
 *
 * A server that kept running across a rebuild keeps serving the id it read at boot,
 * so the mismatch never clears; reloading on every check turned the tab into a spin
 * (measured at 93 navigations in 4 seconds). Hence the one-shot latch: a second
 * reload can only come from a fresh page.
 */
export function createStaleGate(onStale: () => void) {
  let stopped = false;
  let fired = false;
  return {
    /** Returns true when this call triggered the single allowed reload. */
    offer(servedBuild: string): boolean {
      if (stopped || fired) return false;
      if (servedBuild === "unknown" || servedBuild === currentBuild()) return false;
      fired = true;
      stopped = true;
      onStale();
      return true;
    },
    stop(): void {
      stopped = true;
    },
    get stopped(): boolean {
      return stopped;
    },
  };
}

/**
 * A tab keeps running the bundle it loaded, however the server is redeployed.
 * When the served build changes, the tab reloads itself once instead of talking to
 * a newer API with an older client.
 */
export function watchBuild(onStale: () => void, intervalMs = 30_000): () => void {
  const gate = createStaleGate(onStale);
  const check = async () => {
    if (gate.stopped) return;
    try {
      const served = await getJson("/api/version", VersionSchema);
      gate.offer(served.build);
    } catch {
      // an unreachable server is not a stale-build signal
    }
  };
  const timer = window.setInterval(() => {
    check().catch(() => {});
  }, intervalMs);
  const onVisible = () => {
    if (document.visibilityState === "visible") check().catch(() => {});
  };
  window.addEventListener("focus", onVisible);
  document.addEventListener("visibilitychange", onVisible);
  check().catch(() => {});
  return () => {
    gate.stop();
    window.clearInterval(timer);
    window.removeEventListener("focus", onVisible);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
