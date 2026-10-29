// GitHub Actions 전용. 빌드·공개·Homebrew 갱신을 분리해 실패한 단계부터 재실행할 수 있게 한다.
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { git, newerVersion, parseVersion } from './release.mjs';
import { releaseNotes } from './release-notes.mjs';

export function releaseFiles(version) {
  parseVersion(version);
  const exe = `sudal-${version}-x64.exe`;
  return [`sudal-${version}-arm64.dmg`, exe, `${exe}.blockmap`, 'latest.yml'];
}

export function validateTag(tag, version) {
  parseVersion(version);
  if (tag !== `v${version}`) throw new Error(`태그 ${tag}와 package.json 버전 ${version}이 다릅니다.`);
}

export function verifyAssets(dir, version) {
  const files = releaseFiles(version);
  for (const name of files) if (!statSync(join(dir, name)).isFile() || statSync(join(dir, name)).size === 0) throw new Error(`빈 릴리즈 파일: ${name}`);
  const metadata = readFileSync(join(dir, 'latest.yml'), 'utf8');
  const scalar = key => metadata.match(new RegExp(`^${key}:\\s*['\"]?([^'\"\\r\\n]+?)['\"]?\\s*$`, 'm'))?.[1];
  if (scalar('version') !== version || scalar('path') !== files[1]) throw new Error('latest.yml 버전 또는 설치 파일 경로가 다릅니다.');
  const digest = createHash('sha512').update(readFileSync(join(dir, files[1]))).digest('base64');
  if (scalar('sha512') !== digest) throw new Error('latest.yml의 Windows 설치 파일 체크섬이 다릅니다.');
  return files;
}

export function caskText(version, sha, repo) {
  parseVersion(version);
  if (!/^[a-f0-9]{64}$/.test(sha) || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Cask 체크섬 또는 저장소 형식이 잘못됐습니다.');
  return `cask "sudal" do
  version "${version}"
  sha256 "${sha}"

  url "https://github.com/${repo}/releases/download/v#{version}/sudal-#{version}-arm64.dmg"
  name "Sudal"
  desc "Desktop workspace for coding agents"
  homepage "https://github.com/${repo}"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on arch: :arm64
  app "Sudal.app"

  zap trash: [
    "~/Library/Application Support/Sudal",
    "~/Library/Preferences/io.github.97kim.sudal.plist",
    "~/Library/Saved Application State/io.github.97kim.sudal.savedState",
  ]

  caveats <<~CAVEATS
    서명과 공증을 하지 않은 앱이라 처음 열 때 macOS가 막아요.
    시스템 설정 → 개인정보 보호 및 보안에서 허용하거나 다음을 실행하세요.
      xattr -d com.apple.quarantine #{appdir}/Sudal.app
  CAVEATS
end
`;
}

function gh(...args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(r.stderr?.trim() || 'GitHub CLI 요청 실패');
  return r.stdout.trim();
}

async function api(path, token, method = 'GET', body) {
  const response = await fetch(`https://api.github.com/${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`GitHub API ${method} ${path}: HTTP ${response.status}`);
  return response.json();
}

async function main(command) {
  let version = JSON.parse(readFileSync('package.json', 'utf8')).version;
  parseVersion(version);
  const repo = process.env.GITHUB_REPOSITORY;
  const tag = process.env.RELEASE_TAG;
  const dir = 'release';
  if (command === 'prepare') {
    const publish = process.env.GITHUB_EVENT_NAME === 'push' || process.env.INPUT_PUBLISH === 'true';
    let sha = git('rev-parse', 'HEAD');
    if (process.env.GITHUB_EVENT_NAME !== 'pull_request') {
      if (!tag?.startsWith('v')) throw new Error('v로 시작하는 버전 태그가 필요합니다.');
      parseVersion(tag.slice(1));
      sha = git('rev-parse', `refs/tags/${tag}^{commit}`);
      git('merge-base', '--is-ancestor', sha, 'origin/main');
      version = JSON.parse(git('show', `${sha}:package.json`)).version;
      validateTag(tag, version);
    }
    if (publish) {
      if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' && process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('수동 공개는 main 워크플로에서만 가능합니다.');
      validateTag(tag, version);
      if (!process.env.HOMEBREW_TAP_TOKEN) throw new Error('저장소 Actions secret HOMEBREW_TAP_TOKEN을 등록하세요 (97kim/homebrew-sudal Contents: read/write).');
      const tap = await api('repos/97kim/homebrew-sudal/contents/Casks/sudal.rb', process.env.HOMEBREW_TAP_TOKEN);
      const oldVersion = Buffer.from(tap.content, 'base64').toString('utf8').match(/version "([^"]+)"/)?.[1];
      if (oldVersion && newerVersion(oldVersion, version)) throw new Error('이미 배포된 Homebrew 버전보다 낮은 버전을 공개할 수 없습니다.');
    }
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\nsha=${sha}\npublish=${publish}\ntag=${publish ? tag : ''}\n`);
  } else if (command === 'verify') {
    const files = verifyAssets(dir, version);
    const hashes = files.map(name => `${createHash('sha256').update(readFileSync(join(dir, name))).digest('hex')}  ${name}`);
    writeFileSync(join(dir, 'SHA256SUMS'), hashes.join('\n') + '\n');
    writeFileSync(join(dir, 'sudal.rb'), caskText(version, hashes[0].split(' ')[0], repo));
  } else if (command === 'publish') {
    validateTag(tag, version);
    const files = [...verifyAssets(dir, version), 'SHA256SUMS', 'sudal.rb'];
    // 릴리즈가 없는 404만 새 릴리즈로 취급한다. 인증·네트워크 오류를 덮지 않는다.
    const releases = JSON.parse(gh('api', `repos/${repo}/releases?per_page=100`));
    if (releases.some(r => !r.draft && !r.prerelease && /^v\d+\.\d+\.\d+$/.test(r.tag_name) && newerVersion(r.tag_name.slice(1), version))) {
      throw new Error('이미 공개된 버전보다 낮은 릴리즈를 latest로 지정하지 않습니다.');
    }
    const existing = releases.find(r => r.tag_name === tag);
    if (existing && !existing.draft) {
      for (const name of files) if (!existing.assets.some(a => a.name === name)) throw new Error(`공개된 릴리즈에 ${name}이 없습니다. 기존 릴리즈를 확인하세요.`);
      console.log(`${tag}는 이미 공개됐습니다. Homebrew 갱신부터 이어갑니다.`);
      return;
    }
    if (!existing) {
      const notes = releaseNotes(version);
      writeFileSync(join(dir, 'release-notes.md'), notes);
      gh('release', 'create', tag, '--repo', repo, '--verify-tag', '--draft', '--title', tag, '--notes-file', join(dir, 'release-notes.md'));
    }
    gh('release', 'upload', tag, ...files.map(name => join(dir, name)), '--repo', repo, '--clobber');
    gh('release', 'edit', tag, '--repo', repo, '--draft=false', '--latest');
  } else if (command === 'tap') {
    validateTag(tag, version);
    // 공개된 DMG의 실제 바이트로 체크섬을 만든다. publish 단계 재시도 시 새 빌드와 혼동하지 않는다.
    mkdirSync(dir, { recursive: true });
    gh('release', 'download', tag, '--repo', repo, '--pattern', releaseFiles(version)[0], '--dir', dir, '--clobber');
    const sha = createHash('sha256').update(readFileSync(join(dir, releaseFiles(version)[0]))).digest('hex');
    const content = caskText(version, sha, repo);
    const path = 'repos/97kim/homebrew-sudal/contents/Casks/sudal.rb';
    const current = await api(path, process.env.HOMEBREW_TAP_TOKEN);
    const old = Buffer.from(current.content, 'base64').toString('utf8');
    const oldVersion = old.match(/version "([^"]+)"/)?.[1];
    if (oldVersion && newerVersion(oldVersion, version)) throw new Error('Homebrew를 이전 버전으로 되돌리지 않습니다.');
    if (old === content) return;
    await api(path, process.env.HOMEBREW_TAP_TOKEN, 'PUT', { message: `Sudal ${version}`, content: Buffer.from(content).toString('base64'), sha: current.sha });
  } else throw new Error(`알 수 없는 릴리즈 명령: ${command}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch(e => { console.error(e.message); process.exitCode = 1; });
}
