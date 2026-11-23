export function connectionsShell(): Response {
  return new Response(`<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>digithive 연결</title>
<link rel="stylesheet" href="/styles.css">
</head><body>
<div class="app-shell">
  <header class="topbar">
    <h1>연결</h1>
    <nav class="topnav" aria-label="주요 화면">
      <a class="ghost link" href="/" data-testid="nav-chat">대화</a>
      <a class="ghost link" href="/files" data-testid="nav-files">파일</a>
      <a class="ghost link" href="/memory" data-testid="nav-memory">기억</a>
      <button class="ghost" type="button" data-testid="logout">로그아웃</button>
    </nav>
  </header>
  <main class="conversation">
    <section class="upload" aria-labelledby="google-heading">
      <h2 id="google-heading">Google</h2>
      <p>일정과 메일을 읽기 전용으로 연결합니다. 발송·수정은 하지 않습니다.</p>
      <a class="primary link" href="/api/oauth/google/start" data-testid="connect-google">Google 연결하기</a>
      <ul class="file-list" data-testid="connection-list"></ul>
    </section>
    <p class="run-status" data-testid="connection-status" role="status" hidden></p>
  </main>
</div>
<script type="module" src="/connections.js"></script>
</body></html>`, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "cache-control": "no-store",
    },
  });
}
