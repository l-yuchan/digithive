export type Decision = "allow" | "ask" | "deny";

export type PolicyRule = {
  readonly action: string;
  readonly resource: string;
  readonly effect: Decision;
};

export type PolicyRequest = {
  readonly action: string;
  readonly resource: string;
};

/** Whole-value `*`/`?` wildcards, matching OpenCode's documented semantics. */
export function matches(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(value);
}

/**
 * Ordered rules, last match wins; no match asks. `deny` is evaluated first
 * against every matching rule so a saved approval can never widen a deny.
 */
export function decide(rules: readonly PolicyRule[], request: PolicyRequest): Decision {
  let decision: Decision | null = null;
  for (const rule of rules) {
    if (rule.action !== request.action && rule.action !== "*") continue;
    if (!matches(rule.resource, request.resource)) continue;
    decision = rule.effect;
  }
  return decision ?? "ask";
}

export function decideWithSaved(
  rules: readonly PolicyRule[],
  saved: readonly PolicyRule[],
  request: PolicyRequest,
): { decision: Decision; by: "policy" | "saved" } {
  const configured = decide(rules, request);
  if (configured === "deny") return { decision: "deny", by: "policy" };
  const remembered = decide(saved, request);
  if (remembered === "allow") return { decision: "allow", by: "saved" };
  return { decision: configured, by: "policy" };
}

/** The shipped default: everything allowed, except reading env files. */
export const BASE_POLICY: readonly PolicyRule[] = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "allow" },
];
