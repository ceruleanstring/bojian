import test from 'node:test';
import assert from 'node:assert/strict';
import yaml from 'js-yaml';

test('環境煙霧：js-yaml 解析可用', () => {
  assert.equal(yaml.load('a: 1').a, 1);
});
