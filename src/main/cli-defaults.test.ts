import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeManagedSettingsPath, claudeProgressNotes, claudeShowsThinkingSummaries, codexHasDeveloperInstructions, codexTopLevelModel, readCliDefaultModel } from "./cli-defaults";

test("claudeManagedSettingsPath: 운영체제별 관리형 설정 위치", () => {
  assert.equal(claudeManagedSettingsPath("darwin"), "/Library/Application Support/ClaudeCode/managed-settings.json");
  assert.equal(claudeManagedSettingsPath("win32"), "C:\\Program Files\\ClaudeCode\\managed-settings.json");
});

test("codexTopLevelModel: 최상위 model 만, 섹션 안의 model 은 무시", () => {
  assert.equal(codexTopLevelModel('model = "gpt-6-astra"\nmodel_reasoning_effort = "medium"\n[features]\nmodel = "x"'), "gpt-6-astra");
  assert.equal(codexTopLevelModel('[profiles.a]\nmodel = "x"'), null);
  assert.equal(codexTopLevelModel("# 없음\n"), null);
});

test("readCliDefaultModel: 설정 파일에서 읽고, 없으면 null", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-clidef-"));
  assert.equal(readCliDefaultModel("claude", home), null);
  assert.equal(readCliDefaultModel("codex", home), null);
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ model: "claude-fable-5-1[1m]" }));
  mkdirSync(join(home, ".codex"));
  writeFileSync(join(home, ".codex", "config.toml"), 'model = "gpt-6-astra"\n');
  assert.equal(readCliDefaultModel("claude", home), "claude-fable-5-1[1m]");
  assert.equal(readCliDefaultModel("codex", home), "gpt-6-astra");
  writeFileSync(join(home, ".claude", "settings.json"), "{broken");
  assert.equal(readCliDefaultModel("claude", home), null);
  rmSync(home, { recursive: true, force: true });
});

test("claudeShowsThinkingSummaries·claudeProgressNotes: 사용자 < 프로젝트 < 로컬 < 관리형, CLAUDE_CONFIG_DIR 을 따르고, 서드파티 경로면 끈다", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "wb-cwd-"));
  const managed = join(home, "managed.json");
  const env = {};
  assert.equal(claudeShowsThinkingSummaries(env, home, cwd, managed), false, "설정이 없으면 꺼짐");
  assert.equal(claudeProgressNotes(env, home, cwd, managed), true);
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ showThinkingSummaries: true }));
  assert.equal(claudeShowsThinkingSummaries(env, home, cwd, managed), true);
  assert.equal(claudeProgressNotes(env, home, cwd, managed), false, "추론 요약이 섞이니 끈다");
  mkdirSync(join(cwd, ".claude"));
  writeFileSync(join(cwd, ".claude", "settings.local.json"), JSON.stringify({ showThinkingSummaries: false }));
  assert.equal(claudeShowsThinkingSummaries(env, home, cwd, managed), false, "로컬이 사용자 설정을 덮는다");
  writeFileSync(managed, JSON.stringify({ showThinkingSummaries: true }));
  assert.equal(claudeShowsThinkingSummaries(env, home, cwd, managed), true, "관리형이 가장 앞선다");
  const alt = mkdtempSync(join(tmpdir(), "wb-cfg-"));
  assert.equal(claudeShowsThinkingSummaries({ CLAUDE_CONFIG_DIR: alt }, home, null, join(alt, "none.json")), false, "CLAUDE_CONFIG_DIR 이면 ~/.claude 를 보지 않는다");
  assert.equal(claudeProgressNotes({ CLAUDE_CODE_USE_BEDROCK: "1" }, alt, null, join(alt, "none.json")), false, "Bedrock 경로는 진행 설명 모드를 켜지 않는다");
  assert.equal(claudeProgressNotes({ CLAUDE_CODE_USE_VERTEX: "0" }, alt, null, join(alt, "none.json")), true, "0 은 꺼진 것");
  for (const d of [home, cwd, alt]) rmSync(d, { recursive: true, force: true });
});

test("codexHasDeveloperInstructions: 사용자·프로젝트 설정에 developer_instructions 가 있으면 true", () => {
  const home = mkdtempSync(join(tmpdir(), "sudal-codex-di-"));
  const cwd = mkdtempSync(join(tmpdir(), "sudal-codex-di-cwd-"));
  try {
    assert.equal(codexHasDeveloperInstructions({}, home, cwd), false);
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "config.toml"), 'model = "x"\n# developer_instructions = "주석"\n');
    assert.equal(codexHasDeveloperInstructions({}, home, cwd), false, "주석은 세지 않는다");
    writeFileSync(join(home, ".codex", "config.toml"), 'model = "x"\ndeveloper_instructions = """\n규칙\n"""\n');
    assert.equal(codexHasDeveloperInstructions({}, home, null), true);
    // CODEX_HOME 이 있으면 그쪽을 본다
    const other = mkdtempSync(join(tmpdir(), "sudal-codex-home-"));
    assert.equal(codexHasDeveloperInstructions({ CODEX_HOME: other }, home, null), false);
    mkdirSync(join(cwd, ".codex"));
    writeFileSync(join(cwd, ".codex", "config.toml"), '[profiles.a]\n  developer_instructions = "x"\n');
    assert.equal(codexHasDeveloperInstructions({ CODEX_HOME: other }, home, cwd), true, "프로젝트 설정도 본다");
    rmSync(other, { recursive: true, force: true });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
