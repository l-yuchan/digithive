# 청소 실행 기록

2026-11-25. 계획 `2026-11-25-cleanup-plan.md`를 소유자 결정(마이그레이션 2회 규칙 포함)에 따라 실행한 결과.

## 결정 (소유자)

- 이 프로젝트는 프로덕션 상태가 아니며, 레거시 DB는 항상 최신 스키마로 마이그레이션한다.
- 마이그레이션 코드는 최대 2회 전이만 보존한다(v100이면 v98→v99, v99→v100).
- Q1 레거시 `parts` 엔트리를 최신 `events` 형태로 정규화, Q2 Google 기본 계정 폴백 제거,
  Q3 v1 루트 앱과 `apps/assistant` 삭제, Q4 `citations.ts` 삭제, Q5 `src/jobs` ↔ `jobs/` 분리,
  Q6 stale vim swap 파일은 이미 해제됨.

## 커밋

| 커밋 | 내용 |
| --- | --- |
| `9f69c5b` | 청소 전 기준: 진행 중이던 jobs 스크립트화·대화 이벤트 일급화 작업 커밋 |
| `53e2f93` | 마이그레이션 체인 재편 + 엔트리 payload 정규화(v12) |
| `2c588dc` | v1 루트 앱 제거(56파일, 6,873줄) |
| `d28f278` | 죽은 export 제거, 이벤트 종류 정합 검사, 기본 Google 계정 폴백 제거, `citations.ts` 삭제 |
| `2f9ad5b` | 워크플로 스크립트/서버 코드 분리, v2 변환 도구 삭제, 거짓이 된 문서 수정 |
| `8d63049` | 라이브 v10 DB를 열 수 있게 경계 수정(리허설이 잡은 결함) |

## 마이그레이션 체인

- `src/store/migrations.ts`: `RESET_SCHEMA`(v11, 옛 v1~v10의 산물을 한 번에), `TRANSITIONS`(v11, v12), `RESET_VERSION=11`.
- `src/store/db.ts`: 새 DB는 리셋 스키마에서 시작, 기존 DB는 `user_version` 위의 전이를 한 트랜잭션씩 적용.
  전이는 `run(db)`으로 행 단위 재작성을 같은 트랜잭션에 담을 수 있다. 열 수 있는 가장 오래된 버전은
  `OLDEST_OPENABLE = 10`(라이브 서버), 그보다 오래된 DB는 반쯤 올리지 않고 핸들을 닫은 뒤 거부한다.
- v11: 그 빌드가 출하한 DB의 builtin executor와 capabilities 없는 shipped script를 고친다(2회 보존분).
- v12: `parts` payload를 `events`로 다시 쓰고(denied 보존), writer와 같은 규칙으로 FTS 재색인,
  v1 `parts` 테이블은 더 이상 만들지 않는다.
- 삭제: `account-migration.ts`·`identity-migration.ts`·`schedule-migration.ts`·`workflow-migration.ts`·
  `job-migration.ts`와 그 테스트 2개.

## 검증

- `bun run verify` 255 pass / 0 fail, lint·typecheck 0, 웹 빌드 성공(39 파일).
- `tests/schema-upgrade.test.ts`: v10에서 올린 DB와 새 DB의 스키마(테이블·컬럼·인덱스·트리거)가 **완전히 같음**,
  옛 `parts` 엔트리가 손실 없이 `events`로 바뀜(denied 보존 포함).
- `tests/store.test.ts`: 전이의 버전 기록과 재작성이 같은 트랜잭션(재작성 중 예외 시 둘 다 되돌림), 재실행 멱등,
  리셋보다 오래된 DB 거부.
- `tests/event-kinds.test.ts`: 선언된 모든 이벤트 종류는 `src`에서 쓰이거나 legacy 절에 있어야 하고,
  legacy로 표시된 종류는 코드에 남아 있으면 안 된다.
- **라이브 데이터 리허설**(배포 전): 라이브 DB `VACUUM INTO` 스냅샷을 로컬로 복사해 새 migrator로 변환 →
  `user_version` 10→12, `integrity_check=ok`, FK 위반 0, 엔트리 65/65 `events` 형식, legacy 0, `parts` 테이블 없음,
  FTS 61행 재색인 및 실제 텍스트 검색 일치.

## 리허설이 잡은 결함

open 경계가 기록 버전을 리셋(v11)과 비교해 **라이브 v10 DB를 거부**했다. 리셋 스키마는 v10의 산물과 같으므로
열 수 있는 가장 오래된 버전은 v10이다. `OLDEST_OPENABLE`을 도입하고 테스트를 실제 경계로 고쳤다(`8d63049`).

## 남긴 것

- `DEFAULT_CANVAS_ACCOUNT_ID`: 단일 LMS 신원 설계상 고정 id(유지).
- `DEFAULT_GOOGLE_ACCOUNT_ID`: 시드 행의 id로만 남김(다른 fallback은 제거됨).
- `.omo/` 계획·조사 기록: 역사 문서로 유지(지금 저장소에 없는 코드를 가리킬 수 있음, 각 문서 머리에 명시).
- `docs/harness-research/*`, `docs/qa/*`: 그 시점의 기록으로 유지.
