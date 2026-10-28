import { test } from "node:test";
import assert from "node:assert/strict";
import { agyCommands, modelFromArg, parseAgyAppCommand, parseAppCommand, withAppCommands } from "./app-commands";
import { createI18n } from "./i18n";
const { t } = createI18n("ko");

test("parseAppCommand: 이름·인자 분리, 다른 입력은 null", () => {
  assert.deepEqual(parseAppCommand("/model"), { name: "model", arg: "" });
  assert.deepEqual(parseAppCommand("  /model   opus  "), { name: "model", arg: "opus" });
  assert.deepEqual(parseAppCommand("/config"), { name: "config", arg: "" });
  assert.deepEqual(parseAppCommand("/mcp"), { name: "mcp", arg: "" });
  assert.equal(parseAppCommand("/models"), null);
  assert.equal(parseAppCommand("/modelx opus"), null);
  assert.equal(parseAppCommand("모델 바꿔 /model"), null);
  assert.equal(parseAppCommand("/compact"), null);
});

test("withAppCommands: 앱 커맨드가 앞에, CLI 의 같은 이름은 대체", () => {
  const out = withAppCommands(t, [
    { name: "model", description: "cli", argumentHint: "" },
    { name: "compact", description: "c", argumentHint: "" },
  ]);
  assert.deepEqual(out.map((c) => c.name), ["model", "config", "mcp", "compact"]);
  assert.match(out[0].description, /앱에서 처리/);
});

test("modelFromArg: 기본값 표현은 빈 문자열, 첫 토큰만", () => {
  assert.equal(modelFromArg(""), "");
  assert.equal(modelFromArg("기본"), "");
  assert.equal(modelFromArg("Default"), "");
  assert.equal(modelFromArg("opus 뭐시기"), "opus");
  assert.equal(modelFromArg("claude-sonnet-5"), "claude-sonnet-5");
});

test("agyCommands 및 parseAgyAppCommand: 앱 명령과 에이전트 워크플로 명령 분리", () => {
  const list = agyCommands(t);
  const names = list.map((c) => c.name);
  assert.ok(names.includes("model"));
  assert.ok(names.includes("compact"));
  assert.ok(names.includes("plan"));
  assert.ok(names.includes("boost"));
  assert.ok(names.includes("grill-me"));

  // 앱이 처리할 명령만 parseAgyAppCommand 가 잡아내고, /plan·/boost 등은 에이전트로 전달되게 null 반환
  assert.deepEqual(parseAgyAppCommand("/compact"), { name: "compact", arg: "" });
  assert.deepEqual(parseAgyAppCommand("/rename 새이름"), { name: "rename", arg: "새이름" });
  assert.equal(parseAgyAppCommand("/plan 로그인 구현"), null);
  assert.equal(parseAgyAppCommand("/boost"), null);
});
