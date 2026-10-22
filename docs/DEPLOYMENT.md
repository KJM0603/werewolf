# 하위 주소와 음성 중계 배포 안내

## 이번 변경

- 받은 세 파일은 `docs/received/`에 원본 그대로 보관했습니다. `base_path.patch`의 변경은 이미 코드에 반영했으므로 다시 적용하지 마세요.
- 최신 기준 커밋은 `25ee40c`이며, 양방향 미디어 협상 수정 `6d7b408`을 포함합니다. 이 코드에 하위 주소, TURN, 카카오톡 브라우저 안내, 재접속 보완을 추가했습니다.
- 서버 로그와 임시 파일은 Git 추적에서 제외했습니다. 기존 PDF 생성 소스는 `scripts/build_guide.py`로 옮겨 보존했습니다. 과거 커밋에 포함된 로그까지 지우는 변경은 아닙니다.
- 첨부 사용설명서는 수신 당시 자료입니다. 현재 토론 시간, 밤 행동 시간, AI 추가 방법과 다른 설명이 있으므로 최신 동작은 저장소 README를 참고하세요.

## 실행 환경과 주소

Node.js 20 이상에서 별도 패키지 설치 없이 `node server.mjs`로 실행합니다. 작업 디렉터리는 저장소 루트로 지정합니다.

```powershell
$env:PORT='4173'
$env:BASE_PATH='/game-werewolf261020'
node server.mjs
```

`http://localhost:4173/game-werewolf261020/`로 확인합니다. 마지막 `/`가 없으면 자동 이동하며 쿼리 문자열을 보존합니다. `BASE_PATH`를 설정하지 않거나 빈 값이면 기존 `http://localhost:4173/`로 동작합니다. `/`도 빈 접두어로 처리합니다. 접두어는 `/games/werewolf`처럼 영문·숫자·밑줄·하이픈 경로를 지원합니다.

기존 운영 프록시는 접두어를 유지하여 HTTP와 WebSocket을 전달해야 합니다. WebSocket 경로는 `/game-werewolf261020/signal`입니다. 마이크·카메라는 HTTPS에서 이용하세요. 기존 대문 인증을 HTTP와 WebSocket에 모두 적용하세요. 방 생성은 누구나 할 수 있으므로 방 입장만으로 유료 TURN 남용이 완전히 방지되는 것은 아닙니다.

`.env.example`은 설정 목록입니다. 파일 복사만으로 자동 적용되지는 않습니다. 기존 프로세스 관리자 또는 컨테이너 환경변수로 주입하세요. 실제 비밀키는 Git에 넣지 마세요.

## B안: Cloudflare TURN

운영자가 Cloudflare에서 TURN Key ID와 해당 TURN 키의 API Token을 발급한 다음 다음 변수를 설정합니다.

```text
TURN_PROVIDER=cloudflare
CLOUDFLARE_TURN_KEY_ID=<TURN Key ID>
CLOUDFLARE_TURN_API_TOKEN=<해당 키의 API Token>
TURN_TTL_SECONDS=3600
ICE_TRANSPORT_POLICY=all
```

서버가 Cloudflare에 임시 인증 정보를 요청하고 현재 방에 연결된 참가자에게만 전달합니다. 장기 API Token은 서버에 남습니다. 참가자별 캐시와 동시 요청 병합을 사용하고, 만료 2분 전부터 새 인증 정보로 갱신합니다. 공급자 오류에는 30초 재시도 간격을 두고 화면에 실패를 안내하며, TURN 설정 실패를 정상 연결로 표시하지 않습니다.

실제 발급 방식은 [Cloudflare 공식 문서](https://developers.cloudflare.com/realtime/turn/generate-credentials/)를 따릅니다. 이용 한도와 비용은 계정의 최신 요금 및 사용량 화면에서 확인하세요. 이 저장소를 적용하는 것만으로 Cloudflare 계정 생성이나 TURN 활성화가 이루어지지는 않습니다.

## A안: NAS 또는 자체 coturn

운영자가 coturn을 설치하고 외부에서 연결 가능한 주소, 인증서, 방화벽 및 중계 포트 범위를 구성해야 합니다. 앱의 HTTP 역방향 프록시만으로 TURN이 열리지는 않습니다. 다음은 앱 환경변수입니다.

```text
TURN_PROVIDER=coturn
TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp,turns:turn.example.com:5349?transport=tcp
TURN_SHARED_SECRET=<coturn과 동일한 강한 비밀값>
TURN_TTL_SECONDS=3600
ICE_TRANSPORT_POLICY=all
```

coturn에는 `use-auth-secret`, 동일한 `static-auth-secret`, 실제 도메인의 `realm`을 설정합니다. NAT 뒤에 있으면 외부 IP 매핑과 TURN 릴레이 포트 전달도 필요합니다. `turns:`는 유효한 인증서와 TLS 포트를 구성했을 때만 추가하세요. 앱은 만료 시간과 무작위 식별자로 사용자 이름을 만들고 HMAC-SHA1로 임시 비밀번호를 발급합니다. 상세 설정은 [coturn 공식 설정 예제](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf)를 참고하세요.

## 접속 복구와 모바일 안내

- 카카오톡 내부 브라우저에는 Safari·Chrome으로 열라는 안내가 표시됩니다. 브라우저별로 재접속 정보가 따로 저장되므로 방 입장 전에 외부 브라우저로 이동하는 것이 좋습니다.
- 화면 복귀와 네트워크 복구 시 연결을 점검합니다. 응답 없는 연결은 다시 연결하고, 실패가 반복되면 대기 시간을 최대 약 30초로 늘립니다.
- 미디어 실패 시 ICE 재협상을 시도합니다. 계속 안 들리면 `미디어 연결 재시도`, 자동 재생 차단이면 `상대 소리 재생`을 누릅니다.
- 모바일 운영체제가 화면 잠금이나 백그라운드에서 브라우저를 정지시키는 것까지 막을 수는 없습니다. 음성 사용 중에는 페이지와 화면을 유지하세요. 카메라는 페이지 이탈 시 꺼지며 사용자가 다시 켜야 합니다. 채팅만으로도 진행할 수 있습니다.

## 검증과 배포

```powershell
npm test
node tests/browser/serve-media.mjs
```

두 번째 명령 후 `http://localhost:4188`에서 검증 시작을 누르면 실제 브라우저 WebRTC로 3명의 6방향 합성 음성·영상 전송을 확인합니다. 이 테스트는 TURN 통신 성공을 증명하지 않습니다.

실제 운영 환경에서는 TURN 자격 증명을 설정한 뒤 임시로 `ICE_TRANSPORT_POLICY=relay`를 지정하여 서버를 시작하세요. 모든 참가자가 새로 접속한 상태에서 서로 다른 이동통신망의 Safari·Chrome으로 3명이 들어와 다음을 확인합니다.

1. 세 사람 모두 나머지 두 사람의 소리를 듣는지 확인합니다(총 6방향).
2. 늦게 마이크를 켜고 꺼도 전달되는지, 카메라를 추가해도 음성이 유지되는지 확인합니다.
3. 앱 전환 후 복귀와 Wi-Fi/데이터 전환을 시험합니다. 자동 복구 또는 재시도 버튼으로 복구되는지 확인합니다.
4. Chrome `chrome://webrtc-internals`에서 선택된 candidate pair의 local candidate가 `relay`이고 수신 패킷이 증가하는지 확인합니다. `relay` 강제 설정에서는 직접 연결로 통과할 수 없습니다.
5. 확인 후 `ICE_TRANSPORT_POLICY=all`로 되돌려 직접 연결과 TURN 대체 경로를 함께 사용합니다.

서버 재시작은 메모리에 있는 모든 방을 종료합니다. 접속자가 없는 시간에 운영자가 배포하고 위 절차를 확인해 주세요. 이 작업에서는 운영 서버 배포나 외부 이동통신망 실통화를 수행하지 않았습니다.
