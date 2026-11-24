export type Citation = { readonly sourceId: string; readonly quote: string };

/**
 * A citation is only accepted for a source the model was actually given; an
 * invented id or an empty quote is dropped rather than shown as evidence.
 */
export function validCitations(citations: readonly Citation[], usedSourceIds: readonly string[]): Citation[] {
  const allowed = new Set(usedSourceIds);
  return citations.filter((citation) => allowed.has(citation.sourceId) && citation.quote.trim().length > 0);
}
