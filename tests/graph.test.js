import test from 'node:test';
import assert from 'node:assert/strict';
import { predecessors, layers, computeSkipped } from '../src/graph.js';
import { DAG_DEF } from './fixtures.js';

test('predecessors：join 收得到兩個前驅', () => {
  const preds = predecessors(DAG_DEF);
  assert.deepEqual(preds.get('merge').sort(), ['amount-check', 'boss-sign']);
  assert.deepEqual(preds.get('done-join').sort(), ['mail', 'scan']);
  assert.deepEqual(preds.get('fill'), []);
});

test('layers：拓撲深度（平行兩支同層）', () => {
  const depth = layers(DAG_DEF);
  assert.equal(depth.get('fill'), 0);
  assert.equal(depth.get('amount-check'), 1);
  assert.equal(depth.get('boss-sign'), 2);
  assert.equal(depth.get('merge'), 3);
  assert.equal(depth.get('scan'), depth.get('mail'), '平行兩支同深度');
  assert.equal(depth.get('done-join'), depth.get('scan') + 1);
});

test('computeSkipped：選了不簽核的路 → 簽核步被跳過；選簽核 → 無跳過', () => {
  assert.deepEqual([...computeSkipped(DAG_DEF, { 'amount-check': 'merge' })], ['boss-sign']);
  assert.deepEqual([...computeSkipped(DAG_DEF, { 'amount-check': 'boss-sign' })], []);
  assert.deepEqual([...computeSkipped(DAG_DEF, {})], [], '未選路前不跳過任何節點');
});

test('computeSkipped：跳過沿鏈傳染', () => {
  const def = structuredClone(DAG_DEF);
  // 把簽核路換成兩步鏈：boss-sign → archive-sign → merge
  def.nodes.find((n) => n.id === 'boss-sign').next = ['archive-sign'];
  def.nodes.splice(3, 0, { id: 'archive-sign', title: '歸檔簽名', executor: 'ai', stop_point: 'never', instruction: '存檔', next: ['merge'] });
  const skipped = computeSkipped(def, { 'amount-check': 'merge' });
  assert.deepEqual([...skipped].sort(), ['archive-sign', 'boss-sign']);
});
