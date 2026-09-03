import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { pushNotice, resolveNotice, hasFingerprint } from '../src/notices.js';

function tmpStore() {
  return createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'bojian-not-')));
}

test('D20：pushNotice 指紋去重（含已處理不重生）；trigger 型不進未讀', () => {
  const store = tmpStore();
  const a = pushNotice(store, { type: 'missed', title: 'x', fingerprint: 'fp1' });
  assert.ok(a);
  assert.equal(pushNotice(store, { type: 'missed', title: 'x', fingerprint: 'fp1' }), null);
  resolveNotice(store, a.id, '已跳過');
  assert.equal(pushNotice(store, { type: 'missed', title: 'x', fingerprint: 'fp1' }), null, '已處理仍不重生');
  const t = pushNotice(store, { type: 'trigger', fingerprint: 'fp2' });
  assert.equal(t.status, 'done');
  assert.ok(hasFingerprint(store.readNotices(), 'fp2'));
});

test('D20：resolveNotice 留痕；不存在丟人話', () => {
  const store = tmpStore();
  const n = pushNotice(store, { type: 'reminder', title: 'r' });
  const done = resolveNotice(store, n.id, '已知悉');
  assert.equal(done.status, 'done');
  assert.equal(done.result, '已知悉');
  assert.throws(() => resolveNotice(store, '沒這個'), (e) => e.message.includes('不存在'));
});
