import { test } from "node:test";
import assert from "node:assert/strict";
import type { Root, Element } from "hast";
import { prepareVisualizeMarkdown } from "./visualize-ref";
import { rehypeVisualizeRefs } from "./rehype-visualize";
const marker = (path: string, title?: string) => `\uE200visualize\uE202${JSON.stringify({ path, title })}\uE201`;

test("protects Windows escapes, underscores and adjacent/inline previews before Markdown parsing", () => {
  const first = marker("C:\\work\\my_app\\preview_one.html", "  ");
  const second = marker("/work/my_app/preview_two.html", " Preview ");
  const prepared = prepareVisualizeMarkdown(`시안입니다.\n${first}\n${second} 뒤`);
  assert.equal(prepared.replacements.length, 2);
  assert.equal(prepared.text.includes("my_app"), false);
  assert.equal(prepared.replacements[0].title, undefined);
  assert.equal(prepared.replacements[1].title, "Preview");
  const tree: Root = { type: "root", children: [{ type: "element", tagName: "p", properties: {}, children: [{ type: "text", value: prepared.text }] }] };
  rehypeVisualizeRefs(prepared.replacements)(tree);
  const children = (tree.children[0] as Element).children;
  const previews = children.filter((node): node is Element => node.type === "element");
  assert.deepEqual(previews.map(node => node.properties.dataVisualizePath), ["C:\\work\\my_app\\preview_one.html", "/work/my_app/preview_two.html"]);
  assert.equal((children.at(-1) as { value: string }).value, " 뒤");
});
test("restores literal markers inside code and links without making preview controls", () => {
  const original = marker("C:\\work\\preview_one.html");
  const prepared = prepareVisualizeMarkdown(original);
  for (const tagName of ["code", "pre", "a"]) {
    const tree: Root = { type: "root", children: [{ type: "element", tagName, properties: {}, children: [{ type: "text", value: prepared.text }] }] };
    rehypeVisualizeRefs(prepared.replacements)(tree);
    assert.deepEqual((tree.children[0] as Element).children, [{ type: "text", value: original }]);
  }
});
test("generated tokens cannot collide with tokens already present in the answer", () => {
  const prefix = "\uE200sudalpreview0z\uE201";
  const prepared = prepareVisualizeMarkdown(prefix + marker("/work/preview.html"));
  assert.notEqual(prepared.replacements[0].token, prefix);
  assert.equal(prepared.text.startsWith(prefix), true);
});
