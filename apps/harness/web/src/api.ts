export type Session = { id: string; title: string; created_at: string; updated_at: string };

export type Part =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | { type: "tool_result"; id: string; name: string; output: string; denied?: boolean; timeout?: boolean }
  | { type: "error"; message: string };

export type Entry = {
  id: string;
  sessionId: string;
  kind: string;
  role: string | null;
  status: string | null;
  parts: Part[];
  createdAt: string;
  seq: number;
};

export async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return (await response.json()) as T;
}

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return (await response.json()) as T;
}
