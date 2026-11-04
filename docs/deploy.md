# 외부 배포: mini PC + Docker + Caddy + HTTPS

개인 기록이 담긴 앱을 공개 인터넷에 여는 작업입니다. 아래 절차는 Caddy가
**이미 같은 기기에서 돌고 있다**는 전제로, digithive 컨테이너만 추가합니다.

## 사전 준비

1. `digithive.chanoil.com`의 DNS A 레코드가 mini PC의 공인 IP를 가리킵니다.
2. 공유기에서 80/TCP와 443/TCP가 mini PC로 포워딩됩니다.
3. Caddy가 80/443을 받고 있습니다.

## 1. passphrase 설정

`docker-compose.yml`과 같은 폴더에 `.env`를 만들고 강한 패스프레이즈를
넣습니다.

```text
DIGITHIVE_PASSPHRASE=무작위-긴-문장-여러-단어
DIGITHIVE_DOMAIN=digithive.chanoil.com
```

비밀번호는 20자 이상의 무작위 문구를 권장합니다.

## 2. 컨테이너 실행

```sh
docker compose up -d --build
```

digithive는 컨테이너 안에서 0.0.0.0:3000으로 뜨지만, compose가 호스트의
`127.0.0.1:3000`에만 연결합니다. 컨테이너 포트를 공인 주소로 열지 않습니다.

데이터는 두 개의 named volume에 남습니다.

- `digithive-data` → `/data/digithive.sqlite`
- `digithive-backups` → `/backups` (앱의 SQLite 스냅샷)

## 3. Caddy 설정

기존 Caddy 구성에 다음 블록을 병합하고 재적재합니다.

```caddy
digithive.chanoil.com {
    reverse_proxy 127.0.0.1:3000
}
```

Caddy가 `digithive.chanoil.com`의 인증서를 자동 발급하고 TLS를 종료합니다.
앱 자체는 TLS를 하지 않으며 Caddy 뒤의 http 통신을 전제로 합니다.

## 4. 확인

`https://digithive.chanoil.com`을 열면 passphrase 로그인 화면이 나옵니다.
로그인하면 쿠키 세션이 만들어지고 API가 열립니다.

```sh
curl -i https://digithive.chanoil.com/api/auth/status
```

## 환경 변수

| 변수 | 기본값 | 의미 |
| --- | --- | --- |
| `DIGITHIVE_HOST` | `127.0.0.1` | 바인딩 주소. 컨테이너에서는 `0.0.0.0` |
| `DIGITHIVE_PORT` | `3000` | 포트 |
| `DIGITHIVE_DB` | `data/digithive.sqlite` | SQLite 파일 경로 |
| `DIGITHIVE_BACKUP_DIR` | `backups` | 스냅샷 디렉터리 |
| `DIGITHIVE_PUBLIC_HOST` | 없음 | 허용할 공개 Host(예: digithive.chanoil.com) |
| `DIGITHIVE_PASSPHRASE` | 없음(인증 꺼짐) | 설정하면 passphrase 게이트 활성화 |
| `DIGITHIVE_COOKIE_SECURE` | `true` | HTTPS에서만 쿠키 허용 |
| `DIGITHIVE_SESSION_TTL_SECONDS` | `2592000`(30일) | 세션 유효 시간 |

`DIGITHIVE_PASSPHRASE`가 비어 있으면 인증이 꺼지고 기존 로컬 전용 동작을
유지합니다.

## 보안 주의

- **passphrase 단일 인자는 약합니다.** 공개 인터넷에 노출된 개인 기록에
  충분한 보안을 주지 않습니다. 길고 무작위인 패스프레이즈를 쓰고, 가능하면
  Caddy에 IP 허용 목록이나 추가 인증을 얹으세요. 이 기능은 "아주 간단한"
  접근 제한이며 계정·MFA·비밀번호 재설정이 없습니다.
- 로그인 실패는 IP당 5회 후 15분 잠깁니다(X-Forwarded-For 기반). 방어를
  강화하려면 Caddy의 `basic_auth`나 IP 제한을 함께 쓰세요.
- 컨테이너 포트는 호스트 `127.0.0.1`에만 열립니다. `ports`를 공인 주소로
  바꾸지 마세요.
- named volume은 기기 외부로 자동 백업되지 않습니다. 앱의 스냅샷 기능으로
  정기 백업하고 그 파일을 다른 곳에 복사하세요.
- passphrase를 바꾸면 기존 세션이 모두 무효화됩니다.
