import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { openDatabase } from "../../src/server/db";
import { Store } from "../../src/server/store";
import { createApi } from "../../src/server/api";

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const entryResult = z.object({ entry: z.object({ id: z.string(), kind: z.string(), text: z.string(), original_text: z.string(), status: z.string(), version: z.number() }) });
const suggestion = z.object({ id: z.string(), status: z.string(), strength: z.string() });
const proposals = z.object({ suggestions: z.array(suggestion) });
function fixture() {
  const db = openDatabase(":memory:");
  databases.push(db);
  const store = new Store(db);
  let clock = new Date("2026-11-01T10:00:00Z");
  const api = createApi({ store, now: () => clock, backupDir: "backups/test" });
  return {
    store,
    time: (value: string) => { clock = new Date(value); },
    call: async (path: string, method = "GET", body?: unknown) => {
      const response = await api.handle(new Request(`http://localhost/api${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) }));
      const result: unknown = await response.json();
      expect(response.status).toBeLessThan(400);
      return result;
    },
  };
}
async function seed(f: ReturnType<typeof fixture>) {
  const { entry } = entryResult.parse(await f.call("/entries", "POST", { kind: "interest", text: "memory contamination experiment someday", scope: "research", context: { kind: "interest", known_obstacle: "cheap measurement", why_it_matters: "memory reliability", interruption: "when_strong" } }));
  const { source } = z.object({ source: z.object({ id: z.string() }) }).parse(await f.call("/sources", "POST", { title: "Evaluation paper", evidence_summary: "cheap measurement of memory contamination" }));
  return { entry, source };
}
test("ambiguous interest is not an action, and correction preserves original wording", async () => {
  const f = fixture();
  const { entry } = await seed(f);
  const result = entryResult.parse(await f.call(`/entries/${entry.id}`, "PATCH", { text: "memory reliability question", context: { known_obstacle: "limited time" } }));
  expect(result.entry).toMatchObject({ kind: "interest", text: "memory reliability question", original_text: entry.text, version: 2 });
  expect(f.store.count("entries")).toBe(1);
});
test("grounded retrieval does not turn an interest into a recorded fact", async () => {
  const f = fixture();
  const { entry, source } = await seed(f);
  const result = z.object({ epistemic_status: z.string(), citations: z.array(z.object({ entity_id: z.string(), quote: z.string() })) }).parse(await f.call("/retrieval/query", "POST", { question: "memory contamination" }));
  expect(result.epistemic_status).toBe("insufficient_record");
  expect(result.citations).toEqual(expect.arrayContaining([
    { entity_id: entry.id, quote: entry.text },
    { entity_id: source.id, quote: "cheap measurement of memory contamination" },
  ]));
  expect(result.citations).toHaveLength(2);
});
test.each([false, true])("strong opportunity honors quiet mode %s even after digest access", async quiet => {
  const f = fixture();
  const { entry, source } = await seed(f);
  await f.call("/settings", "PATCH", { quiet_mode: quiet });
  const dev = proposals.parse(await f.call("/developments", "POST", { source_id: source.id, occurred_at: "2026-11-01T10:00:00Z", summary: "cheap measurement of memory contamination experiment", addresses_obstacle_entry_ids: [entry.id] }));
  expect(dev.suggestions.map(s => s.status)).toEqual([quiet ? "held" : "surfaced"]);
  await f.call("/digest");
  const result = proposals.parse(await f.call("/suggestions"));
  expect(result.suggestions.map(s => s.status)).toEqual([quiet ? "held" : "surfaced"]);
});
test("dismissal survives later reads and withdrawal expires another pending proposal", async () => {
  const f = fixture();
  const { entry, source } = await seed(f);
  const make = async () => proposals.parse(await f.call("/developments", "POST", { source_id: source.id, occurred_at: "2026-11-01T10:00:00Z", summary: "cheap measurement memory contamination experiment", addresses_obstacle_entry_ids: [entry.id] }));
  const first = (await make()).suggestions[0];
  if (!first) throw new Error("seed did not create a suggestion");
  await f.call(`/suggestions/${first.id}/respond`, "POST", { action: "dismiss" });
  await make();
  await f.call(`/entries/${entry.id}/withdraw`, "POST", {});
  expect(proposals.parse(await f.call("/suggestions")).suggestions.map(s => s.status).sort()).toEqual(["dismissed", "expired"]);
});
test("JSON export includes ledger and diary without SQL ordering failures", async () => {
  const f = fixture();
  await seed(f);
  await f.call("/evaluation/daily/2026-11-01", "PUT", { condition: "baseline" });
  const result = z.object({ entries: z.array(z.unknown()), history: z.array(z.unknown()), evaluations: z.array(z.unknown()) }).parse(await f.call("/backup/export"));
  expect(result.entries).toHaveLength(1);
  expect(result.evaluations).toHaveLength(1);
  expect(result.history.length).toBe(3);
});
test("missing effort never produces an invented net benefit", async () => {
  const f = fixture();
  await f.call("/evaluation/daily/2026-11-01", "PUT", { condition: "baseline" });
  const result = z.object({ net_time_saved_minutes: z.number().nullable(), missing_data: z.array(z.string()) }).parse(await f.call("/evaluation/summary?from=2026-11-01&to=2026-11-30"));
  expect(result.net_time_saved_minutes).toBeNull();
  expect(result.missing_data).toContain("net_time_saved_minutes: no complete secretary days");
});
test("paused interests do not release deferred proposals", async () => {
  const f = fixture();
  const { entry, source } = await seed(f);
  const result = proposals.parse(await f.call("/developments", "POST", { source_id: source.id, occurred_at: "2026-11-01T10:00:00Z", summary: "cheap measurement memory contamination experiment" }));
  const proposal = result.suggestions[0];
  if (!proposal) throw new Error("missing proposal");
  await f.call(`/suggestions/${proposal.id}/respond`, "POST", { action: "defer", defer_until: "2026-11-02T10:00:00Z" });
  await f.call(`/entries/${entry.id}/pause`, "POST");
  f.time("2026-11-03T10:00:00Z");
  expect(proposals.parse(await f.call("/suggestions")).suggestions[0]?.status).toBe("deferred");
});
test("correcting the obstacle invalidates proposals based on the old obstacle", async () => {
  const f = fixture();
  const { entry, source } = await seed(f);
  await f.call("/developments", "POST", { source_id: source.id, occurred_at: "2026-11-01T10:00:00Z", summary: "cheap measurement memory contamination experiment" });
  await f.call(`/entries/${entry.id}`, "PATCH", { context: { known_obstacle: "not interested in measurement anymore" } });
  expect(proposals.parse(await f.call("/suggestions")).suggestions.map(s => s.status)).toEqual(["expired"]);
});
test("a research-only interruption preference does not change another scope", async () => {
  const f = fixture();
  const { source } = await seed(f);
  await f.call("/entries", "POST", { kind: "interest", text: "memory contamination experiment", scope: "writing", context: { kind: "interest", known_obstacle: "cheap measurement" } });
  await f.call("/preferences", "POST", { key: "interruption", scope: "research", value: "never" });
  const result = proposals.parse(await f.call("/developments", "POST", { source_id: source.id, occurred_at: "2026-11-01T10:00:00Z", summary: "cheap measurement memory contamination experiment" }));
  expect(result.suggestions.map(s => s.status).sort()).toEqual(["held", "surfaced"]);
});
test("explicit preparation can be stopped before any local work runs", async () => {
  const f = fixture();
  const schema = z.object({ preparation: z.object({ id: z.string(), status: z.string() }) });
  const created = schema.parse(await f.call("/preparations", "POST", { request: "memory", scope: "research", local_only: true, max_steps: 2 }));
  expect(created.preparation.status).toBe("pending");
  expect(schema.parse(await f.call(`/preparations/${created.preparation.id}/stop`, "POST")).preparation.status).toBe("stopped");
});
test("source deletion removes its linked suggestions and evidence from export", async () => {
  const f = fixture();
  const { source } = await seed(f);
  await f.call("/developments", "POST", { source_id: source.id, occurred_at: "2026-11-01T10:00:00Z", summary: "cheap measurement memory contamination experiment" });
  await f.call(`/sources/${source.id}`, "DELETE");
  const exported = z.object({ sources: z.array(z.unknown()), developments: z.array(z.unknown()), suggestions: z.array(z.unknown()) }).parse(await f.call("/backup/export"));
  expect(exported).toEqual({ sources: [], developments: [], suggestions: [] });
});
test("accepting a suggestion alone creates no commitment", async () => {
  const f = fixture();
  const { source } = await seed(f);
  const result = proposals.parse(await f.call("/developments", "POST", { source_id: source.id, occurred_at: "2026-11-01T10:00:00Z", summary: "cheap measurement memory contamination experiment" }));
  const s = result.suggestions[0];
  if (!s) throw new Error("missing proposal");
  await f.call(`/suggestions/${s.id}/respond`, "POST", { action: "accept" });
  const records = z.object({ entries: z.array(z.object({ kind: z.string() })) }).parse(await f.call("/entries"));
  expect(records.entries).toEqual([{ kind: "interest" }]);
});
test("cancelled commitment remains cancelled and forbids rescheduling", async () => {
  const f = fixture();
  const { entry } = entryResult.parse(await f.call("/entries", "POST", { kind: "commitment", text: "local research appointment", context: { kind: "commitment" } }));
  await f.call(`/entries/${entry.id}/cancel-schedule`, "POST", { reason: "do not reschedule" });
  const result = z.object({ entry: z.object({ status: z.string(), context: z.object({ reschedule_allowed: z.boolean() }) }) }).parse(await f.call(`/entries/${entry.id}`));
  expect(result.entry).toEqual({ status: "cancelled", context: { reschedule_allowed: false } });
  expect(f.store.count("entries")).toBe(1);
});
