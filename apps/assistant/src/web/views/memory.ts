export function memoryShell(): Response {
  return new Response(`<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>digithive 기억</title>
<link rel="stylesheet" href="/styles.css">
</head><body>
<div class="app-shell">
  <header class="topbar">
    <h1>기억</h1>
    <nav class="topnav" aria-label="주요 화면">
      <a class="ghost link" href="/" data-testid="nav-chat">대화</a>
      <a class="ghost link" href="/files" data-testid="nav-files">파일</a>
      <button class="ghost" type="button" data-testid="logout">로그아웃</button>
    </nav>
  </header>
  <main class="conversation">
    <form class="upload" data-testid="memory-form">
      <label for="memory-statement">기억할 내용</label>
      <input id="memory-statement" data-testid="memory-statement" type="text" autocomplete="off" required>
      <label for="memory-kind">종류</label>
      <select id="memory-kind" data-testid="memory-kind">
        <option value="preference">선호</option>
        <option value="fact">사실</option>
        <option value="interest">관심</option>
        <option value="inference">추론</option>
        <option value="commitment">약속</option>
      </select>
      <label for="memory-evidence">근거 (대화·자료 식별자)</label>
      <input id="memory-evidence" data-testid="memory-evidence" type="text" autocomplete="off" required>
      <button class="primary" type="submit" data-testid="memory-save">저장</button>
    </form>
    <p class="error" data-testid="memory-error" role="alert" hidden></p>
    <p class="run-status" data-testid="memory-status" role="status" hidden></p>
    <ul class="file-list" data-testid="memory-list"></ul>
  </main>
</div>
<script type="module" src="/memory.js"></script>
</body></html>`, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "cache-control": "no-store",
    },
  });
}
