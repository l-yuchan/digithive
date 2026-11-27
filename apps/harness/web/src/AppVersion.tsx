import { appVersion } from "./version";

/** The release this tab is running, so a deployed build can be identified on screen. */
export function Version() {
  const version = appVersion();
  return (
    <span
      className="app-version"
      title={`빌드 ${version}`}
      data-testid="app-version"
      style={{
        marginLeft: "auto",
        alignSelf: "center",
        color: "var(--muted)",
        fontSize: "var(--font-xs)",
        whiteSpace: "nowrap",
      }}
    >
      {version}
    </span>
  );
}
