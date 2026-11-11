import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestReveal, pendingReveal, clearReveal } from './reveal';

test('새 메시지로 대화 이동을 취소해도 다른 분할 칸의 요청은 유지한다', () => {
  try {
    requestReveal('left','old-result');
    clearReveal('right');
    assert.equal(pendingReveal('left'),'old-result');
    clearReveal('left');
    assert.equal(pendingReveal('left'),null);
    requestReveal('right','new-result');
    assert.equal(pendingReveal('left'),null);
    assert.equal(pendingReveal('right'),'new-result');
  } finally { clearReveal(); }
});
