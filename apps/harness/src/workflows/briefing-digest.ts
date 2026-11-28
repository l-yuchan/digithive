import type { Database, SQLQueryBindings } from "bun:sqlite";

/**
 * The briefing's first message: what changed since the last briefing, assembled from the
 * index instead of making the agent survey the board itself.
 *
 * Live 2026-11-27/28: the briefing prompt asked one agent to inspect schedules, mail,
 * assignments, research and commitments, and it spent every tool round (6) on lists and
 * reads without ever reaching `briefing_publish`. A run has a small number of rounds; the
 * runner can answer "what happened" deterministically in one query, so the agent is left
 * with what only it can do: decide what matters and write it in Korean.
 *
 * The digest is bounded per section so a busy two weeks cannot crowd out the tools, and it
 * names the exact document ids the owner can be briefed from.
 */

const MAX_ITEMS = 20;
const MAX_EXCEPTS = 12;
const EXCERPT_CHARS = 160;

export type BriefingDigest = {
  readonly text: string;
  /** Documents the digest actually read; the agent cites from these. */
  readonly candidateIds: readonly string[];
  readonly since: string;
};

type ItemRow = {
  id: string;
  source: string;
  title: string;
  at: string | null;
  account_label: string;
};

function kst(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function line(item: { title: string; at: string | null; label: string }): string {
  const when = item.at === null ? "시각 없음" : kst(item.at);
  return `- [${when}] ${item.label}: ${item.title}`;
}

/**
 * Reads only what the owner's switches left on: a source whose collection is off keeps its
 * already-collected items, but the digest says so instead of presenting them as current.
 */
export function composeBriefingDigest(db: Database, now: number): BriefingDigest {
  const iso = (value: number) => new Date(value).toISOString();
  const last = db
    .query<{ created_at: string }, []>("SELECT max(created_at) AS created_at FROM briefings")
    .get();
  const since =
    last?.created_at ??
    db
      .query<{ created_at: string | null }, []>("SELECT min(created_at) AS created_at FROM runs")
      .get()?.created_at ??
    iso(now - 86_400_000);

  const sections: string[] = [];
  const candidateIds: string[] = [];

  const collected = db
    .query<
      {
        account_id: string;
        source: string;
        enabled: number;
        ok: number;
        last_sync_at: string | null;
        error: string | null;
      },
      []
    >(
      "SELECT account_id, source, enabled, ok, last_sync_at, error FROM account_sources ORDER BY account_id, source",
    )
    .all();
  if (collected.length > 0) {
    const rows = collected.map((row) => {
      const state =
        row.enabled !== 1
          ? "수집 꺼짐(새 자료는 들어오지 않음)"
          : row.ok === 1
            ? `정상 · 마지막 수집 ${row.last_sync_at === null ? "기록 없음" : kst(row.last_sync_at)}`
            : `실패: ${row.error ?? "원인 없음"}`;
      return `- ${row.account_id}/${row.source}: ${state}`;
    });
    sections.push(`## 수집 상태\n${rows.join("\n")}`);
  }

  const items = db
    .query<ItemRow, SQLQueryBindings[]>(
      `SELECT si.account_id || '/' || si.source AS id, si.source, si.title, si.at, a.label AS account_label
         FROM sync_items si JOIN integration_accounts a ON a.id = si.account_id
        WHERE si.updated_at > ?
        ORDER BY si.at DESC LIMIT ?`,
    )
    .all(since, MAX_ITEMS);
  if (items.length > 0) {
    sections.push(
      `## 새로 들어온 자료 (${items.length}건)\n${items
        .map((item) => line({ title: item.title, at: item.at, label: item.account_label }))
        .join("\n")}`,
    );
  }

  // Open commitments and watches the owner asked to keep an eye on come from the board.
  const docs = db
    .query<
      {
        id: string;
        kind: string;
        title: string;
        status: string;
        body: string | null;
        updated_at: string;
      },
      [number]
    >(
      `SELECT d.id, d.kind, d.title, d.status, d.updated_at, f.text AS body
         FROM whiteboard_documents d LEFT JOIN whiteboard_fts f ON f.document_id = d.id
        WHERE d.kind IN ('commitment','watch') AND d.status NOT IN ('done','cancelled','archived','disabled')
        ORDER BY d.updated_at DESC LIMIT ?`,
    )
    .all(MAX_ITEMS);
  if (docs.length > 0) {
    const rows = docs.map((doc) => {
      candidateIds.push(doc.id);
      return `- [${doc.kind}/${doc.status}] ${doc.title} · id=${doc.id}`;
    });
    sections.push(`## 열린 항목\n${rows.join("\n")}`);
  }

  const recent = db
    .query<
      { id: string; kind: string; title: string; status: string; body: string | null },
      [string, number]
    >(
      `SELECT d.id, d.kind, d.title, d.status, f.text AS body
         FROM whiteboard_documents d LEFT JOIN whiteboard_fts f ON f.document_id = d.id
        WHERE d.kind IN ('record','thread') AND d.updated_at > ?
        ORDER BY d.updated_at DESC LIMIT ?`,
    )
    .all(since, MAX_EXCEPTS);
  if (recent.length > 0) {
    const rows = recent.map((doc) => {
      candidateIds.push(doc.id);
      const body = (doc.body ?? "").replace(/\s+/g, " ").trim().slice(0, EXCERPT_CHARS);
      return `- [${doc.kind}] ${doc.title} · id=${doc.id}${body.length > 0 ? `\n  ${body}` : ""}`;
    });
    sections.push(`## 최근 기록·노트 발췌\n${rows.join("\n")}`);
  }

  sections.push(
    "## 지시\n위 요약이 조사 결과입니다. 필요하면 whiteboard_read로 항목 하나만 확인하고, 그 외의 탐색은 하지 마세요. 완성한 브리핑을 briefing_publish로 저장한 뒤 push_send를 한 번 호출하세요.",
  );

  return {
    text: `지난 브리핑(${kst(since)}) 이후의 변경 요약입니다.\n\n${sections.join("\n\n")}`,
    candidateIds,
    since,
  };
}
