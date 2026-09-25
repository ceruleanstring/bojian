import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 外掛層：市集檔、plugin.json、package.json 三邊版本要對齊；SKILL.md 要照「安裝位置約定」寫。
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const pkg = readJson('package.json');

test('plugin：plugin.json 的版本＝package.json', () => {
  const plugin = readJson('.claude-plugin/plugin.json');
  assert.equal(plugin.name, 'bojian');
  assert.equal(plugin.version, pkg.version);
});

test('plugin：marketplace.json 解析得開、唯一外掛叫 bojian、指向本倉庫根、版本一致', () => {
  const mkt = readJson('.claude-plugin/marketplace.json');
  assert.equal(typeof mkt.name, 'string');
  assert.ok(Array.isArray(mkt.plugins) && mkt.plugins.length === 1, '只上架一個外掛');
  const [p] = mkt.plugins;
  assert.equal(p.name, 'bojian');
  assert.equal(p.source, './');
  assert.equal(p.version, pkg.version);
  assert.equal(p.description, readJson('.claude-plugin/plugin.json').description, 'description 用 plugin.json 那句');
  if (mkt.metadata?.version !== undefined) assert.equal(mkt.metadata.version, pkg.version);
});

// claude 在不在：Windows 上可能是 .exe 也可能是 .cmd，交給 shell 找
function claudeCli(args) {
  return spawnSync('claude', args, { cwd: ROOT, encoding: 'utf8', shell: true, timeout: 120_000, windowsHide: true });
}
const probe = claudeCli(['--version']);
const noClaude = probe.error || probe.status !== 0
  ? `本機找不到 claude 指令（${probe.error?.message ?? `exit ${probe.status}：${(probe.stderr || '').trim()}`}），跳過實跑 validate`
  : false;
if (noClaude) console.log(noClaude);

test('plugin：claude plugin validate --strict 實跑通過（市集檔＋plugin.json，警告也算錯）', { skip: noClaude }, () => {
  for (const target of ['.', '.claude-plugin/plugin.json']) {
    const r = claudeCli(['plugin', 'validate', '--strict', target]);
    assert.equal(r.status, 0, `claude plugin validate --strict ${target} 沒過：\n${r.stdout}\n${r.stderr}`);
  }
  const dir = claudeCli(['plugin', 'validate', '--strict', '.']);
  assert.match(dir.stdout, /marketplace/i, '驗資料夾時要認得市集檔（沒認到＝市集檔被略過）');
});

test('plugin：SKILL.md 照安裝位置約定寫（程式夾、資料夾變數、安裝腳本）', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'bojian', 'SKILL.md'), 'utf8');
  for (const s of ['%LOCALAPPDATA%\\bojian\\app', 'BOJIAN_DATA_DIR', 'install.ps1']) {
    assert.ok(skill.includes(s), `SKILL.md 缺「${s}」`);
  }
});
