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

## 릴리스

로컬에서 빌드해 GitHub Releases 에 올린다. 서명·공증을 하지 않아 CI 로 옮길 이유가 없다.

```bash
yarn release          # 지금 package.json 버전으로
yarn release 0.2.0    # 버전을 올려 커밋하고 릴리스
DRY_RUN=1 yarn release  # 올리지 않고 할 일만 본다
```

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

`scripts/release.sh` 가 순서대로 한다 — main 브랜치이고 작업 트리가 깨끗한지 확인, 타입체크·테스트, `yarn package`,
태그와 푸시, DMG 를 붙인 릴리스 생성. 노트는 지난 태그 이후의 커밋 제목으로 만들고 설치 안내를 덧붙인다.
같은 버전의 태그나 릴리스가 이미 있으면 멈춘다.

새 버전은 설정 → 일반 → 업데이트에서 "업데이트 확인"을 눌러 확인한다. Homebrew로 설치한 앱은 "업데이트"를 누르면 새 버전을 설치하고, 완료 후 "다시 시작"을 누르면 새 버전으로 열린다. `electron-updater`는 사용하지 않는다.
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
SUDAL_APPROVED_ROOTS="$PWD" ../release/mac-arm64/Sudal.app/Contents/MacOS/Sudal \
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
