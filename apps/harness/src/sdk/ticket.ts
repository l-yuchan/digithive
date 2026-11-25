import type { CapabilityGroup } from "../core/executor";

/** What a script run is handed: one token, one run, one expiry, one allow list. */
export type ScriptTicket = {
  readonly token: string;
  readonly url: string;
  readonly env: Readonly<Record<string, string>>;
};

export type TicketRequest = {
  readonly runId: string;
  readonly workflowId: string | null;
  readonly workflowTitle: string | null;
  readonly params: Readonly<Record<string, unknown>>;
  readonly capabilities: readonly CapabilityGroup[];
  readonly deadlineAt: number;
};

/** The work layer only needs this much; the bridge owns the implementation. */
export type ScriptTicketIssuer = {
  issue(request: TicketRequest): ScriptTicket;
  revoke(token: string): void;
};
