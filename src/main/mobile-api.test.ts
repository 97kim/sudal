import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import type { ChatEvent } from "@shared/chat-events";
import { MobilePairing } from "./mobile-access";
import { mobileRoutes, mobileStatics, MobileStream, type MobileApiDeps } from "./mobile-api";
import { MobileServer } from "./mobile-server";

async function setup(over: Partial<MobileApiDeps> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sudal-mobile-api-"));
  fs.mkdirSync(path.join(dir, "page", "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "page", "mobile.html"), "<p>mobile</p>");
  fs.writeFileSync(path.join(dir, "page", "assets", "app-1.js"), "console.log(1)");
  fs.writeFileSync(path.join(dir, "secret.txt"), "secret");
  const sent: string[] = [];
  const answered: string[] = [];
  const deps: MobileApiDeps = {
    tabs: () => [{ id: "t1", title: "일", workspace: "w", cwd: "/w", provider: "claude", status: "idle", waiting: false }],
    events: (id) => (id === "t1" ? ([{ type: "user", ts: 1, text: "안녕" }] as unknown as ChatEvent[]) : null),
    send: async (id, text) => (sent.push(`${id}:${text}`), { ok: true }),
    abort: () => {},
    answer: (id, req, allow) => (answered.push(`${id}:${req}:${allow}`), req === "r1"),
    ...over,
  };
  const stream = new MobileStream();
  const pairing = new MobilePairing(path.join(dir, "devices.json"));
  const server = new MobileServer({ pairing, routes: mobileRoutes(deps, stream), statics: mobileStatics(path.join(dir, "page"), () => "ko"), trusted: (ip) => /127\.0\.0\.1$/.test(ip) });
  await server.start(["127.0.0.1"], 0);
  const base = `http://${server.addresses[0]}`;
  const { code } = pairing.newCode();
  const r = await fetch(base + "/api/pair", { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ code }) });
  const paired = (await r.json()) as { token: string; device: { id: string } };
  const auth = { authorization: `Bearer ${paired.token}` };
  const deviceId = paired.device.id;
  const post = (p: string, body: unknown) => fetch(base + p, { method: "POST", headers: { origin: base, "content-type": "application/json", ...auth }, body: JSON.stringify(body) });
  const get = (p: string) => fetch(base + p, { headers: auth });
  return { dir, server, stream, base, get, post, sent, answered, auth, deviceId };
}

test("mobile API: 화면 파일·탭·이벤트·보내기·권한, 경로 거슬러 오르기는 막는다", async () => {
  const s = await setup();
  try {
    assert.equal(await (await fetch(s.base + "/")).text(), "<p>mobile</p>", "화면은 토큰 없이도 받는다");
    assert.deepEqual(await (await fetch(s.base + "/app-info")).json(), { language: "ko" });
    assert.match((await s.get("/")).headers.get("content-security-policy") ?? "", /script-src 'self'/);
    assert.equal(await (await s.get("/assets/app-1.js")).text(), "console.log(1)");
    assert.equal((await s.get("/assets/../secret.txt")).status, 404);
    assert.equal((await s.get("/assets/%2e%2e%2fsecret.txt")).status, 404);
    assert.deepEqual(((await (await s.get("/api/tabs")).json()) as { tabs: { id: string }[] }).tabs.map((t) => t.id), ["t1"]);
    assert.equal(((await (await s.get("/api/tabs/t1/events")).json()) as { events: unknown[] }).events.length, 1);
    assert.equal((await s.get("/api/tabs/nope/events")).status, 404);
    assert.equal((await s.post("/api/tabs/t1/send", { text: "  해 줘 " })).status, 200);
    assert.deepEqual(s.sent, ["t1:해 줘"]);
    assert.equal((await s.post("/api/tabs/t1/send", { text: "   " })).status, 400);
    assert.equal((await s.post("/api/tabs/t1/permission", { requestId: "r1", allow: true })).status, 200);
    assert.equal((await s.post("/api/tabs/t1/permission", { requestId: "old", allow: false })).status, 409, "이미 끝난 요청은 409");
    assert.equal((await s.post("/api/tabs/t1/permission", { requestId: "r1", allow: "yes" })).status, 400);
  } finally {
    await s.server.stop();
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test("mobile API: 스트림은 앱 이벤트를 흘려보내고, 토큰 없이는 열 수 없다", async () => {
  const s = await setup();
  const ctrl = new AbortController();
  try {
    assert.equal((await fetch(s.base + "/api/stream")).status, 401);
    const res = await fetch(s.base + "/api/stream", { headers: s.auth, signal: ctrl.signal });
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let got = "";
    // 구독이 붙은 뒤에 보낸다
    for (let i = 0; i < 50 && s.stream.size === 0; i++) await new Promise((r) => setTimeout(r, 10));
    s.stream.send("chat", { tabId: "t1", event: { type: "text", ts: 2, text: "답" } });
    while (!got.includes("event: chat")) got += dec.decode((await reader.read()).value);
    assert.match(got, /"tabId":"t1"/);
    // 기기를 끊으면 열린 스트림도 닫힌다
    s.stream.closeDevice(s.deviceId);
    let ended = false;
    // 끊긴 기기의 연결은 바로 끊으므로 읽기가 정상 종료 대신 오류로 끝날 수도 있다 — 둘 다 닫힌 것이다
    for (let i = 0; i < 20 && !ended; i++) ended = await reader.read().then((r) => r.done, () => true);
    assert.equal(ended, true);
  } finally {
    ctrl.abort();
    await s.server.stop();
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

/** 스트림 단위 시험용 가짜 응답. 쓴 글·닫힘·쌓인 바이트만 흉내 낸다. */
function fakeRes() {
  const r = Object.assign(new EventEmitter(), {
    status: 0,
    chunks: [] as string[],
    destroyed: false,
    writableLength: 0,
    writeHead(s: number) {
      r.status = s;
      return r;
    },
    write(c: string) {
      r.chunks.push(c);
      return true;
    },
    end(c?: string) {
      if (c) r.chunks.push(c);
      r.destroy();
    },
    destroy() {
      if (r.destroyed) return;
      r.destroyed = true;
      r.emit("close");
    },
  });
  return r;
}
type FakeRes = ReturnType<typeof fakeRes>;
const asRes = (r: FakeRes) => r as unknown as http.ServerResponse;

test("MobileStream: 등록에서 빠진 기기·읽지 않고 쌓인 연결은 닫고, 연결 수를 묶는다", () => {
  const alive = new Set(["a", "b"]);
  const stream = new MobileStream((id) => alive.has(id));
  try {
    const a = fakeRes();
    const b = fakeRes();
    stream.add(asRes(a), "a");
    stream.add(asRes(b), "b");
    // 새 기기에 밀려 a 가 목록에서 빠지면, 다음 이벤트부터 a 는 받지 못하고 닫힌다
    alive.delete("a");
    stream.send("chat", { x: 1 });
    assert.equal(a.destroyed, true);
    assert.equal(a.chunks.some((c) => c.includes("event: chat")), false);
    assert.equal(b.chunks.some((c) => c.includes("event: chat")), true);
    // prune 은 이벤트를 기다리지 않고 바로 닫는다
    const b2 = fakeRes();
    stream.add(asRes(b2), "b");
    alive.delete("b");
    stream.prune();
    assert.equal(b.destroyed && b2.destroyed, true);
    assert.equal(stream.size, 0);

    // 기기 하나는 3개까지 — 넷째가 오면 가장 오래된 것을 닫는다
    alive.add("c");
    const cs = [fakeRes(), fakeRes(), fakeRes(), fakeRes()];
    for (const c of cs) stream.add(asRes(c), "c");
    assert.deepEqual(cs.map((c) => c.destroyed), [true, false, false, false]);
    assert.equal(cs[0].chunks.at(-1), "event: replaced\ndata: null\n\n", "밀려난 페이지에는 replaced 를 알린다");
    // 읽지 않아 1MB 넘게 쌓인 연결은 끊는다
    cs[1].writableLength = 2 * 1024 * 1024;
    stream.send("chat", {});
    assert.equal(cs[1].destroyed, true);
    assert.equal(cs[2].destroyed, false);

    // 전체 12개를 넘으면 새 연결은 503
    stream.closeAll();
    for (let i = 0; i < 12; i++) {
      alive.add(`d${i}`);
      stream.add(asRes(fakeRes()), `d${i}`);
    }
    alive.add("late");
    const late = fakeRes();
    stream.add(asRes(late), "late");
    assert.equal(late.status, 503);
    assert.equal(stream.size, 12);
  } finally {
    stream.closeAll();
  }
});
