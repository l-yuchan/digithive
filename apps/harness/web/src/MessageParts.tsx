import type { Part } from "./api";

export function MessageParts({ parts }: { readonly parts: readonly Part[] }) {
  return parts.map((part, index) => {
    switch (part.type) {
      case "text":
        return (
          <p key={index} className="text">
            {part.text}
          </p>
        );
      case "reasoning":
        // Closed by default: the model's internal reasoning stays reachable but never
        // becomes the visible answer, and it is frequently not in the user's language.
        return (
          <details key={index} className="reasoning" data-testid="reasoning">
            <summary>생각 과정</summary>
            <p>{part.text}</p>
          </details>
        );
      case "tool_call":
        return (
          <details key={index} className="tool-call" data-testid="tool-call">
            <summary>도구 호출 · {part.name}</summary>
            <pre>{part.arguments}</pre>
          </details>
        );
      case "tool_result":
        return (
          <details
            key={index}
            className={part.denied ? "tool-result denied" : "tool-result"}
            data-testid="tool-result"
            open={part.denied || part.timeout}
          >
            <summary>
              {part.denied ? "거부됨" : part.timeout ? "시간 초과" : "결과"} · {part.name}
            </summary>
            <pre>{part.output}</pre>
          </details>
        );
      case "error":
        return (
          <pre key={index} className="error">
            {part.message}
          </pre>
        );
      default: {
        const unexpected: never = part;
        throw new Error(`Unknown message part: ${JSON.stringify(unexpected)}`);
      }
    }
  });
}
