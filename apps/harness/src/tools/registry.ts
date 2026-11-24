import type { ToolSpec } from "../providers/openai";

export type ToolRuntime = ToolSpec & {
  /** Policy action used for the approval decision, e.g. "shell" or "read". */
  readonly action: string;
  readonly execute: (
    args: Record<string, unknown>,
    context: { readonly runId: string; readonly signal?: AbortSignal },
  ) => Promise<string>;
};

export type ToolRegistry = {
  readonly tools: readonly ToolRuntime[];
  get(name: string): ToolRuntime | undefined;
};

export function createRegistry(tools: readonly ToolRuntime[]): ToolRegistry {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return {
    tools,
    get: (name) => byName.get(name),
  };
}

export function specs(registry: ToolRegistry): ToolSpec[] {
  return registry.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}
