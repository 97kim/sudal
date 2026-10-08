#!/usr/bin/env node
// build/icon-1024.png 로 Windows 아이콘(build/icon.ico)을 만든다. 결과 파일은 커밋하므로 아이콘을 바꿀 때만 돌린다.
// 크기별 PNG 는 macOS 의 sips 로 줄이고, ICO 는 PNG 를 그대로 담는 형식(Vista 이후)이라 헤더만 직접 쓴다 — 의존성을 늘리지 않으려고.
//
//   node scripts/make-ico.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SRC = join(ROOT, "build/icon-1024.png");
const OUT = join(ROOT, "build/icon.ico");
const SIZES = [16, 24, 32, 48, 64, 128, 256];

const tmp = mkdtempSync(join(tmpdir(), "sudal-ico-"));
try {
  const images = SIZES.map((size) => {
    const file = join(tmp, `${size}.png`);
    execFileSync("sips", ["-z", String(size), String(size), SRC, "--out", file], { stdio: "ignore" });
    return { size, data: readFileSync(file) };
  });

  // ICONDIR(6바이트) + 이미지마다 ICONDIRENTRY(16바이트), 그 뒤에 PNG 들을 차례로 붙인다
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // 1 = 아이콘
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    // 256 은 한 바이트에 담기지 않아 0 으로 적는다(형식의 약속)
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt8(0, e + 2); // 팔레트 없음
    header.writeUInt8(0, e + 3);
    header.writeUInt16LE(1, e + 4); // 색 평면
    header.writeUInt16LE(32, e + 6); // 픽셀당 비트
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  writeFileSync(OUT, Buffer.concat([header, ...images.map((i) => i.data)]));
  console.log(`${OUT} (${SIZES.join("·")}px, ${offset} bytes)`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
