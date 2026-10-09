import { test } from "node:test";
import assert from "node:assert/strict";
import type { Provider } from "@shared/ipc";
import { emptyModel } from "@shared/workspace-model";
import { Store } from "./persistence";
import { WorkspaceService } from "./workspaces";

function service(available: readonly Provider[]) {
  const store = new Store("unused");
  store.loadModel = () => emptyModel();
  store.saveModel = () => {};
  store.deleteThread = () => {};
  const ws = new WorkspaceService(store, () => {});
  ws.availableProviders = available;
  return ws;
}

for (const provider of ["claude", "codex"] as const) {
  test(`only ${provider}: workspace and tab defaults use the installed CLI`, () => {
    const ws = service([provider]);
    const named = ws.createWorkspace("named");
    assert.equal(ws.tab(named.tabId)?.provider, provider);
    const folder = ws.addWorkspace("/repo");
    assert.equal(ws.tab(folder.tabId)?.provider, provider);
    assert.equal(ws.tab(ws.createTab(folder.workspaceId)!)?.provider, provider);
    ws.closeTab(named.tabId);
    ws.closeTab(ws.state().model.activeTabId!);
    ws.closeTab(folder.tabId);
    assert.equal(ws.tab(ws.createTab(named.workspaceId)!)?.provider, provider);
  });

  test(`only ${provider}: unavailable inherited CLI does not carry its model`, () => {
    const ws = service([]);
    const { workspaceId, tabId } = ws.createWorkspace("existing");
    const other = provider === "codex" ? "claude" : "codex";
    ws.onMeta(tabId, { provider: other, model: "other-model", sessionId: "existing-session", policy: "ask" });
    ws.availableProviders = [provider];
    const created = ws.tab(ws.createTab(workspaceId)!)!;
    assert.equal(created.provider, provider);
    assert.equal(created.model, undefined);
    assert.equal(created.policy, "ask");
    assert.equal(ws.tab(tabId)?.provider, other);
    assert.equal(ws.tab(tabId)?.sessionId, "existing-session");
  });
}

for (const available of [[], ["claude", "codex"]] as const) {
  test(`${available.length} installed: retain default and active CLI/model inheritance`, () => {
    const ws = service(available);
    const { workspaceId, tabId } = ws.createWorkspace("both-or-neither");
    assert.equal(ws.tab(tabId)?.provider, "claude");
    ws.onMeta(tabId, { provider: "codex", model: "codex-model" });
    const next = ws.tab(ws.createTab(workspaceId)!)!;
    assert.equal(next.provider, "codex");
    assert.equal(next.model, "codex-model");
  });
}

test("a rescan changes defaults for subsequent tabs and retains models for the same CLI", () => {
  const ws = service(["codex"]);
  const { workspaceId, tabId } = ws.createWorkspace("rescan");
  ws.onMeta(tabId, { model: "codex-model" });
  assert.equal(ws.tab(ws.createTab(workspaceId)!)?.model, "codex-model");
  ws.availableProviders = ["claude"];
  const next = ws.tab(ws.createTab(workspaceId)!)!;
  assert.equal(next.provider, "claude");
  assert.equal(next.model, undefined);
});
