import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { MobilePairing } from "./mobile-access";
import { json, MobileServer } from "./mobile-server";

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sudal-mobile-srv-"));
  const pairing = new MobilePairing(path.join(dir, "devices.json"));
  let release: () => void = () => {};
  const server = new MobileServer({
    pairing,
    statics: ({ path: p, res }) => {
      if (p !== "/") return false;
      res.end("<p>app</p>");
      return true;
    },
    routes: async (r) => {
      if (r.path === "/api/echo") {
        json(r.res, 200, { device: r.device.id, body: r.body });
        return true;
      }
      return false;
    },
    trusted: (ip) => ip === "127.0.0.1" || ip === "::ffff:127.0.0.1",
  });
  await server.start(["127.0.0.1", "192.168.0.9"], 0);
  const base = `http://${server.addresses[0]}`;
  return { dir, pairing, server, base, release };
}

test("MobileServer: 화면은 공개, API 는 토큰, 다른 Host·출처는 막는다", async () => {
  const { dir, pairing, server, base } = await setup();
  try {
    assert.equal(server.addresses.length, 1, "믿는 주소에만 연다");
    assert.equal(await (await fetch(base + "/")).text(), "<p>app</p>");
    assert.equal((await fetch(base + "/api/me")).status, 401);

    const json = { origin: base, "content-type": "application/json" };
    const { code } = pairing.newCode();
    assert.equal((await fetch(base + "/api/pair", { method: "POST", headers: json, body: JSON.stringify({ code: "x" }) })).status, 401);
    assert.equal((await fetch(base + "/api/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) })).status, 403, "출처 없는 POST");
    const ok = await fetch(base + "/api/pair", { method: "POST", headers: json, body: JSON.stringify({ code, name: "폰" }) });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("set-cookie"), null, "쿠키를 쓰지 않는다");
    const { token } = (await ok.json()) as { token: string };
    const auth = { authorization: `Bearer ${token}` };

    const me = (await (await fetch(base + "/api/me", { headers: auth })).json()) as { device: { name: string } };
    assert.equal(me.device.name, "폰");
    const echo = (await (await fetch(base + "/api/echo", { method: "POST", headers: { ...json, ...auth }, body: JSON.stringify({ a: 1 }) })).json()) as { body: unknown };
    assert.deepEqual(echo.body, { a: 1 });
    assert.equal((await fetch(base + "/api/echo", { method: "POST", headers: { origin: "http://evil.example", "content-type": "application/json", ...auth }, body: "{}" })).status, 403);
    assert.equal((await fetch(base + "/api/nope", { headers: auth })).status, 404);

    // Host 가 이 서버 주소가 아니면(DNS 리바인딩) 막는다
    const port = Number(base.split(":").pop());
    const status = await new Promise<number>((resolve) => {
      http.get({ host: "127.0.0.1", port, path: "/", headers: { host: `evil.example:${port}` } }, (r) => resolve(r.statusCode ?? 0));
    });
    assert.equal(status, 403);

    pairing.revoke(pairing.list()[0].id);
    assert.equal((await fetch(base + "/api/me", { headers: auth })).status, 401, "끊으면 바로 못 들어온다");
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MobileServer: 본문을 받는 사이 기기를 끊으면 실행하지 않는다", async () => {
  const { dir, pairing, server, base } = await setup();
  try {
    const { code } = pairing.newCode();
    const r = await fetch(base + "/api/pair", { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ code }) });
    const { token, device } = (await r.json()) as { token: string; device: { id: string } };
    const port = Number(base.split(":").pop());
    const status = await new Promise<number>((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/api/echo", headers: { origin: base, "content-type": "application/json", authorization: `Bearer ${token}` } }, (res) => resolve(res.statusCode ?? 0));
      req.write('{"a":');
      setTimeout(() => {
        pairing.revoke(device.id);
        req.end("1}");
      }, 100);
    });
    assert.equal(status, 401);
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MobilePairing: 코드를 새로 만들어도 10분에 10번 넘게 틀리면 잠근다", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sudal-mobile-lock-"));
  try {
    let t = 0;
    const p = new MobilePairing(path.join(dir, "d.json"), () => t);
    for (let i = 0; i < 10; i++) {
      const { code } = p.newCode();
      p.pair(code === "000000" ? "111111" : "000000", "");
    }
    assert.equal(p.locked(), true);
    const { code } = p.newCode();
    assert.equal(p.pair(code, ""), null, "잠기면 맞는 코드도 안 된다");
    t += 10 * 60_000;
    const c2 = p.newCode().code;
    assert.ok(p.pair(c2, ""), "10분 뒤엔 풀린다");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
