# 워크플로 개편 — 구현과 검증 기록 (2026-11-25)

계획: `.omo/plans/digithive-workflows.md` (D1~D14). 사용자 정정: `workflow_run`은 즉시 실행이
기본이고, 지연 실행은 스케줄의 영역이며, 비동기 옵션은 선택 사항이다.

## 1. 데이터 모델 (마이그레이션 v10)

| 테이블 | 책임 | 핵심 컬럼 |
| --- | --- | --- |
| `workflows` | 재사용 정의 | title, instruction, executor_json, params_json, timeout_seconds |
| `schedules` | 자동 실행 바인딩 | workflow_id(FK RESTRICT), trigger_json, enabled, args_json, next_run_at |
| `runs` | 실행의 유일한 상태 | + workflow_id, workflow_title, schedule_id, trigger_kind, params_json |
| `schedule_occurrences` | 발화 슬롯의 동일성 | schedule_id, scheduled_for, run_id, manual |

- 기존 `schedules` 행은 `wf-<기존 id>` 정의로 옮겨지고, 같은 id의 바인딩이 남는다.
- `schedules`는 DROP하지 않고 제자리에서 컬럼을 바꾼다: `schedule_occurrences`의 외래키가
  걸려 있고, 마이그레이션은 트랜잭션 안이라 `PRAGMA foreign_keys`를 끌 수 없다.
- `workflow_id`는 `ADD COLUMN`으로 NOT NULL을 걸 수 없어 트리거
  (`schedule_workflow_required`)로 쓰기 시점에 강제한다.
- 실행 기록의 `workflow_title`은 정의가 지워져도 남는 스냅샷이다.

## 2. 파라미터

- 선언: `{ name, type: string|number|boolean|json, required, default, description }`, 최대 16개.
- 해석: `unknown_param:<name>` / `invalid_param:<name>` / `missing_param:<name>`.
- 세 시점 검증: 바인딩 저장, 정의 수정(`schedule_args_invalid` + 깨지는 스케줄 목록, `force`면
  통과 값만 유지), 실행 생성(행을 만들기 전).
- 전달: 에이전트=시스템 프롬프트의 `## Workflow parameters` 블록, 스크립트=`DIGITHIVE_PARAMS`,
  모든 실행=`runs.params_json` 스냅샷.

## 3. 즉시 실행

- `workflow_run(id, args?, async?)` — 기본은 호출 안에서 끝까지 실행하고 결과
  (`runId`, `status`, `durationMs`, `result`)를 돌려준다.
- 인라인 실행은 **새 워커 슬롯을 잡지 않는다**(부모-자식 슬롯 교착 없음). 예산은
  `min(정의 timeoutSeconds, 호출자 남은 예산)`, 중첩 깊이 3, 승인이 필요한 도구는
  `inline` 프로파일로 거부(승인자 부재)된다.
- `workflow_run`은 `selfDeadline` 도구로 표시되어 두 표면(대화·작업)의 30초 도구 타이머를 우회한다.
- `async: true`는 워커 큐에 적재하고 `runId`만 돌려준다. 지연 실행의 기본 주체는 스케줄이다.
- 별도 상태 도구는 없다: `workflow_detail(id, ["runs"])`가 최근 실행 10건의 상태·파라미터·결과를 준다.

## 4. 스크립트 SDK

- 워커가 `127.0.0.1:0`에 브리지를 열고 실행마다 토큰을 발급한다(TTL=실행 제한 시간, settle 시 폐기).
- `scriptsRoot/.digithive/sdk.ts`를 부팅 시 생성(내용이 같으면 다시 쓰지 않음).
- capability 그룹만 노출하고, `external_action`은 항상 거부한다.
- 프로세스 밖에서는 토큰이 없어 SDK 호출이 즉시 실패한다.
- 문서: `docs/workflow-sdk.md`, 예제: `scripts/jobs/example-workflow.ts`.

## 5. 검증 결과

| 검사 | 결과 |
| --- | --- |
| `bun test` | 241 pass / 0 fail (36 files) |
| `bunx oxlint --type-aware src tests scripts` | 0 error |
| `bun run typecheck` (서버) | 0 error |
| 마이그레이션 v9→v10 | `tests/workflow-migration.test.ts` 3 pass, FTS·트리거·FK 가드 포함 |
| 스냅샷 검사 스크립트 | `scripts/qa-workflow-migration.ts` (mismatch=0일 때 exit 0) |
| SDK 실제 자식 프로세스 | `tests/workflow-sdk.test.ts` — 자식이 브리지로 `memory_recall` 호출 |
| 인라인 예산/취소 | `tests/workflows.test.ts` — 60ms 예산에서 `interrupted` |

## 6. 남은 위험과 대응

- **v10은 되돌릴 수 없다**: 구 이미지는 `schedules.title`/`executor_json`을 찾다 실패한다.
  롤백 = 배포 전 `VACUUM INTO` 스냅샷 복원 + 이전 이미지 태그 배포.
- **동시 배포**: 서버와 웹이 같은 커밋으로 배포되어야 한다(구 웹은 옛 `/api/schedules` 계약을 부른다).
  그래서 서버 커밋은 웹 커밋과 함께 push한다.
- **스크립트 SDK의 표면**: capability를 켜야만 도구가 열리고, 쓰기·실행은 폼에서 명시적으로 켠다.
