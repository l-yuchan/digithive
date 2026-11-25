# 대화 탭 사용성 개선 계획 (2026-11-25)

상태: **평가 + 계획만. 구현 착수 전.** 승인 후 아래 §6 순서대로 진행합니다.

## 1. 여덟 항목에 대한 평가

### 1-1. 응답 중 로딩 인디케이터 (braille 등)

**현재 동작.** 턴이 시작되면 `turn.response.started` 이벤트로 비서 말풍선이 생기고
(`web/src/App.tsx`의 `started` 액션), 그 뒤 첫 `text.delta`/`thinking.delta`가 오기까지
말풍선은 내용이 없다. 그 사이 보이는 것은 정적 문자열 `…`(`className="typing"`) 하나뿐이고,
도구 실행 중(`tool_call` 후 `tool_result` 전)에는 카드 테두리가 점선이 될 뿐 공간이 변하지 않는다.
첫 토큰까지 최대 60초(`TurnLimits.firstTokenMs`)를 기다릴 수 있으므로, 이 정적 표시는
"멈췄는지 도는 중인지"를 구분해 주지 못합니다.

**평가.** 타당하고 비용이 작습니다. 다만 인디케이터가 거짓말을 하지 않도록 세 가지 부류를
구분해야 합니다 — ① 첫 응답 대기, ② 응답 도중(생각·본문이 흐르는 중), ③ 도구 실행 대기.
③은 경과 시간(초)을 함께 보여야 의미가 있습니다. 어떤 부류에서도 "진행 중인데 신호 없음"인
상태가 남으면 안 되므로, ③은 크로미움 tick + 경과 초를 표시하고 ③가 30초
(`TurnLimits.toolMs`)에 닿기 직전 상태에서 자동 종료된다는 사실도 화면에 남깁니다.

**주의.** `aria-live="polite"`가 걸린 `ol.messages` 안에서 매 프레임(예: 120ms) 갱신되는 문자를
읽기 보조기술에 노출하면 스크린리더가 계속 읽어 댑니다. 애니메이션 문자는 `aria-hidden`으로
두고, 상태 문구("응답을 기다리는 중", "gmail_search 실행 중 · 4초")만 별도
`role="status"`로 1회성 갱신합니다. `prefers-reduced-motion`에서도 문자는 회전을 멈추고
정지 문자 하나를 보여줍니다.

**판정.** 채택. 프론트엔드 전용, 서버 변경 없음.

### 1-2. 응답 도중 사용자 입력을 interrupt가 아닌 queue로

**현재 동작.** `App.send()`는 `POST /api/sessions/:id/messages`를 즉시 호출하고
(`src/server/app.ts`), 서버는 `void runTurn(...)`으로 새 턴을 **동시에** 시작합니다.
같은 세션에 두 턴이 겹치면 두 턴이 같은 리프에서 갈라지고, 각자 `setLeaf`로 리프를 서로 덮어
쓰며, 한 턴이 끝나면 `updateEntryEvents(..., sessionId)`가 그 대화 검색 색인을 다시 쓰는데
경합하면 다른 턴이 지운 색인을 되살릴 수도 있습니다. 또 `pathEntries(leaf)`로 맥락을 재구성하면
두 번째 턴은 첫 턴의 응답을 보지 못합니다. 즉 지금은 "interrupt"도 "queue"도 아니고 **경합**입니다.

**평가.** 요청 자체는 정확합니다. 큐로 만들면 턴은 직렬로 실행되고, 두 번째 사용자 발화는
첫 응답 뒤에 붙습니다. 다만 이 서버는 재시작·크래시(`src/scheduler/...`처럼 워커가 아닌
서버 프로세스 안의 async 함수)를 넘어가는 인메모리 큐를 신뢰할 수 없으므로, **큐의 진실은 DB**여야
합니다(마이그레이션).

**설계.**

- 스키마(마이그레이션 v11, 규칙상 v10→v11 전이 하나 추가, 가장 오래된 전이 v9→v10은 유지):
  `session_queue(id, session_id, text, created_at)` — 사용자 발화 텍스트만 담습니다.
  `sessions.queue_paused INTEGER NOT NULL DEFAULT 0` — 오류로 멈춘 큐를 사용자가 풀 때까지 보존.
- 전송 경로: 세션에 진행 중인 턴이 없으면 **지금처럼** 즉시 `runTurn`(결과가 화면에 바로).
  진행 중이면 `session_queue`에 넣고 `202 {queued: true}`로 응답. 이벤트 `queue.enqueued`
  (sessionId)로 다른 탭에도 반영.
- 이어가기: `runTurn`이 성공 또는 중단으로 정상 종료한 지점에서 `drainQueue(sessionId)`를 호출 —
  대기열에서 하나 꺼내 `queue.dequeued` 이벤트를 낸 뒤 `runTurn`을 다시 시작. 실패
  (`status: failed`)일 때는 **배출하지 않고** `queue_paused = 1`로 두고 `queue.paused` 이벤트로
  화면에 알립니다(자동 재시도가 오류를 반복하지 않게).
- 대기열 API: `GET /api/sessions/:id/queue`, `DELETE /api/sessions/:id/queue/:queueId`(개별 취소),
  `POST /api/sessions/:id/queue/resume`(오류 뒤 재개). 모두 인증 필요 경로(기존 gate 그대로).
- 화면: 작성기 위에 칩 목록(`대기 중 · 1` + 본문 + ✕). `composer disabled`를
  `sending`에서 분리해 응답 중에도 입력과 전송이 가능. 본문 placeholder와 전송 버튼 문구를
  "대기열에 추가"로 바꾸지 않고, 대기 상태를 칩으로만 드러냅니다(입력 자체는 늘 같은 동작).
- 편집·재생성·분기 버튼은 응답 중 비활성(대기열은 새 발화만 담고, 브랜치를 만지는 행위는
  턴 종료 후).

**판정.** 채택. 서버(마이그레이션 + 라우트 + 배출기) + 프론트엔드. 이 항목이 8개 중 유일하게
스키마를 바꾸므로 단독 랜드로 올립니다.

### 1-3·1-4. 대화 목록을 '대화' 탭 하위 메뉴로 + 5개 탭 개별 경로

**현재 동작.** 대화 목록은 `<aside class="sidebar">`로 탭과 **형제**입니다. 활성 탭은
`useState`에만 있음(`?oauth=`가 있을 때 `connections`로 시작하는 예외 하나). 새로고침하면 늘
대화 탭으로 돌아가고, 링크를 보낼 수도, 뒤로 가기도 되지 않습니다. 지금 라우팅 라이브러리는
없습니다(번들러는 `bun build` 하나, 의존성은 react/zod/web-push 뿐).

**평가.**
- 두 요청은 사실 한 요구입니다: 목록이 대화 탭 소속이면 `/chat/...`에서만 보이는 것이 자연스럽고,
  탭에 경로를 주면 그때 분기가 생깁니다. 그래서 **같은 랜드**로 묶습니다.
- 서버 쪽 필수 변경이 하나 있습니다. SPA 경로로 직접 접속하면 `serveStatic`이 `/chat`를 파일명
  `chat`으로 찾다가 404를 냅니다. 그래서 첫 세그먼트가 5개 탭 중 하나인 경로는 로그인 gate 뒤에서
  `index.html`을 돌려주는 폴백을 `src/server/app.ts`에 넣습니다(정적 자산이 우선).
- Google OAuth 콜백은 `src/server/account-routes.ts`의 `redirect()`가 `/`로 302합니다.
  사용자는 '연결' 탭에서 시작했으므로 결과가 그 탭 위에 떠야 하고, `/`는 이제 `/chat`으로
  보내야 합니다. 수정 지점은 두 곳: (a) `redirect()` 대상을 `/connections`로, (b) `/`는
  `/chat`으로 리다이렉트.
- 라우팅은 **의존성 0**으로 갑니다. History API + `popstate`만 쓰는 얇은 `web/src/routes.ts`
  (`tabOf(pathname)`, `navigate(tab)`, `useRoute()`). react-router는 이 앱에 없는 요구
  (중첩 라우트, 로더)를 끌어오므로 채택하지 않습니다.
- 경로:
  | 탭 | 경로 |
  |---|---|
  | 대화 | `/chat`, 대화 하나 선택 시 `/chat/:sessionId` |
  | 실행 로그 | `/work` |
  | 워크플로 | `/workflows` |
  | 연결 | `/connections` |
  | 기억 | `/knowledge` |
- 대화 목록 UI: 사이드바를 대화 탭 안으로 옮기고 모바일에서는 드로어→탭 내부 상단 시트로.
  데스크톱은 2단(목록 | 대화) 유지, 창 폭이 좁으면 목록이 접힘. `/chat/:sessionId`를 직접 열면
  그 대화를 활성화하고, 없는 id면 목록으로 되돌리며 오류를 표시.
- 뒤로 가기는 대화 전환도 포함(`pushState`), 탭 간 이동도 포함. 탭 전환은 `replaceState`가 아니라
  `pushState`(뒤로 = 직전 탭).

**판정.** 둘 다 채택, 같은 랜드. `tests/build-watch.test.ts`와는 무관하지만, 알림에서 대화를
열 때 `/chat/:id`로 가는 진입점은 이 랜드가 만든 경로를 그대로 씁니다.

### 1-5. 대화 이름 자동 부여

**현재 동작.** 대화 이름은 생성 시 `"첫 대화"`, `"새 대화"`, 분기 시 `"분기 대화"`로만
정해지고, 사용자가 ✎로 바꾸기 전까지 그대로입니다. 대화가 늘면 목록이
`새 대화, 새 대화, 새 대화…`가 됩니다.

**평가.** 이 환경에서 실제로 체감되는 통증입니다. 다만 "언제 붙일지"와 "어떤 자료로 붙일지"를
정하지 않으면 자동 이름이 **사용자가 손으로 붙인 이름을 덮어쓰는** 사고가 납니다.

**설계.**

- **한 번만.** `sessions.title_source` 컬럼(`'initial' | 'auto' | 'user'`, 마이그레이션 v11 —
  1-2와 같은 전이). 초기 제목은 `'initial'`, ✎ 편집은 `'user'`, 자동은 `'auto'`.
  자동 이름은 `title_source = 'initial'`일 때만 적용 → 이미 자동/수동 이름이면 다시 건드리지 않음.
  사용자가 나중에 손으로 고치면 `'user'`가 되어 영구 고정.
- **자료.** ① 첫 사용자 발화, ② 첫 비서 응답의 생각(`thinking`)과 본문 중 400자까지,
  ③ (있으면) 그 턴이 호출한 도구 이름 목록. 이 셋이 모이는 시점 = 첫 턴이 `turn.done`을 낸 직후.
- **실행 방식: 워크플로 정의 하나 + 단발 실행.** 이 프로젝트는 "스크립트로 충분하면 스크립트"
  원칙이지만, 짧은 이름은 언어 판단이므로 예외적으로 모델을 씁니다. 새 서버 코드 없이
  워크플로 실행기(`RunExecutorSchema`의 `agent`)에 위임하고, 모델에게 JSON 한 줄
  (`{"title": "..."}`)을 요구하는 지시를 정의로 둡니다. 실행은 `enqueueRun`을 그대로 사용해
  실행 로그 탭에서 관찰 가능하게 합니다(원격에서 안 보이는 백그라운드 마법 금지).
  결과를 세션 제목에 쓰는 작은 경로만 서버에 추가 — `run.settled` 직후 결과 JSON을 해석해
  `title_source = 'initial'`이면 `renameSession` + `session.renamed` 이벤트.
- **실패 처리.** 모델 오류·파싱 실패·시간 초과(워크플로 deadline) → 제목 그대로 두고
  `session.title_failed` 이벤트(payload: reason). 자동 제목은 **화면에 알리는 실패**로 남고,
  다음 턴에도 재시도하지 않습니다(그러면 실행이 끝없이 붙습니다). 사용자 수동 편집은 언제나 가능.
- **모델.** 제목은 짧은 호출이므로 `workflows`의 기본 모델 경로를 그대로 쓰되, 시간 초과 30초.

**판정.** 채택. 단, 위의 "한 번만 + 실패 고지 + 실행 로그 노출" 세 조건을 설계에 고정합니다.

### 1-6·1-7. Tool Call 결과 collapsible(기본 접힘) + pretty print

**현재 동작.** `web/src/MessageParts.tsx`에서 도구 카드는 이미 `section` 하나에 펼친 채로
`<pre className="tool-output">{result.detail}</pre>`를 그대로 보여줍니다(입력 인자만
`<details>`로 접힘). 결과가 `gmail_search`/`stored_file_read`처럼 긴 JSON이면 본문 다섯 줄마다
화면 한 장이 도구 출력으로 덮여 비서의 실제 답이 묻힙니다.

**평가.**
- ⑥은 `details`로 결과를 감싸면 끝나는 수준이 아닙니다. 지금은 `<li class="turn">` 안의
  이벤트 목록이 한 덩어리로 펼쳐져 있으므로, 접힘 상태를 **턴 응답이 끝난 뒤에도** 유지하려면
  열림 상태를 화면이 들고 있어야 합니다. `details`의 열림 상태는 DOM이 들고 있지만, 완료 시
  `reloadEntries`가 엔트리를 다시 받아오면서 같은 key의 `details`는 그대로 살아 있으므로
  초기에 한 번만 정하면 유지됩니다. 다만 이후 `open`을 읽을 수 없는 문제(controlled)를 피하려고
  **uncontrolled `<details>`**를 쓰고 기본 닫힘으로 둡니다. 대신 "결과 요약 한 줄"(길이, 도구
  상태)은 접힌 상태에서도 보이게 합니다.
- ⑦은 pretty print 대상이 **결과 문자열**이며 JSON·한 줄 로그·비JSON 텍스트가 섞여 있습니다.
  무조건 `JSON.parse → stringify(2)`는 비JSON 텍스트에서 아무 이득이 없고, 큰 JSON은
  pretty print가 줄 수를 2~3배로 늘립니다. 그래서 **(a) 기본은 원문 유지**, **(b) 유효 JSON일 때만
  `pretty`/`compact` 토글**, **(c) 20,000자를 넘으면 pretty 대신 "크기 + 처음 4,000자"만.**

**설계.**

- `MessageParts.tsx`의 tool 블록을 `ToolCallBlock`으로 분리하고, `detail` 문자열을
  `formatToolResult(detail)`(신규 `web/src/formatTool.ts`, 순수 함수, 단위 테스트 대상)로 처리:
  - `JSON.parse` 성공 → `pretty`(2칸 들여쓰기)와 `raw`(원래 문자열) 두 표현 제공, 기본 `raw`.
  - 실패 → `raw`만.
  - 길이 > 20,000 → `truncated: true`, 앞 4,000자 + "… 외 N자, 원본은 도구 결과로 보존됨".
- 카드 구조: `header`(도구 이름 · 상태 · 결과 크기 · `›`)를 `summary`로, 펼치면 탭 `[pretty | raw]`.
  실행 중 카드에는 1-1의 경과 초 표시가 `header`에 붙습니다.
- 전체 접힘 기본값은 **도구 결과에만**. 생각 과정은 지금처럼 접힘, 본문 텍스트는 늘 펼침.
- 설정을 기억하지 않습니다(대화 단위 상태 없음). 원하면 다음 랜드에서 localStorage.

**판정.** ⑥·⑦ 모두 채택, 한 랜드. `web/src/MessageParts.tsx` + 신규 `formatTool.ts` + 스타일.
`conversationBlocks`의 그룹핑 규칙(도구 호출+결과 = 한 블록)은 유지합니다 — 접힘 단위가 그 블록입니다.

### 1-8. 에이전트 응답 마크다운 렌더링

**현재 동작.** 본문은 `<p className="event text">{block.event.text}</p>`에
`white-space: pre-wrap`으로 그대로 출력. 코드 블록, 목록, 표, 강조, 링크 모두 문자 그대로.

**평가.**
- 이 앱의 근간은 대화 기록이 XSS·HTML 주입의 표면이 된다는 점입니다. 결과는 모델이 만들어낸
  텍스트이고, 그 안에는 도구 결과(Gmail 본문, 파일 내용)가 섞여 들어옵니다. 따라서
  **`dangerouslySetInnerHTML`은 어떤 옵션에서도 기본 경로가 될 수 없습니다.**
- 두 후보를 실제로 비교합니다:
  | | A. `react-markdown` + `remark-gfm` | B. 직접 파서(블록 4종 + 인라인 4종) |
  |---|---|---|
  | 보안 | 기본이 React 엘리먼트(HTML 미허용), `rehype-raw`를 안 쓰면 raw HTML은 문자 | 구조적으로 안전 |
  | 기능 범위 | 제목·표·체크리스트·각주·URL 자동 링크·코드 하이라이트 확장 | 문단·목록·코드·인용·표 정도 |
  | 번들 | +~50KB(min) | +~3KB |
  | 유지비 | 라이브러리 갱신 | 자체 테스트 40~60케이스(중첩, 이스케이프, 한글 강조) |
  | 스트리밍 중 불완전 마크다운 | 닫히지 않은 코드펜스·표는 일반 문단으로 graceful | 직접 처리 필요 |
- **선택: A.** 이유는 하나입니다 — 이 앱의 신뢰 기반이 "기록을 그대로 보여준다"는 것이고,
  직접 파서는 그 약속을 지키기 위해 계속 모델 출력 전 영역을 다루는 코드를 우리가 책임져야
  합니다. 라이브러리 코드는 거의 모든 출력을 처리해 왔고, raw HTML을 끈 채로 쓰면
  보안 경로가 폐쇄됩니다. 번들 +50KB는 이 앱 규모에서 무의미하며, 의존성은 3개
  (`react-markdown`, `remark-gfm`)로 최소화 — 코드 하이라이트는 이번 범위에서 제외.

**설계.**

- 적용 범위: **비서의 `text` 이벤트만.** 사용자 발화, 생각 과정, 도구 결과, 오류는 지금처럼
  원문. (도구 결과는 ⑥의 raw 기본값과 일치.)
- 컴포넌트 `web/src/MarkdownText.tsx`: `react-markdown` + `remark-gfm`,
  `skipHtml`(또는 `rehype` 없이 기본), 링크는 `target="_blank" rel="noopener noreferrer"`,
  코드/표/링크에 스타일 클래스. 인라인 `<code>`와 코드 블록은 가로 스크롤.
- 스트리밍 중: 구문이 닫히지 않은 마크다운을 매 델타마다 재파싱합니다. 닫히지 않은
  펜스는 마지막 델타에서 텍스트로 보이며, 완료 후 다시 그려집니다. 재파싱 비용은 델타가
  올 때만(현재 부모가 매 델타마다 `MessageParts`를 다시 그리는 구조 그대로) 발생합니다.
- 단위 테스트: raw HTML이 문자로 남는지, `javascript:` 링크가 렌더되지 않는지,
  GFM 표/목록/코드가 렌더되는지.

**판정.** 채택(A안). 의존성 추가는 `bun.lock` 변경을 동반합니다.

### 평가하지 않고 제안하지 않는 것

- **interrupt(중단) 버튼 추가** — 요청은 queue이지 cancel이 아닙니다. `AbortController`를
  `POST /api/sessions/:id/interrupt`로 노출하는 일은 별도 판단이 필요하므로 이번 계획에서 제외합니다.
  단 §1-2에서 `queue.paused` 상태는 화면에 남깁니다.
- **도구 결과 전체 스트리밍** — ⑥⑦이 결과를 접어두는 것이므로 결과 스트리밍은 필요 없습니다.

## 2. 랜드 분해와 의존성

| 랜드 | 내용 | 건드리는 파일 | 선행 |
|---|---|---|---|
| R0 | 공통 준비: `web/src/routes.ts`, 서버 SPA 폴백·`/`→`/chat`, OAuth redirect 대상 | `web/src/routes.ts`(신규) `web/src/App.tsx` `src/server/app.ts` `src/server/account-routes.ts` `web/src/connections/oauth.ts` | — |
| R1 | 큐 (DB + 라우트 + 배출기 + 칩 UI) | `src/store/migrations.ts` `src/core/sessions.ts` `src/surfaces/conversation/loop.ts` `src/server/app.ts` `web/src/App.tsx` `web/src/composer/Composer.tsx` 신규 `web/src/queue.ts` | R0 |
| R2 | 대화 목록을 대화 탭 안으로 + `/chat/:sessionId` | `web/src/sidebar/ConversationSidebar.tsx` `web/src/App.tsx` `web/src/styles.css` | R0 |
| R3 | 로딩 인디케이터 + 도구 카드 접힘/pretty print | 신규 `web/src/Spinner.tsx` `web/src/formatTool.ts`, `web/src/MessageParts.tsx` `web/src/styles.css`, 1-1은 `web/src/App.tsx` | R0 |
| R4 | 자동 대화 이름 (마이그레이션 `title_source` + 워크플로 정의 + 서버 배선) | `src/store/migrations.ts` `src/workflows/*` `src/server/app.ts` `web/src/App.tsx`(이름 갱신 반영) | R1(R1의 v11 전이에 컬럼을 함께 넣음) |
| R5 | 마크다운 렌더 | 신규 `web/src/MarkdownText.tsx`, `web/src/MessageParts.tsx` `web/src/styles.css`, `package.json`/`bun.lock` | R3(같은 파일 MessageParts) |

R1과 R4가 같은 마이그레이션 파일을 만지므로 **순차**로 갑니다. R2·R3은 화면 파일이 겹치지만
(App.tsx, styles.css) 다른 영역이라, 이 저장소의 관례대로 **한 커밋씩** 순서대로 올립니다.
겹치는 파일 때문에 병렬 하위 작업은 이 계획에서 쓰지 않습니다(과거 같은 파일을 동시에 만진
lanes가 반쪽 변경을 남긴 사례 있음).

## 3. 마이그레이션 (v12 → v13)

> 구현 시 확인: 체인의 현재 head는 **v12**였다(계획 작성 시점에 v10으로 오기). 따라서 전이는 v13이 되고,
> "최대 2회 전이" 규칙에 따라 V11은 버려지고 V12→V13이 유지된다. RESET 스키마는 v11 그대로.

```
-- 한 번에 하나의 전이를 더하고, 가장 오래된 전이(v9→v10)를 유지해 체인 길이 2를 지킨다.
ALTER TABLE sessions ADD COLUMN title_source TEXT NOT NULL DEFAULT 'initial'
CREATE TABLE session_queue (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL
)
ALTER TABLE sessions ADD COLUMN queue_paused INTEGER NOT NULL DEFAULT 0
```
- 기존 리브 DB(1.8MB, v10)에서 `schema-upgrade.test.ts`로 검증. 배포 전 `VACUUM INTO` 스냅샷은
  기존 절차대로.

## 4. 검증 계획

- `bun run lint && bun run typecheck && bun run build:web && bun test`(기준선 241 pass).
- 신규 단위 테스트:
  - `queue.test.ts` — 진행 중 턴이 있으면 `session_queue`로, 없으면 즉시 실행; 실패 턴에서
    배출 정지(`queue_paused`); `resume` 후 이어감.
  - `format-tool.test.ts` — JSON pretty/raw, 비JSON, 20,000자 초과 잘림.
  - `routes.test.ts` — `tabOf()`가 5개 경로와 알 수 없는 경로를 정확히 분류.
  - `title-source.test.ts` — `initial`만 자동 덮어쓰기, `user`·`auto`는 불간섭.
  - 앱 테스트에서 `spaFallback`: `/chat/abc`가 `index.html`을 200으로, 인증 없으면 401.
- 브라우저 실측(라이브 상태에서, `.omo/evidence/chat-usability/`에 캡처):
  1. 응답 전 첫 토큰 대기 중 braille 회전, 도구 실행 중 경과 초, 끝나면 사라짐.
  2. 응답 중 두 번째 발화 전송 → "대기 중 · 1" 칩, 첫 응답 끝나면 자동 발화·응답, 순서 보존.
  3. 응답 중 오류 턴 → 큐가 "일시정지"로 보이고 재개 버튼이 동작.
  4. `/workflows` 직접 접속·새로고침·뒤로가기(5개 탭).
  5. `/chat/<id>` 직접 접속 → 그 대화 열림; 없는 id → 목록 복귀 + 오류.
  6. Google OAuth 완료 후 `/connections?oauth=ok` 위에 결과 표시.
  7. 첫 턴 완료 ~수 초 뒤 대화 이름 변경 확인, 손으로 고친 이름이 바뀌지 않음.
  8. 도구 결과 기본 접힘, 펼치면 pretty/raw 전환, 큰 결과 잘림 표시.
  9. 마크다운의 표·목록·코드·링크, raw `<script>`가 문자로 남고 `javascript:` 링크 미실행.

## 5. 위험과 되돌리기

- **마이그레이션 v11** — 배포 전 `VACUUM INTO` 스냅샷, 실패 시 이전 이미지 태그로 롤백(컨테이너
  롤백은 이미지 태그 고정 배포로 가능). `title_source DEFAULT 'initial'`이라 기존 대화는 모두
  자동 이름 대상이 됩니다(이 이름을 이미 의도적으로 붙인 경우 ✎로 고친 직후 `user`로 고정).
- **큐** — 자동 발화는 모델 비용과 도구 호출을 수반합니다. 대기열 항목은 사용자가 방금 친
  문장이라 수락이 명확하지만, "대기 중"을 보고 지울 수 있게 개별 ✕를 둡니다.
- **`prefers-reduced-motion`** — 움직임을 끈 사용자에게 회전을 강제하지 않습니다.
- **`react-markdown` 추가** — `bun.lock` 갱신. `bun install`이 배포 Dockerfile에서
  `--frozen-lockfile`로 도므로 lock이 커밋되지 않으면 빌드가 깨집니다. 같은 커밋에 넣습니다.

## 구현 결과

구현·검증 기록: docs/qa/2026-11-25-chat-usability.md. 번들 크기는 계획의 추정(+50KB)보다 컸다(+180KB, main.js 400,650 → 580,999바이트).

## 6. 실행 순서와 산출물

1. R0 → 커밋 → `bun run verify`.
2. R1 → 커밋 → 큐 테스트.
3. R4(자동 이름) → 커밋 → 워크플로 정의 시드 + 테스트.
4. R2(목록 이동) → 커밋.
5. R3(인디케이터·도구 접힘) → 커밋 → `format-tool.test.ts`.
6. R5(마크다운) → 커밋 → 브라우저 실측 → `.omo/evidence/chat-usability/review-self.md`.
7. push = CD 배포(기존 과정). 각 랜드의 브라우저 캡처는 배포 후 라이브에서.

각 커밋은 `bun run verify` 통과 후에만. 실패하면 다음 랜드로 넘어가지 않습니다.
