import { z } from "zod";

export type ToolContext = {
  readonly runId: string;
  readonly scopes: readonly string[];
};

export type ToolDefinition = {
  readonly name: string;
  readonly description: string;
  readonly parameters: z.ZodType<Record<string, unknown>>;
  readonly scope: string;
  readonly execute: (args: Record<string, unknown>, context: ToolContext) => Promise<string>;
};

export class ToolDenied extends Error {
  constructor(readonly kind: "unknown_tool" | "invalid_arguments" | "missing_scope") {
    super(kind);
    this.name = "ToolDenied";
  }
}

export type ToolRegistry = {
  readonly definitions: readonly ToolDefinition[];
  run(name: string, rawArguments: string, context: ToolContext): Promise<string>;
  freeform(): readonly { name: string; description: string; parameters: unknown }[];
};

function jsonSchema(schema: z.ZodType<unknown>): unknown {
  return z.toJSONSchema(schema, { io: "input" });
}

export function createRegistry(tools: readonly ToolDefinition[]): ToolRegistry {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return {
    definitions: tools,
    freeform: () => tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: jsonSchema(tool.parameters),
    })),
    async run(name, rawArguments, context) {
      const tool = byName.get(name);
      if (!tool) throw new ToolDenied("unknown_tool");
      if (!context.scopes.includes(tool.scope)) throw new ToolDenied("missing_scope");
      let raw: unknown;
      try {
        raw = JSON.parse(rawArguments);
      } catch (error) {
        if (error instanceof SyntaxError) throw new ToolDenied("invalid_arguments");
        throw error;
      }
      const parsed = tool.parameters.safeParse(raw);
      if (!parsed.success) throw new ToolDenied("invalid_arguments");
      return tool.execute(parsed.data, context);
    },
  };
}
