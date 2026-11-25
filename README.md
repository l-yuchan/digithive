# digithive

개인용 대화형 에이전트 하네스의 저장소입니다. 실행되는 애플리케이션은 `apps/harness` 하나이고,
CI·CD·이미지·배포가 모두 그 디렉터리만 봅니다.

```bash
cd apps/harness
bun install
bun run build:web
bun run verify
```

실행 방법, 스키마 마이그레이션 규칙(최근 2회 전이만 보존), 연동 환경변수, 배포 절차는
[`apps/harness/README.md`](apps/harness/README.md)에 있습니다. 배포 파이프라인은
[`docs/ci-cd.md`](docs/ci-cd.md)가 정본입니다.

- `apps/harness/src` 서버·워커 엔진, `apps/harness/jobs` 앱이 실어 보내는 워크플로 스크립트,
  `apps/harness/web` 웹 클라이언트
- `docs/` 설계·운영·QA 기록, `.omo/` 계획과 작업 기록(역사 문서; 코드는 지금 저장소에 없을 수 있음)
