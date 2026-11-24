import { useRef, useState } from "react";
import { shouldSubmit } from "./submit";

export function Composer({
  disabled,
  onSend,
}: {
  disabled: boolean;
  onSend: (text: string) => void;
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
        placeholder="무엇을 도와드릴까요? (Enter 전송, Shift+Enter 줄바꿈)"
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
      <button className="primary" type="submit" data-testid="chat-send" disabled={disabled}>
        보내기
      </button>
    </form>
  );
}
