const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

module.exports = async function signAdhoc(context) {
  if (context.electronPlatformName !== "darwin") return;

  const productFilename = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${productFilename}.app`);

  // 패키징 때 이 Mac 에서 다시 컴파일한 node-pty 는 디버그 심볼에 빌드 경로(/Users/<이름>/...)를 품는다.
  // 공개 DMG 에 개인 경로가 실리지 않게 서명 전에 디버그 심볼만 지운다(전역 심볼은 남아 로드에 지장 없다).
  const ptyDir = path.join(appPath, "Contents/Resources/app.asar.unpacked/node_modules/node-pty");
  const natives = execFileSync("find", [ptyDir, "-type", "f", "(", "-name", "*.node", "-o", "-name", "spawn-helper", ")"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  if (natives.length > 0) execFileSync("strip", ["-S", ...natives], { stdio: "inherit" });

  // mac.icon 에 .icon 을 주면 electron-builder 가 actool 이 만든 icns 를 넣는데, 그건 256px 이상이 없어
  // macOS 15 이하의 큰 아이콘이 흐리다. 예전 macOS 용은 크기를 다 갖춘 우리 icns 로 바꾼다(서명 전에).
  fs.copyFileSync(path.join(context.packager.projectDir, "build/icon.icns"), path.join(appPath, "Contents/Resources/icon.icns"));

  execFileSync(
    "codesign",
    ["--force", "--deep", "--sign", "-", "--timestamp=none", appPath],
    { stdio: "inherit" }
  );

  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], {
    stdio: "inherit",
  });
};
