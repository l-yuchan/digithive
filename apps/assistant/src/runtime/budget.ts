import type { Database } from "bun:sqlite";
import { z } from "zod";

const Reservation = z.object({
  id: z.string(),
  month_bucket: z.string(),
  price_version: z.string(),
  reserved_micro_usd: z.number(),
  settled_micro_usd: z.number().nullable(),
  status: z.enum(["active", "settled", "unknown"]),
});
export type Reservation = z.infer<typeof Reservation>;

const Totals = z.object({
  settled: z.number(),
  reserved: z.number(),
  unknown: z.number(),
});

export class BudgetError extends Error {
  constructor(readonly kind: "limit_exceeded" | "price_unknown" | "missing") {
    super(kind);
    this.name = "BudgetError";
  }
}

export type MonthUsage = {
  readonly monthBucket: string;
  readonly settledMicroUsd: number;
  readonly reservedMicroUsd: number;
  readonly unknownMicroUsd: number;
  readonly committedMicroUsd: number;
  readonly limitMicroUsd: number;
};

export function monthBucket(instant: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(instant));
  const pick = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}`;
}

function totals(db: Database, bucket: string): z.infer<typeof Totals> {
  const row = db.query(`SELECT
      coalesce(sum(CASE WHEN status = 'settled' THEN coalesce(settled_micro_usd, 0) ELSE 0 END), 0) AS settled,
      coalesce(sum(CASE WHEN status = 'active' THEN reserved_micro_usd ELSE 0 END), 0) AS reserved,
      coalesce(sum(CASE WHEN status = 'unknown' THEN reserved_micro_usd ELSE 0 END), 0) AS unknown
    FROM cost_reservations WHERE month_bucket = ?`).get(bucket);
  return Totals.parse(row);
}

export function usage(db: Database, bucket: string, limitMicroUsd: number): MonthUsage {
  const sum = totals(db, bucket);
  return {
    monthBucket: bucket,
    settledMicroUsd: sum.settled,
    reservedMicroUsd: sum.reserved,
    unknownMicroUsd: sum.unknown,
    committedMicroUsd: sum.settled + sum.reserved + sum.unknown,
    limitMicroUsd,
  };
}

export function reserve(
  db: Database,
  input: {
    readonly runId: string;
    readonly providerRequestId: string;
    readonly bucket: string;
    readonly priceVersion: string | null;
    readonly estimateMicroUsd: number;
    readonly limitMicroUsd: number;
  },
  now = Date.now(),
): Reservation {
  const existing = db.query(`SELECT id,month_bucket,price_version,reserved_micro_usd,settled_micro_usd,status
    FROM cost_reservations WHERE provider_request_id = ?`).get(input.providerRequestId);
  if (existing) return Reservation.parse(existing);
  if (input.priceVersion === null) throw new BudgetError("price_unknown");
  return db.transaction(() => {
    const current = totals(db, input.bucket);
    if (current.settled + current.reserved + current.unknown + input.estimateMicroUsd > input.limitMicroUsd) {
      throw new BudgetError("limit_exceeded");
    }
    const id = crypto.randomUUID();
    db.query(`INSERT INTO cost_reservations
      (id,run_id,provider_request_id,month_bucket,price_version,reserved_micro_usd,status,created_at)
      VALUES (?,?,?,?,?,?,'active',?)`)
      .run(id, input.runId, input.providerRequestId, input.bucket, input.priceVersion, input.estimateMicroUsd,
        new Date(now).toISOString());
    return Reservation.parse(db.query(`SELECT id,month_bucket,price_version,reserved_micro_usd,settled_micro_usd,status
      FROM cost_reservations WHERE id = ?`).get(id));
  }).immediate();
}

export function settle(
  db: Database, reservationId: string, billedMicroUsd: number | null, now = Date.now(),
): Reservation {
  db.transaction(() => {
    const current = db.query("SELECT status FROM cost_reservations WHERE id = ?").get(reservationId);
    if (!current) throw new BudgetError("missing");
    const row = z.object({ status: z.string() }).parse(current);
    if (row.status !== "active") throw new BudgetError("missing");
    if (billedMicroUsd === null) {
      db.query("UPDATE cost_reservations SET status = 'unknown' WHERE id = ?").run(reservationId);
    } else {
      db.query("UPDATE cost_reservations SET status = 'settled', settled_micro_usd = ? WHERE id = ?")
        .run(billedMicroUsd, reservationId);
    }
    db.query("INSERT INTO usage_ledger (id,reservation_id,billed_micro_usd,observed_at) VALUES (?,?,?,?)")
      .run(crypto.randomUUID(), reservationId, billedMicroUsd, new Date(now).toISOString());
  }).immediate();
  return Reservation.parse(db.query(`SELECT id,month_bucket,price_version,reserved_micro_usd,settled_micro_usd,status
    FROM cost_reservations WHERE id = ?`).get(reservationId));
}
