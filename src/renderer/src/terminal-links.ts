// 터미널 출력 속 파일 경로("src/a.ts:42")를 링크로 만들 때 쓰는 순수 로직.
// xterm 의 링크 좌표는 글자 인덱스가 아니라 셀이다 — 앞에 한글·이모지(2칸)가 있으면 인덱스를 그대로 쓰면 어긋난다.
import { toPosix } from "@shared/any-path";

/** IBufferCell 에서 필요한 것만. width 0 은 넓은 글자의 뒷칸이라 문자열에 나오지 않는다. */
export interface CellLike {
  chars: string;
  width: number;
}

/**
 * translateToString 이 만든 문자열의 [start, end) 를 1-based 셀 범위로. 빈 칸은 공백 한 글자, 넓은 글자는 chars 그대로(이모지는 2글자)를
 * 차지한다는 규칙으로 되짚는다. 못 찾으면 null(줄 끝 잘림 등).
 */
export function cellRangeFor(cells: CellLike[], start: number, end: number): { x1: number; x2: number } | null {
  if (end <= start) return null;
  let off = 0;
  let x1 = -1;
  let x2 = -1;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (c.width === 0) continue;
    const len = c.chars.length || 1;
    if (x1 < 0 && start >= off && start < off + len) x1 = i + 1;
    if (end - 1 >= off && end - 1 < off + len) {
      x2 = i + Math.max(1, c.width);
      break;
    }
    off += len;
  }
  return x1 > 0 && x2 > 0 ? { x1, x2 } : null;
}

/**
 * 존재 확인 캐시. 같은 (cwd, 참조) 는 한 번만 묻고, 못 찾은 결과는 잠깐만 기억한다 —
 * 방금 만든 파일이 계속 "없음" 으로 남으면 안 되니까.
 */
export function createLocateCache(
  locate: (ref: string) => Promise<string[]>,
  opts: { missTtlMs?: number; max?: number; now?: () => number } = {},
): (cwd: string, ref: string) => Promise<string[]> {
  const missTtl = opts.missTtlMs ?? 15_000;
  const max = opts.max ?? 1000;
  const now = opts.now ?? (() => Date.now());
  const map = new Map<string, { at: number; value: Promise<string[]> }>();
  return (cwd, ref) => {
    const key = `${cwd}\0${ref}`;
    const hit = map.get(key);
    if (hit) return hit.value;
    if (map.size >= max) map.clear();
    const at = now();
    const value = locate(ref).then(
      (r) => {
        // 못 찾은 것은 TTL 뒤에 다시 묻는다
        if (r.length === 0) setTimeoutSafe(() => {
          if (map.get(key)?.at === at) map.delete(key);
        }, missTtl);
        return r;
      },
      () => {
        map.delete(key);
        return [] as string[];
      },
    );
    map.set(key, { at, value });
    return value;
  };
}

function setTimeoutSafe(fn: () => void, ms: number) {
  const t = setTimeout(fn, ms);
  // 테스트(node)에서 프로세스를 붙들지 않게
  (t as unknown as { unref?: () => void }).unref?.();
}

/** 후보가 여럿이면 참조와 꼬리가 정확히 맞는 것을, 없으면 첫 후보를. */
export function pickCandidate(candidates: string[], ref: string): string | null {
  if (candidates.length === 0) return null;
  // Windows 후보는 \ 로 나뉘어 온다 — 양쪽을 / 로 맞춰 비교한다
  const tail = toPosix(ref).replace(/^(\.\.?\/)+/, "").replace(/^\/+/, "");
  return candidates.find((c) => toPosix(c) === tail || toPosix(c).endsWith("/" + tail)) ?? candidates[0];
}
