import { test } from "node:test";
import assert from "node:assert/strict";
import { codexAppSlug, codexMentionsFrom, filterCodexMentions, findCodexMentions, parseDollarQuery } from "./codex-mentions";

test("codexAppSlug: Codex CLI 와 같은 슬러그", () => {
  assert.equal(codexAppSlug("Google Drive"), "google-drive");
  assert.equal(codexAppSlug("  Linear!! "), "linear");
  assert.equal(codexAppSlug("노션"), "app");
});

test("codexMentionsFrom: 켜진 스킬과 쓸 수 있는 앱, 겹치는 앱 슬러그·스킬 이름과 같은 앱은 뺀다", () => {
  const skills = {
    data: [
      {
        cwd: "/r",
        skills: [
          { name: "sudal-cli", description: "긴 설명", interface: { shortDescription: "짧은 설명" }, path: "/s/sudal-cli/SKILL.md", enabled: true },
          { name: "off", description: "꺼짐", path: "/s/off/SKILL.md", enabled: false },
          { name: "linear", description: "스킬", path: "/s/linear/SKILL.md", enabled: true },
        ],
      },
    ],
  };
  const apps = {
    data: [
      { id: "google_drive", name: "Google Drive", description: "Drive", isAccessible: true, isEnabled: true },
      { id: "linear", name: "Linear", description: null, isAccessible: true, isEnabled: true },
      { id: "a1", name: "Twin", isAccessible: true, isEnabled: true },
      { id: "a2", name: "twin", isAccessible: true, isEnabled: true },
      { id: "x", name: "Locked", isAccessible: false, isEnabled: true },
    ],
  };
  assert.deepEqual(
    codexMentionsFrom(skills, apps).map((m) => [m.kind, m.name, m.description, m.path]),
    [
      ["skill", "sudal-cli", "짧은 설명", "/s/sudal-cli/SKILL.md"],
      ["skill", "linear", "스킬", "/s/linear/SKILL.md"],
      ["app", "google-drive", "Drive", "app://google_drive"],
    ],
  );
  assert.deepEqual(codexMentionsFrom(null, undefined), []);
});

test("findCodexMentions: 글 속 $이름 중 아는 것만, 겹치지 않게", () => {
  const list = codexMentionsFrom({ data: [{ skills: [{ name: "pdf", description: "", path: "/p" }] }] }, { data: [{ id: "g", name: "Gmail", isAccessible: true }] });
  assert.deepEqual(findCodexMentions("$pdf 로 $gmail 에서 받은 걸 정리. 다시 $pdf, $HOME 은 아님", list).map((m) => m.name), ["pdf", "gmail"]);
  // 플러그인 스킬은 이름에 ":" 가 있다
  const plugin = codexMentionsFrom({ data: [{ skills: [{ name: "event-agent:event-create", description: "", path: "/e" }] }] }, null);
  assert.deepEqual(findCodexMentions("$event-agent:event-create 로 만들어", plugin).map((m) => m.path), ["/e"]);
  assert.deepEqual(parseDollarQuery("$event-agent:ev"), { start: 0, query: "event-agent:ev" });
  assert.deepEqual(findCodexMentions("$pdf: 이걸 정리해", list).map((m) => m.name), ["pdf"]);
});

test("parseDollarQuery: 줄 처음이나 공백 뒤 $ 부터 커서까지", () => {
  assert.deepEqual(parseDollarQuery("$"), { start: 0, query: "" });
  assert.deepEqual(parseDollarQuery("이걸 $sud"), { start: 3, query: "sud" });
  assert.equal(parseDollarQuery("가격 10$"), null);
  assert.equal(parseDollarQuery("a$b"), null);
  assert.equal(parseDollarQuery("$pdf 끝"), null);
});

test("filterCodexMentions: 앞부분이 맞는 것 먼저", () => {
  const list = [
    { kind: "skill" as const, name: "my-pdf", description: "", path: "" },
    { kind: "skill" as const, name: "pdf", description: "", path: "" },
  ];
  assert.deepEqual(filterCodexMentions(list, "pd").map((m) => m.name), ["pdf", "my-pdf"]);
});
