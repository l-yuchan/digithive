# 기억·파일 표면 검증

브랜치: `memory-file-surfaces`. 방향과 API 계약:
`docs/memory-file-surfaces.md`.

이전에는 기억·파일 저장 모듈과 단위 테스트만 존재했고 실제 대화, HTTP,
화면에서 도달할 수 없었다. 새 기억 탭은 기억 생성·정정·이력 검토와
파일 업로드·목록·다운로드·삭제를 제공한다. 대화는 관련 기억을 자동 회상하고
모델은 등록된 도구로 기억과 텍스트 파일을 사용할 수 있다.

## 실행한 증거

증거 경로는 `.omo/evidence/memory-file-surfaces/` 기준이다.

| 기준 | 실행과 관찰 | 결과·증거 |
| --- | --- | --- |
| C1 기억 주입 | 실제 HTTP 서버에 기억 생성·정정 후 대화 전송. 별도 OpenAI 호환 HTTP 수신 서버가 받은 요청에 `회의 수요일`만 존재, `회의 화요일` 없음 | PASS `c1-prompt.json` |
| C2 파일 왕복 | 원본 바이트 POST 후 GET 다운로드. 두 SHA256 동일 | PASS `c2-sha.txt` |
| C2 화면 | 실제 서버에서 기억 생성·정정·이력 선택, 파일 입력으로 업로드, 두 단계 삭제. 문서 폭 390/1440px가 뷰포트와 일치 | PASS `c2-mobile.png`, `c2-desktop.png`, `mobile-files.png`, `browser-actions.txt` |
| C3 경계 | 이전 행 보존, 이전 ID 재정정 404, 없는 파일 404, 10MiB 초과 413, 경로 이름 정규화 및 저장 루트 안의 파일, 삭제 시 실제 바이트 제거 | PASS `http-evidence.json`, `tests/knowledge-http.test.ts` |
| C4 모델 경계 | 실제 등록 도구가 commitment 생성 거부, fact 저장 성공 후 화면에서 표시. 큰 파일 입력의 실패 원인과 상한도 화면에 표시 | PASS `http-evidence.json`, `c2-desktop.png`, `upload-error.png` |

모델의 실제 자율 판단 품질은 검증하지 않았다. C1은 실제 서버·SQLite·대화
실행 계층·모델 HTTP 전송을 실행하고, 응답만 결정론적 제공자로 대체했다.
외부 계정 및 운영 배포는 이 브랜치의 검증 대상이 아니다.

## 검사와 자체 리뷰

- `bun run verify`: lint, typecheck, web build 성공. 195 tests passed, 0 failed.
- `bun run fmt:check`: 새 기억 주입 행의 포맷 오류를 발견해 해당 파일만
  Oxfmt로 수정한 뒤 exit 0.
- 회상 입력을 빈 문자열로 바꾼 변이는 새 대화 회귀 테스트에서 실패했다
  (4 pass, 1 fail). 원상 복구 후 관련 11개 테스트가 통과했다.
- UI 자식의 `child-ui.md`와 실제 파일을 읽고 부모가 브라우저를 직접 조작했다.
  초기 두 자식은 사용량 제한으로 실행 전 실패했고, 세 번째 자식이 UI를 완성했다.
- HEAVY 유지: 저장된 개인 자료를 모델 맥락과 다운로드 응답에 연결한다.
  정정은 트랜잭션 안에서 원본을 보존하고 이미 정정된 행의 재사용을 거부한다.
  모델은 약속·위임을 새로 만들 수 없고 회상 자료는 허가로 취급하지 않는다.
  주입은 최대 8개, 각 1,000자로 제한하며 잘림을 표시한다.
- 파일 기본 경로는 DB 옆 `files/`이므로 기존 `/data` 볼륨에 보존된다.
  `HARNESS_FILES`, `HARNESS_MAX_UPLOAD_BYTES`로 경로와 크기를 설정한다.
- 전체 WCAG 적합성 감사는 수행하지 않았다. 기존 어두운 테마를 재사용했고
  이번 캡처에서 글자 겹침·가로 넘침·조작 불가 상태는 관찰되지 않았다.
- 사용자 요청은 ulw-plan 또는 엄격 리뷰가 아니므로 ULW의 자체 리뷰 게이트를
  적용했다. 독립 리뷰 승인을 주장하지 않는다.

## 정리

Owned Chrome 종료, 서버/모델 수신 프로세스 종료, 임시 DB·브라우저 프로필·
캐시 디렉터리 제거. 포트 18879 응답 없음과 디렉터리 부재를 확인했다:
`cleanup.json`. 캡처·로그는 로컬 증거로 보관하며 Git에는 이 보고서를 남긴다.

작업 노트:
`C:/Users/chabun/AppData/Local/Temp/ulw-20261125-115648.5a5v2O.md`.
