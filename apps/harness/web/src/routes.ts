/**
 * The app's tab routes, dependency-free so both the client and a contract test can
 * read them. The server holds the same list (`TAB_ROUTE` in `src/server/auth.ts`) and
 * serves the shell behind each of them.
 */
export type Tab = "chat" | "work" | "workflows" | "connections" | "knowledge" | "whiteboard";

export const TAB_PATHS: Record<Tab, string> = {
  chat: "/chat",
  work: "/work",
  workflows: "/workflows",
  connections: "/connections",
  knowledge: "/knowledge",
  whiteboard: "/whiteboard",
};

const FIXED_TABS: readonly Tab[] = ["work", "workflows", "connections", "knowledge", "whiteboard"];

/**
 * The problem this solves, recorded because it was reported from the live site: the
 * tab links multiplied their own separators. `/chat` opened became `//chat`, and a
 * conversation switch made `//chat/chat/<id>`; after three switches and a tab change
 * the address read `//chat//chat//chat///workflows`. A browser keeps an address exactly
 * as it was pushed, so the parser must accept them, and the app must never write one.
 *
 * Parsing, stated plainly:
 *   - empty segments (whatever a run of slashes produced) do not exist;
 *   - the word `chat` repeated directly after itself is the tab naming itself again,
 *     which a doubled slash produced, so only the first one counts;
 *   - `chat` takes at most one id, and a tab word after that id is the tab, not a
 *     second conversation.
 */
/** The tab a word names, or null when it names no tab. */
function fixedTab(word: string): Tab | null {
  for (const tab of FIXED_TABS) if (tab === word) return tab;
  return null;
}

export function routeOf(pathname: string): { tab: Tab; sessionId: string | null } {
  const pieces: string[] = [];
  for (const part of pathname.split("/")) if (part !== "") pieces.push(part);

  const cleaned: string[] = [];
  for (const part of pieces) {
    const last = cleaned.length === 0 ? null : cleaned[cleaned.length - 1];
    if (part === "chat" && last === "chat") continue;
    cleaned.push(part);
  }

  const head: string | undefined = cleaned[0];
  if (head === undefined) return { tab: "chat", sessionId: null };
  if (head !== "chat") {
    const fixed = fixedTab(head);
    return fixed === null ? { tab: "chat", sessionId: null } : { tab: fixed, sessionId: null };
  }
  if (cleaned.length > 2) {
    const after = fixedTab(cleaned[2] ?? "");
    return after === null ? { tab: "chat", sessionId: null } : { tab: after, sessionId: null };
  }
  const id = cleaned.length === 2 ? cleaned[1] : null;
  if (id === null || id === undefined) return { tab: "chat", sessionId: null };
  try {
    return { tab: "chat", sessionId: decodeURIComponent(id) };
  } catch {
    return { tab: "chat", sessionId: null };
  }
}

/** The segments of a path with the empty ones dropped. */
export function collapsePath(pathname: string): string[] {
  const segments: string[] = [];
  for (const part of pathname.split("/")) if (part !== "") segments.push(part);
  return segments;
}

export function chatPath(sessionId: string | null | undefined): string {
  return sessionId ? `/chat/${encodeURIComponent(sessionId)}` : TAB_PATHS.chat;
}

export function tabPath(tab: Tab, sessionId?: string | null): string {
  return tab === "chat" ? chatPath(sessionId) : TAB_PATHS[tab];
}

/** True for the paths the shell answers: the root and every tab route. */
export function isTabPath(pathname: string): boolean {
  if (pathname === "/") return true;
  return TAB_ROUTE_MIRROR.test(pathname);
}

/**
 * Kept byte-identical in shape to the server's pattern; `tests/router-contract.test.ts`
 * fails when the two disagree.
 */
const TAB_ROUTE_MIRROR =
  /^\/(chat(?:\/[^/]+)?|work|workflows|connections|knowledge|whiteboard)\/?$/;

export const TAB_ROUTE_PATTERN = TAB_ROUTE_MIRROR.source;
