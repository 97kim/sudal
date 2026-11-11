// Actions에서 버전 커밋·태그를 만든 후 기존 빌드·배포 워크플로를 명시적으로 시작한다.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, newerVersion, parseVersion, startRelease } from './release.mjs';
import { releaseNotes } from './release-notes.mjs';

async function request(path, token, method = 'GET', body) {
  const response = await fetch(`https://api.github.com/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(30_000),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`GitHub API ${method} ${path}: HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}

export async function startReleaseAction(env = process.env, deps = {}) {
  const version = env.RELEASE_VERSION;
  parseVersion(version);
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/main') throw new Error('main에서 수동 실행하세요.');
  const repo = env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !env.GH_TOKEN) throw new Error('GitHub 저장소와 GH_TOKEN이 필요합니다.');
  if (!env.HOMEBREW_TAP_TOKEN) throw new Error('HOMEBREW_TAP_TOKEN을 등록하세요.');
  if (env.DRY_RUN) throw new Error('start-release에서는 DRY_RUN을 사용할 수 없습니다.');
  const current = deps.currentVersion?.() ?? JSON.parse(readFileSync('package.json', 'utf8')).version;
  if (!newerVersion(version, current)) throw new Error('새 버전은 현재 버전보다 커야 합니다. 기존 태그 재배포는 release 워크플로를 사용하세요.');
  releaseNotes(version);
  const sha = deps.head?.() ?? git('rev-parse', 'HEAD');
  if (!env.GITHUB_SHA || sha !== env.GITHUB_SHA) throw new Error('실행 대기 중 main이 변경됐습니다. 최신 main에서 다시 실행하세요.');
  const call = deps.request ?? request;
  const runs = await call(`repos/${repo}/actions/workflows/test.yml/runs?branch=main&event=push&head_sha=${sha}&per_page=10`, env.GH_TOKEN);
  const ci = runs.workflow_runs?.find(run => run.head_sha === sha);
  if (ci?.status !== 'completed' || ci.conclusion !== 'success') throw new Error('현재 main 커밋의 test CI가 통과한 뒤 다시 실행하세요.');
  // The shared release script verifies a clean main, origin/main and tag absence,
  // then atomically pushes the version commit and tag without rewriting history.
  (deps.release ?? startRelease)([version]);
  const tag = `v${version}`;
  try {
    // GITHUB_TOKEN pushes do not trigger tag workflows. workflow_dispatch does.
    await call(`repos/${repo}/actions/workflows/release.yml/dispatches`, env.GH_TOKEN, 'POST', {ref:'main', inputs:{tag, publish:'true'}});
  } catch (error) {
    throw new Error(`${tag} 생성 후 배포 실행 요청에 실패했습니다. release 워크플로를 main에서 tag=${tag}, publish=true로 수동 실행하세요. (${error.message})`);
  }
  console.log(`${tag} 버전·태그 생성 및 릴리즈 빌드 실행을 요청했습니다.`);
  return tag;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await startReleaseAction(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
