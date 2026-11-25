import {
  accountSources,
  getAccount,
  isSourceEnabled,
  listAccountRecords,
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

function skipped(accountId: string, source: SourceName, error: string): SyncOutcome {
  return { accountId, source, ok: false, skipped: true, count: 0, cursor: null, error };
}

function allAccounts(deps: SyncSourcesDeps): AccountRecord[] {
  return listAccountRecords(deps.google.db);
}

/**
 * Collects every enabled source. With an account id only that account runs;
 * without one, every connected Google account and the Canvas identity run.
 * Callers get one outcome per account and source, so one broken credential
 * never hides the success of another account.
 */
export async function syncEnabledSources(
  deps: SyncSourcesDeps,
  accountId?: string,
): Promise<SyncOutcome[]> {
  if (accountId) {
    const account = getAccount(deps.google.db, accountId);
    if (!account) throw new Error("account_not_found");
    return syncAccount(deps, account, true);
  }
  const results: SyncOutcome[] = [];
  for (const account of allAccounts(deps)) {
    results.push(...(await syncAccount(deps, account, false)));
  }
  return results;
}

async function syncAccount(
  deps: SyncSourcesDeps,
  account: AccountRecord,
  explicit: boolean,
): Promise<SyncOutcome[]> {
  if (account.provider === "google") {
    const connected = loadTokens(deps.google.db, deps.google.vaultSecret, account.id) !== null;
    if (!connected) {
      if (!explicit) return [];
      return accountSources(deps.google.db, account.id)
        .filter((source) => source.enabled && source.source !== "canvas")
        .map((source) => skipped(account.id, source.source, "google_not_connected"));
    }
    const results: SyncOutcome[] = [];
    if (isSourceEnabled(deps.google.db, account.id, "calendar"))
      results.push(await syncGoogleCalendar(deps.google, account.id));
    if (isSourceEnabled(deps.google.db, account.id, "gmail"))
      results.push(await syncGoogleGmail(deps.google, account.id));
    return results;
  }
  if (!isSourceEnabled(deps.google.db, account.id, "canvas")) return [];
  const configured =
    deps.canvas.config.baseUrl.trim().length > 0 && deps.canvas.config.token.trim().length > 0;
  // A global scheduled sync must not report a phantom failure for an LMS the
  // owner never configured. An explicit account sync still shows why nothing ran.
  if (!explicit && !configured) return [];
  return [await syncCanvas({ ...deps.canvas, accountId: account.id })];
}
