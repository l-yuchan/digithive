export const APP_VERSION = "0.0.1";

/**
 * The visible release label: the app version and the commit the bundle was built from.
 * A build context without repository metadata reports `unknown` rather than an
 * incomplete label, so the screen always names something identifiable.
 */
export function buildVersion(version: string, commit: string): string {
  const base = version.trim() || "0.0.0";
  const hash = commit.trim() || "unknown";
  return `${base}-${hash}`;
}

/**
 * `BUILD_VERSION` is injected by `scripts/build-web.ts`. This module is also loaded
 * outside a bundle (tests, a preview), where the identifier is absent; read it
 * defensively so those contexts still render a stable label.
 */
export function appVersion(
  injected: string | undefined = typeof BUILD_VERSION === "string" ? BUILD_VERSION : undefined,
): string {
  const value = injected?.trim() ?? "";
  return value.length > 0 ? value : buildVersion(APP_VERSION, "");
}
