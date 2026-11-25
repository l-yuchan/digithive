import { useRef, useState } from "react";
import { shouldSubmit } from "./submit";

/**
 * The message box. It never disables itself for a running answer: what the owner types
 * while the assistant is answering becomes a queued message, shown above the box until
 * it runs. Only a turn that has been submitted and not yet accepted is held back by
 * `busy`, which is a network state, not a reason to stop typing.
 */
export function Composer({
  busy = false,
  onSend,
}: {
  readonly busy?: boolean;
  readonly onSend: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const composing = useRef(false);

  const submit = () => {
    const value = text.trim();
    if (value.length === 0) return;
    setText("");
    onSend(value);
  };

  return (
    <form
      className="composer"
      data-testid="composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label className="visually-hidden" htmlFor="chat-input">
        메시지
      </label>
      <textarea
        id="chat-input"
        data-testid="chat-input"
        rows={2}
        value={text}
        placeholder="무엇을 도와드릴까요? 응답 중에 보내면 차례로 실행됩니다."
        onChange={(event) => setText(event.target.value)}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          if (event.nativeEvent.isComposing || composing.current) return;
          if (
            !shouldSubmit({
              key: event.key,
              shiftKey: event.shiftKey,
              isComposing: event.nativeEvent.isComposing,
              keyCode: event.keyCode,
            })
          )
            return;
          event.preventDefault();
          submit();
        }}
      />
      <button className="primary" type="submit" data-testid="chat-send" disabled={busy}>
        보내기
      </button>
    </form>
  );
}
