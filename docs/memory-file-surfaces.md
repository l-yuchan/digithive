# 기억과 파일 표면

## 왜

자산 이전(W6)은 `src/knowledge/memory.ts`와 `src/files/store.ts`를 코드와 테스트로
남겼지만 도구·API·화면이 붙지 않았다. `buildContext`는 `memories`를 받을 수 있는데
호출자는 넘기지 않았으므로 실제 제품에는 기억도 파일 저장소도 없었다. 사용자 결정은
"기억은 대부분 자동, 가끔 검토", 파일은 "클라우드 저장소처럼 열람", 그리고 "화면에
조작이 없으면 전달된 것으로 치지 않는다"이다. 이 문서가 그 표면의 계약이다.

## 의미론

- 기억의 종류(interest/fact/hypothesis/commitment/delegation) 선택은 사람의 몫이다.
  모델 도구는 `fact`와 `hypothesis`만 쓸 수 있고, 관심이 약속이나 위임으로 스스로
  승격되지 않는다.
- 정정은 삭제가 아니다. 기존 행은 남고 `superseded_by`로 새 행을 가리킨다. 회상과
  프롬프트에는 살아 있는 행만 들어간다.
- 파일 이름은 저장 전에 정규화하고, 실제 경로는 `filesRoot` 아래에만 둔다.
  업로드 크기는 상한을 넘으면 413으로 거절한다.
- 회상은 전문 일치가 아니라 2자 이상 토큰 점수다. 점수 → 최근 수정 순으로 상위 8개만
  매 턴 system 프롬프트의 `기억 요약:` 블록에 들어간다.

## HTTP API (모두 기존 패스프레이즈 세션 뒤)

| 메서드 | 경로 | 요청 | 응답 |
| --- | --- | --- | --- |
| GET | `/api/memories?includeSuperseded=1` | — | `{ memories: [{ id, kind, text, source, supersededBy, createdAt }] }` |
| POST | `/api/memories` | `{ kind, text }` | 201 `memory`, 422 `{ error: "invalid_memory", issues }` |
| POST | `/api/memories/:id/correct` | `{ text }` | 200 `memory`, 404 `{ error: "memory_not_found" }`, 422 |
| GET | `/api/files` | — | `{ files: [{ id, name, mime, bytes, sha256, origin, createdAt }] }` |
| POST | `/api/files?name=<file>` | 원본 바이트, `content-type` | 201 `file`, 413 `{ error: "file_too_large", limit }`, 422 `{ error: "invalid_file" }` |
| GET | `/api/files/:id/content` | — | 200 원본 바이트(`content-type`, `content-disposition: attachment`), 404 |
| DELETE | `/api/files/:id` | — | 200 `{ deleted: true }`, 404 |

`memory`는 `{ id, kind, text, source, supersededBy, createdAt }`이고 `file`은
`{ id, name, mime, bytes, sha256, origin, createdAt }`이다. 저장 경로는 응답에 넣지 않는다.

## 화면

새 탭 `기억`(`data-testid="tab-knowledge"`, 패널 제목 `기억과 파일`)에 두 영역을 둔다.

- 기억: 목록(`data-testid="memory-list"`, 각 항목 `memory-<id>`, 종류·내용·시각,
  정정됨 표시), 생성 폼(`data-testid="memory-form"`, 종류 선택 + 내용),
  정정 폼(`data-testid="memory-correct-<id>"`), 숨김 이력 보기(`includeSuperseded`).
- 파일: 업로드(`data-testid="file-input"`), 목록(`data-testid="file-list"`,
  각 항목 `file-<id>`, 이름·크기·시각·다운로드 링크·삭제), 오류는
  `data-testid="knowledge-error"`.

390px에서 문서 폭이 뷰포트를 넘지 않아야 하고, 1440px에서 같은 조작이 되어야 한다.
