# 하네스 비교 — 축별 근거, 역할 구조, 확보 방식, UI 후보

조사일 2026-11-24. 대상 버전은 `sources.md` §2. 표기의 뜻: **지원**(코드·문서 근거 있음) / **부분**(조건부·제한적) / **미지원**(근거 있는 부재) / **미확인**(이번 조사에서 확인하지 못함).

---

## 1. 필수 조건 대조 (계획 §9)

digithive의 필수 조건 7개로 세 하네스와 현재 digithive를 같은 표에 놓았다. 점수 합산은 하지 않는다.

| 필수 조건 | OmO (omo-ai 5.1.65 + senpi 2026.11.6-3) | OpenCode (anomalyco/opencode @8c80aff) | Codex (openai/codex @714bc44) | digithive v2 (현재) |
|---|---|---|---|---|
| 서버 독립 실행 | **지원** — `omo --mode rpc`, multi-session host, `senpi schedule run`. 서버에서 헤드리스로 돌릴 수 있는 RPC 표면이 문서화됨 | **지원** — HTTP 서버 + SDK + 다중 클라이언트(TUI/app/desktop) | **부분** — `app-server` + `exec` 경로. app-server의 일부 승인 흐름은 `experimentalApi` 필요 | **지원** — Bun 서버, `apps/assistant/src/server` |
| PC·모바일 접근 | **부분** — 터미널 TUI 중심, Desktop 앱, 원격 세션(`omo remote`)·메신저 연동은 "Coming soon". 모바일 웹 클라이언트는 미확인 | **지원** — 웹 앱 + 데스크톱 + TUI가 같은 서버에 붙음 | **부분** — TUI 중심, app-server 프로토콜로 외부 클라이언트 가능 | **부분** — 반응형 웹(모바일 뷰포트 메타), 한글 입력 처리 버그 있음 |
| 과정·실패 가시성 | **지원** — 이벤트 종류가 매우 세분화(`message_update`, `tool_execution_*`, `auto_retry_*`, `retry_fallback_exhausted`, `host_stalled`, `session_recovered`) | **부분~지원** — 이벤트 그룹과 SSE 경로 존재, TUI/app이 소비 | **지원** — item 기반 이벤트(추론·명령 출력·승인·오류) | **부분** — 실행 상태 라벨과 도구 없음. 토큰 스트리밍·추론·도구 기록 미구현 |
| 작업 지속성 | **부분** — JSONL 트리 세션 + 스케줄 러너 리스는 강하지만, 위임 작업 정산 실패 사례 다수(#9711, #11269, #11856) | **부분~지원** — 세션 서버 저장, 재접속 SDK | **지원** — 세션 재개·중단(`Interrupt`)·샌드박스 정책 | **부분** — SQLite run 큐 있음. 워커 사망 시 회수 근거 미확인 |
| 승인 집행 | **부분** — 권한 프리셋(`full-access` 기본, `workspace`, `read-only`, `ask`) + 규칙. **샌드박스 없음**(문서 명시). 거부가 결과로 안 돌아오는 결함 #14649 | **지원** — ordered allow/ask/deny, 자원 단위 매칭, `once/always/reject`, 조직 정책 하드 deny | **지원** — 승인 요청이 프로토콜 item, `requirements.toml`의 `prompt-user` 체크포인트, OS 샌드박스(seatbelt/landlock) | **부분** — `awaiting_approval` 상태와 취소 엔드포인트, 승인 정책 세부는 미확인 |
| 개인 자료 보호 | **부분** — 프로젝트 신뢰·비밀 마스킹(텔레메트리), 그러나 로컬 권한으로 전부 접근 가능 | **부분** — `.env` 기본 ask, external_directory 규칙 | **부분~지원** — OS 샌드박스가 주 방어선 | **지원** — 단일 사용자 패스프레이즈 게이트, 정책 모듈 |
| 비용 통제 | **부분** — 모델별 카테고리 라우팅, 폴백, 구독 한도 이벤트. 하드 예산 상한은 미확인 | **미확인** | **미확인** | **지원** — `runtime/budget.ts`, 청구 추정/실청구 분리 |

## 2. 조사 축별 관찰 (계획 §5)

### 2.1 실행 루프와 모델 어댑터
- **OpenCode**: 공급자별 요청 빌드가 `packages/ai`에 모여 있고, 에이전트별 권한·모델 설정이 `packages/schema`에 스키마로 존재. 런타임 의존 방향이 `Schema → Core/Protocol → Server`로 강제된다(`AGENTS.md`).
- **Codex**: Rust 코어. `Op` (클라이언트→서버 의도)와 이벤트(서버→클라이언트)로 분리된 프로토콜. `Op::Interrupt`는 "백그라운드 터미널 프로세스는 죽이지 않고 현재 작업만 중단"으로 문서화되어 있어, **작업 취소와 프로세스 정리**를 구분한다.
- **OmO/senpi**: 엔진이 `agent_start → turn_start → message_* → tool_execution_* → turn_end → agent_end → agent_settled`로 정산 단계를 나눈다. `agent_end`와 `agent_settled`를 분리한 것이 핵심이다(재시도·압축·대기 continuation이 남아 있을 수 있음). 실패는 `retry_fallback_exhausted`, `extension_error`, `transcript_write_failed`로 구분해 내보낸다.
- **digithive**: `agents/provider.ts`는 OpenAI 호환 Chat Completions 1회 호출(`stream: false`), 실패는 `http|timeout|malformed|truncated` 4종으로 축약. 루프·재시도·폴백이 없다.

### 2.2 스트리밍과 실행 가시성
- **OmO/senpi**: 이벤트 약 40종(표는 senpi `docs/rpc.md` §Events). 특히 참고할 것: `agent_settled`(재시도·압축·continuation까지 끝난 상태), `queue_update`(steering/follow-up 큐), `tool_barrier_waiting/expired`(쓰기 도구 간 배리어), `host_stalled`(이벤트 루프 지연), `session_recovered`(세션 파일 마지막 레코드 손상 복구), `session_parked/session_released`(호스트가 세션을 놓는 경로).
- **Codex**: `item` 단위 이벤트(명령 실행·승인·출력) + `EventMsg::TurnAborted`. 클라이언트는 `app-server`에 붙는다.
- **OpenCode**: 이벤트 그룹이 프로토콜에 정의되고, 앱 e2e에 SSE 전송 유틸(`packages/app/e2e/utils/sse-transport.ts`)이 있다.
- **digithive**: SSE 엔드포인트는 **저장된 이벤트 재생**(`eventsAfter`)만 하고, 클라이언트는 종료 상태를 1초 폴링으로 확인한다(`web/app.ts`의 `poll`). 토큰 단위 스트리밍 없음.
- **결론**: 세 하네스 모두 "이벤트를 저장하고, 클라이언트는 커서 이후를 재생"한다. digithive는 이미 이 구조의 절반(저장+재생)을 갖고 있고, 빠진 것은 **라이브 스트림**과 **이벤트 종류의 세분화**다.

### 2.3 대화와 입력 UX
- **OmO/senpi**: 세션이 트리이고 `/tree`로 분기 이동, `/fork`·`/clone`으로 새 파일, 브랜치 요약으로 버려진 가지 맥락 보존. `navigate_tree` RPC가 편집기 텍스트를 돌려주고, `edit_user_message`는 편집을 새 분기로 커밋한다.
- **OpenCode**: `fork`/`revert` 상태 기계를 `packages/app/src/session/`에 두고 테스트(`*-machine.test.ts`)로 고정. UI 상호작용을 순수 상태 기계로 분리한 패턴.
- **Codex**: `Op::Interrupt`로 턴 중단, 세션 재개.
- **digithive**: 대화 생성/목록/메시지만 있다. **제목 변경·삭제·메시지 수정·분기·재생성이 API에도 UI에도 없다**. Enter 처리 코드가 없어 한국어 조합 중 Enter가 폼 제출로 새는 구조다(`web/views/chat.ts`의 폼 + `web/app.ts`의 `submit` 리스너).

### 2.4 맥락과 시스템 지시
- **OmO/senpi**: `buildDynamicSystemPrompt` 등 프롬프트 생성 함수를 패키지로 노출하고(`docs/prompt-presets.md`), cwd·선택 도구·컨텍스트 파일·스킬·표면(terminal 등)을 인자로 받는다. 압축은 물리 창과 활성 예산을 분리하는 방향(#7152)이 논의 중. 언어 표류는 미해결(#11527).
- **Codex**: `docs/agents_md.md`, `docs/config.md`, 환경 정보 조립. 컨텍스트 창 처리는 코어 크레이트.
- **OpenCode**: 압축이 설정 스키마(`config/compaction.ts`)로 존재.
- **digithive**: `buildContext`가 시스템 프롬프트 + 출처 블록(8,000자 예산)만 조립하고 **현재 날짜/시간을 넣지 않는다**. 이번 요구사항("날짜를 메일에서 추론하게 두지 말 것")의 직접 원인이다.

### 2.5 작업 위임과 복구
- **OmO**: `task` 도구가 category(카테고리 워커)와 subagent_type(명명 에이전트)로 분기. 실행 모드는 in-process(기본, 같은 런타임·같은 도구 클로저) / process(격리 프로세스, JSON-RPC로 steer/abort). 백그라운드 완료는 부모 상태(유휴/스트리밍/압축·전환·종료)에 따라 주입 경로가 다르고, 취소는 동기 결과로만 반환하며 완료 알림을 보내지 않는다. 유휴 자식은 15분 후 parking(`persisted_only`/`rpc_detached`), `task_send`로 부활. 팀은 별도 durable inbox + 1초 폴링.
- **복구 실패 사례가 이 구조의 비용을 보여준다**: #9711(정산 안 됨), #11269(EPERM으로 pending 고착), #11856(중단된 실행을 사용자 Stop으로 오인). 즉 "in-process/process 두 러너 + parking/revival + 팀 mailbox"는 강력하지만 상태 기계가 크다.
- **Codex**: `app-server`가 세션을 소유하고 클라이언트가 붙는 구조. 승인·샌드박스가 프로토콜 수준.
- **OpenCode**: `subagent` 권한 액션과 `mode: "subagent"` 에이전트, 부모-자식 권한 상속 규칙 명시("A custom subagent uses its own permissions, not a subset of its parent's").
- **digithive**: `runtime/queue.ts`의 실행 큐 + `executors/{agent,script}`. **위임 개념 자체가 없다**(실행 1개 = 요청 1개). 예약·브리핑은 별도 경로.

### 2.6 도구와 확장
- **OmO/senpi**: TypeScript 확장(도구·명령·이벤트·UI), Skills(에이전트 스킬), MCP 내장 클라이언트, 패키지로 묶어 배포. Skill/도구 후보 목록이 바뀌면 `commands_changed`/`loaded_surfaces_changed` 이벤트로 클라이언트에 알린다.
- **OpenCode**: 플러그인 + 실험 API 규칙(`experimental.*`), SDK 코드젠.
- **Codex**: MCP, `execpolicy` 규칙, `requirements.toml`.
- **digithive**: 도구 3~4개(`agents/tools.ts`), 확장 개념 없음.

### 2.7 권한과 격리
- **OpenCode 문서가 가장 구체적**: `action`×`resource`×`effect` 순서 규칙(last match wins), 자원 단위(`read`, `edit`, `shell`, `skill`, `subagent`, `external_directory`, MCP 도구), 다중 자원 검사 시 "하나라도 deny면 deny, 아니면 ask, 아니면 allow", 승인 응답 3종(`once/always/reject`, reject는 세션의 다른 대기 승인까지 거부), 저장된 승인은 프로젝트 스코프 allow이며 설정된 deny를 이길 수 없음, 조직 정책은 하드 deny.
- **Codex**: 승인이 프로토콜 item, `prompt-user` 체크포인트는 세션/영구 승인으로 대체 불가, OS 샌드박스.
- **OmO/senpi**: 문서가 스스로 "프리셋은 격리 경계가 아니다. 부분적 in-process 샌드박스는 오해를 부르므로 두지 않는다. 실제 격리는 OS/컨테이너 경계에서"라고 명시. digithive의 "승인 경계 + 컨테이너 실행" 방향과 같은 결론이다.

### 2.8 기억과 자료 수명
- **OmO**: 기억 도구 + Kibitzer(읽기 전용 회상 판정자, 비밀 마스킹, 최대 2회 동시 기상), 세션 트리·압축 엔트리·`ContextEditEntry`로 맥락 편집 이력 보존.
- **Codex/OpenCode**: 세션 저장이 중심, 기억은 사용자 파일(AGENTS.md 등) 기반.
- **digithive**: 메모리 FTS + 정정 epoch, 파일 저장소, 인용 검증(`validCitations`). 구조는 이미 "출처 있는 기억"에 가깝다.

### 2.9 운영과 비용
- **OmO**: 자체 호스트/워커/데몬 계층이 있어 운영 개념이 많다(`omo daemon`, `host_stalled`, `host_memory_pressure`, `host_trimmed`). 그만큼 장애 유형도 많다(open issues 3,069).
- **OpenCode**: 모노레포 패키지 수 40여 개, 이슈 4,026. 기능은 풍부하지만 유지 비용은 사용자 몫.
- **Codex**: Rust + Bazel, 이슈 28,435(사실상 토론장). 성숙도 높음, 확장 비용 높음.
- **digithive**: 코드베이스가 작고(핵심 파일 합계 약 1.9천 줄) 운영 표면이 좁다. 예산·비용 추적이 이미 있다.

### 2.10 UI 기술과 코드 구조
- **OpenCode**: 웹 앱은 **SolidJS + Kobalte**(`packages/app/package.json`), TUI는 별도 패키지(`@opencode/tui` + `@opencode/ui`), 데스크톱 별도. 클라이언트는 Core/Server를 import하지 못하고 Schema/Protocol만 쓴다 — 의존 방향이 문서 규칙으로 강제됨.
- **Codex**: TUI(Rust) + app-server 프로토콜. 클라이언트는 프로토콜만 안다.
- **OmO**: TUI는 엔진(senpi) 소유, OmO는 확장·패널·데스크톱을 얹는다.
- **digithive**: 프레임워크 없이 `document.createElement`로 렌더(`web/app.ts`). 테스트 ID 중심.

## 3. 두 역할(대화 / 백그라운드 작업) 구조 비교 (계획 §6)

코드 공유와 실행 인스턴스 공유를 분리해 본다.

| 대안 | 코드 공유 | 실행 인스턴스 | 이점 | 부담 |
|---|---|---|---|---|
| **A. 하나의 강력한 하네스 공유** | 전부 | 세션·프로세스·큐 공유 | 도구·정책·기록 일관성, 구현 중복 0 | 대화 지연(도구 루프가 대화 턴을 잡음), 맥락 오염, 승인 피로, 장애 격리 없음. OmO가 이 모델의 극단이며 이슈 수가 그 비용을 보여준다 |
| **B. 완전히 별개의 하네스** | 없음 | 분리 | 역할별 최적화, 독립 배포 | 상태 불일치, 인계·승인·결과 연결을 매번 새로 만든다. digithive 규모(1인)에서 중복 구현 비용이 이득을 넘을 가능성이 큼 |
| **C. 공통 코어 + 역할별 실행 계층** | 도메인·이벤트·저장·모델 어댑터 | 세션·큐·프로세스·권한·예산 분리 | 기반 재사용 + 격리. 세 하네스가 실제로 채택한 형태(엔진 코어 + TUI/앱/서버/워커) | 공통 계약의 복잡성, 버전 결합, 추상화 유지 비용 |

**판단**: C를 권고하되, "모듈러라서 안전하다"는 이유가 아니라 **세 하네스가 독립적으로 같은 형태로 수렴했다는 증거** 때문이다. Codex는 `core` + `app-server`/`exec`, OpenCode는 `Core/Protocol/Server` + 다중 클라이언트, OmO는 `senpi` 엔진 + in-process/process 러너. 다만 C의 실패 모드는 OmO 사례가 잘 보여준다: 공통 계약이 커질수록 **정산·취소·재개 상태 기계**가 복잡해진다. digithive는 그 상태 기계를 지금 5~6개 상태로 유지하고, 늘릴 때 근거를 요구해야 한다.

### 3.1 반드시 정해야 할 경계 (계획 §6.2) — 현재 상태
| 경계 | digithive 현재 | 결정 필요 |
|---|---|---|
| 요청·목표의 소유자, 완료 판정 주체 | run 1개. 완료는 워커가 기록한 status | 대화 턴과 작업 run의 관계를 1:N으로 열 것인가 |
| 위임 시 전달할 목표·자료·권한·예산·완료 조건 | 위임 없음(대화 메시지가 곧 run.goal) | 위임 도입 시 5개 필드 명시 |
| 진행 이벤트·결과·오류 전달, 순서·중복·재연결 | `seq` 기반 이벤트 + `after` 재생 | 라이브 스트림 추가 시 seq 규약 유지 |
| 실행 중 질문·승인·지시 변경·취소 연결 | `awaiting_approval`, `cancel` | 승인 결정을 어느 run에 귀속시킬지 |
| 편집·분기·삭제·기억 정정의 영향 | 해당 기능 없음 | 도입 시 "이미 실행 중인 run"의 참조 규칙 |
| 동시 작업 간 자료·승인·예산 격리 | 예산 파일 1개(`runtime/budget.ts`) | run별/일별 예산 축 |
| 클라이언트 종료·서버 재시작·워커 장애 후 재개 | 재생 + 폴링 | 워커 리스/회수 |
| 결과 파일·출처·검증 근거 인계 | 인용 검증만 | 작업 산출물의 계보 |
| 모델 판단 vs 스크립트·정책 보장 | 일부(인용 검증, 예산) | 정책 집행 지점 목록화 |

## 4. 하네스 확보 방식 비교 (계획 §9.1)

| 방식 | 조건 | OmO 채택 | OpenCode 채택 | Codex 채택 | 자체 구축 |
|---|---|---|---|---|---|
| 라이선스 | — | **Sustainable Use License**: "personal use" 허용, 배포는 무료·비상업만, 서브라이선스 불가, 수정 시 고지 의무 | MIT | Apache-2.0 | 해당 없음 |
| 서버·모바일 | — | RPC/원격은 있으나 모바일 웹 클라이언트 미확인 | 앱+서버 구조로 가장 적합 | app-server로 가능하나 클라이언트를 직접 만들어야 함 | 직접 구현 |
| 개인 비서 적합성 | 브리핑·예약·기억 | 스케줄·기억·원격이 있으나 코딩 중심 어휘·프롬프트 | 코딩 에이전트 중심 | 코딩 에이전트 중심 | 요구에 정확히 맞출 수 있음 |
| 유지 비용 | — | 높음(3천 open issues, 자체 호스트 계층) | 높음(4천, 40패키지) | 높음(Rust+Bazel, 28k) | 낮음(작은 코드베이스 유지) |
| 되돌림 비용 | — | 엔진 전환·롤백 사례 존재(#10905, #7728) | 중간 | 높음 | 낮음 |
| 저비용 모델 호환 | 도구·스트리밍 호환 | 공급자 다수 지원 | 공급자 다수 + 커스텀 프로바이더 문서 | OpenAI 중심, 커스텀 가능 | 직접 구현(OpenAI 호환) |

**관찰**: 세 제품 모두 "코딩 에이전트"이며, digithive의 요구(대화 중심·모바일·브리핑·승인)와는 어휘와 표면이 다르다. OmO는 이미 digithive 운영에 쓰이고 있으므로(현재 세션) **백그라운드 작업 역할**에는 실사용 근거가 있다. 반면 **대화 역할**에 OmO를 그대로 노출하는 것은 터미널·코딩 어휘·승인 피로 문제가 있다.

## 5. UI 후보 비교 (계획 §9.2)

| 후보 | 스트리밍·도구 UI 지원 | 대화 관리(분기·편집) | 한글 입력·모바일 | 유지·생태계 | 비용 |
|---|---|---|---|---|---|
| 현 DOM 방식 유지 | 없음(직접 구현) | 없음 | 직접 처리 | 의존성 0, 생태계 없음 | 가장 작게 시작, 기능 늘수록 급증 |
| **React + assistant-ui** | 런타임이 스레드·스트림·도구를 소유("The runtime owns the thread, the stream, and the tools"), 백엔드 어댑터 | 브랜치·편집 프리미티브 제공 | 생태계 성숙, IME 이슈 라이브러리 많음 | 가장 큼 | 중간 |
| React + Vercel AI SDK UI | `useChat` + `UIMessageStreamResponse` (React 훅 중심) | 직접 구현 | 동일 | 큼 | 중간 |
| Solid (OpenCode 방식) | 직접 구현(OpenCode가 실증) | `fork/revert` 상태 기계 패턴 참고 | 생태계 작음 | 중간 | 중간 |
| Svelte 5 / SvelteKit | 직접 구현 | 직접 구현 | 생태계 중간 | 중간 | 중간 |
| Web Components(aparte) | 스트리밍·도구·첨부·분기 내장, React/Vue/Svelte/Angular 어댑터 | 내장 | 확인 필요 | 작음 | 낮음(도입) |

**판단 기준**: 이 결정의 실제 위험은 렌더러가 아니라 **스트리밍 상태·메시지 트리·도구 기록을 누가 소유하는가**다. 그 소유권을 라이브러리에 줄 수 있으면(assistant-ui/AI SDK) 렌더러 선택은 2차 문제가 된다. digithive는 단일 사용자·장기 유지가 목표이므로, 라이브러리 의존이 늘어나는 것과 직접 구현 유지비를 같은 축에서 비교해야 한다.
**미확인**: 각 후보의 실제 한글 IME 조합 중 Enter 처리 품질, 모바일 스크롤·접근성. 이번 조사는 문서 근거까지만 확인했다.

## 6. digithive 격차 분석 (계획 §8 시나리오)

| 시나리오 | 현재 관찰 (코드 근거) | 격차 |
|---|---|---|
| 현재 날짜·오늘 일정 질문 | `agents/context.ts`는 시스템 프롬프트+출처만 조립. 날짜 주입 없음 | **치명** — 모델이 메일 날짜로 추론 |
| 메일·LMS 자료로 조사·초안 위임 | 검색·인용은 있으나 위임·산출물 계보 없음 | 큼 |
| 긴 작업 중 별도 질문 | 런 큐가 직렬. 대화 턴이 run과 분리되어 있지 않음 | 큼 |
| 실행 중 수정·취소 | `POST /api/runs/:id/cancel`만 | 중간 |
| 승인 대기 중 재접속 | `awaiting_approval` 상태 존재, 승인 UI 세부 미확인 | 중간 |
| 스트리밍 중 연결 단절·새로고침 | 이벤트 `seq` + `after` 재생으로 복원 가능. 단 재생은 1회성 응답이고 라이브 아님 | 중간(구조는 이미 맞음) |
| 메시지 편집·분기·재생성 | API·UI 모두 없음 | 큼 |
| 대화 삭제·기억 정정 | 대화 삭제 없음. 기억 정정 epoch는 있음 | 중간 |
| 서버 재시작·도구 실패·한도 도달 | 예산·시도(`runtime/attempts.ts`) 있음. 워커 사망 회수 미확인 | 중간 |
| 모바일 입력·결과 확인 | Enter 처리 없음, IME 가드 없음, 제목 갱신 없음 | **즉시 수정 가능** |
| 예약 작업과 사용자 작업 동시 | 스케줄러 존재(07:30/21:00), 우선순위·예산 경합 규칙 미확인 | 중간 |
