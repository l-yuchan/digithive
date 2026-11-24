# digithive 하네스 rewrite 상세 구현 계획

작성일: 2026-11-24
선행 문서: `docs/harness-research-plan.md`(조사 계획), `docs/harness-research/`(조사 보고서 7종)
대체 관계: 이 문서는 `docs/assistant-v2-spec.md`를 덮어쓰지 않는다. 그 명세의 제품 요구를 유지한 채 **하네스 구현을 새로 세우는 착수 계획**이다.

상태: **승인 대기.** 이 문서로 구현을 자동 시작하지 않는다. 승인 후 웨이브 W0부터 착수한다.

---

## 0. 결정 전제 (사용자 확정, 재논의 대상 아님)

| # | 결정 | 계획에 반영된 방식 |
|---|---|---|
| D1 | 두 하네스는 **공통 코어 + 필요에 따라 차이를 두는 실행 계층** | §2. 대화/작업 실행 계층이 같은 코어(도메인·이벤트·저장·모델 어댑터·도구 계약)를 공유하고, 루프·도구 집합·권한·예산·격리만 다르다 |
| D2 | **OmO는 사용하지 않고 직접 구현** | §2. 외부 하네스 의존 0. 현재 OmO는 개발 보조 도구로만 남고 제품 런타임에서 제거 |
| D3 | **UI는 React** | §10. React 19 + Vite. 스트리밍 상태 소유권은 코어/클라이언트 런타임 계약으로 고정 |
| D4 | **전면 rewrite** | §11 기존 자산은 "이전(migrate)"으로 처리하고, 대화·실행·UI 코드는 새로 쓴다. `src/`(v1 프로토타입)는 손대지 않는다 |
| D5 | 상세 계획의 **순서 선호 없음** | §12 웨이브 순서는 의존성 기준으로만 정했다. 사용자가 순서를 바꿔도 각 웨이브가 독립 검증 가능하도록 설계 |
| D6 | 라이선스는 결정 변수 아님 | 외부 코드 복사 없음. 참고한 설계는 문서화된 아이디어 수준 |

## 1. 목표와 비목표

### 1.1 목표
1. 사용자가 일상 대화를 하고 복잡한 작업을 맡길 수 있는 단일 제품을, 자체 하네스로 운영한다.
2. 대화 턴은 스트리밍으로 즉시 반응하고, 모든 도구 호출·결과·실패·승인이 화면에 보인다.
3. 작업 실행은 대화와 분리되어 길게 돌 수 있고, 리스·정산·취소·재개 규칙이 명시적이다.
4. 현재 v2의 제품 자산(개인 연동, 기억, 파일, 브리핑·푸시, 예산)은 데이터 손실 없이 이전한다.

### 1.2 비목표 (이번 rewrite에서 하지 않는다)
- 다중 사용자·조직·권한 관리. 단일 사용자 + 패스프레이즈 게이트 유지.
- 코딩 에이전트 기능(저장소 편집·LSP·터미널 TUI). 제품 표면은 웹/모바일이다.
- OmO·OpenCode·Codex 런타임 의존, 그들의 프로토콜 채택.
- 일반화 검증·벤치마크. n=1 개인 시험 범위를 유지한다.
- 마크다운 렌더링 고도화·부가 기능 확장은 이 계획 범위 밖(사용자 지시로 후순위).

## 2. 대상 구조

### 2.1 배치

```
apps/harness/
  src/core/          도메인: 세션 트리, 메시지·part, run 상태 기계, 정책 판정, 예산
  src/events/        정규 이벤트 로그: seq 부여, 커서 재생, 라이브 구독
  src/providers/     모델 어댑터: 스트리밍 파싱, 오류 분류, 사용량
  src/tools/         도구 레지스트리 + 승인 게이트 + 실행 경계(데드라인·abort)
  src/store/         SQLite 스키마·마이그레이션·쿼리
  src/surfaces/
    conversation/    대화 실행 계층: 빠른 턴, 조회 도구, 위임 요청
    work/            작업 실행 계층: 긴 루프, 쓰기·실행·검증, 산출물
  src/server/        HTTP API, 인증, SSE, 정적 자산
  src/scheduler/     예약·브리핑·푸시
  src/integrations/  Gmail·Calendar·Canvas (v2에서 이전)
  src/knowledge/     기억·검색·인용 (v2에서 이전)
  web/               React 클라이언트 (Vite)
  tests/             계약·상태 기계·통합 테스트
```

### 2.2 책임·소유권과 의존 방향

| 계층 | 소유 | 의존 가능 | 의존 금지 |
|---|---|---|---|
| core | 상태 전이 규칙, 정책 판정, 예산 계산 | store(인터페이스), events(기록) | HTTP, React, 모델 SDK |
| events | 이벤트 종류·seq·페이로드 스키마 | store | core 로직, 표면 |
| providers | 공급자 요청/응답·스트림 파싱·오류 분류 | core 타입 | store, 정책, 표면 |
| tools | 도구 계약, 승인 필요 여부, 실행 상한 | core, providers | HTTP, 표면 |
| surfaces/* | 루프와 도구 선택 정책 | core, events, providers, tools | server 라우팅, React |
| server | 인증, 라우팅, SSE 전송 | core, events, store | 표면 내부 구현 |
| web | 렌더·입력·로컬 초안 | server API 계약 | core, store |

의존은 위→아래 한 방향. **정책 판정은 `core/policy` 한 곳**에서만 하고 server·scheduler·표면이 각자 재해석하지 않는다(조사 사례 #13016).

### 2.3 두 실행 계층의 차이 (D1)

| 항목 | 대화 계층(`surfaces/conversation`) | 작업 계층(`surfaces/work`) |
|---|---|---|
| 트리거 | 사용자 메시지 | 위임·예약·수동 실행 |
| 목표 지연 | 첫 토큰까지 수 초 | 완료까지 분~시간 |
| 도구 집합 | 조회·검색·읽기·위임 요청 | 읽기+쓰기+스크립트 실행+검증 |
| 승인 | 외부 행동은 매번 승인 요청 | 승인 프로필로 사전 위임, 예산·범위 초과 시 재승인 |
| 컨텍스트 | 대화 트리 + 요약 + 기억 | 목표 브리프 + 자료 + 이전 시도 기록 |
| 종료 조건 | 답변 1개 | 완료 조건 + 산출물 증거 |
| 격리 | 서버 프로세스 내 | 별도 워커 프로세스(격리 실행 디렉터리) |
| 상태 | 턴 단위 이벤트 | run 리스·정산 |

공유하는 것은 **코어 계약**(상태 전이, 이벤트, 도구 승인 판정, 예산, 모델 어댑터)이다. 공유하지 않는 것은 **루프·도구 집합·프로세스 경계**다.

## 3. 데이터 모델

SQLite. 기존 v2 DB는 새 스키마와 공존 가능한 이름을 쓴다(§13).

```sql
-- 세션: 대화 1개 = 세션 1개. 트리는 entries로 표현.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                 -- uuid
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,                    -- 삭제 대신 보관(되돌림 가능)
  deleted_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

-- 트리 엔트리: 메시지·압축·브랜치 요약·모델 변경·라벨·시스템 노트
CREATE TABLE entries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  parent_id TEXT REFERENCES entries(id),
  kind TEXT NOT NULL,                  -- message|compaction|branch_summary|model_change|label|note
  role TEXT,                           -- user|assistant|tool|system (message일 때)
  status TEXT,                         -- streaming|complete|failed|aborted
  payload_json TEXT NOT NULL,          -- parts, 모델, 사용량, 오류
  created_at TEXT NOT NULL,
  seq INTEGER NOT NULL                 -- 세션 내 단조 증가
);
CREATE INDEX entries_tree ON entries(session_id, parent_id);
CREATE INDEX entries_seq ON entries(session_id, seq);

-- part: 메시지 본문을 구성 요소로 분해 (별도 테이블, 순서 보존)
CREATE TABLE parts (
  entry_id TEXT NOT NULL REFERENCES entries(id),
  idx INTEGER NOT NULL,
  kind TEXT NOT NULL,                  -- text|reasoning|tool_call|tool_result|error|citation
  payload_json TEXT NOT NULL,
  PRIMARY KEY (entry_id, idx)
);

-- 실행: 대화 턴에서 파생된 작업 또는 예약 작업
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id),
  parent_run_id TEXT REFERENCES runs(id),
  origin TEXT NOT NULL,                -- conversation|delegation|schedule|manual
  goal TEXT NOT NULL,
  status TEXT NOT NULL,                -- queued|running|awaiting_approval|succeeded|failed|cancelled|interrupted
  cancel_intent TEXT,                  -- user|timeout|host_restart|policy|superseded
  lease_owner TEXT,
  lease_expires_at TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  budget_json TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL,
  settled_at TEXT
);
CREATE INDEX runs_live ON runs(status, lease_expires_at);

CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  entry_id TEXT REFERENCES entries(id),
  name TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  decision TEXT,                       -- allow|ask|deny
  decision_by TEXT,                    -- policy|user|timeout
  status TEXT NOT NULL,                -- pending|running|succeeded|failed|denied|timeout|aborted
  result_json TEXT,
  started_at TEXT,
  ended_at TEXT,
  deadline_at TEXT
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  tool_call_id TEXT NOT NULL REFERENCES tool_calls(id),
  status TEXT NOT NULL,                -- pending|approved|rejected|expired
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  note TEXT
);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT,
  session_id TEXT,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX events_run ON events(run_id, seq);
CREATE INDEX events_session ON events(session_id, seq);
```

### 3.1 규칙
- **삭제는 soft**: `deleted_at` + 이벤트 `session.deleted`. 파일·기억 참조는 삭제 시점의 id를 보존하고, 새 요청에서만 제외한다.
- **편집은 새 엔트리**: 기존 메시지를 덮어쓰지 않고 같은 `parent_id`를 가진 새 엔트리를 만든다(분기). 원본은 보존.
- **part는 불변**: 스트리밍 중에는 같은 entry의 마지막 text part를 append-only로 키우고, 완료 시 확정.
- 기존 v2 테이블(`conversations`, `messages`, `runs`, `events`, `files`, `memories` …)은 이전 기간 동안 유지한다(§13).

## 4. 이벤트 계약

### 4.1 종류 (닫힌 목록, 추가는 스키마 변경으로 취급)

| 분류 | kind |
|---|---|
| 세션 | `session.created`, `session.renamed`, `session.deleted` |
| 턴 | `turn.started`, `turn.settled` |
| 메시지 | `message.started`, `message.delta`(text/reasoning), `message.part`, `message.completed`, `message.aborted` |
| 도구 | `tool.started`, `tool.progress`, `tool.result`, `tool.denied`, `tool.timeout` |
| 승인 | `approval.requested`, `approval.decided`, `approval.expired` |
| 실행 | `run.queued`, `run.started`, `run.heartbeat`, `run.settled`, `run.failed`, `run.interrupted`, `run.cancelled` |
| 맥락 | `context.compacted`, `context.edited` |
| 운영 | `usage.recorded`, `budget.threshold`, `provider.retry`, `provider.fallback`, `integration.sync_state` |

### 4.2 전송 규약
- 모든 이벤트는 `seq`(전역 단조)를 갖는다. 클라이언트는 `Last-Event-ID` 또는 `?after=<seq>`로 재개한다.
- `GET /api/events?after=<seq>&session=<id>` 는 **살아 있는 SSE 스트림**이다. 유휴 시 15초마다 주석 프레임(`: ping`)을 보내 프록시 타임아웃을 막는다.
- 재개 시 서버는 저장된 이벤트를 순서대로 재생한 뒤 같은 연결에서 라이브로 전환한다(재생과 라이브 사이 gap 없음).
- 이벤트는 **쓰기 트랜잭션 안에서** 상태 변경과 함께 기록한다. 이벤트 없는 상태 변경 금지.
- 클라이언트는 이벤트로만 화면을 갱신한다(폴링 없음). 재연결 실패 시 지수 백오프, 30초 후 전체 스냅샷 재조회.

### 4.3 정산 규칙 (조사 결함 계열 대응)
- `run.started`는 리스를 얻은 뒤에만 발행. 리스는 15초 하트비트, 45초 만료.
- 리스가 만료되면 리컨사일러가 `run.interrupted`(cancel_intent=`host_restart` 또는 `timeout`)로 정산한다. **종료 이벤트 부재가 영구 `running`을 만들지 않는다**.
- 턴에도 상한이 있다: 첫 토큰 60초, 토큰 간 유휴 120초, 전체 턴 15분. 초과 시 `message.aborted` + 사유.
- 모든 도구 호출은 `deadline_at`을 갖고, 초과 시 `tool.timeout`이 결과로 모델에 전달된다(거부/시간초과도 결과).

## 5. 모델 어댑터

- 계약: `stream(messages, tools, options) -> AsyncIterable<AdapterEvent>`.
  `AdapterEvent` = `{type:"text_delta"|"reasoning_delta"|"tool_call_start"|"tool_call_args_delta"|"tool_call_end"|"usage"|"done"|"error"}`.
- 기본 구현: OpenAI 호환 `chat/completions` SSE(`stream:true`, `stream_options:{include_usage:true}`).
- 오류 분류(기존 4종 확장): `http_4xx`(재시도 없음), `http_5xx`(지수 백오프 2회), `timeout`, `malformed`, `truncated`(finish_reason=length → 명시적 실패), `rate_limited`(제공자 힌트 대기), `auth_expired`.
- 폴백 체인: 모델 목록 순서대로, 실패 원인이 `http_5xx|rate_limited|timeout`일 때만 다음 모델. `http_4xx|auth_expired`는 폴백하지 않고 사용자에게 상태 표시.
- 사용량: `usage.recorded` 이벤트에 토큰·추정비용·실청구를 분리 기록(기존 v2 방식 유지).
- 스트리밍 미지원 공급자도 계약을 만족한다(내부에서 단일 응답을 delta 1개로 방출).

## 6. 맥락과 시스템 지시

### 6.1 조립 순서 (매 턴, 고정)
1. **정체·정책**: 제품 정체, 응답 언어(한국어), 승인 경계, 금지 행동.
2. **현재 시각**: `Asia/Seoul` 기준 ISO 시각 + 요일 + "이 값이 유일한 시간 기준이며, 메일·문서의 날짜를 현재로 추론하지 않는다"는 문장. **매 턴 재주입**(압축·도구 다발 턴 이후 표류 방지, 사례 #11527).
3. **사용자 맥락**: 기억 요약(최대 2,000자), 활성 파일 목록 요약.
4. **도구 설명**: 선택된 도구만.
5. **대화 트리**: 활성 분기 메시지 + 최근 압축 요약.
6. **작업 브리프**(작업 계층만): 목표, 완료 조건, 이전 시도, 예산.

### 6.2 예산과 압축
- 모델별 물리 컨텍스트 한도와 **활성 예산**을 분리한다(조사 #7152 방향). 활성 예산 = 물리 한도의 60%.
- 80% 도달 시 자동 압축: 오래된 구간을 요약 엔트리(`kind=compaction`)로 대체하고, 원본은 트리에 보존한다.
- 압축 프롬프트는 1번·2번 블록을 절대 요약 대상에서 제외한다.
- 압축 실패 시 압축을 포기하고 "컨텍스트가 길다"를 사용자에게 표시한다(조용한 절단 금지).

## 7. 대화 관리 의미론

| 동작 | API | 데이터 의미 |
|---|---|---|
| 제목 변경 | `PATCH /api/sessions/:id {title}` | `sessions.title` 갱신 + `session.renamed` |
| 삭제 | `DELETE /api/sessions/:id` | soft delete + `session.deleted`. 연결된 진행 중 run은 `cancel_intent=policy`로 취소 |
| 메시지 편집 | `POST /api/sessions/:id/entries/:entryId/edit {text}` | 같은 `parent_id`의 새 user 엔트리 생성, 그 지점으로 leaf 이동 |
| 재생성 | `POST /api/sessions/:id/entries/:entryId/regenerate` | assistant 엔트리를 형제로 새로 생성, 이전 응답은 트리에 보존 |
| 분기 전환 | `POST /api/sessions/:id/leaf {entryId}` | 활성 leaf만 변경(새 파일 생성 없음) |
| 새 세션으로 분기 | `POST /api/sessions/:id/fork {entryId, title}` | 해당 지점까지 복사한 새 세션 |
| 검색 | `GET /api/sessions?q=` | 제목·본문 FTS |

편집·재생성은 **실행 중 run을 건드리지 않는다**. 그 run이 참조한 엔트리 id는 불변이므로 결과 귀속이 유지된다.

## 8. 작업 실행 계층

### 8.1 상태 기계
```
queued → running → (awaiting_approval ↔ running) → succeeded | failed | cancelled | interrupted
queued → cancelled
running → interrupted   (리스 만료)
```
- `interrupted`는 재개 가능: 다음 실행에서 `attempt+1`, 입력은 유지, 이미 발생한 외부 효과는 재실행 금지 목록에 기록.
- 취소 의도는 `cancel_intent`에 반드시 기록(사례 #11856).

### 8.2 승인
- 요청 생성 시 `tool_calls.decision`을 정책이 `allow|ask|deny`로 먼저 판정한다.
- `deny` → **도구 결과로 거부 사유를 반환**하고 턴은 계속(사례 #14649).
- `ask` → `approval.requested` 이벤트 + run은 `awaiting_approval`. 만료(기본 30분) 시 `approval.expired` → `denied`로 정산.
- 승인 응답 three-way 유지: 이번만/항상(프로젝트 스코프 규칙 저장)/거부. 저장된 승인은 설정된 deny를 이길 수 없다.
- 승인 대기 중 서버 재시작 → 재기동 리컨사일러가 `pending` 승인을 그대로 살린다(대상·인자 불변 확인 후).

### 8.3 실행 경계
- 도구 실행은 별도 워커 프로세스(`scripts/worker.ts` 계승)에서 수행, run id로 격리 디렉터리.
- 모든 도구 호출: 데드라인, abort 신호 전파, 부분 출력 스트리밍(`tool.progress`).
- 스크립트 실행과 에이전트 실행을 동일 run 계약으로 다룬다(기존 `executors` 개념 유지).

## 9. 위임과 가시성

- 위임 = `runs.parent_run_id`를 가진 작업 run. 대화 턴은 위임을 **요청**하고 즉시 사용자에게 "맡김"을 표시한다.
- 위임 시 5개를 명시: 목표, 입력 자료(엔트리/파일 id), 권한 프로필, 예산 상한, 완료 조건.
- 자식 진행은 부모 세션에 **요약 이벤트**(`run.progress`)로만 흘리고, 원본은 자식 run의 이벤트 로그에 남긴다(사례 #7288, 맥락 오염 방지).
- 완료 시 부모에 `run.settled` + 결과 요약 + 증거 링크(파일·출처·검증 명령 출력)를 넣는다.
- 동시 실행 상한: 기본 2(대화 외). 예산·CPU 경합 시 `queued`로 대기하고 사용자에게 이유 표시.

## 10. React 클라이언트

- 스택: React 19 + Vite + TypeScript. 상태: 서버 상태는 얇은 자체 훅 + 이벤트 리듀서(외부 상태 라이브러리는 필요해질 때만).
- 스트리밍 소유권: **코어가 이벤트의 단일 소스**이고 클라이언트 리듀서가 entry/part를 재구성한다. 렌더러는 재구성된 상태만 본다(라이브러리 도입 여부는 W2에서 이 계약 위에서 결정).
- 화면: 세션 목록(제목·검색), 대화 뷰(메시지 part 렌더, 도구 카드, 승인 카드, 실행 상태), 작업 뷰(run 목록·진행·증거), 설정(연결·기억·예산).
- 입력: `Enter` 전송, `Shift+Enter` 줄바꿈, **`isComposing`/`keyCode 229` 가드로 한글 조합 중 Enter 무시**, 초안은 세션별 localStorage 보존.
- 접근성: 승인 카드에 포커스 트랩, `aria-live`로 스트리밍 상태 안내, 키보드만으로 승인/거부 가능.
- 테스트: 컴포넌트 단위(순수 리듀서 + 렌더 스냅샷 아님), IME 시뮬레이션 테스트(`compositionstart` → Enter → 전송 안 됨).

## 11. 기존 자산 이전

| 자산 | 처리 | 검증 |
|---|---|---|
| `integrations/{gmail,calendar,canvas,google-auth}` | 코드 이전, 커서·동기화 상태 이벤트를 §4 `integration.sync_state`로 정규화 | 실제 계정 1회 수집 + 부분 실패 표시 |
| `knowledge/*`(기억·검색·인용) | 이전, `parts.citation`과 연결 | 정정 epoch 반영 확인 |
| `files/*` | 이전 | 업로드·다운로드·삭제 |
| `scheduler`+Web Push | 이전, `schedule` 트리거를 run 생성으로 통일 | 07:30/21:00 실제 발화 + 기기 수신 |
| `server/{auth,secrets,policy}` | 이전(정책은 core/policy로 이동) | 패스프레이즈 로그인·Origin 검사 |
| `db` 기존 데이터 | 세션·메시지를 새 스키마로 변환(§13) | 대화 1개 왕복 읽기 |

## 12. 웨이브와 작업

각 작업은 독립 커밋·독립 검증이 가능한 단위다. 순서는 의존성 기준이며, 사용자가 순서를 바꿔도 각 작업은 자기 검증으로 성립한다.

### W0 — 기반 (계약·저장·이벤트)
| ID | 작업 | 주 파일 | 검증 명령 | PASS 관찰값 | 증거 |
|---|---|---|---|---|---|
| W0-1 | 앱 스캐폴드·설정 로딩·인증 이전 | `apps/harness/src/server/main.ts`, `contracts/config.ts` | `bun run typecheck && curl -s -o /dev/null -w '%{http_code}' localhost:8787/api/session` | typecheck 0, 응답 `401` | 명령 출력 캡처 |
| W0-2 | 스키마·마이그레이션(§3 전체) | `src/store/migrations/001_core.sql`, `store/db.ts` | `bun test tests/store` | 모든 테이블 생성, 마이그레이션 재실행 멱등 | 테스트 출력 |
| W0-3 | 이벤트 로그·커서 | `src/events/log.ts` | `bun test tests/events` | seq 단조·after 재생·트랜잭션 원자성 3케이스 통과 | 테스트 출력 |
| W0-4 | run 상태 기계 + 리스 | `src/core/run-state.ts` | `bun test tests/core/run-state` | 허용 전이 전부, 금지 전이 거부, 리스 만료→interrupted | 테스트 출력 |
| W0-5 | 정책 판정 단일화 | `src/core/policy.ts` | `bun test tests/core/policy` | allow/ask/deny 3분기 + 저장 승인이 deny 못 이김 | 테스트 출력 |

### W1 — 스트리밍 대화
| ID | 작업 | 주 파일 | 검증 명령 | PASS 관찰값 | 증거 |
|---|---|---|---|---|---|
| W1-1 | 모델 어댑터 스트리밍 | `src/providers/openai.ts` | `bun test tests/providers` | delta 순서, tool_call 인자 조립, truncated→error | 테스트 출력 |
| W1-2 | 대화 실행 계층 루프 | `src/surfaces/conversation/loop.ts` | `bun test tests/conversation/loop` | 도구 1회 왕복, 데드라인 초과 시 aborted | 테스트 출력 |
| W1-3 | SSE 라이브+재개 | `src/server/routes/events.ts` | `curl -N 'localhost:8787/api/events?after=0'` | 라이브 delta 도착, 재접속 시 gap 없음 | curl 출력 |
| W1-4 | React 셸·스트리밍 렌더 | `web/src/App.tsx`, `web/src/session/stream.ts` | `bun run build && bun run qa:chat` | 실제 대화 1턴이 토큰 단위로 렌더 | 브라우저 스크린샷 |
| W1-5 | 입력 규칙(Enter/Shift+Enter/IME) | `web/src/composer/Composer.tsx` | `bun test web/src/composer` | 조합 중 Enter → 미전송, Shift+Enter → 개행 | 테스트 출력 + 수동 확인 |

### W2 — 대화 관리
| ID | 작업 | 주 파일 | 검증 명령 | PASS 관찰값 | 증거 |
|---|---|---|---|---|---|
| W2-1 | 제목 변경·삭제(soft) | `src/server/routes/sessions.ts` | `curl -X PATCH .../sessions/:id -d '{"title":"t"}'` | 200 + 목록 반영 + `session.renamed` | curl + 이벤트 덤프 |
| W2-2 | 편집·재생성·분기 | `src/core/tree.ts` | `bun test tests/core/tree` | 원본 보존, 형제 생성, leaf 이동 | 테스트 출력 |
| W2-3 | 세션 검색(FTS) | `src/store/search.ts` | `curl 'localhost:8787/api/sessions?q=회의'` | 본문 일치 세션 반환 | curl 출력 |
| W2-4 | 클라이언트 대화 관리 UI | `web/src/session/*` | `bun run qa:manage` | 편집 후 분기 표시, 삭제 후 목록 제거 | 스크린샷 |

### W3 — 맥락·시간
| ID | 작업 | 주 파일 | 검증 명령 | PASS 관찰값 | 증거 |
|---|---|---|---|---|---|
| W3-1 | 현재 시각 주입(Asia/Seoul) | `src/core/context.ts` | `bun test tests/core/context` | 프롬프트에 ISO+요일 포함, 시간대 오프셋 정확 | 테스트 출력 |
| W3-2 | 조립 순서·예산·도구 설명 | 같은 파일 | `bun test tests/core/context-budget` | 예산 초과 시 잘림 순서 고정 | 테스트 출력 |
| W3-3 | 압축 | `src/core/compaction.ts` | `bun test tests/core/compaction` | 80% 도달 시 요약 엔트리 생성, 원본 보존 | 테스트 출력 |
| W3-4 | 실제 질의 확인 | 라이브 서버 | `curl -s -X POST .../messages -d '{"text":"오늘 날짜와 요일"}'` | 답변이 실제 KST 날짜와 일치 | 응답 캡처 |

### W4 — 작업 실행 계층
| ID | 작업 | 주 파일 | 검증 명령 | PASS 관찰값 | 증거 |
|---|---|---|---|---|---|
| W4-1 | 워커·리스·리컨사일러 | `scripts/worker.ts`, `src/core/reconciler.ts` | `bun test tests/worker/lease` | 워커 강제 종료 후 45초 내 interrupted 정산 | 테스트 출력 |
| W4-2 | 도구 실행 경계(데드라인·abort) | `src/tools/execute.ts` | `bun test tests/tools/deadline` | 무한 대기 도구가 timeout 결과 반환 | 테스트 출력 |
| W4-3 | 승인 흐름·거부=결과 | `src/core/approval.ts` | `bun test tests/core/approval` | deny 시 tool_result에 사유, 턴 지속 | 테스트 출력 |
| W4-4 | 작업 뷰 UI | `web/src/work/*` | `bun run qa:work` | 진행·승인·실패가 화면에 표시 | 스크린샷 |

### W5 — 위임
| ID | 작업 | 주 파일 | 검증 명령 | PASS 관찰값 | 증거 |
|---|---|---|---|---|---|
| W5-1 | 자식 run 생성·5필드 계약 | `src/core/delegation.ts` | `bun test tests/core/delegation` | 목표·자료·권한·예산·완료조건 누락 시 거부 | 테스트 출력 |
| W5-2 | 진행 요약·완료 인계 | `src/surfaces/work/progress.ts` | `bun test tests/work/progress` | 부모에 요약만, 원본은 자식 로그 | 테스트 출력 |
| W5-3 | 동시 실행 상한·예산 경합 | `src/core/scheduler-queue.ts` | `bun test tests/core/concurrency` | 상한 초과 시 queued + 사유 표시 | 테스트 출력 |

### W6 — 자산 이전·절단
| ID | 작업 | 주 파일 | 검증 명령 | PASS 관찰값 | 증거 |
|---|---|---|---|---|---|
| W6-1 | 연동 이전·동기화 상태 | `src/integrations/*` | `bun run doctor` | 3개 연동 상태 표시, 부분 실패 구분 | doctor 출력 |
| W6-2 | 기억·파일 이전 | `src/knowledge/*`, `src/files/*` | `bun test tests/knowledge` | 정정 반영·인용 검증 통과 | 테스트 출력 |
| W6-3 | 브리핑·푸시 이전 | `src/scheduler/*` | `bun test tests/scheduler && bun run brief --now` | 테스트 0 실패, 브리핑 1건 저장, 기기 푸시 수신 | 테스트 출력 + 수신 캡처 |
| W6-4 | 기존 데이터 변환 | `scripts/migrate-v2.ts` | `bun run migrate --dry-run && bun run migrate` | 대화 N개 왕복 읽기, 원본 무변경 | 변환 리포트 |

### W7 — 병행 운영·절단
| ID | 작업 | 주 파일 | 검증 명령 | PASS 관찰값 | 증거 |
|---|---|---|---|---|---|
| W7-1 | `/app2` 병행 노출 | `Caddyfile.snippet` | `curl -s -o /dev/null -w '%{http_code}' https://.../app2` | 200, 기존 `/` 무영향 | curl 출력 |
| W7-2 | 2주 병행 후 절단 | 운영 문서 | `curl -s -o /dev/null -w '%{http_code}' -X POST https://digithive.chanoil.com/api/conversations` | v2 쓰기 `403`(읽기 전용), `/app2`는 `201` | 두 curl 상태줄 캡처 |
| W7-3 | 되돌림 리허설 | 동일 | `docker compose` 되돌림 | 10분 내 v2 복귀 | 리허설 기록 |

## 13. 마이그레이션·병행 운영·되돌림

- **DB**: 새 스키마를 같은 SQLite 파일에 추가하고, `scripts/migrate-v2.ts`가 `conversations`/`messages`를 `sessions`/`entries`로 변환한다(메시지 1개 = text part 1개). 변환은 idempotent, 원본 테이블은 삭제하지 않는다.
- **병행**: 새 UI를 `/app2`에 두고 2주 병행. 두 표면이 같은 DB를 쓰지 않고, 새 표면만 새 테이블에 쓴다.
- **절단**: 사용자 확인 후 v2 쓰기를 막고(읽기 전용), 새 표면을 `/`로 승격.
- **되돌림**: 이미지 태그 이전 버전으로 복귀 + DB는 추가 테이블만 남기므로 v2 코드가 무시하고 동작한다. 되돌림 후 새 표면의 쓰기는 손실될 수 있음을 명시.

## 14. 검증 전략

| 층 | 방법 | 통과 기준 |
|---|---|---|
| 단위·계약 | `bun test` (core/events/providers/tools) | 실패 0, 신규 테스트가 결함을 실제로 잡음(뮤테이션 1회 확인) |
| 상태 기계 | 전이 표 기반 테이블 테스트 | 허용/금지 전이 전부 커버 |
| 통합 | 로컬 서버 + 실제 모델 1회(소액) | 스트리밍·도구·승인·정산이 한 흐름으로 동작 |
| 화면 | 브라우저 QA(데스크톱·모바일 폭) | 빈 화면·겹침 없음, 한글 조합 Enter 미전송 |
| 운영 | 서버 재시작·워커 kill·네트워크 절단 | 각 경우 상태가 화면에 정확히 표시 |

테스트 통과는 약속의 증명이지 사용 편익의 증명이 아니다(기존 원칙 유지).

## 15. 위험과 대응

| 위험 | 대응 (조사 결함 계열) |
|---|---|
| 영구 `running` | 리스·정산·턴 상한 (§4.3) |
| 멈춘 경계 | 모든 도구·훅에 데드라인 + abort 전파 (§8.3) |
| 침묵 거부 | deny를 tool_result로 강제 (§8.2) |
| 취소 오인 | `cancel_intent` 필수 기록 (§8.1) |
| 파일 연산 고착 | 상태 전이는 DB 트랜잭션, 파일은 참조만 (§3) |
| 정책 우회 | `core/policy` 단일 판정 (§2.2) |
| 언어 표류 | 매 턴 정책 블록 재주입 (§6.1) |
| 가시성 부족 | 3단 이벤트(시작/진행/상세) (§4.1) |

## 16. 남은 사용자 결정

| # | 결정 | 기본값(승인 시 채택) |
|---|---|---|
| 1 | 기본 모델·공급자 | 현재 사용 중인 OpenAI 호환 구성 유지, 설정으로 교체 가능 |
| 2 | 병행 운영 기간 | 2주 |
| 3 | 작업 계층 동시 실행 상한 | 2 |
| 4 | 기존 데이터 변환 시점 | W6 완료 후, 절단 전 |
| 5 | 승인 만료 시간 | 30분 |

## 17. 착수 조건

이 계획은 승인 후 W0-1부터 순서대로 실행한다. 각 웨이브 종료 시 검증 결과와 남은 위험을 보고하고, 다음 웨이브 착수 여부를 확인한다. 배포(§13 절단)는 별도 승인이다.
