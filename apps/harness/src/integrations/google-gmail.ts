import { z } from "zod";
import { accessToken, resolveAccountId, type GoogleDeps } from "./google-auth";
import { isSourceEnabled } from "./account-store";
import { cursorOf, failureDetail, type Progress } from "./google-sync-state";
import { recordOutcome, saveItems, skippedOutcome } from "./sync-store";
import { normalizeGmail, type NormalizedItem, type SyncOutcome } from "./normalize";

async function syncGmailFull(
  deps: GoogleDeps,
  accountId: string,
  token: string,
  now: number,
  progress: Progress,
): Promise<SyncOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  // Capture the baseline before listing, so mail arriving during collection
  // is replayed by the next incremental sync rather than skipped.
  const profile = await fetchImpl("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!profile.ok) throw new Error(`gmail_profile_http_${profile.status}`);
  const historyId = z
    .object({ historyId: z.string().optional() })
    .parse(await profile.json()).historyId;
  if (!historyId) throw new Error("gmail_missing_history_id");
  const ids = new Set<string>();
  let page: string | undefined;
  do {
    const url = new URL(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=100&q=newer_than:7d",
    );
    if (page) url.searchParams.set("pageToken", page);
    const list = await fetchImpl(url.toString(), { headers: { authorization: `Bearer ${token}` } });
    if (!list.ok) throw new Error(`gmail_list_http_${list.status}`);
    const body = z
      .object({
        messages: z.array(z.object({ id: z.string().optional() })).optional(),
        nextPageToken: z.string().optional(),
      })
      .parse(await list.json());
    for (const message of body.messages ?? []) if (message.id) ids.add(message.id);
    page = body.nextPageToken;
  } while (page);
  const items: NormalizedItem[] = [];
  await gmailDetails(deps, token, ids, items, progress);
  return deps.db.transaction(() => {
    deps.db.query("DELETE FROM sync_items WHERE account_id=? AND source='gmail'").run(accountId);
    saveItems(deps.db, accountId, "gmail", items, now);
    return recordOutcome(deps, {
      accountId,
      source: "gmail",
      ok: true,
      count: items.length,
      cursor: historyId,
      error: "full_resync",
    });
  })();
}

async function gmailDetails(
  deps: GoogleDeps,
  token: string,
  ids: Iterable<string>,
  sink: NormalizedItem[],
  progress: Progress,
): Promise<void> {
  for (const id of ids) {
    const detail = await (deps.fetchImpl ?? fetch)(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    if (!detail.ok) throw new Error(`gmail_detail_http_${detail.status}`);
    sink.push(normalizeGmail(await detail.json()));
    progress.items = sink.length;
  }
}

export async function syncGoogleGmail(deps: GoogleDeps, accountId?: string): Promise<SyncOutcome> {
  const target = resolveAccountId(accountId);
  if (!isSourceEnabled(deps.db, target, "gmail")) return skippedOutcome(target, "gmail");
  const now = (deps.now ?? Date.now)();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const progress: Progress = { items: 0 };
  try {
    const token = await accessToken(deps, target);
    const historyId = cursorOf(deps.db, target, "gmail");
    if (!historyId) return await syncGmailFull(deps, target, token, now, progress);

    const ids = new Set<string>();
    const deleted = new Set<string>();
    let page: string | undefined;
    let cursor = historyId;
    do {
      const url = new URL(
        `https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${encodeURIComponent(historyId)}&maxResults=100`,
      );
      if (page) url.searchParams.set("pageToken", page);
      const response = await fetchImpl(url.toString(), {
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.status === 404) return await syncGmailFull(deps, target, token, now, progress);
      if (!response.ok) throw new Error(`gmail_history_http_${response.status}`);
      const messageChange = z.array(
        z.object({ message: z.object({ id: z.string().optional() }).optional() }),
      );
      const body = z
        .object({
          history: z
            .array(
              z.object({
                messagesAdded: messageChange.optional(),
                messagesDeleted: messageChange.optional(),
              }),
            )
            .optional(),
          historyId: z.string().optional(),
          nextPageToken: z.string().optional(),
        })
        .parse(await response.json());
      for (const entry of body.history ?? []) {
        for (const added of entry.messagesAdded ?? [])
          if (added.message?.id) {
            ids.add(added.message.id);
            deleted.delete(added.message.id);
          }
        for (const removed of entry.messagesDeleted ?? [])
          if (removed.message?.id) {
            deleted.add(removed.message.id);
            ids.delete(removed.message.id);
          }
      }
      cursor = body.historyId ?? cursor;
      page = body.nextPageToken;
    } while (page);
    const items: NormalizedItem[] = [];
    await gmailDetails(deps, token, ids, items, progress);
    return deps.db.transaction(() => {
      saveItems(deps.db, target, "gmail", items, now);
      for (const id of deleted)
        deps.db
          .query("DELETE FROM sync_items WHERE account_id=? AND source='gmail' AND item_id=?")
          .run(target, id);
      return recordOutcome(deps, {
        accountId: target,
        source: "gmail",
        ok: true,
        count: items.length,
        cursor,
        error: null,
      });
    })();
  } catch (error) {
    return recordOutcome(deps, {
      accountId: target,
      source: "gmail",
      ok: false,
      count: progress.items,
      cursor: null,
      error: error instanceof Error ? error.message : "unknown",
      detail: failureDetail(progress),
    });
  }
}
