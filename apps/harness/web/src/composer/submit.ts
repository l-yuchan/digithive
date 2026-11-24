export type SubmitKey = {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly isComposing?: boolean;
  readonly keyCode?: number;
  readonly nativeEvent?: { readonly isComposing?: boolean };
};

/**
 * Enter submits, Shift+Enter inserts a newline, and an unfinished Korean
 * composition never submits: the IME reports `isComposing` (or keyCode 229)
 * while the syllable is still being assembled.
 */
export function shouldSubmit(event: SubmitKey): boolean {
  if (event.key !== "Enter") return false;
  if (event.shiftKey) return false;
  if (event.isComposing === true) return false;
  if (event.keyCode === 229) return false;
  if (event.nativeEvent?.isComposing === true) return false;
  return true;
}
