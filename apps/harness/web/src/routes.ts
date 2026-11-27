/**
 * The app's tab routes, dependency-free so both the client and a contract test can
 * read them. The server holds the same list (`TAB_ROUTE` in `src/server/auth.ts`) and
 * serves the shell behind each of them.
 *
 * 연결 used to be its own tab beside 설정; they are one settings tab now, and each part
 * of it is a child route (`/settings/providers`, `/settings/accounts`, …) so a part can
 * be linked, bookmarked and reloaded on its own.
 */
export type Tab = "chat" | "work" | "workflows" | "knowledge" | "whiteboard" | "settings";

export type SettingsChild = "providers" | "accounts" | "push" | "briefings";

export const SETTINGS_CHILDREN: Readonly<Record<SettingsChild, string>> = {
  providers: "모델 공급자",
  accounts: "계정",
  push: "알림",
  briefings: "브리핑",
};

export const TAB_PATHS: Record<Tab, string> = {
  chat: "/chat",
  work: "/work",
  workflows: "/workflows",
  knowledge: "/knowledge",
  whiteboard: "/whiteboard",
  settings: "/settings",
};

const FIXED_TABS: readonly Tab[] = ["work", "workflows", "knowledge", "whiteboard", "settings"];

/** The part of the settings tab an address names; the overview when it names none. */
export function settingsChildOf(pathname: string): SettingsChild | null {
  const pieces = collapsePath(pathname);
  if (pieces[0] !== "settings") return null;
  const word = pieces[1];
  if (word === "providers" || word === "accounts" || word === "push" || word === "briefings")
    return word;
  return null;
}

/** The address of a settings child; no child is the overview. */
export function settingsPath(child: SettingsChild | null): string {
  return child === null ? TAB_PATHS.settings : `${TAB_PATHS.settings}/${child}`;
}

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

/** True for the paths the shell answers: the root, every tab, and the settings children. */
export function isTabPath(pathname: string): boolean {
  if (pathname === "/") return true;
  return TAB_ROUTE_MIRROR.test(pathname);
}

/**
 * Kept byte-identical in shape to the server's pattern; `tests/router-contract.test.ts`
 * fails when the two disagree. `/connections` is no longer a tab, but its address still
 * answers so an old link reaches the accounts it used to show.
 */
const TAB_ROUTE_MIRROR =
  /^\/(chat(?:\/[^/]+)?|work|workflows|connections|knowledge|whiteboard|settings(?:\/(?:providers|accounts|push|briefings))?)\/?$/;

export const TAB_ROUTE_PATTERN = TAB_ROUTE_MIRROR.source;
