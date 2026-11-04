export type Id = string;
export type IsoDateTime = string;
export type LocalDate = string;
export type TimeOfDay = string;
export type Provenance = "user_stated" | "inferred";
export type EntryKind = "interest" | "fact" | "hypothesis" | "commitment" | "delegation";
export type EntryStatus = "active" | "paused" | "withdrawn" | "completed" | "cancelled";
export type InterruptionPreference = "never" | "digest_only" | "when_strong" | "immediate";

export interface InterestContext { kind: "interest"; why_it_matters: string | null; known_obstacle: string | null; interruption: InterruptionPreference }
export interface FactContext { kind: "fact"; decided_at: IsoDateTime | null }
export interface HypothesisContext { kind: "hypothesis"; falsifier: string | null }
export interface CommitmentContext { kind: "commitment"; due_at: IsoDateTime | null; scheduled_start: IsoDateTime | null; scheduled_end: IsoDateTime | null; reschedule_allowed: boolean }
export interface DelegationContext { kind: "delegation"; scope: string; max_steps: number; local_only: true }
export type EntryContext = InterestContext | FactContext | HypothesisContext | CommitmentContext | DelegationContext;
export interface Entry {
  id: Id; kind: EntryKind; text: string; original_text: string; status: EntryStatus;
  provenance: Provenance; context: EntryContext; source_ids: Id[];
  derived_from_entry_id: Id | null; created_at: IsoDateTime; updated_at: IsoDateTime;
  version: number; scope: string;
}
export type PreferenceKey = "report_style" | "interruption" | "delivery" | "proactivity";
export type PreferenceValueMap = {
  report_style: "concise_first" | "detailed" | "summary_only";
  interruption: InterruptionPreference; delivery: "immediate" | "digest";
  proactivity: "off" | "suggestions_only" | "suggestions_and_preparation";
};
export interface Preference { id: Id; key: PreferenceKey; scope: string; value: string; status: "active" | "withdrawn"; provenance: Provenance; created_at: IsoDateTime; updated_at: IsoDateTime; version: number }
export interface Source { id: Id; title: string; url: string | null; publisher: string | null; published_at: LocalDate | null; evidence_summary: string; created_at: IsoDateTime }
export type TimeSensitivity = "none" | "time_sensitive";
export interface Development { id: Id; source_id: Id; occurred_at: IsoDateTime; summary: string; content: string | null; time_sensitivity: TimeSensitivity; deadline: IsoDateTime | null; created_at: IsoDateTime }
export type SuggestionStatus = "queued" | "held" | "surfaced" | "accepted" | "dismissed" | "deferred" | "expired";
export type MatchStrength = "strong" | "weak";
export type Uncertainty = "low" | "medium" | "high";
export interface WhyNow { obstacle_link: string; evidence_summary: string; source_id: Id; matched_terms: string[]; uncertainty: Uncertainty; explanation: string }
export interface SuggestionResponse { action: "accept" | "dismiss" | "defer" | "correct" | "explore"; note: string | null; at: IsoDateTime }
export interface Suggestion { id: Id; entry_id: Id; development_id: Id; status: SuggestionStatus; strength: MatchStrength; score: number; matcher: "rules" | "llm_phrasing"; why_now: WhyNow; hold_until: IsoDateTime | null; surfaced_at: IsoDateTime | null; response: SuggestionResponse | null; created_at: IsoDateTime; updated_at: IsoDateTime }
export interface TriageEvent { id: Id; development_id: Id; entry_id: Id; outcome: "suggested" | "held" | "queued_weak" | "suppressed"; reason: string; score: number; at: IsoDateTime }
export type PreparationStatus = "pending" | "in_progress" | "done" | "stopped" | "failed";
export interface Preparation { id: Id; request: string; delegation_id: Id | null; suggestion_id: Id | null; scope: string; max_steps: number; status: PreparationStatus; produced_actions: string[]; result_summary: string | null; model: "rules" | "llm"; created_at: IsoDateTime; updated_at: IsoDateTime }
export interface FocusWindow { id: Id; label: string; days: number[]; start: TimeOfDay; end: TimeOfDay }
export interface Settings { quiet_mode: boolean; quiet_until: IsoDateTime | null; delivery: "immediate" | "digest"; digest_time: TimeOfDay; timezone: string; focus_windows: FocusWindow[] }
export type HistoryEntityType = "entry" | "preference" | "source" | "development" | "suggestion" | "preparation" | "settings" | "evaluation" | "system" | "calendar";
export type HistoryActor = "user" | "system_rules" | "llm";
export interface HistoryEvent { id: Id; entity_type: HistoryEntityType; entity_id: Id; action: string; actor: HistoryActor; summary: string; details: Record<string, unknown> | null; at: IsoDateTime }
export type EvaluationCondition = "baseline" | "secretary";
export interface EvaluationEntry { id: Id; date: LocalDate; condition: EvaluationCondition; context_recovery_minutes: number | null; search_minutes: number | null; task_restart_minutes: number | null; review_correction_minutes: number | null; assistant_management_minutes: number | null; interruption_recovery_minutes: number | null; opportunities_offered: number; opportunities_accepted: number; missed_high_value: number; unwanted_interruptions: number; grounding_errors: number; correction_events: number; cancellation_violations: number; approval_boundary_violations: number; usefulness_rating: number | null; burden_rating: number | null; control_rating: number | null; confidence_rating: number | null; notes: string; created_at: IsoDateTime; updated_at: IsoDateTime }
export type EvaluationEntryInput = Omit<EvaluationEntry, "id" | "date" | "created_at" | "updated_at">;
export interface Citation { entity_type: "entry" | "source" | "development" | "suggestion"; entity_id: Id; at: IsoDateTime; quote: string }
export interface QueryRequest { question: string; at?: IsoDateTime }
export interface QueryResponse { answer: string; epistemic_status: "recorded_facts" | "includes_inferences" | "insufficient_record"; citations: Citation[]; unpinned_claims: string[]; mode: "rules" | "llm"; limitations: string }
export interface DigestResponse { date: LocalDate; generated_at: IsoDateTime; held: Suggestion[]; surfaced_today: Suggestion[]; counts: { held: number; surfaced: number; suppressed: number } }
export interface CapabilitiesResponse { app: "digithive"; schema_version: 1; mode: "offline_rules" | "llm_assisted"; llm: { enabled: boolean; provider: string | null; model: string | null }; limitations_notice: string }
export type CalendarColor = "accent" | "info" | "amber" | "danger" | "neutral";
export type CalendarEventStatus = "confirmed" | "tentative";
/** One subscribed iCal feed. The URL is usually a private, token-bearing address. */
export interface CalendarSubscription {
  id: Id; name: string; url: string; color: CalendarColor; enabled: boolean;
  last_synced_at: IsoDateTime | null; last_error: string | null; event_count: number;
  created_at: IsoDateTime; updated_at: IsoDateTime;
}
/**
 * One expanded occurrence of a calendar event inside the sync window.
 * Recurring feeds are expanded on the server, so every row is a single dated
 * occurrence. All-day rows carry the instant of local midnight in the app
 * timezone; timed rows carry the UTC instant of the occurrence start.
 */
export interface CalendarOccurrence {
  id: Id; calendar_id: Id; uid: string; summary: string; location: string | null;
  starts_at: IsoDateTime; ends_at: IsoDateTime | null; all_day: boolean;
  status: CalendarEventStatus; created_at: IsoDateTime; updated_at: IsoDateTime;
}
export interface CalendarSyncResult {
  calendar_id: Id; synced_at: IsoDateTime; window: { from: IsoDateTime; to: IsoDateTime };
  added: number; updated: number; removed: number; total: number;
}
export interface BackupSnapshotInfo { id: Id; created_at: IsoDateTime; file_name: string; size_bytes: number }
export interface ExportBundle { schema_version: 1; exported_at: IsoDateTime; settings: Settings; calendars: CalendarSubscription[]; calendar_events: CalendarOccurrence[]; entries: Entry[]; preferences: Preference[]; sources: Source[]; developments: Development[]; suggestions: Suggestion[]; preparations: Preparation[]; triage_events: TriageEvent[]; history: HistoryEvent[]; evaluations: EvaluationEntry[] }
export interface ApiError { error: { code: "validation_error" | "not_found" | "conflict" | "invalid_transition" | "forbidden_external_action" | "llm_unavailable" | "auth_required" | "auth_invalid" | "internal_error"; message: string; details?: unknown } }
export interface CreateEntryRequest { kind: EntryKind; text: string; context: EntryContext; source_ids?: Id[]; scope?: string }
export interface UpdateEntryRequest { text?: string; correction_note?: string; context?: Partial<EntryContext> }
export interface WithdrawRequest { reason?: string; stop_preparation?: boolean }
export interface CancelScheduleRequest { reason: string; reschedule_allowed?: false }
export interface PromoteRequest { to: "commitment" | "delegation"; text?: string; due_at?: IsoDateTime | null; scope?: string; max_steps?: number }
export interface CreateSourceRequest { title: string; url?: string | null; publisher?: string | null; published_at?: LocalDate | null; evidence_summary: string }
export type UpdateSourceRequest = Partial<CreateSourceRequest>;
export interface CreateDevelopmentRequest { source_id: Id; occurred_at: IsoDateTime; summary: string; content?: string | null; time_sensitivity?: TimeSensitivity; deadline?: IsoDateTime | null; addresses_obstacle_entry_ids?: Id[] }
export type UpdateDevelopmentRequest = Partial<Omit<CreateDevelopmentRequest, "source_id">>;
export interface CreatePreferenceRequest { key: PreferenceKey; scope?: string; value: string }
export interface UpdatePreferenceRequest { key?: PreferenceKey; scope?: string; value?: string; status?: "active" | "withdrawn" }
export type SuggestionResponseRequest =
  | { action: "accept"; note?: string; promote_to?: { kind: "commitment" | "delegation"; text?: string; due_at?: IsoDateTime | null; scope?: string; max_steps?: number } }
  | { action: "dismiss"; reason?: string }
  | { action: "defer"; defer_until: IsoDateTime }
  | { action: "correct"; correction: UpdateEntryRequest }
  | { action: "explore"; request: string; max_steps?: number };
export interface CreatePreparationRequest { request: string; delegation_id?: Id | null; suggestion_id?: Id | null; scope: string; max_steps?: number; local_only: true }
export interface CreateCalendarRequest { name: string; url: string; color?: CalendarColor; enabled?: boolean }
export type UpdateCalendarRequest = Partial<CreateCalendarRequest>;
export interface DeleteAllRequest { confirm: "DELETE_ALL" }
