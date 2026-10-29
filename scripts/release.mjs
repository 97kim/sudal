#!/usr/bin/env node
// Windows/macOS 모두 로컬 빌드 없이 버전 커밋·태그를 올려 Actions 릴리즈를 시작한다.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseNotes } from './release-notes.mjs';

export function parseVersion(value) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value ?? '')) throw new Error(`버전 형식은 x.y.z입니다: ${value}`);
  const parts = value.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error('버전 숫자가 너무 큽니다.');
  return parts;
}

export function newerVersion(next, current) {
  const a = parseVersion(next), b = parseVersion(current);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

export function git(...args) {
  const r = spawnSync('git', args, { encoding: 'utf8', windowsHide: true });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(r.stderr?.trim() || `git ${args.join(' ')} 실패`);
  return r.stdout.trim();
}

export function startRelease(args = process.argv.slice(2)) {
  const dryRun = args.includes('--dry-run') || Boolean(process.env.DRY_RUN);
  const versions = args.filter(a => a !== '--dry-run');
  if (versions.length > 1) throw new Error('사용법: yarn release [x.y.z] [--dry-run]');
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  const version = versions[0] ?? manifest.version;
  parseVersion(version);
  releaseNotes(version);
  if (versions[0] && !newerVersion(version, manifest.version)) throw new Error('새 버전은 현재 버전보다 커야 합니다.');
  if (git('branch', '--show-current') !== 'main') throw new Error('최신 main 브랜치에서 실행하세요.');
  if (git('status', '--porcelain')) throw new Error('작업 트리가 깨끗하지 않습니다. 먼저 커밋하세요.');
  git('fetch', 'origin', 'main');
  if (git('rev-parse', 'HEAD') !== git('rev-parse', 'refs/remotes/origin/main')) throw new Error('로컬 main과 origin/main이 다릅니다. git pull --ff-only 후 다시 실행하세요.');
  const tag = `v${version}`;
  if (git('tag', '--list', tag) || git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`)) throw new Error(`${tag} 태그가 이미 있습니다. 실패한 Actions 실행은 GitHub에서 재실행하세요.`);
  if (dryRun) {
    console.log(`[dry-run] ${tag}: 버전 커밋 → 태그 → main·태그 atomic push → GitHub Actions 빌드·배포`);
    return;
  }
  if (version !== manifest.version) {
    manifest.version = version;
    writeFileSync('package.json', JSON.stringify(manifest, null, 2) + '\n');
    git('add', 'package.json');
    git('commit', '-m', tag);
  }
  git('tag', '-a', tag, '-m', tag);
  git('push', '--atomic', 'origin', 'main', `refs/tags/${tag}`);
  console.log(`${tag} 릴리즈를 시작했습니다. GitHub Actions의 release 실행에서 결과를 확인하세요.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.chdir(fileURLToPath(new URL('..', import.meta.url)));
    startRelease();
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
