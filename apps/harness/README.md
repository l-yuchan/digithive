# digithive harness (신규)

계획: `.omo/plans/digithive-harness-rewrite.md` (W0·W1 구현 상태)

## 실행

```bash
cd apps/harness
bun install
bun run build:web                       # web/dist 생성
bun run mock                            # (선택) 로컬 목 제공자 :8798
PORT=8799 MODEL_BASE_URL=http://127.0.0.1:8798/v1 MODEL_NAME=mock-model bun run start
```

환경 변수: `PORT`(기본 8799), `HARNESS_DB`(기본 `apps/harness/data/harness.db`), `MODEL_BASE_URL`, `MODEL_API_KEY`, `MODEL_NAME`.

## 검증

```bash
bun run typecheck && bun test
```

`tests/`는 스키마·이벤트·상태 기계·정책·스트리밍 어댑터·대화 루프·입력 규칙을 다룬다. 외부 모델 호출 없이 돈다.

## 현재 범위 (W0·W1)

- 세션·엔트리·part·run·tool_call·approval·event 스키마와 마이그레이션
- 전역 seq 이벤트 로그, 커서 재생, 라이브 SSE(+15초 ping), 스냅샷 프레임
- run 상태 기계, 리스 만료 정산, 취소 의도 기록
- 정책 단일 판정 지점(allow/ask/deny, 저장 승인이 deny를 이길 수 없음)
- OpenAI 호환 스트리밍 어댑터(오류 분류, 잘림=실패)
- 대화 턴: 델타 저장·스트리밍, 도구 왕복, 거부=도구 결과, 턴·도구 데드라인
- React 클라이언트: 세션 목록, 스트리밍 렌더, Enter/Shift+Enter, 한글 조합 Enter 무시

W2(대화 관리)·W3(맥락·압축)·W4(작업 계층)·W5(위임)·W6(이전)·W7(절단)은 아직 없다.

## 알려진 한계

- 도구 레지스트리가 비어 있다(승인 게이트·실행 경계는 W4에서 도구와 함께 채운다).
- SSE 재연결은 EventSource 기본 동작(`Last-Event-ID`)에 의존한다. 서버는 스냅샷을 먼저 보내므로 화면 복원은 안전하다.
- 대화 삭제·제목 변경·편집·분기는 W2.

## 배포 (mini, https://digithive.chanoil.com/app2/)

```bash
# 서버에서
cd ~/digithive-harness/deploy
# .env: HARNESS_PASSPHRASE, HARNESS_SESSION_SECRET, MODEL_BASE_URL, MODEL_API_KEY, MODEL_NAME, HARNESS_MODEL_HEADERS
docker compose up -d --build
```

- 두 서비스: `harness`(웹, 4318, caddy_expose) + `harness-worker`(실행 계층).
- Caddy는 `handle_path /app2/*`로 접두사를 벗겨 프록시한다. 클라이언트는 `/app2` 아래에서 API 경로에 자동으로 접두사를 붙인다(`apiUrl`).
- 인증: `HARNESS_PASSPHRASE`(빈 값이면 로컬 개발용으로 인증 비활성), `HARNESS_SESSION_SECRET`으로 서명한 HttpOnly 쿠키.
- 되돌림: `~/caddy/Caddyfile.bak-*`를 `docker exec -i caddy_proxy sh -c 'cat > /etc/caddy/Caddyfile'`로 복원 후 `caddy reload`. (파일 bind-mount라 sed -i 금지)
- 운영 DB는 볼륨 `deploy_harness-data`(/data). v2 데이터는 `bun scripts/migrate-v2.ts --from <v2.db> --to /data/harness.db`로 옮긴다.


## 연동 환경변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET | (없음) | OAuth 클라이언트. 없으면 `/api/oauth/google/start`가 409 |
| GOOGLE_REDIRECT_URI | https://digithive.chanoil.com/api/oauth/google/callback | 동의 후 돌아올 주소 |
| CANVAS_URL | (없음) | LMS 베이스 URL (예: https://lxp-canvas.hanyang.ac.kr) |
| CANVAS_TOKEN | (없음) | Canvas API 토큰 |
| VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY | (없음) | Web Push VAPID 키. 없으면 전송은 `push_unconfigured` |
| VAPID_SUBJECT | mailto:owner@digithive.local | VAPID subject |

- 연결 상태: `GET /api/connections` → { googleConnected, canvasConfigured, pushConfigured, states[] }
- 수동 동기화: `POST /api/connections/sync` → 소스별 {ok,count,cursor,error}
- Google 연결: `GET /api/oauth/google/start`가 돌려준 URL로 1회 동의하면 콜백이 토큰을 암호화 저장하고 즉시 1회 동기화한다.
- 알림: 브라우저에서 구독하면 `POST /api/push/subscribe`로 저장되고, 브리핑 발행 시 전송된다. 점검은 `POST /api/push/test`.

