import {
  accountSources,
  getAccount,
  isSourceEnabled,
  type AccountRecord,
  type SourceName,
} from "./accounts";
import { syncCanvas, type CanvasDeps } from "./canvas";
import { loadTokens, syncGoogleCalendar, syncGoogleGmail, type GoogleDeps } from "./google";
import type { SyncOutcome } from "./normalize";

export type SyncSourcesDeps = {
  readonly google: GoogleDeps;
  readonly canvas: CanvasDeps;
};

/** What a collection run asked for: an account and, optionally, which sources. */
export type CollectionScope = {
  readonly accountId: string;
  /** Absent means every source the account's feature switches allow. */
  readonly sources?: readonly SourceName[];
};

function skipped(accountId: string, source: SourceName, error: string): SyncOutcome {
  return { accountId, source, ok: false, skipped: true, count: 0, cursor: null, error };
}

/**
 * Collect one account's data. Collection happens only inside a scheduled run,
 * never as a side effect of connecting an account or opening a screen.
 *
 * A source's feature switch is a permission: when it is off, that information is
 * not used, so collection refuses it here as well as in searches and briefings.
 * The requested source list narrows collection further; a source outside the
 * account's provider is refused instead of silently ignored.
 */
export async function collectSources(
  deps: SyncSourcesDeps,
  scope: CollectionScope,
): Promise<SyncOutcome[]> {
  const account = getAccount(deps.google.db, scope.accountId);
  if (!account) throw new Error(`account_not_found: ${scope.accountId}`);
  const supported = accountSources(deps.google.db, account.id).map((state) => state.source);
  const requested = scope.sources ?? supported;
  const unsupported = requested.filter((source) => !supported.includes(source));
  if (unsupported.length > 0) {
    throw new Error(
      `source_not_supported: ${account.provider} account ${account.id} has no ${unsupported.join(", ")} source`,
    );
  }
  if (requested.length === 0) {
    throw new Error(`source_required: ${account.id} has no sources to collect`);
  }
  const results: SyncOutcome[] = [];
  for (const source of unique(requested)) {
    if (!isSourceEnabled(deps.google.db, account.id, source)) {
      results.push(skipped(account.id, source, "source_disabled"));
      continue;
    }
    results.push(await collectOne(deps, account, source));
  }
  return results;
}

async function collectOne(
  deps: SyncSourcesDeps,
  account: AccountRecord,
  source: SourceName,
): Promise<SyncOutcome> {
  if (account.provider === "google") {
    if (loadTokens(deps.google.db, deps.google.vaultSecret, account.id) === null) {
      return skipped(account.id, source, "google_not_connected");
    }
    // The source functions refuse a disabled source themselves; this guard keeps
    // the permission in one place for every caller inside the collection run.
    if (!isSourceEnabled(deps.google.db, account.id, source)) {
      return skipped(account.id, source, "source_disabled");
    }
    return source === "gmail"
      ? syncGoogleGmail(deps.google, account.id)
      : syncGoogleCalendar(deps.google, account.id);
  }
  const configured =
    deps.canvas.config.baseUrl.trim().length > 0 && deps.canvas.config.token.trim().length > 0;
  if (!configured) return skipped(account.id, source, "canvas_not_configured");
  return syncCanvas({ ...deps.canvas, accountId: account.id });
}

function unique(sources: readonly SourceName[]): SourceName[] {
  return [...new Set(sources)];
}
