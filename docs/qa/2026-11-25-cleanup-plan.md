# 코드베이스 청소 계획

2026-11-25. 작성 시점 기준 커밋 `92517c6` + 커밋되지 않은 작업(jobs/ 스크립트화, 대화 이벤트 일급화)이
작업 트리에 있는 상태를 조사했다. **이 문서는 조사와 계획만 담는다. 구현은 승인 후 시작한다.**

## 0. 요약

| # | burden | 규모 | 위험 | 소유자 결정 필요 |
| --- | --- | --- | --- | --- |
| F1 | 살아 있는 백호환 코드: 레거시 `parts` 저장 형식 + `parts` 테이블 | 65/65 라이브 엔트리, 변환기 1개, 빈 테이블 1개 | 중 | 백필 여부 |
| F2 | 커밋된 적 없음: v1 루트 앱(src·tests·public·scripts·루트 Dockerfile·compose·lockfile·node_modules) | 2,766줄 코드 + 44MB | 낮음 | 삭제 승인 |
| F3 | 커밋된 적 없음: `apps/assistant`(v2) 완전 삭제 후 잔존 | 98파일 / 8,725줄 | 낮음 | 삭제 승인 |
| F4 | 마이그레이션 v1~v11에 박힌 과도기 흔적, 결정 주석 | `src/store` 225+줄 중 | 중(마이그레이션은 수정 금지) | 동결 선언 |
| F5 | 도입 후 쓰이지 않은 싱글턴 계정 상수와 3단 폴백 | 3개 상수 + 4곳 | 중(데이터 오배치 위험) | 동결 선언 |
| F6 | 분해 후 남은 죽은 코드·미사용 export·정합성 구멍 | export 23개, 금지 규칙까지 있고 위반 1건 | 낮음~중 | 없음 |
| F7 | 거짓말이 된 문서·주석·배포 파일·shim(`/app2`, 3000포트, W0/W1 상태) | 8개 파일 | 중(운영 사고 유발 가능) | 삭제 승인 |
| F8 | 이전 완료된 일회성 스크립트·QA 스탠드인·테스트 없는 도구 | 9개 파일 | 낮음 | 삭제 승인 |
| F9 | 구조: 같은 개념이 두 곳(`src/jobs` vs `jobs/`, 수집 케이던스 3벌, barrel 3개) | ~400줄 | 중 | 구조 변경 승인 |
| F10 | 저장소 위생: swap 파일(vim 실행 중), QA DB, 계획서 기록 누락 | 소규모 | 낮음 | 오너 직접 |

핵심 발견 2가지:

1. **마이그레이션 코드는 "지나간 과도기"가 아니라 라이브 데이터와 맞물려 있다.** 라이브 DB의 엔트리 65건이
   전부 옛 `parts` 형식으로 저장돼 있고, 이걸 읽는 변환기는 영구히 남는다. 반면 `parts` 테이블은 아무도 쓰지 않는다.
2. **"구조 변경 후 남은 것"은 대부분 git 이력에 없다.** `src/`(v1)와 `apps/assistant`(v2)는 저장소에 그대로
   커밋돼 있고, CI/CD/이미지/Dockerfile 어디서도 쓰지 않는다. 삭제하면 git 이력에만 남는다(되돌릴 수 있음).

## 1. 조사 근거 (재현 명령)

| 확인 | 명령 | 결과 |
| --- | --- | --- |
| 기준선이 초록인지 | `cd apps/harness && bun test` | **260 pass / 0 fail** (39파일, 8.9s) |
| 타입·린트 | `bun run typecheck`, `bun run lint` | exit 0, 경고 0 |
| 파일 도달성 | `Bun.Transpiler.scanImports` 기반 도달성 스캔 | 비테스트 140개 중 137 도달, 미도달 3개(`src/sdk/ticket.ts`는 타입만 쓰여 아님) |
| 미사용 export | 전 파일 식별자 참조 횟수 | 참조 0인 export 23개(부록 A) |
| 라이브 payload 형식 | `docker exec deploy-harness-1 bun …`으로 `entries.payload_json` 집계 | `{events}` 0건, `{parts}` **65건**, 기타 0건 |
| CI/CD 대상 | `.github/workflows/*.yml` | `apps/harness`만 빌드·배포. 루트 앱·`apps/assistant`는 어떤 단계에도 없음 |
| 이벤트 종류 정합 | `EVENT_KINDS` vs 실제 `kind:"…"` 발생 | 선언됐지만 발생 0인 종류 12개, 선언 없이 발생하는 종류 19개 |

## 2. 최우선: 커밋되지 않은 작업을 먼저 확정

청소 전에 지금 작업 트리에 있는 변경을 커밋해야 한다. 그렇지 않으면 청소 diff가 진행 중인 jobs/스크립트화와
뒤섞여 검증도, 되돌림도 불가능해진다.

- 대상: `git status`의 51개 수정 + 10개 untracked(`apps/harness/jobs/`, `src/jobs/install.ts`,
  `src/store/job-migration.ts`, `src/tools/jobs.ts`, `src/workflows/collection.ts`, `tests/jobs.test.ts`,
  `docs/qa/2026-11-25-builtin-as-scripts.md`).
- 제외: `docs/qa/.2026-11-25-repairs.md.swp`(vim이 잡고 있음, F10).
- 게이트: `bun run verify` (lint·typecheck·build:web·test) 초록. 현재 test/lint/typecheck는 확인했고 build:web은 이 커밋에서 확인한다.
- 청소는 이 커밋 **위에서** 작은 커밋으로 쌓는다. 각 단계 끝마다 `bun run verify` 초록 + 라이브 영향 없음 확인.

## 3. 제안 단계

우선순위: **C1 → C2 → C3 → C4 → C5 → C6 → C7 → C8**, F1·F4는 "손대지 않는 대신 못 박는" 트랙(C9)으로 분리.

### C1 — 문서·배포 파일 거짓말 바로잡기 (F7) : 위험 중, 먼저

문서는 코드보다 빠르게 거짓이 되고, 지금 상태의 문서는 **운영 사고를 유발한다**(옛 3000포트 스택을 띄우라고
안내함, 롤백 절차가 실제와 다름).

| 파일 | 문제 | 조치 |
| --- | --- | --- |
| `docs/deploy.md` | v2 드라이버(3000포트, `digithive-data`/`digithive-backups` 볼륨, `DIGITHIVE_PASSPHRASE`)를 배포 절차로 안내. 이 스택은 2026-11-24 삭제됨 | 삭제. 라이브 배포는 `apps/harness/README.md` + `docs/ci-cd.md`가 정본 |
| `apps/harness/README.md` | "현재 범위 (W0·W1)"에 "W2~W7은 아직 없다"고 적음(실제로는 라이브 전체 기능). `/app2` 308 리다이렉트·`~/caddy/Caddyfile.bak-*` 롤백 안내(실제는 CD 이미지 롤백). 연결 상태가 `GET /api/connections`라고 적혀 있으나 코드는 계정 API로 옮겨감 | 상태 절 재작성(현재 기능 요약), 배포·롤백 절은 `docs/ci-cd.md`로 위임, API 목록은 실제 라우트로 교체 |
| `docs/harness-research-plan.md` | 상태: "외부 조사 실행·구현·배포를 승인하거나 완료했다는 뜻이 아니다" — 전부 완료됨 | 상태 헤더를 "완료(결과: `docs/harness-research/`, 구현: `apps/harness`)"로 |
| `docs/memory-file-surfaces.md` | "도구·API·화면이 붙지 않았다"로 시작하나 이후 붙었다 | 상태 머리말 추가 또는 최신 QA 기록으로 대체 |
| `docs/assistant-v2-spec.md` | 삭제된 `apps/assistant`의 명세. 계속"논의 초안" | 아카이브 머리말(`역사 문서, 코드 없음`) 추가. 단, 이 문면을 근거로 삼는 `.omo` 계획과 마이그레이션 스크립트가 있으므로 삭제는 F8과 함께 |
| `web/src/api.ts` | `window.location.pathname.startsWith("/app2")` 프리픽스 shim(병행 운영 시절). 라이브 라우팅에 `/app2` 없음 | `basePath` 상수 제거, `tests/push-diagnostics.test.ts`의 `/app2` 픽스처 정리 |

게이트: `rg '/app2|digithive-data|3000:3000'`가 코드·문서에서 0건. CI `image` job과 CD가 참조하는 파일은 건드리지 않음.

### C2 — v1 루트 앱 제거 (F2) : 위험 낮음

2026-11-22에 새 구현으로 대체 결정, 2026-11-24 v2까지 삭제. 루트 앱은 그 이후 코드 변경 0.

- 삭제 대상(tracked): `src/`(37파일), `tests/`(5파일), `public/`(2파일, `public/app.js`는 gitignore), `scripts/build-ui.ts`,
  `Dockerfile`, `docker-compose.yml`, `Caddyfile.snippet`, `.env.example`, `package.json`, `tsconfig.json`,
  `bun.lock`, `README.md`(v1 안내문), `DESIGN.md`(v1 화면 계약).
- 삭제 대상(untracked, 로컬): 루트 `node_modules/`(44MB, 6패키지), 루트 `data/digithive.sqlite*`(v1 로컬 DB).
- **바꾸기 전에 확인한 것**: `.github/workflows/{ci,cd}.yml`은 `apps/harness`만 본다. `apps/harness/Dockerfile`의
  build context는 `apps/harness`. 루트 `package.json`은 어떤 워크플로에서도 호출되지 않는다.
- 남길 것: 루트는 저장소 루트로 유지되므로 새 `README.md`를 `apps/harness/README.md`를 가리키는 짧은 안내로 대체.
- 제안 위치: 루트 `.gitignore`도 함께 정리(`public/app.js`, `data/`, `backups/` 항목은 v1 전용).
- 되돌림: `git revert <commit>` 한 번. 데이터는 삭제 전 `data/digithive.sqlite`를 백업 폴더로 옮긴다(오너 확인 후).

### C3 — `apps/assistant`(v2) 제거 (F3) : 위험 낮음

- 98파일 / 8,725줄. 2026-11-24 mini에서 컨테이너·볼륨·이미지까지 삭제됨. 코드는 git tag `archive/v2`와
  이력으로 복구 가능. 현재 저장소에서 아무도 import/create/build하지 않음(빌드는 CD가 `apps/harness` 고정).
- 착수 전 손볼 것: `apps/harness/scripts/migrate-v2.ts`가 `apps/assistant`의 DB 스키마 형태를 해석한다.
  이 스크립트 자체가 F8의 "이전 완료된 일회성 도구"이므로 **C8에서 함께** 다룬다. → C3와 C8을 같은 커밋으로 묶는다.
- 같이 고칠 문서: `docs/assistant-v2-spec.md` 상태 머리말(코드 없음 안내), `.omo/plans/digithive-v2.md`는 기록으로 유지.
- 게이트: `git grep -l 'apps/assistant'`가 문서(역사 기록) 외 0건. `bun run verify` 초록. `docker build apps/harness` 초록.

### C4 — 죽은 코드와 미사용 export (F6) : 위험 낮음

부록 A 목록. 각 항목은 "참조 0"으로 확인했다. 삭제 기준:

- **삭제**: `canvasItemsDueSoon`(124줄 부근 export, 캘린더 도움 함수였고 후속 배선 0), `triggerHasFuture`,
  `countBindings`, `bindingArgsProblem`, `listAccountRecords`, `historyMessages`, `isTerminal`, `describeCapabilities`,
  `scheduleToolNames`, `workflowToolNames`, 그리고 같은 참조 0인 타입 별칭(`EventType`, `ExecutorSource`,
  `CancelIntent`, `EventKind`, `BindingViewRow`, `WorkflowParamInput`, `WorkflowDetailSection`, `RunWorkflowInput`,
  `CanvasTodoPayload`, `GmailPayload`, `CalendarEventPayload`, `CanvasAssignmentPayload`, `Db`).
- **유지 후보(근거 확인 후)**: `src/knowledge/citations.ts`는 테스트(`assets.test.ts`)만 쓰고 **런타임 배선이 없다**.
  "모델이 보지 않은 출처 인용은 버린다"는 규칙이 제품 경로에 없다는 뜻이다 — 지우기보다 배선하는 쪽이 맞을 가능성이 크고,
  이는 오너 결정(부록 B Q4).
- **정합성 구멍 1건**: `EVENT_KINDS`의 12개 종류는 "선언만 되고 발생 0". 그중 `budget.threshold`, `tool.progress`,
  `sdk.capability`는 기능이 빠져 있음을 감추고 있다. 반대로 `turn.response.*`·`tool_call.started`·`briefing.stored`
  등 19개는 선언 없이 발생한다(집합 검사가 `workflow-contract.test.ts` 한 곳뿐이라 통과). 조치: 제거한 기능을
  "legacy·readable, never emitted" 절에 **명시적으로 옮기고**, 나머지는 선언에 추가, 전 종류 집합 검사 테스트 1개 추가.
- 게이트: `bun run typecheck`(noUnusedLocals), `bun run lint` 초록, 테스트 260 중 삭제로 깨지는 테스트는 없어야 함.

### C5 — 일회성 스크립트·QA 스탠드인 정리 (F8) : 위험 낮음

| 파일 | 상태 | 제안 |
| --- | --- | --- |
| `scripts/migrate-v2.ts` (240줄) | v2→v3 데이터 이전. 2026-11-24 실행 완료, 기존 변환 결과가 라이브 | 삭제(문서에 "v2 이전 완료" 한 줄 남김) |
| `scripts/qa-make-v2-fixture.ts` (56줄) | 위 스크립트용 v2 모양 fixture. 테스트 없음 | 삭제 |
| `scripts/qa-workflow-migration.ts` (80줄) | v9 스냅샷 1회 검증용. `tests/workflow-migration.test.ts`가 같은 내용을 커버 | 삭제 |
| `scripts/qa-providers.ts` (87줄) | 공급자 폴백 QA용 로컬 서버. `tests/provider-routing.test.ts`·`qa-routing.ts`가 대체 | 삭제 또는 `qa-routing.ts` 한 곳으로 통합 |
| `src/tools/jobs.ts` | 개발 중 도입된 도구 4종(`account_list`·`source_collect`·`briefing_compose`·`push_send`) | **삭제 금지** — `jobs/*.ts` 스크립트가 쓰는 SDK 표면. 테스트(`tests/jobs.test.ts`)로 고정됨 |

게이트: `rg 'qa-make-v2|qa-workflow-migration|qa-providers'`가 README 외 0건, README 라우팅 절 갱신.

### C6 — 구조 정리: 같은 개념이 두 곳 (F9) : 위험 중, 승인 필요

1. **`src/jobs/`와 `jobs/`**: `src/jobs/briefing.ts`(브리핑 조합, 324줄)와 `jobs/briefing.ts`(스크립트) 가 같은 이름으로
   두 계층에 있다. `src/workflows/collection.ts`(계정별 수집 워크플로 보장)와 `jobs/collection.ts`도 같다.
   현재 `src/jobs/install.ts`는 "루트가 앱 루트이면 SDK import를 절대 경로로 바꾼다"는 분기를 갖는다 — 루트 규약이
   두 벌이라는 사실의 증상이다. 제안: **앱 내부 모듈은 `src/jobs/`(엔진), 실행 스크립트는 `jobs/`(배포물)** 로 역할을
   이름에 드러내고, `install.ts`의 조건 분기를 "스크립트가 SDK를 절대 경로로 import" 한 가지로 축소.
2. **수집 케이던스가 3벌**: `COLLECTION_INTERVAL_SECONDS=900`(`workflows/collection.ts`),
   v9 SQL의 `everySeconds 900`(`schedule-migration.ts`), `jobs/collection.ts` 문서. 마이그레이션은 동결이므로
   런타임 쪽 두 곳을 한 상수로 모으고, v9 SQL은 주석으로 출처를 밝힌다.
3. **barrel 3개**(`integrations/accounts.ts`, `integrations/google.ts`, `scheduler/schedules.ts`): 대부분의 import가
   실제 모듈을 직접 가리키는데 일부만 barrel을 거친다. 한 방식으로 통일 — **실제 모듈 직접 import**를 권장
   (`accounts.ts`의 3중 재수출이 "계정 계층이 한 파일"이라는 인상을 준다).

게이트: 리팩터 후 `bun run verify` 초록, `jobs/*.ts`의 실제 실행 테스트(`tests/jobs.test.ts`) 초록, 라이브 없이 로컬 3프로세스 기동 확인.

### C7 — 테스트 부채 (F6/code, 여유 있을 때)

- `tests/accounts.test.ts` 849줄, `schedule-execution.test.ts` 595줄: 추가만 된 흔적. "결함을 잡는 테스트인가"로
  재판정(사용자 선호: 커버리지보다 잡는 결함). 이번 청소에서는 **삭제로 깨지는 테스트 재검토만** 하고, 전면 정리는 별도 라운드.
- `tests/personal-tools-fixture.ts`: export 3개 모두 사용 중 — 손대지 않음.

### C8 — C3+C5와 묶는 데이터 이전 도구 정리

위 표대로 `migrate-v2.ts`·fixture·`qa-workflow-migration.ts`를 삭제하는 커밋에 `apps/assistant` 삭제를 함께 넣는다.
이유: 이 스크립트의 유일한 입력이 v2 DB 모양이고, 남기면 `apps/assistant`가 "아직 쓰일 수 있는 코드"처럼 보인다.

### C9 — "동결 트랙": 건드리지 않는 대신 못 박기 (F1·F4·F5)

이 항목들은 **삭제가 곧 위험**이다. 제안은 삭제가 아니라 "왜 남기는지, 언제까지 남기는지"를 코드와 문서에 못 박는 것.

**F1. 레거시 `parts` 저장 형식**

- 사실: 라이브 엔트리 65/65가 `{parts:[…]}`. 쓰는 코드는 이미 `{events:[…]}`. 읽는 쪽(`parseEntryEvents`)만 변환.
  `parts` 테이블(v1)은 쓰기 0건, 읽기 0건.
- 옵션 = **백필 마이그레이션 v12**로 라이브를 `{events}`로 바꾸고 → 변환기와 `parts` 테이블을 다음 릴리스에서 제거.
- 청소 관점의 손익: 변환기 ~50줄 + 빈 테이블. 백필은 한 번의 데이터 변환이므로, 되돌릴 수 있게 v12 이전에 DB 스냅샷을 먼저 뜬다(기존 manner: `/data/pre-vNN-deploy-YYYY-MM-DD.db`).
- 변환 금지할 것: 도구 호출/결과의 `callId`는 옛 `id` 필드에서 온다. `denied`/`timeout`은 `failed`로 합쳐지며 원 정보 손실 — 백필을 하면 이 손실이 영구화된다. **그래서 백필 시 '정규화하지 않고 옛 parts 그대로 → events로 옮기되 원문 보존 필요 여부'를 먼저 결정**(부록 B Q1).

**F4. 마이그레이션 v1~v11**

- 원칙(`migrations.ts` 주석)대로 **출하된 마이그레이션은 수정하지 않는다**. 라이브 `user_version=10`, 작업 트리에서 11.
- 과도기 흔적: v6이 `'google-default'`/`'기존 Google'`을 심고 v8이 라벨을 바꾸고 v9가 id를 UUID로 바꾼다. 새 DB도
  v6→v9를 거친다. 즐겨찾기처럼 "깨끗한 고정점"을 만들려면 `BASELINE` 스키마 상수를 따로 두고 새 DB는 그것만 적용하는
  방식이 있으나, 라이브와 똑같은 최종 스키마를 두 벌 만들면 드리프트 위험이 더 크다.
- 제안: v1~v11은 **동결**. 파일 머리에 "출하된 과도기 단계이며 수정 금지. 새 DB는 이 단계를 순서대로 재생한다"를 명시.
  결정 주석(`DEFAULT_GOOGLE_ACCOUNT_ID` = "v9가 만든 id")은 F5 결정 후 갱신.
- gate: `tests/account-migration.test.ts`(289줄)가 v6→v11 재생을 검증하고 있는지 확인 — 있으면 이 테스트가 동결의 보증이 된다.

**F5. 싱글턴 계정 상수와 3단 폴백**

- 문제: `DEFAULT_CANVAS_ACCOUNT_ID='canvas-default'`, `DEFAULT_GOOGLE_ACCOUNT_ID=<uuid>`가 **v9가 특정 DB에 부여한 id**로
  하드코딩돼 있고, `resolveAccountId`는 `accountId ?? deps.accountId ?? DEFAULT_GOOGLE_ACCOUNT_ID` 순으로 떨어진다.
  Google 계정이 둘이 된 지금, 기본 id 폴백은 "잘못된 계정에 쓰기"로 이어질 수 있다(캘린더/Gmail·OAuth 콜백·토큰 저장).
- 제거가 이상적이지만: Canvas는 "단일 LMS 신원" 설계상 고정 id가 의도이고, v9 이전 데이터의 소유자 복원에도 쓰인다.
- 제안: 캔버스는 유지 + 주석에 "단일 신원 설계" 명시. Google은 **폴백 제거** = `resolveAccountId`가 `undefined`면
  명시적 오류(`account_required`). 이후 v9 이전 형태로 떨어지는 경로가 0건임을 테스트로 고정. 이 변경은 동작 변경이라
  부록 B Q2 결정 필요.

## 4. 하지 말아야 할 것 (명시)

1. 출하된 마이그레이션(v1~v11) 수정·삭제·재번호. 유일한 예외는 "SQL이 아닌 v11"의 실행 지점 정리(실행 순서 자체는 유지).
2. `src/tools/jobs.ts` — 잡 스크립트의 SDK 표면이며 지금 살아 있는 실행 경로.
3. `parseEntryEvents`의 `parts` 변환 — 라이브 65건이 이 경로다(F1 백필 없이는 삭제 금지).
4. `tests/jobs.test.ts`, `tests/workflow-*.test.ts` — 11월 25일 구조 변경의 회귀 방지.
5. `.github/workflows/`와 `apps/harness/deploy/compose.yml` — 배포 설정 동결.

## 5. 실행 규칙

- 커밋 단위: C1, C2, C3+C8, C4, C5, C6, C7 순. 각 커밋은 **한 종류의 burden만** 건드린다(diff가 클수록 검증이 어려움).
- 검증 게이트(각 커밋): `cd apps/harness && bun run verify` 0 / 0 / build 성공 / 260+ pass. 배포 트리에 닿는 단계(C1·C2·C3)는 `docker build apps/harness`까지.
- 라이브 확인이 필요한 단계(F1 백필)는 CD 전에 DB 스냅샷 → `VACUUM INTO` 후 `integrity_check` + `user_version` 확인
  (2026-11-25 v10 배포 때 쓴 절차 그대로).
- 병렬화: C2·C3은 git 조작만이라 병렬 불필요. C4·C5는 코드·스크립트로 분리 가능. C6은 구조 변경이라 단독.
- "커밋 메시지 형식" 등 사소한 규약은 프로토타입 단계에서 무시(기존 합의).

## 6. 부록

### A. 미사용 export (참조 0)

`src/core/contracts.ts` EventType · `src/core/executor.ts` ExecutorSource · `src/core/run-state.ts` CancelIntent, isTerminal ·
`src/core/sessions.ts` historyMessages · `src/events/log.ts` EventKind · `src/integrations/account-store.ts` listAccountRecords ·
`src/integrations/canvas.ts` CanvasTodoPayload, canvasItemsDueSoon · `src/integrations/normalize.ts` GmailPayload,
CalendarEventPayload, CanvasAssignmentPayload · `src/scheduler/schedule-store.ts` countBindings · `src/scheduler/schedule-types.ts`
BindingViewRow · `src/scheduler/triggers.ts` triggerHasFuture · `src/sdk/capabilities.ts` describeCapabilities ·
`src/store/db.ts` Db · `src/tools/schedules.ts` scheduleToolNames · `src/tools/workflows.ts` workflowToolNames ·
`src/workflows/workflow-params.ts` bindingArgsProblem · `src/workflows/workflow-types.ts` WorkflowParamInput,
WorkflowDetailSection, RunWorkflowInput

참고: `src/sdk/ticket.ts`는 import가 0이지만 **타입만** 쓰이므로 코드가 아니다(삭제 금지).

### B. 오너 결정 필요

| Q | 질문 | 권장 |
| --- | --- | --- |
| Q1 | F1: 레거시 `parts` 65건을 events로 **백필**할지, 변환기를 영구히 둘지 | 백필. 변환기가 "영구 호환 계층"이 되는 순간 또 하나의 부채가 됨. 단 `denied/timeout` 정보 보존 방식을 먼저 정함 |
| Q2 | F5: `DEFAULT_GOOGLE_ACCOUNT_ID` 폴백을 제거(미지정 시 오류)할지 | 제거. 다중 계정에서 "기본 계정"은 사고의 씨앗 |
| Q3 | F2/F3: v1 루트 앱·`apps/assistant`를 **저장소에서 삭제**할지(git 이력에 남김) | 삭제 |
| Q4 | F6: `citations.ts`(출처 검증 규칙)를 삭제할지, 제품 경로에 **배선**할지 | 배선(대화 응답의 출처 인용 검증) |
| Q5 | F9: `src/jobs` ↔ `jobs/` 역할 명명을 바꿀지 | 바꿈(엔진/배포물 구분을 이름에) |
| Q6 | F10: `docs/qa/.2026-11-25-repairs.md.swp` — vim이 잡고 있음. 저장된 변경이 있는지 확인 후 정리할지 | 오너가 vim에서 스왑 복구 여부를 확인한 뒤 삭제 |

### C. 조사 중 발견한 "청소 대상은 아니지만 알아야 할" 것

- 올해 11월 25일 작업 트리의 `.omo/plans/digithive-workflows.md`가 실제 구현(`f2bf463`·`5c032b9`)과 `docs/qa/2026-11-25-workflows.md`를 반영하지 않은 채다.
- `web/dist/main.js`에 `/app2` 문자열이 빌드 산출물로 남아 있다(C1 후 재빌드로 사라짐).
- `apps/harness/data/`에는 로컬 QA DB(`harness.db`, `qa-workflow-source.db`)가 gitignore 상태로 남아 있다. 삭제 불필요, 로컬 정리만.
- `scripts/jobs/example-workflow.ts`는 SDK 문서용 예제 — 유지.
