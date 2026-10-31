import { test } from "node:test";
import assert from "node:assert/strict";
import { agyCommands, codexCommands, isCodexSlashCommand, modelFromArg, parseCodexCommand, parseAgyAppCommand, parseAppCommand, withAppCommands } from "./app-commands";
import { createI18n } from "./i18n";
import { filterCommands } from "./slash-commands";
const { t } = createI18n("ko");

test("명령 출처: 앱 기능과 Codex·Claude·Antigravity 기능을 구분한다", () => {
  const codex = new Map(codexCommands(t).map(command => [command.name, command.source]));
  for (const name of ["plan", "goal", "compact", "review", "mcp", "rename", "fork"]) assert.equal(codex.get(name), "codex", name);
  for (const name of ["config", "model", "permissions", "new", "clear", "resume", "diff", "export", "worktree"]) assert.equal(codex.get(name), "sudal", name);
  const claude = withAppCommands(t, [{ name: "compact", description: "", argumentHint: "" }, { name: "clear", description: "", argumentHint: "" }, { name: "mcp", description: "", argumentHint: "" }]);
  assert.equal(claude.find(command => command.name === "compact")?.source, "claude");
  assert.equal(claude.find(command => command.name === "clear")?.source, "sudal");
  assert.equal(claude.find(command => command.name === "mcp")?.source, "sudal");
  const agy = agyCommands(t);
  assert.equal(agy.find(command => command.name === "plan")?.source, "agy");
  assert.equal(agy.find(command => command.name === "config")?.source, "sudal");
});

test("Codex의 plan·goal과 하이픈 명령을 제공하고 미지원 명령도 가로챈다", () => {
  for (const command of ["plan", "goal", "mcp", "review", "permissions", "debug-config"]) {
    assert.ok(codexCommands(t).some(c=>c.name===command));
    assert.equal(parseCodexCommand(`/${command}`)?.name,command);
  }
  assert.deepEqual(parseCodexCommand("/goal pause"),{name:"goal",arg:"pause"});
  assert.equal(parseCodexCommand("/logout"),null);
  assert.equal(isCodexSlashCommand("/logout"),true);
  assert.equal(isCodexSlashCommand("/typo"),true);
  assert.equal(isCodexSlashCommand("//path"),false);
  assert.ok(filterCommands(codexCommands(t), "resume").some(command=>command.name==="resume"), "앱에서 구현한 resume은 터미널 전용 필터로 숨기지 않는다");
});

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
