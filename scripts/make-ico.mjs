#!/usr/bin/env node
// Windows ICO만 생성한다. macOS PNG·ICNS·Icon Composer 원본은 변경하지 않는다.
// Electron 이미지 처리를 사용해 Windows/macOS에서 같은 명령으로 재생성한다.
//
//   node scripts/make-ico.mjs
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(import.meta.dirname, "..");
const SRC = join(ROOT, "build/icon-1024.png");
const OUT = join(ROOT, "build/icon.ico");
const SIZES = [16, 24, 32, 48, 64, 128, 256];

if (!process.versions.electron) {
  const electron = createRequire(import.meta.url)("electron");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(electron, [fileURLToPath(import.meta.url)], { env, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

const { app, nativeImage } = createRequire(import.meta.url)("electron");
app.whenReady().then(() => {
try {
  const image = nativeImage.createFromBuffer(readFileSync(SRC));
  if (image.isEmpty()) throw new Error("Cannot decode icon source");
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap();
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (bitmap[(y * width + x) * 4 + 3] === 0) continue;
      left = Math.min(left, x); top = Math.min(top, y);
      right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
  }
  if (right < left) throw new Error("Icon source is fully transparent");
  // 32px 아이콘에서 약 30px를 사용하고 모서리가 잘리지 않을 여백을 남긴다.
  const side = Math.min(width, height, Math.ceil(Math.max(right - left + 1, bottom - top + 1) / (30 / 32)));
  const x = Math.max(0, Math.min(width - side, Math.round((left + right + 1 - side) / 2)));
  const y = Math.max(0, Math.min(height - side, Math.round((top + bottom + 1 - side) / 2)));
  const cropped = image.crop({ x, y, width: side, height: side });
  const images = SIZES.map((size) => {
    return { size, data: cropped.resize({ width: size, height: size, quality: "best" }).toPNG() };
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
  console.log(`${OUT}: crop ${x},${y},${side},${side}; ${SIZES.join("/")}px`);
  app.exit(0);
} catch (error) {
  console.error(error);
  app.exit(1);
}
});
