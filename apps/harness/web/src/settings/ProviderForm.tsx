import { useState } from "react";
import type { Catalog } from "./providerTypes";

/** HTTP header names the server accepts; a placeholder like `your-header` is refused. */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

function headersFromText(text: string): Record<string, string> | null {
  const headers: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const index = trimmed.indexOf(":");
    if (index <= 0) return null;
    const name = trimmed.slice(0, index).trim();
    if (!HEADER_NAME.test(name)) return null;
    headers[name] = trimmed.slice(index + 1).trim();
  }
  return headers;
}

/**
 * The provider form. A predefined provider needs only its key; an OpenAI-compatible server
 * also needs where it lives. The key field is empty when editing, because the server never
 * sends a key back: leaving it empty keeps the stored one.
 */
export function ProviderForm({
  catalogs,
  busy,
  initial,
  onCancel,
  onSave,
}: {
  readonly catalogs: readonly Catalog[];
  readonly busy: boolean;
  readonly initial?: {
    readonly catalogId: string;
    readonly label: string;
    readonly baseUrl: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly keyHint: string | null;
  };
  readonly onCancel: () => void;
  readonly onSave: (body: Record<string, unknown>) => void;
}) {
  const editing = initial !== undefined;
  const [catalogId, setCatalogId] = useState(initial?.catalogId ?? catalogs[0]?.id ?? "custom");
  const [label, setLabel] = useState(initial?.label ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [headers, setHeaders] = useState(
    Object.entries(initial?.headers ?? {})
      .map(([name, value]) => `${name}: ${value}`)
      .join("\n"),
  );
  const [error, setError] = useState<string | null>(null);

  const catalog = catalogs.find((candidate) => candidate.id === catalogId) ?? null;

  const submit = () => {
    setError(null);
    const parsedHeaders = headersFromText(headers);
    if (parsedHeaders === null) {
      setError("헤더는 한 줄에 `이름: 값` 형식으로 적어주세요.");
      return;
    }
    const target = baseUrl.trim().length > 0 ? baseUrl.trim() : (catalog?.baseUrl ?? "");
    if (!/^https?:\/\/\S+$/.test(target)) {
      setError("base URL은 http:// 또는 https://로 시작해야 합니다.");
      return;
    }
    if (!editing && apiKey.trim().length === 0) {
      setError("API 키를 입력해 주세요.");
      return;
    }
    onSave({
      catalogId,
      ...(label.trim().length > 0 ? { label: label.trim() } : {}),
      baseUrl: target,
      ...(apiKey.trim().length > 0 ? { apiKey: apiKey.trim() } : {}),
      headers: parsedHeaders,
    });
  };

  return (
    <div className="card provider-form" data-testid="provider-form">
      <h3>{editing ? `${initial.label} 수정` : "공급자 추가"}</h3>
      <div className="provider-fields">
        <label>
          종류
          <select
            value={catalogId}
            data-testid="provider-catalog"
            disabled={editing || busy}
            onChange={(event) => {
              setCatalogId(event.target.value);
              setBaseUrl("");
            }}
          >
            {catalogs.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        {catalog !== null ? (
          <p className="run-meta" data-testid="provider-catalog-description">
            {catalog.description}{" "}
            <a href={catalog.docsUrl} target="_blank" rel="noreferrer">
              문서
            </a>
          </p>
        ) : null}
        <label>
          이름
          <input
            value={label}
            placeholder={catalog?.label ?? "이름"}
            data-testid="provider-label"
            disabled={busy}
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>
        <label>
          base URL
          <input
            value={baseUrl}
            placeholder={catalog?.baseUrl ?? "https://llm.example/v1"}
            aria-label="base URL"
            data-testid="provider-base-url"
            disabled={busy}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </label>
        <label>
          API 키
          <input
            type="password"
            value={apiKey}
            placeholder={editing ? (initial.keyHint ?? "변경하지 않으려면 비워두세요") : "sk-…"}
            aria-label="API 키"
            data-testid="provider-api-key"
            disabled={busy}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </label>
        <label>
          추가 헤더 (선택)
          <textarea
            value={headers}
            rows={2}
            placeholder={"x-api-key: …"}
            data-testid="provider-headers"
            disabled={busy}
            onChange={(event) => setHeaders(event.target.value)}
          />
        </label>
      </div>
      {error !== null ? (
        <p className="error" role="alert" data-testid="provider-form-error">
          {error}
        </p>
      ) : null}
      <div className="run-actions">
        <button
          className="primary"
          type="button"
          disabled={busy}
          data-testid="provider-save"
          onClick={submit}
        >
          {busy ? "저장 중…" : editing ? "저장" : "추가하고 모델 읽기"}
        </button>
        <button className="ghost" type="button" disabled={busy} onClick={onCancel}>
          취소
        </button>
      </div>
    </div>
  );
}
