import { z } from "zod";
import type { ToolRegistry } from "../tools/registry";
import { allowedTools } from "./capabilities";
import type { ScriptTicket, ScriptTicketIssuer, TicketRequest } from "./ticket";

type Ticket = TicketRequest & { readonly expiresAt: number };

export type SdkBridgeDeps = {
  readonly tools: ToolRegistry;
  readonly now?: () => number;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * A loopback-only window into the run's own tool surface.
 *
 * The token names exactly one run; the allow list comes from the capabilities
 * stored in that run's executor. The bridge never listens on a public interface,
 * expires with the run, and refuses an approval-seeking tool because no approver
 * exists while a script is running unattended.
 */
export class SdkBridge implements ScriptTicketIssuer {
  private readonly tickets = new Map<string, Ticket>();
  private readonly server: ReturnType<typeof Bun.serve>;
  private readonly now: () => number;

  constructor(private readonly deps: SdkBridgeDeps) {
    this.now = deps.now ?? Date.now;
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 30,
      fetch: (request) => this.handle(request),
    });
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  issue(request: TicketRequest): ScriptTicket {
    const token = crypto.randomUUID();
    this.tickets.set(token, { ...request, expiresAt: request.deadlineAt });
    return {
      token,
      url: this.url,
      env: {
        DIGITHIVE_SDK_URL: this.url,
        DIGITHIVE_SDK_TOKEN: token,
        DIGITHIVE_RUN_ID: request.runId,
        DIGITHIVE_WORKFLOW_ID: request.workflowId ?? "",
        DIGITHIVE_WORKFLOW_TITLE: request.workflowTitle ?? "",
        DIGITHIVE_PARAMS: JSON.stringify(request.params),
      },
    };
  }

  revoke(token: string): void {
    this.tickets.delete(token);
  }

  close(): void {
    this.tickets.clear();
    this.server.stop(true).catch(() => {
      // the listener is going away either way
    });
  }

  private ticketFor(request: Request): Ticket | null {
    const header = request.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (token.length === 0) return null;
    const ticket = this.tickets.get(token);
    if (!ticket) return null;
    if (ticket.expiresAt <= this.now()) {
      this.tickets.delete(token);
      return null;
    }
    return ticket;
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const ticket = this.ticketFor(request);
    if (!ticket) return json({ ok: false, error: "sdk_unauthenticated" }, 401);

    if (url.pathname === "/sdk/context" && request.method === "GET") {
      return json({
        ok: true,
        runId: ticket.runId,
        workflowId: ticket.workflowId,
        workflowTitle: ticket.workflowTitle,
        params: ticket.params,
        expiresAt: new Date(ticket.expiresAt).toISOString(),
      });
    }

    const allow = allowedTools(ticket.capabilities);
    if (url.pathname === "/sdk/tools" && request.method === "GET") {
      const tools = this.deps.tools.tools
        .filter((tool) => allow.has(tool.name))
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        }));
      return json({ ok: true, tools });
    }

    if (url.pathname === "/sdk/call" && request.method === "POST") {
      const body: unknown = await request.json().catch(() => null);
      if (body === null || typeof body !== "object") {
        return json({ ok: false, error: "sdk_invalid_body" }, 400);
      }
      const record = z
        .object({ name: z.unknown().optional(), args: z.unknown().optional() })
        .parse(body);
      const name = typeof record.name === "string" ? record.name : "";
      const args =
        record.args !== null && typeof record.args === "object"
          ? z.record(z.string(), z.unknown()).parse(record.args)
          : {};
      if (name.length === 0) return json({ ok: false, error: "sdk_tool_required" }, 400);
      if (!allow.has(name)) {
        return json(
          {
            ok: false,
            error: "script_capability_denied",
            detail: { tool: name, capabilities: ticket.capabilities },
          },
          403,
        );
      }
      const tool = this.deps.tools.get(name);
      if (!tool) return json({ ok: false, error: "unknown_tool", detail: { tool: name } }, 404);
      if (tool.action === "external_action") {
        return json(
          { ok: false, error: "script_approval_unavailable", detail: { tool: name } },
          403,
        );
      }
      const remaining = Math.max(1_000, Math.min(ticket.expiresAt - this.now(), 60_000));
      try {
        const result = await tool.execute(args, {
          runId: ticket.runId,
          signal: AbortSignal.timeout(remaining),
        });
        return json({ ok: true, result });
      } catch (error) {
        return json(
          {
            ok: false,
            error: "tool_failed",
            detail: error instanceof Error ? error.message : String(error),
          },
          500,
        );
      }
    }

    return json({ ok: false, error: "sdk_not_found" }, 404);
  }
}
