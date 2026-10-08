// Windows 작업 표시줄 배지. Dock 배지처럼 숫자를 그릴 수는 없어(오버레이 아이콘은 16px 그림 한 장) 빨간 점으로 "응답이 필요하다" 만 알린다.
// 숫자는 오버레이 설명(화면 낭독기가 읽는다)에 넣는다.

/** 지름 size 의 빨간 원을 BGRA 비트맵으로(nativeImage.createFromBitmap 용). 가장자리는 부드럽게. */
export function dotBitmap(size = 16): Buffer {
  const buf = Buffer.alloc(size * size * 4);
  const r = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - r, y + 0.5 - r);
      const a = Math.max(0, Math.min(1, r - d));
      const i = (y * size + x) * 4;
      // BGRA, 미리 곱한 알파
      buf[i] = Math.round(0x30 * a);
      buf[i + 1] = Math.round(0x3b * a);
      buf[i + 2] = Math.round(0xff * a);
      buf[i + 3] = Math.round(0xff * a);
    }
  }
  return buf;
}
