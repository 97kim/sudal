import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_EDITOR_FILES,
  closeEditorFile,
  closeEditorPaths,
  dirtyEditorPathsUnder,
  forgetEditorTabs,
  getEditorTabs,
  openEditorFile,
  renameEditorPaths,
  setEditorFileDirty,
  isBrowserTab,
  openBrowserTab,
  getEditorDraft,
  setEditorDraft,
} from "./editor-tabs";

test("미저장 본문(draft): 닫으면 버리되 다른 탭이 편집 중이면 남기고, 이름 변경은 따라가고, 삭제는 지운다", () => {
  const a = "tab-draft-a";
  const b = "tab-draft-b";
  openEditorFile(a, "/r/x.ts");
  openEditorFile(b, "/r/x.ts");
  setEditorFileDirty(a, "/r/x.ts", true);
  setEditorFileDirty(b, "/r/x.ts", true);
  setEditorDraft("/r/x.ts", { text: "typing", mtimeMs: 1, size: 6 });
  assert.deepEqual(getEditorDraft("/r/x.ts"), { text: "typing", mtimeMs: 1, size: 6 });
  // a 가 버리고 닫아도 b 가 아직 편집 중 → 남는다
  setEditorFileDirty(a, "/r/x.ts", false);
  closeEditorFile(a, "/r/x.ts");
  assert.ok(getEditorDraft("/r/x.ts"));
  // 이름 변경은 draft 키도 따라간다
  renameEditorPaths("/r", "/s");
  assert.equal(getEditorDraft("/r/x.ts"), null);
  assert.equal(getEditorDraft("/s/x.ts")?.text, "typing");
  // b 도 버리고 닫으면 사라진다
  setEditorFileDirty(b, "/s/x.ts", false);
  closeEditorFile(b, "/s/x.ts");
  assert.equal(getEditorDraft("/s/x.ts"), null);
  // 파일 삭제(폴더 prefix)는 draft 를 지운다
  openEditorFile(a, "/d/sub/y.ts");
  setEditorDraft("/d/sub/y.ts", { text: "t", mtimeMs: null, size: null });
  closeEditorPaths("/d");
  assert.equal(getEditorDraft("/d/sub/y.ts"), null);
  forgetEditorTabs(a);
  forgetEditorTabs(b);
});

test("openEditorFile: 상한을 넘으면 오래된 탭부터 닫되 dirty 탭은 건너뛴다", () => {
  const t = "tab-cap";
  for (let i = 0; i < MAX_EDITOR_FILES; i++) openEditorFile(t, `/r/f${i}.ts`);
  setEditorFileDirty(t, "/r/f0.ts", true);
  openEditorFile(t, "/r/new.ts");
  const st = getEditorTabs(t);
  assert.equal(st.files.length, MAX_EDITOR_FILES);
  assert.equal(st.files.includes("/r/f0.ts"), true, "dirty 인 맨 앞 탭은 남는다");
  assert.equal(st.files.includes("/r/f1.ts"), false, "그 다음 오래된 탭이 닫힌다");
  assert.equal(st.active, "/r/new.ts");
  // 전부 dirty 면 상한을 넘겨서라도 연다
  for (const f of st.files) setEditorFileDirty(t, f, true);
  openEditorFile(t, "/r/more.ts");
  assert.equal(getEditorTabs(t).files.length, MAX_EDITOR_FILES + 1);
  forgetEditorTabs(t);
  assert.deepEqual(getEditorTabs(t).files, []);
});

test("renameEditorPaths / closeEditorPaths: 폴더 prefix 로 따라가고, 닫힌 활성 탭은 이웃으로", () => {
  const t = "tab-rename";
  openEditorFile(t, "/r/a/x.ts");
  openEditorFile(t, "/r/a/y.ts");
  openEditorFile(t, "/r/b.ts");
  setEditorFileDirty(t, "/r/a/y.ts", true);
  renameEditorPaths("/r/a", "/r/c");
  assert.deepEqual(getEditorTabs(t).files, ["/r/c/x.ts", "/r/c/y.ts", "/r/b.ts"]);
  assert.deepEqual(getEditorTabs(t).dirty, ["/r/c/y.ts"]);
  assert.deepEqual(dirtyEditorPathsUnder("/r/c"), ["/r/c/y.ts"]);
  assert.deepEqual(dirtyEditorPathsUnder("/r/cx"), [], "prefix 가 아니라 경로 단위로 본다");
  // 가운데 활성 탭(y)이 지워지면 그 자리의 이웃(b)이 활성, 맨 끝 점프 아님
  openEditorFile(t, "/r/c/y.ts");
  openEditorFile(t, "/r/d.ts");
  openEditorFile(t, "/r/c/y.ts"); // 활성 = y (index 1)
  closeEditorPaths("/r/c/y.ts");
  const st = getEditorTabs(t);
  assert.deepEqual(st.files, ["/r/c/x.ts", "/r/b.ts", "/r/d.ts"]);
  assert.equal(st.active, "/r/b.ts");
  assert.deepEqual(st.dirty, []);
  // closeEditorFile 도 같은 규칙
  closeEditorFile(t, "/r/b.ts");
  assert.equal(getEditorTabs(t).active, "/r/d.ts");
  forgetEditorTabs(t);
});

test("openEditorFile: 줄 범위를 주면 reveal 이 새 nonce 로 바뀌고, 없이 다시 열면 유지된다", () => {
  const t = "tab-reveal";
  openEditorFile(t, "/r/a.ts", { line: 12, endLine: 20 });
  const r1 = getEditorTabs(t).reveal;
  assert.deepEqual(r1 && { path: r1.path, line: r1.line, endLine: r1.endLine }, { path: "/r/a.ts", line: 12, endLine: 20 });
  openEditorFile(t, "/r/a.ts", { line: 3 });
  const r2 = getEditorTabs(t).reveal!;
  assert.equal(r2.line, 3);
  assert.notEqual(r2.nonce, r1!.nonce);
  openEditorFile(t, "/r/a.ts");
  assert.equal(getEditorTabs(t).reveal, r2, "범위 없이 열면 이전 reveal 유지(다시 스크롤하지 않음)");
  openEditorFile(t, "/r/b.ts");
  assert.equal(getEditorTabs(t).reveal, null, "다른 파일을 열면 비운다");
  openEditorFile(t, "/r/c.ts", { line: 0 });
  assert.equal(getEditorTabs(t).reveal, null, "0 이하 줄은 무시");
  forgetEditorTabs(t);
});

test("브라우저 탭: URL 이나 browser:<n> 키로 열리고 파일 탭과 같은 목록에 산다", () => {
  const t = "tab-browser";
  openBrowserTab(t, "https://example.com/docs");
  openBrowserTab(t);
  openEditorFile(t, "/r/a.ts");
  const st = getEditorTabs(t);
  assert.equal(st.files.length, 3);
  assert.deepEqual(st.files.map(isBrowserTab), [true, true, false]);
  assert.equal(isBrowserTab("http://localhost:3000"), true);
  assert.equal(isBrowserTab("/r/https://x"), false);
  openBrowserTab(t, "not a url");
  assert.ok(getEditorTabs(t).files.at(-1)!.startsWith("browser:"), "URL 이 아니면 빈 탭");
  forgetEditorTabs(t);
});

test("Windows 경로: 표기가 달라도 같은 파일은 한 탭, 하위 판정·이름 변경도 \\ 를 따른다", () => {
  const id = "tab-win";
  openEditorFile(id, "C:\\r\\src\\a.ts");
  openEditorFile(id, "C:/r/src/a.ts");
  assert.deepEqual(getEditorTabs(id).files, ["C:\\r\\src\\a.ts"]);
  setEditorFileDirty(id, "C:\\r\\src\\a.ts", true);
  assert.deepEqual(dirtyEditorPathsUnder("C:\\r"), ["C:\\r\\src\\a.ts"]);
  assert.deepEqual(dirtyEditorPathsUnder("C:\\r\\sr"), [], "이름 앞부분만 같은 폴더는 아니다");
  renameEditorPaths("C:\\r\\src", "C:\\r\\lib");
  assert.deepEqual(getEditorTabs(id).files, ["C:\\r\\lib\\a.ts"]);
  closeEditorPaths("C:\\r");
  assert.deepEqual(getEditorTabs(id).files, []);
  forgetEditorTabs(id);
});
