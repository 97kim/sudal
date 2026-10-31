# Claude·Codex ACP 전환 준비

관련 이슈: [#15](https://github.com/97kim/sudal/issues/15)

상태: **실험 브랜치에 보관, 기본 연결 전환 보류** (`feat/acp-preparation`).
기본 개발은 Claude Agent SDK·Codex App Server 연결을 유지한다. ACP 실험을 재개할 때 이 문서의 미검증 항목부터 확인한다.

이 문서는 현재 연결을 ACP로 바꾸기 전에 필요한 준비와 검증을 기록한다.
앱의 기본 경로는 Claude Agent SDK와 Codex App Server이다. 명시적으로 만든 새 ACP 실험
대화만 별도 연결을 사용하며, 기존 대화는 연결 방식과 세션 ID를 유지한다. Antigravity는 CLI를 유지한다.

## 추가한 기반

- `src/main/acp-client.ts`: 공식 `@agentclientprotocol/sdk` 2.2.0을 사용하는 ACP v1 stdio 클라이언트
- `src/main/acp-session.ts`: 명령 목록·그룹형 설정 선택지·지원 기능 메타데이터 변환
- `src/main/acp-adapter.ts`: 실험 탭의 ChatEvent·일회 승인·슬래시 실행·복원·종료 연결
- `src/main/acp-runtime.ts`: 사용자 데이터 폴더에서 명시한 어댑터 실행 설정 읽기
- `yarn acp:probe`: 실제 어댑터의 초기화·새 세션·설정·명령 목록을 조회하는 개발용 진단
- `src/main/acp-client.test.ts`: 실제 자식 프로세스를 이용한 프로토콜·승인·취소·종료 회귀 검증

클라이언트는 세션 ID와 함께 업데이트를 즉시 전달하며 전체 대화 기록을 보관하지 않는다.
파일·터미널 실행·인증 UI·하위 에이전트 등의 클라이언트 확장은 구현 전까지 선언하지 않는다.
승인 콜백이 없거나 실패하거나 알 수 없는 선택지를 반환하면 실행을 허용하지 않는다.
취소 상태는 턴이 끝날 때까지 유지해 뒤늦게 도착한 승인도 콜백 호출 없이 취소한다.
다음 턴은 새로운 취소 상태를 사용하며 다른 세션의 승인에는 영향을 주지 않는다.
승인 대기는 prompt의 제어 요청 타임아웃에 포함하지 않으며, 사용자 취소는 별도 처리한다.
연결 종료·요청 타임아웃 시 미결 요청을 해제하고 소유 프로세스 트리를 정리한다.

실험 탭은 `SessionManager`·IPC·채팅 화면·승인 카드·앱 종료에 연결했다.
기존 SDK의 기능 전체를 대체하지는 않으며, 검증 범위는 아래에 구분한다.

## 앱에서 실험 대화 열기

어댑터는 직접 설치한 뒤, Sudal 사용자 데이터 폴더의 `acp-adapters.json`에 실행 설정을 둔다.
다른 파일을 쓰려면 앱을 실행할 때 `SUDAL_ACP_CONFIG`를 해당 파일의 경로로 지정한다.
저장소 설정에서는 실행 파일을 자동으로 읽지 않는다. 설정 파일은 인증 정보 없이 실행 경로와 인자만 담는다.

```json
{
  "codex": {
    "command": "C:/Program Files/nodejs/node.exe",
    "args": ["C:/tools/acp/node_modules/@agentclientprotocol/codex-acp/dist/index.js"]
  },
  "claude": {
    "command": "C:/Program Files/nodejs/node.exe",
    "args": ["C:/tools/acp/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js"]
  }
}
```

macOS에서는 `command`와 `args`를 설치된 Node·어댑터 경로로 바꾼다. 경로처럼 적은 상대 `command`는
설정 파일 기준이며 `args`의 파일 경로는 절대 경로를 권장한다. 초기 로그인은 각 제공사의 CLI에서 완료한다.

Claude 또는 Codex 대화의 헤더 더보기에서 **새 ACP 실험 대화**를 선택한다.
폴더 신뢰를 확인하고 같은 제공사·작업 경로의 새 탭을 연다. 기존 대화의 모델·권한·세션 ID는 복사하지 않는다.
실험 탭의 연결 방식은 저장되며, 탭을 닫았다 열거나 앱을 다시 실행해도 ACP로 복원한다.
복원 실패 시 다른 연결이나 새 세션으로 바꾸지 않고 오류를 표시한다.

- 입력창 `/` 목록은 사용자 스니펫과 ACP `available_commands_update`를 함께 표시한다.
- Codex ACP가 `$스킬명`으로 제공한 항목은 `$` 자동완성으로 분리한다. 문장 중간에서도 선택할 수 있고 `/` 없이 삽입·전송한다.
  이 목록은 같은 ACP 세션의 명령 알림을 사용하며 스킬 경로나 별도 App Server 연결을 추측해서 만들지 않는다.
- 에이전트가 새 목록을 보내면 해당 세션의 자동완성도 갱신한다. 같은 폴더의 다른 탭 목록과 섞지 않는다.
- 모드·모델 등 설정 변경 알림도 현재 설정에 반영한다. 단순 `/plan` 전환은 대화에 입력·설정 안내·성공 요약을 남기지 않는다.
  전환 실패는 오류로 표시하며, 본문 요청이나 첨부가 있으면 일반 대화로 처리한다. 이전에 저장한 모드 전환도 화면에서 숨긴다.
  입력창 하단에 계획 모드 켜짐·꺼짐을 표시하며, 오른쪽 패널에서 에이전트의 현재 설정을 확인할 수 있다.
- `/config`, `/new`, `/clear`, `/rename`, `/cd`는 Sudal이 처리하며 같은 이름이 겹치면 앱 명령을 우선한다.
- `/model`, `/mcp`, `/skills`, `/review`, `/compact` 등은 에이전트가 제공한 그대로 ACP에 전송한다.
  `/skills`를 기존 Codex의 `$` 입력으로 바꾸거나, `/compact`를 요약 후 새 세션으로 대체하지 않는다.
- ACP가 실제 제공한 `/logout`, `/doctor`는 SDK/TUI 전용 명령 필터로 숨기지 않는다. 내부 명령은 계속 숨긴다.
- 새 연결은 Claude `default`, Codex `read-only`로 시작하고 실제 설정 응답을 확인한다.
  해당 모드를 제공하지 않거나 적용하지 못한 어댑터는 실행하지 않는다.
- 일회 승인·거부만 연결했다. 항상 허용·사용자 질문·추가 확장과 동일한 의미라고 가정하지 않는다.
- 앱의 모델 피커·권한 변경·제공사 전환·터미널 이어받기·실행 중 steer는 실험 탭에서 막는다.
  모델 변경 등은 지원되는 ACP 명령으로 실행한다. 토큰·비용 집계는 미지원으로 표시한다.
- 취소, 대화 비우기, 탭 닫기, 앱 종료 시 ACP 연결을 정리한다. 초기화 중 닫는 경우도 취소한다.

### 확인한 범위

- 가짜 stdio 에이전트 회귀 테스트: 명령 조회·동적 갱신·일반 텍스트·도구 이벤트·일회 승인·취소·복원 중복 방지,
  미지원 설정 거절, 폴더 신뢰 대기 중 탭/경로 변경.
- 실제 Windows 어댑터: Codex 2.5.0의 명령 74개와 `/status`, Claude 0.99.1의 명령 48개와 `/model` 응답 확인.
  이 두 명령은 도구 실행 없이 완료됐다. 전체 스킬 실행이나 실제 모델 추론·파일 변경 승인의 검증은 아니다.
- 실제 모델을 사용하는 검증은 Codex를 우선한다. Claude는 모델 호출 테스트 환경이 준비되지 않아
  실제 응답·도구 승인·취소·재시작 복원·사용량 검증을 보류한다.
  Claude 초기화·명령 목록·`/model` 설정 응답과 모의 테스트를 실사용 검증 완료로 취급하지 않는다.
- 별도 Electron 프로필: 두 제공사의 새 실험 대화 생성, 자동완성 선택·전송, 동적 명령 갱신,
  `/clear` 후 ACP 연결 유지. `yarn build` 후 `node e2e/check-acp-slash.cjs`로 실행한다.
  영어는 `node e2e/check-acp-slash.cjs --english`로 확인한다.
- macOS 실험 연결 실행과 아래 점검표의 고급 기능은 아직 미검증이다.

### 재개 전 확인할 문제

- Codex에서 새 세션을 만든 뒤 `/plan` 같은 로컬 명령만 실행하면 rollout 기록이 생기지 않을 수 있다.
  이 상태에서 앱을 재시작했을 때 `no rollout found for thread id` 복원 실패를 실제로 확인했다.
  명령 전용 세션의 수명·복원 정책과 오류 안내를 정리해야 한다.
- Codex ACP 2.5.0의 `/plan`은 무인자 토글이다. 현재 모의 에이전트의 `/plan off` 처리는 실제 어댑터와 다르므로,
  인자 오류를 정상 전환으로 숨기지 않는지 검증하고 모의 테스트를 실제 규칙에 맞춰야 한다.
- 사용량 이벤트·상세 집계는 아직 연결하지 않았다. Claude 실제 모델 호출·도구 승인·복원 검증도 별도로 필요하다.

## 진단 실행

어댑터는 개발자가 별도로 준비한다. Sudal의 의존성에는 통신용 SDK만 추가했으며,
Claude·Codex ACP 어댑터를 자동 설치하거나 사용자 CLI 경로를 교체하지 않는다.

```bash
npm install --prefix .sudal/acp-adapters --no-audit --no-fund @agentclientprotocol/codex-acp@2.5.0 @agentclientprotocol/claude-agent-acp@0.99.1
```

로컬 설정 파일을 만든다. 아래 예는 PATH에 `codex-acp`가 있는 경우다.
별도 폴더에 설치했다면 `command`를 Node 실행 파일로, `args`를 해당 어댑터의
`dist/index.js` 절대 경로로 지정한다. 실행 파일 경로는 셸 명령문으로 조합하지 않는다.
Windows의 npm 전역 설치는 `command`에 `codex-acp.cmd`의 절대 경로를 지정하거나,
Node와 `dist/index.js`를 분리해 지정한다. PowerShell의 `.ps1` 파일은 실행 대상으로 쓰지 않는다.

```json
{
  "provider": "codex",
  "command": "codex-acp",
  "args": []
}
```

```bash
yarn acp:probe --config .sudal/codex-acp.json --output .sudal/codex-acp-report.json
```

- `provider`: `claude` 또는 `codex`. Antigravity는 진단 대상으로 받지 않는다.
- 작업 폴더를 생략하면 임시 폴더에 새 세션을 생성하고 폴더를 정리한다.
  에이전트의 세션 메타데이터는 해당 에이전트의 저장소에 남을 수 있다.
- `--cwd`로 실제 작업 폴더를 지정하면 해당 폴더의 에이전트 설정이 적용될 수 있다.
- 기본 진단은 모델에 프롬프트를 보내지 않는다. 명령 목록 수신과 세션 생성은 명령의 실제 실행과 다르다.
- `--authenticate <methodId>`를 명시한 경우에만 서버가 안내한 인증을 시작한다.
  기존 로그인으로 새 세션 생성이 되는 경우 이 옵션은 필요 없다.
- 슬래시 목록은 세션 생성 응답 앞이나 뒤에 수신될 수 있다. 응답 후 최대 2초간 기다리며,
  `commandsReceived`가 없는 것은 이 시간 안에 받지 못했다는 의미다.
- 인증 URL·계정 정보가 포함될 수 있는 어댑터 stderr는 출력하지 않는다.
  진단 결과에도 개인별 스킬 이름·모델·세션 메타데이터가 들어갈 수 있으므로 저장소에 올리지 않는다.
- 일반 Windows 배치는 실행하지 않는다. 실행 파일·Node 스크립트·인식 가능한 npm shim을 사용한다.

## Windows 실제 어댑터 확인 (2026-10-31)

같은 진단 명령과 임시 작업 폴더에서 확인했다. 모델 추론 요청은 보내지 않았다.
아래 시간과 명령 개수는 이 PC에서 관측한 값이며 환경·계정·설치된 스킬에 따라 달라진다.

| 항목 | Codex ACP 2.5.0 | Claude ACP 0.99.1 |
|---|---|---|
| 초기화 | 성공, 약 1.2초 | 성공, 약 5.8초 |
| 새 세션 생성 | 성공, 약 1.9초 | 성공, 약 2.0초 |
| 슬래시 목록 수신 | 74개(개인별 스킬 포함) | 48개 |
| 예시 명령 | `/review`, `/compact`, `/skills`, `/plan` | `/code-review`, `/debug`, `/verify` |
| 모델·추론 강도 설정 메타데이터 | 수신 | 수신 |
| load / resume / list 지원 선언 | 있음 | 있음 |
| 이미지 지원 선언 | 있음 | 있음 |
| 실제 모델 응답·승인·기록 복원 | 미실행 | 미실행 |

`loadSession` 등의 선언만으로 해당 기능이 Sudal과 완전히 호환된다고 판단하지 않는다.
실제 승인 왕복·취소·다중 세션·기록 재생은 외부 모델을 부르지 않는 시험용 에이전트로 검증했다.
이는 Claude·Codex의 실제 승인/기록 복원을 검증한 결과와 구분한다.
macOS 실행은 아직 검증하지 않았다.

Windows에서 관련 회귀 테스트·타입 검사·앱 빌드와 가짜 에이전트를 연결한 Electron 채팅 UI 검증을 통과했다.
시험용 에이전트의 통과 결과는 위 실제 어댑터·모델 호출 검증 범위와 구분한다.

## 전환 전 기능 점검표

| 기능 | 공통화할 부분 | 남은 확인 |
|---|---|---|
| 기본 대화·도구·이미지 | ACP prompt와 session/update | 실제 ChatEvent/이미지/오류 매핑, 도구 결과 정보 보존 |
| 슬래시 자동완성 | available_commands_update → SlashCommandDto | 앱 명령과의 이름 충돌, 사용자 스킬 명령의 삽입·실행 규칙 |
| 모델·추론 강도·빠른 모드 | configOptions | ID와 기본값 유지, 설정 변경 시 실제 동작 |
| 승인·항상 허용·질문 | request_permission 및 필요한 확장 | 옵션의 지속 범위·입력 수정·사용자 질문·승인 철회 |
| 권한 정책 | 동적 mode/config 목록 | Sudal 정책과 실제 샌드박스의 범위가 같은지 확인 |
| 자동 승인 검토 | 제공사별 정책/확장 | Claude의 auto는 보이나 Codex 목록에는 auto_review가 없음. 더 느슨한 모드로 대체하지 않기 |
| 기록·재시작 | load / resume / list | 최근 우선 로딩, 재생 중복, 기존 SDK/App Server 세션 ID 호환성 |
| 특정 턴에서 대화 분기 | 제공사별 확장 또는 기존 API | pointId와 과거 턴 선택 보존. 전체 세션 분기만으로 대체하지 않기 |
| 압축·실행 중 추가 입력 | 명령 또는 확장 | 기존 요약/새 세션 구분, 진행 중 steer 처리 |
| 하위 에이전트·백그라운드 | 제공사별 확장 | 자식 세션 이벤트·권한·완료·중단의 일치 |
| 터미널로 이어받기 | 기존 터미널 계층 | 같은 세션을 동시에 제어하지 않도록 소유권 전환 |
| 언어 유지 훅 | 기존 SDK 훅 또는 확장 | Claude UserPromptSubmit/PostToolBatch 문맥 주입과 동작 일치 |
| 구독 한도·상세 사용량 | 필요 시 기존 전용 조회 | API 환산과 실제 토큰 계수, 모델별 집계 중복 방지 |
| MCP·스킬·앱 | 명령·확장 또는 기존 조회 | 상태/오류/도구 목록 구조와 사용자의 설정 유지 |
| 팬아웃·교차 리뷰·예약 | 기존 Sudal 오케스트레이션 | 각 세션 정책·작업폴더·중단·결과 수집 회귀 확인 |

## 다음 구현 순서

1. 실제 Claude·Codex로 모델 추론·파일 변경 승인·취소·재시작 복원·사용자 스킬 실행을 확인한다.
2. 모델·추론·권한 선택 UI를 실제 `configOptions`와 연결하고 상태 변경을 반영한다.
3. 질문·상시 승인·하위 세션 등의 확장과 기능 지원 상태를 구체화한다.
4. 점검표의 전용 기능을 유지할 확장/직접 API 경로를 정한다.
5. Windows·macOS의 다중 세션·시작 시간·메모리·오류 복구를 비교한 후 기본 경로 전환을 결정한다.

검증이 끝나기 전에는 기존 SDK 의존성을 제거하거나 ACP 실패 시 다른 세션을 몰래 생성하지 않는다.

## 참고

- [ACP TypeScript SDK](https://agentclientprotocol.com/libraries/typescript)
- [ACP v1 슬래시 명령](https://agentclientprotocol.com/protocol/v1/slash-commands)
- [Claude ACP 어댑터](https://github.com/agentclientprotocol/claude-agent-acp)
- [Codex ACP 어댑터](https://github.com/agentclientprotocol/codex-acp)
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
