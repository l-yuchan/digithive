# 기존 배포의 읽기 전용 확인

최신 사용자 지시: 검토 후 즉시 구현하고 SSH 호스트에 Docker Compose 배포까지 완료한다. 기존 digithive는 폐기 가능하다. 이 파일은 기존 서비스 발견 증거이며 새 버전의 배포 성공을 뜻하지 않는다.

## 연결과 환경

- SSH alias: `mini`, user `leefam`, host `192.168.0.94`, port 22.
- 초기 22/2222 probe는 timeout. 질문은 무응답 종료. 기존 주소를 유지했고 복구 monitor가 `SSH_READY=mini`를 출력하며 exit 0.
- `ssh mini "hostname && docker version && docker ps"` exit 0 (`bash_13`).
- 호스트명 `microdeb`; Linux amd64; Docker Engine 29.6.1; Compose v5.2.0.

## 교체 대상

- 컨테이너 `digithive`, image `digithive-digithive`, 내부 3000/tcp.
- Compose project `digithive`, 파일 `/home/leefam/digithive/compose.yml`, working directory `/home/leefam/digithive`.
- 기존 데이터 volume `digithive_digithive-data` → `/data`; backup volume `digithive_digithive-backups` → `/backups`.
- 외부 Docker network `caddy_expose`, 앱 alias `digithive`.
- 프록시 컨테이너 `caddy_proxy`, 공개 80/443, 같은 `caddy_expose` 네트워크.
- Caddyfile host bind `/home/leefam/caddy/Caddyfile` → `/etc/caddy/Caddyfile`.

근거 명령: `docker inspect digithive --format '{{json .Config.Labels}} {{json .Mounts}} {{json .NetworkSettings.Networks}}'`와 caddy_proxy의 mounts/networks 조회, `docker compose version`; SSH `bash_14`, exit 0.

## 실행 경계

이 단계에서 컨테이너·파일·volume·프록시를 수정하지 않았다. 다른 서비스가 함께 실행 중이므로 전체 Compose project 정리·Docker prune·공유 network 삭제를 수행하지 않는다. 새 앱의 인증·기본 대화·라우팅을 확인한 뒤 digithive만 교체한다. 사용자 폐기 허용은 다른 서비스 삭제나 기존 비밀값 출력의 권한이 아니다.

독립 검토 대상 계획은 아직 frozen 상태다. 검토 후 이 배포 사실과 사용자 실행 권한을 execution ledger에 통합한다.

## 실행 도구·설정 항목 사전 확인

`bash_15` SSH 명령 exit 0:

```text
docker inspect digithive --format '{{range .Config.Env}}{{println .}}{{end}}' | cut -d= -f1
command -v bun
command -v canvas
command -v node
docker compose -f /home/leefam/digithive/compose.yml config --services
```

확인된 앱 설정은 passphrase/host/port/DB/backup/public host이며, 기존 컨테이너 환경 항목에 모델 API Key 설정은 없었다. 비밀값은 출력하지 않았다. 호스트 PATH에서 bun/canvas/node의 경로는 반환되지 않았다. Compose service는 digithive다. 새 런타임과 Canvas CLI는 컨테이너 이미지에 준비해야 하며 호스트 설치를 가정하지 않는다. 모델 자격증명은 기존 컨테이너에서 재사용 가능하다고 추정하지 않는다.
