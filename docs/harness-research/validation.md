# 검증 기록 — 실행한 것, 읽은 것, 하지 않은 것

조사일 2026-11-24. 이 문서는 계획 §10의 `validation.md`에 해당한다. 원칙: 실행하지 않은 것은 "미실행", 읽지 못한 것은 "미확인"으로 남긴다.

## 1. 실행한 명령과 관찰

| 명령 | 목적 | 결과 |
|---|---|---|
| `omo --version` | 실행 중 하네스 식별 | `omo 5.1.65 (engine: senpi 2026.11.6-3)` |
| `npm view @code-yeongyu/senpi` | 엔진 저장소·라이선스 | `github.com/code-yeongyu/senpi`, MIT, latest 2026.11.23 |
| `gh api repos/{code-yeongyu/oh-my-openagent, sst/opencode, openai/codex}` | 대상·버전·규모 고정 | 표는 `sources.md` §2. `sst/opencode` → `anomalyco/opencode` 리다이렉트 확인 |
| `git clone --depth 1` ×3 | 코드 경로 추적용 사본 | 3개 완료. HEAD 커밋 기록됨 |
| `gh api 'search/issues?q=...'` ×7 | OmO 이슈 계열 탐색 | 40건/질의. 결과 JSON은 조사 워크스페이스 `notes/omo_*.json` |
| `gh api repos/.../issues/{n}` + `/comments` ×10 | 사례 본문·댓글 | `notes/issues/i{n}.json` |
| `tinyfish search query` ×3 | UI 라이브러리·하네스 구조·senpi 계보 | 결과 JSON 저장, 인용은 본문에 반영 |
| `tinyfish fetch content get` ×4 | omo.dev, opencode permissions, codex local-config, assistant-ui/aparte/AI SDK | 본문 인용 |
| `firecrawl --status` | 대체 스크레이프 수단 확인 | 인증됨(1017 크레딧). 이번엔 미사용 |
| 파일 읽기 (senpi docs 8종, 저장소 코드 다수, digithive v2 파일 6종) | 근거 확보 | `sources.md` §4 |

## 2. 실행하지 않은 것 (미실행)

- 세 하네스의 실제 실행 관찰 비교: 설치·실행·동일 시나리오 구동을 하지 않았다. OmO는 이 세션 자체로만 관찰했다.
- OpenCode/Codex 로컬 설치·실행 없음.
- 유료 모델 호출 실험 없음(비용 0). tinyfish·gh 호출만 사용.
- 모바일 실기기에서 digithive 입력 품질 테스트 없음.
- 이슈 스레드 전수 열람 아님(선별 10건 + 제목 14건).

## 3. 위임 조사 시도와 결과 (실패 기록)

계획된 코드 경로 조사를 서브에이전트 3개(OpenCode/Codex/OmO)에 위임했으나, 세 자식 모두 실패했다.

- 위임 후 두 번째 점검 시점까지 산출물 파일 0건, 상태는 계속 `running`.
- 2026-11-23에 같은 패턴(자식이 running으로 남고 산출물 없음)을 관찰한 기록이 있고, 그때의 교훈은 "두 번째 점검에 산출물이 없으면 기다리지 말고 취소"였다.
- 조치: 세 자식 모두 취소(`task_cancel`). 남은 조사는 직접 수행.
- 영향: 이 실패 자체가 조사 대상 하네스의 결함 계열(정산 안 됨, 진행 가시성 부족)의 재현 사례다. `case-studies.md`의 C1·C9 계열과 일치하며, "실행 관찰"로 기록한다.
- 한계: Codex·OpenCode의 일부 축(Q4 컨텍스트 조립 세부, Q6 확장 세부)은 위임이 담당할 예정이었으므로 근거 밀도가 낮다. `report.md`의 "미확인" 목록에 반영했다.

## 4. 근거 등급 표기

인용한 각 사실은 다음 중 하나로 취급했다.
- **코드**: 파일을 열어 확인(경로 명시).
- **문서**: 제품 저장소 docs 또는 공식 사이트(URL 명시).
- **이슈**: GitHub 본문·댓글(번호·상태·날짜 명시).
- **실행 관찰**: 명령 실행 결과.
- **추론**: 위 근거에서 도출한 판단. 표에 "판단"으로 표기.

`comparisons.md`와 `architecture-options.md`의 권고는 모두 **판단**이며, 근거는 같은 문서 안에서 참조된다.

## 5. 재현 방법

조사 사본은 `C:/Users/chabun/Documents/code/research/harness/`에 남아 있다. 이슈 JSON과 웹 수집물은 같은 폴더의 `notes/`에 있다. 재검증하려면:

```
gh api repos/anomalyco/opencode --jq .default_branch
cd research/harness/opencode && git log -1 --format=%H
cd research/harness/codex && git log -1 --format=%H
cd research/harness/oh-my-openagent && git log -1 --format=%H
```

각 HEAD가 `sources.md` §2와 다르면 그 사이 변경이 있을 수 있으므로, 인용한 줄 번호·심볼을 다시 확인해야 한다.
