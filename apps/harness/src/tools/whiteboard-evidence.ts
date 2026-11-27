import { z } from "zod";

export class BriefingCitationError extends Error {
  readonly name = "BriefingCitationError";

  constructor(readonly sourceIds: readonly string[]) {
    super(`sources_not_retrieved:${sourceIds.join(",")}`);
  }
}

export type WhiteboardEvidence = {
  readonly record: (runId: string, sourceIds: readonly string[]) => void;
  readonly assertRetrieved: (runId: string, sourceIds: readonly string[]) => void;
};

/** Retrieval membership is scoped to one agent run; knowing an id is not evidence. */
export function createWhiteboardEvidence(): WhiteboardEvidence {
  // Mutation is the receipt ledger's purpose; entries are never shared between runs.
  const seen = new Map<string, Set<string>>();
  return {
    record(runId, sourceIds) {
      const current = seen.get(runId) ?? new Set<string>();
      for (const id of sourceIds) current.add(id);
      seen.set(runId, current);
    },
    assertRetrieved(runId, sourceIds) {
      z.array(z.string().min(1)).parse(sourceIds);
      const current = seen.get(runId);
      const missing = sourceIds.filter((id) => !current?.has(id));
      if (sourceIds.length === 0 || missing.length > 0) {
        throw new BriefingCitationError(missing);
      }
    },
  };
}
