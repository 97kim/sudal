import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { SessionManager } from "./session-manager";
import type { Provider } from "@shared/ipc";

for (const provider of ["claude", "codex", "agy"] as Provider[]) {
  test(`${provider}: task context is supplied at execution without changing user history`, async () => {
    let calls = 0;
    const manager = new SessionManager({
      emit() {}, resolveConfig: () => ({ provider, cwd: tmpdir(), policy: "ask" }),
      taskContext(tabId, cwd) { assert.equal(tabId, "tab"); assert.equal(cwd, tmpdir()); calls++; return "\nTask criteria"; },
      claudeRuntime: async () => { throw new Error("isolated runtime"); },
      codexRuntime: async () => { throw new Error("isolated runtime"); },
      agyRuntime: async () => { throw new Error("isolated runtime"); },
    });
    try {
      await manager.send("tab", "Original user request", [], { type: "user_message", id: "request", ts: 1, text: "Original user request" });
      assert.equal(calls, 1);
      const message = manager.events("tab").find(event => event.type === "user_message");
      assert.equal(message?.type === "user_message" ? message.text : null, "Original user request");
      await new Promise(resolve => setTimeout(resolve, 10));
    } finally { manager.shutdown(); }
  });
}

test("slash commands keep their native argument semantics", async () => {
  let calls = 0;
  const manager = new SessionManager({
    emit() {}, resolveConfig: () => ({ provider: "claude", cwd: tmpdir(), policy: "ask" }),
    taskContext() { calls++; return "context"; },
    claudeRuntime: async () => { throw new Error("isolated runtime"); }, codexRuntime: async () => { throw new Error("unused"); },
  });
  try {
    await manager.send("tab", "/compact", [], { type: "user_message", id: "compact", ts: 1, text: "/compact" });
    assert.equal(calls, 0);
    await new Promise(resolve => setTimeout(resolve, 10));
  } finally { manager.shutdown(); }
});
