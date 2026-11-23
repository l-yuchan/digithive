import { z } from "zod";

export const ScriptManifest = z.object({
  id: z.string().min(1).max(120),
  kind: z.enum(["collector", "generated"]),
  artifactDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  timeoutMs: z.number().int().min(100).max(600_000),
  maxOutputBytes: z.number().int().min(1_024).max(4_194_304),
  memoryMb: z.number().int().min(64).max(2_048),
  cpus: z.number().min(0.1).max(4),
  pidsLimit: z.number().int().min(8).max(512),
}).strict();
export type ScriptManifest = z.infer<typeof ScriptManifest>;

export const SandboxRequest = z.object({
  image: z.string().min(1),
  entrypoint: z.string().regex(/^[a-z0-9_./-]{1,120}$/),
  argv: z.array(z.string().max(4_096)).max(32),
  timeoutMs: z.number().int().min(100).max(600_000),
  maxOutputBytes: z.number().int().min(1_024).max(4_194_304),
  memoryMb: z.number().int().min(64).max(2_048),
  cpus: z.number().min(0.1).max(4),
  pidsLimit: z.number().int().min(8).max(512),
  inputName: z.string().regex(/^[a-z0-9-]{1,64}$/).optional(),
}).strict();
export type SandboxRequest = z.infer<typeof SandboxRequest>;

export const SandboxResult = z.object({
  exitCode: z.number().int(),
  timedOut: z.boolean(),
  stdout: z.string(),
  truncated: z.boolean(),
  outputs: z.array(z.object({
    path: z.string(),
    sha256: z.string(),
    bytes: z.number().int(),
  })),
}).strict();
export type SandboxResult = z.infer<typeof SandboxResult>;

export const TOOL_SCOPES = ["script.run", "file.read", "file.write", "source.read"] as const;
export type ToolScope = (typeof TOOL_SCOPES)[number];
