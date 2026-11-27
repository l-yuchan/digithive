import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { open, seal } from "../core/vault";
import type { ModelOffer, ProviderUsage } from "../providers/catalog";
import { hasProviderTables } from "../store/providers-v17";

/**
 * A provider the owner added, as the settings screen may see it. The key is never part
 * of this shape: only whether one is stored and the last four characters, so the screen
 * can tell two keys apart without ever receiving one back.
 */
export type ProviderView = {
  readonly id: string;
  readonly catalogId: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly enabled: boolean;
  readonly keyHint: string | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly modelsFetchedAt: string | null;
  readonly modelsError: string | null;
  readonly usage: ProviderUsage | null;
  readonly usageFetchedAt: string | null;
  readonly usageError: string | null;
};

export type StoredModel = ModelOffer;

export const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/** Custom headers a provider requires. Invalid names are refused, never dropped silently. */
const HeadersSchema = z.record(
  z.string().regex(HEADER_NAME, "invalid_header_name"),
  z.string().max(2_000),
);

export type ProviderInput = {
  readonly catalogId: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly apiKey: string | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly enabled: boolean;
};

type Row = {
  id: string;
  catalog_id: string;
  label: string;
  base_url: string;
  key_sealed: string;
  headers_json: string;
  enabled: number;
  created_at: string;
  updated_at: string;
};

type StateRow = {
  provider_id: string;
  models_fetched_at: string | null;
  models_error: string | null;
  usage_json: string | null;
  usage_fetched_at: string | null;
  usage_error: string | null;
};

const now = (): string => new Date().toISOString();

/** The key hint is derived from the plaintext, and the plaintext is not kept. */
function keyHint(secret: string): string {
  return secret.length <= 4 ? "••••" : `••••${secret.slice(-4)}`;
}

function parseHeaders(json: string): Record<string, string> {
  const parsed = HeadersSchema.safeParse(JSON.parse(json || "{}"));
  return parsed.success ? parsed.data : {};
}

function parseUsage(json: string | null): ProviderUsage | null {
  if (json === null) return null;
  try {
    return z
      .object({
        meters: z.array(
          z.object({
            id: z.string(),
            label: z.string(),
            percent: z.number().nullable(),
            status: z.string(),
            resetsAt: z.string().nullable(),
            text: z.string().nullable(),
          }),
        ),
        nextResetAt: z.string().nullable(),
      })
      .parse(JSON.parse(json));
  } catch {
    return null;
  }
}

/**
 * Providers, their stored catalog and the routing chain.
 *
 * Every write is one transaction, and a provider's key is sealed with the deployment
 * secret so the database file alone never carries a usable credential. Reading a key
 * back for an upstream call is the only place it is decrypted, inside the process.
 */
export class ProviderStore {
  constructor(
    private readonly db: Database,
    private readonly vaultSecret: string,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  private requireTables(): void {
    if (!hasProviderTables(this.db)) throw new Error("provider_tables_missing");
  }

  list(): ProviderView[] {
    this.requireTables();
    const rows = this.db
      .query<Row, []>("SELECT * FROM provider_connections ORDER BY created_at, id")
      .all();
    const states = new Map(
      this.db
        .query<StateRow, []>("SELECT * FROM provider_state")
        .all()
        .map((state) => [state.provider_id, state]),
    );
    return rows.map((row) => this.view(row, states.get(row.id) ?? null));
  }

  get(id: string): ProviderView | null {
    this.requireTables();
    const row = this.db
      .query<Row, [string]>("SELECT * FROM provider_connections WHERE id = ?")
      .get(id);
    if (!row) return null;
    const state =
      this.db
        .query<StateRow, [string]>("SELECT * FROM provider_state WHERE provider_id = ?")
        .get(id) ?? null;
    return this.view(row, state);
  }

  private view(row: Row, state: StateRow | null): ProviderView {
    const plain = open(this.vaultSecret, row.key_sealed);
    return {
      id: row.id,
      catalogId: row.catalog_id,
      label: row.label,
      baseUrl: row.base_url,
      enabled: row.enabled === 1,
      keyHint: plain === null ? null : keyHint(plain),
      headers: parseHeaders(row.headers_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      modelsFetchedAt: state?.models_fetched_at ?? null,
      modelsError: state?.models_error ?? null,
      usage: parseUsage(state?.usage_json ?? null),
      usageFetchedAt: state?.usage_fetched_at ?? null,
      usageError: state?.usage_error ?? null,
    };
  }

  /** The plaintext key, only for an upstream call made in this process. */
  keyOf(id: string): string | null {
    this.requireTables();
    const row = this.db
      .query<{ key_sealed: string }, [string]>(
        "SELECT key_sealed FROM provider_connections WHERE id = ?",
      )
      .get(id);
    return row ? open(this.vaultSecret, row.key_sealed) : null;
  }

  create(input: ProviderInput): string {
    this.requireTables();
    const id = randomUUID();
    const at = now();
    this.db
      .query(
        `INSERT INTO provider_connections
         (id, catalog_id, label, base_url, key_sealed, headers_json, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.catalogId,
        input.label,
        input.baseUrl,
        seal(this.vaultSecret, input.apiKey ?? ""),
        JSON.stringify(input.headers),
        input.enabled ? 1 : 0,
        at,
        at,
      );
    return id;
  }

  /**
   * Edits a provider. An absent key keeps the stored one, so editing a label does not
   * require the owner to paste the key again.
   */
  update(
    id: string,
    patch: {
      readonly label?: string;
      readonly baseUrl?: string;
      readonly apiKey?: string | null;
      readonly headers?: Readonly<Record<string, string>>;
      readonly enabled?: boolean;
    },
  ): boolean {
    this.requireTables();
    const row = this.db
      .query<Row, [string]>("SELECT * FROM provider_connections WHERE id = ?")
      .get(id);
    if (!row) return false;
    const baseChanged = patch.baseUrl !== undefined && patch.baseUrl !== row.base_url;
    this.db
      .query(
        `UPDATE provider_connections SET label = ?, base_url = ?, key_sealed = ?, headers_json = ?, enabled = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        patch.label ?? row.label,
        patch.baseUrl ?? row.base_url,
        patch.apiKey ? seal(this.vaultSecret, patch.apiKey) : row.key_sealed,
        JSON.stringify(patch.headers ?? parseHeaders(row.headers_json)),
        (patch.enabled ?? row.enabled === 1) ? 1 : 0,
        now(),
        id,
      );
    // A different endpoint or key describes a different catalog: the stored one and the
    // last reading are no longer about this provider.
    if (baseChanged || patch.apiKey)
      this.db.query("DELETE FROM provider_state WHERE provider_id = ?").run(id);
    if (baseChanged) this.db.query("DELETE FROM provider_models WHERE provider_id = ?").run(id);
    return true;
  }

  remove(id: string): boolean {
    this.requireTables();
    const result = this.db.query("DELETE FROM provider_connections WHERE id = ?").run(id);
    if (result.changes === 0) return false;
    this.normalizeChainPositions();
    return true;
  }

  models(providerId: string): StoredModel[] {
    this.requireTables();
    return this.db
      .query<
        {
          model_id: string;
          label: string;
          kind: string;
          context_length: number | null;
          max_output: number | null;
          input_price: number | null;
          output_price: number | null;
          tags_json: string;
        },
        [string]
      >(
        `SELECT model_id, label, kind, context_length, max_output, input_price, output_price, tags_json
           FROM provider_models WHERE provider_id = ? ORDER BY kind, label`,
      )
      .all(providerId)
      .map((row) => ({
        id: row.model_id,
        label: row.label,
        kind: row.kind === "chat" ? "chat" : "other",
        contextLength: row.context_length,
        maxOutput: row.max_output,
        inputPrice: row.input_price,
        outputPrice: row.output_price,
        tags: z.array(z.string()).catch([]).parse(JSON.parse(row.tags_json)),
      }));
  }

  /** Replaces a provider's stored catalog with what its own API just served. */
  replaceModels(providerId: string, offers: readonly StoredModel[]): void {
    this.requireTables();
    this.db.transaction(() => {
      this.db.query("DELETE FROM provider_models WHERE provider_id = ?").run(providerId);
      const insert = this.db.query(
        `INSERT OR REPLACE INTO provider_models
           (provider_id, model_id, label, kind, context_length, max_output, input_price, output_price, tags_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const offer of offers)
        insert.run(
          providerId,
          offer.id,
          offer.label,
          offer.kind,
          offer.contextLength,
          offer.maxOutput,
          offer.inputPrice,
          offer.outputPrice,
          JSON.stringify(offer.tags),
        );
    })();
  }

  /**
   * Stores what a probe established, each side with its own outcome: a usage failure
   * does not erase a good model list, and a model failure does not erase good meters.
   */
  recordProbe(
    providerId: string,
    result: {
      readonly models: readonly StoredModel[] | null;
      readonly modelsError: string | null;
      readonly usage: ProviderUsage | null;
      readonly usageError: string | null;
      readonly fetchedAt: string;
    },
  ): void {
    this.requireTables();
    if (result.models !== null) this.replaceModels(providerId, result.models);
    this.db
      .query(
        `INSERT INTO provider_state
         (provider_id, models_fetched_at, models_error, usage_json, usage_fetched_at, usage_error, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider_id) DO UPDATE SET
         models_fetched_at = COALESCE(excluded.models_fetched_at, provider_state.models_fetched_at),
         models_error = excluded.models_error,
         usage_json = COALESCE(excluded.usage_json, provider_state.usage_json),
         usage_fetched_at = COALESCE(excluded.usage_fetched_at, provider_state.usage_fetched_at),
         usage_error = excluded.usage_error,
         checked_at = excluded.checked_at`,
      )
      .run(
        providerId,
        result.models === null ? null : result.fetchedAt,
        result.modelsError,
        result.usage === null ? null : JSON.stringify(result.usage),
        result.usage === null ? null : result.fetchedAt,
        result.usageError,
        result.fetchedAt,
      );
  }

  /** Records a read that could not even be attempted, keeping the previous good reading. */
  recordProbeError(
    providerId: string,
    modelsError: string | null,
    usageError: string | null,
  ): void {
    this.requireTables();
    this.db
      .query(
        `INSERT INTO provider_state (provider_id, models_error, usage_error, checked_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(provider_id) DO UPDATE SET
         models_error = excluded.models_error,
         usage_error = excluded.usage_error,
         checked_at = excluded.checked_at`,
      )
      .run(providerId, modelsError, usageError, now());
  }

  chain(): ChainEntry[] {
    this.requireTables();
    return this.db.query<ChainRow, []>(CHAIN_SELECT).all().map(chainEntryOf);
  }

  /** The enabled entries the router may use, in the saved order. */
  routes(): ChainEntry[] {
    return this.chain().filter((entry) => entry.enabled && entry.providerEnabled);
  }

  addToChain(providerId: string, modelId: string): void {
    this.requireTables();
    this.db.transaction(() => {
      const exists = this.db
        .query<{ provider_id: string }, [string, string]>(
          "SELECT provider_id FROM model_chain WHERE provider_id = ? AND model_id = ?",
        )
        .get(providerId, modelId);
      if (exists) {
        this.db
          .query("UPDATE model_chain SET enabled = 1 WHERE provider_id = ? AND model_id = ?")
          .run(providerId, modelId);
        return;
      }
      const next = this.db
        .query<{ position: number | null }, []>(
          "SELECT MAX(position) + 1 AS position FROM model_chain",
        )
        .get();
      this.db
        .query(
          "INSERT INTO model_chain (position, provider_id, model_id, enabled, created_at) VALUES (?, ?, ?, 1, ?)",
        )
        .run(next?.position ?? 0, providerId, modelId, now());
    })();
  }

  removeFromChain(providerId: string, modelId: string): void {
    this.requireTables();
    this.db
      .query("DELETE FROM model_chain WHERE provider_id = ? AND model_id = ?")
      .run(providerId, modelId);
    this.normalizeChainPositions();
  }

  setChainEnabled(providerId: string, modelId: string, enabled: boolean): void {
    this.requireTables();
    this.db
      .query("UPDATE model_chain SET enabled = ? WHERE provider_id = ? AND model_id = ?")
      .run(enabled ? 1 : 0, providerId, modelId);
  }

  /**
   * Saves an exact permutation of the whole chain. Anything else is refused, because a
   * partial order would make the router's decision depend on positions nobody chose.
   */
  reorderChain(
    entries: readonly { readonly providerId: string; readonly modelId: string }[],
  ): void {
    this.requireTables();
    const current = this.chain();
    const wanted = new Set(entries.map((entry) => `${entry.providerId}\u0000${entry.modelId}`));
    if (
      entries.length !== current.length ||
      wanted.size !== entries.length ||
      !current.every((entry) => wanted.has(`${entry.providerId}\u0000${entry.modelId}`))
    )
      throw new Error("invalid_chain");
    this.db.transaction(() => {
      const move = this.db.query(
        "UPDATE model_chain SET position = ? WHERE provider_id = ? AND model_id = ?",
      );
      // Positions are unique and primary; park them out of range first so a swap of
      // adjacent rows cannot collide mid-transaction.
      this.db.query("UPDATE model_chain SET position = -1 - position").run();
      for (const [index, entry] of entries.entries())
        move.run(index, entry.providerId, entry.modelId);
    })();
  }

  /** Seeds a database from the old environment configuration, once. */
  seed(entries: readonly SeedProvider[]): number {
    this.requireTables();
    const existing =
      this.db
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM provider_connections")
        .get()?.count ?? 0;
    if (existing > 0) return 0;
    let created = 0;
    this.db.transaction(() => {
      for (const entry of entries) {
        const id = this.create({
          catalogId: entry.catalogId,
          label: entry.label,
          baseUrl: entry.baseUrl,
          apiKey: entry.apiKey,
          headers: entry.headers,
          enabled: true,
        });
        this.db
          .query(
            "INSERT OR IGNORE INTO model_chain (position, provider_id, model_id, enabled, created_at) VALUES (?, ?, ?, 1, ?)",
          )
          .run(entry.position, id, entry.model, now());
        created += 1;
      }
    })();
    return created;
  }

  private normalizeChainPositions(): void {
    const rows = this.chain();
    this.db.transaction(() => {
      const move = this.db.query(
        "UPDATE model_chain SET position = ? WHERE provider_id = ? AND model_id = ?",
      );
      this.db.query("UPDATE model_chain SET position = -1 - position").run();
      for (const [index, entry] of rows.entries()) move.run(index, entry.providerId, entry.modelId);
    })();
  }

  /** Exposed so the runtime can build the router with the same transport its tests use. */
  transport(): { fetchImpl?: typeof fetch } {
    return this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl };
  }
}

export type ChainEntry = {
  readonly position: number;
  readonly providerId: string;
  readonly providerLabel: string;
  readonly catalogId: string;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly modelLabel: string;
  readonly enabled: boolean;
  readonly providerEnabled: boolean;
};

export type SeedProvider = {
  readonly catalogId: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly model: string;
  readonly position: number;
};

type ChainRow = {
  position: number;
  provider_id: string;
  model_id: string;
  enabled: number;
  provider_enabled: number;
  label: string;
  catalog_id: string;
  base_url: string;
  model_label: string | null;
};

const CHAIN_SELECT = `SELECT c.position, c.provider_id, c.model_id, c.enabled,
  p.enabled AS provider_enabled, p.label, p.catalog_id, p.base_url,
  m.label AS model_label
  FROM model_chain c
  JOIN provider_connections p ON p.id = c.provider_id
  LEFT JOIN provider_models m ON m.provider_id = c.provider_id AND m.model_id = c.model_id
  ORDER BY c.position`;

function chainEntryOf(row: ChainRow): ChainEntry {
  return {
    position: row.position,
    providerId: row.provider_id,
    providerLabel: row.label,
    catalogId: row.catalog_id,
    baseUrl: row.base_url,
    modelId: row.model_id,
    modelLabel: row.model_label ?? row.model_id,
    enabled: row.enabled === 1,
    providerEnabled: row.provider_enabled === 1,
  };
}
