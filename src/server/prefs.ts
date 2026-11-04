import type { Preference, PreferenceKey, PreferenceValueMap } from "../shared";

// Scoped preference resolution (contract §12.8): the most recent active
// preference for a key wins; the entry's own scope beats "global"; a withdrawn
// preference never applies. Falls back to the caller-supplied default.

export function newestActive(prefs: Preference[], key: PreferenceKey, scope: string): Preference | null {
  const matches = prefs
    .filter((p) => p.key === key && p.status === "active" && p.scope === scope)
    .sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? 1 : -1) : a.created_at < b.created_at ? 1 : -1));
  return matches[0] ?? null;
}

export function effectivePreference<K extends PreferenceKey>(
  prefs: Preference[],
  key: K,
  scope: string,
  fallback: PreferenceValueMap[K],
): PreferenceValueMap[K] {
  const scoped = scope === "global" ? null : newestActive(prefs, key, scope);
  const chosen = scoped ?? newestActive(prefs, key, "global");
  return (chosen ? chosen.value : fallback) as PreferenceValueMap[K];
}

export type ReportStyle = PreferenceValueMap["report_style"];

export function effectiveReportStyle(prefs: Preference[], scope: string): ReportStyle {
  return effectivePreference(prefs, "report_style", scope, "concise_first");
}
