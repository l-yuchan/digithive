import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative as relativePath, resolve } from "node:path";
import type { ToolRuntime } from "./registry";
import { z } from "zod";

export type WorkspaceRoots = {
  /** Everything a work run may read or write lives under this root. */
  readonly root: string;
};

function safePath(root: string, runId: string, relative: string): string {
  const base = resolve(root, runId);
  const target = resolve(base, relative);
  const contained = (parent: string, child: string) => {
    const path = relativePath(parent, child);
    return path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(path);
  };
  if (!contained(base, target)) throw new Error("path_outside_workspace");
  mkdirSync(root, { recursive: true });
  if (existsSync(base) && !contained(realpathSync(root), realpathSync(base))) throw new Error("path_outside_workspace");
  mkdirSync(base, { recursive: true });
  let ancestor = target;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  if (!contained(realpathSync(base), realpathSync(ancestor))) throw new Error("path_outside_workspace");
  return target;
}

/**
 * Work-surface tools. They are small on purpose: the layer under test is the
 * approval/lease/deadline machinery, not a rich tool catalogue.
 */
export function builtinTools(roots: WorkspaceRoots): ToolRuntime[] {
  return [
    {
      name: "workspace_write",
      description: "작업 공간 안에 텍스트 파일을 쓴다. path는 작업 공간 기준 상대 경로.",
      parameters: { type: "object", properties: { path: { type: "string" }, text: { type: "string" } }, required: ["path", "text"] },
      action: "edit",
      execute: async (args, context) => {
        const input = z.object({ path: z.string(), text: z.string() }).parse(args);
        const path = safePath(roots.root, context.runId, input.path);
        mkdirSync(resolve(path, ".."), { recursive: true });
        await Bun.write(path, input.text);
        return `작성 완료: ${input.path} (${input.text.length}자)`;
      },
    },
    {
      name: "workspace_read",
      description: "작업 공간 안의 텍스트 파일을 읽는다.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      action: "read",
      execute: async (args, context) => {
        const input = z.object({ path: z.string() }).parse(args);
        const path = safePath(roots.root, context.runId, input.path);
        const file = Bun.file(path);
        if (!(await file.exists())) return `파일이 없습니다: ${input.path}`;
        return (await file.text()).slice(0, 4_000);
      },
    },
    {
      name: "external_action",
      description: "외부로 나가는 행동(전송·게시 등)을 요청한다. 승인이 필요하다.",
      parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
      action: "external_action",
      execute: async (args) => `외부 행동 실행됨: ${z.object({ summary: z.string() }).parse(args).summary}`,
    },
  ];
}

/** Work runs may write inside their workspace and nothing else. */
export const WORK_POLICY = [
  { action: "*", resource: "*", effect: "deny" as const },
  { action: "read", resource: "*", effect: "allow" as const },
  { action: "edit", resource: "*", effect: "allow" as const },
  { action: "external_action", resource: "*", effect: "ask" as const },
  { action: "shell", resource: "*", effect: "deny" as const },
];
