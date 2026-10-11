import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { localFileHref } from "@shared/file-refs";
import { locateFiles, readFileView } from "../../main/files";
import { loadMarkdownImage, markdownUrlTransform } from "./markdown-image";

test("마크다운의 Windows 경로·인코딩된 이미지 링크는 로컬 파일로 전달한다", () => {
  for (const path of ["C:/Users/me/개발/작은 눈.gif", "C:\\Users\\me\\작은 눈.png", "images/작은 눈.gif"]) {
    const refs: string[] = [];
    renderToStaticMarkup(createElement(ReactMarkdown, {
      children: `![image](<${path}>) [preview](<${path}>)`,
      urlTransform: markdownUrlTransform,
      components: {
        img: ({ src }) => { refs.push(String(src)); return null; },
        a: ({ href }) => { refs.push(String(href)); return null; },
      },
    }));
    assert.equal(refs.length, 2);
    for (const ref of refs) assert.deepEqual(localFileHref(ref), { path });
  }
  for (const url of ["javascript:alert(1)", "data:text/html,test", "vscode://file/test"]) {
    assert.equal(markdownUrlTransform(url), "");
  }
});

test("채팅 PNG/GIF: 마크다운 URL → 실제 파일 찾기 → 에디터와 같은 data URL 읽기", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "sudal-markdown-image-"));
  try {
    const files = {
      locate: (cwd: string, path: string) => locateFiles(cwd, path, process.env),
      read: (cwd: string, path: string) => readFileView(cwd, path, process.env),
      remoteImage: async () => null,
    };
    for (const [ext, mime, encoded] of [
      ["gif", "image/gif", "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"],
      ["png", "image/png", "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII="],
    ]) {
      const name = `수대리 작은 눈.${ext}`;
      const path = join(cwd, name);
      await writeFile(path, Buffer.from(encoded, "base64"));
      for (const src of [path, encodeURI(path.replace(/\\/g, "/")), encodeURI(name), pathToFileURL(path).href]) {
        assert.equal(await loadMarkdownImage(src, { cwd }, files), `data:${mime};base64,${encoded}`, src);
        const ref = localFileHref(markdownUrlTransform(src));
        assert.ok(ref);
        const found = await files.locate(cwd, ref.path);
        assert.equal(found.length, 1);
        assert.equal((await files.read(cwd, found[0])).image?.mime, mime);
      }
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("문서 상대 이미지·저장소 루트 이미지·원격 이미지와 실패 처리를 유지한다", async () => {
  const paths: string[] = [];
  const files = {
    locate: async () => [] as string[],
    read: async (_cwd: string, path: string) => { paths.push(path); return { image: { mime: "image/png", dataUrl: "data:image/png;base64,AA==" } }; },
    remoteImage: async (src: string) => src === "https://example.com/a.png" ? "remote-data" : null,
  };
  const base = { cwd: "C:/repo", file: "C:/repo/docs/README.md" };
  await loadMarkdownImage("../images/a.png", base, files);
  await loadMarkdownImage("/images/a.png", base, files);
  assert.deepEqual(paths, ["C:/repo/images/a.png", "C:/repo/images/a.png"]);
  assert.equal(await loadMarkdownImage("https://example.com/a.png", base, files), "remote-data");
  for (const src of ["missing.png", "javascript:alert(1)", "%E0%A4%A.png"]) {
    assert.equal(await loadMarkdownImage(src, { cwd: base.cwd }, files), null);
  }
});
