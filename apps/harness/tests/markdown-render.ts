import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { safeHref } from "../web/src/markdown";
import { MarkdownText } from "../web/src/MarkdownText";

/**
 * The answer component as markup. The wrapper below is the app's own component, so the
 * properties asserted here are the ones the app renders; the link component is repeated
 * only because rendering it through the app would need its private list of components.
 */
export function renderMarkdown(markdown: string): string {
  const components = {
    a: ({ href, children }: { href?: string | undefined; children?: ReactNode }) => {
      const safe = safeHref(href);
      return safe === undefined
        ? createElement("span", null, children)
        : createElement(
            "a",
            { href: safe, target: "_blank", rel: "noopener noreferrer" },
            children,
          );
    },
  };
  return renderToStaticMarkup(
    createElement(Markdown, { remarkPlugins: [remarkGfm], components }, markdown),
  );
}

/** The app's own component, for the one assertion about its wrapper element. */
export function renderAppAnswer(markdown: string): string {
  return renderToStaticMarkup(createElement(MarkdownText, { text: markdown }));
}
