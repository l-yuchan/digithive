/**
 * Seeds a throwaway QA database for the browser pass: a provider-failure run and
 * a collection schedule pointed at the seeded Google account. Local only.
 */
import { Database } from "bun:sqlite";

const path = process.argv[2];
if (!path) throw new Error("usage: qa-seed.ts <db path>");
const db = new Database(path, { strict: true });
const now = new Date().toISOString();
const runId = "qa-run-provider-failure";
db.query(
  `INSERT OR REPLACE INTO runs (id, session_id, origin, goal, status, budget_json, result_json, executor_json, timeout_seconds, created_at, settled_at)
   VALUES (?, NULL, 'schedule', ?, 'failed', '{}', ?, '{"kind":"agent"}', 1800, ?, ?)`,
).run(
  runId,
  "아침 브리핑 (공급자 장애 재현)",
  JSON.stringify({
    error:
      "quota_exhausted (HTTP ?): 모든 모델 경로가 실패했습니다.\nprimary/qa-primary: quota_exhausted (HTTP 429): GoUsageLimitError primary usage limit reached (5-hour, resets in 31m)\nbackup/qa-backup: transport (HTTP ?): connect ECONNREFUSED",
    detail: '{"type":"GoUsageLimitError","message":"primary usage limit reached"}',
  }),
  now,
  now,
);
const kinds: [string, unknown][] = [
  ["run.started", { runId }],
  [
    "provider.fallback",
    {
      level: "warning",
      decision: "provider.fallback",
      provider: "backup",
      model: "qa-backup",
      failedProvider: "primary",
      reason: "quota_exhausted",
      retryInMs: 900000,
      error: "quota_exhausted (HTTP 429): GoUsageLimitError primary usage limit reached",
    },
  ],
  [
    "provider.exhausted",
    { level: "error", decision: "provider.exhausted", provider: "primary", model: "qa-primary" },
  ],
  [
    "run.failed",
    {
      error: "모든 모델 경로가 실패했습니다.",
      detail: '{"type":"GoUsageLimitError","message":"primary usage limit reached"}',
    },
  ],
];
for (const [kind, payload] of kinds) {
  db.query(
    "INSERT INTO events (run_id, session_id, kind, payload_json, created_at) VALUES (?,NULL,?,?,?)",
  ).run(runId, kind, JSON.stringify(payload), now);
}
db.query(
  `INSERT OR REPLACE INTO schedules (id,title,instruction,enabled,trigger_json,executor_json,timeout_seconds,next_run_at,created_at,updated_at)
   VALUES ('qa-collect',?,'구글 계정에서 새 메일과 일정을 모읍니다.',1,?,?,600,NULL,?,?)`,
).run(
  "매일 아침 메일·일정 모으기",
  JSON.stringify({ kind: "daily", at: "07:00" }),
  JSON.stringify({
    kind: "builtin",
    name: "sync_sources",
    accountId: "google-default",
    sources: ["gmail", "calendar"],
  }),
  now,
  now,
);
console.log(JSON.stringify({ seeded: ["runs", "events", "schedules"], runId }));
db.close();
