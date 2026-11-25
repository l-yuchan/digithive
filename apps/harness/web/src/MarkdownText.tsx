import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { safeHref } from "./markdown";

/**
 * The assistant's own words, rendered as markdown.
 *
 * Only the answer goes through here: a user's message is what they typed, reasoning is
 * the model talking to itself, and tool output is data — all three stay literal. Raw
 * HTML in the model's answer is not rendered (react-markdown escapes it), and a link
 * whose scheme is not web or mail loses its href instead of becoming clickable.
 */
const COMPONENTS = {
  a: ({ href, children }: { href?: string | undefined; children?: React.ReactNode }) => {
    const safe = safeHref(href);
    return safe === undefined ? (
      <span>{children}</span>
    ) : (
      <a href={safe} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
};

const PLUGINS = [remarkGfm];

export function MarkdownText({ text }: { readonly text: string }) {
  return (
    <div className="event text markdown" data-testid="event-text">
      <Markdown remarkPlugins={PLUGINS} components={COMPONENTS}>
        {text}
      </Markdown>
    </div>
  );
}
