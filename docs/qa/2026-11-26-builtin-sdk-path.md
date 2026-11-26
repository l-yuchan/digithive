# 연결 자료 수집 실패 — `Cannot find module '../.digithive/sdk.ts'` (2026-11-26)

## 보고된 증상

```
error: Cannot find module '../.digithive/sdk.ts' from '/app/jobs/collection.ts'
Bun v1.4.4 (Linux x64)
```

## 원인

워크플로가 `@builtin/collection.ts`를 실행하면 `resolveScriptPath`는 저장소의
`apps/harness/jobs/collection.ts`를 읽습니다. 이미지에서는 이것이 `/app/jobs/collection.ts`입니다.
이 파일은 `../.digithive/sdk.ts`, 즉 `/app/.digithive/sdk.ts`를 import 합니다.

그런데 SDK는 `<HARNESS_SCRIPTS_ROOT>/.digithive/sdk.ts`에 생성되고, compose는
`HARNESS_SCRIPTS_ROOT=/app/jobs`를 줍니다. 그래서 SDK는 `/app/jobs/.digithive/sdk.ts`에 있었고,
`/app/.digithive`는 아무도 만들지 않았습니다.

작업 스크립트를 `<scriptsRoot>/jobs/`에 심는 설치본과, 설치본의 부모를 상정한 import 경로가
서로 다른 디렉터리를 가리킨 것이 본질입니다. 검증되지 않은 것도 직접 원인입니다:
`workflow-sdk.test.ts`는 픽스처 스크립트를 `<root>/jobs/`에 직접 쓰고 `syncSdkFile(root)`도 함께
하므로 두 쪽이 항상 일치했다. `@builtin/*`를 실제로 실행하는 테스트가 없었다.

라이브 확인(`ssh mini`):

```
/app: src scripts jobs web package.json tsconfig.json node_modules
/app/.digithive: No such file or directory
/app/jobs/.digithive/sdk.ts: 4123 bytes   (기동 시 생성)
```

## 수정

- `jobs/collection.ts`, `jobs/briefing.ts`가 SDK를 자기 디렉터리에서 import한다:
  `./.digithive/sdk.ts`. 이 앱의 작업은 항상 스크립트 루트의 `jobs/` 안에서 실행되므로
  (배포 시 `/app/jobs`, 로컬 시 `<scriptsRoot>/jobs`), 위치가 한 가지로 고정된다.
- `installJobs`가 SDK를 작업 파일 옆(`<scriptsRoot>/jobs/.digithive/sdk.ts`)에 심는다.
  이전에는 `<scriptsRoot>/.digithive`에만 썼다.
- `.digithive/`는 생성물이므로 `.gitignore`에 넣고, 이미 추적되던 `scripts/.digithive/sdk.ts`는
  추적에서 뺐다(파일은 남는다).
- 실행기가 모듈을 못 찾았을 때 경로에 공백이 있으면 그 이유를 stderr에 덧붙인다. Bun은
  공백이 들어간 경로의 파일에서는 실제로 존재하는 모듈도 "Cannot find module"로 보고하며,
  이때는 스크립트 디렉터리 이름의 공백을 없애야 한다(별개 제약, 실행기는 그대로 둔다).

## 검증

- 회귀 테스트 `tests/jobs.test.ts` — “an installed job starts and reaches the SDK, from a root
  that only has the install”: 설치만 된 새 루트에서 `@builtin/collection.ts`를 실제 실행하고,
  실패 사유에 `Cannot find module`이 없으며 계정을 찾지 못했다는 메시지가 있는지 본다.
  수정 전 코드(import를 `../`로 되돌림)로 실행하면 이 테스트가 실패한다.
- 표면 실행: `createRuntime`으로 작업 도구를 연결한 런타임을 만들고 이미지와 같은 형태의
  루트에서 수집 워크플로를 실행. 수정 전 `failed` / `Cannot find module`, 수정 후 `succeeded`.
  증거 `.omo/evidence/job-sdk-fix/pre-fix-run.json`, `.omo/evidence/job-sdk-fix/local-surface-run.json`.
- `bun run verify`: 291 pass, 0 fail; lint/typecheck/build/format 통과.
