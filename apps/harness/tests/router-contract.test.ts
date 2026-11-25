import { describe, expect, test } from "bun:test";
import { TAB_PATHS, chatPath, isTabPath, routeOf, tabPath } from "../web/src/routes";
import { TAB_ROUTE } from "../src/server/auth";

/**
 * The client and the server each need to know the tab routes: the server to serve the
 * shell behind them and to keep them reachable before login, the client to decide which
 * tab a URL means. They are written twice, so this keeps the two lists equal.
 */
describe("the tab routes", () => {
  test("the server pattern is the one the client mirrors", () => {
    const paths = ["/chat", "/chat/abc", "/work", "/workflows", "/connections", "/knowledge"];
    for (const path of paths) {
      expect(TAB_ROUTE.test(path)).toBe(true);
      expect(isTabPath(path)).toBe(true);
      const route = routeOf(path);
      expect(tabPath(route.tab, route.sessionId)).toBe(path);
    }
    for (const path of ["/", "/app2", "/chat/a/b", "/api/health", "/nope"]) {
      expect(TAB_ROUTE.test(path)).toBe(false);
    }
    expect(isTabPath("/")).toBe(true);
    expect(isTabPath("/nope")).toBe(false);
  });

  test("a path names its tab, and the chat tab names its conversation", () => {
    expect(routeOf("/")).toEqual({ tab: "chat", sessionId: null });
    expect(routeOf("/chat")).toEqual({ tab: "chat", sessionId: null });
    expect(routeOf("/chat/abc")).toEqual({ tab: "chat", sessionId: "abc" });
    expect(routeOf("/work")).toEqual({ tab: "work", sessionId: null });
    expect(routeOf("/workflows/")).toEqual({ tab: "workflows", sessionId: null });
    expect(routeOf("/connections")).toEqual({ tab: "connections", sessionId: null });
    expect(routeOf("/knowledge")).toEqual({ tab: "knowledge", sessionId: null });
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
    expect(tabPath("work")).toBe(TAB_PATHS.work);
    expect(tabPath("workflows")).toBe("/workflows");
    expect(tabPath("connections")).toBe("/connections");
    expect(tabPath("knowledge")).toBe("/knowledge");
    expect(tabPath("chat", "x")).toBe("/chat/x");
    expect(tabPath("chat")).toBe("/chat");
  });
});
