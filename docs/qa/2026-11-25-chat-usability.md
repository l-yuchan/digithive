# 대화 탭 사용성 개선 — 구현과 검증 (2026-11-26)

계획: `2026-11-25-chat-usability-plan.md`. 커밋: `f8bf715`(구현 전체), `e08ecf7`(계획 정정).
기준선에서 계획과 달랐던 점 하나: 체인의 head가 v12였으므로 전이는 **v13**이고, 2회 전이 규칙에 따라 V11이 버려졌다.
게이트: `bun run verify` + `bun run fmt:check` — **282 pass / 0 fail**, lint·typecheck·build clean.

## 항목별 결과

| # | 요청 | 결과 | 근거 |
|---|---|---|---|
| 1 | 응답 중 로딩 표시 | braille 스피너, 80ms 프레임, 경과 초, `aria-hidden` 문자 + `role="status"` 문구, `prefers-reduced-motion`에서 `⠿` 고정 | `chat-waiting-queue.png`(`⠸ 응답을 기다리는 중 · 0초`), `tests/web-utils.test.ts` |
| 2 | 응답 중 입력 = queue | `session_queue`(DB), 순서대로 실행, 항목별 취소, 실패 시 일시정지 후 소유자 재개, 재시작 후 이어짐 | `chat-waiting-queue.png`(칩 `대기 중 · 1`), `chat-desktop.png`(2번째 발화가 1번째 답변 **뒤**에 답변됨), `queue.test.ts` 6케이스 |
| 3 | 대화 목록을 대화 탭 하위로 | `.chat` 그리드 안의 `chat-list`; 좁은 화면은 `☰ 대화 목록`으로 열고, 선택 시 주소가 `/chat/<id>`로 바뀜 | `chat-desktop.png`, `chat-mobile.png`, `chat-mobile-list.png`, `work-nolist.png` |
| 4 | 5개 탭 개별 경로 | `/chat`, `/chat/:id`, `/work`, `/workflows`, `/connections`, `/knowledge`; 서버가 셸을 서빙하고 로그인 전에도 200, API는 401 유지, `/`→`/chat`, OAuth 복귀→`/connections` | `routes.txt`, `routes-tabs.png`(직접 링크), `router-contract.test.ts`, `account-http.test.ts` |
| 5 | 대화 이름 자동 부여 | 첫 답변 직후 앱 소유 `system:title` 워크플로를 **서버 프로세스에서 인라인 실행**, `title_source='initial'`일 때만 기록, 실패 시 `session.title_failed` | 라이브: 두 대화가 `오프라인 모의 제목` / `titleSource: auto`; `markdown-and-tool-collapsed.png`의 `자동 이름` 배지; `title.test.ts`, `queue.test.ts`(이름 짓기 → 다음 질문 순서) |
| 6 | Tool 결과 접힘 기본 | 카드가 한 줄 요약(이름·상태·크기)으로 접힘, 펼치면 payload | 캡처에서 접힌 카드 높이 36px = 헤더만, 상태 텍스트 완료 2B, 펼친 뒤 `tool-pretty.png` |
| 7 | Tool 결과 pretty print | 유효 JSON일 때만 `원문/정리` 토글(기본 원문), 20,000자 초과는 4,000자 미리보기 + 생략 수 | `tool-pretty.png`(`정리` aria-pressed=true), `web-utils.test.ts` |
| 8 | 마크다운 렌더 | 비서 본문만: 표·목록·인라인 코드·펜스·링크; raw HTML은 문자, `javascript:` 링크는 href 없음; 사용자 발화는 평문 | `markdown-and-tool-collapsed.png`, DOM 단언(표/목록/코드/link rel, script 미생성), `markdown.test.ts` |

## 검증이 잡아낸 결함 (그리고 고친 것)

1. **셸이 `/chat/<id>`에서 부팅되지 않음** — `./main.js`가 `/chat/main.js`로 해석돼 HTML을 받았다. 자산 경로를 루트 기준으로 바꾸고(`web/index.html`), 파일 미리보기용 상대화는 `PREVIEW_ASSETS=1`일 때만.
2. **일시정지된 큐가 새 턴을 시작함** — `send()`가 `queuePaused`를 먼저 본다.
3. **이름 짓기 실행이 큐를 영구히 막음** — 워커가 아닌 서버에서 인라인 실행 + `session.title_settled` 이벤트 + 가드 타이머(`titleGuardMs`).
4. **대화 표면의 이벤트 구독이 닫힌 DB를 계속 읽음** — 테스트 전체를 깨뜨렸다(suite 간섭). `close()`로 해제, 하네스 종료와 테스트에 연결.
5. **v12 전이가 스스로를 건너뜀** — 쓰기 트랜잭션 안에서 `PRAGMA user_version` 읽기가 이전 값을 돌려준다(실측: Bun 1.4.5). 버전을 트랜잭션 밖으로 옮기고 마지막 커밋 뒤에 기록.
6. 도구 상태 텍스트가 flex에서 압축됨(`완료`) → `white-space: nowrap`; 모바일 `☰ 대화 목록`이 채워진 버튼으로 보임 → quiet 스타일.

## 계획과 달라진 점

- **번들 크기**: 계획은 +50KB를 예상, 실측 `main.js` 400,650 → 580,999바이트(+180KB, +45%). gfm 표가 큰 부분을 차지한다. 이 규모에서는 문제없다고 판단했지만, 추정이 틀렸다는 사실은 남긴다.
- **Tool 카드 접힘 단위**: 계획대로 호출+결과 한 블록. 다만 카드 자체를 `<details>`로 만들어 헤더 한 줄로 접히고, 펼친 상태는 그대로 둔다.
- **큐 UX**: 계획은 "보내기 버튼이 응답 중에도 동작"만 정했다. 구현은 일시정지 상태까지 화면에 표시하고 `다시 시작` 버튼을 둔다.

## 미검증 / 남은 것

- **재시작 후 큐 복원**(`resumePending`)은 코드·테스트 서비스에는 있으나, 실제 프로세스 재시작 시나리오로 라이브 검증하지 않았다.
- **긴 tool 결과(>20,000자) 잘림**은 단위 테스트로만 확인했고 라이브 화면에서는 재현하지 않았다(현 mock이 작은 결과만 준다).
- **`prefers-reduced-motion`**의 정지 문자는 단위 테스트로만 확인(`spinnerText(…, true) === "⠿"`), emulated media로 화면 검증하지 않았다.
- 라이브 서버(digithive.chanoil.com)에는 아직 배포되지 않았다: 이 커밋은 push 후 CI/CD를 거친다.
- 기존 실패가 아니라 이번 변경 밖의 관찰: page가 `favicon.ico` 404를 남긴다(영향 없음).

## 증거 위치

`.omo/evidence/chat-usability/` (git 추적 제외, 저장소의 `.omo/evidence` ignore 규칙에 따름): `chat-desktop.png`, `chat-waiting-queue.png`, `markdown-and-tool-collapsed.png`, `tool-pretty.png`, `routes-tabs.png`, `work-nolist.png`, `chat-mobile.png`, `chat-mobile-list.png`, `routes.txt`, `oauth.txt`.

브라우저는 저장소 밖에 이미 설치되어 있던 `playwright` 1.60 + Chromium 1223으로 실제 페이지를 구동해 캡처했다.
