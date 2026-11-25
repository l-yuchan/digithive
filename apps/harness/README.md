# digithive harness (신규)

계획: `.omo/plans/digithive-harness-rewrite.md` (W0·W1 구현 상태)

## 실행

```bash
cd apps/harness
bun install
bun run build:web                       # web/dist 생성
bun run mock                            # (선택) 로컬 목 제공자 :8798
PORT=8799 MODEL_BASE_URL=http://127.0.0.1:8798/v1 MODEL_NAME=mock-model bun run start
```

환경 변수: `PORT`(기본 8799), `HARNESS_DB`(기본 `apps/harness/data/harness.db`), `MODEL_BASE_URL`, `MODEL_API_KEY`, `MODEL_NAME`.

## 모델 공급자 라우팅

한 대화(또는 한 실행)는 가능한 한 하나의 공급자에 머문다. 한 공급자가 실패하면
사유에 따라 다르게 처리한다.

| 실패                                                             | 처리                                                                  |
| ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| 일시 오류(429 rate limit, 5xx, 시간 초과, 연결 끊김)             | 같은 공급자에서 `MODEL_RETRIES`회 재시도 후 이번 호출만 다음 공급자   |
| 사용량/쿼터 소진(402, `usage limit reached`), 인증 만료(401/403) | 즉시 다음 공급자로 넘기고 그 공급자를 `MODEL_COOLDOWN_MS` 동안 제외   |
| 이미 응답이 스트리밍된 뒤 실패                                   | 재시도·전환 없이 실패로 기록(부분 응답을 다른 공급자로 반복하지 않음) |
| 모든 공급자 실패/대기                                            | 빈 문자열이 아니라 사유가 담긴 오류                                   |

대체 공급자는 `MODEL_FALLBACKS_JSON`(우선순위 순 배열)으로 지정한다. 잘못된
JSON은 시작 시 오류로 멈춘다(조용히 버리지 않음).

```bash
MODEL_FALLBACKS_JSON='[{"name":"backup","baseUrl":"https://api.example/v1","apiKey":"...","model":"..."}]' \
MODEL_COOLDOWN_MS=900000 MODEL_RETRIES=1 bun run start
```

라우팅 결정(재시도·전환·전체 소진)은 대화의 응답 근처와 실행 로그(`provider.retry`,
`provider.fallback`, `provider.exhausted` 이벤트)에 공급자명, 사유, 업스트림 응답 본문과
함께 남는다. HTTP 200으로 오는 오류 봉투와 내용 없는 스트림도 실패로 처리한다.
`bun scripts/qa-providers.ts`는 quota 공급자와 정상 공급자를 로컬에 띄워 이 경로를
무료로 재현한다.

## 검증

```bash
bun run verify
bun run fmt:check
```

`apps/harness`에서 실행한다. `verify`는 타입 기반 lint, TypeScript 검사,
웹 빌드, 전체 테스트를 순서대로 실행한다. `fmt:check`는 파일을 수정하지 않고
포맷만 확인하며, `bun run fmt`는 포맷을 적용한다. 개별 검사는 `lint`,
`typecheck`, `build:web`, `test`로 실행할 수 있다. 자동 CI나 배포는 연결하지 않는다.

Oxlint 1.95.0, oxlint-tsgolint 7.0.2008, Oxfmt 0.80.0을 lockfile과 함께 고정한다.
correctness/suspicious 규칙과 unsafe 연산, 미처리 Promise, 잘못된 async 사용,
분기 완결성 검사를 오류로 처리하며 경고도 실패시킨다. `void`만 붙여 Promise를
버리는 방식은 허용하지 않는다. 타입 단언으로 외부 JSON을 신뢰하지 않고
경계에서 스키마로 파싱하며, DB 결과는 SQLite 쿼리의 제네릭 계약으로 표현한다.

TypeScript의 enum, namespace, constructor parameter property 등 non-erasable
문법은 허용한다. `erasableSyntaxOnly`는 `false`이며, 해당 문법을 사용하는
테스트도 lint와 타입 검사의 대상이다. 자동 JSX 런타임에 맞춰 React 전역 import를
강제하지 않으며 함수 위치만 바꾸는 스타일 규칙은 사용하지 않는다.
독립 JavaScript 플러그인과 service worker에는 TypeScript 프로젝트의 타입 정보가
없으므로 unsafe 계열 타입 규칙만 제외하고 일반 lint는 적용한다.

포맷은 2칸 들여쓰기, 큰따옴표, 세미콜론, 100자 줄 너비, LF를 사용한다.
생성된 `web/dist`, 의존성, 데이터, 커버리지 출력은 검사에서 제외한다.
규칙 억제에는 사유가 필요하며, 프로덕션 문자열의 em dash도 검사한다.

`tests/`는 저장소·이벤트·상태·정책·모델 프로토콜·동기화·대화 분기와
프로세스 간 실행을 다룬다. 외부 모델 호출 없이 돈다.

## 워크플로와 스케줄 (v10)

정의와 자동 실행을 분리했다.

- **워크플로**: 재사용 가능한 정의. `title`, `instruction`, `executor`(agent/builtin/script),
  `params`(선언된 입력), `timeoutSeconds`. trigger는 없다.
- **스케줄**: 정의 하나를 자동 실행하는 바인딩. `trigger`, `enabled`, `args`(바인딩된 파라미터 값),
  `next_run_at`. 스케줄을 지워도 정의와 실행 기록은 남는다.
- **실행**: `runs` 행이 `workflow_id`·`workflow_title`·`schedule_id`·`trigger_kind`
  (`schedule`/`manual`/`tool`/`script`/`delegation`)·`params_json` 스냅샷을 함께 가진다.

마이그레이션 v11은 builtin executor를 script로 바꾼다(`migrateBuiltinExecutors`).

마이그레이션 v10은 기존 `schedules` 행을 `wf-<id>` 정의 + 바인딩으로 옮긴다. `schedules` 테이블은
`schedule_occurrences`의 외래키 때문에 DROP하지 않고 제자리에서 컬럼을 바꾼다.

두 가지 실행 방식만 있다: 에이전트와 스크립트. `연결 자료 수집`(`jobs/collection.ts`)과
`브리핑 생성`(`jobs/briefing.ts`)은 앱이 실어 보내는 **스크립트 작업**이며, 다른 스크립트와
실행 방식이 같다 — 경로만 앱이 설치하는 `jobs/` 아래라는 점이 다르다. 설치(매 시작 시 갱신)와
`kind:"builtin"` 정의의 전환은 `src/jobs/install.ts`·`src/store/job-migration.ts`가 맡는다.
수집은 저장된 소스 목록을 쓰지 않고 실행 시점에 계정의 켜진 소스(`account.read`)만 읽는다.

`HARNESS_SCRIPTS_ROOT`는 스크립트를 해석하는 루트이자 작업 공간의 루트다. 운영 이미지는
`/app/jobs`를 쓴다.

도구(대화·작업 공용): `workflow_list`(keyword/regex/bm25 중 하나) · `workflow_detail`(섹션 선택) ·
`workflow_create` · `workflow_edit` · `workflow_delete` · `workflow_run`(기본 동기 즉시 실행,
`async:true`면 큐 적재) · `schedule_list/detail/create/edit/delete`.

스크립트 SDK: [docs/workflow-sdk.md](../../docs/workflow-sdk.md), 예제
`scripts/jobs/example-workflow.ts`.

## 현재 범위 (W0·W1)

- 세션·엔트리·part·run·tool_call·approval·event 스키마와 마이그레이션
- 전역 seq 이벤트 로그, 커서 재생, 라이브 SSE(+15초 ping), 스냅샷 프레임
- run 상태 기계, 리스 만료 정산, 취소 의도 기록
- 정책 단일 판정 지점(allow/ask/deny, 저장 승인이 deny를 이길 수 없음)
- OpenAI 호환 스트리밍 어댑터(오류 분류, 잘림=실패)
- 대화 턴: 델타 저장·스트리밍, 도구 왕복, 거부=도구 결과, 턴·도구 데드라인
- React 클라이언트: 세션 목록, 스트리밍 렌더, Enter/Shift+Enter, 한글 조합 Enter 무시

W2(대화 관리)·W3(맥락·압축)·W4(작업 계층)·W5(위임)·W6(이전)·W7(절단)은 아직 없다.

## 알려진 한계

- 도구 레지스트리가 비어 있다(승인 게이트·실행 경계는 W4에서 도구와 함께 채운다).
- SSE 재연결은 EventSource 기본 동작(`Last-Event-ID`)에 의존한다. 서버는 스냅샷을 먼저 보내므로 화면 복원은 안전하다.
- 대화 삭제·제목 변경·편집·분기는 W2.

## 배포 (mini, https://digithive.chanoil.com/)

```bash
# 서버에서
cd ~/digithive-harness/deploy
# .env: HARNESS_PASSPHRASE, HARNESS_SESSION_SECRET, MODEL_BASE_URL, MODEL_API_KEY, MODEL_NAME, HARNESS_MODEL_HEADERS
docker compose up -d --build
```

- 두 서비스: `harness`(웹, 4318, caddy_expose) + `harness-worker`(실행 계층).
- Caddy는 `handle /app2*`로 308 리다이렉트 후 `/`를 `harness:4318`으로 프록시한다.
- 인증: `HARNESS_PASSPHRASE`(빈 값이면 로컬 개발용으로 인증 비활성), `HARNESS_SESSION_SECRET`으로 서명한 HttpOnly 쿠키.
- 되돌림: `~/caddy/Caddyfile.bak-*`를 `docker exec -i caddy_proxy sh -c 'cat > /etc/caddy/Caddyfile'`로 복원 후 `caddy reload`. (파일 bind-mount라 sed -i 금지)

## CI/CD (GitHub Actions)

| 워크플로 | 트리거                | 하는 일                                                                                                                               |
| -------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `ci`     | `main` push, PR, 수동 | `apps/harness`에서 `bun install --frozen-lockfile` → lint → typecheck → build:web → test → fmt:check, 그리고 push 없이 `docker build` |
| `cd`     | `main` push, 수동     | `ghcr.io/<owner>/digithive-harness:<sha>`·`:latest` 발행 → mini 러너에서 배포                                                         |

배포 job은 `runs-on: [self-hosted, mini]`에서 돈다(서버가 LAN에 있어
GitHub 호스티드 러너가 직접 닿지 못한다). 순서:

1. `deploy/compose.yml`을 `~/digithive-harness/deploy/compose.yml`로 동기화
2. 현재 이미지를 `deploy/.harness_image`에 기록
3. job 한정 `DOCKER_CONFIG`로 GHCR 로그인 후 `docker compose pull`
4. `docker compose up -d --no-build`
5. `https://digithive.chanoil.com/api/session`이 60초 안에 응답하는지 확인
6. 실패하면 기록해 둔 직전 이미지로 되돌리고 job 실패

러너는 mini의 컨테이너 `digithive-runner`(이름 `mini-digithive`, 라벨 `mini`)로 돈다.
이미지는 `ghcr.io/actions/actions-runner:latest`이고 `--restart unless-stopped`라서
dockerd가 부팅 때 함께 살린다. 러너 파일과 등록 상태는 호스트
`~/runner-container`(컨테이너 `/home/runner`)에 있고, 컨테이너에는 도커 소켓,
호스트 `docker`/compose 플러그인, `~/digithive-harness`가 마운트된다. libicu가
이미지 안에 있어 이전의 `LD_LIBRARY_PATH` 꼼수는 필요 없다. 이전 호스트 설치
`~/actions-runner`와 `~/.config/systemd/user/actions-runner.service` 유닛은
쓰지 않는 채로 남아 있다. 재등록 절차는 `docs/ci-cd.md`에 있다.

- 운영 DB는 볼륨 `deploy_harness-data`(/data). v2 데이터는 `bun scripts/migrate-v2.ts --from <v2.db> --to /data/harness.db`로 옮긴다.

## 연동 환경변수

| 변수                                    | 기본값                                                  | 설명                                                     |
| --------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------- |
| GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET | (없음)                                                  | OAuth 클라이언트. 없으면 `/api/oauth/google/start`가 409 |
| GOOGLE_REDIRECT_URI                     | https://digithive.chanoil.com/api/oauth/google/callback | 동의 후 돌아올 주소                                      |
| CANVAS_URL                              | (없음)                                                  | LMS 베이스 URL (예: https://lxp-canvas.hanyang.ac.kr)    |
| CANVAS_TOKEN                            | (없음)                                                  | Canvas API 토큰                                          |
| VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY    | (없음)                                                  | Web Push VAPID 키. 없으면 전송은 `push_unconfigured`     |
| VAPID_SUBJECT                           | mailto:owner@digithive.local                            | VAPID subject                                            |

- 연결 상태: `GET /api/connections` → { googleConnected, canvasConfigured, pushConfigured, states[] }
- 수동 동기화: `POST /api/connections/sync` → 소스별 {ok,count,cursor,error}
- Google 연결: `GET /api/oauth/google/start`가 돌려준 URL로 1회 동의하면 콜백이 토큰을 암호화 저장하고 즉시 1회 동기화한다.
- 알림: 브라우저에서 구독하면 `POST /api/push/subscribe`로 저장되고, 브리핑 발행 시 전송된다. 점검은 `POST /api/push/test`.
