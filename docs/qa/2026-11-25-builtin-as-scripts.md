# 내장 작업 → 앱이 실어 보내는 스크립트, 그리고 대화 이벤트의 일급화

2026-11-25. 두 요청에 대한 설계와 검증 기록.

## 1. 내장 작업은 종류가 아니라 경로다

요청: `연결 자료 수집`과 `브리핑 생성`을 `kind:"builtin"`이라는 별도 종류로 두지 말고, 에이전트/스크립트와 동등한
실행 방식 위에서 "앱이 실어 보내는 스크립트"로 두기. 특별한 것은 종류가 아니라 스크립트 경로다.

### 옮기기 전에 확인한 결함

`kind:"builtin"` 경로는 소유자가 켜고 끄는 소스 기능 스위치를 실행 시점에 지키지 않았다.

- 대화에서 `workflow_run` → 인라인 실행은 `permissionProfile: "inline"`을 남기지만, 그 값은 에이전트 분기만 읽는다.
  내장 분기는 `createBuiltinExecutor`로 곧장 가서 `collectSources`를 부른다.
- `collectSources`는 계정의 **켜진** 소스를 기준으로 목록을 만들고, 워크플로의 `sources`는 그 목록을
  **좁히는** 용도로만 쓴다. 그래서 Gmail이 켜져 있을 때 저장한 워크플로는, 이후 Gmail을 꺼도 계속 Gmail을 수집한다.
- 스케줄 경로(`dispatchDueSchedules` → `executeRun`)는 워크플로의 `sources`를 executor에 그대로 넘긴다.
  즉 같은 계정을 두 경로가 서로 다른 규칙으로 읽었다.

저장 시점의 라우트 검사(`collectionProblem`)는 저장된 뒤에 꺼진 스위치를 볼 수 없으므로, 이 구멍은 고쳐도
"언제나 참"이 되지 않는다. 스크립트로 옮기면 사라진다: 스크립트는 `account_list`로 **지금 켜진** 소스를 받아
그것만 읽으므로, 끈 소스는 실행 코드에 닿지 않는다.

### 새 모양

| 실행 방식 | 무엇이 실행되나 | 특별한 점 |
| --- | --- | --- |
| `agent` | 모델 + 도구 | 없음 |
| `script` | `scriptsRoot` 안의 `.ts/.js` | 없음 |

- 연결 자료 수집: `{kind:"script", path:"jobs/collection.ts", args:[accountId], capabilities:["account.read"]}`
- 브리핑 생성: `{kind:"script", path:"jobs/briefing.ts", args:[], capabilities:["account.read","mail.send"]}`
- 두 경로는 `jobs/`, 즉 **앱이 만드는 scripts 루트 바로 아래**에 설치된다. 다른 특별함은 없다.
- 없는 기능은 SDK로 넓힌다(앱 코드를 도구로 노출하던 방식 대신):
  - `account_list`: 계정과 **켜진** 소스·연결 상태 (capability `account.read`)
  - `mail.send`: 푸시 발송, 받는 기기가 없으면 실패가 아니라 `sent:0` (capability `mail.send`)
- 기능 스위치와 계정이 사라지는 문제는 스크립트가 직접 판단하고 실패 메시지를 남긴다.

### 실행 경로 정리

- `runTurn`/`executeNonAgent`의 내장 분기, `WorkDeps.scriptExecutor`, `src/scheduler/builtins.ts` 삭제.
- 브리핑 조합(`compose.ts`, `runBriefing`)을 `src/jobs/`로 옮겨, 스크립트가 호출하는 경로와 같은 것을 스케줄러도 쓴다.
- `briefing.stored` 이벤트는 그대로 남는다. 실행 행과 무관한 푸시 실패는 `briefing.push_failed`로 남긴다.
- 스크립트 루트 기본값을 `workspaceRoot/..`에서 `workspaceRoot`로 옮기고, 작업 실행이 작업 공간에 쓴 파일이
  실제 scripts 루트에서 해석되도록 맞춘다(기존 불일치로 파일이 "작성 완료"되어도 스크립트로 실행되지 않았다).
- 이미지: `COPY jobs ./jobs`, compose: `HARNESS_SCRIPTS_ROOT: /app/jobs`. 서버가 시작할 때 필요한 작업 파일과
  그 SDK는 고정 경로의 가져오기(`../src/jobs/...`)를 그대로 두고, 루트가 SSSD면 그 가져오기를 절대 경로로 바꿔
  기록한다(나머지 스크립트는 SDK만 쓴다).

### 마이그레이션 v11

- `kind:"builtin"` 워크플로를 위 스크립트 executor로 바꾼다. `accountId`는 인자로, `sources`는 버린다(이제
  스크립트가 매 실행마다 켜진 소스를 본다).
- 시드 브리핑 두 개(`system-briefing-morning|evening`)의 지시문과 실행 방식을 새 모양으로 맞춘다.
  반복 시각과 바인딩은 건드리지 않는다.
- 계정 연결 시 만드는 수집 워크플로(`ensureCollectionWorkflow`)도 같은 모양으로 만들고, 서버 시작 시 빠진
  계정을 채운다(이전에는 연결 이벤트에서만 만들어졌다).
- 새 표는 만들지 않는다. 그래서 손상된 DB에 붙는 startup reconcile도 바꿀 것이 없다.

## 2. 대화 이벤트를 전부 일급으로

요청: 생각, 도구 호출, 도구 결과, 응답을 하나의 큰 응답에 묶지 말고 전부 분해해서 보여주기. UI의 계층도 줄어야 한다.

### 저장

- 파트(`text|reasoning|tool_call|tool_result|error`)를 버리고 **이벤트** 하나가 파트 하나다:
  `{type:thinking|text|tool_call|tool_result|error, id, name?, detail?, denied?}`. `event.id`는 이벤트가 아니라
  **턴 안의 순서**(정수)다. 호출과 결과를 잇는 것은 `callId`다.
- 이유: 브랜치 포크와 수정이 `entry_id`로 잘리고, 이벤트 `id`가 전선의 주 식별자로 쓰이면 같은 호출의 두 이벤트가
  한 id를 갖게 된다. 순서를 id로 두면 매 이벤트가 고유하다.
- 저장 방식은 그대로다: 엔트리 행 하나 안에 `payload_json.events` 배열. 스키마 변경 없음.
  옛 레코드는 `parts`를 이벤트로 바꿔 읽는다(`parseEntryEvents`).

### 스트림 이름

| 이전 | 이후 |
| --- | --- |
| `message.started` | `turn.response.started {entryId}` |
| `message.delta {text}` | `text.delta {entryId, id, text}` |
| `message.delta {reasoning}` | `thinking.delta {entryId, id, text}` |
| (없음) | `tool_call.started {entryId, id, callId, name, detail}` |
| (없음) | `tool_result.recorded {entryId, id, callId, name, detail, failed?}` |
| `message.completed` | `turn.response.completed {entryId}` |
| `turn.settled` | `turn.done {entryId}` |
| `message.aborted` | `turn.response.aborted {entryId, reason}` |

`tool.started`, `tool.result`, `tool.denied`, `tool.timeout`은 감사 로그(`tool_calls`를 읽는 쪽)가 쓰므로 유지한다.

### 액션의 위치

수정·재생성·분기는 **사용자 대화 이벤트**에 달린다. 클라이언트가 마지막 사용자 이벤트를 직접 판단하지 않도록
`GET /api/sessions/:id/entries/:entryId/actions` 하나를 둔다: 사용자 메시지에는 `edit`·`regenerate`,
활성 브랜치의 끝에 달린 답에는 `regenerate`, 더 오래된 답에는 액션이 없다(항상 `canFork`).
원자성과 잠금 해제(잠금된 잎에서 분기할 때)는 기존 서버 경로(`edit`/`regenerate`/`fork`)를 그대로 부른다.

### 화면

- 응답 엔트리가 bubble 하나였다면, 이제 턴 안의 이벤트마다 자기 블록이 붙는다: 사용자 말풍선, 사고(접힌 블록),
  문단, 도구 호출/결과 쌍(이름으로 이어 붙임), 오류.
- 응답 머리("비서") 안에 액션 줄(분기, 그리고 마지막 사용자 이벤트면 수정·재생성). 액션이 이벤트마다 붙지 않는다.
- 스냅샷 재연결의 부분 텍스트 보존은 이벤트 id 기준으로 같은 규칙을 쓴다.

## 검증

- 게이트: `bun run lint` 0건, `bun run typecheck` 0건, `bun run build:web` 성공, `bun test` 260 pass / 0 fail(신규 `tests/jobs.test.ts` 12건 포함).
- **실제 잡 스크립트 실행**(스텁이 아닌 `jobs/*.ts`를 실제 `runScriptFile` + SDK 브리지로):
  - `collection.ts acct-a` → 해당 계정의 **켜진** 소스만 요청, Gmail 미연결이면 `failed[{source:"gmail",error:"google_not_connected"}]`와 exit 1
  - `collection.ts missing-account` → exit 1 "계정 … 이(가) 없습니다"
  - `collection.ts `(인자 없음) → exit 2 "수집할 계정 id가 필요합니다"
  - `briefing.ts` → exit 0, 브리핑 저장 + `pushed:false, errors:["push_unconfigured"]`, 런은 성공(알림 실패는 run 실패가 아님)
- **큐 경로**: v11 후 `wf-system-briefing-morning`이 `jobs/briefing.ts` + `account.read,mail.send`로 바뀌고,
  `claimNext → executeRun`을 거쳐 `runs.status=succeeded`, `result_json.stdout`에 브리핑 JSON이 기록됨.
- **화면**(실제 대화 턴을 오프라인 mock provider로 실행 → 실제 뷰 렌더): 이벤트가
  `tool_call → tool_result → thinking → text`로 나뉘고 블록은 `tool | thinking | text`. 도구 블록은 "입력"(접힘)과 결과를
  함께 보이고, 생각은 접힌 블록, 답은 문단 블록이다.
- **화면(워크플로)**: 실행 방식은 에이전트/스크립트 둘뿐이고, "내장 작업"은 없어졌다. 앱 작업은 스크립트 경로
  `jobs/collection.ts`로 표시되며 선택 시 권한이 맞춰진다.

### 실행 중 잡은 결함

1. **압축이 자기 자신을 다시 요약할 뻔함(내 변경이 만든 회귀).** 압축 엔트리는 계속 `parts`로 쓰고 있었는데
   읽기는 `events`만 봤다. 그래서 `latestCompaction`이 null로 읽혀 매 턴 같은 메시지를 다시 압축했을 것이다.
   쓰는 쪽을 `events`로 바꿨다(`src/core/compaction.ts`). 테스트가 바로 잡아냈다.
2. **설치본 SDK 가져오기 경로.** 원본 `../.digithive/sdk.ts`는 설치본 `<root>/jobs/`에서 한 단계 깊게 풀려
   설치본이 실제로는 실행 즉시 실패했다. 설치본은 절대 경로로 SDK를 가져온다. 테스트가 상대 경로를 기대해
   놓쳐서, **실제 파일 실행**이 잡아냈다. 테스트도 절대 경로를 단언하도록 고쳤다.
3. **브리핑이 script 경로에서 FK로 실패.** `briefings.run_id`가 `runs`를 참조하는데 스크립트의 runId가
   행을 갖지 않을 수 있었다. `runExists`가 있을 때만 기록하도록 했다.
4. **`push_send`가 스크립트에서 거부됨.** `external_action`이라 브리지가 막았다. 직접 쓰는 계정 소유자의
   서버이므로 `read`로 두고 `mail.send` 권한으로만 제한한다.

### 배포

- 이미지 `COPY jobs ./jobs`, compose `HARNESS_SCRIPTS_ROOT: /app/jobs`.
- 스크립트 루트 기본값을 `workspaceRoot`로 맞추었다. 예전에는 작업 공간 파일이 scripts 루트와 한 단계 어긋나
  "작성 완료"된 파일이 스크립트로 해석되지 않았다.

### 남은 확인

- 브라우저 화면 캡처는 하지 않았다(BrowserSkill 데몬이 없는 환경). 렌더는 happy-dom으로 실제 컴포넌트를
  실제 이벤트로 그려 확인했다. 라이브 배포 후 실제 기기에서는 아직 보지 않았다.
- `mail.send`에는 속도 제한과 자기 자신을 무한히 깨우지 않는 예산이 없다. 오너 서버 전제로 미뤄 둔 항목이다.
