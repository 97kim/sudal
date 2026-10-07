import { test } from "node:test";
import assert from "node:assert/strict";
import { isOffLanguage } from "./language-drift";

test("isOffLanguage(ko): 영어로 넘어간 진행 설명을 잡는다", () => {
  assert.equal(isOffLanguage("Now the hint reads clearly. I'll close the test app, run the tests one last time, and commit each feature separately.", "ko"), true);
  // 따옴표 속 한글이 조금 섞여도 본문이 영어면 벗어난 것
  assert.equal(isOffLanguage('Both follow-up features are in. You can drop mid-sentence, like "이거 봐줘 /tmp/mdt/README.md" plus one image.', "ko"), true);
});

test("isOffLanguage(ko): 코드·경로·영어 용어가 섞인 한국어는 그대로 둔다", () => {
  assert.equal(isOffLanguage("`ipc.ts`와 `preload`에 두 기능의 변경이 섞여 있어서, 끌어다 놓기 부분만 먼저 스테이징할게요.", "ko"), false);
  assert.equal(isOffLanguage("SDK에 PostToolBatch 훅이 있어서 parallel tool call 도 한 번만 넣을 수 있는지 확인할게요.", "ko"), false);
  assert.equal(isOffLanguage("빌드됐어요. /Users/kyungjung-kim/ax/sudal/out/renderer/index.html 을 열게요.\n```bash\nnpm run build && echo done done done\n```", "ko"), false);
  assert.equal(isOffLanguage("OK", "ko"), false);
});

test("isOffLanguage(en): 한국어로 넘어간 글을 잡고, 고유명사 몇 글자는 넘긴다", () => {
  assert.equal(isOffLanguage("빌드가 끝났어요. 이제 앱을 띄워서 화면을 확인할게요.", "en"), true);
  assert.equal(isOffLanguage("The character is called 수대리 in the Korean build, and the app is ready.", "en"), false);
});
