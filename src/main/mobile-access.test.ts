import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isTailscaleAddress, MobilePairing, parseTailscaleSelf, tailscaleAddresses } from "./mobile-access";

test("isTailscaleAddress: 100.64.0.0/10 과 fd7a:115c:a1e0::/48 만", () => {
  for (const ip of ["100.64.0.1", "100.101.2.3", "100.127.255.255", "::ffff:100.100.1.1", "fd7a:115c:a1e0::1", "FD7A:115C:A1E0:ab12::5"]) assert.equal(isTailscaleAddress(ip), true, ip);
  for (const ip of ["100.63.0.1", "100.128.0.1", "192.168.0.10", "127.0.0.1", "::1", "fd7a:115c:a1e1::1", "10.0.0.1"]) assert.equal(isTailscaleAddress(ip), false, ip);
});

test("tailscaleAddresses: Tailscale 주소만, IPv4 먼저, 겹치지 않게", () => {
  const ifaces = {
    lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    en0: [{ address: "192.168.0.5", family: "IPv4", internal: false }],
    utun4: [
      { address: "fd7a:115c:a1e0::aa", family: "IPv6", internal: false },
      { address: "100.90.1.2", family: "IPv4", internal: false },
    ],
  };
  assert.deepEqual(tailscaleAddresses(ifaces), ["100.90.1.2", "fd7a:115c:a1e0::aa"]);
});

test("MobilePairing: 코드로 짝짓고 토큰은 해시로만 저장, 코드는 한 번·5분·5번 틀리면 끝", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sudal-mobile-"));
  try {
    let t = 1_000_000;
    const file = path.join(dir, "mobile-devices.json");
    const p = new MobilePairing(file, () => t);
    assert.equal(p.pair("123456", "x"), null, "코드 없이는 안 된다");
    const { code } = p.newCode();
    assert.match(code, /^\d{6}$/);
    const wrong = code === "000000" ? "111111" : "000000";
    assert.equal(p.pair(wrong, "x"), null);
    const r = p.pair(code, "  내 아이폰  ");
    assert.ok(r);
    assert.equal(r.device.name, "내 아이폰");
    assert.equal(p.pair(code, "다시"), null, "코드는 한 번만");
    const saved = fs.readFileSync(file, "utf8");
    assert.equal(saved.includes(r.token), false, "토큰 자체는 저장하지 않는다");
    assert.equal((fs.statSync(file).mode & 0o777).toString(8), "600");
    assert.equal(new MobilePairing(file, () => t).verify(r.token)?.id, r.device.id, "다시 읽어도 알아본다");
    assert.equal(p.verify("엉뚱한 토큰"), null);
    assert.equal(p.verify(undefined), null);

    // 5분이 지나면 무효
    const c2 = p.newCode().code;
    t += 5 * 60_000;
    assert.equal(p.activeCode(), null);
    assert.equal(p.pair(c2, "x"), null);

    // 다섯 번 틀리면 맞는 코드도 무효
    const c3 = p.newCode().code;
    const bad = c3 === "999999" ? "888888" : "999999";
    for (let i = 0; i < 5; i++) p.pair(bad, "x");
    assert.equal(p.pair(c3, "x"), null);

    assert.equal(p.revoke(r.device.id), true);
    assert.equal(p.verify(r.token), null, "끊은 기기는 못 들어온다");
    assert.deepEqual(p.list(), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseTailscaleSelf: Tailscale 이 이 기기 주소라고 한 것만", () => {
  assert.deepEqual(parseTailscaleSelf(JSON.stringify({ Self: { TailscaleIPs: ["100.91.91.125", "fd7a:115c:a1e0::1", "10.0.0.1"] } })), ["100.91.91.125", "fd7a:115c:a1e0::1"]);
  assert.deepEqual(parseTailscaleSelf("Warning: version mismatch"), []);
  assert.deepEqual(parseTailscaleSelf(JSON.stringify({ BackendState: "Stopped" })), []);
});

test("MobilePairing: 넓은 권한으로 남아 있던 기기 파일은 0600 으로 좁힌다", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sudal-mobile-perm-"));
  try {
    const file = path.join(dir, "d.json");
    fs.writeFileSync(file, "[]", { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    new MobilePairing(file);
    assert.equal((fs.statSync(file).mode & 0o777).toString(8), "600");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
