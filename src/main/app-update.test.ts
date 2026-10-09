import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brewUpgrade, caskVersion, downloadProgress, runBrew, compareVersions, fetchLatestRelease, versionOfDownload, type UpdateProgress } from "./app-update";

// Homebrew 업그레이드는 macOS 에서만 쓴다(Windows 는 winDownloadUpdate). 가짜 brew 도 sh 스크립트·POSIX 신호에 기댄다.
const MAC_ONLY = process.platform === "win32" && "Homebrew 업그레이드는 macOS 전용";

test("버전은 자리마다 숫자로 비교한다", () => {
  assert.ok(compareVersions("0.9.30", "0.9.29") > 0);
  assert.ok(compareVersions("0.10.0", "0.9.99") > 0);
  assert.ok(compareVersions("0.9.29", "1.0.0") < 0);
  assert.equal(compareVersions("v0.9.29", "0.9.29"), 0);
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
});

const fakeFetch = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

test("최신 릴리즈 태그에서 v 를 떼고 페이지 주소를 함께 준다", async () => {
  const r = await fetchLatestRelease(fakeFetch(200, { tag_name: "v0.9.30", html_url: "https://github.com/97kim/sudal/releases/tag/v0.9.30" }));
  assert.deepEqual(r, { version: "0.9.30", url: "https://github.com/97kim/sudal/releases/tag/v0.9.30" });
});

test("응답이 실패이거나 태그가 없으면 오류", async () => {
  await assert.rejects(fetchLatestRelease(fakeFetch(404, {})), /404/);
  await assert.rejects(fetchLatestRelease(fakeFetch(200, { name: "x" })), /버전/);
});

/** PATH 맨 앞에 가짜 brew 를 둔다. list 는 installed 버전을 답하고, 나머지 명령은 성공한다. */
function fakeBrewEnv(installed: string | null): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "fake-brew-"));
  const list = installed ? `echo "sudal ${installed}"` : "exit 1";
  writeFileSync(join(dir, "brew"), `#!/bin/sh\nif [ "$1" = list ]; then ${list}; fi\nexit 0\n`);
  chmodSync(join(dir, "brew"), 0o755);
  // 캐시도 가짜 폴더로 — 진행률을 재려고 실제 Homebrew 캐시를 읽지 않게
  return { ...process.env, PATH: `${dir}:${process.env.PATH}`, HOMEBREW_CACHE: join(dir, "cache") };
}

test("brew upgrade 가 성공해도 설치 버전이 목표에 못 미치면 실패", { skip: MAC_ONLY }, async () => {
  const r = await brewUpgrade(fakeBrewEnv("0.9.29"), "0.9.30");
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.error : "", /0\.9\.30.*0\.9\.29/);
});

test("목표 버전에 닿으면 설치 버전을 돌려준다", { skip: MAC_ONLY }, async () => {
  assert.deepEqual(await brewUpgrade(fakeBrewEnv("0.9.30"), "0.9.30"), { ok: true, version: "0.9.30" });
});

test("cask 로 설치하지 않았으면 caskVersion 은 null", { skip: MAC_ONLY }, async () => {
  assert.equal(await caskVersion(fakeBrewEnv(null)), null);
});

test("시간 초과면 다른 프로세스 그룹의 자손까지 끝낸 뒤 돌려준다", { skip: MAC_ONLY }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "fake-brew-"));
  // set -m: 백그라운드 작업이 자기 프로세스 그룹을 갖는다(Homebrew 의 pgroup: true 와 같은 상황)
  writeFileSync(join(dir, "brew"), "#!/bin/sh\nset -m\nsleep 30 &\necho $!\nwait\n");
  chmodSync(join(dir, "brew"), 0o755);
  const r = await runBrew([], { ...process.env, PATH: `${dir}:${process.env.PATH}` }, 1500, 300);
  assert.equal(r.code, null);
  assert.match(r.out, /시간 초과/);
  const pid = Number(r.out.trim().split("\n")[0]);
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), "자손 sleep 이 남아 있다");
});

test("TERM 을 무시하는 자손이 있으면 KILL 로 끝낸 뒤 돌려준다", { skip: MAC_ONLY }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "fake-brew-"));
  // 자손은 별도 그룹 + TERM 무시 + 출력 파이프를 물지 않는다 → brew 만 먼저 끝나 close 가 온다
  writeFileSync(join(dir, "brew"), "#!/bin/sh\nset -m\nsh -c 'trap \"\" TERM; exec sleep 30' >/dev/null 2>&1 &\necho $!\nwait\n");
  chmodSync(join(dir, "brew"), 0o755);
  const r = await runBrew([], { ...process.env, PATH: `${dir}:${process.env.PATH}` }, 1500, 300);
  assert.equal(r.code, null);
  const pid = Number(r.out.trim().split("\n")[0]);
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), "TERM 을 무시한 자손이 남아 있다");
});

/** 가짜 brew 를 시간 초과로 끊고, 출력 첫 줄의 pid 가 반환 시점에 남아 있지 않은지 본다. */
async function assertCleanedUp(script: string) {
  const dir = mkdtempSync(join(tmpdir(), "fake-brew-"));
  writeFileSync(join(dir, "brew"), `#!/bin/sh\n${script}\n`);
  chmodSync(join(dir, "brew"), 0o755);
  const r = await runBrew([], { ...process.env, PATH: `${dir}:${process.env.PATH}` }, 1500, 300);
  assert.equal(r.code, null);
  const pid = Number(r.out.trim().split("\n")[0]);
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), "남은 프로세스가 있다");
}

test("brew 자신이 TERM 을 무시해 close 가 오지 않아도 KILL 로 끝내고 돌려준다", { skip: MAC_ONLY }, () =>
  assertCleanedUp("trap '' TERM\necho $$\nsleep 30"));

test("TERM 을 무시하는 자손이 출력 파이프를 물고 있어도 KILL 로 끝내고 돌려준다", { skip: MAC_ONLY }, () =>
  assertCleanedUp("set -m\nsh -c 'trap \"\" TERM; exec sleep 30' &\necho $!\nwait"));

test("릴리즈에 붙은 DMG 의 크기를 함께 준다(진행률의 분모)", async () => {
  const r = await fetchLatestRelease(
    fakeFetch(200, { tag_name: "v0.9.30", html_url: "u", assets: [{ name: "sudal-0.9.30-arm64.dmg.blockmap", size: 10 }, { name: "sudal-0.9.30-arm64.dmg", size: 143_000_000 }] }),
  );
  assert.equal(r.dmgSize, 143_000_000);
});

test("내려받는 중인 캐시 파일로 단계와 진행률을 정한다", () => {
  const dir = mkdtempSync(join(tmpdir(), "brew-dl-"));
  const file = join(dir, "bbb--sudal-0.9.30-arm64.dmg");
  assert.equal(versionOfDownload(file), "0.9.30");
  assert.equal(versionOfDownload(join(dir, "something-else.dmg")), null);
  assert.equal(downloadProgress(file, 1000), null, "아직 받기 전");
  // 이름이 같아도 다른 해시의 남은 파일은 보지 않는다 — brew 가 알려 준 경로만 본다
  writeFileSync(join(dir, "zzz--sudal-0.9.30-arm64.dmg.incomplete"), Buffer.alloc(900));
  assert.equal(downloadProgress(file, 1000), null);
  writeFileSync(`${file}.incomplete`, Buffer.alloc(430));
  assert.deepEqual(downloadProgress(file, 1000), { phase: "downloading", percent: 43 });
  assert.deepEqual(downloadProgress(file), { phase: "downloading" }, "크기를 모르면 퍼센트 없이");
  writeFileSync(`${file}.incomplete`, Buffer.alloc(1000));
  assert.deepEqual(downloadProgress(file, 1000), { phase: "downloading", percent: 99 }, "받는 동안에는 100 을 넘기지 않는다");
  renameSync(`${file}.incomplete`, file);
  assert.deepEqual(downloadProgress(file, 1000), { phase: "installing" });
  // 체크섬이 틀려 다시 받으면 내려받기로 돌아간다
  writeFileSync(`${file}.incomplete`, Buffer.alloc(100));
  assert.deepEqual(downloadProgress(file, 1000), { phase: "downloading", percent: 10 });
});

/** upgrade 때 version 의 DMG 를 반쯤 받다가 다 받은 이름으로 바꾸는 가짜 brew. `--cache --cask` 는 그 파일 경로를 답한다. */
function fakeDownloadingBrew(version: string): { env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), "fake-brew-"));
  const downloads = join(dir, "cache", "downloads");
  mkdirSync(downloads, { recursive: true });
  const f = join(downloads, `ccc--sudal-${version}-arm64.dmg`);
  writeFileSync(
    join(dir, "brew"),
    `#!/bin/sh\nif [ "$1" = list ]; then echo "sudal ${version}"; fi\nif [ "$1" = --cache ]; then echo "${f}"; fi\nif [ "$1" = upgrade ]; then head -c 500 /dev/zero > "${f}.incomplete"; sleep 0.4; mv "${f}.incomplete" "${f}"; sleep 0.4; fi\nexit 0\n`,
  );
  chmodSync(join(dir, "brew"), 0o755);
  return { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } };
}

test("업그레이드하는 동안 확인 → 내려받기(%) → 설치 순서로 알린다", { skip: MAC_ONLY }, async () => {
  const seen: UpdateProgress[] = [];
  const r = await brewUpgrade(fakeDownloadingBrew("0.9.30").env, "0.9.30", { dmgSize: 1000, pollMs: 50, onProgress: (p) => seen.push(p) });
  assert.deepEqual(r, { ok: true, version: "0.9.30" });
  assert.deepEqual(seen, [{ phase: "checking" }, { phase: "downloading", percent: 50 }, { phase: "installing" }]);
});

test("확인한 뒤 더 새 버전이 올라와 brew 가 그것을 받으면, 크기가 맞지 않으니 퍼센트 없이 단계만 알린다", { skip: MAC_ONLY }, async () => {
  const seen: UpdateProgress[] = [];
  const r = await brewUpgrade(fakeDownloadingBrew("0.9.31").env, "0.9.30", { dmgSize: 1000, pollMs: 50, onProgress: (p) => seen.push(p) });
  assert.deepEqual(r, { ok: true, version: "0.9.31" });
  assert.deepEqual(seen, [{ phase: "checking" }, { phase: "downloading" }, { phase: "installing" }]);
});

test("brew 가 캐시 경로를 주지 않으면 퍼센트 없이 내려받는 중으로만 알린다", { skip: MAC_ONLY }, async () => {
  const seen: UpdateProgress[] = [];
  const r = await brewUpgrade(fakeBrewEnv("0.9.30"), "0.9.30", { dmgSize: 1000, pollMs: 50, onProgress: (p) => seen.push(p) });
  assert.equal(r.ok, true);
  assert.deepEqual(seen, [{ phase: "checking" }, { phase: "downloading" }]);
});
