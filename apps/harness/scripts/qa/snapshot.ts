import { resolve } from "node:path";
import { write } from "bun";

export type SnapshotSurface = {
  evaluate<T>(callback: () => T): Promise<Awaited<T>>;
};

/** Captures the current authenticated rendered DOM with its real CSS, without scripts. */
export async function saveStaticSnapshot(
  surface: SnapshotSurface,
  baseUrl: string,
  directory: string,
  filename: string,
): Promise<void> {
  const response = await fetch(`${baseUrl}/styles.css`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`snapshot_styles_${response.status}`);
  const css = await response.text();
  const html = await surface.evaluate(() => document.documentElement.outerHTML);
  const staticDocument = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  await write(
    resolve(directory, filename.replace(/\.png$/, ".html")),
    `<base href="${baseUrl}/"><style>${css}</style>${staticDocument}`,
  );
}
