import { test } from "node:test";
import assert from "node:assert/strict";
import { filterCommands, isAcpSlashCommand, mergeSlashCommands, parseSlashQuery, type SlashCommandDto } from "./slash-commands";

const cmds: SlashCommandDto[] = [
  { name: "compact", description: "대화 압축", argumentHint: "[instructions]" },
  { name: "usage", description: "사용량", argumentHint: "", aliases: ["cost", "stats"] },
  { name: "review", description: "코드 리뷰", argumentHint: "" },
  { name: "resume", description: "세션 재개", argumentHint: "" },
  { name: "commit", description: "git 커밋 만들기", argumentHint: "" },
  { name: "__remote-workflow", description: "내부", argumentHint: "" },
  { name: "deploy-list:_config", description: "내부", argumentHint: "" },
];

test("parseSlashQuery: 슬래시로 시작하고 공백 전까지만 검색어", () => {
  assert.equal(parseSlashQuery("/"), "");
  assert.equal(parseSlashQuery("/co"), "co");
  assert.equal(parseSlashQuery("/compact 지금"), null);
  assert.equal(parseSlashQuery("안녕"), null);
  assert.equal(parseSlashQuery(""), null);
  assert.equal(parseSlashQuery(" /x"), null);
});

test("filterCommands: 빈 검색어는 터미널 전용·내부용만 빼고 이름순", () => {
  assert.deepEqual(
    filterCommands(cmds, "").map((c) => c.name),
    ["commit", "compact", "review", "usage"],
  );
});

test("filterCommands: 접두 일치 우선, 이름·별칭 부분 일치는 뒤에, 설명은 검색하지 않음", () => {
  assert.deepEqual(filterCommands(cmds, "co").map((c) => c.name), ["commit", "compact", "usage"]);
  assert.deepEqual(filterCommands(cmds, "cost").map((c) => c.name), ["usage"]);
  assert.deepEqual(filterCommands(cmds, "pact").map((c) => c.name), ["compact"]);
  assert.deepEqual(filterCommands(cmds, "리뷰"), []);
  assert.deepEqual(filterCommands(cmds, "zzz"), []);
});

test("filterCommands: 터미널 목록을 주면 그것으로 제외", () => {
  const names = filterCommands(cmds, "", new Set(["compact"])).map((c) => c.name);
  assert.ok(names.includes("resume") && !names.includes("compact"));
});

test("ACP가 제공한 logout·doctor는 표시하고 기존 SDK의 터미널 명령 필터는 유지한다", () => {
  const commands: SlashCommandDto[] = [
    { name: "logout", description: "ACP logout", argumentHint: "", source: "acp" },
    { name: "doctor", description: "ACP diagnostics", argumentHint: "", source: "acp" },
    { name: "resume", description: "Terminal only", argumentHint: "" },
    { name: "_private", description: "Internal", argumentHint: "", source: "acp" },
  ];
  assert.deepEqual(filterCommands(commands, "").map(row => row.name), ["doctor", "logout"]);
});

test("앱·ACP 목록의 이름 충돌을 정리한 뒤 실행 경로도 같은 선택을 따른다", () => {
  const commands = mergeSlashCommands(
    [{ name: "model", description: "App picker", argumentHint: "" }],
    [
      { name: "model", description: "Agent picker", argumentHint: "", source: "acp" },
      { name: "review", description: "Review", argumentHint: "scope", source: "acp" },
    ],
  );
  assert.equal(commands.length, 2);
  assert.equal(commands[0].description, "App picker");
  assert.equal(isAcpSlashCommand("/model", commands), false);
  assert.equal(isAcpSlashCommand("/review this branch", commands), true);
  assert.equal(isAcpSlashCommand("/reviewx", commands), false);
  assert.equal(isAcpSlashCommand("hello /review", commands), false);
});
