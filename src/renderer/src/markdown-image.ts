import { defaultUrlTransform } from "react-markdown";
import { localFileHref } from "@shared/file-refs";
import { dirnameAny } from "@shared/any-path";
import type { FileViewDto } from "@shared/ipc";
import { resolveUnder } from "./doc-path";

export interface ImageBase {
  cwd: string;
  /** 문서 미리보기이면 문서 경로, 채팅이면 생략. */
  file?: string;
}

/** Windows 드라이브는 URL 스킴이 아니다. 나머지 스킴 필터는 유지한다. */
export function markdownUrlTransform(url: string): string {
  return /^file:/i.test(url) || /^[A-Za-z]:(?:[\\/]|%5c|%2f)/i.test(url) ? url : defaultUrlTransform(url);
}

interface ImageFiles {
  read(cwd: string, path: string): Promise<Pick<FileViewDto, "image">>;
  locate(cwd: string, path: string): Promise<string[]>;
  remoteImage(url: string): Promise<string | null>;
}

/** CSP를 풀지 않고 main에서 읽은 이미지 data URL만 표시한다. */
export async function loadMarkdownImage(src: string, base: ImageBase, files: ImageFiles): Promise<string | null> {
  if (/^https?:/i.test(src)) return files.remoteImage(src);
  const local = localFileHref(src.replace(/[?#].*$/, ""));
  if (!local) return null;
  let path = local.path;
  if (base.file && !/^file:/i.test(src) && !/^(?:[A-Za-z]:[\\/]|\\\\|~[\\/])/.test(path)) {
    // 문서의 /images/... 는 기존처럼 저장소 루트 기준이다.
    path = resolveUnder(path.startsWith("/") ? base.cwd : dirnameAny(base.file), path);
  } else {
    const found = await files.locate(base.cwd, path);
    if (found.length !== 1) return null;
    path = found[0];
  }
  return (await files.read(base.cwd, path)).image?.dataUrl ?? null;
}
