import { describe, expect, test } from "bun:test";
import { renderAppAnswer, renderMarkdown } from "./markdown-render";

/**
 * What the answer component renders, checked as markup. The risk it guards is the model
 * (and, through tool output quoted into an answer, the outside world) writing HTML: raw
 * tags must stay text and a script URL must not become a link.
 */
describe("an answer rendered as markdown", () => {
  test("a GFM table, a list, inline code and a fenced block become elements", () => {
    const html = renderMarkdown(
      "| a | b |\n| - | - |\n| 1 | 2 |\n\n- 하나\n- 둘\n\n`code`\n\n```js\nconst x = 1;\n```\n",
    );
    expect(html).toContain("<table>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<pre><code");
    expect(html).toContain("const x = 1;");
  });

  test("a web link is clickable and opens in a new tab", () => {
    const html = renderMarkdown("[열기](https://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  test("a script URL never becomes a link", () => {
    const html = renderMarkdown("[누르면](javascript:alert(1))");
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain("javascript:");
  });

  test("the app's answer component is the one rendering it", () => {
    expect(renderAppAnswer("**굵게**")).toContain("<strong>굵게</strong>");
    expect(renderAppAnswer("**굵게**")).toContain('data-testid="event-text"');
  });

  test("raw HTML in an answer stays text", () => {
    const html = renderMarkdown("<script>alert(1)</script>");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });
});
