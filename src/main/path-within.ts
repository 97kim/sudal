import { isAbsolute, relative, sep } from "node:path";

/**
 * relative(root, p) 의 결과가 root 자신이거나 그 안을 가리키는지.
 * "..foo" 같은 이름의 하위 폴더를 밖으로 잘못 보지 않도록 ".." 한 단계 전체만 바깥으로 본다.
 */
export function isInsideRel(rel: string): boolean {
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** p 가 root 와 같거나 root 안에 있는지. */
export function isWithin(root: string, p: string): boolean {
  return isInsideRel(relative(root, p));
}
