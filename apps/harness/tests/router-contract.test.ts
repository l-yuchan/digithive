import { describe, expect, test } from "bun:test";
import {
  SETTINGS_CHILDREN,
  chatPath,
  collapsePath,
  isTabPath,
  routeOf,
  settingsChildOf,
  settingsPath,
  tabPath,
} from "../web/src/routes";
import { TAB_ROUTE } from "../src/server/auth";

/**
 * The client and the server each need to know the tab routes: the server to serve the
 * shell behind them and to keep them reachable before login, the client to decide which
 * tab a URL means. They are written twice, so this keeps the two lists equal.
 */
describe("the tab routes", () => {
  test("the server pattern is the one the client mirrors", () => {
    const paths = [
      "/chat",
      "/chat/abc",
      "/work",
      "/workflows",
      "/knowledge",
      "/whiteboard",
      "/settings",
      "/settings/providers",
      "/settings/accounts",
      "/settings/push",
      "/settings/briefings",
      // The address the 연결 tab used to have stays served, so an old link still works.
      "/connections",
    ];
    for (const path of paths) {
      expect(TAB_ROUTE.test(path)).toBe(true);
      expect(isTabPath(path)).toBe(true);
      if (path !== "/connections")
        expect(tabPath(routeOf(path).tab)).toBe(`/${path.split("/")[1]}`);
    }
    for (const path of ["/", "/app2", "/chat/a/b", "/api/health", "/nope", "/settings/unknown"]) {
      expect(TAB_ROUTE.test(path)).toBe(false);
    }
    expect(isTabPath("/")).toBe(true);
    expect(isTabPath("/nope")).toBe(false);
  });

  test("연결 is gone as a tab: its parts live under /settings", () => {
    // The one settings tab carries the four parts 연결 used to split from 설정.
    expect(Object.keys(SETTINGS_CHILDREN)).toEqual(["providers", "accounts", "push", "briefings"]);
    for (const child of ["providers", "accounts", "push", "briefings"] as const) {
      expect(routeOf(`/settings/${child}`)).toEqual({ tab: "settings", sessionId: null });
      expect(settingsChildOf(`/settings/${child}`)).toBe(child);
      expect(settingsPath(child)).toBe(`/settings/${child}`);
    }
    expect(settingsPath(null)).toBe("/settings");
    expect(settingsChildOf("/settings")).toBeNull();
    expect(settingsChildOf("/settings/unknown")).toBeNull();
    // `/connections` is not a tab any more; the client turns it into the accounts part.
    expect(routeOf("/connections")).toEqual({ tab: "chat", sessionId: null });
  });

  test("a path names its tab, and the chat tab names its conversation", () => {
    expect(routeOf("/")).toEqual({ tab: "chat", sessionId: null });
    expect(routeOf("/chat")).toEqual({ tab: "chat", sessionId: null });
    expect(routeOf("/chat/abc")).toEqual({ tab: "chat", sessionId: "abc" });
    expect(routeOf("/work")).toEqual({ tab: "work", sessionId: null });
    expect(routeOf("/workflows/")).toEqual({ tab: "workflows", sessionId: null });
    expect(routeOf("/knowledge")).toEqual({ tab: "knowledge", sessionId: null });
    expect(routeOf("/whiteboard")).toEqual({ tab: "whiteboard", sessionId: null });
    expect(routeOf("/settings")).toEqual({ tab: "settings", sessionId: null });
    // Anything else falls back to the chat tab rather than a blank screen.
    expect(routeOf("/nope")).toEqual({ tab: "chat", sessionId: null });
    expect(routeOf("/chat/a/b")).toEqual({ tab: "chat", sessionId: null });
  });

  test("paths encode and decode a conversation id", () => {
    const id = "bb0e277f-b729-42f6-a621-0362df129b62";
    expect(chatPath(id)).toBe(`/chat/${id}`);
    expect(routeOf(chatPath(id))).toEqual({ tab: "chat", sessionId: id });
    expect(chatPath(null)).toBe("/chat");
    expect(chatPath(undefined)).toBe("/chat");
    const korean = "대화/하나";
    expect(chatPath(korean)).toBe(`/chat/${encodeURIComponent(korean)}`);
    expect(routeOf(chatPath(korean)).sessionId).toBe(korean);
  });

  test("every tab has one fixed path and the chat tab carries the conversation", () => {
    expect(tabPath("work")).toBe("/work");
    expect(tabPath("workflows")).toBe("/workflows");
    expect(tabPath("knowledge")).toBe("/knowledge");
    expect(tabPath("whiteboard")).toBe("/whiteboard");
    expect(tabPath("settings")).toBe("/settings");
    expect(tabPath("chat", "x")).toBe("/chat/x");
    expect(tabPath("chat")).toBe("/chat");
  });

  test("an address that repeated separators still names its tab, once", () => {
    // Reported from the live site: three conversation switches from /chat left
    // `//chat//chat//chat/<id>`, and moving to the work tab and then workflows from
    // there left `//chat//chat//chat///workflows`. A browser keeps those as pushed.
    const id = "900a78a8-8570-4867-9112-d9bbda54d142";
    expect(routeOf(`//chat//chat//chat/${id}`)).toEqual({ tab: "chat", sessionId: id });
    expect(routeOf(`//chat//chat//chat/${id}///workflows`)).toEqual({
      tab: "workflows",
      sessionId: null,
    });
    expect(routeOf(`/chat/${id}///work`)).toEqual({ tab: "work", sessionId: null });
    expect(routeOf("//chat/")).toEqual({ tab: "chat", sessionId: null });
    // A repeated tab name is never a conversation.
    expect(routeOf("//chat//chat//chat")).toEqual({ tab: "chat", sessionId: null });
    expect(routeOf("/chat/chat")).toEqual({ tab: "chat", sessionId: null });
    // A word after a conversation names the tab the address opened, never a second
    // segment, so `/chat/a/b` stays on the chat tab with no conversation.
    expect(routeOf("/chat/a/workflows")).toEqual({ tab: "workflows", sessionId: null });
    expect(routeOf("/chat/a/b")).toEqual({ tab: "chat", sessionId: null });
    // The path the app writes from a collapsed route is the canonical one.
    expect(tabPath("workflows")).toBe("/workflows");
  });

  test("collapsing a path is one pass, however many separators it repeats", () => {
    expect(collapsePath("/")).toEqual([]);
    expect(collapsePath("/chat/x")).toEqual(["chat", "x"]);
    expect(collapsePath("//a///b//")).toEqual(["a", "b"]);
    const many = `/${"/".repeat(20_000)}chat`;
    expect(collapsePath(many)).toEqual(["chat"]);
  });
});
