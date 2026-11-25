# 다중 계정과 통합 스케줄 구현 계약

## 확정 결정

- D1: 사용자는 “구현을 승인하겠습니다”라고 두 기능의 구현을 승인했다.
  기존 `docs/qa/2026-11-25-repairs.md`의 Supplementary proposals를 구체화한다.
- D2: “데이터 구조를 예쁘게 가져가는 것”을 위해 계정, 소스 상태, 스케줄 정의,
  발화 기록과 실행 상태의 책임을 분리한다. 공통 코어의 작업 큐를 재사용한다.
- D3: Google OAuth에서 읽기 권한을 받되 실제 사용은 계정별 메일/캘린더 스위치로
  정한다. 한 계정의 비활성화가 다른 계정이나 다른 소스에 영향을 주지 않는다.
- D4: 대화는 스케줄 관리와 결과 설명을 맡고, 실제 작업은 워커가 수행한다.
  단발/반복, 결정론적 스크립트/에이전트, 수 시간의 실행을 지원한다.
- D5: 이 세션에서 mini 배포도 승인되어 있다. 별도의 계획 재승인을 기다리지 않는다.

범위 제외: 새 모델 제공자, 기존 OAuth 계정의 동의 자동화, 다중 사용자 테넌시,
일반 워크플로 그래프 편집기, 임의 호스트 셸 명령 실행, 별도 실행 상태 기계.

## 구조와 의존 방향

`store + core ← integrations / scheduler / work ← runtime ← server ← web`.
계정과 스케줄은 서로의 저장소를 직접 변경하지 않는다.
runtime이 계정 수집/브리핑 실행기를 작업 계층에 주입한다.

| 소유자 | 책임 | 소유 데이터 |
| --- | --- | --- |
| integration accounts | 제공자 계정 식별과 연결 | 계정 ID, verified subject, email, label |
| account sources | 계정별 사용 여부와 수집 진도 | enabled, cursor, 성공/시도 시각, 오류 |
| OAuth vault | 암호화 자격 증명 | account_id에 종속된 토큰 |
| collected items | 출처를 잃지 않는 자료 | account_id/source/item_id 복합 키 |
| schedules | 다음 실행의 정의 | trigger, executor, instruction, timeout, next_run_at |
| occurrences | 스케줄이 발화한 사실 | schedule_id, scheduled_for, 단일 run_id |
| runs | 실제 실행의 유일한 상태 | 상태, lease, cancel_intent, 승인, 결과 |

## 데이터 모델과 마이그레이션

출시된 migration 1~5는 수정하지 않고 6, 7을 추가한다. 각 단계는 기존
`migrate()`의 트랜잭션과 `PRAGMA user_version`으로 한 번만 적용한다.

v6:

- `integration_accounts`: ID PK, provider와 검증된 subject의 UNIQUE.
- `account_sources`: `(account_id, source)` PK/FK, enabled와 소스별 독립 cursor.
- `oauth_tokens`: account_id PK/FK. 암호화 payload는 기존 값을 그대로 이전한다.
- `oauth_states`: 일회용 OAuth state, 재연결 대상, 만료 시각.
- `sync_items`: `(account_id, source, item_id)` PK, account_sources로 복합 FK.
- 기존 Google 자료는 `google-default`, Canvas는 `canvas-default`로 이전한다.
  기본 Google의 실제 신원을 알기 전에는 임의로 새 계정과 합치지 않는다.
- 단일 `integration_state`는 제거한다. 이전 테이블을 뷰나 이중 쓰기로 남기지 않는다.

v7:

- `schedules`: ID PK, title, instruction, enabled, trigger/executor JSON,
  timeout_seconds, next_run_at, 생성/수정 시각.
- `schedule_occurrences`: ID PK, schedule_id nullable FK, 제목 snapshot,
  scheduled_for, run_id UNIQUE FK, manual, 생성 시각.
  `(schedule_id, scheduled_for)` UNIQUE가 중복 발화를 차단한다.
- `runs`에 executor_json과 timeout_seconds를 추가한다. 과거 run은 agent로 해석한다.
- 정의를 삭제해도 발화/run 이력은 남는다. 실행 상태를 occurrences에 복사하지 않는다.
- 기존 15분 수집, 07:30/21:00 Asia/Seoul 브리핑을 편집 가능한 기본 스케줄로 이전한다.

## 이벤트와 실행 상태

기존 전역 단조 증가 event seq와 재생/SSE 계약을 유지한다. 추가 이벤트는
`account.updated`, `account.source_updated`, `schedule.created`, `schedule.updated`,
`schedule.deleted`, `schedule.dispatched`다. 실행 경과는 기존 `run.queued`,
`run.started`, `run.heartbeat`, `approval.requested`, `run.settled/failed/interrupted`
이벤트를 사용한다.

자동 발화는 트랜잭션 안에서 정의의 next_run_at, 발화와 run을 함께 갱신한다.
워커 두 개가 경합해도 발화당 run은 한 개다. 실행은 기존 큐의 동시 실행 한도와
짧게 갱신되는 lease를 사용한다. 워커가 죽으면 lease 만료 후 interrupted로 남긴다.
취소는 `cancel_intent=user`를 기록하며 실제 스크립트 프로세스도 종료한다.
승인 대기/거부/만료는 기존 작업 정책을 따른다.

트리거는 once(at), interval(everySeconds, anchorAt),
daily(time, timeZone)다. 재시작 후 interval 누락분은 가장 최근 슬롯 한 번으로
합친다. 같은 스케줄의 실행이 진행 중이면 자동 중첩은 건너뛴다.
실패한 외부 동작을 숨겨서 재시도하지 않는다. “지금 실행”은 명시적 새 발화다.
하루 두 번의 DST 겹침도 같은 local date/time을 두 번 실행하지 않는다.

executor는 agent, builtin(sync_sources/briefing), script(relative path/args)다.
스크립트는 서버 scripts 디렉터리에 한정하고 셸 없이 실행하며 경로 이탈과
심볼릭 링크 이탈을 거부한다. stdout/stderr/exit code와 deadline을 기록한다.
실행 timeout은 1초~24시간이며 lease 시간과 별개다.

## 모델과 클라이언트

모델 어댑터와 비용/스트리밍 계약은 유지한다. 현재 Asia/Seoul 시각은 매 턴 주입하고
기존 맥락 예산과 compaction을 유지한다. 대화에는 계정/소스가 붙은 검색과
스케줄 CRUD 도구를 노출한다. 등록 도구는 정의를 저장하고 오래 실행하지 않는다.
정책 거부나 실행 실패는 도구 결과로 돌아간다.

연결 화면은 계정 목록, 추가/재연결/삭제, 계정별 소스 스위치와 진단을 제공한다.
스케줄 화면은 생성/수정/일시정지/지금 실행/삭제, 다음 시각, 실행 이력과
전체 결과/오류, 취소와 승인을 제공한다. initial unknown은 미연결/빈 목록으로
표시하지 않는다. 폴링 중 편집 내용과 선택은 유지한다.
기존 대화의 Enter/Shift+Enter 및 `isComposing` 입력 가드는 유지한다.
390px와 1440px에서 실제 조작하고 가로 넘침, 잘림, 대비와 실패 상태를 본다.

## 웨이브와 검증

웨이브는 의존 관계 순서다. 계정/스케줄/화면 구현은 공유 계약 이후 병렬화한다.
표의 증거 경로 기준은 `.omo/evidence/accounts-schedules/`다.

| ID | 작업 | 주 파일 | 검증 명령 | PASS 관찰값 | 증거 |
| --- | --- | --- | --- | --- | --- |
| W0-1 | 기존 자료 이전과 복합 키 | store account/schedule migration | `bun test tests/account-migration.test.ts` | 이전 토큰/자료 보존, FK/UNIQUE 경계 검사 통과 | account-tests.txt |
| W1-1 | OAuth 계정과 수집 격리 | integrations, account-routes | `bun test tests/accounts.test.ts tests/sync-contracts.test.ts` | 동일 item ID가 계정별 보존, disabled 소스 네트워크 호출 0 | account-tests.txt |
| W1-2 | 정의와 원자적 발화 | scheduler | `bun test tests/schedules.test.ts` | 경합/재시작에도 슬롯당 run 1개, timezone/DST 검사 통과 | schedule-tests.txt |
| W1-3 | 공통 실행기 | work execution | `bun test tests/schedule-execution.test.ts` | script 성공/실패/취소, agent 승인 회귀 통과 | execution-tests.txt |
| W2-1 | 계정/스케줄 화면 | web | `bun run typecheck && bun run build:web` | exit 0, 실제 브라우저 CRUD와 390/1440 캡처 | browser/ |
| W2-2 | 대화 관리와 워커 연결 | runtime, server, worker | `bun test tests/schedules.test.ts tests/personal-tools.test.ts` | 실제 등록 도구가 정의 저장, 워커가 별도 run으로 완료 | conversation.json |
| W3-1 | 전체 회귀와 자체 리뷰 | harness | `bun run verify && bun run fmt:check` | 모든 검사 exit 0, 실패/중단/격리 증거 확인 | verification.txt |
| W3-2 | mini 교체 배포와 실계정 확인 | deploy | `gh run list --workflow cd.yml --limit 1` | 배포 success, 실계정/기본 스케줄과 HTTPS 200 | deployment.json |

브라우저와 실제 서버/워커 시나리오는 작업 노트에 정확한 URL/조작/입력/관찰값을
실행 전에 기록한다. 검사 통과 후 새 입력 변경이 없는 검사를 반복하지 않는다.

## 배포와 되돌림

검증된 증분을 커밋하고 기존 CI/CD로 mini를 교체한다. v5 데이터 스냅샷을 남긴 후
새 이미지가 v6/v7 마이그레이션을 적용한다. 두 버전을 동시에 운영하지 않는다.
마이그레이션이 있는 만큼 이전 이미지만으로 rollback하지 않고 이전 DB snapshot과
이미지 태그를 함께 복원한다. 스냅샷과 운영 데이터는 QA 임시 자원처럼 지우지 않는다.

| 위험 | 구조적 조치 | 검증 |
| --- | --- | --- |
| 계정별 자료/토큰 뒤섞임 | account FK와 복합 키, verified identity upsert | 같은 message ID의 두 계정과 재연결 테스트 |
| 비활성 소스가 소비됨 | 수집/도구/브리핑이 같은 enabled 상태를 참조 | 소스 토글 후 세 경로 검사 |
| 중복 발화와 장시간 중첩 | 원자적 occurrence/run 생성, UNIQUE, 중첩 skip | 별도 프로세스 경합과 진행 중 슬롯 검사 |
| 죽은 작업이 running 유지 | 기존 lease 정산과 cancel_intent | 프로세스 종료/재시작 시나리오 |
| 임의 스크립트 경로 실행 | scripts root realpath 경계, shell 미사용 | traversal/symlink/취소 검사 |
| 자료 이전 유실 | 단계별 migration 트랜잭션과 운영 snapshot | v5 fixture와 재실행 검사 |

## 남은 결정과 채택 기본값

임의 cron 문법 대신 단발/고정 간격/시간대별 일일 트리거를 먼저 제공한다.
local script는 TypeScript/JavaScript 파일이며 자동 발화의 중첩은 건너뛴다.
기존 동시 실행 상한 2를 유지한다. 추가 Google 계정의 실제 OAuth 동의는 소유자만
할 수 있으므로 코드/와이어 검증과 운영 기존 계정 이전 검증을 구분해 보고한다.
이 기본값으로 승인된 구현을 진행하며, 이미 승인한 구조를 다시 승인받지 않는다.
