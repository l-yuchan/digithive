# digithive-v2 - Work Plan

## TL;DR (For humans)
<!-- Fill this LAST, after the detailed plan below is written, so it summarizes the REAL plan. -->
<!-- Plain English for a non-engineer: NO file paths, NO todo numbers, NO wave/agent/tool names. -->

**Who this is for and what changes for them:** PC와 모바일에서 대화로 일을 맡기고, 개인 일정과 관련 정보를 함께 챙기려는 사용자 한 명을 위한 계획이다. 대화를 닫아도 서버가 일을 이어가고 결과와 실패를 확인할 수 있게 한다.

**What you'll get:** 일정·메일·학교 정보를 연결한 아침·저녁 브리핑과 긴급 푸시, 자동 기억, 내부 파일 저장소, 조사·초안 작성, 승인 후 도구 개선을 구현한다.

**Why this approach:** 반복 확인은 스크립트로, 해석과 조사는 AI로 수행하되 같은 작업 기록과 권한 검사를 사용한다. 정보의 출처와 변경 이력을 보존해 잘못된 기억과 실패를 고칠 수 있게 한다.

**What it will NOT do:** 승인 없이 외부에 행동하거나 운영 환경을 바꾸지 않는다. 고정된 에이전트 인격이나 네이티브 앱, 메신저·교통 연결을 첫 구현에 추가하지 않는다.

**Effort:** XL
<!-- Effort is exactly ONE band, never hours/days. Quick = single edit, minutes of agent work; Short = one focused change, a few files; Medium = multi-file feature in one session; Large = several waves, one long session; XL = multi-session or architectural work. A written duration is rewritten to a band. -->
**Risk:** High — 실제 계정 인증, 장기 실행 복구와 푸시 수신은 실제 서버·기기에서 검증해야 한다.
**Decisions to sanity-check:** 한국 시간, 15분 수집, 비용 경고·정지 기준은 설정 가능한 제안값이다. 실제 계정 연결·유료 호출·공개 배포는 준비와 승인을 거쳐 수행한다.

Your next move: 계획 검토 결과와 제안값을 확인한 뒤 실행을 별도로 지시한다. 이번 문서는 제품 구현이나 배포 완료 보고가 아니다.

---

> TL;DR (machine): XL / High / 새 서버형 비서 전체 구현, 25개 작업, 5개 구현 wave, 4개 최종 검증.

## Scope
### Affected user and ideal state
<!-- From the draft ledger: who this touches and how they use the result, then one IS row per property with its reason, then one GAP row per difference with its reason. Every todo below closes a GAP row; ## Success criteria proves every IS row. -->
**Affected user:** 개인 사용자 한 명은 PC·모바일에서 대화하고 서버에 일을 맡긴다. 구현자는 이 문서만으로 구현·검증 순서를 결정할 수 있어야 한다. 현재는 키워드 중심 프로토타입과 기능 명세만 있으며 v2 앱은 없다.

| Row | Statement | Reason |
| --- | --- | --- |
| IS-1 | 대화·조사·초안 작업을 서버에서 이어가고 결과와 실패를 확인한다 | 클라이언트와 작업 수명을 분리 |
| IS-2 | Calendar·Gmail·LMS 정보를 출처·시점과 함께 연결한다 | 일정 준비에 필요한 실제 정보 |
| IS-3 | 07:30·21:00 브리핑과 다음 브리핑 전에 시급한 변화만 푸시로 받는다 | 일정 중심의 절제된 능동성 |
| IS-4 | 자동 기억을 확인·정정·삭제하고 이후 행동에 반영한다 | 노트 입력 부담 없이 맥락 유지 |
| IS-5 | 내부 파일을 업로드·탐색·다운로드하고 산출물을 찾는다 | 클라우드처럼 접근 가능한 저장소 |
| IS-6 | 반복 스크립트와 AI가 같은 예약·내구성·취소 계약으로 실행된다 | 모델을 쓰지 않아도 되는 반복 작업 분리 |
| IS-7 | 외부 영향·작업 환경 변경을 통제하고 비용을 확인한다 | 명시적 승인과 월 100달러 부담 기준 |
| IS-8 | 별도 서버에서 인증·백업·복원·상태 점검과 실제 사용 검증을 수행한다 | 실행 가능한 개인 비서 기반 |
| GAP-1 | 새 앱·인증·계약·파일 경계 부재 | 작업 1–5 |
| GAP-2 | 실행 복구·도구·모델·대화·기억 부재 | 작업 6–10 |
| GAP-3 | 실제 개인 정보 동기화·후보 추출 부재 | 작업 11–15 |
| GAP-4 | 예약·브리핑·알림·관심 탐색·위임 흐름 부재 | 작업 16–20 |
| GAP-5 | 승인 기반 개선·운영·실연동 통합 증거 부재 | 작업 21–25 |

### Must have

명세 `docs/assistant-v2-spec.md:19-41`의 요구 전부를 포함한다. 초기 필수는 읽기 연동, 대화·조사·문서, 기억·파일, 정기·긴급 알림, 스크립트/에이전트 실행, 승인 기반 환경 변경이다. 출처 없는 정보와 실패를 성공으로 꾸미지 않는다.

기술 선택은 **계획의 제안**이다: `apps/assistant/`에 독립 Bun+TypeScript 패키지, `bun:sqlite`, Bun HTTP 서버와 번들러, DOM 기반 TypeScript 웹 UI. 기존 앱을 import하지 않는다. 기존 루트 verify는 보존한다. 추가 런타임 의존성은 검증용 스키마와 Web Push 전송, PDF/office 텍스트 추출에 실제 필요한 라이브러리만 도입하고 lockfile을 커밋한다. 구체 버전은 작업 1의 가용 버전·라이선스 확인 후 고정한다. 원본과 파생 텍스트를 분리한다.

### 상세 계약

이 절의 경로는 **앞으로 생성할 파일**이다. 존재하는 패턴이라고 주장하지 않는다.

```text
apps/assistant/
  package.json, bun.lock, tsconfig.json
  src/contracts/          config.ts, api.ts, events.ts, tools.ts
  src/db/                 schema.sql, migrations/, store.ts
  src/server/             main.ts, auth.ts, routes/, secrets.ts
  src/runtime/            queue.ts, scheduler.ts, attempts.ts, budget.ts
  src/runtime/executors/  script.ts, agent.ts
  src/agents/             provider.ts, context.ts, tools.ts, research.ts
  src/integrations/       google-auth.ts, calendar.ts, gmail.ts, canvas.ts
  src/knowledge/          ingest.ts, memory.ts, retrieval.ts, citations.ts
  src/briefings/          compose.ts, urgency.ts, interests.ts
  src/notifications/      outbox.ts, web-push.ts
  src/changes/            proposals.ts, apply.ts
  src/files/              store.ts, extract.ts
  src/web/                app.ts, api.ts, views/, styles.css, sw.ts
  scripts/                build.ts, doctor.ts, qa.ts, worker.ts, maintenance.ts
  tests/                  unit/, integration/, fixtures/
  qa/                     scenarios/, browser/
  deploy/                 Dockerfile, compose.yaml, Caddyfile.example
  docs/                   setup.md, operations.md, permissions.md
```

**실행 배치:** 서버 web 프로세스와 단일 worker 프로세스가 같은 SQLite·파일 볼륨을 사용한다. 단일 인스턴스가 기본이나 DB 선점은 경합에도 안전해야 한다. 생성 스크립트는 Docker 격리 runner, 코드 적용은 maintenance 명령으로 분리한다. 웹 프로세스에 Docker socket이나 호스트 코드 쓰기 권한을 주지 않는다. 승인된 코드 적용은 운영자가 설치한 maintenance supervisor만 수행한다. 실제 Linux/Docker 사용 가능 여부는 작업 1·24의 게이트다.

**설정과 비밀값:** `APP_ORIGIN`, 데이터/파일 루트, passphrase hash, session key, encryption key, OAuth client secret, VAPID key, provider key는 서버 주입이다. UI/API는 비밀 참조와 설정 여부만 반환한다. 운영 설정은 DB에 revision과 변경자를 기록한다. 시작 화면에서 시간대·정보 전송 범위·월 예산·연동 범위를 확인한 뒤 자동화 enable. 07:30·21:00은 고정 요구, `Asia/Seoul`, 15분 수집, 관심 검색 1일 1회, 70/90/100달러 제어는 수정 가능한 제안값이다. 설정 승인 전 유료 자동 실행을 시작하지 않는다.

**저장 계약:** 시간은 UTC instant와 필요한 IANA zone·all-day local date를 함께 보존한다. ID는 앱 UUID, 외부 ID는 문자열. 금액은 integer micro-USD, 모르는 비용은 null/unknown이다. 외래키, WAL, synchronous FULL, busy timeout 5초를 적용하고 네트워크 await는 트랜잭션 밖에서 수행한다.

| 테이블 | 핵심 키·제약 |
|---|---|
| settings / sessions / connections | revision; hashed session token+expiry; provider별 encrypted credential, scope와 sync 상태 |
| conversations / messages | message의 client_request_id unique, role/content, run 연결 |
| source_items / source_versions / sync_batches | `(connection,remote_id)` unique, content hash, immutable version, tombstone, observed_at, effective time |
| memories / memory_edges / context_threads | statement kind/status/revision, evidence ref, supersedes/derived_from; 자유 관심과 위임 구분 |
| commitments / candidates | 사용자 확인·외부의 명확한 의무와 추출 후보 분리, 원본·기한·변경 관계 |
| files / file_derivations | logical path unique, owner/run, sha256, mime/size, extraction 상태, immutable blob ref |
| automations / runs / attempts | automation version; `(automation,scheduled_slot)` unique; attempt number/fence, lease와 heartbeat |
| run_events / tool_calls / approvals | run별 event seq unique; tool args hash; actor/scope/expiry/version와 one-use 소비 |
| cost_reservations / usage_ledger | provider request id unique, reserved/settled/unknown, price version, month bucket |
| briefings / notifications / push_subscriptions / deliveries | `(slot,config_revision)` 중복 정책, source refs, notification key unique, device별 전송 상태 |
| change_proposals / tool_versions / audit_log | immutable diff/artifact digest, test evidence, active version pointer, approval ref |

프로토타입 DB를 자동으로 열거나 변환하지 않는다. 새 DB migration은 numbered SQL과 schema version을 사용하며, 실패 시 기존 버전으로 rollback한다.

**Run/Attempt 계약:** Run은 사용자 목표, Attempt는 실제 실행 시도다. Run 상태는 queued/running/awaiting_approval/succeeded/failed/cancelled/interrupted. 외부 요청 결과가 불명확한 tool_call은 `outcome_unknown`이며 Run은 interrupted, 사용자 확인 없이 자동 재실행하지 않는다. Attempt는 queued→claimed→running→terminal, 단조 증가 fence를 가진다. BEGIN IMMEDIATE로 claim하고 30초 lease/5초 heartbeat를 제안한다. 완료·도구 결과·이벤트 저장은 현재 fence 소유자만 가능하다. lease가 만료된 worker의 산출물은 게시하지 않는다. 프로세스를 중단해도 이미 나간 외부 요청을 취소했다고 주장하지 않는다.

승인 대기 시 프로세스를 붙들지 않고 계획된 tool_call과 인자를 저장한다. 승인되면 새 Attempt가 저장된 지점에서 이어가며 대화 계획 전체를 재실행하지 않는다. 승인·도구 call 소비는 한 트랜잭션, 외부 요청은 그 뒤이며 결과 불명확 상태는 별도로 남긴다. cancel과 완료는 CAS로 한쪽만 승리한다. 동일 client_request_id는 동일 Run을 반환한다. UI 재접속은 event seq 이후를 가져온다.

**Script/Agent 계약:** Automation은 trigger(kind,daily/interval/event/manual), executor(script/agent), 승인된 version ref, params, scope, limits, output route를 가진다. agent에만 model/instruction ref가 있다. 정기 slot은 `(automation_id,definition_version,scheduled_utc)`로 고유하다. 이전 실행 중이면 중첩 skip 기록, 실행 종료 뒤 backlog 전체를 재생하지 않는다. 예약/명시적 요청 모두 같은 Run을 사용한다.

수집 스크립트는 신뢰된 adapter를 고정 argv로 호출한다. 생성 script는 hash로 승인된 등록 버전만 실행하며 셸 문자열을 받지 않는다. 별도 non-root container, read-only rootfs, cap-drop ALL, no-new-privileges, network none, CPU/memory/pid/time/output 제한, 해당 작업 입력 read-only와 출력 폴더만 mount. credentials·DB·호스트 코드·Docker socket은 mount하지 않는다. 시험용 생성 코드도 같은 격리를 사용한다. 업로드 파일을 실행 권한으로 승격하지 않는다.

**모델/조사:** 공급자 base URL·model·capabilities·가격 revision을 설정한다. Chat Completions의 text/tool 호출은 adapter가 정규화하며 unsupported tool call은 실패로 표시한다. model ID·현재 단가를 소스에 고정하지 않는다. 대화마다 새 Run을 기록하되 짧은 답변을 임의로 여러 전문가로 분해하지 않는다. 조사 도구는 검색·허용된 URL 읽기·자료 조회·작업 파일 작성·등록 스크립트다. 역할별 워커는 동일 계약으로 필요할 때만 사용하고 기본 병렬도는 2로 제한한다. UI의 팀 비유에 고정 agent identity를 강제하지 않는다.

검색 공급자는 설정 가능한 HTTP adapter로 두고, 초기 구현은 Firecrawl 검색·scrape API를 후보로 고정해 작업 1의 기능·단가 사전 점검을 통과한 경우 사용한다. 검색 제공자 계정/결제 생성은 계획 권한에 포함되지 않는다. 페이지 접근 실패와 로그인 필요는 솔직히 반환한다. 웹·파일 출처를 근거로 답변하고 인용은 반환된 evidence ID로만 생성한다. 원격 URL은 private/link-local/metadata 주소와 redirect별 DNS 재검사를 거쳐 제한하고 최대 크기·시간·mime을 검사한다.

**기억:** 원문과 파생 해석을 구분한다. 추출은 대화와 분리한 저우선 실행이며 실패해도 사용자 답변은 보존한다. correction/delete 시 memory revision과 전역 context_epoch를 갱신하고 파생 요약·검색 색인을 무효화한다. 게시 직전 epoch가 변한 작업은 관련 맥락을 재확인한다. 원문 삭제 요청은 evidence와 파생물까지 추적하되 audit에는 삭제 본문을 남기지 않는다. 백업은 암호화하고 삭제 전 백업에서 복원할 때 deletion ledger를 재적용한다. 기본 백업 보존 14일은 설정 제안으로 표시한다.

**동기화:** 첫 전체 수집은 staging batch에 저장하고 마지막 페이지까지 성공한 뒤 현재 view와 커서를 교체한다. 실패하면 기존 view와 커서를 보존하고 stale 표시한다. 증분 역시 처리된 변경과 커서를 같은 transaction에서 확정한다. 외부 버전 hash가 같으면 사건을 생성하지 않는다. tombstone은 이력을 지우지 않는다. 서로 다른 출처가 비슷하다는 이유만으로 원본 ID를 합치지 않고 후보 link를 생성한다.

- Calendar: 선택한 캘린더별 고정 query fingerprint와 sync token. `singleEvents=false` 원본 series/exception을 동기화하고, 내부 occurrence view를 -7~+120일로 materialize한다. RRULE/EXDATE/RECURRENCE-ID와 all-day/floating timezone 테스트를 포함하며 공식 recurrence parser를 사용한다. syncToken에는 timeMin/timeMax/q/orderBy를 붙이지 않는다. 410은 해당 connection의 staging full resync; 사용자 기억/다른 연결/과거 증거를 삭제하지 않는다.
- Gmail: 첫 수집은 최근 30일·INBOX와 사용자가 선택한 label 범위 제안. 수집 시작 history watermark와 최종 catch-up으로 초기 수집 중 도착분을 놓치지 않는다. history.list 페이지와 관련 message 상세를 처리한 뒤 커서 이동. 404는 범위 full resync. 삭제·label 이동은 선정 범위 상태 갱신이며 숨은 과거 메일을 계속 처리하지 않는다. MIME multipart/encoding/첨부 metadata를 파싱하고 본문은 HTML 실행 없이 추출한다.
- Canvas: CLI `api GET ... --paginate -o json --no-cache`, 지정 origin과 과목 allowlist를 사용한다. 시작 시 auth status와 version/help를 검사한다. course/assignment/announcement/module/file을 분리 수집하고 세부 요구사항은 detail 조회. 권한 제한·404를 과목 삭제로 해석하지 않는다. 완전 목록 성공 때만 누락을 tombstone으로 판단한다. Linux CLI 설치·secure storage는 실제 서버 preflight 전에는 미검증이다.

**브리핑/긴급:** 정기 시각까지 최신 수집 결과를 준비하고 snapshot으로 생성한다. 수집 지연은 freshness와 함께 표시하며 전체 생성을 무기한 막지 않는다. 놓친 회차는 2시간 이내 최신 1회만 생성, 이후 다음 회차로 넘기는 정책을 제안한다. local date/slot과 설정 revision으로 중복을 막고 시간대 변경은 미래 slot에만 적용한다. DST의 존재하지 않는 시각은 다음 유효 instant, 중복 시각은 첫 instant 한 번으로 정한다.

긴급은 `actionable_before < next_briefing`이고 사용자 관련성이 확인된 변화다. 구조화된 기한은 코드로 비교하고 모호한 의미는 모델이 근거를 내되 불확실한 내용은 후보로 남긴다. 중복키 `(source_change,reason_revision)`와 해결 상태로 재알림을 통제한다. 뉴스레터·관심 검색은 정기 브리핑 끝 최대 3건, 긴급으로 승격하지 않는다.

**푸시:** notification 저장과 outbox 삽입을 동일 transaction으로 처리한다. 기기별 전달은 pending/accepted/failed/expired, 브라우저에서 열기는 opened다. accepted를 received로 표시하지 않는다. service worker는 generic 문구와 내부 상대 경로만 받아 인증 후 원문을 연다. 구독 endpoint/key는 비밀값이고 임의 URL 전송을 막기 위해 HTTPS·공인 endpoint 및 허용 push-service host를 검증한다. 404/410 구독 폐기, 429/5xx는 제한 재시도, TTL 경과 시 stale 푸시 중단. 푸시 사용은 명시적 UI 동작으로 권한을 요청한다.

**비용:** 모든 유료 호출 전 해당 월 `settled+active_reservations+unknown_liabilities`를 transaction으로 검사하고 상한을 예약한다. 출력 토큰 제한과 보수적 입력 상한을 사용하며 가격 미설정은 유료 자동 호출 차단. usage가 없어도 예약을 풀지 않고 unknown으로 보존한다. 취소·timeout·응답 절단은 무료로 보지 않는다. 월은 설정 timezone 기준, 경계 전 시작 요청은 원 예약 월로 정산한다. 70/90/100 정책은 초기 설정 확인 후 활성화하며 추가 예산 승인과 tool 행동 승인은 구분한다.

**승인·개선:** action 종류, canonical args hash, 대상 version/hash, scope, expiry, budget cap을 담고 user actor만 승인한다. 승인 수정 후 이전 승인을 재사용하지 않는다. 변화 제안은 draft→tested→awaiting_approval→approved→applying→applied/failed/rolled_back. 실행 등록은 immutable tool version으로, 코드 변경은 새 release 작업영역·시험·승인 후 maintenance supervisor가 원자적 release pointer와 restart로 적용한다. in-place 운영 코드 쓰기, 자동 git push, 의존성/권한 무단 확대는 금지한다. DB schema 변경 제안은 수동 운영 게이트로 보류하고 자동 self-evolution 범위에서는 실행하지 않는다. 적용 실패 시 이전 release/tool pointer 복구와 실패 기록을 남긴다.

**HTTP/화면 계약:** 아래는 앞으로 구현할 API다. 인증 없는 `/health`는 비밀 없는 liveness만 반환한다. 나머지는 인증을 검사하고 mutation에는 정확한 Origin/CSRF 검사를 적용한다. 상태 코드는 401 미인증, 403 권한/CSRF, 409 revision/승인 불일치, 422 입력 오류, 429 로그인 제한, 503 공급자/연동 이용 불가다.

| API | 계약 |
|---|---|
| POST /api/session, DELETE /api/session | passphrase 로그인/로그아웃, HttpOnly/SameSite/Secure opaque 세션 |
| POST /api/conversations; GET /api/conversations | 대화 생성/목록 |
| POST /api/conversations/:id/messages | `{text,client_request_id}` → 202 `{message_id,run_id}` |
| GET /api/runs/:id; GET /api/runs/:id/events?after=0 | 상태와 seq 기반 SSE, 재접속 가능 |
| POST /api/runs/:id/cancel; POST /api/runs/:id/instructions | 취소/추가 지시, revision/중복키 검사 |
| GET/POST /api/files; GET /api/files/:id/content | 목록/multipart 업로드/인증 다운로드; overwrite는 approval 연결 |
| GET /api/memories; PATCH/DELETE /api/memories/:id | `{revision,correction}` 정정/삭제 |
| GET/PUT /api/settings | revision CAS, secret은 write-only reference |
| GET /api/connections; POST /api/connections/:id/sync | 상태/읽기 수집 Run |
| GET /api/oauth/google/start; GET /api/oauth/google/callback | state·PKCE·redirect URI 검사, 토큰 비노출 |
| GET/POST/PATCH /api/automations | 정의 목록/등록/수정, 승인 버전만 실행 |
| GET /api/briefings; GET /api/briefings/:id | 출처·freshness·본문 |
| GET /api/notifications; POST /api/notifications/:id/open | 알림함/열람 |
| GET /api/push/public-key; POST/DELETE /api/push/subscriptions | VAPID public key와 현재 기기 등록/해제 |
| GET /api/approvals; POST /api/approvals/:id/decision | `{decision,action_hash}` 승인/거절 |
| GET/POST /api/changes; POST /api/changes/:id/test; POST /api/changes/:id/apply | 변경안/격리 시험/승인된 적용 요청 |
| GET /api/usage; GET /api/status | 비용·예약·unknown 및 서비스 상태 |

웹 화면은 대화, 작업, 브리핑/알림함, 파일, 기억, 승인/변경안, 연결/자동화/비용 설정이다. `data-testid`를 QA 계약으로 고정한다. 채팅은 streaming event를 보여주고 생성 경로는 파일 화면으로 연결한다. 1440·390 폭과 한국어 긴 제목, 로딩/빈 상태/실패/접근 제한을 검증한다.

### Must NOT have (guardrails, anti-slop, scope boundaries)

고정 agent personality, Git Blackboard 의무화, 네이티브 Android/Windows 앱, 다중 사용자 가입, 외부 파일 클라우드·메신저·교통 연결, 기존 데이터 자동 이전·삭제, 임의 셸·브라우저 로그인 우회, 승인 전 외부 쓰기·환경 변경, 참가자 모집·일반화된 벤치마크를 추가하지 않는다. 미지원 외부 쓰기 도구는 제공하지 않으며 승인 인프라가 빈 구현이어서는 안 된다.

## Verification strategy
테스트 전략: Bun test. 상태·권한·커서·시간·정산은 테스트 우선, UI/어댑터는 기능과 함께 회귀 테스트 작성. 기존 루트 `bun run verify`는 마지막에 한 번 실행하고 새 앱은 `cd apps/assistant && bun run verify`로 typecheck/build/test를 실행한다.

아래 QA 명령과 경로는 **작업 1·2에서 생성할 미래 검증 인터페이스**다. 이번 계획 세션에서 앱을 실행했다는 뜻이 아니다.

- 공통 `bun run qa --scenario <name> --evidence ../../.omo/evidence/digithive-v2/task-N`는 `apps/assistant`에서 실행한다. scripts/qa.ts가 실제 HTTP·DB·PTY·browser driver로 시나리오를 수행한다. stdout에 PASS를 인쇄하는 것만으로 통과하지 않고 binary assertions와 요청/응답·상태 diff를 저장한다. 미정의 시나리오는 exit 2, 의도적으로 잘못된 fixture 응답은 exit 1이어야 한다.
- HTTP 채널은 실제 기동 앱에 요청하고 status/headers/body를 저장한다. fixture provider는 로컬 HTTP 서버로 실행해 네트워크 파서·페이지·실패 경로를 통과한다. fixture 테스트를 live integration 통과로 표시하지 않는다.
- Browser 채널은 browser skill의 omowright로 실제 페이지를 조작하고 action log+1440/390 screenshot을 저장한다. 소유한 QA profile을 사용한다. 로그인된 실제 계정이 필요한 설정/검증은 attached browser와 사용자 인증 절차를 사용하며 쿠키를 지우거나 복제하지 않는다.
- 모든 QA는 고유 DB·포트·임시 폴더를 생성하고 teardown에서 프로세스·브라우저·포트·폴더 제거 read-back receipt를 남긴다. 증거만 영속 경로로 옮긴다. 테스트 전용 clock/fault injection은 운영 API에서 활성화하지 않는다.
- live 검증은 별도 `bun run qa --scenario live-personal-flow --live --evidence ...`로 실행한다. 설정된 실제 API·계정을 사용하고 최소 호출의 비용을 사전 확인한다. 자격증명·인증·푸시 권한·실제 대상 기기가 없으면 `NEEDS_SETUP`와 빠진 조건을 기록하고 최종 완료로 선언하지 않는다. 사용자에게 필요한 로그인·브라우저 권한 부여는 준비 단계이며 검증 결과를 대신하지 않는다.
- 계획 자체의 구조 검사는 `.omo/evidence/digithive-v2-planning/structure.json`, 명세 대응은 `coverage.md`, 독립 검토는 `review.md`에 별도 보존한다.

## Execution strategy
### Parallel execution waves
W1 기반 1–5 → W2 실행·맥락 6–10 → W3 개인 정보 11–15 → W4 비서 동작 16–20 → W5 통제·운영·통합 21–25 → F1–F4.

한 작업은 구현과 해당 테스트·QA를 함께 소유한다. parent는 통합·공통 contracts/store 변경을 직렬 관리한다. 독립 adapter(calendar/gmail/canvas), web views, push는 계약 확정 뒤 disjoint 경로로 background task에 분담한다. 같은 schema·API contract 수정은 동시 작업하지 않는다. category는 각 task에 명시한다. 단계별 작업영역이 필요하면 기존 사용자 파일을 복사·삭제하지 않는 task-owned worktree를 사용하고 끝에 제거한다.

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | 없음 | 2–25 | 없음 |
| 2 | 1 | 3–25 | 없음 |
| 3 | 2 | 8,11,18,21,24 | 4,5 |
| 4 | 2 | 6,9,20 | 3,5 |
| 5 | 2 | 7,17,19 | 3,4 |
| 6 | 4 | 20,22 | 7,8 |
| 7 | 4,5 | 8,10,15,17,19 | 6 |
| 8 | 3,7 | 20,23 | 9 |
| 9 | 4 | 10,20,24 | 8 |
| 10 | 7,9 | 15,17,20 | 11 |
| 11 | 3 | 12,13 | 10,14 |
| 12 | 11 | 15,17,25 | 13,14 |
| 13 | 11 | 15,19,25 | 12,14 |
| 14 | 6 | 15,17,25 | 12,13 |
| 15 | 10,12,13,14 | 17,20,25 | 16 |
| 16 | 4 | 17,19 | 12–15 |
| 17 | 5,10,15,16 | 18,23,25 | 19,20 |
| 18 | 3,17 | 23–25 | 19,20 |
| 19 | 5,7,13,16 | 23,25 | 18,20 |
| 20 | 6,8,9,10,15 | 22,23,25 | 17–19 |
| 21 | 3,4,6,9 | 22,23 | 17–20 |
| 22 | 6,20,21 | 23–25 | 없음 |
| 23 | 8–22 | 25 | 24 |
| 24 | 3,9,18,22 | 25 | 23 |
| 25 | 12–24 | F1–F4 | 없음 |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->
- [ ] 1. 새 애플리케이션 경계와 실행 사전 점검을 만든다
  - Recommended task executor category: deep-low — 새 패키지·개발 도구의 독립적인 기반 구현.
  - Closes: GAP-1. Wave W1. Depends on: none. Blocks: 2–25.
  - Paths: `apps/assistant/package.json`, `tsconfig.json`, `scripts/{build,doctor}.ts`, `docs/setup.md`. 기존 루트 명령·src/tests를 변경하지 않는다.
  - References: 명세 1·4·12·14절; 현재 `package.json:5-20`; planning `sources.md`.
  - What: dev/start/worker/typecheck/build/test/verify/qa/doctor 명령을 고정한다. doctor는 OS/Bun/Docker/Canvas 실행파일·scope별 설정 여부·포트·볼륨 쓰기를 검사하고 비밀값 없이 JSON을 반환한다. Linux target, dependency license/고정 lock, Canvas binary 배포 경로, search/provider capabilities를 검증한다. 실제 도메인·OAuth·계정·결제 준비는 별도 setup 게이트로 기록한다.
  - Acceptance: `cd apps/assistant && bun run typecheck && bun run build && bun run doctor -- --mode local` exit 0; 미설정 live 조건은 명시적 NEEDS_SETUP, 허위 PASS 없음.
  - QA happy: PTY `bun run doctor -- --mode local --json`; PASS iff 기본 실행파일·쓰기 경계 확인 결과가 구조화되고 비밀값 없음. Evidence: task-1/doctor.json.
  - QA failure: PTY `bun run doctor -- --mode live --config tests/fixtures/config/missing-secrets.json --json`; PASS iff nonzero와 missing requirements 목록, 실제 API 요청 0. Evidence: task-1/missing.json.
  - Commit: Y — `Create an isolated assistant application and preflight checks`.

- [ ] 2. 저장 스키마·HTTP 계약과 실제 QA 실행기를 구축한다
  - Recommended task executor category: deep-high — 여러 모듈의 트랜잭션·공통 계약을 고정.
  - Closes: GAP-1. Wave W1. Depends on: 1. Blocks: 3–25.
  - Paths: `src/contracts/*`, `src/db/*`, `src/server/main.ts`, `scripts/qa.ts`, `qa/scenarios/*`, `tests/integration/migrations.test.ts`.
  - References: 이 계획 상세 계약의 schema/API 표; 명세 5·8·13절; Bun SQLite 공식 sources 8.
  - What: 표의 테이블·unique/FK·revision/migrations를 구현한다. QA 공통 fixture HTTP 서버, 격리 DB, fake clock, 요청/응답 캡처, assertions·teardown·unknown scenario 실패를 제공한다. 후속 task가 시나리오 파일을 추가한다. QA는 serial 4317 앱/4318 fixture 포트를 점유하며 이미 사용 중이면 fail; 타인의 프로세스를 종료하지 않는다.
  - Acceptance: `bun test tests/integration/migrations.test.ts`; rollback과 unique 경합 테스트가 통과하고 health는 실제 HTTP 200.
  - QA happy: `bun run qa --scenario foundation-health --evidence ../../.omo/evidence/digithive-v2/task-2`; HTTP `GET http://127.0.0.1:4317/health` 200, schema version 일치. Evidence: task-2/http.json, db.json.
  - QA failure: `bun run qa --scenario foundation-bad-migration --evidence ../../.omo/evidence/digithive-v2/task-2`; PASS iff 잘못된 migration 실패 뒤 기존 row·version 보존. 미정의 scenario는 exit 2임도 검증. Evidence: task-2/rollback.json, cleanup.json.
  - Commit: Y — `Add assistant storage contracts and executable QA infrastructure`.

- [ ] 3. 인증·정책 검사·비밀값 저장을 구현한다
  - Recommended task executor category: deep-high — 세션·CSRF·권한의 공통 경계.
  - Closes: GAP-1, GAP-5. Wave W1. Depends on: 2. Blocks: 8,11,18,21,24.
  - Paths: `src/server/{auth,secrets}.ts`, `src/server/routes/session.ts`, `src/contracts/config.ts`, `tests/integration/auth.test.ts`.
  - References: 명세 9·12절; 이 계획 HTTP 계약; 기존 auth 구현은 재사용 의무 없음.
  - What: 서버 측 opaque 세션 hash, passphrase hash, secure cookie, logout·만료·로그인 제한을 만든다. 운영에서 비밀번호 미설정 시 fail closed. 정확한 APP_ORIGIN·trusted proxy·CSRF 검사, source/tool scope 검사, 서버 주입 key 기반 암호화를 적용한다.
  - Acceptance: 실제 Origin/Host/포트를 포함한 auth test 통과; API·로그·파일에서 토큰 비노출.
  - QA happy: `bun run qa --scenario auth-browser --evidence ../../.omo/evidence/digithive-v2/task-3`; browser `page.goto("http://127.0.0.1:4317"); page.getByTestId("passphrase").fill("qa-only-long-passphrase"); page.getByTestId("login").click()` 뒤 대화 화면과 session cookie 확인. Evidence: action log, desktop/mobile screenshots.
  - QA failure: `bun run qa --scenario auth-origin-and-expiry --evidence ../../.omo/evidence/digithive-v2/task-3`; POST /api/conversations with Origin `https://evil.invalid`→403, 만료 cookie→401, 반복 로그인→429. Evidence: http.json.
  - Commit: Y — `Enforce authenticated assistant sessions and execution scopes`.

- [ ] 4. Run·Attempt 큐와 재시작·취소 계약을 구현한다
  - Recommended task executor category: deep-high — 경합과 side effect를 분리하는 핵심 상태 기계.
  - Closes: GAP-2. Wave W1. Depends on: 2. Blocks: 6,9,16,20,21.
  - Paths: `src/runtime/{queue,attempts}.ts`, `scripts/worker.ts`, `src/server/routes/runs.ts`, tests/runtime.
  - References: 명세 5.3절; 상세 Run/Attempt 계약.
  - What: transactional claim, lease/fence, event seq, idempotent enqueue, cancellation CAS, interrupted 복구를 구현한다. stdout 종료 코드만으로 목표 달성을 판정하지 않는다. 승인 대기와 결과 불명확을 보존한다.
  - Acceptance: Bun state-machine/경합 테스트 통과; lease 잃은 worker는 결과 저장 불가.
  - QA happy: `bun run qa --scenario run-reconnect --evidence ../../.omo/evidence/digithive-v2/task-4`; 실제 HTTP 작업 시작→클라이언트 종료→worker 완료→GET /api/runs/<id>/events?after=0에서 하나의 결과 확인. Evidence: http.json, events.json.
  - QA failure: `bun run qa --scenario run-lease-crash-cancel --evidence ../../.omo/evidence/digithive-v2/task-4`; 두 worker 경합, 한 worker 강제 종료, clock lease 경과, stale completion·cancel race 주입; PASS iff 하나의 terminal 결과와 stale write 0. Evidence: db-diff.json, process-cleanup.json.
  - Commit: Y — `Persist assistant runs with fenced attempts and cancellation`.

- [ ] 5. 비용 예약·정산과 운영 설정을 구현한다
  - Recommended task executor category: deep-high — 동시 호출·불명확 청구의 예산 불변식.
  - Closes: GAP-1, GAP-5. Wave W1. Depends on: 2. Blocks: 7,17,19.
  - Paths: `src/runtime/budget.ts`, `src/server/routes/{settings,usage}.ts`, tests/budget.
  - References: 명세 11절; 이 계획 비용 계약과 제안값 표.
  - What: micro-USD·가격 version·예약·settled/unknown을 구현한다. 설정 revision과 자동화 최초 enable 전 확인을 제공한다. USD100은 comfort 기준이고 정책 thresholds는 설정 제안임을 표시한다. 비용 미설정 자동 호출 차단.
  - Acceptance: 동시 예약이 상한을 넘지 않으며 취소/누락 usage는 비용 0으로 바뀌지 않는다.
  - QA happy: `bun run qa --scenario budget-settle --evidence ../../.omo/evidence/digithive-v2/task-5`; fixture 요청 2회 후 GET /api/usage에 예약/실비/가격 version 일치. Evidence: usage.json.
  - QA failure: `bun run qa --scenario budget-concurrent-unknown --evidence ../../.omo/evidence/digithive-v2/task-5`; USD99.9 상태에서 각각 USD0.1 예약 2개 동시 요청·usage 누락; PASS iff 하나만 실행되고 unknown 부채 보존, 월 경계 정산 중복 0. Evidence: ledger.json.
  - Commit: Y — `Track reserved and uncertain API costs before execution`.

- [ ] 6. 등록 스크립트와 격리된 생성 코드 실행기를 구현한다
  - Recommended task executor category: deep-high — 스크립트도 agent와 같은 권한·내구성 경계를 준수.
  - Closes: GAP-2, GAP-5. Wave W2. Depends on: 4. Blocks: 14,20–22.
  - Paths: `src/runtime/executors/script.ts`, `src/contracts/tools.ts`, `deploy/script-runner.Dockerfile`, tests/scripts.
  - References: 명세 5.1–5.3·9절; 상세 Script/Agent 계약.
  - What: trusted collector와 approved generated script를 구분한다. argv schema·artifact digest·scope 검사, timeout/output limit, non-root container 제한과 작업 출력만 수거한다. local development에서도 격리를 생략한 generated-code fallback 금지.
  - Acceptance: LLM key 없이 등록 collector 실행 가능; 미승인 script 실행 403/승인 대기.
  - QA happy: `bun run qa --scenario script-approved --evidence ../../.omo/evidence/digithive-v2/task-6`; 승인된 text 변환 script를 실제 runner에서 실행해 파일 hash·Run 상태 확인. Evidence: transcript.txt, result.json.
  - QA failure: `bun run qa --scenario script-escape-and-timeout --evidence ../../.omo/evidence/digithive-v2/task-6`; script가 secret path 읽기·외부 HTTP·무한 loop를 시도; PASS iff 읽기/네트워크 차단·시간 제한 종료와 호스트 파일 변화 0. Evidence: sandbox.json, cleanup.json.
  - Commit: Y — `Run approved scripts inside bounded isolated workspaces`.

- [ ] 7. 모델 adapter와 제한된 도구 호출 루프를 구현한다
  - Recommended task executor category: deep-low — 공식 호환 API와 실행 계약 구현.
  - Closes: GAP-2. Wave W2. Depends on: 4,5. Blocks: 8,10,15,17,19,20.
  - Paths: `src/agents/{provider,tools,context}.ts`, `src/runtime/executors/agent.ts`, tests/provider.
  - References: 명세 3.4·4·11절; sources 7; 비용·권한·Run 계약.
  - What: API Key/base URL/model 설정, text/tool 결과·streaming 사용량 정규화, 토큰/도구/time 제한, 취소 전달과 unknown charge를 구현한다. provider error는 사용자 메시지와 상태에 반영한다.
  - Acceptance: fixture 공급자와 실제 HTTP round trip, malformed tool args 거부, scope 우회 없음.
  - QA happy: `bun run qa --scenario agent-tool-roundtrip --evidence ../../.omo/evidence/digithive-v2/task-7`; fixture tool call→내부 읽기→답변→usage 정산. Evidence: provider-http.json, run.json.
  - QA failure: `bun run qa --scenario agent-malformed-and-disconnect --evidence ../../.omo/evidence/digithive-v2/task-7`; 잘못된 args·지원 안 되는 tool·응답 절단 주입; PASS iff 임의 도구 실행 0, failure/unknown 비용 보존. Evidence: failures.json.
  - Commit: Y — `Add configurable model calls and bounded agent tool execution`.

- [ ] 8. 대화·작업 상태와 재접속 가능한 웹 흐름을 만든다
  - Recommended task executor category: visual-engineering — 실제 PC·모바일 대화 경험.
  - Closes: GAP-2. Wave W2. Depends on: 3,7. Blocks: 20,23.
  - Paths: `src/web/{app,api}.ts`, `src/web/views/{chat,runs}.ts`, styles, `src/server/routes/conversations.ts`.
  - References: 명세 2·3.4·7절; HTTP·웹 화면 계약.
  - What: 대화 목록·메시지·streaming·작업 목록·취소·추가 지시·오류를 구현한다. message 중복키와 SSE reconnect seq, 일반 질문의 단일 답변을 지원한다.
  - Acceptance: reload 후 대화·진행 작업·답변이 남고 중복 전송이 새 작업을 만들지 않는다.
  - QA happy: `bun run qa --scenario chat-browser --evidence ../../.omo/evidence/digithive-v2/task-8`; page.getByTestId("chat-input").fill("이 단어의 어원을 설명해줘"); page.getByTestId("chat-send").click(); page.reload(); PASS iff 답변 1개와 원 작업 복구. Evidence: actions.json, desktop.png, mobile.png.
  - QA failure: `bun run qa --scenario chat-offline-cancel --evidence ../../.omo/evidence/digithive-v2/task-8`; 네트워크 끊기→재접속→page.getByTestId("run-cancel").click(); PASS iff 상태가 사실과 일치하고 중복 bubble/overlap 없음. Evidence: actions.json, mobile-error.png.
  - Commit: Y — `Provide persistent conversations and visible task control`.

- [ ] 9. 내부 파일 저장소와 텍스트 추출을 구현한다
  - Recommended task executor category: deep-low — 업로드·파일 경계·산출물 일관성.
  - Closes: GAP-1, GAP-2. Wave W2. Depends on: 4. Blocks: 10,20,21,24.
  - Paths: `src/files/*`, `src/server/routes/files.ts`, `src/web/views/files.ts`, tests/files.
  - References: 명세 7절; 상세 저장·파일 계약.
  - What: content-addressed 원본 blob·논리 경로·immutable version, 목록/업로드/다운로드/삭제 확인을 만든다. 초기 text/md/pdf/docx 추출, 미지원 파일도 원본 보관·다운로드와 unsupported 상태. 크기 기본 25MiB·추출 제한은 설정값으로, HTML 실행과 path traversal/symlink escape 차단.
  - Acceptance: 파일 내용과 hash round trip, 원본과 파생 텍스트 구분, 실패 추출을 빈 성공으로 저장하지 않음.
  - QA happy: `bun run qa --scenario files-browser-roundtrip --evidence ../../.omo/evidence/digithive-v2/task-9`; page.getByTestId("file-upload").setInputFiles("tests/fixtures/files/assignment.pdf"); 다운로드 bytes/hash 일치와 추출 상태 확인. Evidence: actions.json, hashes.json, mobile.png.
  - QA failure: `bun run qa --scenario files-path-size-corrupt --evidence ../../.omo/evidence/digithive-v2/task-9`; traversal filename·초과 업로드·깨진 PDF·symlink 시도; PASS iff 경계 밖 파일 접근 0, 명시적 4xx/extraction failure. Evidence: http.json, disk-diff.json.
  - Commit: Y — `Store accessible user files with bounded text extraction`.

- [ ] 10. 자동 기억·검색·정정 전파를 구현한다
  - Recommended task executor category: deep-high — 파생 기억과 삭제·동시 작업의 무결성.
  - Closes: GAP-2. Wave W2. Depends on: 7,9. Blocks: 15,17,20.
  - Paths: `src/knowledge/{memory,retrieval,citations}.ts`, `src/server/routes/memories.ts`, `src/web/views/memory.ts`.
  - References: 명세 3.5·8절; 연구 노트 2·3·6절 각주; 상세 memory epoch 계약.
  - What: 자동 추출·원문 근거·추론 상태·revision·정정/철회·FTS와 source filters를 구현한다. embeddings 필수 아님. 관심을 약속으로 승격하지 않고 correction/delete를 파생 색인·요약과 게시 중 결과까지 전파한다.
  - Acceptance: 사용자가 수정한 선호가 다음 답변/브리핑에 적용되고 삭제한 문구가 활성 검색에 재등장하지 않는다.
  - QA happy: `bun run qa --scenario memory-correct-browser --evidence ../../.omo/evidence/digithive-v2/task-10`; “아침에는 짧게 설명해줘” 대화→기억 확인→수정→다음 답변의 근거 revision 확인. Evidence: actions.json, memory-diff.json.
  - QA failure: `bun run qa --scenario memory-revoke-inflight --evidence ../../.omo/evidence/digithive-v2/task-10`; 답변 생성 중 기억 삭제·가정문 추출·stale revision 수정; PASS iff 409 충돌, 관심의 의무화 0, 철회된 근거 게시 0. Evidence: events.json, retrieval.json.
  - Commit: Y — `Keep correctable memories with source and revision propagation`.

- [ ] 11. Google 연결과 offline OAuth 수명주기를 구현한다
  - Recommended task executor category: deep-high — 개인 계정·토큰과 callback 보안.
  - Closes: GAP-3. Wave W3. Depends on: 3. Blocks: 12,13.
  - Paths: `src/integrations/google-auth.ts`, `src/server/routes/oauth.ts`, connection settings UI, tests/oauth.
  - References: 명세 6절; sources 4; API OAuth 계약.
  - What: 최소 read-only Calendar/Gmail scopes, state·PKCE·redirect, encrypted refresh token, refresh single-flight·401 재인증·연결 해제를 구현한다. 이전 refresh token을 누락 응답으로 지우지 않는다. Google consent/testing 상태와 장기 만료 조건은 doctor에서 실제 project 설정과 대조한다.
  - Acceptance: 서버 부재 중 offline refresh fixture 통과, token은 browser/API/log에서 검출되지 않음.
  - QA happy: `bun run qa --scenario oauth-code-refresh --evidence ../../.omo/evidence/digithive-v2/task-11`; 로컬 OAuth fixture callback→만료 access token 갱신→연결 상태. Evidence: redacted-http.json.
  - QA failure: `bun run qa --scenario oauth-state-revocation --evidence ../../.omo/evidence/digithive-v2/task-11`; 틀린 state·재사용 code·invalid_grant; PASS iff 403/재인증 상태, 기존 비밀 비노출. Evidence: failures.json.
  - Commit: Y — `Connect Google accounts with scoped offline authorization`.

- [ ] 12. Google Calendar 동기화와 occurrence view를 구현한다
  - Recommended task executor category: deep-high — 반복 일정·증분·삭제의 일관성.
  - Closes: GAP-3. Wave W3. Depends on: 11. Blocks: 15,17,25.
  - Paths: `src/integrations/calendar.ts`, `src/knowledge/calendar-occurrences.ts`, tests/calendar.
  - References: 명세 6 Calendar; sources 2·3; Calendar 상세 계약.
  - What: calendar 선택·고정 query full/incremental sync, staging commit, 410 resync, recurrence materialization과 timezone을 구현한다. date window를 syncToken 요청에 혼합하지 않는다.
  - Acceptance: 움직인 occurrence·all-day·취소·EXDATE 중복 0, 페이지 실패 뒤 cursor 이동 0.
  - QA happy: `bun run qa --scenario calendar-sync-recurrence --evidence ../../.omo/evidence/digithive-v2/task-12`; fixture 두 페이지와 moved instance를 실제 adapter로 수집하고 다음 sync는 변경 0. Evidence: http.json, occurrences.json.
  - QA failure: `bun run qa --scenario calendar-410-pagefailure --evidence ../../.omo/evidence/digithive-v2/task-12`; expired token→full resync, 중간 page 500; PASS iff 이전 snapshot 유지·stale 표시·다른 출처 데이터 보존. Evidence: db-diff.json.
  - Commit: Y — `Synchronize calendar changes without losing recurrence history`.

- [ ] 13. Gmail 증분 수집과 메시지 자료화를 구현한다
  - Recommended task executor category: deep-low — 공식 history·MIME 계약 기반 adapter.
  - Closes: GAP-3. Wave W3. Depends on: 11. Blocks: 15,19,25.
  - Paths: `src/integrations/gmail.ts`, `src/knowledge/mail-body.ts`, tests/gmail.
  - References: 명세 6 Gmail; sources 1; Gmail 상세 계약.
  - What: 범위 설정·첫 수집 watermark·history pagination·404 resync·MIME 추출·label/삭제 갱신. 읽음·라벨·발송 API를 호출하지 않는다. HTML scripts·인용된 명령은 데이터로 취급한다.
  - Acceptance: 초기 수집 중 도착한 메일도 catch-up, 동일 message version 재처리 0.
  - QA happy: `bun run qa --scenario gmail-history-mime --evidence ../../.omo/evidence/digithive-v2/task-13`; multipart+새 메일+label 변경 fixture를 수집. Evidence: http.json, message-versions.json.
  - QA failure: `bun run qa --scenario gmail-404-and-partial --evidence ../../.omo/evidence/digithive-v2/task-13`; stale history·중간 detail 실패·메일 HTML injection; PASS iff cursor 보존/복구, 외부 write 0. Evidence: db-diff.json, tool-audit.json.
  - Commit: Y — `Read Gmail changes and preserve bounded message evidence`.

- [ ] 14. Canvas CLI 기반 LMS 수집기를 구현한다
  - Recommended task executor category: deep-low — 실제 CLI 계약과 명확한 오류 경계.
  - Closes: GAP-3. Wave W3. Depends on: 6. Blocks: 15,17,25.
  - Paths: `src/integrations/canvas.ts`, `src/integrations/canvas-cli.ts`, tests/canvas, setup docs.
  - References: 명세 6 LMS; sources 로컬 CLI·5; canvas skill 읽기 명령.
  - What: 지정 host·course allowlist·고정 GET argv, --no-cache/--paginate/JSON, detail 자료·권한 제한을 처리한다. Windows secure store를 컨테이너에 복사하지 않고 실제 Linux 지원 인증 경로를 doctor로 검증한다. Linux 설치 출처와 binary digest를 기록하고 실패 시 unsupported/NEEDS_SETUP.
  - Acceptance: fixture CLI 프로세스와 실제 JSON envelope/배열을 파싱하고 임의 command·host·as-user 거부.
  - QA happy: `bun run qa --scenario canvas-cli-pages --evidence ../../.omo/evidence/digithive-v2/task-14`; CLI fixture가 2페이지 과제·detail을 반환, 요구사항/기한/자료 source 저장. Evidence: argv-redacted.json, items.json.
  - QA failure: `bun run qa --scenario canvas-auth-partial-host --evidence ../../.omo/evidence/digithive-v2/task-14`; 401/403/404·깨진 JSON·다른 host Link; PASS iff stale 상태와 cursor 보존, false deletion·secret 전달 0. Evidence: failures.json.
  - Commit: Y — `Collect LMS changes through a bounded Canvas CLI adapter`.

- [ ] 15. 출처 사건과 일정·작업 후보 추출을 연결한다
  - Recommended task executor category: deep-high — 여러 출처의 의미·시간·확정 상태 구분.
  - Closes: GAP-3. Wave W3. Depends on: 10,12,13,14. Blocks: 17,20,25.
  - Paths: `src/knowledge/{ingest,candidates}.ts`, `src/server/routes/candidates.ts`, tests/ingest.
  - References: 명세 3.2·3.3·8절; 연구 노트 관심/위임 구분; 상세 source/candidate 계약.
  - What: source version→change event→필요한 경우 모델 추출→candidate/명확한 마감. 기한 앞당김·취소·철회를 연결하고 비슷한 출처는 merge 대신 근거 link. 사용자가 확인한 약속과 추출 추측을 구분한다.
  - Acceptance: 동일 변경 재수집은 추출/알림 후보 1개, 모호한 약속은 캘린더 write 0.
  - QA happy: `bun run qa --scenario intake-deadline-change --evidence ../../.omo/evidence/digithive-v2/task-15`; LMS와 mail 변경으로 기한 전후·근거 비교. Evidence: source-events.json, candidates.json.
  - QA failure: `bun run qa --scenario intake-ambiguity-injection --evidence ../../.omo/evidence/digithive-v2/task-15`; “다음 주쯤”·충돌 날짜·메일 속 도구 명령; PASS iff uncertain 상태와 출처 보존, 무단 실행 0. Evidence: audit.json.
  - Commit: Y — `Extract grounded schedule candidates from source changes`.

- [ ] 16. 정기·간격·사건 기반 자동화와 예약 UI를 구현한다
  - Recommended task executor category: deep-high — 시간·중복·재시작 의미 고정.
  - Closes: GAP-4. Wave W4. Depends on: 4. Blocks: 17,19.
  - Paths: `src/runtime/scheduler.ts`, `src/server/routes/automations.ts`, `src/web/views/automations.ts`, tests/scheduler.
  - References: 명세 5·11절; 상세 slot/catch-up 계약.
  - What: script/agent 정의·등록 버전·timezone·limits·scope·수동/예약 Run을 지원한다. 07:30/21:00, 15분 수집은 설정 확인 후 생성, pause/수정 CAS, 중첩 skip, downtime grace/DST 처리.
  - Acceptance: 스크립트 자동화는 model 필드 불필요, 동일 slot Run 최대 1개.
  - QA happy: `bun run qa --scenario scheduler-script-agent --evidence ../../.omo/evidence/digithive-v2/task-16`; clock 07:29→07:30·15분 경과와 worker restart. Evidence: slots.json, runs.json.
  - QA failure: `bun run qa --scenario scheduler-dst-overlap-downtime --evidence ../../.omo/evidence/digithive-v2/task-16`; DST 중복/누락, 3시간 downtime, 실행 중 수정; PASS iff 계약대로 skip/latest 1회, 중복 0. Evidence: timeline.json.
  - Commit: Y — `Schedule script and agent automations with durable slots`.

- [ ] 17. 아침·저녁 브리핑과 긴급성 판단을 구현한다
  - Recommended task executor category: deep-high — 시급성과 사실·제안의 사용자 계약.
  - Closes: GAP-4. Wave W4. Depends on: 5,10,15,16. Blocks: 18,23,25.
  - Paths: `src/briefings/{compose,urgency}.ts`, briefing routes, tests/briefings.
  - References: 명세 3.1·3.2·10절; 상세 briefing/urgency 계약.
  - What: 아침 준비·저녁 변화/내일을 분리하고 freshness·근거·불확실성을 표시한다. deadline 구조 비교와 의미 판단을 분리, unknown 진행을 미완료로 단정하지 않는다. model unavailable/예산 대기는 저장된 근거 목록과 생성 중지 상태를 명시한다.
  - Acceptance: 07:30/21:00 snapshot과 next briefing 경계가 정확하고 관심 정보는 긴급 승격되지 않음.
  - QA happy: `bun run qa --scenario briefings-day-cycle --evidence ../../.omo/evidence/digithive-v2/task-17`; clock 하루 진행→두 브리핑→마감 앞당김 사건; 출처와 actionable-before 기준 확인. Evidence: briefings.json, urgency.json.
  - QA failure: `bun run qa --scenario briefings-stale-budget-duplicate --evidence ../../.omo/evidence/digithive-v2/task-17`; LMS 오류·예산 정지·중복 사건·취소; PASS iff 실패를 빈 일정으로 표현하지 않고 중복·철회 알림 0. Evidence: snapshot.json.
  - Commit: Y — `Compose grounded briefings and restrained urgent alerts`.

- [ ] 18. Web Push와 기기별 알림 수명주기를 구현한다
  - Recommended task executor category: deep-high — push endpoint 비밀과 재전송 상태.
  - Closes: GAP-4. Wave W4. Depends on: 3,17. Blocks: 23–25.
  - Paths: `src/notifications/*`, `src/web/sw.ts`, push routes, tests/push.
  - References: 명세 10절; sources 6; 상세 outbox/기기 계약.
  - What: VAPID·구독 등록/해제·pushsubscriptionchange·outbox·TTL·404/410 제거·generic 알림·인증된 내부 경로 열기를 구현한다. accepted와 opened를 구분하고 알림함을 유지한다.
  - Acceptance: 중복 enqueue에도 기기당 활성 notification 한 건, endpoint/key 미노출.
  - QA happy: `bun run qa --scenario push-browser-notification --evidence ../../.omo/evidence/digithive-v2/task-18`; 소유 browser에서 알림 허용 UI 클릭→실제 SW 등록·알림 수신→notificationclick로 briefing 열기. Local fixture push는 전송 계약 검증으로만 표시; 실제 Web Push는 작업25에서 별도 증명. Evidence: actions.json, sw-events.json, screenshot.png.
  - QA failure: `bun run qa --scenario push-expired-denied-outbox --evidence ../../.omo/evidence/digithive-v2/task-18`; 권한 거절·410·429·process crash 후 재개; PASS iff 안내/구독 폐기/중복 통제와 원문 보존. Evidence: deliveries.json.
  - Commit: Y — `Deliver briefing notifications through a durable Web Push outbox`.

- [ ] 19. 뉴스레터와 제한된 관심 정보 탐색을 구현한다
  - Recommended task executor category: deep-low — 비용 제한과 근거가 있는 부가 브리핑.
  - Closes: GAP-4. Wave W4. Depends on: 5,7,13,16. Blocks: 23,25.
  - Paths: `src/briefings/interests.ts`, `src/agents/search.ts`, interests settings, tests/interests.
  - References: 명세 2·11절; 검색/비용/기억 계약.
  - What: 사용자가 허용한 관심사와 뉴스레터를 바탕으로 일 1회 탐색, 출처/중복/개수 제한, scope·예산 검사. 검색 API 미설정이면 연결 필요 표시, fabricated 검색 결과 금지.
  - Acceptance: 최대 3건 정기 브리핑 부가 정보와 원문 링크, 긴급 푸시 0.
  - QA happy: `bun run qa --scenario interests-newsletter-search --evidence ../../.omo/evidence/digithive-v2/task-19`; newsletter+검색 HTTP fixture의 겹치는 기사 선택. Evidence: selections.json, costs.json.
  - QA failure: `bun run qa --scenario interests-budget-revocation --evidence ../../.omo/evidence/digithive-v2/task-19`; 철회 관심·중복 기사·90달러 모드·검색 실패; PASS iff 자율 탐색 중단/감소와 새 정보 없음의 사실 표시. Evidence: audit.json.
  - Commit: Y — `Add bounded interest discovery to regular briefings`.

- [ ] 20. 실제 자료를 쓰는 조사·초안 작업을 완성한다
  - Recommended task executor category: deep-high — 대화·도구·자료·기억·산출물의 통합.
  - Closes: GAP-2, GAP-4. Wave W4. Depends on: 6,8,9,10,15. Blocks: 22,23,25.
  - Paths: `src/agents/research.ts`, context/tools, task routes/views, tests/research.
  - References: 명세 3.4·4·7절; 상세 agent/근거/추가 지시 계약.
  - What: 브리핑 항목에서 요청→과제 요구·일정·파일 검색→조사→초안·인용→대화와 파일 경로. 도구 출력은 evidence ID로 검증하고 일부 실패를 표시한다. 필요하면 task-specific worker 최대2개, 공통 산출물/이벤트 계약. 저장된 checkpoint 뒤 재개하며 모델 자체 KV/session 영속성을 가정하지 않는다.
  - Acceptance: 생성 파일 내용이 실제 수집 자료와 연결되고 없는 출처를 인용하지 않음.
  - QA happy: `bun run qa --scenario research-from-briefing-browser --evidence ../../.omo/evidence/digithive-v2/task-20`; page.getByTestId("briefing-task-help").click(); 채팅 “관련 자료를 찾아 초안을 만들어줘” 전송→file-link 클릭→다운로드 검증. Evidence: actions.json, source-map.json, artifact.sha256, desktop/mobile.png.
  - QA failure: `bun run qa --scenario research-blocked-injection-restart --evidence ../../.omo/evidence/digithive-v2/task-20`; 검색 페이지 오류·문서 속 외부 전송 명령·worker 중단·추가 지시; PASS iff 무단 전송 0, 부분 결과·실패 구분과 source-valid 재개. Evidence: audit.json, events.json.
  - Commit: Y — `Complete grounded research and draft tasks from conversation`.

- [ ] 21. 승인 UI와 내용에 묶인 실행 결정을 구현한다
  - Recommended task executor category: deep-high — 승인 재사용·동시 소비·권한 상승 방지.
  - Closes: GAP-5. Wave W5. Depends on: 3,4,6,9. Blocks: 22,23.
  - Paths: approval routes, `src/runtime/approval.ts`, `src/web/views/approvals.ts`, tests/approvals.
  - References: 명세 9절; 상세 승인 계약.
  - What: 행동/대상/args/version/cost hash와 expiry·one-use, 거절/만료/변경 후 재승인, awaiting_approval 저장·재개. 내부 원본 파일 교체로 실제 승인 효과를 검증한다. 외부 write tool은 미등록 기본 deny, 모델이 존재하지 않는 도구를 호출해도 효과 없음.
  - Acceptance: old hash 승인으로 새 내용 실행 불가, 한 승인 동시 두 번 사용 불가.
  - QA happy: `bun run qa --scenario approval-file-replace-browser --evidence ../../.omo/evidence/digithive-v2/task-21`; diff 확인→page.getByTestId("approval-approve").click(); 정확한 version만 교체, 새 Attempt 결과 확인. Evidence: actions.json, file-diff.json.
  - QA failure: `bun run qa --scenario approval-tamper-expire-race --evidence ../../.omo/evidence/digithive-v2/task-21`; 승인 후 args 변경·만료·동시 소비·외부 메일 발송 요청; PASS iff 409/403와 무승인 효과 0. Evidence: audit.json.
  - Commit: Y — `Bind user approvals to exact actions and immutable versions`.

- [ ] 22. 스크립트·Skill·하네스 개선의 승인 후 적용을 구현한다
  - Recommended task executor category: deep-high — 자기 변경의 시험·적용·실패 복구 경계.
  - Closes: GAP-5. Wave W5. Depends on: 6,20,21. Blocks: 23–25.
  - Paths: `src/changes/*`, change routes/views, `scripts/maintenance.ts`, `deploy/maintenance.example`, tests/changes.
  - References: 명세 3.6·9절; 상세 승인·release 계약.
  - What: 병목/피드백에서 diff·artifact·시험·영향·rollback 포함 제안 생성, 격리 시험, 승인 버전 등록. harness patch는 별도 release 작업영역에서 verify→승인→maintenance apply/restart/health→실패 시 pointer rollback. 운영 DB migration과 권한/결제 변경은 자동 적용 금지. UI 코드가 docker/host code 권한을 갖지 않도록 한다.
  - Acceptance: unapproved script/Skill/harness 운영 version 변화 0; approved digest 적용과 이전 version 복구 가능.
  - QA happy: `bun run qa --scenario evolution-approve-apply --evidence ../../.omo/evidence/digithive-v2/task-22`; 실제 formatter script+Skill 변경안 생성·격리 test·browser 승인·다음 Run에서 새 version 사용. harness fixture release도 maintenance 실제 프로세스로 적용·재시작. Evidence: actions.json, releases.json, transcript.txt.
  - QA failure: `bun run qa --scenario evolution-reject-fail-rollback --evidence ../../.omo/evidence/digithive-v2/task-22`; digest 변조·미승인·검증 실패·health 실패; PASS iff active version 보존/rollback, 승인하지 않은 권한 확대 0. Evidence: release-diff.json, cleanup.json.
  - Commit: Y — `Apply tested assistant improvements only after user approval`.

- [ ] 23. 모든 사용자 화면과 운영 피드백을 통합한다
  - Recommended task executor category: visual-engineering — 화면 간 연속성과 한국어 반응형 QA.
  - Closes: GAP-4, GAP-5. Wave W5. Depends on: 8–22. Blocks: 25.
  - Paths: `src/web/views/*`, styles, `qa/browser/*`, feedback route/table migration.
  - References: 명세 2·3·10·13절; 이 계획 HTTP/화면 표.
  - What: 대화·작업·브리핑·알림·파일·기억·승인·연결·자동화·비용 화면을 통합한다. 피드백은 해당 briefing/run/memory와 연결해 이후 개인화 근거로 저장하며 운영 정책을 자동 확대하지 않는다. 설정 초기 확인·empty/error/loading/NEEDS_SETUP·stale를 구현한다.
  - Acceptance: 모든 기능이 웹에서 접근되고 raw engine JSON 대신 이해 가능한 한국어 설명 제공.
  - QA happy: `bun run qa --scenario ui-full-navigation --evidence ../../.omo/evidence/digithive-v2/task-23`; page.goto("http://127.0.0.1:4317"); 모든 nav testid 클릭, 1440×900·390×844 capture; PASS iff 핵심 행동 접근과 가로 overflow/겹침/blank 0. Evidence: actions.json, screenshots/.
  - QA failure: `bun run qa --scenario ui-stale-error-feedback --evidence ../../.omo/evidence/digithive-v2/task-23`; 연결 실패·긴 한국어 제목·예산 정지·피드백 입력 후 reload; PASS iff 상태·피드백 보존, 명암·focus·모바일 가독성 확인. Evidence: actions.json, screenshots/error/.
  - Commit: Y — `Integrate assistant views and actionable user feedback`.

- [ ] 24. 별도 서버 배포·백업·복원과 상태 점검을 구현한다
  - Recommended task executor category: deep-high — 운영 비밀·프로세스·복원의 실제 경계.
  - Closes: GAP-5. Wave W5. Depends on: 3,9,18,22. Blocks: 25.
  - Paths: `deploy/*`, `scripts/{backup,restore,doctor}.ts`, `docs/{setup,operations,permissions}.md`.
  - References: 명세 12·14절; 기존 docs/deploy.md는 참고만; 이 계획 실행 배치·삭제 ledger.
  - What: web/worker/maintenance와 sandbox runner 설치 경로를 문서화하고 health·권한·볼륨·secret injection·백업을 구현한다. 기존 서버/Caddy는 사용자 확인 후 연결, 공개 노출은 별도 승인. backup은 SQLite consistent snapshot+blob manifest+암호화, restore에 deletion ledger 재적용. heartbeat/status·disk quota·연동 실패를 표시한다.
  - Acceptance: 새 데이터 볼륨으로 복원 후 대화·파일·작업·승인 상태 일치, 삭제된 기억은 부활하지 않음.
  - QA happy: `bun run qa --scenario deploy-backup-restore --evidence ../../.omo/evidence/digithive-v2/task-24`; 격리 compose 기동→데이터 생성→backup→새 볼륨 restore→인증 HTTP와 파일 hash 비교. Evidence: compose.txt, manifest-diff.json.
  - QA failure: `bun run qa --scenario deploy-missing-secret-corrupt-backup --evidence ../../.omo/evidence/digithive-v2/task-24`; secret 누락·손상 backup·disk full·worker 사망; PASS iff fail closed/원볼륨 보존·status 경고, 타인 컨테이너 변경 0. Evidence: failures.json, cleanup.json.
  - Commit: Y — `Package the assistant with recoverable server operations`.

- [ ] 25. 실제 개인 정보와 푸시로 전체 사용 흐름을 검증한다
  - Recommended task executor category: deep-low — 구현자가 직접 수행하는 실연동·실표면 통합 검증.
  - Closes: GAP-3, GAP-4, GAP-5. Wave W5. Depends on: 12–24. Blocks: F1–F4.
  - Paths: `qa/scenarios/live-personal-flow.ts`, `qa/browser/live-push.ts`, `docs/operations.md`; 발견한 in-scope 결함은 해당 모듈에서 수정 후 관련 증거 재실행.
  - References: 명세 13 통합 완료 기준 1–6; 이 계획 IS-1–IS-8.
  - What: 준비된 실제 계정·서버에서 최소 범위 읽기와 유료 호출 예산을 확인하고 live smoke 수행. 실데이터·토큰은 증거에서 익명화, 인용·hash·상태만 남긴다. Calendar/Gmail/LMS 신규·변경을 확인하고 실제 과제 하나의 조사·초안·파일, 기억 정정, 정기/긴급 알림, PC·모바일 실제 푸시 수신을 연결한다. 실제 시간대의 두 회차 예약 결과를 확인한다. 강제 test trigger만으로 예정 시각 작동을 대체하지 않는다.
  - Acceptance: 실제 출처·모델·PC/모바일 Push의 증거와 재시작 연속성. 자격증명/기기/시간 대기 미충족은 pending/NEEDS_SETUP이며 최종 통과 불가.
  - QA happy: `bun run qa --scenario live-personal-flow --live --evidence ../../.omo/evidence/digithive-v2/task-25`; 실제 연결→다음 07:30/21:00 이벤트 monitor 구독→브리핑 수신·열기→“이 과제 초안을 만들어줘”→다운로드; PASS iff source map·두 slot·실제 notification click·파일 결과·비용 정산이 연결됨. Evidence: redacted-actions.json, scheduled-events.json, push-desktop.png, push-mobile.png, artifact-hash.json.
  - QA failure: `bun run qa --scenario live-disconnect-restart --live --evidence ../../.omo/evidence/digithive-v2/task-25`; 앱 측 연결 disable과 worker restart로 stale 표시·복구·기억 정정 확인. 외부 계정 삭제·메일 발송·과제 제출을 검증용으로 실행하지 않는다. PASS iff 잘못된 최신성/중복 효과 0과 복구 결과 확인. Evidence: state-diff.json, audit.json, cleanup.json.
  - Commit: Y — `Verify the complete assistant flow against live personal sources`.

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [ ] F1. Plan compliance audit
  - Recommended task executor category: deep-low — 산출물·계약·검증 누락 대조.
  - Read this plan and implementation diff, run `cd apps/assistant && bun run verify`, then root `bun run verify`. PASS iff tests/typecheck/build and all 25 acceptance receipts match current code. Evidence: final/F1.md and command logs. 작업별 부분 통과를 전체 완료로 해석하지 않는다.
- [ ] F2. Code quality review
  - Recommended task executor category: deep-high — 인증·권한·DB 경합·외부 데이터 경계 검토.
  - Read changed production code and tests with file:line findings. Reproduce criterion-cited issues through corresponding `bun run qa --scenario ...`. PASS iff no blocking correctness/security/in-scope defect; evidence final/F2.md. 범위 밖 발견은 재현 근거와 별도 기록.
- [ ] F3. Real manual QA
  - Recommended task executor category: visual-engineering — PC·모바일 실화면과 실제 수신 증거.
  - Run `bun run qa --scenario ui-full-navigation --evidence ../../.omo/evidence/digithive-v2/final/F3` and inspect task25 live artifacts against current build. PASS iff browser actions/screenshots and actual push opening support delivered behavior; fixtures-only verdict prohibited. Evidence final/F3/report.md.
- [ ] F4. Ideal-state fidelity
  - Recommended task executor category: deep-high — 사용 기대와 실제 증거를 IS별 대조.
  - Check Success criteria table 1:1 against actual run/source/cost/approval evidence; verify teardown receipts and current code identity. PASS iff IS-1–IS-8 have no deferred confirmed behavior. Evidence final/F4.md. Shortfalls become explicit corrective tasks, not notes. Execution ends only after all final checks pass; this planning session does not run product final checks.

## Commit strategy

각 task는 구현·테스트·QA 증거가 통과한 단위로 한 commit을 남긴다. 기존 history의 imperative English 제목을 따른다. 실제 메시지 작성 전 최신 log를 읽는다. 실패한 QA를 통과한 것으로 stage하지 않는다. `.omo` 전체나 개인 자료·토큰·DB·파일 산출물을 일괄 stage하지 않는다. Plan footer: `Plan: .omo/plans/digithive-v2.md`. 실행 worktree와 프로세스는 사용자 변경을 보존하며 정리한다.

이 계획 세션은 제품 commit을 만들지 않는다. 계획 문서와 익명화한 계획 검증 증거만 하나의 docs commit으로 남긴다. 앞서 작성된 미추적 명세·연구 노트는 읽기 근거이며 별도 사용자 파일로 보존한다.

## Success criteria
> One row per IS row. The plan is complete only when every IS row has a delivering todo and a proving QA scenario; F4 checks the delivered behavior against these rows 1:1, and a shortfall becomes new `- [ ] N.` rows, never a note.
| IS | Delivering todo(s) | Proving QA scenario | Evidence |
| --- | --- | --- | --- |
| IS-1 | 4,7,8,20 | run-reconnect, chat-browser, research-from-briefing-browser | task-4/8/20, task-25 |
| IS-2 | 11–15 | oauth-code-refresh, calendar-sync-recurrence, gmail-history-mime, canvas-cli-pages, live-personal-flow | task-11–15/25 |
| IS-3 | 16–19,25 | scheduler-script-agent, briefings-day-cycle, push-browser-notification, live-personal-flow | task-16–19/25 |
| IS-4 | 10,15,20,24 | memory-correct-browser, memory-revoke-inflight, deploy-backup-restore | task-10/24/25 |
| IS-5 | 9,20 | files-browser-roundtrip, files-path-size-corrupt, research-from-briefing-browser | task-9/20/25 |
| IS-6 | 4,6,7,16 | run-lease-crash-cancel, script-approved, scheduler-dst-overlap-downtime | task-4/6/7/16 |
| IS-7 | 3,5,21,22 | auth-origin-and-expiry, budget-concurrent-unknown, approval-tamper-expire-race, evolution-reject-fail-rollback | task-3/5/21/22 |
| IS-8 | 1,23–25,F1–F4 | doctor, ui-full-navigation, deploy-backup-restore, live-personal-flow | task-1/23–25, final/ |
