import type { Retrieved } from "./retrieval";

export type Citation = {
  readonly sourceId: string;
  readonly kind: string;
  readonly revision: number;
  readonly quote: string;
};

/**
 * A citation is built only from a record this process actually retrieved, so a
 * model can point at a source id it was given and nothing else.
 */
export function toCitations(retrieved: readonly Retrieved[]): readonly Citation[] {
  return retrieved.map((item) => ({
    sourceId: item.id,
    kind: item.kind,
    revision: item.revision,
    quote: item.statement,
  }));
}

export function rejectUnknownCitations(citations: readonly Citation[], retrieved: readonly Retrieved[]): readonly Citation[] {
  const allowed = new Set(retrieved.map((item) => item.id));
  return citations.filter((citation) => allowed.has(citation.sourceId));
}

export function contextBlock(retrieved: readonly Retrieved[]): string {
  return retrieved
    .map((item) => `[memory:${item.id} rev${item.revision}]\n${item.statement}`)
    .join("\n\n");
}
