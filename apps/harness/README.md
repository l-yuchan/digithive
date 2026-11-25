# digithive harness

브라우저에서 대화하고 작업을 맡기는 개인용 에이전트 하네스. 서버(`src/server`)와 실행 워커(`scripts/worker.ts`)가
같은 SQLite 파일을 열고, 웹 클라이언트(`web/`)는 `web/dist`로 빌드된다. 라이브: https://digithive.chanoil.com/

계획과 배경: `.omo/plans/digithive-harness-rewrite.md`.

## 실행

```bash
cd apps/harness
bun install
bun run build:web                       # web/dist 생성
bun run mock                            # (선택) 로컬 목 제공자 :8798
PORT=8799 MODEL_BASE_URL=http://127.0.0.1:8798/v1 MODEL_NAME=mock-model bun run start
```

환경 변수: `PORT`(기본 8799), `HARNESS_DB`(기본 `apps/harness/data/harness.db`),
`HARNESS_WORKSPACE`, `HARNESS_SCRIPTS_ROOT`(기본은 작업 공간), `MODEL_BASE_URL`, `MODEL_API_KEY`, `MODEL_NAME`.
연동 변수는 아래 표를 본다.

## 스키마와 마이그레이션

이 프로젝트는 프로덕션 상태가 아니며, 규칙은 둘이다(2026-11-25, 소유자 결정).

1. 레거시 DB는 **항상 최신 스키마로 마이그레이션**한다. 데이터도 최신 형태로 정규화한다
   (예: 옛 `parts`로 저장된 엔트리는 `events`로 다시 쓴다).
2. 마이그레이션 코드는 **최대 2회 전이만** 보존한다. v100이면 v98→v99, v99→v100만 가진다.
   스키마가 바뀔 때마다 가장 오래된 전이를 버리고 새 전이를 더한다.

`src/store/migrations.ts`가 그 두 가지를 담는다: `RESET_SCHEMA`(새 DB의 출발점), `TRANSITIONS`(최대 2단계),
`RESET_VERSION`(열 수 있는 가장 오래된 버전). 새 DB는 `RESET_SCHEMA`에서 시작하고, 레거시 DB는 기록된
`user_version` 위의 전이를 순서대로 적용한다. 두 경로는 같은 스키마에 도착하며 `tests/schema-upgrade.test.ts`가
그 같음을 검사한다. 리셋보다 오래된 DB는 반쯤 올리지 않고 `openDatabase`에서 거부한다.

전이는 SQL만으로 표현할 수 없을 때 `run(db)`으로 행 단위 재작성을 가질 수 있고, 같은 트랜잭션 안에서
버전 기록과 함께 커밋된다. 출하된 전이는 수정하지 않고, 다음 전이를 더한다.

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
`tests/provider-routing.test.ts`와 `scripts/qa-routing.ts`의 `providers` 모드가 이 경로를 로컬에서 재현한다.

## 검증

```bash
bun run verify     # lint + typecheck + build:web + test
bun run fmt:check
```

`apps/harness`에서 실행한다. `.github/workflows/ci.yml`이 같은 순서(plus `fmt:check`와 이미지 빌드)를 돌린다.

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

## 워크플로와 스케줄

정의와 자동 실행을 분리했다.

- **워크플로**: 재사용 가능한 정의. `title`, `instruction`, `executor`(`agent`/`script`),
  `params`(선언된 입력), `timeoutSeconds`. trigger는 없다.
- **스케줄**: 정의 하나를 자동 실행하는 바인딩. `trigger`, `enabled`, `args`(바인딩된 파라미터 값),
  `next_run_at`. 스케줄을 지워도 정의와 실행 기록은 남는다.
- **실행**: `runs` 행이 `workflow_id`·`workflow_title`·`schedule_id`·`trigger_kind`
  (`schedule`/`manual`/`tool`/`script`/`delegation`)·`params_json` 스냅샷을 함께 가진다.

### 실행 방식은 둘뿐이다

| 방식     | 실행되는 것              | 특별한 점                       |
| -------- | ------------------------ | ------------------------------- |
| `agent`  | 모델 + 도구              | 없음                            |
| `script` | `scriptsRoot`의 스크립트 | SDK 브리지로만 앱 기능에 닿는다 |

앱이 실어 보내는 작업(`연결 자료 수집` = `jobs/collection.ts`, `브리핑 생성` = `jobs/briefing.ts`)도 같은
`script` 방식이다. `jobs/`는 **제품 파일**이며 서버 코드(`src/`)가 아니다: 컨테이너는 `jobs/`를 `/app/jobs`로
복사하고 `HARNESS_SCRIPTS_ROOT=/app/jobs`로 실행하므로, 스크립트의 `../.digithive/sdk.ts` import가 그대로 SDK를
가리킨다. 그래서 서버는 평소 작업 파일을 설치하지 않고, 개발/테스트처럼 스크립트 루트가 체크아웃의 `jobs/`와
다른 경우에만 원본 그대로 복사한다(`src/jobs/install.ts`). 수집은 저장된 소스 목록을 쓰지 않고 실행 시점에
계정의 켜진 소스(`account.read`)만 읽는다.

스크립트 SDK: [docs/workflow-sdk.md](../../docs/workflow-sdk.md), 예제 `scripts/jobs/example-workflow.ts`.

도구(대화·작업 공용): `workflow_list`(keyword/regex/bm25 중 하나) · `workflow_detail`(섹션 선택) ·
`workflow_create` · `workflow_edit` · `workflow_delete` · `workflow_run`(기본 동기 즉시 실행,
`async:true`면 큐 적재) · `schedule_list/detail/create/edit/delete`.

## 배포 (mini, https://digithive.chanoil.com/)

배포는 GitHub Actions CD가 한다: `main` push → CI → 이미지 발행 → mini 러너에서 배포. 서버에서 손으로 하는
절차는 만들지 않는다. 러너 구성, 롤백(`workflow_dispatch`에 직전 이미지 태그 고정), 볼륨·네트워크는
`docs/ci-cd.md`가 정본이다. 운영 DB는 볼륨 `deploy_harness-data`(`/data/harness.db`)이고, 스키마·데이터
정규화는 위의 마이그레이션 규칙대로 **서버 시작 시 자동**으로 일어난다. 배포 전 DB 스냅샷은
`docker exec`로 `VACUUM INTO '/data/pre-v<NN>-deploy-<date>.db'`를 실행해 남긴다.

## 연동 환경변수

| 변수                                    | 기본값                                                  | 설명                                                     |
| --------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------- |
| GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET | (없음)                                                  | OAuth 클라이언트. 없으면 `/api/oauth/google/start`가 409 |
| GOOGLE_REDIRECT_URI                     | https://digithive.chanoil.com/api/oauth/google/callback | 동의 후 돌아올 주소                                      |
| CANVAS_URL                              | (없음)                                                  | LMS 베이스 URL (예: https://lxp-canvas.hanyang.ac.kr)    |
| CANVAS_TOKEN                            | (없음)                                                  | Canvas API 토큰                                          |
| VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY    | (없음)                                                  | Web Push VAPID 키. 없으면 전송은 `push_unconfigured`     |
| VAPID_SUBJECT                           | mailto:owner@digithive.local                            | VAPID subject                                            |

연결은 화면에서 한다: 사이드바 **연결** 탭에서 Google 동의, 계정별 소스 스위치, 동기화, 알림 구독을 관리한다.
