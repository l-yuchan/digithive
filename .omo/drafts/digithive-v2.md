---
slug: digithive-v2
status: user-approved-for-execution
intent: clear
review_required: true
plan_path: .omo/plans/digithive-v2.md
plan_sha256: 36feaad316914e73af33f5ec19ee7dde5ebf0a2f6618856c2e82ca77f6fb7698
review_round_id: digithive-v2-r2
review_round_limit: 5
pending-action: execute approved plan and deploy via SSH mini
review:
  plan_reviewer:
    status: inconclusive
    workspace_root: C:/Users/chabun/Documents/code/util/digithive
    runtime_home: null
    target: .omo/plans/digithive-v2.md
    round_id: digithive-v2-r2
    plan_sha256: 36feaad316914e73af33f5ec19ee7dde5ebf0a2f6618856c2e82ca77f6fb7698
    launch_id: digithive-v2-r2-launch1
    session: null
    result: spawn_denied_execute_stage_plan_gate
approach: fresh isolated application with durable script/agent runs, read-first integrations, conversational memory, briefings and approval-gated evolution
---

# Draft: digithive-v2

## Affected user and ideal state
<!-- Who this output touches (a customer, another programmer, a program or agent consuming it - often more than one) and how each uses it today and will use it after. -->
<!-- IS-n | property of the ideal state: nothing snags, feels odd, regresses, or degrades for them | reason -->
<!-- GAP-n | difference between IS-n and today | reason | closed by todo(s) -->

## Components (topology ledger)
<!-- Lock the SHAPE before depth. One row per top-level component that can succeed or fail independently. -->
<!-- id | outcome (one line) | status: active|deferred | evidence path -->

## Open assumptions (announced defaults)
<!-- Record any default you adopt instead of asking, so the user can veto it at the gate. -->
<!-- assumption | adopted default | rationale | reversible? -->

## Findings (cited - path:lines)

- `docs/assistant-v2-spec.md:85-100`: module responsibilities exist, but stack and concrete file boundaries remain unspecified.
- `docs/assistant-v2-spec.md:164-170`: run states lack claim/lease and approval continuation semantics; catch-up grace is unspecified.
- `docs/assistant-v2-spec.md:184-192`: Linux/server LMS credential portability is unverified.
- `docs/assistant-v2-spec.md:227-235`: approval must be bound to a version; no execution protocol for applying and rolling back environment changes yet.
- `docs/assistant-v2-spec.md:249-269`: provider support, cost reservation and unknown charge settlement need concrete contracts.
- `package.json:5-11`: prototype uses Bun, TypeScript, UI build and Bun tests; no new application constraints derive from its architecture.
- Worktree: `assistant-v2` points at `82d589b`; `.omo/`, specification and supplied research note are untracked. Preserve them and stage exact owned paths only.
- Architect advisory lane `st_01a20438` failed before tools with provider HTTP 402; this is not architecture approval. Parent takes this analysis back.
- Planning tier HEAVY; no product code or real account changes. Mandatory skill plan review remains enabled.

## Preliminary gap assessment

1. Stack, application root, public endpoints, UI flows and verification entry points.
2. Transactional schedule claims, attempt identity, lease loss, cancellation, approval continuation and restart recovery.
3. Initial sync windows, pagination, stale cursors, tombstones, source versions and cross-source candidate linking.
4. OAuth lifecycle, server credentials, script sandbox and boundaries between source data, memory and execution policy.
5. Context construction, file ingestion, memory correction/deletion propagation and truthful citations.
6. Price/usage uncertainty, concurrent budget reservation and stop-versus-settle accounting.
7. Push subscription lifecycle, read/received distinctions, downtime catch-up and urgent notification deduplication.
8. Exact change-proposal lifecycle, immutable approved versions, code deployment/restart and rollback.
9. Real integration prerequisites and validation evidence cannot be replaced by fixtures.

## Decisions (with rationale)

- 새 앱 루트 `apps/assistant/`; 기존 src/public/tests와 루트 실행 명령은 보존한다. 새 Bun+TypeScript+SQLite 앱과 TypeScript DOM 웹 클라이언트로 시작한다. 앱 내부 책임은 분리하지만 초기 서비스는 web+worker 한 서버다.
- 구현 계약은 최종 계획 Scope에 고정하고, 공급자·단가·시간대·수집 주기·권한은 버전 있는 설정이다. 사용자 원래 기준과 설계 제안값을 구분한다.
- 스크립트와 에이전트는 AutomationDefinition → Run → Attempt로 통합한다. 생성 코드의 승인 전 실행·일반 셸·무제한 네트워크 도구는 금지한다.
- 외부 자료 조회는 신뢰된 adapter, 생성 스크립트는 비밀값·네트워크 없는 container runner, 하네스 변경은 별도 maintenance 절차로 분리한다.
- 초기 외부 연동은 읽기 전용. 승인 인프라는 내부 원본 파일 교체와 도구/하네스 적용에서 실제 검증하며, 지원하지 않는 외부 쓰기 도구를 빈 구현으로 제공하지 않는다.
- 테스트는 기능과 함께 작성한다. 시간·경합·권한·커서 처리는 테스트 우선, UI/연동은 기능 후 계약 테스트와 실표면 QA. 실제 연동 검증과 fixture 검증을 별도 표시한다.
- 비용·자격증명·배포 미확정 사항은 실제 실행 전 게이트로 남기되 구현 구조는 결정한다. 검증되지 않은 개인 계정 접근을 완료로 보지 않는다.

## Integrated advisory outcome

Architect failed (HTTP 402); contract, librarian, explore and consultant lanes were cancelled without usable final reports and are inconclusive. Parent directly inspected repository/CLI and official sources: `.omo/evidence/digithive-v2-planning/sources.md`. No advisor approval claimed. Independent complete-plan review remains required.

## Review receipt

Round digithive-v2-r1 launched against SHA256 36feaad316914e73af33f5ec19ee7dde5ebf0a2f6618856c2e82ca77f6fb7698.
Receipt st_01a2046e; no plan edits while the review is in flight.
Structure and coverage checks passed; JSON LSP is unavailable because configured biome is not installed. Parse JSON directly; do not add a product dependency for this prose-only task.

## User scope extension while review is in flight

The current user explicitly authorized starting implementation immediately after review, completing Docker Compose deployment on the SSH host as the first prototype outcome, and discarding the old digithive. This supersedes the earlier planning-only stop condition. The frozen review target is not edited mid-review; deployment execution details will be appended after the verdict and reviewed if substantive.

Execution will use ulw-execute state and per-wave workers after review passes. The current goal continues through implementation and live deployment; no narrowing to document delivery.

Read-only server discovery: `C:/Users/chabun/.ssh/config` defines `mini` at 192.168.0.94:22 (leefam) and `mini-wsl` at 192.168.0.94:2222 (chabun314). BatchMode SSH probes both timed out, exit 255. No remote command or change ran. A non-blocking question asks whether to restore this host or use a different one.

Host question timed out; proceed with existing targets and do not ask again. Persistent monitor mon_VRNE1CMVG4CWV2Z3 / bash_12 wakes on SSH_READY. Reviewer st_01a2046e remains running with held lease; no verdict/approval assumed.

## Review recovery

Round r1 is INCONCLUSIVE, not approved. Latest stall investigation retrieved the complete transcript: only the opening acknowledgement, no tool/plan-read evidence or verdict. The RPC watcher had no terminal session. Retired task st_01a2046e and watcher rpc_2; cancellation/kill receipts obtained. This is recovery from an ACK-only protocol stall, not accepting an elapsed-time timeout as a review verdict.

Round r2 uses the same frozen SHA256 and native plan-reviewer with explicit `chatgpt-subscription/gpt-6-sol` model override (the responsive parent model), fresh session receipt to follow. No duplicate reviewer remains.

Round r2 launch was DENIED before a child was created: reading/invoking ulw-execute locked plan-gated reviewers in this session. Do not retry the same operation through another path. Parent acknowledged the premature workflow transition. The review_recovery question asks whether to adopt the allowed general independent gate reviewer as the review mechanism; required=true timed out. No answer means no substitute review, implementation, or deployment starts. Preserve action pending; no approval claimed.

## Current explicit approval — 2026-11-23

After receiving the final plan summary the user replied: “좋은 계획이네요. 전반적으로 문제가 있는 부분이 보이지 않습니다. 구현과 배포를 승인합니다.”

This authorizes execution of the presented plan and SSH Compose deployment. It supersedes the unanswered internal review-method question. Historical independent review remains inconclusive; do not relabel it approved or retry the denied plan-reviewer. Execute F1–F4 implementation reviews under the execution workflow.

## Affected user ledger

IS-1 대화와 작업의 서버 연속성; IS-2 근거 있는 개인 정보 연결; IS-3 일정 중심 브리핑과 절제된 푸시; IS-4 자동·정정 가능한 기억; IS-5 사용자 접근 가능한 파일; IS-6 스크립트와 AI의 내구성 실행; IS-7 승인된 행동·개선과 비용 통제; IS-8 실제 서버 운영과 검증 가능한 인계.

## Constraints sweep

Audience/scale: one person, no recruitment or generalized benchmark. Budget: USD100 comfort threshold, additional paid calls not authorized by plan writing. Stack/distribution: reversible implementation recommendation, Linux container server target subject to actual environment preflight. Retention/schema: explicit contracts in plan, no legacy destructive migration. Credentials/deploy: execution gates, never requested as secrets in chat.

## Scope IN

## Scope OUT (Must NOT have)

## Open questions

## Approval gate
status: writing-authorized-by-current-request
authorization: User explicitly instructed assessing deficiencies and then starting the detailed plan; no extra approval requested. Plan creation only; implementation is not authorized by this artifact.
<!-- When exploration is exhausted and unknowns are answered, set status: awaiting-approval. -->
<!-- That durable record is the loop guard: on a later turn read it and resume at the gate instead of re-running exploration. -->
