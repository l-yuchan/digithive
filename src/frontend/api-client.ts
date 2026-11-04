import type { ApiError, BackupSnapshotInfo, CalendarOccurrence, CalendarSubscription, CalendarSyncResult, CapabilitiesResponse, CreateCalendarRequest, CreateDevelopmentRequest, CreateEntryRequest, CreatePreferenceRequest, CreatePreparationRequest, CreateSourceRequest, DeleteAllRequest, Development, DigestResponse, Entry, EvaluationEntry, EvaluationEntryInput, ExportBundle, FocusWindow, HistoryEvent, Preference, Preparation, PromoteRequest, QueryRequest, QueryResponse, Settings, Source, Suggestion, SuggestionResponseRequest, TriageEvent, UpdateDevelopmentRequest, UpdateEntryRequest, UpdatePreferenceRequest, UpdateSourceRequest, WithdrawRequest, CancelScheduleRequest, UpdateCalendarRequest } from "../shared/types";

export interface EvaluationSummary {
  from: string; to: string; days_logged: { baseline: number; secretary: number };
  components: { baseline: Record<string, number | null>; secretary: Record<string, number | null> };
  net_time_saved_minutes: number | null;
  counts: { opportunities_offered: number; opportunities_accepted: number; missed_high_value: number; unwanted_interruptions: number; grounding_errors: number; corrections: number; cancellation_violations: number; approval_boundary_violations: number };
  ratings: { usefulness: number | null; burden: number | null; control: number | null; confidence: number | null };
  critical_events: HistoryEvent[]; missing_data: string[]; disclaimer: string;
}
type Query = Record<string, string | number | undefined>;
type List<T, K extends string> = { total: number } & { [P in K]: T[] };
function query(params: Query): string {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => { if (value !== undefined && value !== "") search.set(key, String(value)); });
  const result = search.toString(); return result ? `?${result}` : "";
}
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("Content-Type", "application/json");
  let response: Response;
  try { response = await fetch(path, { ...init, headers }); }
  catch { throw new Error("로컬 서버에 연결할 수 없습니다. 서버가 실행 중인지 확인하세요."); }
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json") ? await response.json() as unknown : await response.text();
  if (!response.ok) throw { body: body as ApiError, status: response.status };
  return body as T;
}
function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  return request<T>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

export interface AuthStatus { enabled: boolean; authenticated: boolean; }
export interface CalendarMutation { calendar: CalendarSubscription; sync: CalendarSyncResult | null; sync_error: string | null }
export interface CalendarAgenda { from: string; to: string; timezone: string; events: CalendarOccurrence[]; calendars: CalendarSubscription[] }
export const api = {
  authStatus: () => request<AuthStatus>("/api/auth/status"),
  login: (passphrase: string) => send<{ authenticated: true }>("/api/auth/login", "POST", { passphrase }),
  logout: () => send<{ authenticated: false }>("/api/auth/logout", "POST"),
  capabilities: () => request<CapabilitiesResponse>("/api/system/capabilities"),
  settings: () => request<{ settings: Settings }>("/api/settings"),
  updateSettings: (body: Partial<Omit<Settings, "focus_windows">> & { focus_windows?: FocusWindow[] }) => send<{ settings: Settings }>("/api/settings", "PATCH", body),
  entries: (params: Query = {}) => request<List<Entry, "entries">>(`/api/entries${query({ limit: 100, ...params })}`),
  entry: (id: string) => request<{ entry: Entry; history: HistoryEvent[]; suggestions: Suggestion[] }>(`/api/entries/${id}`),
  createEntry: (body: CreateEntryRequest) => send<{ entry: Entry }>("/api/entries", "POST", body),
  updateEntry: (id: string, body: UpdateEntryRequest) => send<{ entry: Entry }>(`/api/entries/${id}`, "PATCH", body),
  deleteEntry: (id: string) => send<{ deleted: true; id: string }>(`/api/entries/${id}`, "DELETE"),
  pauseEntry: (id: string) => send<{ entry: Entry }>(`/api/entries/${id}/pause`, "POST"),
  resumeEntry: (id: string) => send<{ entry: Entry }>(`/api/entries/${id}/resume`, "POST"),
  withdrawEntry: (id: string, body: WithdrawRequest) => send<{ entry: Entry; preparations_stopped: string[] }>(`/api/entries/${id}/withdraw`, "POST", body),
  cancelSchedule: (id: string, body: CancelScheduleRequest) => send<{ entry: Entry }>(`/api/entries/${id}/cancel-schedule`, "POST", body),
  promoteEntry: (id: string, body: PromoteRequest) => send<{ source_entry: Entry; created_entry: Entry }>(`/api/entries/${id}/promote`, "POST", body),
  preferences: (params: Query = {}) => request<List<Preference, "preferences">>(`/api/preferences${query(params)}`),
  createPreference: (body: CreatePreferenceRequest) => send<{ preference: Preference }>("/api/preferences", "POST", body),
  updatePreference: (id: string, body: UpdatePreferenceRequest) => send<{ preference: Preference }>(`/api/preferences/${id}`, "PATCH", body),
  sources: (params: Query = {}) => request<List<Source, "sources">>(`/api/sources${query({ limit: 100, ...params })}`),
  createSource: (body: CreateSourceRequest) => send<{ source: Source }>("/api/sources", "POST", body),
  updateSource: (id: string, body: UpdateSourceRequest) => send<{ source: Source }>(`/api/sources/${id}`, "PATCH", body),
  deleteSource: (id: string) => send<{ deleted: true; id: string }>(`/api/sources/${id}`, "DELETE"),
  developments: (params: Query = {}) => request<List<Development, "developments">>(`/api/developments${query({ limit: 100, ...params })}`),
  createDevelopment: (body: CreateDevelopmentRequest) => send<{ development: Development; suggestions: Suggestion[]; triage_events: TriageEvent[] }>("/api/developments", "POST", body),
  updateDevelopment: (id: string, body: UpdateDevelopmentRequest) => send<{ development: Development }>(`/api/developments/${id}`, "PATCH", body),
  deleteDevelopment: (id: string) => send<{ deleted: true; id: string }>(`/api/developments/${id}`, "DELETE"),
  suggestions: (params: Query = {}) => request<List<Suggestion, "suggestions">>(`/api/suggestions${query({ limit: 100, ...params })}`),
  suggestion: (id: string) => request<{ suggestion: Suggestion; entry: Entry; development: Development; source: Source }>(`/api/suggestions/${id}`),
  respondSuggestion: (id: string, body: SuggestionResponseRequest) => send<{ suggestion: Suggestion; entry: Entry; created: { entry?: Entry; preparation?: Preparation }; history: HistoryEvent[] }>(`/api/suggestions/${id}/respond`, "POST", body),
  triageEvents: (params: Query = {}) => request<List<TriageEvent, "triage_events">>(`/api/triage-events${query({ limit: 100, ...params })}`),
  retrieval: (body: QueryRequest) => send<QueryResponse>("/api/retrieval/query", "POST", body),
  digest: (date: string) => request<DigestResponse>(`/api/digest${query({ date })}`),
  calendars: () => request<List<CalendarSubscription, "calendars">>("/api/calendars"),
  createCalendar: (body: CreateCalendarRequest) => send<CalendarMutation>("/api/calendars", "POST", body),
  updateCalendar: (id: string, body: UpdateCalendarRequest) => send<CalendarMutation>(`/api/calendars/${id}`, "PATCH", body),
  deleteCalendar: (id: string) => send<{ deleted: true; id: string }>(`/api/calendars/${id}`, "DELETE"),
  syncCalendar: (id: string) => send<CalendarMutation>(`/api/calendars/${id}/sync`, "POST"),
  syncAllCalendars: () => send<{ calendars: CalendarSubscription[]; results: CalendarSyncResult[]; failures: Array<{ calendar_id: string; name: string; error: string }> }>("/api/calendars/sync-all", "POST"),
  calendarAgenda: (params: Query = {}) => request<CalendarAgenda>(`/api/calendar/events${query({ days: 14, ...params })}`),
  createPreparation: (body: CreatePreparationRequest) => send<{ preparation: Preparation }>("/api/preparations", "POST", body),
  preparations: (params: Query = {}) => request<List<Preparation, "preparations">>(`/api/preparations${query({ limit: 100, ...params })}`),
  preparation: (id: string) => request<{ preparation: Preparation }>(`/api/preparations/${id}`),
  stopPreparation: (id: string) => send<{ preparation: Preparation }>(`/api/preparations/${id}/stop`, "POST"),
  runPreparation: (id: string) => send<{ preparation: Preparation }>(`/api/preparations/${id}/run`, "POST"),
  evaluationDaily: (date: string, condition: "baseline" | "secretary") => request<{ entry: EvaluationEntry | null }>(`/api/evaluation/daily${query({ date, condition })}`),
  saveEvaluation: (date: string, body: EvaluationEntryInput) => send<{ entry: EvaluationEntry }>(`/api/evaluation/daily/${date}`, "PUT", body),
  evaluationSummary: (from: string, to: string) => request<EvaluationSummary>(`/api/evaluation/summary${query({ from, to })}`),
  history: (params: Query = {}) => request<{ events: HistoryEvent[]; total: number }>(`/api/history${query({ limit: 100, ...params })}`),
  exportBackup: () => request<ExportBundle>("/api/backup/export"),
  snapshot: () => send<{ snapshot: BackupSnapshotInfo }>("/api/backup/snapshot", "POST"),
  deleteAll: (body: DeleteAllRequest) => send<{ deleted: true }>("/api/data/all", "DELETE", body),
};
