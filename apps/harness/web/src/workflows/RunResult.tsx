import { z } from "zod";

const LABELS = { text: "결과", stdout: "표준 출력", stderr: "표준 오류", error: "오류" } as const;
const KEYS = ["text", "stdout", "stderr", "error"] as const;

function display(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
}

export function RunResult({ resultJson }: { readonly resultJson: string | null }) {
  if (resultJson === null)
    return (
      <p className="run-meta">
        아직 실행 결과가 없습니다. 실행은 워커에서 계속 진행될 수 있습니다.
      </p>
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultJson) as unknown;
  } catch {
    return <pre className="result-output">{resultJson}</pre>;
  }
  const record = z.record(z.string(), z.unknown()).safeParse(parsed);
  const entries = record.success
    ? KEYS.filter(
        (key) =>
          Object.hasOwn(record.data, key) && record.data[key] !== null && record.data[key] !== "",
      ).map((key) => ({ key, value: record.data[key] }))
    : [];
  return (
    <div className="run-result">
      {entries.map(({ key, value }) => (
        <section className={`result-block ${key}`} key={key}>
          <h4>{LABELS[key]}</h4>
          <pre className="result-output">{display(value)}</pre>
        </section>
      ))}
      <details className="result-json" open={entries.length === 0}>
        <summary>전체 결과 JSON</summary>
        <pre className="result-output">{JSON.stringify(parsed, null, 2) ?? resultJson}</pre>
      </details>
    </div>
  );
}
