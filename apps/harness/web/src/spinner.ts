/**
 * The braille spinner shown while an answer is still arriving.
 *
 * It exists to say "working, and here is how long" without ever claiming progress the
 * app cannot see: the frames are decorative for assistive technology (`aria-hidden`)
 * and the words next to them change once, not per frame.
 */

export const BRAILLE_FRAMES: readonly string[] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const FRAME_MS = 80;

export function spinnerFrame(elapsedMs: number): string {
  const index = Math.floor(Math.max(0, elapsedMs) / FRAME_MS) % BRAILLE_FRAMES.length;
  return BRAILLE_FRAMES[index] ?? BRAILLE_FRAMES[0] ?? "⠋";
}

/** Reduced motion keeps one still character: the same information, no movement. */
export function spinnerText(elapsedMs: number, reducedMotion: boolean): string {
  return reducedMotion ? "⠿" : spinnerFrame(elapsedMs);
}

/** "0초", "3초", "1분 05초" — whole seconds, never negative. */
export function elapsedLabel(startedAtMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1_000));
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}분 ${String(rest).padStart(2, "0")}초`;
}
