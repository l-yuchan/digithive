import type { Database } from "bun:sqlite";
import { createWhiteboardStore } from "../whiteboard";
import type { SearchConfig, SearchHit } from "../search";
import { webSearchTools } from "../tools/web-search";
import { whiteboardTools } from "../tools/whiteboard";
import { createWhiteboardEvidence } from "../tools/whiteboard-evidence";

/** Whiteboard/search composition shared by the HTTP server and worker. */
export function createWhiteboardTools(input: {
  readonly db: Database;
  readonly root: string;
  readonly search: SearchConfig;
}) {
  const whiteboard = createWhiteboardStore(input.db, input.root);
  whiteboard.refresh();
  const evidence = createWhiteboardEvidence();
  const archive = (query: string, hits: readonly SearchHit[]) => {
    const archiveId = crypto.randomUUID();
    const now = Date.now();
    const iso = new Date(now).toISOString();
    const stamp = `${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
    return hits.map((hit) => {
      const document = whiteboard.write({
        path: `records/web/${iso.slice(0, 10)}/${stamp}-${archiveId}-${hit.provider}-${hit.position}.md`,
        kind: "record",
        title: hit.title,
        text: `${hit.snippet}\n\n[원문](${hit.url})\n\n검색어: ${query}\n검색 시각: ${iso}`,
        source: {
          type: "web_search",
          id: archiveId,
          provider: hit.provider,
          query,
          url: hit.url,
          position: hit.position,
        },
        now,
      });
      return { id: document.id, path: document.path };
    });
  };
  return {
    whiteboard,
    evidence,
    tools: [
      ...whiteboardTools({ whiteboard, evidence }),
      ...webSearchTools({ config: input.search, archive }),
    ],
  };
}
