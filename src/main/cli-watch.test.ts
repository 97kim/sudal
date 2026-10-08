import { test } from "node:test";
import assert from "node:assert/strict";
import { ShellCliMonitor, findCliDescendants, parsePsTree, parseResumeId, parseWinProcessJson } from "./cli-watch";

const ps = (rows: [number, number, string][]) => rows.map(([pid, ppid, comm]) => `${pid} ${ppid} ${comm}`).join("\n");

test("parsePsTree/findCliDescendants: 셸의 자손 가운데 claude·codex 를 찾는다(손자 포함, 다른 셸 것은 제외)", () => {
  const tree = parsePsTree(
    ps([
      [1, 0, "launchd"],
      [100, 1, "/bin/zsh"],
      [101, 100, "node"],
      [102, 101, "/Users/me/.local/bin/claude"],
      [200, 1, "/bin/zsh"],
      [201, 200, "/opt/homebrew/bin/codex"],
      [202, 201, "/bin/zsh"],
    ]),
  );
  assert.deepEqual(findCliDescendants(tree, 100), [{ pid: 102, provider: "claude" }]);
  assert.deepEqual(findCliDescendants(tree, 200), [{ pid: 201, provider: "codex" }]);
  assert.deepEqual(findCliDescendants(tree, 300), []);
});

test("parseWinProcessJson: Win32_Process JSON → 트리. .exe·node 로 띄운 npm CLI 도 알아본다", () => {
  const rows = [
    { ProcessId: 4, ParentProcessId: 0, Name: "System", CommandLine: null },
    { ProcessId: 100, ParentProcessId: 4, Name: "powershell.exe", CommandLine: "powershell.exe" },
    { ProcessId: 101, ParentProcessId: 100, Name: "claude.exe", CommandLine: '"C:\\Users\\me\\.local\\bin\\claude.exe" --resume 0d9c6a8e-1111-4222-8333-444455556666' },
    { ProcessId: 200, ParentProcessId: 4, Name: "pwsh.exe", CommandLine: "pwsh" },
    { ProcessId: 201, ParentProcessId: 200, Name: "node.exe", CommandLine: '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js' },
    { ProcessId: 202, ParentProcessId: 201, Name: "codex.exe", CommandLine: "codex.exe" },
    { ProcessId: 300, ParentProcessId: 4, Name: "cmd.exe", CommandLine: "cmd" },
    { ProcessId: 301, ParentProcessId: 300, Name: "node.exe", CommandLine: "node server.js" },
  ];
  const { tree, args } = parseWinProcessJson(JSON.stringify(rows));
  assert.deepEqual(findCliDescendants(tree, 100), [{ pid: 101, provider: "claude" }]);
  assert.deepEqual(findCliDescendants(tree, 200), [{ pid: 201, provider: "codex" }, { pid: 202, provider: "codex" }]);
  assert.deepEqual(findCliDescendants(tree, 300), []);
  assert.equal(parseResumeId(args.get(101) ?? ""), "0d9c6a8e-1111-4222-8333-444455556666");
  // 프로세스가 하나뿐이면 ConvertTo-Json 은 배열이 아니라 객체를 낸다
  assert.equal(parseWinProcessJson(JSON.stringify(rows[2])).tree.size, 1);
  assert.equal(parseWinProcessJson("").tree.size, 0);
  assert.equal(parseWinProcessJson("깨진 출력").tree.size, 0);
});

test("parseResumeId: 명령에서 이어받는 세션 id 만 뽑는다(--last·세션 이름은 null)", () => {
  const uuid = "01a01111-1111-7111-8111-111111111111";
  assert.equal(parseResumeId(`/opt/homebrew/bin/codex resume ${uuid}`), uuid);
  assert.equal(parseResumeId(`codex resume ${uuid} "숫자 2만 답해."`), uuid);
  assert.equal(parseResumeId(`claude --resume ${uuid} --settings {}`), uuid);
  assert.equal(parseResumeId(`claude -r ${uuid}`), uuid);
  assert.equal(parseResumeId("codex resume --last"), null, "id 없이 --last 면 알 수 없다");
  assert.equal(parseResumeId("codex resume my-session-name"), null, "세션 이름은 파일명으로 못 찾는다");
  assert.equal(parseResumeId("codex"), null);
  assert.equal(parseResumeId("claude --settings {} "), null);
});

test("ShellCliMonitor: 나타나면 onStart(한 번), 사라지거나 셸이 닫히면 onExit", async () => {
  let rows: [number, number, string][] = [[100, 1, "/bin/zsh"]];
  let shells = [{ tabId: "t1", pid: 100, cwd: "/w" }];
  const started: unknown[] = [];
  const exited: unknown[] = [];
  const m = new ShellCliMonitor({
    shells: () => shells,
    onStart: (tabId, cli) => started.push([tabId, cli]),
    onExit: (tabId, pid) => exited.push([tabId, pid]),
    ps: async () => ps(rows),
    cwdOf: async (pid) => (pid === 102 ? "/w/sub" : null),
    argsOf: async (pid) => (pid === 102 ? "claude --resume 01a01111-1111-7111-8111-111111111111" : "codex"),
  });
  await m.tick();
  assert.deepEqual(started, []);
  rows = [[100, 1, "/bin/zsh"], [102, 100, "claude"]];
  await m.tick();
  await m.tick();
  assert.deepEqual(
    started,
    [["t1", { pid: 102, provider: "claude", cwd: "/w/sub", resumeId: "01a01111-1111-7111-8111-111111111111" }]],
    "한 번만 알리고, 명령의 resume id 도 함께 준다",
  );
  rows = [[100, 1, "/bin/zsh"]];
  await m.tick();
  assert.deepEqual(exited, [["t1", 102]]);
  // 다시 뜨면 다시 알리고, 셸이 닫히면 exit
  rows = [[100, 1, "/bin/zsh"], [103, 100, "codex"]];
  await m.tick();
  assert.equal(started.length, 2);
  assert.deepEqual((started[1] as [string, { cwd: string }])[1].cwd, "/w", "cwd 를 못 읽으면 셸 cwd");
  shells = [];
  await m.tick();
  assert.deepEqual(exited[1], ["t1", 103]);
});
