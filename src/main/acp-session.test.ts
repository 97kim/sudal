import { test } from "node:test";
import assert from "node:assert/strict";
import { acpCapabilities, acpConfigValues, acpSelectOptions, acpSlashCommands } from "./acp-session";

test("ACP 현재 설정은 그룹 선택지의 표시명과 실제 값을 구분한다", () => {
  assert.deepEqual(acpConfigValues([{ id: "collaboration_mode", name: "Collaboration", type: "select", currentValue: "plan", options: [{ group: "mode", name: "Mode", options: [{ value: "plan", name: "Plan" }] }] }]), [
    { id: "collaboration_mode", name: "Collaboration", value: "plan", label: "Plan" },
  ]);
});

test("ACP 슬래시 목록은 설명·인자 힌트와 최신 정의를 보존한다", () => {
  assert.deepEqual(acpSlashCommands([
    { name: "review", description: "old" },
    { name: "/review", description: "Review", input: { hint: "scope" } },
    { name: "compact", description: "Compact" },
    { name: "bad name", description: "invalid" },
  ]), [
    { name: "review", description: "Review", argumentHint: "scope", source: "acp" },
    { name: "compact", description: "Compact", argumentHint: "", source: "acp" },
  ]);
});

test("ACP 모델 그룹을 펼치면서 제공사가 준 ID를 바꾸지 않는다", () => {
  assert.deepEqual(acpSelectOptions({
    id: "model", name: "Model", type: "select", currentValue: "model/fast",
    options: [{ group: "provider", name: "Provider", options: [{ value: "model/fast", name: "Fast" }] }],
  }), [{ value: "model/fast", name: "Fast" }]);
  assert.deepEqual(acpSelectOptions({ id: "fast", name: "Fast", type: "boolean", currentValue: true }), []);
});

test("ACP 미선언 기능은 지원하지 않는 것으로 판단한다", () => {
  assert.deepEqual(acpCapabilities({ protocolVersion: 1 }), {
    loadSession: false, resumeSession: false, listSessions: false, images: false, audio: false, embeddedContext: false,
  });
  assert.deepEqual(acpCapabilities({ protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, list: {} }, promptCapabilities: { image: true } } }), {
    loadSession: true, resumeSession: true, listSessions: true, images: true, audio: false, embeddedContext: false,
  });
});
