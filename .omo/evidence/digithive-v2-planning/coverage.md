# 명세 대응 검토

이 검토는 상세 계획의 요구 포함 여부에 대한 QA-by-read다. 제품 동작의 PASS를 뜻하지 않는다.

| 명세의 확정 요구 | 계획 작업 | 관찰할 결과 |
|---|---|---|
| 대화 중심·일상 질문 | 7,8,20,23 | chat-browser, 단일 답변·위임 결과 |
| 독립 서버·PC/모바일 | 1,4,23,24,25 | worker 연속성, 반응형 화면, 실제 서버 |
| 클라이언트 종료 후 지속 | 4,8,20 | run-reconnect, checkpoint 재개 |
| Google Calendar | 11,12,15,25 | OAuth, 반복 일정·증분·실제 자료 |
| Gmail | 11,13,15,25 | history·MIME·후보와 실제 정보 |
| Hanyang Canvas CLI | 1,14,15,25 | Linux preflight, 지정 host CLI 수집 |
| 내부 파일 클라우드 접근 | 9,20,23 | upload/list/download와 authenticated file link |
| 대화 답변·파일 경로 안내 | 8,9,20 | 대화→산출물 다운로드 |
| 07:30/21:00 브리핑 | 16,17,25 | 두 실제 slot과 morning/evening 구분 |
| Web Push 우선 | 18,23,25 | 구독·알림·실제 PC/모바일 notification click |
| 다음 브리핑 이전 시급한 변화 | 15,17,18 | actionable-before 비교와 중복/철회 |
| 메일의 일정·작업 추출 | 13,15 | 확정/후보 구분과 근거 |
| 뉴스레터·관심 검색 | 19 | 짧은 정기 부가 정보, 긴급 승격 0 |
| API Key·저비용 모델 | 5,7 | configurable model, 비용 사전 예약 |
| 월 USD100 초과 부담 | 5 | comfort 기준과 정책 제안 구분, unknown 비용 |
| 자동 기억·나중 점검 | 10,23 | automatic extraction, correction UI |
| 명시적 외부 권한 | 3,7,21 | unknown tool deny, 승인 hash, 무단 효과 0 |
| Skill/하네스 변경 승인 | 6,21,22 | 격리 시험·승인·version 적용·rollback |
| 유동적 전문가, 실행 방식 자유 | 7,20 | 단일 실행 기본·필요한 작업별 역할 |
| 스크립트와 AI 자동화 | 4,6,7,16 | 같은 Run/예약 계약, 모델 없는 collector |
| 장기 진행 시각화 구상 | 8,23 | 초기 작업/자료/상태, 상세 화이트보드는 후속 |

## 제안값과 미검증 전제

- Asia/Seoul, 15분, 일 1회 탐색, 70/90/100 제어, 기술 구성, 백업 14일은 사용자 승인으로 표현하지 않았다.
- 실제 서버·도메인·Google OAuth·Canvas Linux 인증·모델/검색 API·실제 푸시 기기는 구현의 preflight/live gate다.
- fixture QA와 실제 연동 QA를 분리했다. 작업25가 미완료면 실사용 완료로 선언할 수 없다.
- 단순 다중 에이전트 프레임워크 구축으로 목표를 축소하지 않았다.
- 기존 코드·미추적 명세·연구 노트는 보존하고 계획 파일만 commit한다.

## 부모 자체 검토

누락 위험이 큰 항목은 기억 삭제의 파생 전파, Calendar 증분 query 제약, 초기 Gmail 수집 중 새 메시지, 승인과 실행 사이 race, usage 누락 비용, worker 재시작과 pending 푸시다. 계획 Scope의 계약과 해당 failure 시나리오에 반영했다.

결론: 요구 포함 검토 PASS. 실제 기능·실제 연동은 아직 구현·실행하지 않았다. 독립 계획 검토 결과는 review.md를 따른다.
