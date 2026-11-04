// Deterministic tokenization shared by triage (R4) and grounded retrieval (R7).
// Word segmentation uses Intl.Segmenter (Unicode-aware, incl. CJK); ASCII tokens
// get light suffix folding so "measure"/"measuring"/"measurement" overlap;
// Hangul tokens additionally contribute character bigrams so agglutinative
// Korean words ("오염을" vs "오염") can partially match. Pure digits are dropped.
// This is an honest keyword heuristic, not semantic understanding.

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "else", "when", "while",
  "because", "until", "although", "though", "so", "too", "very", "just", "also",
  "both", "each", "few", "more", "most", "other", "some", "such", "no", "not",
  "nor", "only", "own", "same", "than", "that", "these", "those", "there",
  "here", "all", "any", "can", "cannot", "could", "should", "would", "will",
  "shall", "may", "might", "must", "do", "does", "did", "done", "doing",
  "have", "has", "had", "having", "be", "been", "being", "am", "is", "are",
  "was", "were", "i", "me", "my", "mine", "we", "us", "our", "ours", "you",
  "your", "yours", "he", "she", "it", "its", "they", "them", "their", "this",
  "what", "which", "who", "whom", "whose", "why", "how", "at", "by", "for",
  "in", "into", "of", "off", "on", "onto", "out", "over", "under", "up",
  "down", "to", "from", "with", "without", "about", "against", "between",
  "through", "during", "before", "after", "above", "below", "again", "further",
  "once", "its", "now", "s", "t", "re", "ve", "ll", "d", "m", "o", "y",
]);

const segmenter = new Intl.Segmenter("en", { granularity: "word" });

function isHangul(token: string): boolean {
  return /^[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]+$/.test(token);
}

/** Light, deterministic ASCII suffix folding (not a real stemmer). */
export function fold(token: string): string {
  if (!/^[a-z]+$/.test(token)) return token;
  let t = token;
  if (t.length > 4 && t.endsWith("ies")) t = t.slice(0, -3) + "y";
  else if (t.length > 4 && t.endsWith("sses")) t = t.slice(0, -2);
  else if (t.length > 4 && t.endsWith("es") && !t.endsWith("sses")) t = t.slice(0, -2);
  else if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") && !t.endsWith("us") && !t.endsWith("is"))
    t = t.slice(0, -1);
  if (t.length > 5 && t.endsWith("ing")) t = t.slice(0, -3);
  else if (t.length > 4 && t.endsWith("ed")) t = t.slice(0, -2);
  else if (t.length > 4 && t.endsWith("ly")) t = t.slice(0, -2);
  else if (t.length > 4 && t.endsWith("e")) t = t.slice(0, -1);
  if (t.length > 3 && t.length % 2 === 0 && t.at(-1) === t.at(-2)) t = t.slice(0, -1);
  return t;
}

function bigrams(word: string): string[] {
  const chars = [...word];
  if (chars.length < 2) return chars.length === 1 ? [chars[0]!] : [];
  const out: string[] = [];
  for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i]! + chars[i + 1]!);
  return out;
}

export interface TokenSet {
  /** folded (stem-ish) tokens */
  primary: Set<string>;
  /** Hangul character bigrams for partial Korean overlap */
  grams: Set<string>;
  /** folded token -> first surface form (for honest matched-term display) */
  surface: Map<string, string>;
}

export function tokenize(text: string | null | undefined): TokenSet {
  const out: TokenSet = { primary: new Set(), grams: new Set(), surface: new Map() };
  if (!text) return out;
  for (const seg of segmenter.segment(text.toLowerCase())) {
    if (!seg.isWordLike) continue;
    const raw = seg.segment.trim().replace(/['’]/g, "");
    if (!raw) continue;
    const folded = fold(raw);
    if (!folded || /^\d+$/.test(folded)) continue;
    if (STOPWORDS.has(raw) || STOPWORDS.has(folded)) continue;
    if (!out.primary.has(folded)) out.surface.set(folded, raw);
    out.primary.add(folded);
    if (isHangul(raw)) for (const g of bigrams(raw)) out.grams.add(g);
  }
  return out;
}

/** Target tokens that the `against` set also contains (directly or via bigrams). */
export function matchedTokens(target: TokenSet, against: TokenSet): string[] {
  const matched: string[] = [];
  for (const token of target.primary) {
    if (against.primary.has(token)) {
      matched.push(token);
      continue;
    }
    const raw = target.surface.get(token) ?? token;
    if (isHangul(raw) && bigrams(raw).some((g) => against.grams.has(g))) matched.push(token);
  }
  return matched;
}

/** Share of `target`'s tokens found in `against` (0 when target is empty). */
export function coverage(target: TokenSet, against: TokenSet): { ratio: number; matched: string[] } {
  if (target.primary.size === 0) return { ratio: 0, matched: [] };
  const matched = matchedTokens(target, against);
  return { ratio: matched.length / target.primary.size, matched };
}
