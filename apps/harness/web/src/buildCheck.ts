import { z } from "zod";
import { getJson } from "./api";

const VersionSchema = z.object({ build: z.string() });

/**
 * A tab keeps running the bundle it loaded, however the server is redeployed.
 * When the served build changes, the tab reloads itself instead of talking to a
 * newer API with an older client.
 */
export function watchBuild(onStale: () => void, intervalMs = 30_000): () => void {
  let stopped = false;
  const check = async () => {
    try {
      const served = await getJson("/api/version", VersionSchema);
      if (!stopped && served.build !== "unknown" && served.build !== BUILD_ID) onStale();
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
    stopped = true;
    window.clearInterval(timer);
    window.removeEventListener("focus", onVisible);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
