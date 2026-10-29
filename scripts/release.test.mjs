import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseVersion, newerVersion } from './release.mjs';
import { releaseFiles, validateTag, verifyAssets, caskText } from './release-ci.mjs';
import { releaseNotes } from './release-notes.mjs';

test('릴리즈 노트는 기존 한국어 제목·설치 안내와 버전에 맞는 파일 이름을 사용한다', () => {
  for (const version of ['0.15.0', '0.15.1']) {
    const notes = releaseNotes(version);
    assert.deepEqual(notes.match(/^## .+$/gm), ['## 이번에 달라진 것', '## 설치', '## Windows에 설치하기', '## 필요한 것']);
    assert.ok(notes.includes(`sudal-${version}-x64.exe`));
    assert.ok(notes.includes('brew upgrade --cask sudal'));
    assert.ok(notes.includes('xattr -d com.apple.quarantine'));
    assert.ok(notes.includes('`agy`'));
    assert.ok(!notes.includes("What's Changed") && !notes.includes('{{version}}'));
  }
  assert.throws(() => releaseNotes('../0.15.0'), /버전/);
  assert.throws(() => releaseNotes('99.0.0'), /변경 사항/);
});

test('정식 버전만 허용하고 숫자 단위로 대소를 비교한다', () => {
  for (const bad of ['v1.2.3', '01.2.3', '1.2.3-beta', '1.2', '1.2.3\n', '1.2.3;echo x', '99999999999999999.0.0']) assert.throws(() => parseVersion(bad));
  assert.deepEqual(parseVersion('0.15.0'), [0, 15, 0]);
  assert.ok(newerVersion('0.15.0', '0.14.12'));
  assert.ok(newerVersion('0.14.12', '0.14.9'));
  assert.equal(newerVersion('0.14.12', '0.14.12'), false);
  assert.equal(newerVersion('0.14.12', '0.15.0'), false);
});

test('태그와 package.json 버전이 다르면 공개를 막는다', () => {
  validateTag('v0.15.0', '0.15.0');
  for (const tag of ['v0.14.12', 'main', '--help', 'v0.15.0\n']) assert.throws(() => validateTag(tag, '0.15.0'));
});

test('두 OS의 파일과 Windows 업데이트 메타데이터가 일치해야 한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sudal-release-assets-'));
  const version = '0.15.0';
  const files = releaseFiles(version);
  try {
    for (const name of files) writeFileSync(join(dir, name), 'fixture');
    const sha = createHash('sha512').update('fixture').digest('base64');
    const metadata = `version: ${version}\npath: ${files[1]}\nsha512: ${sha}\n`;
    writeFileSync(join(dir, 'latest.yml'), metadata);
    assert.deepEqual(verifyAssets(dir, version), files);
    writeFileSync(join(dir, 'latest.yml'), metadata.replace(version, '0.14.12'));
    assert.throws(() => verifyAssets(dir, version), /버전/);
    writeFileSync(join(dir, 'latest.yml'), metadata.replace(files[1], 'other.exe'));
    assert.throws(() => verifyAssets(dir, version), /경로/);
    writeFileSync(join(dir, 'latest.yml'), metadata);
    writeFileSync(join(dir, files[1]), 'tampered');
    assert.throws(() => verifyAssets(dir, version), /체크섬/);
    writeFileSync(join(dir, files[0]), '');
    assert.throws(() => verifyAssets(dir, version), /빈 릴리즈/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Homebrew가 공개 DMG 버전과 체크섬을 사용한다', () => {
  const sha = 'a'.repeat(64);
  const cask = caskText('0.15.0', sha, '97kim/sudal');
  assert.match(cask, /version "0.15.0"/);
  assert.ok(cask.includes(`sha256 "${sha}"`));
  assert.match(cask, /depends_on arch: :arm64/);
  assert.match(cask, /github\.com\/97kim\/sudal\/releases\/download\/v#\{version\}/);
  assert.throws(() => caskText('0.15.0', 'bad', '97kim/sudal'));
});

test('dry-run은 변경 없이 끝나고 실제 실행은 버전 커밋과 태그를 함께 push한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sudal-release-git-'));
  const remote = join(dir, 'remote.git'), repo = join(dir, 'repo');
  const run = (cmd, args, cwd = dir) => {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    return r.stdout.trim();
  };
  try {
    run('git', ['init', '--bare', remote]);
    run('git', ['clone', remote, repo]);
    run('git', ['checkout', '-b', 'main'], repo);
    run('git', ['config', 'user.name', 'Release test'], repo);
    run('git', ['config', 'user.email', 'release-test@example.invalid'], repo);
    writeFileSync(join(repo, 'package.json'), JSON.stringify({version: '0.14.12'}) + '\n');
    mkdirSync(join(repo, 'release-notes'));
    writeFileSync(join(repo, 'release-notes', 'INSTALL.md'), '## 설치\n\nsudal-{{version}}-x64.exe\n');
    writeFileSync(join(repo, 'release-notes', '0.15.0.md'), '- 사용자 변경 사항\n');
    run('git', ['add', 'package.json', 'release-notes'], repo);
    run('git', ['commit', '-m', 'initial'], repo);
    run('git', ['push', '-u', 'origin', 'main'], repo);
    const entry = pathToFileURL(join(import.meta.dirname, 'release.mjs')).href;
    const call = args => run(process.execPath, ['--input-type=module', '-e', `import {startRelease} from ${JSON.stringify(entry)}; startRelease(${JSON.stringify(args)});`], repo);
    const before = run('git', ['rev-parse', 'HEAD'], repo);
    call(['0.15.0', '--dry-run']);
    assert.equal(run('git', ['rev-parse', 'HEAD'], repo), before);
    assert.equal(run('git', ['tag'], repo), '');
    assert.equal(JSON.parse(readFileSync(join(repo, 'package.json'))).version, '0.14.12');
    const missingNotes = spawnSync(process.execPath, ['--input-type=module', '-e', `import {startRelease} from ${JSON.stringify(entry)}; startRelease(['0.15.1']);`], { cwd: repo, encoding: 'utf8' });
    assert.notEqual(missingNotes.status, 0);
    assert.match(missingNotes.stderr, /release-notes\/0.15.1.md/);
    assert.equal(run('git', ['rev-parse', 'HEAD'], repo), before);
    assert.equal(run('git', ['tag'], repo), '');
    call(['0.15.0']);
    assert.equal(JSON.parse(readFileSync(join(repo, 'package.json'))).version, '0.15.0');
    assert.equal(run('git', ['rev-parse', 'HEAD'], repo), run('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/main']));
    assert.equal(run('git', ['--git-dir', remote, 'rev-parse', 'v0.15.0^{commit}']), run('git', ['rev-parse', 'HEAD'], repo));
    const output = join(dir, 'outputs');
    const prepare = (tag, publish = 'false') => spawnSync(process.execPath, [join(import.meta.dirname, 'release-ci.mjs'), 'prepare'], {
      cwd: repo, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', RELEASE_TAG: tag,
        INPUT_PUBLISH: publish, HOMEBREW_TAP_TOKEN: '', GITHUB_OUTPUT: output },
    });
    assert.equal(prepare('v0.15.0').status, 0);
    assert.match(readFileSync(output, 'utf8'), /version=0.15.0\nsha=[a-f0-9]+\npublish=false/);
    const noToken = prepare('v0.15.0', 'true');
    assert.notEqual(noToken.status, 0);
    assert.match(noToken.stderr, /HOMEBREW_TAP_TOKEN/);
    run('git', ['tag', 'v0.15.1'], repo);
    assert.notEqual(prepare('v0.15.1').status, 0, '태그/manifest 불일치를 막는다');
    assert.notEqual(prepare('main').status, 0, '임의 ref는 받지 않는다');
    run('git', ['checkout', '-b', 'unmerged'], repo);
    writeFileSync(join(repo, 'package.json'), JSON.stringify({version: '0.16.0'}) + '\n');
    run('git', ['commit', '-am', 'unmerged'], repo);
    run('git', ['tag', 'v0.16.0'], repo);
    assert.notEqual(prepare('v0.16.0').status, 0, 'main에 없는 태그는 빌드하지 않는다');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
