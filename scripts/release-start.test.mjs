import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startReleaseAction } from './release-start.mjs';

// Action tests own their release notes so the next real release version can change.
const notesRoot = mkdtempSync(join(tmpdir(), 'sudal-actions-notes-'));
mkdirSync(join(notesRoot, 'release-notes'));
writeFileSync(join(notesRoot, 'release-notes', '0.20.6.md'), '- 테스트 변경 사항\n');
writeFileSync(join(notesRoot, 'release-notes', 'INSTALL.md'), '## 설치\n\nsudal-{{version}}-x64.exe\n');
after(() => rmSync(notesRoot, {recursive:true,force:true}));
const sha = 'a'.repeat(40);
const env = {RELEASE_VERSION:'0.20.6',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',GITHUB_REPOSITORY:'example/repo',GITHUB_SHA:sha,GH_TOKEN:'fixture',HOMEBREW_TAP_TOKEN:'fixture'};
function fixture(runs = [{head_sha:sha,status:'completed',conclusion:'success'}]) {
  const calls = [];
  return {calls, deps:{
    notesRoot,
    head:()=>sha, currentVersion:()=> '0.20.5',
    release:args=>calls.push({release:args}),
    request:async(path, _token, method, body)=> { calls.push({path, method, body}); return {workflow_runs:runs}; },
  }};
}

test('검증된 main의 버전·태그 생성 뒤 release를 명시적으로 한 번 호출한다', async () => {
  const {calls,deps}=fixture();
  assert.equal(await startReleaseAction(env,deps),'v0.20.6');
  assert.deepEqual(calls[1],{release:['0.20.6']});
  assert.match(calls[0].path,/test\.yml\/runs\?branch=main&event=push&head_sha=/);
  assert.deepEqual(calls[2],{path:'repos/example/repo/actions/workflows/release.yml/dispatches',method:'POST',body:{ref:'main',inputs:{tag:'v0.20.6',publish:'true'}}});
  assert.equal(calls.length,3);
});
test('실행 환경·버전·문서·커밋이 유효하지 않으면 태그를 만들지 않는다', async () => {
  for (const patch of [{GITHUB_REF:'refs/heads/feature'},{GITHUB_EVENT_NAME:'push'},{GH_TOKEN:''},{HOMEBREW_TAP_TOKEN:''},{RELEASE_VERSION:'0.20.5'},{RELEASE_VERSION:'0.20.6;echo bad'},{RELEASE_VERSION:'99.0.0'},{GITHUB_SHA:'b'.repeat(40)},{DRY_RUN:'1'}]) {
    const {calls,deps}=fixture();
    await assert.rejects(startReleaseAction({...env,...patch},deps));
    assert.equal(calls.length,0,JSON.stringify(patch));
  }
});
test('CI가 없거나 실행 중·실패·취소됐으면 태그를 만들지 않는다', async () => {
  for (const runs of [[],[{head_sha:'b'.repeat(40),status:'completed',conclusion:'success'}],...[['in_progress',null],['completed','failure'],['completed','cancelled']].map(([status,conclusion])=>[{head_sha:sha,status,conclusion}])]) {
    const {calls,deps}=fixture(runs);
    await assert.rejects(startReleaseAction(env,deps),/CI/);
    assert.equal(calls.length,1);
  }
});
test('태그 생성 실패 시 배포를 요청하지 않고, 배포 요청 실패 시 기존 태그 재실행 방법을 안내한다', async () => {
  const first=fixture();
  first.deps.release=()=>{throw Error('push failed');};
  await assert.rejects(startReleaseAction(env,first.deps),/push failed/);
  assert.equal(first.calls.length,1);
  const second=fixture();
  const request=second.deps.request;
  second.deps.request=async(...args)=>{if(args[2]==='POST')throw Error('network');return request(...args);};
  await assert.rejects(startReleaseAction(env,second.deps),/tag=v0\.20\.6, publish=true/);
  assert.equal(second.calls.filter(c=>c.release).length,1);
});
