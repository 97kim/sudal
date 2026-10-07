const signAdhoc = require("./scripts/sign-adhoc.cjs");


module.exports = {
  appId: "io.github.97kim.sudal",
  productName: "Sudal",
  icon: "build/icon.icns",
  artifactName: "sudal-${version}-${arch}.${ext}",
  directories: { output: "release" },
  // node-pty 의 네이티브 바이너리(pty.node, spawn-helper)는 asar 안에서 실행할 수 없다.
  asarUnpack: ["node_modules/node-pty/**"],
  files: [
    "out/**/*",
    // Codex SDK 는 codexPathOverride(사용자 설치 CLI)로만 구동하므로 딸려오는
    // 플랫폼 바이너리(@openai/codex-darwin-arm64 등, ~300MB)는 제외한다.
    "!node_modules/@openai/codex-*-*/**",
    // Claude Agent SDK 도 pathToClaudeCodeExecutable(사용자 설치 CLI)로만 구동하므로
    // 딸려오는 플랫폼 바이너리(@anthropic-ai/claude-agent-sdk-darwin-arm64, ~213MB)는 제외한다.
    "!node_modules/@anthropic-ai/claude-agent-sdk-*-*/**",
    // node-pty 는 프리빌드 4종(darwin-arm64·darwin-x64·win32-arm64·win32-x64)을 함께 담는다.
    // 우리가 내는 것은 arm64 DMG 하나뿐인데 x64 프리빌드가 번들에 들어가면 macOS 가 번들 안의
    // x86_64 Mach-O 를 보고 "Intel 기반 앱 지원 종료" 경고를 띄운다. 쓰지도 않는 것들을 뺀다.
    "!node_modules/node-pty/prebuilds/darwin-x64/**",
    "!node_modules/node-pty/prebuilds/win32-*/**",
  ],
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
  },
  afterPack: signAdhoc,
};
