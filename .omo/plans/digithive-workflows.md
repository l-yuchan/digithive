# 워크플로 개편 계획 — 이름, 파라미터, 스크립트 SDK, 도구 표면

작성일: 2026-11-25 · 상태: **승인 대기** (구현·배포 시작 전)
기준 커밋: `733c9b4` (main) · 기준 테스트: `bun test` → **217 pass / 0 fail** (31 files, 9.07s)

---

## 0. 전제 결정

### 사용자가 확정한 것

- **D1.** "이름 변경: 스케줄이 아닌 워크플로로 이름을 변경하고 싶습니다. … 이에 따라 '스케줄'이라는
  이름은 워크플로의 자동 실행만 떼내어 칭하는 이름이 될 것입니다." → 정의는 **워크플로**, 그 자동
  실행 예약만 **스케줄**이다. 이름표 교체가 아니라 개념 분리다.
- **D2.** "단발성 시행도 강화할 생각" → 자동 실행이 없는 워크플로(정의만 존재)가 정상 상태이고,
  지금 실행이 1급 동작이다. `enabled`·`trigger`는 워크플로의 속성이 아니다.
- **D3.** "전용 SDK를 제공하여 에이전트의 tool call처럼 다른 스케줄(이하 워크플로) 조회나
  수정/실행, 기억 조회, 메일함 확인 등을 수행할 수 있게" → 스크립트가 내부 도구 표면에 접근한다.
- **D4.** "워크플로는 … 파라미터를 수신할 수 있도록" → 정의가 입력을 선언하고, 호출자가 값을 준다.
- **D5.** 도구 표면: `workflow_list(keyword?, regex?, bm25?)`, `workflow_detail(id, filter?)`,
  `workflow_edit(id, delta)`, `workflow_create`, `workflow_delete`, `workflow_run(id, ...args)`,
  그리고 스케줄에도 "유사한 list, detail, edit, create, delete". deferred loading(먼저 검색으로
  id를 얻고 상세를 고른다)이 목적.

### 이 계획이 정한 것 (승인 시 구속력)

- **D6. 데이터 모델은 넷으로 분리한다.** `workflows`(정의) / `schedules`(자동 실행 바인딩) /
  `runs`(실행 기록, 정의가 지워져도 남음) / `schedule_occurrences`(슬롯 동일성·중복 방지).
  정의와 실행 기록의 분리는 이미 있는 원칙이고, 여기서 `trigger`가 정의에서 빠져 바인딩으로 내려간다.
- **D7. `workflow_run`은 기본이 동기 즉시 실행이다.** 도구 호출 하나가 정의를 그 자리에서 실행하고
  결과(상태·텍스트·stdout/exit code)를 돌려준다. 오래 걸리는 실행만 호출자가 `async: true`로 큐에
  넘기고 `runId`를 받는다 — 지연 실행의 기본 주체는 스케줄이다. 별도 상태 도구는 두지 않고
  `workflow_detail(id, ["runs"])`가 최근 실행의 상태·결과를 보여준다.
- **D7a. 인라인 실행은 호출자의 슬롯과 예산을 빌린다.** 새 워커 슬롯을 잡지 않으므로(부모가 슬롯을
  쥔 채 자식을 기다리는 교착이 없다) 예산은 `min(워크플로 제한, 호출자 남은 예산)`이고 중첩 깊이는
  3이다. 승인이 필요한 도구(`ask`)는 인라인에서 거부하고 `async: true`나 스케줄 등록을 안내한다.
  `workflow_run`은 스스로 deadline을 관리하는 도구로 표시해 두 표면의 30초 도구 타이머를 우회한다.
- **D8. 파라미터는 문자열 치환이 아니라 실행 계약으로 전달한다.** 에이전트 실행은 시스템 프롬프트의
  `Workflow parameters` 블록, 스크립트 실행은 환경변수, 그리고 **모든 실행은 `runs.params_json`에
  실제 사용값을 스냅샷**한다(나중에 정의·바인딩이 바뀌어도 그 실행이 무엇으로 돌았는지 남는다).
- **D9. 스크립트 SDK는 워커의 127.0.0.1 루프백 브리지다.** 자식 프로세스이므로 모듈을 주입할 수
  없고, 비밀 없는 공개 HTTP도 아니다. 실행마다 새 토큰을 발급해 `DIGITHIVE_SDK_URL/TOKEN`으로 넘기고,
  `scriptsRoot`에 단일 파일 SDK(`.digithive/sdk.ts`)를 생성해 스크립트가 정적 import 한다.
- **D10. 권한은 실행 레코드가 소유한다.** `capabilities`는 script executor 안에 저장한다(워크플로
  행과 실행 행이 같은 값을 본다). 기본값은 읽기 5종(`workflow.read`(스케줄 읽기 포함), `memory.read`,
  `mail.read`, `files.read`), 쓰기·실행 그룹은 폼에서 명시적으로 켜야 한다. 켠 사실은 이벤트로 남는다.
- **D11. 도구 이름 최종안**은 §6이다. `schedule_run`과 `workflow_run_status`는 두지 않는다(수동
  실행은 `workflow_run`/UI 버튼, 상태는 `workflow_detail`의 `runs` 섹션과 실행 기록 화면).
- **D12. UI는 탭 하나다.** 최상위 `워크플로` 탭 안에서 정의·파라미터·바인딩된 스케줄·실행 기록을
  함께 본다. `스케줄` 최상위 탭은 사라진다.
- **D13. 내부 식별자까지 전면 개명한다.** 테이블·모듈·라우트·도구·이벤트 종류·테스트 이름.
  구 API/도구 별칭은 두지 않는다(단일 사용자, 서버와 웹이 같은 커밋으로 배포된다).
  DB에 이미 기록된 옛 이벤트 종류는 읽기 위해 `EVENT_KINDS`에 남긴다.
- **D14. 비목표:** 워크플로 그래프 편집기, 정의 버전관리/롤백, 다중 사용자 권한, builtin 실행기
  파라미터 확장, 워크플로 간 체인 오케스트레이션 화면, 대화 표면 개명(`작업` 탭 이름 유지).

---

## 1. 구조와 의존 방향

```
store (migrations, db)  ←  workflows (정의·파라미터·검색·호출)  ←  scheduler (바인딩·발화)
        ↑                          ↑                                  ↑
     core/executor ────────────────┴──────────────┬───────────────────┘
                                                  ↓
                                   surfaces/work (lease, settle, script, agent)
                                                  ↑
                                sdk (브리지) ──────┘   tools (도구 표면)
                                                  ↑
                                runtime ← server (routes) ← web
```

| 소유자 | 책임 | 소유 데이터 |
| --- | --- | --- |
| `workflows` | 재사용 가능한 정의 | title, instruction, executor, params, timeout |
| `schedules` | 정의를 자동 실행하는 예약 | workflow_id, trigger, enabled, args, next_run_at |
| `runs` | 실제 실행의 유일한 상태 | 상태, lease, trigger_kind, params 스냅샷, 결과 |
| `schedule_occurrences` | 발화한 슬롯의 동일성 | schedule_id, scheduled_for, run_id |
| `sdk` | 실행 중 스크립트의 내부 접근 창구 | 토큰·capability·만료 |

의존 규칙: `scheduler`는 `workflows`를 읽을 수 있지만 그 반대는 없다. `workflows`는 `runs`에
의존하지 않고 `surfaces/work`의 `enqueueRun`만 호출한다.

---

## 2. 데이터 모델과 마이그레이션 v10

출시된 v1~v9는 수정하지 않는다. `src/store/workflow-migration.ts`에 v10을 추가한다.

```sql
CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  instruction TEXT NOT NULL,
  executor_json TEXT NOT NULL CHECK(json_valid(executor_json)),
  params_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(params_json)),
  timeout_seconds INTEGER NOT NULL DEFAULT 1800 CHECK(timeout_seconds BETWEEN 1 AND 86400),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE workflows_fts USING fts5(workflow_id UNINDEXED, text, tokenize = 'trigram');

-- 1) 정의 이동: id는 'wf-' || 기존 스케줄 id (결정적, 재실행 안전)
INSERT INTO workflows (id,title,instruction,executor_json,params_json,timeout_seconds,created_at,updated_at)
SELECT 'wf-'||id, title, instruction, executor_json, '[]', timeout_seconds, created_at, updated_at FROM schedules;
INSERT INTO workflows_fts (workflow_id, text)
SELECT id, title||' '||instruction FROM workflows;

-- 2) 바인딩: FK가 걸린 schedules는 DROP할 수 없다(occurrences가 스케줄을 참조하고,
--    마이그레이션은 트랜잭션 안이라 PRAGMA foreign_keys를 끌 수도 없다). 제자리 확장.
ALTER TABLE schedules ADD COLUMN workflow_id TEXT REFERENCES workflows(id) ON DELETE RESTRICT;
ALTER TABLE schedules ADD COLUMN args_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(args_json));
UPDATE schedules SET workflow_id = 'wf-'||id;
ALTER TABLE schedules DROP COLUMN title;
ALTER TABLE schedules DROP COLUMN instruction;
ALTER TABLE schedules DROP COLUMN executor_json;
ALTER TABLE schedules DROP COLUMN timeout_seconds;
CREATE INDEX schedules_workflow ON schedules(workflow_id);
-- ADD COLUMN으로는 NOT NULL을 걸을 수 없으므로 쓰기 시점에 강제한다.
CREATE TRIGGER schedules_require_workflow_insert BEFORE INSERT ON schedules
WHEN NEW.workflow_id IS NULL BEGIN SELECT RAISE(ABORT,'schedule_workflow_required'); END;
CREATE TRIGGER schedules_require_workflow_update BEFORE UPDATE OF workflow_id ON schedules
WHEN NEW.workflow_id IS NULL BEGIN SELECT RAISE(ABORT,'schedule_workflow_required'); END;

-- 3) 실행 기록에 정의·바인딩·트리거·파라미터 스냅샷
ALTER TABLE runs ADD COLUMN workflow_id TEXT;
ALTER TABLE runs ADD COLUMN workflow_title TEXT;
ALTER TABLE runs ADD COLUMN schedule_id TEXT;
ALTER TABLE runs ADD COLUMN trigger_kind TEXT CHECK(trigger_kind IN ('schedule','manual','tool','script','delegation'));
ALTER TABLE runs ADD COLUMN params_json TEXT NOT NULL DEFAULT '{}';

UPDATE runs SET
  schedule_id = (SELECT o.schedule_id FROM schedule_occurrences o WHERE o.run_id = runs.id),
  trigger_kind = COALESCE((SELECT CASE o.manual WHEN 1 THEN 'manual' ELSE 'schedule' END
                             FROM schedule_occurrences o WHERE o.run_id = runs.id),
                          CASE runs.origin WHEN 'delegation' THEN 'delegation' ELSE 'manual' END),
  workflow_id = (SELECT s.workflow_id FROM schedule_occurrences o JOIN schedules s ON s.id = o.schedule_id
                  WHERE o.run_id = runs.id),
  workflow_title = COALESCE((SELECT s.title FROM schedule_occurrences o JOIN workflows s ON s.id = o.schedule_id
                               WHERE o.run_id = runs.id),
                            (SELECT o.schedule_title FROM schedule_occurrences o WHERE o.run_id = runs.id));
```

`schedule_occurrences`는 그대로 둔다(슬롯 UNIQUE는 발화 중복을 막는 장치이고, 지금도 옳다).
`runs.workflow_id`는 FK를 걸지 않는다: 정의를 지워도 기록은 남아야 한다. `trigger_kind`는
`schedule`(자동 발화) / `manual`(화면·대화에서 지금 실행) / `tool`(에이전트의 `workflow_run`)
/ `script`(SDK의 `workflow_run`) / `delegation`(기존 위임 실행) 다섯 가지다.
`schedules.workflow_id`는 FK RESTRICT라 정의를 지우려면 바인딩을 같은 트랜잭션에서 먼저 지워야 한다
(도구·API의 409 `schedules_present`가 이 제약을 사용자에게 설명하는 창구다).

**계정 수집의 의미 보존.** `collect-<accountId>` 스케줄은 그대로 v10을 통과하며 정의
`wf-collect-<accountId>`가 생긴다. `ensureCollectionSchedule`은
`ensureCollectionWorkflow`(정의 + 900초 바인딩을 같은 트랜잭션에서)로 대체한다.

---

## 3. 파라미터 계약

```ts
WorkflowParam = {
  name: string;        // /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/, 최대 16개, 중복 불가
  type: "string" | "number" | "boolean" | "json";
  required?: boolean;  // 기본 false
  default?: unknown;   // type과 일치해야 함
  description?: string; // ≤200자
}
```

- 해석 `resolveParams(declared, provided)`: 미선언 키 → `unknown_param:<name>`,
  타입 불일치 → `invalid_param:<name>`, 필수인데 값·기본값 없음 → `missing_param:<name>`.
  결과는 `{ values, errors[] }`. 하나라도 오류면 실행을 만들지 않는다.
- 값 제약: string ≤4000자, number는 유한, json은 8KB 이하 직렬화.
- **바인딩 저장 시 검증**: 스케줄의 `args`는 그 워크플로의 선언에 대해 즉시 검증한다(자동 실행이
  매번 실패하는 상태를 저장하지 않는다).
- **정의 수정 시 검증**: `params`가 바뀌어 기존 바인딩의 `args`가 무효가 되면 `workflow_edit`는
  거부하고 어떤 스케줄이 왜 깨지는지(`schedule_args_invalid` + 제목 목록) 돌려준다. 강제 적용은
  `force: true`일 때만, 그 경우 해당 바인딩의 args를 재검증해 통과분만 유지한다.
- 전달: 에이전트=시스템 계약 블록 `## Workflow parameters`(JSON), 스크립트=`DIGITHIVE_PARAMS`
  환경변수(JSON) + `DIGITHIVE_PARAM_<NAME>`, builtin=이번 범위에서 파라미터 없음(정의에 선언하면 저장 거부).

---

## 4. 스크립트 SDK 계약

- **전송**: 워커 프로세스가 `127.0.0.1:0`에 HTTP 서버를 열고 실제 포트를 실행 환경에 주입한다.
  서버는 부팅 시 1회, 실행 종료·프로세스 종료 시 토큰을 폐기한다.
- **인증**: 실행마다 `crypto.randomUUID()` 토큰. `Authorization: Bearer <token>`; 토큰 → `{runId, capabilities, expiresAt}`.
  `expiresAt` = 실행 deadline + 5초. 다른 실행의 토큰으로 자기 실행 문맥을 얻을 수 없다.
- **엔드포인트**
  - `GET /sdk/tools` → 허용된 도구 이름·설명·파라미터 스키마(권한 범위로 필터)
  - `POST /sdk/call` `{ name, args }` → `{ ok: true, result: string }` | `{ ok: false, error, detail? }`
  - `GET /sdk/context` → `{ runId, workflowId, workflowTitle, params, deadline }`
- **권한 그룹 → 도구**

  | capability | 허용 도구 |
  | --- | --- |
  | `workflow.read` | workflow_list, workflow_detail, schedule_list, schedule_detail |
  | `workflow.write` | workflow_create, workflow_edit, workflow_delete |
  | `workflow.run` | workflow_run |
  | `schedule.write` | schedule_create, schedule_edit, schedule_delete |
  | `memory.read` | memory_recall |
  | `memory.write` | memory_note, memory_correct |
  | `mail.read` | gmail_search, personal_data_search |
  | `files.read` | stored_file_list, stored_file_read |

  `workspace_*`는 실행 작업공간이 이미 주어진 것이라 SDK로 열지 않는다. `external_action`은 승인자가
  없으므로 스크립트에서 항상 거부한다(정책 `ask` → `script_approval_unavailable`).
- **재귀·폭주 방지**: `workflow_run`은 부모 체인(`parent_run_id`) 깊이가 3 이상이면
  `workflow_depth_exceeded`로 거부한다. 스크립트의 SDK 호출은 동기이며, 브리지는 자식 실행이
  끝날 때까지 응답을 미룬다(자식은 부모의 예산·깊이 안에서 산다). 긴 작업은 `async: true`로 넘긴다.
- **배포물**: 부팅 시 `scriptsRoot/.digithive/sdk.ts`를 생성(의존성 없는 단일 파일), 예제
  `scripts/jobs/example-workflow.ts`. 스크립트는 `import { sdk } from "../.digithive/sdk.ts"`.
  타입은 `DIGITHIVE_SDK_PATH`가 아니라 생성 파일 경로로 고정한다(정적 import여야 Bun이 해석한다).
- **실패 가시성**: 브리지 거부·도구 오류는 `stderr`가 아니라 도구 결과 JSON으로 돌려주고, 스크립트가
  그대로 출력하면 실행 기록의 stdout에 남는다. 브리지 자체 오류(토큰 만료 등)는 실행 실패 사유가 된다.

---

## 5. HTTP 표면

| 메서드·경로 | 동작 |
| --- | --- |
| `GET /api/workflows?keyword=&regex=&bm25=` | 목록(요약 + 스케줄 수 + 마지막 실행) |
| `POST /api/workflows` | 정의 생성 |
| `GET /api/workflows/:id` | 정의 + 파라미터 + 바인딩 + 최근 실행 5건 |
| `PATCH /api/workflows/:id` | 부분 수정(파라미터 무효화 검증 포함) |
| `DELETE /api/workflows/:id?cascade=1` | 바인딩이 있으면 409 `schedules_present`, cascade면 함께 삭제 |
| `POST /api/workflows/:id/run` `{ args }` | 워커 큐에 넣고 run 반환(HTTP 요청은 끝까지 기다리지 않는다). 도구의 동기 실행은 도구 표면 전용 |
| `GET /api/runs/:id` | (기존) 실행 상태·결과 |
| `GET /api/schedules?workflowId=` | 바인딩 목록 |
| `POST /api/schedules` | 바인딩 생성 |
| `GET/PATCH/DELETE /api/schedules/:id` | 상세·수정·삭제 |
| `POST /api/schedules/:id/run` `{ args? }` | 이 바인딩의 정의를 지금 실행(바인딩 args 기본값) |

기존 `/api/schedules`의 정의 CRUD 의미는 사라진다. 웹 번들은 빌드 id로 자동 재적재되므로
(2026-11-25 수리) 낡은 탭이 새 API를 반쪽으로 부르는 상태는 남지 않는다.

---

## 6. 도구 표면 (대화 + 작업 실행 공용)

```
workflow_list({ keyword?, regex?, bm25?, limit? = 20 })
  → { workflows: [{ id, title, executorKind, paramCount, schedules:{count,enabled,nextRunAt},
                    lastRun:{status,settledAt}|null, updatedAt, score? }] }
  검색은 셋 중 하나만 허용. keyword = 모든 단어가 title||instruction에 포함(대소문자 무시),
  regex = JS 정규식, bm25 = workflows_fts MATCH(trigram, 3자 이상 필요 — 2자 이하는 오류로 안내).
workflow_detail({ id, filter? = ["definition","params","executor","schedules"] })
  filter ⊂ definition|params|executor|schedules|runs|caps ; runs는 최근 5건(요청 시)
workflow_create({ title, instruction, executor, params?, timeoutSeconds? })
workflow_edit({ id, delta })      // delta = { title?, instruction?, executor?, params?, timeoutSeconds? }
workflow_delete({ id, cascade? })
workflow_run({ id, args?, async? = false })
  // 기본: 그 자리에서 자식 실행을 만들고 끝까지 돌린 뒤
  //   { runId, status, durationMs, result:{ text?, stdout?, stderr?, exitCode?, error? } }
  // async:true: 워커 큐에 넣고 { runId, status:'queued' } 만 반환
  // 예산: min(정의 timeoutSeconds, 호출자 남은 예산), 깊이 3, ask 도구는 거부
workflow_detail({ id, filter } → ["runs"])  // 최근 실행 10건: 상태·trigger·params·결과(≤2000자)
schedule_list({ workflowId? })
schedule_detail({ id })           // 바인딩 + 최근 실행 5건
schedule_create({ workflowId, trigger, enabled?, args? })
schedule_edit({ id, delta })      // delta = { trigger?, enabled?, args? }
schedule_delete({ id })
```

- 정책 action: read 도구는 `read`, 정의·바인딩 변경과 `workflow_run`은 `edit`
  (외부 효과가 아니라 큐 적재이고, 작업 실행 정책에서 `run`이라는 action은 없다).
- `schedules_list`/`schedules_edit`는 삭제한다(D13).
- 도구 스펙 합계가 늘어나므로 `workflow_list`는 요약만, `workflow_detail`은 섹션 선택형으로 둔다.
  이것이 사용자가 말한 deferred loading이다.

---

## 7. 이벤트

추가: `workflow.created`, `workflow.updated`, `workflow.deleted`, `workflow.run`,
`schedule.created`, `schedule.updated`, `schedule.deleted`, `schedule.enabled`, `sdk.capability`.
기존 `schedule.created|updated|deleted|run`(v7~v9 기록)은 유니온에 남겨 읽는다.

---

## 8. 화면

`워크플로` 탭 (`data-testid="tab-workflows"`)

1. **목록** — 검색 입력(키워드/정규식/BM25 선택), 각 행: 제목, 실행기 배지(에이전트/내장/스크립트),
   스케줄 수·다음 실행, 마지막 실행 상태. 선택 시 상세.
2. **상세: 정의** — 제목, 실행 지시, 실행기(에이전트/내장/스크립트 + 경로·인자), 제한 시간,
   스크립트일 때 **권한 체크리스트**(읽기 기본 체크, 쓰기/실행은 사용자가 켬)와 SDK 사용 예시 한 줄.
3. **상세: 파라미터** — 행 추가/삭제(이름·타입·필수·기본값·설명), 서버 검증 오류를 그대로 표시.
4. **상세: 스케줄** — 이 정의에 걸린 바인딩 목록: trigger, 사용/일시정지, 다음 실행, 바인딩 args.
   추가/수정/삭제, "지금 실행".
5. **상세: 실행 기록** — trigger 종류·params 스냅샷·상태·결과(stdout/stderr/error)·취소·승인.
6. **지금 실행** — 파라미터 값 입력 다이얼로그(기본값 채움, 필수 미입력 시 비활성), 생성된 runId 표시.
7. 진단은 화면에: 마이그레이션 후 옛 정의가 안 보이면 `GET /api/health`의 `schemaVersion`과
   목록 오류 문장을 그대로 노출한다. 화면에 컨트롤이 없는 기능은 미배달로 취급한다.

---

## 9. 웨이브와 작업

의존 순서: W0(계약·스키마) → W1(코어 ∥ SDK ∥ 웹 골격) → W2(도구·라우트 ∥ 웹 폼 ∥ 문서)
→ W3(웹 캡처·정리) → W4(검증·배포). 각 웨이브는 독립적으로 검증되고 커밋 1개다.

**스키마는 계약과 분리해 A0으로 옮겼다**: v10은 `schedules` 컬럼을 바꾸므로 같은 커밋에서
store·dispatch도 새 모양을 써야 트리가 초록으로 남는다. 계약(W0)만 먼저 머지하고 스키마와 코어는
한 레인에서 함께 움직인다.

| ID | 작업 | 주 파일 | 검증 명령 | PASS 관찰값 | 증거 |
| --- | --- | --- | --- | --- | --- |
| W0-1 | 계약·타입 고정(Workflow/Param/Capability/뷰, script executor에 capabilities) | `src/workflows/workflow-types.ts`, `src/core/executor.ts` | `bun test tests/workflow-contract.test.ts` | `pass 0 fail` | `tests/workflow-contract.test.ts` |
| A0 | 마이그레이션 v10(정의 이동·바인딩 재자리 확장·runs 스냅샷·FTS·트리거) | `src/store/workflow-migration.ts`, `src/store/migrations.ts` | `bun test tests/workflow-migration.test.ts` | `pass 0 fail`, `PRAGMA user_version=10` | `tests/workflow-migration.test.ts` |
| A0b | v9 스냅샷 변환 검사 스크립트 | `scripts/qa-workflow-migration.ts` | `bun scripts/qa-workflow-migration.ts --db data/qa/v9-snapshot.db` | `user_version=10 mismatch=0` + `workflows 수 = 변환 전 schedules 수` | `.omo/evidence/workflows/migration-check.txt` |
| W0-2 | 이벤트 종류 확장 + 레거시 유지 | `src/events/log.ts` | `bun test tests/events.test.ts` | `pass 0 fail` | `.omo/evidence/workflows/events.txt` |
| A1 | workflow store CRUD + 실행 스냅샷 + 삭제 가드 | `src/workflows/workflow-store.ts` | `bun test tests/workflows.test.ts` | `pass 0 fail` (생성/수정/삭제/409) | `tests/workflows.test.ts` |
| A2 | 검색 3모드(keyword/regex/bm25) | `src/workflows/workflow-search.ts` | `bun test tests/workflows.test.ts -t search` | `3 pass`, 한글 trigram 매치 1건 이상 | `tests/workflows.test.ts` |
| A3 | 파라미터 해석·검증 | `src/workflows/workflow-params.ts` | `bun test tests/workflow-params.test.ts` | `unknown_param/invalid_param/missing_param` 3케이스 통과 | `tests/workflow-params.test.ts` |
| A4 | 즉시 실행 경로(동기 인라인 + `async` 큐 분기, trigger_kind·params 스냅샷·깊이 3) | `src/workflows/workflow-run.ts` | `bun test tests/workflow-run.test.ts` | 동기 호출이 결과를 반환, `async:true`는 `queued` runId, 깊이 4는 `workflow_depth_exceeded` | `tests/workflow-run.test.ts` |
| A5 | 바인딩 store·dispatch 재작성(슬롯 UNIQUE 유지, args 전달) | `src/scheduler/schedule-*.ts` | `bun test tests/schedules.test.ts` | `pass 0 fail` (중복 슬롯 0건, args가 runs.params_json에 기록) | `tests/schedules.test.ts` |
| A6 | 계정 수집 시드·삭제를 새 모델로 | `src/scheduler/collection.ts` | `bun test tests/accounts.test.ts` | `pass 0 fail`, 계정 추가→정의+바인딩 각 1건 | `tests/accounts.test.ts` |
| A7 | 인라인 예산·취소·승인 거부 | `src/surfaces/work/inline-run.ts` | `bun test tests/inline-run.test.ts` | 부모 abort → 자식 `interrupted`, 예산 초과 메시지, `ask` 도구 거부 1건씩 | `tests/inline-run.test.ts` |
| B1 | capability 표 + 브리지 서버(토큰·TTL·거부) | `src/sdk/bridge.ts`, `src/sdk/capabilities.ts` | `bun test tests/workflow-sdk.test.ts -t bridge` | 잘못된 토큰 401, 만료 401, 권한 밖 403 | `tests/workflow-sdk.test.ts` |
| B2 | 실행 환경 주입 + 생성 SDK + 예제 작업 | `src/surfaces/work/script.ts`, `src/sdk/script-sdk.ts`, `scripts/jobs/example-workflow.ts` | `bun test tests/workflow-sdk.test.ts -t subprocess` | 자식 프로세스가 `sdk.call("memory_recall")` 결과를 stdout에 출력 | `tests/workflow-sdk.test.ts` |
| B3 | SDK 문서(스크립트 작성·권한·오류) | `docs/workflow-sdk.md` | `grep -c 'DIGITHIVE_SDK_TOKEN' docs/workflow-sdk.md` | `>=1` | `docs/workflow-sdk.md` |
| C1 | workflow 도구 6종(list/detail/create/edit/delete/run) + 자체 deadline 표시 | `src/tools/workflows.ts` | `bun test tests/workflow-tools.test.ts` | `pass 0 fail`, 스펙 이름 집합 일치, 동기 도구 호출이 결과 반환 | `tests/workflow-tools.test.ts` |
| C2 | schedule 도구 5종 | `src/tools/schedules.ts`(재작성) | `bun test tests/schedule-tools.test.ts` | `pass 0 fail` | `tests/schedule-tools.test.ts` |
| C3 | HTTP 라우트 | `src/server/workflow-routes.ts`, `src/server/schedule-routes.ts` | `bun test tests/workflow-http.test.ts` | 201/200/404/409/422 각 1건 이상 | `tests/workflow-http.test.ts` |
| C4 | runtime·app 배선(브리지 시작, 도구 등록, 라우트, 두 표면의 도구 타이머 우회) | `src/runtime.ts`, `src/server/app.ts`, `src/surfaces/work/tool.ts`, `src/surfaces/conversation/loop.ts` | `bun run typecheck` | exit 0 | `.omo/evidence/workflows/typecheck.txt` |
| D1 | API 클라이언트·타입·탭·목록 | `web/src/workflows/workflowTypes.ts`, `WorkflowPanel.tsx` | `bun run build:web` | exit 0, `web/dist` 갱신 | `.omo/evidence/workflows/build-web.txt` |
| D2 | 정의 폼(실행기·파라미터·권한 체크리스트) | `web/src/workflows/WorkflowForm.tsx`, `ParamsEditor.tsx` | `bun run lint` | exit 0 | `.omo/evidence/workflows/lint.txt` |
| D3 | 스케줄 서브패널·지금 실행·기록 | `web/src/workflows/ScheduleSection.tsx`, `RunDialog.tsx`, `RunHistory.tsx` | `bun run typecheck` | exit 0 | `.omo/evidence/workflows/typecheck.txt` |
| D4 | 스타일·탭 개명·캡처 | `web/src/App.tsx`, `web/src/styles.css` | `PORT=8811 HARNESS_DB=data/qa/workflows.db bun run start` 후 브라우저 캡처 | PNG 2장(1440/390), 탭 라벨 `워크플로`, 목록 3행·파라미터 폼 렌더 | `.omo/evidence/workflows/browser/` |
| E1 | README·설계 문서·QA 기록 | `apps/harness/README.md`, `docs/accounts-schedules-design.md`, `docs/qa/2026-11-25-workflows.md` | `bun run fmt:check` | exit 0 | `docs/qa/2026-11-25-workflows.md` |
| E2 | 개명 잔여·죽은 모듈 정리 | `src/tools/schedules.ts`(삭제), `web/src/schedules/`(이동) | `grep -rn "schedules_list\\|schedules_edit" apps/harness/src apps/harness/tests` | 출력 0줄 | `.omo/evidence/workflows/rename-sweep.txt` |
| E3 | 전체 검증 | — | `bun run verify && bun run fmt:check` | `217+ pass 0 fail`, lint/typecheck/build exit 0 | `.omo/evidence/workflows/verify.txt` |
| E4 | 라이브 스냅샷 변환 검사 | `scripts/qa-workflow-migration.ts` | `bun scripts/qa-workflow-migration.ts --live-snapshot /tmp/harness-v9.db` | `mismatch=0`, user_version 10 | `.omo/evidence/workflows/live-migration.txt` |
| E5 | 배포·라이브 확인 | `.github/workflows/cd.yml`(변경 없음) | `curl -s https://digithive.chanoil.com/api/health` | `ok:true`, `schemaVersion:10` | `.omo/evidence/workflows/live.txt` |

---

## 10. 병렬 실행 규칙

| 라운드 | 동시 레인 | 쓰기 범위 | 선행 |
| --- | --- | --- | --- |
| R0 | 1 (main) | W0-1~W0-4 | — |
| R1 | **3** — A(코어), B(SDK), D1(웹 골격) | A: `src/workflows/`, `src/scheduler/`, `src/surfaces/work/inline-run.ts` · B: `src/sdk/`, `src/surfaces/work/script.ts` · D1: `web/src/workflows/` | R0 |
| R2 | **3** — C(도구·라우트·배선), D2·D3(웹 폼), E1(문서) | C: `src/tools/`, `src/server/`, `src/runtime.ts`, `src/surfaces/work/tool.ts`, `src/surfaces/conversation/loop.ts` · D: `web/src/workflows/` · E: `docs/` | A 완료(C), R0(D) |
| R3 | **2** — D4(캡처·스타일), E2(정리) | D: `web/`, E: 삭제·grep | R2 |
| R4 | 1 (main) | E3·E4·E5 | R3 |

규칙:
- 공유 파일(`src/runtime.ts`, `src/server/app.ts`, `src/store/migrations.ts`, `web/src/App.tsx`,
  `web/src/styles.css`, `package.json`)은 **한 레인만** 만진다. 위 표에 적힌 레인이 소유자다.
- 레인 A는 R0의 계약 파일을 수정하지 않는다. 계약 변경이 필요하면 R0로 돌아가 main에서 고친다.
- 자식 레인은 **산출물 경로를 프롬프트에 명시**하고, main은 첫 확인에서 그 파일을 연다.
  파일이 비어 있으면 `running`을 진행으로 읽지 않고 그 레인을 인수한다(2026-11-25 할당량 중단 재발 방지).
- 각 라운드 종료 시 `bun run typecheck && bun test` 통과 후 커밋 1개.

---

## 11. 위험과 구조적 대응

| 위험 | 왜 생기나 | 대응(구조) |
| --- | --- | --- |
| 라이브 DB v10 변환이 되돌릴 수 없음(구 바이너리는 `schedules.trigger_json`을 찾다 실패) | forward-only 마이그레이션 + 코드·스키마 동시 변경 | 배포 전 `VACUUM INTO` 스냅샷 → 로컬 변환 검사(E4) → 스냅샷 파일 보관. 롤백 = 스냅샷 복원 + `gh workflow run cd -f image_tag=<sha>` (**이미지 롤백만으로는 복구되지 않는다**고 문서에 명시) |
| 스크립트 SDK가 원격 코드 실행 통로가 됨 | 자식 프로세스에 내부 API 토큰을 준다 | 127.0.0.1 바인딩, 실행별 토큰·deadline TTL, capability 그룹만 노출, `external_action` 상시 거부, 깊이 3 제한, 토큰은 settle 시 폐기 |
| 스크립트가 자기 자신을 다시 실행해 폭주 | workflow_run이 스크립트에서도 가능 | 부모 체인 깊이 3, 동시 실행 상한 2는 그대로, 실행 폭주는 `run.queued` 이벤트로 관측 |
| 인라인 실행이 오래 걸려 호출자 예산을 먹는다 | 동기 실행이 부모 턴·실행 안에서 돌기 때문 | 예산 = `min(정의 제한, 호출자 남음)`, 깊이 3, `ask` 거부, 예산 초과 사유를 결과에 명시하고 `async: true`·스케줄 등록을 안내 |
| 정의 수정이 기존 바인딩을 조용히 깨뜨림 | params 변경 + 저장된 args | 저장 시 검증, 수정 시 `schedule_args_invalid` 거부, dispatch 시에도 재검증 |
| 개명이 217개 테스트를 흔든다 | 테이블·모듈·도구 이름 전면 교체 | R0에서 계약과 스키마를 먼저 고정하고, 개명은 `typecheck`가 잡는 기계적 패스(E2)로 몰아서 수행 |
| 도구 스펙이 늘어 컨텍스트를 먹는다 | 도구 12종 신설 | 목록은 요약 필드만, 상세는 `filter` 섹션 선택, BM25로 id 우선 획득 |
| 옛 이벤트 종류가 사라져 과거 기록이 안 읽힘 | 유니온에서 제거 | 레거시 종류 유지 + 새 종류 추가(W0-4) |
| 배포 후 낡은 웹 번들이 새 API를 반쪽으로 호출 | 탭이 열린 채 배포 | 기존 빌드 id 재적재가 그대로 동작(`/api/version`) |

---

## 12. 남은 결정 (승인 시 이 기본값이 구속력이 된다)

1. **UI 구조**: 최상위 탭 `워크플로` 하나, 스케줄은 상세 안. (D12)
2. **기본 capabilities**: 읽기 그룹 체크, 쓰기·실행은 미체크. (D10)
3. **`workflow_run`은 동기 즉시 실행이 기본**, `async: true`만 큐 적재. 별도 상태 도구 없음. (D7·D11)
4. **구 API·도구 별칭 없음**, 내부 식별자까지 개명. (D13)
5. **builtin 실행기는 이번에 파라미터를 받지 않는다**; 선언하면 저장 거부.
6. **검색은 셋 중 하나만** 허용(동시 지정은 422).
7. **`workflow_delete`는 기본 409**, 바인딩이 있으면 `cascade` 필요.
8. **배포는 라이브 스냅샷 검사 후** CD 파이프라인(main push)으로. 스냅샷 전 배포 금지.

이견이 있으면 그 항목만 바꿔 다시 계획한다.

---

## 13. 계획 자체 점검

- 각 작업 행: 실행 명령 27/27(백틱), PASS 관찰값 27/27, 증거 27/27.
- 계약 절이 덮는 것: 데이터 모델(D6, §2), 파라미터(D8, §3), SDK(D9·D10, §4), HTTP(§5),
  도구(D5·D11, §6), 이벤트(§7), 화면(§8·D12), 실패·승인·예산(§4 거부 규칙, §2 삭제 가드).

---

## 14. 진행 상황

- **2026-11-25 R0 완료**: `src/workflows/workflow-types.ts`(정의·파라미터·바인딩·검색·실행 계약),
  script executor의 `capabilities`, 이벤트 종류, `tests/workflow-contract.test.ts` 10 pass.
- **A0~A7 완료**: 마이그레이션 v10(`workflow-migration.ts`)과 스냅샷 검사 스크립트,
  workflow store/검색/파라미터/실행(동기 인라인 + `async` 분기)/깊이 3, 바인딩 store·dispatch 재작성,
  계정 수집 workflow 시드.
- **B1~B2 완료**: 워커 루프백 브리지(`src/sdk/bridge.ts`), capability 매핑,
  생성 SDK(`scriptsRoot/.digithive/sdk.ts`), 실행 환경 주입, 예제 작업(`scripts/jobs/example-workflow.ts`).
- **C 완료**: 도구 11종(`workflow_*` 6 + `schedule_*` 5), HTTP 라우트, runtime 배선,
  `selfDeadline`으로 두 표면의 30초 도구 타이머 우회, `inline` 프로파일로 승인 요청 거부.
- 검증: `bun test` **241 pass / 0 fail**(36 files), `bunx oxlint --type-aware src tests scripts` 0,
  서버 `bun run typecheck` 0.
- 다음: D4 캡처, E1 문서·E2 정리, E3 전체 `verify`, E4 라이브 스냅샷 검사, E5 배포.
