# 직접 확인한 근거

조회일: 2026-11-22. 실제 개인 계정·모델 유료 호출은 수행하지 않았다.

## 저장소와 로컬 CLI

- `package.json:5-11`: Bun 시작·UI 빌드·typecheck·test·verify 명령.
- `tests/engine/{api,auth,calendar,storage}.test.ts`, `tests/shared/schema.test.ts`: 기존 프로토타입의 회귀 범위. 새 앱과 독립적으로 유지한다.
- `docs/deploy.md:1-40`: 과거 mini PC + Docker + Caddy 구상. 새 서버가 동일하다는 증거는 아니다.
- `canvas version`: `canvas-cli 1.15.8`, commit `417c0edefa4544a7b3971908f1494143f7967e09`, `windows/amd64`. Linux 실행·자격증명 이식성은 검증하지 않았다.
- `canvas assignments list --help`: `--course-id`, `--include`, `--order-by`; 공통 `--limit 0`, `--no-cache`, `-o json`.
- `canvas api --help`: GET의 `--paginate`, `--query`, `--config` 지원. 실제 수집은 읽기 명령만 허용한다. 토큰 표시·admin masquerade는 사용하지 않는다.
- 위 세 명령은 PTY `bash_9`에서 exit 0. 전체 출력은 `bash_output({bash_id:"bash_9",view:"log"})`로 확인했다.

## 공식 API 계약

1. Gmail 동기화: https://developers.google.com/workspace/gmail/api/guides/sync
   - 첫 연결은 full sync, 이후 history 기반 partial sync.
   - 오래된 `startHistoryId`는 404를 반환하므로 full sync 복구가 필요하다.
   - 처리 범위 내 메시지 본문은 한 번 읽고 캐시할 수 있다.
2. Calendar 동기화: https://developers.google.com/workspace/calendar/api/guides/sync
   - `nextSyncToken`은 마지막 페이지에 있다.
   - 증분 조회의 페이지 이동은 같은 query·syncToken을 유지한다.
   - 삭제 항목이 증분 결과에 포함되며, 410은 full resync가 필요하다.
3. Calendar events.list: https://developers.google.com/workspace/calendar/api/v3/reference/events/list
   - syncToken과 timeMin/timeMax/q/orderBy 등은 함께 사용할 수 없다.
   - 날짜 필터는 별도 materialized view에 적용하고 동기화 query fingerprint를 고정한다.
4. Google OAuth 웹 서버: https://developers.google.com/identity/protocols/oauth2/web-server
   - 사용자 부재 중 갱신에는 offline access와 refresh token이 필요하다.
   - redirect URI 일치와 state 검사가 필요하다.
   - 첫 승인 이후 응답에 refresh token이 없을 수 있으므로 기존 값을 빈 값으로 덮어쓰지 않는다.
5. Canvas 페이지 처리: https://developerdocs.instructure.com/services/canvas/basics/file.pagination
   - Link rel=next를 따라야 하며 per_page만으로 전체 수집을 보장할 수 없다.
   - 링크는 opaque로 취급한다. 인증 전송은 지정된 LMS origin으로 제한한다.
6. Push API: https://developer.mozilla.org/en-US/docs/Web/API/Push_API
   - 활성 service worker와 기기별 PushSubscription이 필요하다.
   - 구독 endpoint는 capability URL이므로 비밀값으로 취급한다.
   - pushsubscriptionchange와 기기 상태를 다루며 실제 수신·열람을 서비스 접수와 구분한다.
7. DeepInfra 호환 API: https://deepinfra.com/docs/openai_api
   - OpenAI-compatible Chat Completions, 공급자 base URL, 모델 설정을 지원한다.
   - usage 토큰을 제공하고 tool calling 문서를 별도로 연결한다.
   - 문서 예시 모델명을 가용 모델/현재 단가의 검증으로 사용하지 않는다.
8. Bun SQLite: Context7 `/oven-sh/bun`, 공식 `docs/runtime/sqlite.mdx`
   - https://github.com/oven-sh/bun/blob/main/docs/runtime/sqlite.mdx
   - WAL과 db.transaction(...).immediate 제공. 짧은 동기 트랜잭션 안에서 선점하고 네트워크 await는 밖에서 수행한다.
   - durable writes에는 synchronous FULL을 계획한다. NORMAL의 전원 장애 시 최근 commit 손실 가능성을 확인했다.

## 독립 자문 상태

- `st_01a20438`: architect 제공자 HTTP 402, 실행 실패.
- `st_01a20439`, `st_01a2043a`, `st_01a2043b`: 실질 결과를 받지 못해 부모가 회수·취소. 직접 조사로 대체했고 승인 근거로 사용하지 않는다.
- `st_01a2043f`: plan-consultant 제공자 오류 이후 실질 결과를 받지 못해 취소, inconclusive.
- 위 작업들은 읽기 전용 범위였고 부모에게 생성 파일·프로세스가 보고되지 않았다. 숨은 산출물의 존재를 추정하지 않는다.
- 최종 계획은 별도 독립 plan-reviewer의 결과를 받아야 완료한다.
