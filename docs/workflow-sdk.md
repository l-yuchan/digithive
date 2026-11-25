# 워크플로 스크립트 SDK

스크립트는 별도 프로세스로 실행되므로 하네스 모듈을 직접 import 할 수 없습니다. 대신 워커가 실행마다
**그 실행 전용 루프백 브리지**를 열고, `scriptsRoot` 아래에 단일 파일 SDK를 생성합니다.
스크립트는 그 파일을 import 해서 에이전트 도구와 같은 내부 기능을 호출합니다.

## 1. 준비

하네스가 시작될 때 `apps/harness/scripts/.digithive/sdk.ts` 가 생성됩니다(내용이 바뀔 때만 다시 씀).

```ts
// scripts/jobs/morning.ts
import { sdk } from "../.digithive/sdk.ts";

const context = await sdk.context();
const hits = await sdk.memory.recall("회의");
console.log(JSON.stringify({ run: context.runId, params: context.params, hits }));
```

직접 `DIGITHIVE_SDK_URL`/`DIGITHIVE_SDK_TOKEN` 을 읽을 필요는 없습니다. 두 값은 실행 중에만 주입되고,
스크립트가 하네스 밖에서 직접 실행되면 SDK 호출이 `DIGITHIVE_SDK_TOKEN` 오류로 즉시 실패합니다.

## 2. 주입되는 환경변수

| 변수 | 의미 |
| --- | --- |
| `DIGITHIVE_SDK_URL` | 이 실행의 브리지 주소 (`http://127.0.0.1:<port>`) |
| `DIGITHIVE_SDK_TOKEN` | 이 실행에만 유효한 토큰(실행 종료·타임아웃 시 폐기) |
| `DIGITHIVE_RUN_ID` | 실행 id |
| `DIGITHIVE_WORKFLOW_ID` / `DIGITHIVE_WORKFLOW_TITLE` | 이 실행을 만든 정의 |
| `DIGITHIVE_PARAMS` | 이 실행이 받은 파라미터 값(JSON) |

## 3. 권한(capabilities)

워크플로 폼에서 스크립트 실행기에 체크한 그룹만 브리지에서 허용됩니다. 선언되지 않은 도구는
`script_capability_denied` 로 거부되고, 스크립트는 그 오류를 읽고 다른 길을 선택할 수 있습니다.

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

승인이 필요한 도구(`external_action`)는 스크립트에서 항상 거부됩니다 — 실행 중에는 승인할 사람이
없기 때문입니다. 그런 작업은 스케줄로 등록하거나 대화에서 승인하세요.

## 4. API

```ts
sdk.tools()                     // 이 실행이 쓸 수 있는 도구 목록(이름·설명·스키마)
sdk.context()                   // { runId, workflowId, workflowTitle, params, expiresAt }
sdk.call(name, args)            // 도구를 직접 호출(허용 목록 안에서만)

sdk.workflow.list({ keyword?, regex?, bm25?, limit? })
sdk.workflow.detail(id, filter?)
sdk.workflow.create(input)
sdk.workflow.edit(id, delta, force?)
sdk.workflow.delete(id, cascade?)
sdk.workflow.run(id, args?, { async? })   // 기본은 그 자리에서 실행하고 결과 반환

sdk.schedule.list(workflowId?)
sdk.schedule.detail(id)
sdk.schedule.create(input)
sdk.schedule.edit(id, delta)
sdk.schedule.delete(id)

sdk.memory.recall(query)
sdk.memory.note("fact" | "hypothesis", text)
sdk.memory.correct(id, text)

sdk.mail.search(query, { limit?, accountId? })

sdk.files.list()
sdk.files.read(id)
```

## 5. 실행 예산과 중첩

- 스크립트 실행은 워커의 실행 슬롯 하나를 차지하고, 자기 제한 시간(`timeoutSeconds`)까지 삽니다.
- `sdk.workflow.run()` 은 **호출자의 남은 예산 안에서** 자식 실행을 그 자리에서 돌립니다
  (별도 슬롯을 잡지 않으므로 슬롯 교착이 없습니다). 깊이는 3단계까지입니다.
- 오래 걸리는 자식은 `{ async: true }` 로 큐에 넘기고 `sdk.workflow.detail(id, ["runs"])` 로 결과를 봅니다.
- `waitFor` 같은 대기 API는 없습니다: 동기 호출은 끝까지 기다리고, 비동기 호출은 즉시 반환합니다.

## 6. 오류

브리지 응답은 실패해도 JSON입니다. SDK는 이를 예외로 바꾸며 메시지에 원문이 들어 있습니다.

| 상황 | 결과 |
| --- | --- |
| 토큰 없음/만료/폐기 | `401 sdk_unauthenticated` |
| 허용되지 않은 도구 | `403 script_capability_denied` |
| 승인이 필요한 도구 | `403 script_approval_unavailable` |
| 도구 자체 실패 | `500 tool_failed` + 원인 문자열 |

스크립트가 이 오류를 잡아 stdout에 남기면 실행 기록에 그대로 보입니다. 잡지 않으면 프로세스가
0이 아닌 코드로 끝나고 실행은 `failed` 로 정산되며 stderr가 결과에 남습니다.
