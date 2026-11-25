/**
 * The app's tab routes, dependency-free so both the client and a contract test can
 * read them. The server holds the same list (`TAB_ROUTE` in `src/server/auth.ts`) and
 * serves the shell behind each of them.
 */
export type Tab = "chat" | "work" | "workflows" | "connections" | "knowledge";

export const TAB_PATHS: Record<Tab, string> = {
  chat: "/chat",
  work: "/work",
  workflows: "/workflows",
  connections: "/connections",
  knowledge: "/knowledge",
};

const FIXED_TABS: readonly Tab[] = ["work", "workflows", "connections", "knowledge"];

/** The tab a pathname belongs to, and the conversation it names (chat only). */
/**
 * A same-origin URL for a tab. The path alone is not enough: the app is also reachable
 * under a prefix (and from the file:// shell in a test), so links keep the current
 * directory and only replace the trailing segments.
 */
export function tabHref(tab: Tab, base: string, sessionId?: string | null): string {
  const root = base.replace(/[^/]*$/, "");
  const path = tabPath(tab, sessionId).replace(/^\//, "");
  return `${root}${path}`;
}

export function routeOf(pathname: string): { tab: Tab; sessionId: string | null } {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  const head = segments[0];
  if (head === undefined) return { tab: "chat", sessionId: null };
  const fixed = FIXED_TABS.find((tab) => tab === head);
  if (fixed) return { tab: fixed, sessionId: null };
  if (head !== "chat") return { tab: "chat", sessionId: null };
  const id = segments[1];
  if (id === undefined || segments.length > 2) return { tab: "chat", sessionId: null };
  try {
    return { tab: "chat", sessionId: decodeURIComponent(id) };
  } catch {
    return { tab: "chat", sessionId: null };
  }
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
const TAB_ROUTE_MIRROR = /^\/(chat(?:\/[^/]+)?|work|workflows|connections|knowledge)\/?$/;

export const TAB_ROUTE_PATTERN = TAB_ROUTE_MIRROR.source;
