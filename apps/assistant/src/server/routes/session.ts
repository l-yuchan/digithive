import type { AuthGate } from "../auth";

const style = `
  :root{color-scheme:light dark;font-family:system-ui,sans-serif}
  *{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#f4f5f3;color:#171c20}
  main{width:min(100% - 2rem,28rem);padding:2rem;background:#fff;border:1px solid #ccd1d0;border-radius:12px}
  h1{font-size:1.75rem;line-height:1.2;margin:0 0 1.5rem}
  label{display:block;font-weight:600;margin-bottom:.5rem}
  input,button{font:inherit;width:100%;min-height:48px;border-radius:8px}
  input{border:1px solid #59666a;padding:.6rem .8rem;caret-color:#154c64}
  button{background:#174d63;color:white;border:0;margin-top:1rem;font-weight:600;cursor:pointer}
  button:hover{background:#103b50}button:active{background:#082b3e}
  :focus-visible{outline:3px solid #db8a28;outline-offset:3px}
  p{line-height:1.5;color:#37464a}::selection{background:#c7dfed;color:#171c20}
  @media(prefers-color-scheme:dark){
    body{background:#12191d;color:#f1f4f5}main{background:#1b252a;border-color:#597179}
    input{background:#1b252a;color:#f1f4f5;border-color:#b0bdc1}
    button{background:#91cce8;color:#10252c}button:hover{background:#b1ddf2}
    p{color:#c2d0d3}::selection{background:#375b6e;color:#fff}
  }
`;

export function shell(authenticated: boolean): Response {
  const content = authenticated
    ? `<h1>대화</h1><p>로그인되었습니다. 대화와 작업 화면은 다음 단계에서 연결됩니다.</p>`
    : `<h1>로그인</h1><form method="post" action="/api/session"><label for="passphrase">암호</label>
       <input id="passphrase" data-testid="passphrase" name="passphrase" type="password" autocomplete="current-password" required>
       <button data-testid="login" type="submit">로그인</button></form>`;
  return new Response(`<!doctype html><html lang="ko"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1"><title>digithive</title>
    <style>${style}</style></head><body><main>${content}</main></body></html>`, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "cache-control": "no-store",
    },
  });
}

export function sessionRoute(request: Request, auth: AuthGate): Response | Promise<Response> {
  if (request.method === "POST") return auth.login(request);
  if (request.method === "DELETE") {
    if (!auth.authenticated(request)) return Response.json({ error: "authentication_required" }, { status: 401 });
    return auth.logout(request);
  }
  return Response.json({ error: "not_found" }, { status: 404 });
}
