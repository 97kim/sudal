// 화면에 보여 줄 경로 모양. 경로를 다루는 로직이 아니라 표시용이다.

/** 마지막 이름. 끝의 / 는 무시하고, 남는 게 없으면(루트) 원래 값. */
export function baseName(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

/** 홈 폴더(/Users/<이름>)를 ~ 로 줄인다. */
export function shortenHome(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, "~");
}
