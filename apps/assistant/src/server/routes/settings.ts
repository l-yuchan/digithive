import type { Database } from "bun:sqlite";
import { z } from "zod";
import { monthBucket, usage } from "../../runtime/budget";

export const DEFAULT_LIMIT_MICRO_USD = 100_000_000;

const Settings = z.object({
  revision: z.number().int().positive(),
  timezone: z.string(),
  monthlyLimitMicroUsd: z.number().int().positive(),
  proposeThresholds: z.object({
    noticeMicroUsd: z.number().int().nonnegative(),
    reduceMicroUsd: z.number().int().nonnegative(),
    pauseMicroUsd: z.number().int().nonnegative(),
  }),
  automationEnabled: z.boolean(),
  confirmedByUser: z.boolean(),
}).strict();

export type Settings = z.infer<typeof Settings>;

export const PROPOSED_THRESHOLDS = {
  noticeMicroUsd: 70_000_000,
  reduceMicroUsd: 90_000_000,
  pauseMicroUsd: 100_000_000,
} as const;

export class SettingsError extends Error {
  constructor(readonly kind: "stale_revision" | "unconfirmed" | "invalid") {
    super(kind);
    this.name = "SettingsError";
  }
}

export function readSettings(db: Database): Settings {
  const row = db.query("SELECT value_json, revision FROM settings WHERE key = 'monthly'").get();
  if (!row) {
    return {
      revision: 1,
      timezone: "Asia/Seoul",
      monthlyLimitMicroUsd: DEFAULT_LIMIT_MICRO_USD,
      proposeThresholds: PROPOSED_THRESHOLDS,
      automationEnabled: false,
      confirmedByUser: false,
    };
  }
  const parsed = z.object({ value_json: z.string(), revision: z.number() }).parse(row);
  return Settings.parse({ ...JSON.parse(parsed.value_json), revision: parsed.revision });
}

export function writeSettings(
  db: Database, input: unknown, actor: string, now = Date.now(),
): Settings {
  const next = Settings.safeParse(input);
  if (!next.success) throw new SettingsError("invalid");
  if (next.data.automationEnabled && !next.data.confirmedByUser) throw new SettingsError("unconfirmed");
  const current = readSettings(db);
  if (next.data.revision !== current.revision) throw new SettingsError("stale_revision");
  const revision = current.revision + 1;
  const stored = { ...next.data, revision };
  db.query(`INSERT INTO settings (key,value_json,revision,updated_by,updated_at) VALUES ('monthly',?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, revision = excluded.revision,
      updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .run(JSON.stringify(stored), revision, actor, new Date(now).toISOString());
  return Settings.parse(stored);
}

export function usageView(db: Database, now = Date.now()): {
  readonly settings: Settings;
  readonly usage: ReturnType<typeof usage>;
} {
  const settings = readSettings(db);
  return {
    settings,
    usage: usage(db, monthBucket(now, settings.timezone), settings.monthlyLimitMicroUsd),
  };
}
