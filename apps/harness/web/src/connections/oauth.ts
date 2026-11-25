export function hasOAuthResult(search: string): boolean {
  const result = new URLSearchParams(search).get("oauth");
  return result === "error" || result === "ok";
}

export function readOAuthError(search: string): string | null {
  const params = new URLSearchParams(search);
  if (params.get("oauth") !== "error") return null;
  return params.get("reason") || "알 수 없는 이유";
}
