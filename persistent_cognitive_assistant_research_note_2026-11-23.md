# 지속형 인지 비서의 연구 질문과 설계 논점

> **핵심 질문** — 사람의 생각, 관심사, 약속, 미해결 문제를 지속적인 상태로 관리하고, 그 상태로부터 적절한 행동을 생성하는 시스템은 어떻게 만들어야 하는가?
>
> **성격**: 프로토타입 이전의 개념·문헌 검토 노트 (v0.1)  
> **작성일**: 2026-11-23  
> **범위**: 문제 정의 → 인지·기억 모델 → 시간과 불확실성 → 행동 판단 → 실행·권한 → 구현 가설. **Episode 벤치마크의 데이터셋·채점 규칙은 다루지 않음.**

## 읽는 방법과 근거의 수준

이 문서는 앞선 대화에서 논의한 **개인 비서 / Git Blackboard 기반 멀티 에이전트 / 장기 기억 및 하네스** 구상을 하나의 연구 질문 아래 재배치한다. 다음 표기를 일관되게 사용한다.

- **[과거 구상]**: 현재 대화에서 확인 가능한 이전 논의의 요약. 원 대화 전문을 대조한 축어 인용이나 확정된 요구사항 명세는 아니다.
- **[문헌]**: 검증한 논문·표준·공식 문서의 주장. 각주로 출처를 연결한다.
- **[가설]**: 이 프로젝트에 적용할 수 있다고 생각되는 새로운 해석. 아직 실증되지 않았다.
- **[제안]**: 첫 프로토타입의 범위를 줄이기 위한 잠정적 선택. 문헌의 결론과 구별해야 한다.

각주는 **무엇을 참고할 수 있고, 무엇까지는 주장할 수 없는지**를 덧붙였다. 사례는 별도 표시가 없다면 이해를 위한 가상 예시다.

---

## 0. 논의의 요약

**이 프로젝트는 '지식 검색 챗봇'도, '자동화 스케줄러'도, '멀티 에이전트 프레임워크'도 아니다.** 세 요소를 결합할 수는 있지만 각각이 전체 목표를 대체하지는 못한다. 연구 대상은 **장기적으로 변화하는 개인의 인지적 상태와 외부 환경 사이에서, 언제 어떤 행동이 정당화되는지를 판단하는 지속형 시스템**이다.

1. **기억하기**: 단편적 발화를 사실·선호·가설·관심사·계획으로 구별하고 출처·시점을 유지한다.
2. **변화 이해하기**: 새 정보가 과거 내용을 보완·반박·철회하는지 판단하고, 기존 상태를 무조건 덮어쓰지 않는다.
3. **숙성시키기**: 아직 작업으로 정의되지 않은 생각도 연결·재방문·잠복 상태로 유지한다.
4. **결정하기**: 새로운 사건이나 시간 경과가 개입을 요구하는지, 침묵하는 편이 나은지 비교한다.
5. **실행하기**: 실제 작업으로 전환되는 순간부터 권한·담당자·검토·복구 가능한 실행 절차를 적용한다.
6. **배우기**: 수행 결과와 사용자 피드백을 축적하되, 외부 콘텐츠가 곧바로 행동 규칙을 변경하지 못하게 한다.

한 줄로 축약하면 **'지속형 개인 상태 추정 + 정책에 따른 선제적 개입 + 분리된 작업 실행'**이다. 인지 활동이 도구와 결합된다는 생각은 '확장된 마음(extended mind)' 논의와 철학적 접점이 있지만, 그 논문이 이런 비서의 구현 가능성을 증명하는 것은 아니다.[^clark] CoALA는 기억·행동 공간·의사결정을 분리해 언어 에이전트를 기술하므로 아키텍처를 논의하는 유용한 틀이다.[^coala]

## 1. 무엇이 문제인가: 정보 관리와 인지 보조의 차이

### 1.1 검색 가능한 과거와 행동에 쓸 수 있는 과거

기존 노트·RAG·대화 검색이 잘하는 일은 **주어진 질문에 관련된 과거 정보를 찾는 것**이다. RAG는 외부 비모수 기억을 모델에 결합하는 방향을 제시했고, 근거를 함께 제공할 수 있다는 점에서 중요하다.[^rag] 그러나 개인 비서는 다음의 질문까지 다뤄야 한다.

- “작년의 관심사가 지금도 유효한가?”
- “이때 한 말은 실행 약속인가, 그냥 상상해 본 가능성인가?”
- “새로 들어온 사실이 어떤 진행 중인 생각에 영향을 주는가?”
- “오늘은 알려야 하는가, 일주일 뒤에 다시 확인해야 하는가, 아니면 아무것도 하지 말아야 하는가?”

**검색 정확도는 필요조건에 가깝지만 충분조건은 아니다.** 장기 대화 평가에서도 정보를 꺼내기, 세션을 가로지른 추론, 시간 추론, 지식 갱신, 모를 때 답변 보류하기는 서로 구별되는 능력이다.[^longmemeval] 단지 더 긴 문맥을 제공하는 것도 해법이 아닐 수 있다. 긴 문맥의 중간에 위치한 정보를 제대로 활용하지 못하는 현상은 별도로 관찰되었다.[^lost-middle]

### 1.2 '생각'을 모두 Issue로 취급할 수 없다

**[과거 구상]** Git 기반 오케스트레이션에서는 `Issue → 작업 → 리뷰 → 병합`이 자연스럽지만, 인지 활동은 반드시 완료 상태를 갖지 않는다는 문제를 짚었다. 가령 “문명과 기억의 관계를 소설로 써 볼까?”는 해결해야 할 티켓이 아니다. 앞으로 몇 달간 조금씩 발전해도 정상이며, 사라졌다가 다시 돌아올 수도 있다.

**[제안] 두 생애주기의 구분**:

| 구분 | 생각/관심사(인지적 상태) | 작업/약속(실행 상태) |
|---|---|---|
| 생성 | 대화에서 암시되거나 직접 표명 | 명시적 약속 또는 승인된 결정 |
| 진행 | 탐색·연결·숙성·휴면·재활성화 | 대기·할당·진행·검토·완료·취소 |
| 종료 | 필수가 아님 | 원칙적으로 명확한 종료 조건 필요 |
| 진실 조건 | 주관적·불확실·변화 가능 | 수행 여부와 결과를 확인할 수 있어야 함 |
| 적합한 관리법 | 노트/관계/시점/재방문 | Issue/워크플로/권한/로그 |

Evergreen Notes의 '원자성·개념 중심·촘촘한 연결'은 생각의 발전을 돕는 참고 설계다. 이는 검증된 에이전트 메모리 스키마라기보다 인간을 위한 지식 작업 원칙임에 유의한다.[^evergreen] 온톨로지 설계에서는 데이터베이스가 **어떤 질문에 답해야 하는가(competency questions)**에서 개념과 관계를 역으로 설계할 수 있다.[^ontology]

### 1.3 비서가 스스로 목표를 만들어도 되는가

명확히 분리해야 할 것은 다음 세 가지다.

- **관찰**: “사용자가 A를 여러 차례 언급했다.”
- **추론**: “A에 지속적 관심을 보일 가능성이 있다.”
- **위임**: “A에 관한 자료를 매주 모아도 된다.”

첫 번째는 출처 있는 기록, 두 번째는 불확실한 가설, 세 번째는 권한·동의를 수반하는 제약이다. **관심이 곧 명령은 아니다.** [가설] 이 구별을 구조적으로 강제하지 않는 한, 지나치게 능동적인 비서는 사용자의 목표를 스스로 만들어 사용자를 피곤하게 할 위험이 있다. 이는 뒤의 Mixed-Initiative 설계에서 다시 다룬다.[^mixed]

## 2. 무엇을 기억할 것인가: 상태의 최소 단위

### 2.1 네 가지 실용적 개념의 재해석

**[과거 구상]** `Thread / Record / Commitment / Watch`가 기억의 유력한 분해 방식으로 논의되었다. 이들은 표준 분류가 아니라 **프로젝트 내부의 잠정적 어휘**다.

| 단위 | 정의(제안) | 전형적인 질문 | 주의점 |
|---|---|---|---|
| **Record** | 출처가 있는 개별 발화·사실·관찰·결정 | 무엇이 언제, 누구에 의해 관찰·진술되었나? | 기록과 기록의 진실성을 동일시하지 말 것 |
| **Thread** | 장기간 유지되는 질문·관심사·서사적 맥락 | 무엇을 계속 생각하고 있으며 무엇과 연결되는가? | 무조건 목표·작업·할 일로 변환하지 말 것 |
| **Commitment** | 사용자 또는 에이전트가 명시적으로 받아들인 수행 의무 | 무엇을, 언제까지, 어떤 권한으로 할 것인가? | 추정한 의향을 약속으로 승격하지 말 것 |
| **Watch** | 특정 시점·조건·변화를 관찰하라는 등록된 감시 규칙 | 어떤 변화가 일어나면 다시 판단할 것인가? | 감지와 실제 실행은 다른 단계 |

네 객체가 서로 배타적인 것은 아니다. `Record`는 `Thread`에 편입될 수 있고, `Commitment`에는 여러 `Watch`가 연결될 수 있다. 다만 **'기억'이라는 이름 하나로 모두를 뭉개지 않는 것**이 목적이다.

### 2.2 반드시 함께 보존할 메타데이터

**[제안]** 초기 객체의 공통 필드:

```yaml
id: stable-id
kind: record | thread | commitment | watch
content: "원문 또는 짧은 요약"
source: "원본 대화/파일/이벤트의 정확한 위치"
asserted_by: user | assistant | external_source
confidence: unknown   # 반드시 하나의 숫자로 환원할 필요 없음
status: active | uncertain | superseded | retracted | archived
valid_from: null       # 현실에서 유효했던 시점
valid_until: null
observed_at: "2026-11-23T00:00:00+09:00"
relations: []          # supports, contradicts, derived_from, concerns ...
access_scope: private
```

이 예시는 구현 규격이 아니라 사고를 정렬하기 위한 **개념 모델**이다. 모든 필드를 모든 객체에 강제할 필요는 없으며 `confidence` 같은 단일 수치가 실제 불확실성을 정확히 나타낸다고 가정해서도 안 된다.

서로 다른 시스템이 만든 정보를 추적할 때 **어떤 결과가 어떤 출처/활동/행위자에서 유래했는가**를 기록하는 Provenance 개념은 W3C PROV-O와 연결된다.[^prov] “A는 사실이다”와 “사용자가 지난달 A라고 말했다”는 서로 다른 주장이다.

### 2.3 기억은 기록·요약·추론의 세 층으로 나뉜다

**[제안]** 세 층을 서로 대체하지 말자.

1. **Evidence(원본)**: 수정되지 않은 대화·문서·이벤트와 위치.
2. **Memory(구조화된 주장)**: 출처를 가진 원자적 진술, 관계, 시점.
3. **Interpretation(종합 해석)**: “현재는 B보다 A에 관심이 큰 듯함”과 같은 추론.

해석은 유용하지만 틀릴 수 있고 시간에 따라 낡을 수 있다. 사용자에게 새로운 정보를 받으면 원본을 수정하는 대신 새 사건과 수정된 해석을 남겨야 한다.

Generative Agents는 관찰 기록 → 상위 반성(reflection) → 검색 → 계획이라는 중요한 패턴을 제시한다.[^genagents] MemGPT는 제한된 컨텍스트를 위해 여러 기억 계층 사이에서 정보를 관리하는 접근을 제시한다.[^memgpt] MemoryBank와 최근 메모리 시스템 연구들도 개인화된 장기 대화에 외부 기억이 유용할 수 있음을 보여준다.[^memorybank][^mem0] 다만 연구별 실험 과제와 결과가 다르므로 어느 한 논문의 점수만으로 이 프로젝트에 최적임을 선언할 수는 없다.

### 2.4 무엇을 저장하지 않을 것인가

망각·삭제·유보도 설계의 일부다.

- 모호한 농담, 가정문, 타인의 말은 사용자 속성으로 확정하지 않는다.
- 반복적으로 나타나는 취향이라도 원문과 추론을 구별한다.
- 오래된 추론은 만료·재검토할 수 있어야 한다.
- 사용자가 철회를 요청하면 이후 판단과 검색 대상에서 제외하는 정책이 필요하다.
- 민감한 정보는 **유용해 보인다는 이유만으로** 수집하지 않는다.

**[가설]** 메모리의 질은 저장량이 아니라, 최신성·근거·잘못된 승격 방지·수정 가능성에서 좌우된다. 메모리 설계에 대한 체계적 조사는 별도의 문헌 검토 출발점이 된다.[^memory-survey]

## 3. 시간이 흐른다는 것: 변화, 약속, 관심사의 생애주기

### 3.1 '과거에 참이었다'와 '지금 알고 있다'의 구분

예를 들어 10월 1일에는 발표일이 11월 12일이라고 믿었고, 10월 15일에 발표일이 11월 19일로 변경되었다고 하자. 11월 20일에 “10월 7일 당시 무슨 일정을 알고 있었지?”라고 물으면, 현재 일정을 그대로 반환해서는 안 된다.

**[제안]** 두 시각을 구별한다.

- **유효 시각(valid time)**: 해당 내용이 현실에서 적용되던 시각.
- **기록 시각(transaction/observation time)**: 시스템이 그 내용을 알게 되거나 기록한 시각.

이는 시간적 지식 표현의 오래된 연구 주제와 연결된다. Allen의 시간 구간 표현은 전후·겹침 등의 시간 관계를 다루며, 시간에 따른 상태 갱신의 필요성을 잘 보여준다.[^allen] 모든 기록을 처음부터 복잡한 이중시간 DB로 구현할 필요는 없지만, 최소한 변경 시점과 원본은 남기는 편이 안전하다.

### 3.2 '상태 덮어쓰기'보다 '사건과 수정'을 우선

**[제안]** “발표일 = 11월 19일”이라는 최신 필드 하나만 남기는 대신 아래와 같은 연속성을 유지한다.

```text
E1: user stated presentation_date = Nov 12
E2: user revised presentation_date = Nov 19 (supersedes E1)
E3: assistant acknowledged the revision
CURRENT VIEW: Nov 19, derived from E2
```

Event Sourcing은 상태 변화를 사건의 순서로 저장하여 과거 상태를 재구성하는 설계 패턴을 제공한다.[^event-sourcing] 여기서는 완전한 Event Sourcing 도입 여부보다 **정정의 이력과 현재 상태가 양립할 수 있어야 한다**는 원칙이 중요하다.

### 3.3 생각의 진행 상태는 느슨해야 한다

**[제안]** Thread의 상태를 `Exploring / Active / Incubating / Dormant / Archived` 정도로 시작할 수 있다.

이것은 Kanban 보드의 필수 단계가 아니다. 하나의 Thread가 장기간 Dormant일 수도, 두 개의 하위 Thread로 갈라질 수도, 다른 분야와 합쳐질 수도 있다. Evergreen Notes의 연결 원칙은 이러한 비선형적 지식 발전을 설명하는 참고가 된다.[^evergreen]

창작과 TRPG의 Fronts·Progress Clocks는 **진행이 외부 사건과 조건에 따라 바뀌는 맥락**을 생각하는 은유로 유용하다. 다만 이것은 이번 조사에서 실증 연구로 검증한 모델이 아니라 **[과거 구상]에서 가져온 설계 비유**이다. 모든 관심사에 진척률을 부여하는 것은 피한다.

### 3.4 '언젠가'와 '마감'은 다른 종류의 정보

- **희망**: “언젠가 논문을 정리하고 싶다.”
- **계획**: “12월에는 문헌조사를 하려 한다.”
- **약속**: “12월 5일까지 초안을 제출하겠다.”
- **감시**: “초안 제출 일주일 전에도 진행이 없으면 알려 달라.”

**[제안]** 실행이나 알림의 권한은 뒤의 둘에서만 자동으로 발생하게 하고, 전자의 둘은 탐색적 추천의 후보로만 취급한다. 이것은 생산성 방법론의 보편적 진리라기보다 의도치 않은 자동화를 줄이기 위한 초기 안전한 선택이다.

## 4. 기억에서 행동으로: 선제적 개입을 결정하는 문제

### 4.1 Watch는 단순한 알람이 아니다

시간을 기억하는 것과 미래의 특정 상황에서 행동하도록 연결하는 것은 구분된다. 심리학에서는 이를 prospective memory(미래에 해야 할 일을 기억하는 능력)로 연구해 왔다.[^prospective] Implementation Intentions는 “조건 X가 오면 행동 Y를 한다”는 식의 조건-행동 계획을 연구한다.[^implementation]

**[제안]** `Watch = trigger + condition + scope + permitted_response + expiry + evidence`.

```yaml
watch_id: w-17
trigger: "new_relevant_paper_or_weekly_check"
condition: "related_to(thread-interpretability) AND worth_reviewing"
response: "prepare_short_digest"
needs_user_approval: false
notify_when: "user_available"
expires_at: null
```

`trigger`는 **언제 다시 평가할지**이고, `condition`은 **진짜로 개입할 가치가 있는지**이다. 두 개를 분리해야 빈번한 알림이나 중복 실행을 줄일 수 있다.

표준 iCalendar에는 `VEVENT`, `VALARM`, 반복 규칙 등 일정·알림 표현이 존재한다.[^ical] 그러나 “관련된 논문이 발표되면 알려 줘” 같은 의미론적 감시는 단순 일정 스펙으로 충분하지 않으며 검색·판단·중복 방지 계층이 별도로 필요하다.

### 4.2 좋은 비서가 해야 할 일에는 '아무것도 하지 않기'가 포함된다

**[문헌]** Mixed-Initiative Interface 연구는 자동화와 직접적인 사용자 통제를 결합하고, 사용자의 의도·주의·중단 비용을 고려하는 문제를 다룬다.[^mixed] Horvitz 등의 메타추론 연구 역시 더 많은 추론을 수행하는 데에도 계산 비용과 기회비용이 있다는 문제를 다룬다.[^metareason]

다음은 그 관점을 빌린 **[제안]** 의사결정 모형이다.

\[
U(a\mid s) = \operatorname{E}[B(a,s)] - C_{interrupt}(a,s) - C_{error}(a,s) - C_{privacy}(a,s) - C_{compute}(a,s)
\]

- `s`: 시스템이 추정한 현재 상황(불확실할 수 있음)
- `a`: 기록, 침묵, 나중에 제안, 사용자에게 질문, 허용된 작업 실행 등
- `B`: 유용한 정보·시간 절약·마감 위험 감소와 같은 예상 편익
- `C`: 방해, 잘못된 개입, 개인정보 노출, 실행 비용

이것은 실측된 수치 모델이 아니며, 프로토타입에서 모든 비용을 정확한 실수 값으로 계산해야 한다는 뜻도 아니다. **'조용히 있는 것'과 '질문하는 것'을 명시적인 후보 행동에 넣기 위한 사고 도구**다.

### 4.3 자율성과 개입 권한은 연속적이지 않다

**[제안]** 실행에 앞서 다음 네 수준을 구별한다.

| 수준 | 예시 | 기본 정책 |
|---|---|---|
| L0 관찰·기록 | 자료를 읽고 Thread에 연결 | 사용자가 허용한 데이터 범위 안에서 수행 |
| L1 비파괴적 제안 | 관련 논문 추천, 일정 충돌 알림 | 방해 비용이 낮을 때 제안 |
| L2 되돌릴 수 있는 로컬 작업 | 초안 파일 작성, 임시 작업 목록 생성 | 명확한 위임과 감사 로그 아래 수행 |
| L3 외부·영향 큰 작업 | 메일 발송, 일정 삭제, 결제, 공유 | 구체적 사용자 승인 및 독립적인 정책 검사 |

이는 위험을 단순한 단일 점수로 환원하기 위한 등급이 아니다. **행동이 미치는 외부 영향과 되돌릴 수 있는 정도를 분리해 생각하기 위한 초안**이다. 사람과 AI의 상호작용 가이드라인 또한 오류 시 수정·기각과 장기적 행동의 예측 가능성을 강조한다.[^human-ai]

### 4.4 언제 먼저 말을 걸 것인가

**[과거 구상]** 다른 에이전트와의 협업에서는 비차단 알림을 선호했다. 이는 개인 비서와도 통하지만 주의할 점이 있다. **에이전트의 유휴 상태와 사람의 주의 가능 상태는 같지 않다.** 사람은 컴퓨터 앞에 앉아 있어도 작업에 몰입 중일 수 있다.

**[제안]** 최초에는 사용자의 실제 주의를 정확히 추정한다고 가정하지 않는다. 대신 (1) 명시적인 방해 금지, (2) 하루 요약 묶음, (3) 중요한 마감이나 위험에 대한 예외, (4) 일괄 알림 재확인 정책을 구현한다. 이후 사용자가 선호하는 알림 리듬을 피드백으로 학습할 수 있다.

## 5. 작업으로 전환되는 순간: 오케스트레이션의 위치

### 5.1 인지 상태와 Git Blackboard의 경계

**[과거 구상]** Git 기반 Blackboard를 협업 조율 공간으로 두고, 실제 산출물 Repository와 분리한다는 설계가 있었다. 역할은 `Controller / Maintainer / Contributor`로 구분하고, 자원(自願)·승인 기반 할당 및 비차단 알림을 선호했다.

```text
대화·자료·시간 경과
       ↓
Record / Thread / Commitment / Watch
       ↓
상황 판단: 기록? 질문? 추천? 침묵? 실제 실행?
       ↓  [실행할 일이 승인된 경우에만]
작업 요청 / Issue / 권한 부여
       ↓
Controller ↔ Maintainer ↔ Contributor
       ↓
결과물 + 검증 + 실행 로그
       ↘ 기억과 상태 갱신
```

Blackboard는 여러 지식원이 공유된 상태에 기여한다는 오래된 아키텍처 전통이 있다.[^blackboard-nii] Hayes-Roth의 연구는 무엇을 언제 수행할지를 결정하는 **통제 문제 자체**를 다룬다는 점에서 특히 가깝다.[^blackboard-control]

### 5.2 멀티 에이전트가 필수라는 가정은 금지

멀티 에이전트 대화 프레임워크(AutoGen 등)는 역할과 도구를 나눠 복잡한 작업을 처리할 수 있게 하지만, **에이전트 수 증가 = 품질 증가**는 논리적으로 성립하지 않는다.[^autogen] 실제 다중 에이전트 연구 시스템 운영 사례에서도 조정·관측·평가가 새로운 비용과 실패 지점으로 등장한다.[^anthropic]

**[제안]** 첫 인지 비서에서는 판단을 하나의 주 에이전트가 수행하고, 오래 걸리는 명확한 작업에서만 워커를 호출한다. Maintainer와 Contributor의 분리, PR 병합, Git 기반 분산 조율은 **행동의 규모가 커지는 시점**에 검증한다.

이 접근을 택해도 멀티 에이전트 아이디어를 포기하는 것이 아니다. 오히려 **인지 비서의 개선인지, 협업 실행의 개선인지**를 분리해 관찰할 수 있다.

### 5.3 실행 관리에 필요한 최소 성질

작업은 오래 걸리거나 실패할 수 있다. 작업 ID, 상태 전이, 중복 실행 방지, 재시도 조건, 취소·승인 기록이 필요하다. Durable Execution을 제공하는 워크플로 엔진은 이러한 문제의 참고 구현이다.[^temporal] 그러나 v0부터 별도의 대규모 엔진을 설치할 필요는 없다.

**[제안]** 초기에는 SQLite 기반 작업 큐와 idempotency key, 명시적 승인 로그, 로컬 실행 로그만으로 요구사항을 검증할 수 있다. 실행 성공과 사용자 목표 달성은 별도 판단한다.

## 6. 스스로 배운다는 것: 기억 개선과 자기 수정의 경계

### 6.1 학습을 다섯 층으로 나누기

**[과거 구상]** Self-Evolving Harness에 관심이 있었지만 무엇을 자동으로 바꿀지 확정하지는 않았다. 다음 다섯 층을 구분하면 문제가 명료해진다.

1. **정보 학습**: 새 사실·발화를 외부 기억에 추가한다.
2. **관계 학습**: 두 Thread의 연결, 과거 주장과의 모순 등을 식별한다.
3. **사용자 모델 갱신**: 관심사·선호에 대한 가설과 확신도를 수정한다.
4. **정책 학습**: 어떤 알림이 유용했는지 바탕으로 개입 전략을 변경한다.
5. **하네스 변경**: 실행 코드·프롬프트·도구 구성·권한을 변경한다.

Reflexion은 모델 가중치를 직접 갱신하지 않고 언어적 피드백과 에피소드 기억을 다음 시도에 활용하는 접근을 보여준다.[^reflexion] 즉 '가중치를 바꾸지 않는 학습'은 가능하지만, 그 변화가 정말 일반화된 능력 향상인지, 특정 과제에 대한 힌트 축적인지는 별도로 검증해야 한다.

### 6.2 신뢰할 수 없는 데이터가 정책이 되는 사고

문서·웹페이지·이메일에 등장하는 텍스트는 **정보의 출처**일 뿐 **시스템 명령의 권위자**가 아니다. 에이전트가 비공개 데이터에 접근하며 신뢰할 수 없는 콘텐츠를 읽고 외부 통신까지 할 수 있으면 프롬프트 인젝션 위험이 커진다.[^lethal] OWASP 역시 프롬프트 인젝션과 과도한 에이전트 권한을 주요 위험으로 분류한다.[^owasp]

**[제안]** 최소한 다음 경계를 초기부터 마련한다.

- 원본/추출 기억/에이전트 해석/운영 정책을 다른 저장 영역으로 분리한다.
- 추출 기억이 시스템 프롬프트·도구 권한을 직접 수정하지 못하게 한다.
- 신뢰할 수 없는 입력을 통해 생긴 작업은 사용자 승인과 별도의 권한 검사를 거친다.
- 파일 읽기·웹 열기·공유·외부 전송의 권한을 각각 제한한다.
- 수행 결과는 데이터와 실행 로그에 남기며, 사용자가 철회할 수 있다.

CaMeL은 언어 모델의 지시 준수만 신뢰하지 않고 제어·데이터 흐름과 능력(capability)을 분리해 정책을 강제하려는 연구다.[^camel] NIST의 생성형 AI 위험 관리 프로파일은 개발 전 과정에서 위험을 식별·관리하는 넓은 참고 틀을 제공한다.[^nist] **안전한 프롬프트 한 줄로 해결하려는 설계는 지양**한다.

### 6.3 비서의 잘못된 확신을 어떻게 드러낼 것인가

비서가 “사용자는 X를 선호한다”고 추론했을 때, 사용자에게는 다음 두 경로가 있어야 한다.

- **근거 보기**: 그 판단의 원본 대화와 요약을 확인.
- **정정하기**: “예시로 든 것일 뿐, 실제로 선호하지 않는다”를 기록해 추론 수정.

중요한 것은 정정이 단발성 답변에만 반영되지 않고, **앞으로의 검색과 행동 판단에도 영향을 미쳐야 한다**는 점이다. 이것은 [가설]이며 실제 구현에서는 정정의 전파 범위와 재검색 정책이 필요하다.

## 7. 개념 아키텍처: 조합은 하되 결합도를 낮춘다

다음은 제품 설계도가 아니라 연구를 진행하기 위한 **[제안] 참조 구조**다.

```text
┌────────────────────────────────────────────────┐
│ INPUT: 대화 · 문서 · 사용자 수정 · 외부 이벤트 │
└──────────────────────┬─────────────────────────┘
                       ▼
             [해석/분류/출처 부착]
                       │
                       ▼
      ┌─────────────────────────────────┐
      │ Evidence / Record (immutable-ish)│
      │ Thread / Commitment / Watch      │
      │ 시간 · 관계 · 수정 이력 · 권한     │
      └───────────────┬─────────────────┘
                      │ 검색/조건 재평가
                      ▼
      ┌─────────────────────────────────┐
      │ Decision Policy                 │
      │ 침묵 / 기록 / 제안 / 질문 / 실행 │
      └───────────────┬─────────────────┘
                      │ 권한 검사
                      ▼
      ┌─────────────────────────────────┐
      │ Task & Tool Runtime             │
      │ 승인·상태·재시도·검증·감사 로그 │
      └───────────────┬─────────────────┘
                      │
                      └──── 결과/피드백 → Evidence
```

**명시적인 경계**:

- **메모리 ↔ 정책**: “사용자가 한 말”을 “시스템이 지켜야 할 명령”으로 자동 승격하지 않는다.
- **판단 ↔ 실행**: 무엇을 하면 좋겠다는 생각과 그것을 할 권한을 분리한다.
- **인지 상태 ↔ 작업 상태**: Thread가 직접 Issue가 되지 않는다.
- **실행 결과 ↔ 성공 판정**: 도구 호출 성공이 사용자에게 유용한 결과를 보장하지 않는다.

### 7.1 저장 엔진보다 중요한 것

파일시스템과 SQLite는 초기 구조의 유력한 조합이다. 원문을 Markdown/JSON으로 보관하고, SQLite에 안정적인 ID·타임스탬프·관계·인덱스를 두는 식이다. SQLite FTS5는 텍스트 검색을 제공한다.[^fts5] 의미 검색(embedding)은 선택적이다. 의미적으로 유사하다는 것과 **같은 프로젝트, 같은 사람, 같은 시점, 같은 약속**이라는 것은 다르므로 정확한 필터·관계 조회를 대체할 수 없다.

**[가설]** 작은 데이터에서도 먼저 출처·시점·정정의 무결성을 확보하는 편이, 벡터 검색을 즉시 정교화하는 것보다 전체 시스템의 신뢰성에 더 큰 영향을 줄 수 있다. 이에 대한 우열은 아직 실험 결과가 아니다.

## 8. 세 가지 구체적 사고 실험

### 사례 A: 완성되지 않아도 되는 생각

> 사용자: “왕의 어떤 선택이 전장의 기생체 사건을 일으켰다는 설정을 언젠가 소설에 쓸지도 모르겠어.”

**기대 상태**: Thread(소설 설정) + Record(아이디어 출처). Commitment는 없다. 관련 아이디어가 새로 등장하면 연결할 수 있지만, 사용자의 명시적 요청 없이 “이번 주에 소설 1장을 쓰자”는 작업을 자동 생성해서는 안 된다.

**핵심 논점**: 연결·축적·재발견과 생산성 압박 사이의 균형. Evergreen Notes의 관점을 참고하되 하나의 창작 관행을 모든 인지 활동에 강제하지 않는다.[^evergreen]

### 사례 B: 발표 계획의 연속된 변화

> 11/1: “발표할 논문 후보가 셋이다.” → 11/7: “Bau et al.로 하겠다.” → 11/12: “일단 다른 일 때문에 보류한다.”

**기대 상태**: 세 기록이 시간 순서와 상호 관계를 가진다. 후보 탐색 Thread는 유지되지만 현재 계획과 완료된 결정을 구분한다. 기존의 일정 알림이나 자료 준비 Watch가 있다면 재평가해야 한다.

**핵심 논점**: 최신성·정정·철회·과거 시점 복원. 기록 시점/유효 시점과 Event Sourcing의 발상을 참고한다.[^allen][^event-sourcing]

### 사례 C: 유익하지만 방해가 될 수 있는 추천

> 비서가 사용자의 연구 관심사와 연결되는 새로운 논문을 발견했다. 그러나 사용자는 현재 마감 직전 작업에 집중하고 있다.

**가능한 행동**: 즉시 알림 / 요약만 저장 / 다음 일괄 브리핑에 포함 / 아무 행동도 하지 않음.

**핵심 논점**: 추천의 적합성 외에 **개입 시점의 적합성**이 필요하다. 예상 편익, 오류 비용, 주의 분산을 비교하는 Mixed-Initiative 관점이 적합하다.[^mixed][^human-ai]

## 9. 프로토타입 전에 닫아야 할 설계 질문

**질문 1 — '사용자의 생각'을 어디까지 추론할 것인가?**  
발화에 직접 드러난 내용만 저장할지, 반복 패턴으로부터 잠정적인 관심사도 형성할지 정한다. 추론 결과에는 근거·불확실성·정정 경로를 둔다.

**질문 2 — 메모리는 언제 합쳐지고 언제 분리되는가?**  
비슷한 두 아이디어를 하나의 Thread로 통합하는 기준, 정정이 전체 해석에 전파되는 방식, 장기간 사용하지 않은 Thread의 보존 정책을 정한다.

**질문 3 — 어떤 행동에 사전 위임을 인정하는가?**  
읽기·제안·임시 파일 작성·외부 전송·일정 변경을 명확히 구분하고 사용자 승인 범위를 문서화한다.

**질문 4 — 언제 먼저 개입할 것인가?**  
유용성만이 아니라 방해 비용과 실패 비용을 포함한다. 침묵과 지연을 정상적인 행동으로 인정한다.

**질문 5 — 자신의 실행 방법을 스스로 바꿀 수 있는가?**  
지식 추가와 정책 변경을 분리하고, 하네스 수정은 검토 가능한 제안으로 우선 제한한다.

**질문 6 — 멀티 에이전트를 추가할 임계점은 무엇인가?**  
단일 에이전트의 시간·비용·품질 병목이 확인된 뒤 역할 분담을 도입한다. 그 전에는 Git Blackboard를 필수 전제로 놓지 않는다.

## 10. 후속 연구의 가설 목록: 결론과 미확정 사항 분리

### 현재 채택할 수 있는 설계 원칙(잠정)

- [x] **인지 상태와 실행 상태를 분리**한다.
- [x] **기억의 원본, 구조화된 진술, 파생 해석을 분리**한다.
- [x] **출처·시간·정정 이력**을 기본 데이터로 취급한다.
- [x] **행동 결정에 침묵·지연·질문을 포함**한다.
- [x] **정책과 도구 권한은 외부 기억으로부터 독립**시킨다.
- [x] **멀티 에이전트와 자기 개선은 선택적 확장**으로 둔다.

### 검증이 필요한 실질적 가설

| 코드 | 가설 | 잠재적인 반례 또는 실패 |
|---|---|---|
| H1 | 구조화된 상태는 단순 대화 검색보다 장기 연속성을 잘 유지한다 | 추출 과정의 오분류가 누적되어 원문 검색보다 악화 |
| H2 | 시점·출처·정정 관계가 잘못된 개인화 판단을 줄인다 | 복잡성만 늘고 실제 대화에서 거의 쓰이지 않음 |
| H3 | Watch와 개입 정책은 '질문에만 답하는 비서'보다 유용하다 | 과도한 알림·잘못된 예측으로 순효용 감소 |
| H4 | 실행 권한의 단계화가 유용성을 크게 저해하지 않고 위험을 낮춘다 | 승인 요청이 지나치게 많아 사실상 자동화 실패 |
| H5 | 메모리 갱신만으로도 일부 자기 개선 효과가 발생한다 | 과제 특화 힌트나 컨텍스트 누적의 착시 |
| H6 | 일부 작업에서 멀티 에이전트 분담이 비용 대비 품질을 높인다 | 조정·검토 비용이 절감된 작업량보다 큼 |

이 단계에서 **가설의 채택과 실증적 입증을 혼동하지 않는 것**이 중요하다. 다음 문서인 Episode 설계안은 각 가설을 분리하여 판별할 수 있도록 구성하면 된다. LongMemEval·LoCoMo는 장기 기억 관련 차원을 참고할 수 있으나, 이 프로젝트가 측정하려는 **선제적 행동의 적절성**을 그대로 충족시키지는 않는다.[^longmemeval][^locomo]

## 11. 권장 탐독 순서

1. **문제의 틀**: CoALA → Generative Agents → Horvitz(Mixed-Initiative). 기억·행동·의사결정을 서로 다른 책임으로 보게 한다.[^coala][^genagents][^mixed]
2. **기억의 내부 구조**: Evergreen Notes → Ontology Development 101 → PROV-O → Event Sourcing. 생각의 관계·출처·정정을 설계하는 데 도움을 준다.[^evergreen][^ontology][^prov][^event-sourcing]
3. **LLM 장기 기억 기술**: MemGPT → 장기 기억 서베이 → LongMemEval → LoCoMo. 실제 기억 시스템과 평가가 무엇을 다뤘는지 정리한다.[^memgpt][^memory-survey][^longmemeval][^locomo]
4. **실행과 권한**: Blackboard 전통 → AutoGen 및 운영 사례 → Human-AI Guidelines → CaMeL. 분업, 사용자 통제, 신뢰 경계를 이해한다.[^blackboard-nii][^autogen][^anthropic][^human-ai][^camel]

---

# 주석 및 참고문헌

> 각주는 자료의 **직접적 기여**, **프로젝트와의 연결**, **읽을 때의 주의점**을 포함한다. 학술 논문과 표준·문서 및 개인 글은 근거의 성격이 다르다. 인용된 연구가 이 프로젝트의 특정 아키텍처를 검증했다는 의미는 아니다. 방문·검토 기준일: 2026-11-23.

[^clark]: **철학 / 논문.** Andy Clark & David J. Chalmers (1998), *The Extended Mind*, *Analysis* 58(1), 7–19. [DOI](https://doi.org/10.1093/analys/58.1.7). 외부 도구와 인지 과정의 관계를 생각하기 위한 **철학적 동기**. LLM 비서 설계에 대한 실증 증거가 아니다.

[^coala]: **인지 아키텍처 / 논문.** Theodore R. Sumers, Shunyu Yao, Karthik Narasimhan & Thomas L. Griffiths (2023), *Cognitive Architectures for Language Agents* (CoALA). [arXiv](https://arxiv.org/abs/2309.02427). 모듈식 메모리, 구조화된 행동 공간, 일반화된 의사결정 과정을 구분한다. 전체 구조를 잡기에 적합하다.

[^rag]: **외부 기억 / 논문.** Patrick Lewis 외 (2020), *Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks*, NeurIPS 2020. [원문 소개](https://proceedings.nips.cc/paper/2020/hash/6b493230205f780e1bc26945df7481e5-Abstract.html). 외부 비모수 기억과 생성 모델의 결합을 정식화한 고전적 출발점. 사용자의 관심과 개입 정책까지 해결하지는 않는다.

[^longmemeval]: **장기 기억 / 평가 논문.** Di Wu 외 (2025), *LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory*, ICLR 2025. [공식 논문](https://proceedings.iclr.cc/paper_files/paper/2025/hash/d813d324dbf0598bbdc9c8e79740ed01-Abstract-Conference.html). 정보 추출·다중 세션 추론·시간 추론·지식 갱신·답변 보류라는 다섯 능력을 구분한다. 능동적 비서 행동 평가는 별도 문제다.

[^lost-middle]: **장문 문맥 / 논문.** Nelson F. Liu 외 (2024), *Lost in the Middle: How Language Models Use Long Contexts*, TACL 12, 157–173. [ACL Anthology](https://aclanthology.org/2024.tacl-1.9/). 문맥 창이 길다는 사실과 정보 사용의 견고함이 같지 않을 수 있다는 근거.

[^evergreen]: **지식 작업 / 1차 개인 글.** Andy Matuschak, *Evergreen notes*와 *Evergreen notes should be atomic*. [원문](https://notes.andymatuschak.org/About_these_notes). 원자성·개념 중심·연결 및 점진적 발전이라는 설계 직관. 학술적 성능 검증 논문이 아니며 에이전트 메모리 표준도 아니다.

[^ontology]: **지식 표현 / 기술 가이드.** Natalya F. Noy & Deborah L. McGuinness (2001), *Ontology Development 101: A Guide to Creating Your First Ontology*, Stanford Knowledge Systems Laboratory. [Stanford/Protégé 문서](https://protege.stanford.edu/publications/ontology_development/ontology101-noy-mcguinness.html). 특히 competency questions, 클래스·관계 설계 방법이 유용하다. 처음부터 정교한 OWL 온톨로지를 강제하자는 뜻은 아니다.

[^prov]: **출처 추적 / 표준.** W3C (2013), *PROV-O: The PROV Ontology*, W3C Recommendation. [표준](https://www.w3.org/TR/prov-o/). Entity·Activity·Agent와 파생 관계를 모델링하는 참고. 프로젝트는 꼭 RDF/OWL을 사용하지 않아도 관련 원칙을 채택할 수 있다.

[^genagents]: **에이전트 기억 / 논문.** Joon Sung Park 외 (2023), *Generative Agents: Interactive Simulacra of Human Behavior*, UIST 2023. [ACM DOI](https://doi.org/10.1145/3586183.3606763) · [arXiv](https://arxiv.org/abs/2304.03442). 기억 스트림·반성·계획의 결합과 구성 요소 제거 실험을 살펴볼 가치가 있다. 사람과 같은 시뮬레이션 행동이 개인 비서의 정확성·안전성을 보증하지는 않는다.

[^memgpt]: **기억 계층 / 연구 프리프린트.** Charles Packer 외 (2023/2024), *MemGPT: Towards LLMs as Operating Systems*. [arXiv](https://arxiv.org/abs/2310.08560). OS의 가상 메모리 아이디어에서 착안한 여러 기억 계층 및 컨텍스트 관리. 여기서의 interrupt는 대화·제어 흐름 관련 개념이며 인간에게 무조건 알림을 보내라는 의미는 아니다.

[^memorybank]: **개인화 기억 / 학술 논문.** Wanjun Zhong 외 (2024), *MemoryBank: Enhancing Large Language Models with Long-Term Memory*, AAAI 2024. [AAAI DOI](https://doi.org/10.1609/aaai.v38i17.29946). 장기 기억을 갖춘 동반자·비서류 대화 시스템의 사례. 정량적 결과를 다른 데이터셋·서비스로 직접 일반화해서는 안 된다.

[^mem0]: **운영 지향 기억 / 연구 논문.** Prateek Chhikara 외 (2025/2026), *Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory*. [arXiv](https://arxiv.org/abs/2504.19413) · [출판 기록](https://doi.org/10.3233/FAIA251160). 동적 추출·통합·검색과 관계 기반 메모리의 구현 후보. 논문이 보고한 성능은 해당 조건에 한정된다.

[^memory-survey]: **문헌 조사 / 학술 논문.** Zeyu Zhang 외 (2025), *A Survey on the Memory Mechanism of Large Language Model-based Agents*, *ACM Transactions on Information Systems* 43(6). [ACM DOI](https://doi.org/10.1145/3748302) · [arXiv 초기 원고](https://arxiv.org/abs/2404.13501). 메모리 설계와 평가의 연구 지형을 체계적으로 탐색할 때 활용.

[^allen]: **시간 지식 표현 / 논문.** James F. Allen (1983), *Maintaining Knowledge about Temporal Intervals*, *Communications of the ACM* 26(11), 832–843. [DOI](https://doi.org/10.1145/182.358434). 시간 구간 간 관계와 시간 추론의 고전. 'valid time/transaction time'의 특정 구현과 직접 동일시하지 말 것.

[^event-sourcing]: **소프트웨어 패턴 / 1차 기술 글.** Martin Fowler (2005), *Event Sourcing*. [원문](https://martinfowler.com/eaaDev/EventSourcing.html). 상태 변화의 사건 이력을 보존하여 과거 상태를 재구성하는 설계 패턴. 원저자가 초안 성격의 문서임을 밝히며, 모든 응용에 필수라는 근거는 아니다.

[^prospective]: **인지심리 / 논문.** Gilles O. Einstein & Mark A. McDaniel (1990), *Normal Aging and Prospective Memory*, *Journal of Experimental Psychology: Learning, Memory, and Cognition* 16(4), 717–726. [PubMed](https://pubmed.ncbi.nlm.nih.gov/2142956/) · [DOI](https://doi.org/10.1037/0278-7393.16.4.717). 미래 조건과 연결된 기억의 개념적 근거. 소프트웨어 트리거 엔진 구현 지침은 아니다.

[^implementation]: **동기·행동 심리 / 논문.** Peter M. Gollwitzer (1999), *Implementation Intentions: Strong Effects of Simple Plans*, *American Psychologist* 54(7), 493–503. [DOI](https://doi.org/10.1037/0003-066X.54.7.493). 조건-행동 계획(if–then)을 인간 목표 추구에서 연구한다. Watch 문법의 효과를 직접 증명하지는 않는다.

[^ical]: **일정 형식 / 표준.** Bernard Desruisseaux (2009), *RFC 5545: Internet Calendaring and Scheduling Core Object Specification (iCalendar)*. [IETF RFC](https://www.rfc-editor.org/rfc/rfc5545.html). `VEVENT`, `VALARM`, 트리거 및 반복을 표현한다. 의미적 이벤트 탐지·사용자 목표 추론은 범위 밖이다.

[^mixed]: **Human–AI 상호작용 / 논문.** Eric Horvitz (1999), *Principles of Mixed-Initiative User Interfaces*, CHI '99, 159–166. [ACM DOI](https://doi.org/10.1145/302979.303030) · [Microsoft Research](https://www.microsoft.com/en-us/research/publication/principles-mixed-initiative-user-interfaces/). 자동화·직접 조작·의도 불확실성·사용자 주의·개입 비용을 함께 다룬다. 논문의 역사적 시스템이 현재 LLM의 성능을 보장하는 것은 아니다.

[^metareason]: **의사결정 / 논문.** Stuart Russell & Eric Wefald (1991), *Principles of Metareasoning*, *Artificial Intelligence* 49(1–3), 361–395. [DOI](https://doi.org/10.1016/0004-3702(91)90015-C). 추론 자체의 예상 효용과 계산 비용을 살펴보는 출발점. 본문의 비서 효용 함수는 여기에서 영감을 받은 **자체 모델**이다.

[^human-ai]: **HCI 실증 가이드라인 / 논문.** Saleema Amershi 외 (2019), *Guidelines for Human-AI Interaction*, CHI 2019. [ACM DOI](https://doi.org/10.1145/3290605.3300233) · [Microsoft Research](https://www.microsoft.com/en-us/research/publication/guidelines-for-human-ai-interaction/). 18개 가이드라인의 타당성을 사용자 연구 등으로 검토했다. 개별 제품에서 모든 지침의 효과가 자동으로 보장되지는 않는다.

[^blackboard-nii]: **고전 Blackboard / 논문.** H. Penny Nii (1986), *Blackboard Systems, Part One: The Blackboard Model of Problem Solving and the Evolution of Blackboard Architectures*, *AI Magazine* 7(2), 38–53. [DOI](https://doi.org/10.1609/aimag.v7i2.537). 다수 지식원이 공유 상태를 통해 협업한다는 기본 아키텍처를 이해하기 위한 원전.

[^blackboard-control]: **행동 통제 / 논문.** Barbara Hayes-Roth (1985), *A Blackboard Architecture for Control*, *Artificial Intelligence* 26(3), 251–321. [DOI](https://doi.org/10.1016/0004-3702(85)90063-3). 언제 어떤 행동을 선택해야 하는가라는 통제 문제를 Blackboard에 결합한다. Git을 사용하라는 주장은 아니다.

[^autogen]: **멀티 에이전트 / 논문.** Qingyun Wu 외 (2024), *AutoGen: Enabling Next-Gen LLM Applications via Multi-Agent Conversation*, COLM 2024. [Microsoft Research](https://www.microsoft.com/en-us/research/publication/autogen-enabling-next-gen-llm-applications-via-multi-agent-conversation-framework/). 대화 가능한 에이전트와 도구/인간의 조합을 설명하는 구현 사례. 모든 개인 비서에 다중 에이전트가 필요하다는 증거는 아니다.

[^anthropic]: **운영 사례 / 기업 엔지니어링 글.** Anthropic Engineering (2025-06-13), *How we built our multi-agent research system*. [원문](https://www.anthropic.com/research/multi-agent-research-system). 병렬 분업의 효과 및 조정 비용, 관측, 평가의 어려움에 관한 실무 경험. 독립적 비교 연구는 아니며 자사 시스템에 특화된다.

[^temporal]: **내구성 있는 실행 / 공식 문서.** Temporal, *What is Durable Execution?* [공식 문서](https://docs.temporal.io/durable-execution). 이벤트 이력·활동·타이머·재시도·상태 복구의 구현상 쟁점을 설명한다. 이 프로젝트가 Temporal을 채택해야 한다는 뜻은 아니다.

[^reflexion]: **경험 기반 개선 / 논문.** Noah Shinn 외 (2023), *Reflexion: Language Agents with Verbal Reinforcement Learning*, NeurIPS 2023. [공식 논문](https://papers.neurips.cc/paper_files/paper/2023/hash/1b44b878bb782e6954cd888628510e90-Abstract-Conference.html). 가중치 변경 대신 언어적 피드백을 기억으로 저장하여 다음 시도에 활용하는 접근. 단기 과제 개선과 일반적 자기 진화를 혼동하지 말 것.

[^lethal]: **에이전트 보안 / 실무 분석.** Simon Willison (2025-06-16), *The lethal trifecta for AI agents: private data, untrusted content, and external communication*. [원문](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/). 세 능력의 동시 결합이 유발하는 위험을 직관적으로 설명하는 실무 관점. 학술적 확률 추정이 아니다.

[^owasp]: **보안 위험 분류 / 프로젝트.** OWASP, *Top 10 for Large Language Model Applications*. [공식 프로젝트](https://owasp.org/projects/top-10-for-large-language-model-applications). 프롬프트 인젝션·과도한 권한 등 위험을 정리한다. 목록과 명칭은 버전에 따라 바뀔 수 있다.

[^camel]: **보안 아키텍처 / 연구 논문.** Edoardo Debenedetti 외 (2025; 2026 발표), *Defeating Prompt Injections by Design* (CaMeL). [arXiv](https://arxiv.org/abs/2503.18813) · [IEEE 출판 기록](https://doi.org/10.1109/SaTML68715.2026.00040). 신뢰한 요청에서 제어·데이터 흐름을 추출하고 capability 기반 보안 정책을 강제하는 연구. 모든 도구나 사용 환경에서 완벽한 보호가 이미 구현되었다고 해석해서는 안 된다.

[^nist]: **위험 관리 / 공공기관 문서.** NIST (2024), *AI Risk Management Framework: Generative AI Profile*, NIST AI 600-1. [공식 자료](https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-generative-artificial-intelligence) · [DOI](https://doi.org/10.6028/NIST.AI.600-1). 생성형 AI의 위험 식별·대응을 위한 포괄적 참고 틀. 본 문서의 L0–L3 권한 등급은 NIST가 제시한 표준이 아니다.

[^fts5]: **저장·검색 / 공식 문서.** SQLite, *FTS5 Extension*. [공식 문서](https://www.sqlite.org/fts5.html). SQLite의 전문 검색과 tokenizer를 설명한다. FTS5 자체가 의미 검색이나 사용자 상태 추론을 수행하는 것은 아니다.

[^locomo]: **긴 대화 / 평가 논문.** Adyasha Maharana 외 (2024), *Evaluating Very Long-Term Conversational Memory of LLM Agents*, ACL 2024. [ACL Anthology](https://aclanthology.org/2024.acl-long.747/). 긴 다중 세션 대화에서 시간·인과 맥락과 기억을 평가한다. 선제적 실행의 효용은 직접 다루지 않는다.

---

## 부록 A. 용어 혼동 방지

| 용어 | 이 문서의 사용 의미 | 혼동하지 말 것 |
|---|---|---|
| Memory | 과거의 기록과 그것에 근거한 구조화된 상태 | 전체 대화 로그, 모델 가중치와 동의어가 아님 |
| Thread | 지속되는 인지적 맥락 | OS 스레드, 채팅 대화방, Git Issue와 다름 |
| Record | 출처를 가진 개별 진술 또는 관찰 | 검증된 객관적 진실을 뜻하지 않음 |
| Commitment | 명시적 위임 또는 합의된 실행 의무 | 잠정적인 관심·희망과 다름 |
| Watch | 변화를 감지하고 판단을 재개하는 규칙 | 무조건 실행하는 cron job과 다름 |
| Reflection | 관찰에서 더 높은 수준의 해석을 구성 | 사실 자체나 검증된 결론과 다름 |
| Policy | 허용되는 개입·행동·권한에 관한 규칙 | 외부 문서에 등장한 지시사항과 다름 |
| Blackboard | 지식원들이 협업하는 공유 조율 공간 | 개인의 모든 기억을 담는 단일 DB와 다름 |
| Self-evolution | 기억·정책·절차 변화의 다양한 층 | 모델 파인튜닝 또는 하네스 코드 수정만을 뜻하지 않음 |

## 부록 B. '프로토타입 이전' 문서의 산출물 체크리스트

- [ ] 첫 버전의 사용 사례 3~5개를 확정했는가?
- [ ] 사용자가 직접 말한 사실과 에이전트 추론을 구분하는가?
- [ ] Thread와 Commitment 간의 전환 규칙이 있는가?
- [ ] 모든 중요한 상태가 출처·시점·정정 경로를 가지는가?
- [ ] Watch가 실제 실행 권한과 구별되는가?
- [ ] '침묵/나중에 알림/질문'이 합법적인 결과인가?
- [ ] 외부 콘텐츠가 메모리·정책·권한을 오염시키지 못하도록 경계를 정했는가?
- [ ] 단일 에이전트로 먼저 시험할 범위와 멀티 에이전트 확장 시점을 분리했는가?
- [ ] 실패·수정·철회도 정상적인 시스템 동작으로 정의했는가?

**다음 문서에서 다룰 일**: 위의 개념 모델을 바탕으로 상황 변화 시나리오(Episode)를 설계하고, H1–H6를 구분해 판단할 관찰·평가 지표를 정의한다.
