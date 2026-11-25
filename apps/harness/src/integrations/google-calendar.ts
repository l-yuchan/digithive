import { z } from "zod";
import { accessToken, resolveAccountId, type GoogleDeps } from "./google-auth";
import { isSourceEnabled } from "./account-store";
import { cursorOf, failureDetail, type Progress } from "./google-sync-state";
import { recordOutcome, saveItems, skippedOutcome } from "./sync-store";
import {
  CalendarEventPayloadSchema,
  normalizeCalendarEvent,
  type NormalizedItem,
  type SyncOutcome,
} from "./normalize";

export async function syncGoogleCalendar(
  deps: GoogleDeps,
  accountId?: string,
): Promise<SyncOutcome> {
  const target = resolveAccountId(deps, accountId);
  if (!isSourceEnabled(deps.db, target, "calendar")) return skippedOutcome(target, "calendar");
  const now = (deps.now ?? Date.now)();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const progress: Progress = { items: 0 };
  try {
    const token = await accessToken(deps, target);
    const syncToken = cursorOf(deps.db, target, "calendar");

    // Incremental and full sync take different parameters: Google rejects
    // syncToken together with timeMin/singleEvents, so the incremental request
    // carries the token alone and the full request carries the time window.
    const buildUrl = (incremental: string | null): string => {
      const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
      url.searchParams.set("maxResults", "250");
      if (incremental) {
        url.searchParams.set("syncToken", incremental);
      } else {
        url.searchParams.set("singleEvents", "true");
        url.searchParams.set("timeMin", new Date(now - 24 * 60 * 60 * 1_000).toISOString());
      }
      return url.toString();
    };

    let response = await fetchImpl(buildUrl(syncToken), {
      headers: { authorization: `Bearer ${token}` },
    });
    let note: string | null = null;
    let full = syncToken === null;
    if ((response.status === 410 || response.status === 400) && syncToken) {
      // An expired or unusable token means starting over, never failing forever.
      const failureStatus = response.status;
      response = await fetchImpl(buildUrl(null), { headers: { authorization: `Bearer ${token}` } });
      note = `full_resync_after_${failureStatus}`;
      full = true;
    }
    const items: NormalizedItem[] = [];
    const deleted: string[] = [];
    let cursor = syncToken;
    while (true) {
      if (!response.ok) throw new Error(`calendar_http_${response.status}`);
      const body = z
        .object({
          items: z.array(CalendarEventPayloadSchema).optional(),
          nextSyncToken: z.string().optional(),
          nextPageToken: z.string().optional(),
        })
        .parse(await response.json());
      for (const raw of body.items ?? []) {
        if (raw.status === "cancelled" && raw.id) deleted.push(raw.id);
        else items.push(normalizeCalendarEvent(raw));
      }
      progress.items = items.length;
      if (body.nextSyncToken) cursor = body.nextSyncToken;
      if (!body.nextPageToken) break;
      const url = new URL(buildUrl(full ? null : syncToken));
      url.searchParams.set("pageToken", body.nextPageToken);
      response = await fetchImpl(url.toString(), { headers: { authorization: `Bearer ${token}` } });
    }
    return deps.db.transaction(() => {
      if (full)
        deps.db
          .query("DELETE FROM sync_items WHERE account_id=? AND source='calendar'")
          .run(target);
      saveItems(deps.db, target, "calendar", items, now);
      for (const id of deleted)
        deps.db
          .query("DELETE FROM sync_items WHERE account_id=? AND source='calendar' AND item_id=?")
          .run(target, id);
      return recordOutcome(deps, {
        accountId: target,
        source: "calendar",
        ok: true,
        count: items.length,
        cursor,
        error: note,
      });
    })();
  } catch (error) {
    return recordOutcome(deps, {
      accountId: target,
      source: "calendar",
      ok: false,
      count: progress.items,
      cursor: null,
      error: error instanceof Error ? error.message : "unknown",
      detail: failureDetail(progress),
    });
  }
}
