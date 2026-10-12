import test from "node:test";
import assert from "node:assert/strict";
import { BackgroundTaskRegistry } from "./bg-tasks";

const task = (id: string, type = "shell", description = "설명", toolUseId?: string) => ({ id, type, description, ...(toolUseId ? { toolUseId } : {}) });

test("전체 집합을 갈아 끼운다 — 빠진 것은 사라지고 남은 것은 시작 시각을 지킨다", async () => {
  const r = new BackgroundTaskRegistry();
  r.replace("탭1", "sess-1", "/repo", [task("a"), task("b")]);
  const first = r.current();
  assert.deepEqual(first.map((j) => j.id).sort(), ["a", "b"]);
  const startedA = first.find((j) => j.id === "a")!.startedAt;

  await new Promise((res) => setTimeout(res, 12));
  r.replace("탭1", "sess-1", "/repo", [task("a")]);
  const second = r.current();
  assert.deepEqual(second.map((j) => j.id), ["a"]);
  // 계속 돌던 작업의 "경과 시간" 이 갱신될 때마다 0 으로 돌아가면 안 된다
  assert.equal(second[0].startedAt, startedA);

  r.replace("탭1", "sess-1", "/repo", []);
  assert.deepEqual(r.current(), []);
});

test("탭이 달라도 작업 id 가 같으면 서로 덮어쓰지 않는다", () => {
  const r = new BackgroundTaskRegistry();
  r.replace("탭1", "sess-1", "/repo1", [task("같은id", "shell", "첫째")]);
  r.replace("탭2", "sess-2", "/repo2", [task("같은id", "shell", "둘째")]);
  const all = r.current();
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((j) => j.sessionId).sort(), ["sess-1", "sess-2"]);
  assert.deepEqual(all.map((j) => j.summary).sort(), ["둘째", "첫째"]);
});

test("프로세스가 내려가면 그 탭의 작업만 비운다", () => {
  const r = new BackgroundTaskRegistry();
  r.replace("탭1", "sess-1", "/repo1", [task("a")]);
  r.replace("탭2", "sess-2", "/repo2", [task("b")]);
  r.clear("탭1");
  assert.deepEqual(r.current().map((j) => j.id), ["b"]);
});

test("끝났다는 알림이 늦게 와도 이름을 찾을 수 있다", () => {
  const r = new BackgroundTaskRegistry();
  r.replace("탭1", "sess-1", "/repo", [task("a", "shell", "빌드한다")]);
  // 목록에서 먼저 빠지고 알림이 뒤에 오는 순서(SDK 가 순서를 보장하지 않는다)
  r.replace("탭1", "sess-1", "/repo", []);
  assert.equal(r.current().length, 0);
  assert.equal(r.recall("a")?.summary, "빌드한다");
  assert.equal(r.recall("없는id"), null);
});

test("화면이 쓰는 모양으로 내준다", () => {
  const r = new BackgroundTaskRegistry();
  r.replace("탭1", "sess-1", "/repo", [task("a", "subagent", "  긴  설명 ")]);
  const j = r.current()[0];
  assert.equal(j.label, "하위 에이전트");
  assert.equal(j.summary, "긴 설명");
  assert.equal(j.status, "running");
  assert.equal(j.completedAt, null);
  assert.equal(j.root, "/repo");
});

test("tool_use_id 가 있으면 넘기고, 없으면 필드 자체를 안 둔다", () => {
  const r = new BackgroundTaskRegistry();
  r.replace("탭1", "sess-1", "/repo", [task("a", "shell", "설명", "toolu_1"), task("b")]);
  const [a, b] = r.current();
  assert.equal(a.toolUseId, "toolu_1");
  assert.equal(b.toolUseId, undefined);
});
