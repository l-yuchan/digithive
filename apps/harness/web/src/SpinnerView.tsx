import { useEffect, useState } from "react";
import { elapsedLabel, spinnerText } from "./spinner";

/**
 * What is on screen while something is happening but has not produced text yet.
 *
 * The rotating character is decorative (`aria-hidden`); the words carry the meaning
 * and change on their own schedule, so a screen reader is not read a new frame twice
 * a second. `prefers-reduced-motion` keeps the character still.
 */
export function Spinner({
  label,
  startedAt,
}: {
  readonly label: string;
  readonly startedAt: number;
}) {
  const [now, setNow] = useState(() => Date.now());
  const reduced = usePrefersReducedMotion();
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), reduced ? 1_000 : 120);
    return () => clearInterval(timer);
  }, [reduced]);
  return (
    <span className="spinner" role="status" data-testid="spinner" data-elapsed={now - startedAt}>
      <span className="spinner-frame" aria-hidden="true">
        {spinnerText(now - startedAt, reduced)}
      </span>{" "}
      <span className="spinner-label">
        {label} · {elapsedLabel(startedAt, now)}
      </span>
    </span>
  );
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return undefined;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}
