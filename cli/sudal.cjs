#!/usr/bin/env node
// `sudal` — 실행 중인 Sudal 앱을 명령줄에서 제어한다(에이전트용). 의존성 없음: 앱에 동봉된 Electron 을 node 로 돌리거나 시스템 node 로 실행.
// 앱과는 userData 의 유닉스 소켓(control.sock)으로 줄 단위 JSON 을 주고받는다(src/main/control-server.ts).
// 출력은 항상 JSON 한 덩어리(stdout). 실패는 exit 1 + {"error":{...}}.
"use strict";
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function userDataDir() {
  if (process.env.SUDAL_USERDATA) return process.env.SUDAL_USERDATA;
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Sudal");
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Sudal");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "Sudal");
}

/** 소켓 위치: SUDAL_SOCKET → userData/control.json 의 socket(앱이 시작할 때 쓴다) → userData/control.sock */
function socketPath() {
  if (process.env.SUDAL_SOCKET) return process.env.SUDAL_SOCKET;
  const ud = userDataDir();
  try {
    const info = JSON.parse(fs.readFileSync(path.join(ud, "control.json"), "utf8"));
    if (info && typeof info.socket === "string") return info.socket;
  } catch {
    /* 앱이 안 떠 있거나 옛 버전 */
  }
  return path.join(ud, "control.sock");
}

// 사용자에게 보이는 문구 표. 의존성 0 을 지키려고 i18next 없이 이 파일 안에서 고른다.
// 언어: SUDAL_LANG → LC_ALL → LC_MESSAGES → LANG 중 먼저 값이 있는 것이 ko 로 시작하면 한국어, 아니면 영어.
const MESSAGES = {
  // i18n-ignore: 한국어 문구 표
  ko: {
    valueNeeded: "--{{flag}} 에는 값이 필요합니다.",
    timeout: "응답이 {{sec}}초 안에 오지 않았습니다.",
    badResponse: "응답을 읽지 못했습니다: {{line}}",
    disconnected: "응답 전에 연결이 끊겼습니다(앱이 종료 중일 수 있습니다).",
    notRunning: "Sudal 이 실행 중이 아닙니다(제어 소켓 없음). 앱을 먼저 여세요.",
    noSelfTab: "self 는 Sudal 탭 안의 에이전트만 쓸 수 있습니다(SUDAL_TAB_ID 없음). 탭 id 나 제목을 주세요.",
    unknownGuide: "모르는 가이드: {{name}}",
    noAgents: "Claude Code(~/.claude)도 Codex(~/.codex)도 이 PC 에 없습니다.",
    installedNote: "새 세션부터 스킬이 보입니다(Claude Code: /sudal-cli, Codex: $sudal-cli).",
    unknownSkillsCmd: "skills {{cmd}}: 모르는 명령. 'get' 또는 'install'.",
    questionRequired: "--question 이 필요합니다.",
    resumeAfterError: "{{message}} (질문 id {{id}} — --resume {{id}} 로 다시 기다리세요)",
    resumeAfterTransport: "{{message}} (질문은 남아 있습니다 — --resume {{id}} 로 다시 기다리세요)",
    unknownCommand: "모르는 명령: {{cmd}}. --help 를 보세요.",
    help: `sudal — 실행 중인 Sudal 을 제어한다. 출력은 항상 JSON.

  sudal status
  sudal ws list
  sudal ws add --path /abs/dir
  sudal tab list [--ws <id|name>] [--all]
  sudal tab new [--ws <id|name>] [--cwd /abs/dir] [--provider claude|codex] [--policy ask|auto_edit|full]
                  [--model <id>] [--title <text>] [--prompt <text>] [--activate]
  sudal tab status --tab <sel>
  sudal tab send --tab <sel> --text <text> [--wait] [--timeout-ms N]
  sudal tab wait --tab <sel> [--timeout-ms N]
  sudal tab read --tab <sel> [--last N]
  sudal tab activate --tab <sel>
  sudal tab close --tab <sel>
  sudal tab abort --tab <sel>
  sudal tab verify --tab <sel> [--cmd <명령>]... [--wait] [--timeout-ms N]   # 저장한 검증 명령(또는 --cmd) 실행 → 카드
  sudal tab verify-abort --tab <sel>
  sudal tab fanout --tab <sel> --prompt <text> --provider claude --provider codex [--policy ask|auto_edit|full] [--wait] [--timeout-ms N]
                                       # 지시 하나를 격리 세션(worktree) N개에 동시에 → 원래 탭에 팬아웃 카드
  sudal file open --path /abs/file [--line N] [--tab <sel>]
  sudal browser open --url https://… [--tab <sel>]
  sudal browser read [--tab <sel>]                     보이는 글과 누를 만한 것(선택자 포함)
  sudal browser click (--selector <css> | --text <글>) [--tab <sel>]
  sudal browser fill --selector <css> --value <값> [--tab <sel>]
  sudal orch run-create --objective <text> [--coordinator self|active|<tab>]   # 오케스트레이션 Run (코디네이터 = 사람 또는 탭)
  sudal orch worker-start --run <id> [--key <k>] (--spec <text> | --task <id>) [--agent claude|codex] [--model <id>]
                            [--policy ask|auto_edit|full] [--cwd /abs] [--worktree] [--request-id <id>]
  sudal orch check --run <id> [--key <k>] [--wait] [--types worker_done,question,escalation,note] [--ack <delivery>] [--peek] [--timeout-ms N]
  sudal orch reply --run <id> [--key <k>] --id <question> --body <text>
  sudal orch send --run <id> ... --type followup --to dispatch:<id>|@all|@claude|@codex|@idle --body <text>   # 코디네이터 → 워커(그룹 가능)
  sudal orch send --run <id> --dispatch <id> --capability <c> --type worker_done|escalation ...   # 워커 → 코디네이터
  sudal orch ask --run <id> --dispatch <id> --capability <c> (--question <text> [--options a,b] | --resume <msg>) [--timeout-ms N]
  sudal orch task-create --run <id> --key <k> --spec <text> [--deps <task>,<task>]     # DAG: 의존 Task 가 succeeded 여야 시작 가능
  sudal orch task-list --run <id> [--ready]                                            # --ready: 지금 시작할 수 있는 것만
  sudal orch gate-create --run <id> --key <k> --task <id> --question <text> --options a,b   # 시작 전 결정(코디네이터 소유)
  sudal orch gate-resolve --run <id> --key <k> --id <gate> --resolution <choice> | gate-list --run <id> [--task <id>]
  sudal orch worker-start ... [--terminal <tab>]     # 정산된 워커의 탭 재사용(같은 provider·경로)
  sudal orch worker-cleanup --run <id> --key <k> --dispatch <id>   # 정산된 워커의 탭 닫기 + worktree 삭제(강제)
  sudal orch run-list | run-show --run <id> | run-close --run <id>
  sudal orch worker-list --run <id> | worker-show|worker-retain|worker-release|worker-stop|worker-abandon --run <id> --dispatch <id>
  sudal skills get [sudal-cli]      # 이 앱 버전의 에이전트용 가이드(마크다운)
  sudal skills install                # Claude Code(~/.claude/skills)·Codex(~/.codex/skills) 에 스킬 스텁 설치

  <sel> = self(이 명령을 부른 에이전트의 탭) | active(화면에서 보고 있는 탭) | 탭 id | 정확한 제목 | 유일한 제목 접두
  --text / --prompt 에 "-" 를 주면 stdin 에서 읽는다.
`,
  },
  en: {
    valueNeeded: "--{{flag}} needs a value.",
    timeout: "No response within {{sec}} seconds.",
    badResponse: "Could not read the response: {{line}}",
    disconnected: "The connection closed before a response arrived (the app may be quitting).",
    notRunning: "Sudal is not running (no control socket). Open the app first.",
    noSelfTab: "self only works for an agent running inside an Sudal tab (SUDAL_TAB_ID is not set). Pass a tab id or title.",
    unknownGuide: "Unknown guide: {{name}}",
    noAgents: "Neither Claude Code (~/.claude) nor Codex (~/.codex) exists on this computer.",
    installedNote: "The skill shows up from the next new session (Claude Code: /sudal-cli, Codex: $sudal-cli).",
    unknownSkillsCmd: "skills {{cmd}}: unknown command. Use 'get' or 'install'.",
    questionRequired: "--question is required.",
    resumeAfterError: "{{message}} (question id {{id}} — wait again with --resume {{id}})",
    resumeAfterTransport: "{{message}} (the question is still open — wait again with --resume {{id}})",
    unknownCommand: "Unknown command: {{cmd}}. See --help.",
    help: `sudal — control a running Sudal. Output is always JSON.

  sudal status
  sudal ws list
  sudal ws add --path /abs/dir
  sudal tab list [--ws <id|name>] [--all]
  sudal tab new [--ws <id|name>] [--cwd /abs/dir] [--provider claude|codex] [--policy ask|auto_edit|full]
                  [--model <id>] [--title <text>] [--prompt <text>] [--activate]
  sudal tab status --tab <sel>
  sudal tab send --tab <sel> --text <text> [--wait] [--timeout-ms N]
  sudal tab wait --tab <sel> [--timeout-ms N]
  sudal tab read --tab <sel> [--last N]
  sudal tab activate --tab <sel>
  sudal tab close --tab <sel>
  sudal tab abort --tab <sel>
  sudal tab verify --tab <sel> [--cmd <command>]... [--wait] [--timeout-ms N]   # run the saved verify commands (or --cmd) -> card
  sudal tab verify-abort --tab <sel>
  sudal tab fanout --tab <sel> --prompt <text> --provider claude --provider codex [--policy ask|auto_edit|full] [--wait] [--timeout-ms N]
                                       # one prompt to N isolated sessions (worktrees) at once -> fan-out card on the original tab
  sudal file open --path /abs/file [--line N] [--tab <sel>]
  sudal browser open --url https://… [--tab <sel>]
  sudal browser read [--tab <sel>]                     visible text and clickable things (with selectors)
  sudal browser click (--selector <css> | --text <text>) [--tab <sel>]
  sudal browser fill --selector <css> --value <value> [--tab <sel>]
  sudal orch run-create --objective <text> [--coordinator self|active|<tab>]   # orchestration Run (the coordinator is a person or a tab)
  sudal orch worker-start --run <id> [--key <k>] (--spec <text> | --task <id>) [--agent claude|codex] [--model <id>]
                            [--policy ask|auto_edit|full] [--cwd /abs] [--worktree] [--request-id <id>]
  sudal orch check --run <id> [--key <k>] [--wait] [--types worker_done,question,escalation,note] [--ack <delivery>] [--peek] [--timeout-ms N]
  sudal orch reply --run <id> [--key <k>] --id <question> --body <text>
  sudal orch send --run <id> ... --type followup --to dispatch:<id>|@all|@claude|@codex|@idle --body <text>   # coordinator -> worker (groups allowed)
  sudal orch send --run <id> --dispatch <id> --capability <c> --type worker_done|escalation ...   # worker -> coordinator
  sudal orch ask --run <id> --dispatch <id> --capability <c> (--question <text> [--options a,b] | --resume <msg>) [--timeout-ms N]
  sudal orch task-create --run <id> --key <k> --spec <text> [--deps <task>,<task>]     # DAG: a Task can start only after the Tasks it depends on succeeded
  sudal orch task-list --run <id> [--ready]                                            # --ready: only the ones that can start now
  sudal orch gate-create --run <id> --key <k> --task <id> --question <text> --options a,b   # decision before start (owned by the coordinator)
  sudal orch gate-resolve --run <id> --key <k> --id <gate> --resolution <choice> | gate-list --run <id> [--task <id>]
  sudal orch worker-start ... [--terminal <tab>]     # reuse the tab of a settled worker (same provider and path)
  sudal orch worker-cleanup --run <id> --key <k> --dispatch <id>   # close the settled worker's tab + delete its worktree (forced)
  sudal orch run-list | run-show --run <id> | run-close --run <id>
  sudal orch worker-list --run <id> | worker-show|worker-retain|worker-release|worker-stop|worker-abandon --run <id> --dispatch <id>
  sudal skills get [sudal-cli]      # the agent guide for this app version (markdown)
  sudal skills install                # install skill stubs into Claude Code (~/.claude/skills) and Codex (~/.codex/skills)

  <sel> = self (the tab of the agent running this command) | active (the tab shown in the app) | tab id | exact title | unique title prefix
  Pass "-" to --text / --prompt to read it from stdin.
`,
  },
};

function pickLang() {
  const v = [process.env.SUDAL_LANG, process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG].find((x) => x);
  return v && /^ko/i.test(v) ? "ko" : "en";
}
const LANG = pickLang();

function t(key, vars) {
  const text = MESSAGES[LANG][key];
  return vars ? text.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k])) : text;
}

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = (eq >= 0 ? a.slice(2, eq) : a.slice(2)).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      let val;
      if (eq >= 0) val = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) val = argv[++i];
      else val = true;
      // 같은 플래그를 반복하면(--cmd a --cmd b) 배열로 모은다
      if (key in flags) flags[key] = (Array.isArray(flags[key]) ? flags[key] : [flags[key]]).concat([val]);
      else flags[key] = val;
    } else pos.push(a);
  }
  return { pos, flags };
}

/** 값이 있어야 하는 플래그. `--tab` 처럼 값 없이 쓰면 서버가 active 로 오해하기 전에 여기서 거절한다. */
const VALUE_FLAGS = ["tab", "text", "prompt", "ws", "cwd", "provider", "policy", "model", "title", "path", "url", "line", "last", "timeoutMs", "cmd", "run", "key", "spec", "task", "agent", "dispatch", "capability", "question", "options", "resume", "id", "body", "subject", "type", "to", "outcome", "filesModified", "types", "ack", "objective", "coordinator", "reason", "requestId", "deps", "terminal", "resolution", "name", "cron", "timezone", "precheck", "precheckTimeout", "grace", "workspace", "enabled"];
function checkValueFlags(flags) {
  for (const k of VALUE_FLAGS) if (flags[k] === true || (Array.isArray(flags[k]) && flags[k].includes(true))) fail(t("valueNeeded", { flag: k.replace(/([A-Z])/g, (m) => "-" + m.toLowerCase()) }), "bad_request");
}

function readStdinIfDash(v) {
  if (v !== "-") return v;
  return fs.readFileSync(0, "utf8").replace(/\n$/, "");
}

/**
 * 요청 하나를 보내고 응답 한 줄을 기다린다. 응답 전에 연결이 끊기면(앱 종료 중 등) 실패로, 응답이 영영 안 오면 데드라인(서버 대기 시간 + 여유)으로 끝낸다.
 */
function request(method, params, deadlineMs) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath());
    let buf = "";
    let settled = false;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      fn(v);
    };
    const timer = setTimeout(() => finish(reject, Object.assign(new Error(t("timeout", { sec: Math.round(deadlineMs / 1000) })), { code: "timeout" })), deadlineMs);
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(JSON.stringify({ id: 1, method, params }) + "\n"));
    sock.on("data", (d) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i < 0) return;
      const line = buf.slice(0, i);
      try {
        finish(resolve, JSON.parse(line));
      } catch {
        finish(reject, new Error(t("badResponse", { line: line.slice(0, 200) })));
      }
    });
    sock.on("end", () => finish(reject, Object.assign(new Error(t("disconnected")), { code: "disconnected" })));
    sock.on("close", () => finish(reject, Object.assign(new Error(t("disconnected")), { code: "disconnected" })));
    sock.on("error", (e) => {
      if (e.code === "ENOENT" || e.code === "ECONNREFUSED") finish(reject, Object.assign(new Error(t("notRunning")), { code: "not_running" }));
      else finish(reject, e);
    });
  });
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}
function fail(message, code = "error", extra = {}) {
  process.stdout.write(JSON.stringify({ error: { code, message, ...extra } }, null, 2) + "\n");
  process.exit(1);
}

const SKILL_STUB = path.join(__dirname, "skill-stub.md");
const SKILL_GUIDE = path.join(__dirname, "skill-guide.md");

async function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  if (flags.version) {
    out({ cli: readVersion() });
    return;
  }
  if (flags.help || flags.h || pos.length === 0) {
    process.stdout.write(t("help"));
    return;
  }
  const [group, cmd] = pos;
  checkValueFlags(flags);
  // `self` = 이 CLI 를 부른 에이전트의 탭. 앱이 탭의 에이전트를 띄울 때 SUDAL_TAB_ID 로 알려 준다.
  // `active`(사람이 화면에서 고른 탭)와 다르다 — 에이전트가 화면에 떠 있지 않은 탭에서 도는 일이 흔하다.
  const selfTab = process.env.SUDAL_TAB_ID || undefined;
  for (const k of ["tab", "coordinator", "terminal"]) {
    if (flags[k] !== "self") continue;
    if (!selfTab) return fail(t("noSelfTab"), "no_self_tab");
    flags[k] = selfTab;
  }
  const timeoutMs = flags.timeoutMs !== undefined ? Number(flags.timeoutMs) : undefined;

  // 앱이 없어도 되는 명령
  if (group === "skills") {
    if (cmd === "get") {
      const name = pos[2] || "sudal-cli";
      if (name !== "sudal-cli") return fail(t("unknownGuide", { name }), "not_found");
      process.stdout.write(fs.readFileSync(SKILL_GUIDE, "utf8"));
      return;
    }
    if (cmd === "install") {
      // 이 PC 에 있는 에이전트마다: Claude Code(~/.claude/skills), Codex CLI($CODEX_HOME/skills, 기본 ~/.codex/skills)
      const home = os.homedir();
      const targets = [
        { label: "Claude Code", home: path.join(home, ".claude"), dir: path.join(home, ".claude", "skills", "sudal-cli") },
        { label: "Codex CLI", home: process.env.CODEX_HOME || path.join(home, ".codex"), dir: path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "skills", "sudal-cli") },
      ];
      const stub = fs.readFileSync(SKILL_STUB, "utf8");
      const installed = [];
      const skipped = [];
      for (const t of targets) {
        if (!fs.existsSync(t.home)) { skipped.push(t.label); continue; }
        fs.mkdirSync(t.dir, { recursive: true });
        fs.writeFileSync(path.join(t.dir, "SKILL.md"), stub);
        installed.push(path.join(t.dir, "SKILL.md"));
      }
      if (installed.length === 0) return fail(t("noAgents"), "not_found");
      out({ installed, skipped, note: t("installedNote") });
      return;
    }
    return fail(t("unknownSkillsCmd", { cmd: cmd ?? "" }));
  }

  // orch ask: 질문을 먼저 만들어 message_id 를 확보한 뒤 기다린다 — 대기 중 연결이 끊겨도 --resume 할 id 를 알 수 있게.
  // 같은 질문을 다시 실행하면(재시도) requestId(질문 본문의 해시)로 중복 생성을 막는다.
  if (group === "orch" && cmd === "ask" && flags.resume === undefined) {
    const question = flags.question !== undefined ? readStdinIfDash(String(flags.question)) : undefined;
    if (!question) return fail(t("questionRequired"), "bad_request");
    const requestId = flags.requestId ?? require("crypto").createHash("sha1").update(String(flags.dispatch) + "\n" + question).digest("hex").slice(0, 16);
    const base = { run: flags.run, dispatch: flags.dispatch, capability: flags.capability, requestId };
    let created;
    try {
      created = await request("orch.ask", { ...base, question, options: flags.options, wait: false }, 30000);
    } catch (e) {
      return fail(e.message, e.code || "transport");
    }
    if (created.error) return fail(created.error.message, created.error.code || "error");
    if (created.result.state === "answered") return out(created.result);
    const messageId = created.result.messageId;
    try {
      const waited = await request("orch.ask", { ...base, resume: messageId, timeoutMs }, (timeoutMs ?? 600000) + 15000);
      if (waited.error) return fail(t("resumeAfterError", { message: waited.error.message, id: messageId }), waited.error.code || "error");
      return out(waited.result);
    } catch (e) {
      return fail(t("resumeAfterTransport", { message: e.message, id: messageId }), e.code || "transport");
    }
  }

  let method;
  let params = {};
  if (group === "status" && !cmd) method = "status";
  else if (group === "ws" && cmd === "list") method = "ws.list";
  else if (group === "ws" && cmd === "add") { method = "ws.add"; params = { path: flags.path }; }
  else if (group === "tab" && cmd === "list") { method = "tab.list"; params = { workspace: flags.ws, all: flags.all === true }; }
  else if (group === "tab" && cmd === "new") {
    method = "tab.new";
    params = { workspace: flags.ws, cwd: flags.cwd, provider: flags.provider, policy: flags.policy, model: flags.model, title: flags.title, prompt: flags.prompt !== undefined ? readStdinIfDash(String(flags.prompt)) : undefined, activate: flags.activate === true };
  } else if (group === "tab" && cmd === "status") { method = "tab.status"; params = { tab: flags.tab }; }
  else if (group === "tab" && cmd === "send") {
    method = "tab.send";
    params = { tab: flags.tab, text: flags.text !== undefined ? readStdinIfDash(String(flags.text)) : undefined, wait: flags.wait === true, timeoutMs };
  } else if (group === "tab" && cmd === "wait") { method = "tab.wait"; params = { tab: flags.tab, timeoutMs }; }
  else if (group === "tab" && cmd === "read") { method = "tab.read"; params = { tab: flags.tab, last: flags.last !== undefined ? Number(flags.last) : undefined }; }
  else if (group === "tab" && cmd === "activate") { method = "tab.activate"; params = { tab: flags.tab }; }
  else if (group === "tab" && cmd === "close") { method = "tab.close"; params = { tab: flags.tab }; }
  else if (group === "tab" && cmd === "abort") { method = "tab.abort"; params = { tab: flags.tab }; }
  else if (group === "tab" && cmd === "verify") {
    method = "tab.verify";
    const cmds = flags.cmd === undefined ? undefined : (Array.isArray(flags.cmd) ? flags.cmd : [flags.cmd]).map(String);
    params = { tab: flags.tab, commands: cmds, wait: flags.wait === true, timeoutMs };
  } else if (group === "tab" && cmd === "verify-abort") { method = "tab.verify.abort"; params = { tab: flags.tab }; }
  else if (group === "schedule" && cmd) {
    const f = flags;
    method = "schedule." + cmd;
    params = {
      id: f.id, name: f.name, cron: f.cron, timezone: f.timezone,
      prompt: f.prompt !== undefined ? readStdinIfDash(String(f.prompt)) : undefined,
      provider: f.provider, policy: f.policy, model: f.model,
      tab: f.tab, workspace: f.workspace ?? f.ws, cwd: f.cwd, worktree: f.worktree === true,
      precheck: f.precheck, precheckTimeout: f.precheckTimeout, grace: f.grace,
      enabled: f.enabled,
    };
  }
  else if (group === "orch" && cmd) {
    method = "orch." + cmd;
    const f = flags;
    params = {
      run: f.run, key: f.key, objective: f.objective, coordinator: f.coordinator, spec: f.spec !== undefined ? readStdinIfDash(String(f.spec)) : undefined, task: f.task,
      agent: f.agent, model: f.model, policy: f.policy, cwd: f.cwd, worktree: f.worktree === true, requestId: f.requestId,
      dispatch: f.dispatch, capability: f.capability, type: f.type, to: f.to, subject: f.subject, body: f.body !== undefined ? readStdinIfDash(String(f.body)) : undefined,
      outcome: f.outcome, filesModified: f.filesModified, question: f.question, options: f.options, resume: f.resume, id: f.id, reason: f.reason,
      wait: f.wait === true, peek: f.peek === true, types: f.types, ack: f.ack, timeoutMs,
      deps: f.deps, ready: f.ready === true, terminal: f.terminal, resolution: f.resolution,
    };
  }
  else if (group === "tab" && cmd === "fanout") {
    method = "tab.fanout";
    const providers = flags.provider === undefined ? undefined : (Array.isArray(flags.provider) ? flags.provider : [flags.provider]).map(String);
    params = { tab: flags.tab, prompt: flags.prompt !== undefined ? readStdinIfDash(String(flags.prompt)) : undefined, providers, policy: flags.policy, wait: flags.wait === true, timeoutMs };
  }
  else if (group === "file" && cmd === "open") { method = "file.open"; params = { tab: flags.tab, path: flags.path, line: flags.line !== undefined ? Number(flags.line) : undefined }; }
  else if (group === "browser" && cmd === "open") { method = "browser.open"; params = { tab: flags.tab, url: flags.url }; }
  else if (group === "browser" && cmd === "read") { method = "browser.read"; params = { tab: flags.tab }; }
  else if (group === "browser" && cmd === "click") { method = "browser.click"; params = { tab: flags.tab, selector: flags.selector, text: flags.text }; }
  else if (group === "browser" && cmd === "fill") { method = "browser.fill"; params = { tab: flags.tab, selector: flags.selector, value: flags.value }; }
  else return fail(t("unknownCommand", { cmd: [group, cmd].filter(Boolean).join(" ") }), "unknown_command");

  // 부른 탭을 서버에 알려 준다 — 자기 탭을 기다리는 일을 막고, 새 탭은 부른 탭의 워크스페이스에 만든다
  if (selfTab && (method === "tab.wait" || method === "tab.send" || method === "tab.new")) params.caller = selfTab;
  for (const k of Object.keys(params)) if (params[k] === undefined) delete params[k];
  // --tab 을 안 주면 서버가 active 로 본다(선택자 규칙은 서버에)
  // 데드라인: 기다리는 명령은 서버 대기 시간(기본 10분) + 15초, 나머지는 30초
  const waits = method === "tab.wait" || method === "orch.ask" || ((method === "tab.send" || method === "tab.verify" || method === "tab.fanout" || method === "orch.check") && params.wait);
  const deadline = waits ? (timeoutMs ?? (method === "tab.verify" || method === "tab.fanout" ? 1800000 : method === "orch.check" ? 900000 : 600000)) + 15000 : 30000;
  let res;
  try {
    res = await request(method, params, deadline);
  } catch (e) {
    return fail(e.message, e.code || "transport");
  }
  if (res.error) return fail(res.error.message, res.error.code || "error");
  out(res.result);
}

// 앱 번들 안에서는 Contents/Resources/cli/ 옆의 app.asar 에 앱의 package.json 이 있다(Electron 은 node 로 돌 때도 asar 를 읽는다).
// 저장소에서 바로 실행하면 그 자리에 없으니 dev 다.
function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app.asar", "package.json"), "utf8")).version;
  } catch {
    return "dev";
  }
}

main().catch((e) => fail(e.message));
