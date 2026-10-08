const signAdhoc = require("./scripts/sign-adhoc.cjs");

// 플랫폼마다 빼는 것이 달라 mac·win 의 files 에 각각 붙인다. 최상위 files 와 플랫폼 files 를 같이 두면
// electron-builder 가 둘을 따로 맞춰 보는데, 플랫폼 쪽이 빼기만 있으면 "전부 포함" 으로 읽혀 저장소 전체가 실린다.
const files = [
  "out/**/*",
  // Codex SDK 는 codexPathOverride(사용자 설치 CLI)로만 구동하므로 딸려오는
  // 플랫폼 바이너리(@openai/codex-darwin-arm64 등, ~300MB)는 제외한다.
  "!node_modules/@openai/codex-*-*/**",
  // Claude Agent SDK 도 pathToClaudeCodeExecutable(사용자 설치 CLI)로만 구동하므로
  // 딸려오는 플랫폼 바이너리(@anthropic-ai/claude-agent-sdk-darwin-arm64, ~213MB)는 제외한다.
  "!node_modules/@anthropic-ai/claude-agent-sdk-*-*/**",
];

module.exports = {
  appId: "io.github.97kim.sudal",
  productName: "Sudal",
  icon: "build/icon.icns",
  artifactName: "sudal-${version}-${arch}.${ext}",
  directories: { output: "release" },
  // node-pty 의 네이티브 바이너리(pty.node, spawn-helper)는 asar 안에서 실행할 수 없다.
  asarUnpack: ["node_modules/node-pty/**"],
  // `sudal` CLI 와 에이전트용 가이드. Contents/Resources/cli/ 에 그대로 놓인다(앱의 Electron 을 node 로 써서 실행).
  extraResources: [{ from: "cli", to: "cli", filter: ["**/*"] }],
  mac: {
    // GitHub Releases 에 올리는 것은 arm64 DMG 하나뿐이다. Intel 을 받거나 자동 업데이트를 붙이면
    // x64 와 zip(electron-updater 는 zip 으로 받는다)을 다시 추가한다.
    target: [{ target: "dmg", arch: ["arm64"] }],
    category: "public.app-category.developer-tools",
    // macOS 26 은 예전 방식 아이콘(icns)을 자기 모양에 맞춰 다시 그리며 레티나 크기(256px)를 흐리게 만든다.
    // Icon Composer 형식(.icon)을 주면 Assets.car 로 컴파일해 크기마다 원본에서 그린다. 예전 macOS 는 위의 icns 를 쓴다.
    // 컴파일에 Xcode 26 이상의 actool 이 필요하다. 수달 그림(Assets/mark.png)은 .sudal/logo/sudal-mark.svg 를 1024 캔버스에 놓은 것.
    icon: "build/icon.icon",
    // Developer ID 인증서가 없어 ad-hoc 서명만 한다(afterPack). Gatekeeper 는 이걸 거부하므로
    // (spctl -a → rejected) 받는 쪽은 격리 속성을 직접 떼거나 시스템 설정에서 "그래도 열기" 를 눌러야 한다.
    // 예전의 우클릭 → 열기 우회는 macOS 15 Sequoia 에서 없어졌다. Homebrew cask 도 격리를 붙이므로
    // 서명·공증 없이는 brew 로 내도 같은 벽에 막힌다.
    // 인증서를 넣으면 identity 를 지우고(자동 탐지) hardenedRuntime + entitlements(Electron 은 JIT 예외 필요) + notarize 를 켠다.
    identity: null,
    // node-pty 는 프리빌드 4종(darwin-arm64·darwin-x64·win32-arm64·win32-x64)을 함께 담는다.
    // 우리가 내는 것은 arm64 DMG 하나뿐인데 x64 프리빌드가 번들에 들어가면 macOS 가 번들 안의
    // x86_64 Mach-O 를 보고 "Intel 기반 앱 지원 종료" 경고를 띄운다. 쓰지도 않는 것들을 뺀다.
    files: [...files, "!node_modules/node-pty/prebuilds/darwin-x64/**", "!node_modules/node-pty/prebuilds/win32-*/**"],
  },
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    icon: "build/icon.ico",
    // Windows 앱은 GitHub Releases 의 latest.yml 을 읽어 스스로 업데이트한다(electron-updater). 빌드는 --publish never 로 하고
    // 올리기는 scripts/release.sh 가 한다. macOS 는 brew 로 올리므로(src/main/app-update.ts) win 에만 둔다.
    publish: { provider: "github", owner: "97kim", repo: "sudal" },
    // Mac 에서 크로스 빌드할 때는 node-pty 를 win32 용으로 다시 컴파일할 수 없어 동봉된 prebuilds/win32-x64 를 쓴다.
    // npmRebuild 는 플랫폼별로 줄 수 없어 package:win 스크립트가 -c.npmRebuild=false 로 끈다.
    // node-pty 는 build/Release 를 prebuilds 보다 먼저 찾는다 — 예전 macOS 패키징이 남긴 Mac 용 pty.node 가 실리면 로드에 실패한다.
    // pdb(디버그 심볼, ~28MB)도 쓰지 않는다.
    files: [
      ...files,
      "!node_modules/node-pty/build/**",
      "!node_modules/node-pty/prebuilds/darwin-*/**",
      "!node_modules/node-pty/prebuilds/win32-arm64/**",
      "!node_modules/node-pty/prebuilds/**/*.pdb",
    ],
  },
  // 서명이 없어 관리자 권한(UAC) 없이 사용자 폴더(%LOCALAPPDATA%\Programs)에 깐다. 그래야 자동 업데이트도 묻지 않고 덮어쓴다.
  // 마법사 없이 바로 깔고 실행하는 한 번 클릭 설치 — 고를 것이 설치 위치뿐인데 사용자 단위라 바꿀 이유가 적다.
  nsis: {
    oneClick: true,
    perMachine: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    // 지워도 설정·탭 기록(%APPDATA%\Sudal)은 남긴다 — 다시 깔면 이어 쓴다
    deleteAppDataOnUninstall: false,
  },
  afterPack: signAdhoc,
};
