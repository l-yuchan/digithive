# digithive 하네스 재설계 조사 보고서

조사일 2026-11-24 (KST). 조사 계획: `docs/harness-research-plan.md`.
세부 근거: `sources.md`(대상·출처), `case-studies.md`(이슈 추적), `comparisons.md`(축별·대안 비교), `architecture-options.md`(구조 권고), `validation.md`(실행·미실행 기록).
이 보고서는 **구현 명세가 아니다.** 승인 결정을 위한 근거 문서다.

---

## 0. 핵심 결론

1. **세 하네스는 같은 형태로 수렴했다.** 실행 코어 하나 + 다중 표면(터미널/웹/데스크톱/서버) + 서버가 소유하는 세션 + 클라이언트는 커서 이후 이벤트만 재생. OmO(senpi 엔진 + RPC), OpenCode(HTTP 서버 + SDK + Solid 앱), Codex(`core` + `app-server` 프로토콜) 모두 그렇다. digithive는 이미 이 구조의 절반(서버·SQLite·seq 이벤트 재생)을 갖고 있고, 빠진 것은 **라이브 스트리밍·메시지 part 구조·대화 관리·현재 시각 주입**이다.
2. **위험은 "기능 부족"보다 "정산되지 않는 상태"에 있다.** OmO 이슈 10건을 따라간 결과 반복 결함은 (a) 종료 이벤트가 오지 않을 때의 영구 `running`, (b) 경계에 데드라인·abort 부재, (c) 거부·취소를 결과로 모델링하지 않음, (d) 단일 파일 연산에 걸린 상태 전이, (e) 정책이 프롬프트·진입점마다 재해석됨이다. 하네스 교체 여부와 무관하게 이 다섯 가지는 digithive가 먼저 갖춰야 한다.
3. **두 역할은 "공통 코어 + 역할별 실행 계층"이 근거상 우세하다.** 단, "모듈러라서 안전"이 아니라 세 제품이 독립적으로 같은 분리를 택했다는 점과, digithive는 인력이 1인이라 코어를 둘로 나눌 여유가 없다는 점이 근거다. OmO처럼 복잡한 실행 상태 기계(parking/revival/팀 mailbox)를 그대로 들여오는 것은 권하지 않는다.
4. **기존 하네스 채택은 백그라운드 작업 역할에 한해 현실적이고, 대화 역할에는 부적합하다.** OmO는 라이선스가 Sustainable Use(개인 사용 허용·재배포 제한)이고, 무엇보다 코딩·터미널 어휘와 승인 피로가 대화 제품의 표면과 맞지 않는다. OpenCode는 MIT이고 서버·다중 클라이언트 구조가 가장 가깝지만 코딩 에이전트다.
5. **UI 결정은 렌더러가 아니라 상태 소유권 문제다.** 스트리밍·메시지 트리·도구 기록을 런타임이 소유하는 라이브러리(assistant-ui, Vercel AI SDK UI)를 쓰면 렌더러 선택은 2차 문제가 된다. OpenCode 자체는 SolidJS로 만들었고, 프레임워크 무관 Web Components(aparte)도 선택지다.

## 1. 대상과 방법

| 대상 | 확정한 것 |
|---|---|
| OmO | `omo-ai` 5.1.65 + senpi 엔진 2026.11.6-3. 저장소 `oh-my-openagent` HEAD `06011dfd` (repo 5.1.83), `senpi`는 `badlogic/pi-mono` 포크 |
| OpenCode | `anomalyco/opencode`(구 `sst/opencode`) HEAD `8c80aff9`, MIT |
| Codex | `openai/codex` HEAD `714bc44f`, Apache-2.0, Rust |

이슈 검색은 OmO에 집중했다(계획 §7). OpenCode·Codex는 코드·문서 근거만 쓴다. 접근 제약과 실행 관찰 기록은 `validation.md`.

## 2. OmO — 관찰

- **계층 경계**: OmO(`omo-ai`)는 확장·도구·정책·위임을 얹고, 실행·세션·이벤트는 엔진 `senpi`가 소유한다. 엔진 문서가 RPC 명령·이벤트를 공개 계약으로 정의한다(`docs/rpc.md`).
- **세션 모델**: JSONL 트리. 엔트리 종류가 `SessionHeader`, `SessionMessageEntry`, `ModelChangeEntry`, `CompactionEntry`, `ContextEditEntry`, `BranchSummaryEntry`, `CustomEntry` 등으로 나뉘고, `/tree`(같은 파일 안 분기), `/fork`·`/clone`(새 파일)이 구분된다. RPC `navigate_tree`는 편집기로 되돌릴 텍스트를 반환하고 `edit_user_message`는 편집을 새 분기로 커밋한다. **digithive가 그대로 베낄 만한 데이터 모델이다.**
- **이벤트**: 약 40종. `agent_end`(저수준 1회 실행 종료)와 `agent_settled`(재시도·압축·대기 continuation까지 모두 끝남)를 분리한 것이 핵심 설계다. `tool_barrier_waiting/expired`(쓰기 도구 간 배리어), `host_stalled`, `session_recovered`, `retry_fallback_exhausted`, `queue_update`(steering/follow-up 큐) 등 실패·정산 상태가 1급 시민이다.
- **위임(`task`)**: category 경로와 subagent_type 경로가 배타적이고, 실행 모드는 in-process(부모 도구 클로저 재사용, task/team/dag 도구만 제외) 또는 process(JSON-RPC steer/abort, 트랜스크립트 분리). 백그라운드 완료는 부모 상태(유휴/스트리밍/압축/종료)에 따라 주입 경로가 다르고, 취소는 동기 결과로만 반환한다. 유휴 자식은 15분 후 parking, `task_send`로 부활.
- **권한**: 프리셋(`full-access` 기본)은 확인 정책일 뿐 격리 경계가 아니라고 문서가 스스로 밝힌다. 실제 격리는 컨테이너/VM에서.
- **라이선스**: **Sustainable Use License** — "personal use" 허용, 배포는 무료·비상업, 서브라이선스 불가, 수정 시 고지 의무. digithive 1인 사용은 허용 범위. 재배포·서비스화는 조건부.
- **비용 구조**: self-host 데몬, 호스트 리스, `host_stalled`/`host_memory_pressure`/`host_trimmed` 같은 운영 이벤트가 있다. 운영 개념이 많다는 뜻이고, 그만큼 유지 부담이 크다(open issues 3,069).

## 3. OpenCode — 관찰

- **의존 방향이 규칙으로 강제된다**: `Schema → Core/Protocol → Server`, 클라이언트는 `Schema/Protocol`까지만 import, `sdk`가 합성. 40여 패키지의 모노레포에서 이 규칙이 없으면 붕괴한다.
- **권한 모델이 가장 정교하다**(공식 문서): `action`×`resource`×`effect` 순서 규칙, last-match-wins, 자원 단위(`read`/`edit`/`shell`/`skill`/`subagent`/`external_directory`/MCP 도구), 다중 자원이면 "하나라도 deny면 deny", 승인 응답 `once/always/reject`(reject는 세션의 다른 대기 승인까지 거부), 저장된 승인은 프로젝트 스코프 allow이며 설정된 deny를 이길 수 없고, 조직 `policies`가 하드 deny.
- **대화 UX가 상태 기계로 분리되어 있다**: `packages/app/src/session/fork.ts`, `revert.ts`, `fork-machine.ts`, `revert-machine.ts` + 테스트. UI 상호작용(분기·되돌리기)을 순수 상태 기계로 떼어낸 패턴은 digithive가 참고할 만하다.
- **UI 스택**: 웹 앱은 SolidJS + Kobalte(`@dnd-kit/solid` 등), TUI·데스크톱은 별도 패키지. 서버·클라이언트가 같은 HTTP/SDK 계약을 쓴다.
- **이벤트**: `packages/protocol/src/groups/event.ts`가 Effect HttpApi 기반 이벤트 그룹과 `rpc.*` 이벤트 타입을 정의.

## 4. Codex — 관찰

- **프로토콜 분리가 명시적**: `Op`(클라이언트→서버 의도)와 이벤트(서버→클라이언트)로 나뉘고, `Op::Interrupt`는 "백그라운드 터미널 프로세스는 죽이지 않고 현재 작업만 중단"으로 문서화되어 있다 — **작업 취소와 프로세스 정리 분리**.
- **승인이 프로토콜 item이다**: `codex-rs/protocol/src/approvals.rs`에 `PermissionProfile`, `ReviewDecision`, `RequestPermissionProfile` 등이 정의되고, `app-server`가 `item/commandExecution/requestApproval`을 보낸다. `requirements.toml`의 `prompt-user` 체크포인트는 세션·영구 승인으로도 우회되지 않으며 `experimentalApi`/`requiredHumanApproval`을 요구한다.
- **격리는 OS 경계**: `codex-rs/sandboxing`, `execpolicy`, `requirements.toml`. 이는 senpi 문서의 결론("부분적 in-process 샌드박스는 오해를 부른다")과 같은 방향이다.
- **클라이언트**: TUI + `app-server`(stdio/전송 계층 분리). digithive가 Codex를 직접 재사용하는 것은 Rust 코어 의존을 뜻하므로 현실성이 낮다.

## 5. 반복 결함 계열 (OmO 이슈 추적)

`case-studies.md`의 10건에서 추출한 계열:

| 계열 | 사례 | 확인된 수정 상태 |
|---|---|---|
| 정산되지 않는 상태 | #9711(자식이 한도 후 `running`), #14329(스트림 중단 시 Working forever), #14649(거부된 도구 호출 무응답) | 엔진 수정 #11388·senpi#7270 진행/게이트 대기 |
| 경계에 데드라인·abort 부재 | #14354(훅 정지 → 세션 정지, Esc 무효), #14543(기억 도구 1시간 27분 정지) | 둘 다 수정·검증됨(5.1.81) |
| 거부·취소를 결과로 모델링하지 않음 | #14649, #11856(중단된 실행을 사용자 Stop으로 오인) | 미완 |
| 단일 파일 연산에 걸린 상태 전이 | #11269(EPERM → pending 영구) | open |
| 정책이 진입점마다 재해석 | #13016(CLI·SDK가 공용 해석기 우회), #11527(압축 후 언어 표류) | open |
| 가시성 부족 | #7288(동기 서브에이전트 진행 미전달), #14493(폴링 10 s vs ≤5 s) | open |

**교훈**: 하네스를 새로 만들든 채택하든, 이 여섯 계열을 설계 체크리스트로 강제해야 한다(`architecture-options.md` §5).

## 6. digithive 기준선과 격차

현재 v2 코드(`apps/assistant/src`)에서 확인한 사실:

| 항목 | 사실 | 근거 |
|---|---|---|
| 모델 호출 | OpenAI 호환 Chat Completions 1회, `stream: false` | `agents/provider.ts` |
| 오류 분류 | `http|timeout|malformed|truncated` | 같은 파일 |
| 시스템 프롬프트 | 시스템 프롬프트 + 출처 블록(8,000자 예산). **현재 날짜·시간대 없음** | `agents/context.ts` |
| 메시지 저장 | `messages(id, role, content, run_id, ...)` 단일 문자열. 도구 호출·추론·part 없음 | `db/migrations/001_initial.sql`, `server/routes/conversations.ts` |
| 대화 API | 생성·목록·메시지 조회/추가·run 목록만. 제목 변경·삭제·수정·분기·재생성 없음 | 같은 파일 |
| 이벤트 전송 | SSE 1회 재생(`eventsAfter`), 이후 1초 폴링 | `web/app.ts` `poll` |
| 입력 | textarea + form submit. Enter/Shift+Enter 처리 없음, IME 조합 가드 없음 | `web/views/chat.ts`, `web/app.ts` |
| 승인·취소 | `awaiting_approval` 상태, `POST /api/runs/:id/cancel` | `runtime/queue.ts`, `server/routes/runs.ts` |
| 예산 | 추정·실청구 분리 | `runtime/budget.ts` |

격차 우선순위(판단): (1) 현재 시각·시간대 주입, (2) 스트리밍과 part 구조, (3) 대화 관리(제목·삭제·편집·분기), (4) 한글 IME·Enter, (5) 위임/백그라운드 작업 계약.

## 7. 두 역할 구조 결론

세 대안 비교는 `comparisons.md` §3. 결론:

- **A(하나의 하네스 공유)**: OmO가 실증. 힘은 크지만 상태 기계가 크고 실패 계열이 그대로 사용자에게 간다. digithive 인력(1인)에 비해 유지 부담이 크다.
- **B(완전 분리)**: 장애 격리는 최고. 그러나 run·예산·기억을 두 번 모델링하게 된다.
- **C(공통 코어 + 역할별 실행 계층)**: 권고. 대화 실행 계층은 빠른 턴·조회 도구·승인 요청 중심, 작업 실행 계층은 긴 루프·쓰기·검증·증거. 세션·큐·권한·예산은 분리.

"모듈러는 절충안이라 안전하다"는 이유로 고른 것이 아니다. 세 제품이 같은 분리를 독립적으로 택했다는 증거와, 실패가 집중되는 지점(정산·취소·재개)을 한 곳에서 관리해야 한다는 점이 근거다.

## 8. 확보 방식 결론

| 방식 | 판단 |
|---|---|
| OmO 채택(대화+작업 모두) | **비권장** — 코딩·터미널 표면, 승인 피로, Sustainable Use 라이선스, 3천 open issues |
| OmO 채택(작업 역할만, 현재처럼) | **현실적** — 이미 실사용 중. 단 위임 작업의 정산 실패(#9711 계열)를 digithive 쪽에서 리스로 감싸야 한다 |
| OpenCode 코어/프로토콜 재사용 | **검토 가치 있음** — MIT, 서버/클라이언트 구조, 권한 모델 문서가 가장 정교. 다만 TypeScript 모노레포 40패키지 의존은 부담 |
| Codex 재사용 | **비권장** — Rust 코어, 클라이언트를 직접 만들어야 함 |
| 자체 구축(현 코드 확장) | **권고** — 코드베이스가 작고, 이미 서버·이벤트 재생·예산·기억이 있다. 부족한 부분은 위 격차 목록 |

## 9. UI 결론

- 스트리밍·메시지 트리·도구 기록의 소유권을 라이브러리에 넘길 수 있는지가 1차 기준이다.
  - assistant-ui: React 런타임이 스레드·스트림·도구를 소유, 백엔드 어댑터.
  - Vercel AI SDK UI: `useChat` + `UIMessageStreamResponse`, React 훅 중심.
  - aparte: Web Components, 스트리밍·도구·첨부·분기 내장, React/Vue/Svelte/Angular 어댑터.
- 렌더러 비교: React(생태계 최대) vs Solid(OpenCode 실증, 생태계 작음) vs Svelte 5/Kit(중간).
- **판단**: React + (assistant-ui 또는 AI SDK UI 런타임)이 유지비·생태계·에이전트 도구 지원에서 가장 방어적이다. 단, 이 결정은 1차 결정(상태 소유권)의 결과이므로 지금 확정하지 않고 상세 계획에서 확정할 것을 권한다. 현 DOM 방식 유지는 단기 수정(IME)에는 적합하지만 분기·편집·스트리밍이 들어오면 급격히 비싸진다.

## 10. 가벼운 구현 제안 (승인 이후 상세 계획 대상)

1. **현재 시각·시간대 주입** — 시스템 프롬프트 조립에 `Asia/Seoul` 현재 시각을 매 턴 넣는다. 가장 작고 효과가 확실한 수정.
2. **스트리밍 + part 구조** — 모델 어댑터에 스트리밍을 추가하고 메시지를 part(text/reasoning/tool_call/tool_result/error)로 저장. 이벤트 로그는 이미 있으므로 SSE 라이브 전송과 커서 재개만 붙인다.
3. **대화 관리** — 제목 변경·삭제·메시지 편집·분기·재생성. 데이터는 OmO의 트리 엔트리 모델을 축소해 채택.
4. **입력 품질** — IME 조합 중 Enter 무시, Shift+Enter 줄바꿈, 초안 보존. 즉시 가능.
5. **작업 실행 계층 분리** — run에 리스·정산 규칙·거부 결과를 추가하고, 대화 턴과 run을 1:N으로 연다.

## 11. 미확인·남은 위험

- 세 하네스의 **실제 실행 비교**는 하지 않았다(설치·동일 시나리오 구동 없음).
- Codex의 컨텍스트 조립·확장 세부, OpenCode의 세션 저장 스키마 세부는 근거가 얕다(위임 조사 실패).
- OmO 이슈의 수정이 현재 설치본(5.1.65)에 반영됐는지 미확인(검증은 5.1.81 기준).
- UI 후보별 한글 IME·모바일 접근성 실측 없음.
- digithive 승인 결정이 실행 결과로 반영되는 경로(`server/policy.ts`)는 이번에 읽지 않았다.

## 12. 조사 비용

- 유료 모델 호출 0회. tinyfish 검색·fetch 수 회, GitHub API 수십 회. 비용은 사실상 0에 가깝다.
- 사람 시간: 단일 세션에서 수행. 위임 조사 3건은 실패로 손실.

## 13. 사용자 결정이 필요한 것

1. 두 역할 구조: C(공통 코어 + 역할별 실행 계층)로 갈 것인가, 아니면 대화만 먼저 개선하고 위임은 후순위로 둘 것인가.
2. 작업 역할에 OmO를 계속 쓸 것인가(현행 유지), 아니면 자체 작업 실행 계층으로 흡수할 것인가.
3. UI: React + 채팅 런타임으로 갈 것인가, 현 DOM을 단계적으로 확장할 것인가.
4. 상세 구현 계획을 작성할 범위(1번 또는 2번 항목부터).
