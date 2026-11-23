export function chatShell(): Response {
  return new Response(`<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>digithive</title>
<link rel="stylesheet" href="/styles.css">
</head><body>
<div class="app-shell">
  <header class="topbar">
    <h1>digithive</h1>
    <button class="ghost" type="button" data-testid="logout">로그아웃</button>
  </header>
  <div class="layout">
    <aside class="sidebar" aria-label="대화 목록">
      <button class="primary" type="button" data-testid="new-conversation">새 대화</button>
      <ul class="conversation-list" data-testid="conversation-list"></ul>
    </aside>
    <main class="conversation" aria-label="대화">
      <h2 data-testid="conversation-title">대화</h2>
      <ol class="messages" data-testid="messages" aria-live="polite"></ol>
      <p class="run-status" data-testid="run-status" role="status" hidden></p>
      <button class="ghost" type="button" data-testid="run-cancel" hidden>작업 취소</button>
      <form class="composer" data-testid="composer">
        <label class="visually-hidden" for="chat-input">메시지</label>
        <textarea id="chat-input" data-testid="chat-input" name="text" rows="2" required
          placeholder="무엇을 도와드릴까요?"></textarea>
        <button class="primary" type="submit" data-testid="chat-send">보내기</button>
      </form>
      <p class="error" data-testid="chat-error" role="alert" hidden></p>
    </main>
  </div>
</div>
<script type="module" src="/app.js"></script>
</body></html>`, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "cache-control": "no-store",
    },
  });
}
