import type { Database } from "bun:sqlite";
import type { PushSubscription } from "web-push";

export type PushConfig = {
  readonly publicKey: string;
  readonly privateKey: string;
  readonly subject: string;
};

export type PushPayload = { readonly title: string; readonly body: string };

export type PushSubscriptionRow = { readonly id: string; readonly endpoint: string; readonly payload: string };

export type Deliver = (subscription: PushSubscriptionRow, job: PushConfig, payload: PushPayload) => Promise<void>;

export type PushOutcome = { readonly sent: number; readonly failed: number; readonly errors: string[] };

export function addSubscription(db: Database, subscription: unknown, now = Date.now()): { id: string; duplicate: boolean } {
  const parsed = subscription as { endpoint?: unknown };
  const endpoint = typeof parsed?.endpoint === "string" ? parsed.endpoint : "";
  if (endpoint.length === 0) throw new Error("missing_endpoint");
  const existing = db.query("SELECT id FROM push_subscriptions WHERE endpoint = ?").get(endpoint) as { id: string } | null;
  if (existing) return { id: existing.id, duplicate: true };
  const id = crypto.randomUUID();
  db.query("INSERT INTO push_subscriptions (id, endpoint, payload, created_at) VALUES (?,?,?,?)").run(
    id,
    endpoint,
    JSON.stringify(subscription),
    new Date(now).toISOString(),
  );
  return { id, duplicate: false };
}

export function subscriptions(db: Database): PushSubscriptionRow[] {
  return db.query("SELECT id, endpoint, payload FROM push_subscriptions").all() as PushSubscriptionRow[];
}

export function pushConfigured(config: PushConfig): boolean {
  return config.publicKey.length > 0 && config.privateKey.length > 0;
}

type WebPushModule = {
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  sendNotification(subscription: PushSubscription, payload: string): Promise<unknown>;
};

/** web-push is CommonJS; load it lazily so tests and the API never pay for it. */
async function loadWebPush(): Promise<WebPushModule> {
  const loaded = (await import("web-push")) as unknown as { default?: WebPushModule } & WebPushModule;
  return loaded.default ?? loaded;
}

const defaultDeliver: Deliver = async (row, config, payload) => {
  const webpush = await loadWebPush();
  webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  await webpush.sendNotification(JSON.parse(row.payload) as PushSubscription, JSON.stringify(payload));
};

/**
 * Sends to every stored subscription and records the per-device result, so a
 * dead subscription is visible instead of silently counted as delivered.
 */
export async function sendPush(
  db: Database,
  config: PushConfig,
  payload: PushPayload,
  deliver: Deliver = defaultDeliver,
  now = Date.now(),
): Promise<PushOutcome> {
  if (!pushConfigured(config)) return { sent: 0, failed: 0, errors: ["push_unconfigured"] };
  const rows = subscriptions(db);
  if (rows.length === 0) return { sent: 0, failed: 0, errors: ["no_device"] };
  let sent = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const row of rows) {
    try {
      await deliver(row, config, payload);
      sent += 1;
      db.query("UPDATE push_subscriptions SET last_success_at = ?, last_error = NULL WHERE id = ?").run(new Date(now).toISOString(), row.id);
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : "push_failed";
      errors.push(`${row.endpoint.slice(0, 40)}:${message}`.slice(0, 200));
      db.query("UPDATE push_subscriptions SET last_error = ?, last_error_at = ? WHERE id = ?").run(message.slice(0, 300), new Date(now).toISOString(), row.id);
      if (/410|404/.test(message)) db.query("DELETE FROM push_subscriptions WHERE id = ?").run(row.id);
    }
  }
  return { sent, failed, errors };
}
