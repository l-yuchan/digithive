# 조사 출처·대상·접근 기록

조사일: 2026-11-24 (KST). 조사자: digithive 세션의 에이전트.
이 문서는 `docs/harness-research-plan.md` §4.1, §10 단계 A의 산출물이다.

## 1. 조사 방법과 도구

| 도구 | 버전 | 용도 | 접근 결과 |
|---|---|---|---|
| `gh` CLI | 로그인 계정 `l-yuchan` (repo 스코프) | 저장소 메타데이터, 이슈·PR·댓글 조회 | 정상 |
| GitHub REST `search/issues` | — | 저장소별 주제 검색 (질의당 최대 40건) | 정상, 전수 아님 |
| `tinyfish` | 0.59.0 | `search query`, `fetch content get`로 공식 사이트·문서 수집 | 정상 (검색 3건, 문서 4건) |
| `firecrawl` CLI | 1.19.6 | 인증 확인 (`--status`), 문서 스크레이프 대체 수단 | 인증됨 (1017 크레딧), 이번 조사에서는 tinyfish fetch로 충분해 미사용 |
| git shallow clone (`--depth 1`) | — | 코드 경로 추적용 로컬 사본 | 3개 저장소 완료 |

로컬 사본 위치: `C:/Users/chabun/Documents/code/research/harness/{opencode,codex,oh-my-openagent}` (조사용, 제품 저장소 밖).

## 2. 대상 식별 (혼동 방지)

| 호칭 | 실제 정체 | 근거 |
|---|---|---|
| **OmO** | npm `omo-ai`. 실행 중 버전 `omo 5.1.65 (engine: senpi 2026.11.6-3)`. 저장소 `code-yeongyu/oh-my-openagent`, `dev`, HEAD `06011dfda8733fd50a8032251ef95fb650569f4f` (2026-11-24 11:14 +09:00), repo package version 5.1.83, stars 71,089, open issues 3,069, license `NOASSERTION`(LICENSE.md/CLA.md 별도) | `omo --version`, `plugin/package.json`, `gh api repos/...` |
| **OmO 엔진** | `@code-yeongyu/senpi` — "an opinionated fork of badlogic/pi-mono". MIT. npm latest 2026.11.23, 로컬 2026.11.6-3. 저장소 `code-yeongyu/senpi` (별도) | senpi `docs/index.md`, `npm view`, 로컬 `package.json` |
| **OpenCode** | `sst/opencode` → **`anomalyco/opencode`** 로 리다이렉트. MIT. `dev`, HEAD `8c80aff92ba359a67fe6d2a961a76cad067b0686` (2026-11-23 23:37 -0500), stars 228,839, open issues 4,026 | `gh api repos/sst/opencode`(리다이렉트 확인), `gh api repos/anomalyco/opencode` |
| **Codex** | `openai/codex`. Apache-2.0. `main`, HEAD `714bc44f0dd9787632ed9d294fa0d6cb1fb844c8` (2026-11-24 04:29 UTC), stars 136,267, open issues 28,435. Rust 워크스페이스 `codex-rs/` | `gh api repos/openai/codex` |

### 식별 함정 (실제로 존재함)
- OmO는 **현행 기준 OpenCode 플러그인이 아니다**. 엔진이 senpi(pi-mono 포크)로 바뀌었고, 패키지 설명·라벨·이슈에는 OpenCode 시대 흔적이 남아 있다: `package.json` description "Batteries-Included OpenCode Plugin", 이슈 라벨 `opencode`, #12118 "…on OpenCode 1.x", #10905 `Revert "feat(omo-opencode): load on OpenCode 2 and point to OmO Native"`.
- 서드파티 포크 `kejian-tong/oh-my-openagent`는 "multi-model agent orchestration harness for OpenCode"로 소개된다 → 이름이 같은 다른 계보. 조사에서 제외하고 위 표의 저장소만 대상으로 삼았다.
- `senpi`는 `badlogic/pi-mono` 포크이며, senpi 문서의 compaction 절은 소스 링크를 `earendil-works/pi`로 건다(포크 계보가 한 단계 더 있음). 문서 링크와 로컬 배포물이 같은 코드라는 보장은 없다.

## 3. 접근 제약·공개 수준

| 항목 | 상태 |
|---|---|
| OmO 저장소 코드 | 공개 (packages/, crates/, tests/, docs/, signatures/) |
| OmO 실행 환경 | 로컬 설치본 `node_modules/omo-ai/plugin` (dist 번들 + extensions) |
| senpi 엔진 소스 | 별도 저장소로 존재하나 이번 조사에서 clone하지 않음. 판단 근거는 **배포물의 `docs/`(약 1.37 MB) + README + CHANGELOG** |
| senpi 엔진 dist | 번들(`dist/bundle`)만 있어 내부 구현은 번들 수준에서만 확인 가능 |
| OpenCode 코드 | 전체 공개, AGENTS.md에 의존 방향 규칙 명시 |
| Codex 코드 | 전체 공개 (Rust), `docs/`에 sandbox·execpolicy·config 문서 |
| 제품별 실제 UI 체험 | 미실시. 이번 조사는 코드·문서·이슈 읽기 중심이며 실행 관찰은 OmO(현재 세션 자체)에 한정 |

## 4. 읽은 출처 목록

### 4.1 로컬 1차 자료 (senpi 엔진 배포물)
`C:/Users/chabun/.bun/install/global/node_modules/@code-yeongyu/senpi/`
- `docs/index.md` — 엔진 정체("opinionated fork of badlogic/pi-mono"), 문서 지도
- `docs/sessions.md` — JSONL 트리 세션, `/tree`·`/fork`·`/clone`, 브랜치 요약, 이동/리바인드
- `docs/security.md` — 프로젝트 신뢰, 내장 샌드박스 없음, 권한 프리셋(`full-access` 기본, `workspace`, `read-only`, `ask`)
- `docs/schedule.md` — `schedule_prompt`, 러너, 리스·전달 보장(at-most-once)
- `docs/rpc.md` §Events (line 6248~) — 이벤트 타입 표 전체, `agent_settled`/`agent_idle` 구분, `host_stalled`, `session_recovered`, `retry_fallback_exhausted`
- `docs/rpc.md` §Commands — `prompt`/`steer`/`follow_up`의 `clientMessageId` 멱등 중복 제거
- `docs/compaction.md` — 압축·브랜치 요약, 소스 파일 위치
- `docs/prompt-presets.md` — `buildDynamicSystemPrompt` 등 네이티브 프롬프트 생성 함수 노출
- `docs/session-format.md`(목차), `docs/extensions.md`, `docs/skills.md`, `docs/mcp.md`, `docs/providers.md`, `docs/sdk.md` (존재·규모 확인)

### 4.2 원격 1차 자료 (제품 저장소 코드)
- `opencode/AGENTS.md` — 의존 방향: Schema → Core/Protocol → Server, Client는 Schema/Protocol까지, `sdk`가 합성
- `opencode/packages/*/package.json` — `app`은 SolidJS 계열(`solid-js`, `@kobalte/core`, `@dnd-kit/solid`), `tui`는 `@opencode/ui`·`plugin`·`simulation` 기반
- `opencode/packages/app/src/session/{fork.ts,revert.ts,fork-machine.ts,revert-machine.ts}` (파일 존재·테스트 존재 확인)
- `opencode/packages/protocol/src/groups/*.ts` — HTTP API 그룹(agent, artifact, automation, blob, command, config, credential, debug, event …)
- `opencode/packages/schema/src/*` — config/policy/flag 등 스키마
- `codex/codex-rs/protocol/src/protocol.rs` — `Op::Interrupt`("Abort current task without terminating background terminal processes", `EventMsg::TurnAborted` 응답)
- `codex/codex-rs/app-server/README.md` — `item/commandExecution/requestApproval`, `experimentalApi`/`requiredHumanApproval`
- `codex/codex-rs/` 크레이트 목록 — `app-server`, `app-server-protocol`, `app-server-transport`, `exec`, `execpolicy`, `sandboxing`, `core`, `tui`

### 4.3 웹 문서 (tinyfish fetch)
- OmO 공식 사이트 `https://omo.dev/` — 설치, 스킬 목록, 모델 목록, 메신저 연동 "Coming soon", 70.3k stars / 4.4M+ downloads 표기(사이트 기준)
- OpenCode `https://opencode.ai/docs/permissions/` — ordered `action`/`resource`/`effect` 규칙, last-match-wins, 기본 정책(`*` allow, `.env` ask), 승인 응답 `once`/`always`/`reject`(reject는 세션의 다른 대기 승인까지 거부), `policies` 하드 deny
- Codex `https://developers.openai.com/codex/local-config` — (수집 완료, 요약은 codex 조사 절)

### 4.4 이슈·PR (GitHub API로 본문·댓글 열람)
`code-yeongyu/oh-my-openagent`: #9711, #11269, #14354, #14543, #14649, #14329, #11856, #7288, #11527, #14508 — 상세는 `case-studies.md`.
추가로 제목·상태만 확인한 항목: #10905, #7728, #11859, #12625, #11039, #14493, #14476, #13016, #7202, #5197, #5865, #7152, #9232, #12344.

### 4.5 대화·세션 관찰 (실행 관찰)
- 2026-11-23 이 세션: `task`로 띄운 자식이 6분 이상 `running` 상태로 남고 worktree에 산출물 0건. 같은 작업을 직접 수행하니 약 10회 도구 호출로 typecheck/build/doctor 통과. → 하네스 상태 표시와 실제 진행의 괴리(이슈 #9711/#7288 계열과 일치).

## 5. 남은 접근 제약
- senpi 엔진 repo(`code-yeongyu/senpi`)와 `badlogic/pi-mono`는 clone하지 않았다. 엔진 내부 구현 주장은 배포물 docs/README 근거로만 한정했다.
- Codex 이슈 트래커(28k open)는 표본 조사하지 않았다. Codex 관련 진술은 코드·docs 근거로만 한다.
- OpenCode는 이슈 조회를 하지 않았다. 실패·회귀 사례는 OmO에서만 수집했다(계획 §7이 OmO 중심 심층 조사를 요구).
