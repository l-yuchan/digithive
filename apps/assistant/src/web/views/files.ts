export function filesShell(): Response {
  return new Response(`<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>digithive 파일</title>
<link rel="stylesheet" href="/styles.css">
</head><body>
<div class="app-shell">
  <header class="topbar">
    <h1>내 파일</h1>
    <nav class="topnav" aria-label="주요 화면">
      <a class="ghost link" href="/" data-testid="nav-chat">대화</a>
      <button class="ghost" type="button" data-testid="logout">로그아웃</button>
    </nav>
  </header>
  <main class="conversation">
    <form class="upload" data-testid="upload-form">
      <label for="file-path">저장 경로 (예: tasks/draft.md)</label>
      <input id="file-path" data-testid="file-path" name="path" type="text" autocomplete="off">
      <label for="file-upload">파일 선택 (25MB까지)</label>
      <input id="file-upload" data-testid="file-upload" name="file" type="file" required>
      <button class="primary" type="submit" data-testid="file-submit">올리기</button>
    </form>
    <p class="error" data-testid="files-error" role="alert" hidden></p>
    <ul class="file-list" data-testid="file-list"></ul>
    <p class="run-status" data-testid="files-status" role="status" hidden></p>
  </main>
</div>
<script type="module" src="/files.js"></script>
</body></html>`, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "cache-control": "no-store",
    },
  });
}
