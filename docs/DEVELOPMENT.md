# Sudal 개발 문서

빌드·릴리스·검증 방법과 코드 구조예요. 기능 설명은 [기능 안내서](GUIDE.ko.md)에 있어요.

## 개발

```bash
yarn            # 의존성 설치 (postinstall 이 electron 바이너리를 받는다)
yarn dev        # electron-vite dev
yarn test       # node:test (순수 리듀서·매퍼·main 모듈)
yarn typecheck  # main/preload/shared + renderer
yarn package    # ad-hoc 서명 arm64 DMG (release/sudal-<version>-arm64.dmg)
```

- `SUDAL_DEV_CWD=/path/to/repo yarn dev` — 워크스페이스를 미리 추가하고 탭을 하나 연다.
- `SUDAL_MAX_CONCURRENT=4` — 동시에 실행하는 턴 수 상한(기본 4). 넘으면 탭 상태가 "대기열"이 된다.
- `yarn dev -- --remote-debugging-port=9333` — CDP 로 UI 자동화/디버깅.
- `SUDAL_DEBUG_SDK=1` — Claude CLI stderr 를 콘솔에 출력.
- `SUDAL_APPROVED_ROOTS=경로:경로` — 검증용으로 작업 경로를 미리 승인한다.
- `SUDAL_E2E_MOCK_KEYCHAIN=1` — (macOS, e2e 전용) 쿠키 암호화에 실제 키체인 대신 고정 키를 쓴다. 패키징 빌드마다 서명이 바뀌어 키체인 허용 창에 막히는 것을 피한다.

## 릴리스

GitHub Actions의 `release` 워크플로가 macOS arm64 DMG와 Windows x64 설치 파일을 각 운영체제에서 빌드한다.
로컬 Mac은 필요 없다. Windows에서도 아래 명령으로 버전 커밋과 태그를 올리면 배포가 시작된다.

### 최초 설정

`97kim/sudal` 저장소 Settings → Secrets and variables → Actions에 `HOMEBREW_TAP_TOKEN`을 등록한다.
GitHub fine-grained personal access token의 대상 저장소는 `97kim/homebrew-sudal` 하나,
Repository permissions → **Contents: Read and write**로 설정한다. 토큰은 채팅·코드에 붙여 넣지 않는다.
기본 `GITHUB_TOKEN`은 현재 저장소에만 접근할 수 있어 Homebrew 저장소 갱신에는 별도 토큰이 필요하다.
앱 릴리즈 생성에는 Actions가 제공하는 `GITHUB_TOKEN`을 사용한다.

실제 공개를 요청했는데 Homebrew 토큰이 없거나 유효하지 않으면 빌드 전 단계에서 실패한다.
PR 빌드·수동 빌드 검증에는 이 토큰이 필요하지 않다.

### GitHub Actions에서 새 버전 시작

`release-notes/<새 버전>.md`를 PR로 머지하고 최신 main의 `test` CI가 통과하면,
GitHub → Actions → **start-release** → **Run workflow**에서 브랜치 `main`과 새 버전(예: `0.21.0`)을 입력한다.
현재 버전보다 큰 정식 버전만 허용한다. 버전 커밋과 태그를 함께 올린 뒤 기존 `release` 워크플로를 호출해
Windows·macOS 빌드, 산출물 검증, 공개, Homebrew 갱신까지 실행한다. 로컬 Node.js·Yarn은 필요 없다.

저장소의 기본 `GITHUB_TOKEN`에 이 작업의 `contents: write`, `actions: write` 권한을 부여한다.
기존 Homebrew 갱신용 `HOMEBREW_TAP_TOKEN`도 필요하다. main의 새 CI 실행과 버전 커밋·태그 확인이 끝나기 전에
main이 변경되면 시작을 중단하므로 최신 main의 CI를 확인한 뒤 다시 실행한다.

기본 토큰이 올린 태그는 다른 `push` 워크플로를 실행하지 않으므로 `release`를 `workflow_dispatch`로 직접 호출한다.
태그 생성 후 이 호출만 실패했다면 `start-release`를 반복하지 말고 기존 `release`에서 `tag=v<버전>`, `publish=true`로 실행한다.
빌드·공개 단계가 실패했을 때도 아래의 **실패한 릴리즈 재실행** 절차를 따른다.

### Windows 또는 macOS에서 시작

먼저 `release-notes/<새 버전>.md`에 사용자 관점의 한국어 변경 사항을 글머리표로 작성하고 PR로 머지한다.
제목과 설치 안내는 넣지 않는다. 공통 `release-notes/INSTALL.md`를 합쳐 기존 형식인
`이번에 달라진 것 → 설치 → Windows에 설치하기 → 필요한 것`으로 만든다.
Windows 설치 파일 이름은 배포 버전으로 자동 치환한다. 변경 사항 파일이 없으면 커밋·태그를 만들기 전에 중단한다.

```bash
git switch main
git pull --ff-only
yarn install --frozen-lockfile
yarn release 0.15.0 --dry-run  # 변경 없이 검사. 예시 버전은 현재보다 높게 정한다.
yarn release 0.15.0            # 버전 커밋 + 태그를 함께 push → Actions 실행
```

Node.js 22 이상, Yarn, Git과 저장소 push 권한이 필요하다. `main`은 깨끗하고 원격과 같아야 한다.
`yarn release`에 버전을 생략하면 현재 `package.json` 버전을 사용한다. 이미 존재하는 태그는 덮어쓰지 않는다.
버전 커밋·태그 생성 후 push가 실패하면 원인을 해결하고 `git push --atomic origin main refs/tags/v버전`으로 재시도한다.
이 경우 버전 올리기 명령을 다시 실행할 필요는 없다.

두 OS에서 타입 검사·테스트·패키징이 모두 성공해야 공개한다. macOS는 `macos-26` arm64/Xcode 26 이상,
Windows는 `windows-2025` x64를 사용한다. 기존과 같이 macOS는 ad-hoc 서명이며 공증하지 않고, Windows도 코드 서명하지 않는다.
모은 DMG·EXE·blockmap·`latest.yml`의 존재·버전·EXE 체크섬을 확인하고,
GitHub의 draft 릴리즈에 파일을 모두 업로드한 뒤 공개한다. `SHA256SUMS`와 Homebrew `sudal.rb`도 함께 제공한다.
공개 후에는 실제 공개된 DMG의 SHA-256으로 `97kim/homebrew-sudal`의 `Casks/sudal.rb`를 갱신한다.

릴리즈 관련 파일을 바꾸는 PR에서는 같은 빌드를 실행해 Actions artifacts로만 보관한다. 태그·릴리즈·Homebrew는 수정하지 않는다.
빌드 산출물은 각 실행 페이지의 Artifacts에서 14일 동안 받을 수 있다.

### 실패한 릴리즈 재실행

- Actions → 해당 `release` 실행 → **Re-run failed jobs**로 실패한 단계부터 재실행한다.
- 또는 Actions → release → **Run workflow**에서 브랜치는 `main`, `tag`는 기존 `v버전`을 입력한다.
  `publish`를 끄면 빌드만 검증하고, 켜면 공개와 Homebrew 갱신까지 진행한다.
- 이미 공개한 릴리즈 파일은 재업로드하지 않는다. Homebrew 단계만 실패했다면 공개된 DMG로 갱신을 재시도한다.
- 새 버전을 이미 공개한 뒤에는 이전 버전을 latest로 만들거나 Homebrew를 이전 버전으로 되돌리지 않는다.
- 태그의 버전과 `package.json`이 다르거나 태그가 `main`에 포함되지 않은 커밋이면 공개하지 않는다.

### 버전을 어떻게 올리나

기준은 하나다 — **쓰던 사람이 새로 배울 것이 있는가.**

| 자리 | 언제 | 예 |
|---|---|---|
| **PATCH** `0.2.x` | 배울 게 없다. 버그 수정, 하던 대로 했는데 더 잘 되는 것, 문구·배치 손질 | ⌘W 가 보고 있던 탭을 닫게, Gatekeeper 안내 수정 |
| **MINOR** `0.x.0` | 새 화면·새 개념·새 단축키가 생긴다. 설명을 읽어야 쓸 수 있다 | 넓게 보기(⌘⇧E), 팬아웃, 오케스트레이션, 인앱 브라우저 |
| **MAJOR** `x.0.0` | `0.x` 인 동안은 올리지 않는다 | — |

`1.0` 은 기능이 많아져서가 아니라 **남에게 권할 수 있을 때** 붙인다. 지금은 설치하려면 Gatekeeper 를 손으로 뚫어야 하므로 아직 아니다.
서명·공증이 되어 받는 사람이 두 번 생각하지 않고 열 수 있으면 그때가 `1.0` 이다.

애매하면 낮은 쪽으로 간다. 혼자 쓰는 앱이라 번호를 아껴서 손해 볼 일이 없다.

`scripts/release.mjs`는 로컬 버전·태그 생성, `scripts/release-ci.mjs`는 Actions의 검증·공개·Homebrew 갱신을 맡는다.
`scripts/release.sh`는 예전 명령 경로를 위한 래퍼다. 릴리즈 노트는 GitHub의 자동 생성 노트에 설치 안내를 덧붙인다.
예전 로컬 빌드 옵션 `PUBLIC_REPO`, `TAP_REPO`, `RELEASE_NOTES`는 사용하지 않는다. 노트는 공개 후 GitHub에서 편집할 수 있다.

새 버전은 설정 → 일반 → 업데이트에서 "업데이트 확인"을 눌러 확인한다. Homebrew로 설치한 앱은 "업데이트"를 누르면 새 버전을 설치하고, 완료 후 "다시 시작"을 누르면 새 버전으로 열린다. Windows는 릴리즈의 `latest.yml`을 읽는 `electron-updater`로 업데이트한다.
터미널에서는 `brew update && brew upgrade --cask sudal`로 업데이트한다. 앱에서도 Homebrew 탭을 갱신한 뒤 업그레이드하고 설치된 버전을 확인한다. GitHub 릴리스가 Homebrew 탭에 아직 반영되지 않았다면 잠시 뒤 다시 시도한다.
DMG로 직접 설치한 앱도 새 버전을 확인할 수 있지만 앱 안에서 설치할 수는 없다. 릴리스 페이지에서 새 DMG를 받아 Applications 폴더의 Sudal.app을 교체한다.

## 국제화 (i18n)

표시 언어는 한국어(ko)와 영어(en)다. 설정의 `language`(`system`·`ko`·`en`)를 main 이 해석해 `resolvedLocale` 로 내려 주고,
`system` 은 macOS 의 선호 언어(`app.getPreferredSystemLanguages()[0]`)가 한국어일 때만 ko 다. 화면·메뉴·알림·오류·CLI 응답의 문구는 모두 사전에 있다.
모델에게 보내는 프롬프트만 아직 한국어다(응답 언어 정책과 함께 다룰 예정).

- 사전은 `src/shared/i18n/ko.ts`(원본)와 `en.ts`, 영역별 파일은 `ko/*.ts`·`en/*.ts` 다. 영어 값에 빈 문자열을 넣지 않는다(번역이 있는 것으로 취급된다).
  한국어 사전의 모든 키에 영어를 붙인다 — 테스트(`i18n.test.ts`)가 빠진 키를 잡는다.
- 문구는 어디서 번역하느냐로 나뉜다.
  - 바로 보이고 사라지는 것(메뉴, macOS 알림, IPC 결과의 오류, CLI 응답): main 이 만든 자리에서 `mt("영역.키", { 값 })`(`src/main/i18n.ts`).
  - 저장됐다가 다시 그려지는 것(대화 기록의 오류·안내, 검증·리뷰·팬아웃 카드의 앱 문구, 예약 실행 사유, 오케스트레이션 메모): 문장 옆에
    `Msg`(`{ key, params }`, `src/shared/i18n/msg.ts`)를 함께 저장하고 그릴 때 `msgText(i18n, msg, 문장)` 으로 번역한다. 대화 이벤트는 `...appMsg(key, params)`,
    그 밖의 필드는 `<필드>Msg` 를 옆에 둔다. 키는 `<영역>.msg.*` 에만 두고, 한 번 내보낸 키와 값 이름은 저장 데이터의 일부라 바꾸지 않는다(문구는 고쳐도 된다).
    Msg 가 없거나 모르는 키면 함께 저장한 문장이 보인다(예전 기록, 외부 오류).
  - renderer 는 `useTranslation()` 의 `t`.
- provider·git·OS 가 준 오류 원문은 번역하지도 덮어쓰지도 않는다. 값(`detail`)으로 넣는다.
- 번역 결과를 상수나 state 에 담아 두지 않는다. 키와 값을 들고 있다가 그릴 때 번역해야 언어를 바꿨을 때 따라온다.
- 화면 문구로 동작을 정하지 않는다. 상태는 값으로 두고 문구는 그 값에서 만든다(`src/shared/tool-state.ts`, `shouldCoalesceSkip` 의 사유 비교가 예다).
- 자동으로 붙이는 이름(탭 제목, 새 워크스페이스·예약의 기본 이름)은 만드는 시점의 언어로 저장하고 다시 번역하지 않는다.
  앱이 만든 자리는 이름이 아니라 값으로 찾는다(예약 워크스페이스는 `builtin: "schedules"`). 예약 워크스페이스의 이름만은 예외로, 기본 이름 그대로면 언어를 바꿀 때 따라 바뀐다. 이름 없는 탭("새 세션")은 저장하지 않고 그릴 때 번역한다.
- `src/shared` 의 함수가 표시 문구를 만들면 `t: TFunction` 을 첫 인자로 받는다(`verifySummary`, `runSummary`, `fanoutSummary` 가 예다). main 은 `mt`, 테스트는 `createI18n("ko").t` 를 넘긴다.
- `cli/sudal.cjs` 는 의존성 없이 돌아야 해서 파일 안의 작은 표로 번역한다. 언어는 `SUDAL_LANG` → `LC_ALL` → `LC_MESSAGES` → `LANG` 순으로 본다.
- 번역 대상이 아닌 것: 모델에게 보내는 글, 로그, 외부 오류 문구를 읽는 파서(`usage-limit.ts`), 계산용 로케일(`cron.ts` 의 `en-US`).
- `yarn i18n:check` 는 코드에 남은 한국어 문구를 센다. `--list <경로>` 로 위치를 본다. `console.*`·`log(...)` 호출은 세지 않고,
  바로 윗줄에 `// i18n-ignore: <이유>` 가 붙은 노드도 건너뛴다 — 프롬프트처럼 화면 문구가 아닌 것에만, 가장 좁은 범위에 붙인다.
  `yarn i18n:strict` 는 전체가 0개여야 통과한다.
- 전환 확인은 `e2e/check-i18n-switch.cjs`.

## 실기기 검증 (e2e)

단위 테스트가 못 잡는 것 — 실제로 화면에 뜨는지, 실제 CLI 가 답하는지 — 은 `e2e/` 의 스크립트로 본다.
패키지 앱을 **별도 userData 로** 띄우고(사용자가 쓰는 앱과 single-instance lock 이 겹치지 않게) CDP 로 붙는다.

```bash
yarn package
cd e2e
SUDAL_APPROVED_ROOTS="$PWD" SUDAL_E2E_MOCK_KEYCHAIN=1 ../release/mac-arm64/Sudal.app/Contents/MacOS/Sudal \
  --user-data-dir="$PWD/userdata" --remote-debugging-port=9333 > app.log 2>&1 &
node check-header2.cjs      # 원하는 스크립트
```

`--user-data-dir` 이 핵심이다. `SUDAL_USERDATA` 는 앱이 자식 프로세스에 내보내는 값일 뿐 자기 userData 를 바꾸지 않는다.
CLI 를 붙일 때는 그 값을 준다(`SUDAL_USERDATA=$PWD/userdata`). 스크립트는 `playwright-core` 로 `connectOverCDP` 만 하므로
브라우저를 내려받지 않는다. `userdata/`·`repo/`·스크린샷·로그는 만들어지는 것이라 추적하지 않는다.

스크립트는 한국어 화면의 글자로 요소를 찾는다. 새 userData 는 macOS 언어를 따라가므로, 한국어가 아닌 환경에서는 먼저
`node set-language.cjs ko` 로 맞춘다(`en` 을 주면 영어 화면을 눈으로 볼 때 쓴다). 언어 전환 자체는 `check-i18n-switch.cjs` 가 본다.

사이드바·헤더처럼 창을 끌어 옮기는 영역(`drag`)에 버튼을 넣으면 `no-drag` 를 붙여야 눌린다. CDP 로 누르는 클릭은 이 영역을 우회해 통과하므로
클릭 검증으로는 잡히지 않는다 — `check-drag-buttons.cjs` 가 계산된 스타일로 본다.

## 고치기 전에 알아 둘 것

자동 검증 피드백의 실행·중단·반복 제한은 `src/main/verification-feedback.ts`, Git 변경본 지문은 `verification-revision.ts`에 있다.
`e2e/check-verification-feedback.cjs`는 별도 userData·Git 프로젝트와 모의 Codex App Server로 실제 명령 실패 → 진단 전달 → 수정 →
재검증·중단 버튼까지 검사한다. `yarn build` 후 `node e2e/check-verification-feedback.cjs`로 실행하며 실계정 모델을 호출하지 않는다.
추가 CLI는 테스트 인스턴스에서 비활성화하고, 스크린샷은 `.sudal/verification-feedback-ui.png`에 남긴다.

여기서 실제로 데인 것들이다. 겉보기에 멀쩡한 코드를 건드릴 때 이유를 모르면 되돌리기 쉬운 자리라 적어 둔다.

- **저장소는 ESM 이고 preload 만 CJS 다.** 두 SDK 가 ESM 전용이라 `package.json` 에 `"type": "module"` 을 두고 main 을 ESM 으로 번들한다.
  샌드박스의 preload 는 ESM 으로 읽히지 않아서 `out/preload/index.cjs` 로 따로 낸다 — preload 의 출력 형식을 바꾸지 말 것.
- **옛 이름(Atelier)은 `src/main/legacy-name.ts` 에만 남아 있다.** 옛 설치의 데이터 폴더·CLI·스킬을 처음 한 번 넘겨받는 코드다.
  옛 이름을 계속 받아 주는 호환이 아니니 다른 곳에 옛 이름을 되살리지 말 것. 검증용 인스턴스(`--user-data-dir`)에서는 동작하지 않는다 — 쓰던 데이터를 옮겨 버리지 않게.
- **테스트는 Electron 이 아니라 Node 로 돈다.** npm 의 `electron` 패키지는 실행 파일 경로만 내보내서 `import { session } from "electron"` 이 링크 단계에서 실패한다.
  `scripts/test-electron-stub.mjs` 가 테스트에서만 빈 값으로 바꿔 준다. main 이 `electron` 에서 새 이름을 가져오면 그 목록에 더한다.
- **비대화형 셸에는 PATH 가 거의 없다.** `claude`·`codex` 를 그냥 실행하면 못 찾는다.
  `src/main/cli-discovery.ts` 가 사용자 셸의 PATH 를 캡처해 후보를 `--version` 으로 검증한다. 이 경로를 건너뛰지 말 것.
- **권한 콜백은 턴을 세운다.** `canUseTool` 이 답을 줄 때까지 모델은 멈춰 있다. 그래서 대기 상태를 눈에 띄게 두고 창이 포커스 밖이면 알린다.
  `AskUserQuestion` 은 권한이 아니라 질문인데도 같은 콜백으로 오므로 "전부 자동" 에서도 사람을 기다린다.
- **스트리밍 중간 메시지와 최종 메시지가 둘 다 온다.** message id 로 합치지 않으면 같은 답이 두 번 쌓인다.
- **탭을 닫는 것과 세션이 끝나는 것은 다르다.** `AbortController.abort()` 뒤 프로세스가 실제로 내려갔는지 확인해야 한다.
  늦게 끝난 턴이 이미 지운 세션을 되살리지 않게 하는 것도 같은 이유다.
- **네이티브 모듈은 값이 비싸다.** `node-pty` 는 설치 후 `spawn-helper` 에 실행 권한을 다시 줘야 해서 postinstall 이 `chmod` 를 한다.
  `better-sqlite3` 는 같은 종류의 문제로 쓰지 않기로 했다 — 영속화는 JSONL 을 쓴다.
- **SDK 가 띄운 CLI 는 턴이 끝나면 하위 MCP 프로세스까지 연쇄 종료한다.** 그래서 탭마다 프로세스를 살려 두고 유휴 시간이 지나야 내린다.

## 구조

```
src/shared/     renderer ↔ main 계약 (ipc.ts), 공통 이벤트 스키마 (chat-events.ts), 세션 리듀서 (session-state.ts)
                워크스페이스/탭 모델 (workspace-model.ts), provider 전환 요약 (handoff.ts), 사용량 집계·가격표 (usage.ts)
                오케스트레이션 모델·리듀서 (orchestration.ts), 브라우저 진단 형식 (browser-diagnostics.ts)
src/main/       Electron main. cli-discovery / claude-adapter + claude-events / codex-adapter + codex-app-server + codex-events
                session-manager(큐·권한·핸드오프) / workspaces(모델 소유) / persistence(jsonl) / git / worktree / logger(파일 로그)
                orchestration(Run·Task·Dispatch) / verify(테스트·빌드 실행) / control-server(sudal CLI 소켓)
                browser-net(웹뷰 요청 실패 수집) / background-jobs(턴 밖 작업) / preview-server(로컬 HTML)
                transcripts(트랜스크립트 파서 + 스캐너) / transcript-mirror(터미널 모드)
src/preload/    contextBridge → window.sudal
src/renderer/   React + Tailwind. views/ChatView, views/SettingsView, components/*
```
# Conversation history

History loading uses `src/main/history-checkpoint.ts` to cache a checksummed projection and byte offset at the end of the indexed log, keeping the bounded recent page and lightweight identities for earlier blocks. Source size, timestamps and file identity must match; Store appends advance only the small metadata file. Clear/reset invalidates the cache, and a build racing with source changes is discarded. Cache files are optional and limited to 16 MiB, with at most eight in-memory entries. Prefix block identities, reducer counters/totals and restoration metadata retain late-update and stale-run behavior without old message bodies. `readJsonl` resumes on saved line boundaries. Older pages intentionally use full source replay. The renderer collapses prior bodies, fences in-flight pages when a new compaction arrives, and can hydrate archived search hits.

# Harness implementation

`src/main/harness.ts` owns project configuration, local tasks, suggestions and evidence associations. Shared task criteria keep completion separate from verification. The session manager appends the current task context at execution time, preserving user history and skipping native/slash commands. Queued-turn retries reuse the original prompt before applying fresh context.

Project configuration uses `sudal.harness.json` with schema version 1. The IPC harness endpoint derives the directory from the real tab, requires project trust for mutation, and never accepts a renderer-supplied path. Suggestions use optional `sudal-task` and `sudal-harness` fenced JSON; malformed output is ignored without altering chat history. Valid suggestions require explicit acceptance.

`e2e/check-harness.cjs` runs a separate Electron profile, real Git project and verification command with a fake Codex App Server. Run after `yarn build`; it checks UI task creation, evidence ownership, context injection, unchanged user history, stale revisions and restored task history without accessing a real account.

하네스 대화 카드는 메시지별 슬롯에 표시한다. 작업 제안은 저장된 원본 블록 ID, 완료 기록은 완료 시 저장한 직전 블록 ID를 사용한다. 해당 블록이 아직 로드되지 않았거나 압축되어 있으면 카드를 최신 대화 끝으로 옮기지 않는다. 확인·결과 연결 제안은 원본 응답 위치를 사용하고, 다음 사용자 메시지가 왔다는 이유로 미처리 제안을 제거하지 않는다.

카드 변경 시에는 제안/완료 → 후속 대화 → 화면 재진입 → 앱 재시작 순서로 원본 위치와 중복 여부를 확인한다. 일반 창과 좁은 창에서 본문 시작선·오른쪽 경계·가로 넘침도 확인한다. `e2e/check-harness.cjs`에 이 흐름을 유지하며, 설정 화면은 활성화 스위치·구성 편집·취소·저장·복원을 함께 확인한다.

## 하네스 완료 조건 검증

대화 확인 제안은 실제 탭 로그의 `assistant_text`와 직전 `user_message`를 서버에서 대조한다. 저장 시 원본 사용자 메시지 시각을 보존하고, 당시 코드 지문이 없는 확인은 `unconfirmed`로 기록한다. 현재 상태를 새로 확인하는 수동 확인과 구분하며, 오래된 기록을 늦게 저장해 최신 실패를 덮어쓰지 않는다. `recordedAt`/`afterBlockId`는 카드 위치만 정하고 상태 판정에는 쓰지 않는다. 동일 검증 결과의 정정 제안은 최신 유효 조건을 사용하며, 제안 닫기 상태는 원본 응답별로 구분한다.

기존 구현을 다시 확인할 때는 아래 대응표를 기준으로 검증 범위를 선택한다. 모든 결과는 실행한 변경본과 함께 기록하고, 테스트 응답과 실계정 모델의 확인 결과를 구분한다.

| 완료 조건 | 반복 가능한 확인 방법 |
| --- | --- |
| 프로젝트별 설정·활성화·보존 | `src/main/harness.test.ts`에서 같은 저장소 서비스를 사용하는 두 프로젝트의 설정·활성화·작업 분리와 서비스 재시작·비활성화 후 보존을 확인한다. UI E2E에서는 설정 폼 접기·재펼치기와 화면 재진입 후 구성을 확인한다. |
| 제안 검토·수정·수락·거절 | 서비스 테스트에서 제안만으로 작업·구성이 바뀌지 않는지, 거절·잘못된 제안이 적용되지 않는지 확인한다. UI E2E에서 작업 제안 수락·조건 편집 및 오래된 편집 거부를 확인한다. |
| 에이전트별 작업 맥락 | `src/main/session-task-context.test.ts`는 Claude·Codex·Antigravity의 공통 실행 경로에서 컨텍스트 생성 호출과 원본 사용자 기록 보존, 슬래시 명령 제외를 확인한다. 이 테스트는 런타임 준비를 모의 실패시키므로 실제 CLI 수신이나 모델의 지시 준수까지 증명하지 않는다. Codex UI E2E는 모의 App Server가 받은 프롬프트를 별도로 검사한다. |
| 조건별 검증·리뷰·직접 확인 | 서비스·공통 모델 테스트에서 실행 결과의 작업/조건 소유권, 실패·미확인·코드 및 조건 변경 후 재확인을 확인한다. UI E2E에서는 실제 검증 명령, 확인 내용 오연결 차단, 자동 수정 중단과 재검증을 확인한다. |
| 완료와 검증 상태 분리 | 공통 모델과 서비스 테스트에서 실패·미확인 조건이 있을 때 완료 사유를 요구하고, 완료 뒤에도 원래 상태·근거·사유가 재시작 후 남는지 확인한다. |
| 재발 방지 구성 | 서비스 테스트와 UI E2E에서 문제 기록 → 초안 검토 → 취소 시 기존 구성 보존 → 해당 문제에 연결해 적용 → 별도 동작 확인 → 재진입 후 보존을 확인한다. 구성을 적용했다는 사실만으로 재발 방지가 검증됐다고 표시하지 않는다. |
| UI 간섭·오류 복구 | UI E2E에서 초기 조회 실패·복구, 검증 모드와 다중 선택 유지, 상단 팝오버/검색/최대화 편집기의 Esc, 폼 보존, 저장 후 작업 화면 복귀를 확인한다. 분할 화면과 OS별 실기기 동작은 별도로 확인한다. |

기본 검증은 `yarn typecheck`, `yarn test`, `yarn build` 순으로 실행한다. 빌드 후 `node e2e/check-harness.cjs`와 `node e2e/check-verification-feedback.cjs`로 하네스 및 검증 피드백 흐름을 확인한다. E2E는 별도 임시 사용자 데이터와 프로젝트를 사용하며 실제 사용자의 작업 근거나 프로젝트 설정을 수정하지 않는다.

실계정 확인은 사용 가능한 각 CLI에서 일반 요청을 보내 활성 목표·조건을 참조하는지 확인하고, 입력한 원문이 대화 기록에 유지되는지 비교한다. 구독·설치·모델 한도로 실행하지 못한 제공자는 미검증으로 남긴다. 모의 테스트 통과를 실계정 확인으로 대신 기록하거나, 에이전트 보고를 사용자의 직접 확인으로 저장하지 않는다.

Windows에서 `yarn` 실행 파일 없이 Corepack만 설치돼 있다면 위 명령을 `corepack yarn typecheck`, `corepack yarn test`, `corepack yarn build`로 실행한다. 테스트를 위해 관리자 권한이나 개발자 모드를 요구하지 않는다. 폴더 신뢰 테스트의 디렉터리 링크는 Windows에서 junction을 사용하며, Unix Electron의 `SingletonLock` 링크 형식은 Windows 테스트에서 `readlink` 응답으로 모의하고 실제 파일 이동·정리는 그대로 검사한다. 백그라운드 감시 테스트는 한글 경로 확인을 유지하되 임시 폴더 전체를 생성한 상위 경로에서 정리한다. 이는 로컬 Node.js 24.13.0에서 한글 하위 경로를 `rmSync`의 시작 경로로 지정할 때 재현된 네이티브 종료를 피하면서 임시 상위 폴더도 남기지 않기 위한 것이다.
