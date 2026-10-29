import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 변경 사항은 사람이 한국어로 쓰고 설치 안내는 모든 버전에서 같은 원본을 쓴다. */
export function releaseNotes(version, root = process.cwd()) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('릴리즈 노트 버전 형식이 잘못됐습니다.');
  const file = join(root, 'release-notes', `${version}.md`);
  let changes;
  try { changes = readFileSync(file, 'utf8').trim(); }
  catch { throw new Error(`릴리즈 전에 release-notes/${version}.md에 사용자에게 보여 줄 변경 사항을 작성하세요.`); }
  if (!/^-\s+\S/m.test(changes) || /^#/m.test(changes)) throw new Error(`${file}: 제목 없이 변경 사항을 글머리표로 작성하세요.`);
  const install = readFileSync(join(root, 'release-notes', 'INSTALL.md'), 'utf8').trim().replaceAll('{{version}}', version);
  return `## 이번에 달라진 것\n\n${changes}\n\n${install}\n`;
}
