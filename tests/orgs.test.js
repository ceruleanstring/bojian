// 多組織輪 O1：組織清單＋舊扁平版面遷移。全部在 os.tmpdir() 造假資料，不碰 bojian/data
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureOrgLayout, readOrgs, writeOrgs, orgDir, newOrgId, validOrgId, OrgsError, LEGACY, DEFAULT_ORG } from '../src/orgs.js';

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bojian-orgs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 造一份舊扁平版面：夾裡放一個記號檔、檔案寫自己的名字，好驗「原樣搬過去」
function makeLegacy(root, names = LEGACY) {
  fs.mkdirSync(root, { recursive: true });
  for (const n of names) {
    if (n.includes('.')) fs.writeFileSync(path.join(root, n), `內容-${n}`, 'utf8');
    else {
      fs.mkdirSync(path.join(root, n), { recursive: true });
      fs.writeFileSync(path.join(root, n, 'mark.txt'), `記號-${n}`, 'utf8');
    }
  }
}

const ls = (d) => fs.readdirSync(d).sort();

test('O1 ①：全新空目錄／根本不存在的目錄 → 產出 orgs.json（current main）＋ orgs/main/', (t) => {
  const root = tmpRoot(t);
  const got = ensureOrgLayout(root);
  assert.equal(got.current, DEFAULT_ORG);
  assert.deepEqual(got.orgs.map((o) => o.id), ['main']);
  assert.ok(Date.parse(got.orgs[0].created_at) > 0, '要有 ISO 建立時間');
  assert.deepEqual(ls(root), ['orgs', 'orgs.json']);
  assert.ok(fs.statSync(path.join(root, 'orgs', 'main')).isDirectory());
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'orgs.json'), 'utf8')), got);

  const fresh = path.join(root, 'nope', 'deeper'); // 整條路徑都還不存在
  const got2 = ensureOrgLayout(fresh);
  assert.equal(got2.current, 'main');
  assert.deepEqual(ls(fresh), ['orgs', 'orgs.json']);
});

test('O1 ②：扁平舊目錄 13 項齊全 → 全數搬進 orgs/main/，根層只剩 orgs.json＋orgs/，內容原樣', (t) => {
  const root = tmpRoot(t);
  makeLegacy(root);
  const got = ensureOrgLayout(root);
  assert.deepEqual(ls(root), ['orgs', 'orgs.json']);
  const home = path.join(root, 'orgs', 'main');
  assert.deepEqual(ls(home), [...LEGACY].sort());
  assert.equal(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'), '內容-settings.json');
  assert.equal(fs.readFileSync(path.join(home, 'workflows', 'mark.txt'), 'utf8'), '記號-workflows');
  assert.deepEqual(got.orgs.map((o) => o.id), ['main']);
});

test('O1 ③：連跑三次結果完全相同（冪等）', (t) => {
  const root = tmpRoot(t);
  makeLegacy(root);
  const a = ensureOrgLayout(root);
  const snap = () => [fs.readFileSync(path.join(root, 'orgs.json'), 'utf8'), ls(root).join(), ls(path.join(root, 'orgs', 'main')).join()];
  const s1 = snap();
  const b = ensureOrgLayout(root);
  const s2 = snap();
  const c = ensureOrgLayout(root);
  assert.deepEqual(snap(), s1);
  assert.deepEqual(s2, s1);
  assert.deepEqual(b, a);
  assert.deepEqual(c, a);
});

test('O1 ④：搬到一半被殺（先手動搬走 3 項）→ 再跑一次能搬完', (t) => {
  const root = tmpRoot(t);
  makeLegacy(root);
  const home = path.join(root, 'orgs', 'main');
  fs.mkdirSync(home, { recursive: true });
  for (const n of ['workflows', 'memory', 'settings.json']) fs.renameSync(path.join(root, n), path.join(home, n));
  assert.deepEqual(ls(root), [...LEGACY.filter((n) => !['workflows', 'memory', 'settings.json'].includes(n)), 'orgs'].sort());

  ensureOrgLayout(root);
  assert.deepEqual(ls(root), ['orgs', 'orgs.json']);
  assert.deepEqual(ls(home), [...LEGACY].sort());
  assert.equal(fs.readFileSync(path.join(home, 'memory', 'mark.txt'), 'utf8'), '記號-memory');
});

test('O1 ⑤：dest 與 src 同時存在 → 丟錯、不覆蓋、不合併', (t) => {
  const root = tmpRoot(t);
  makeLegacy(root, ['settings.json', 'workflows']);
  const home = path.join(root, 'orgs', 'main');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'settings.json'), '新位置的設定', 'utf8');

  assert.throws(() => ensureOrgLayout(root), (e) => e instanceof OrgsError && e.code === 'CONFLICT' && e.message.includes('settings.json'));
  assert.equal(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'), '新位置的設定', '新位置不准被蓋');
  assert.equal(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'), '內容-settings.json', '舊位置要留著等人工處理');
});

test('O1 ⑥：orgs/ 下多一個未登記的夾 → 自動補進清單（非法夾名略過）', (t) => {
  const root = tmpRoot(t);
  ensureOrgLayout(root);
  fs.mkdirSync(path.join(root, 'orgs', 'org-abc-1234'));
  fs.mkdirSync(path.join(root, 'orgs', '明遠'));
  fs.writeFileSync(path.join(root, 'orgs', 'readme.txt'), 'x', 'utf8');

  const got = ensureOrgLayout(root);
  assert.deepEqual(got.orgs.map((o) => o.id), ['main', 'org-abc-1234']);
  assert.equal(got.current, 'main');
  assert.ok(fs.existsSync(path.join(root, 'orgs', '明遠')), '不合法的夾只是不登記，不刪');
});

test('O1 ⑦：清單有 id 但夾不見了 → 自動移除', (t) => {
  const root = tmpRoot(t);
  ensureOrgLayout(root);
  writeOrgs(root, { version: 1, current: 'main', orgs: [{ id: 'main', created_at: 'x' }, { id: 'ghost', created_at: 'x' }] });
  const got = ensureOrgLayout(root);
  assert.deepEqual(got.orgs.map((o) => o.id), ['main']);
});

test('O1 ⑧：current 指到不存在的 id → 退到第一個；大小寫重複登記收斂成一筆', (t) => {
  const root = tmpRoot(t);
  ensureOrgLayout(root);
  fs.mkdirSync(path.join(root, 'orgs', 'b-team'));
  writeOrgs(root, { version: 1, current: '不存在', orgs: [{ id: 'b-team' }, { id: 'Main' }, { id: 'main' }] });
  const got = ensureOrgLayout(root);
  assert.equal(got.current, 'b-team', '退到清單第一個');
  assert.deepEqual(got.orgs.map((o) => o.id), ['b-team', 'main']);
});

test('O1 ⑨：newOrgId 連叫 1000 次全合法且無重複', () => {
  const ids = Array.from({ length: 1000 }, () => newOrgId());
  assert.equal(new Set(ids).size, 1000, '不准撞');
  for (const id of ids) {
    assert.match(id, /^org-[a-z0-9-]{1,28}$/, id);
    assert.ok(validOrgId(id), id);
  }
});

test('O1 ⑩：validOrgId——只收 ASCII 小寫英數與減號，長度 1–32', () => {
  for (const ok of ['main', 'a', 'org-abc-1234', 'b-team', '0', 'a'.repeat(32)]) assert.equal(validOrgId(ok), true, ok);
  for (const bad of ['Main', '明遠', '../x', 'a/b', 'a\\b', '', ' main', 'main ', 'a_b', 'a.b', 'a'.repeat(33), null, undefined, 123, 'con:']) {
    assert.equal(validOrgId(bad), false, String(bad));
  }
  // Windows 保留裝置名不能當資料夾名（規則與 store.js:safeFileName 同源）：大小寫、帶副檔名都算
  for (const bad of ['con', 'nul', 'aux', 'prn', 'com1', 'com9', 'lpt1', 'lpt9', 'CON', 'Con', 'NUL', 'con.txt', 'CON.md', 'com1.log']) {
    assert.equal(validOrgId(bad), false, String(bad));
  }
  // 只擋整個 id 剛好是保留字，不要誤殺正常 id
  for (const ok of ['console', 'con-1', 'nul2', 'com0', 'lpt10', 'auxiliary', 'my-con']) assert.equal(validOrgId(ok), true, ok);
});

test('O1 ⑪：BOJIAN_DATA_DIR 指到組織夾本身 → 丟明確錯誤，不生 orgs/main/orgs/main 套娃', (t) => {
  const root = tmpRoot(t);
  ensureOrgLayout(root);
  const home = path.join(root, 'orgs', 'main');
  assert.throws(() => ensureOrgLayout(home), (e) => e instanceof OrgsError && e.code === 'NESTED' && e.message.includes('上兩層'));
  assert.ok(!fs.existsSync(path.join(home, 'orgs')), '不准生出套娃');
  // 只是剛好叫 orgs 的爺爺夾（沒有 orgs.json）不誤判
  const fake = path.join(root, 'x', 'orgs', 'main');
  fs.mkdirSync(fake, { recursive: true });
  assert.equal(ensureOrgLayout(fake).current, 'main');
});

test('O1 ⑫：orgDir 擋非法 id；readOrgs 缺檔給缺省；writeOrgs 往返一致', (t) => {
  const root = tmpRoot(t);
  assert.equal(orgDir(root, 'main'), path.join(root, 'orgs', 'main'));
  for (const bad of ['../x', '明遠', 'Main', '']) {
    assert.throws(() => orgDir(root, bad), (e) => e instanceof OrgsError && e.code === 'BAD_ID', String(bad));
  }
  assert.deepEqual(readOrgs(root), { version: 1, current: 'main', orgs: [] }, '缺檔＝缺省');
  const data = { version: 1, current: 'b-team', orgs: [{ id: 'b-team', created_at: '2026-09-18T00:00:00.000Z' }] };
  writeOrgs(root, data);
  assert.deepEqual(readOrgs(root), data);
});

test('O1 ⑬：根層不認識的檔（使用者自己放的筆記）不動、不擋', (t) => {
  const root = tmpRoot(t);
  makeLegacy(root);
  fs.writeFileSync(path.join(root, '我的筆記.txt'), '別動我', 'utf8');
  fs.mkdirSync(path.join(root, '我的備份'));
  const got = ensureOrgLayout(root);
  assert.equal(got.current, 'main');
  assert.deepEqual(ls(root), ['orgs', 'orgs.json', '我的備份', '我的筆記.txt'].sort());
  assert.equal(fs.readFileSync(path.join(root, '我的筆記.txt'), 'utf8'), '別動我');
});

test('O1 ⑭：orgs.json 壞掉不准讓站開不起來 → 壞檔改名保留、依資料夾重建、站照常跑', (t) => {
  const root = tmpRoot(t);
  makeLegacy(root);
  ensureOrgLayout(root);
  fs.mkdirSync(path.join(root, 'orgs', 'b-team'));
  ensureOrgLayout(root);
  fs.writeFileSync(path.join(root, 'orgs.json'), '{壞掉的', 'utf8');

  const got = readOrgs(root); // 不准丟錯
  assert.deepEqual(got.orgs.map((o) => o.id), ['b-team', 'main'], '依資料夾實際內容重建');
  assert.equal(got.current, 'b-team', 'current 取第一個');

  const bad = ls(root).filter((n) => n.startsWith('orgs.json.bad-'));
  assert.equal(bad.length, 1, '壞檔要改名保留成證據');
  assert.equal(fs.readFileSync(path.join(root, bad[0]), 'utf8'), '{壞掉的', '壞檔內容原封不動');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'orgs.json'), 'utf8')), got, '新清單要真的寫回磁碟');

  const after = ensureOrgLayout(root); // 站繼續跑：資料一項都沒少
  assert.deepEqual(after.orgs.map((o) => o.id), ['b-team', 'main']);
  assert.deepEqual(ls(path.join(root, 'orgs', 'main')), [...LEGACY].sort());

  // orgs/ 整個不見也不能卡住：重建成空清單，交給 ensureOrgLayout 補預設組織
  fs.rmSync(path.join(root, 'orgs'), { recursive: true, force: true });
  fs.writeFileSync(path.join(root, 'orgs.json'), 'x', 'utf8');
  assert.deepEqual(readOrgs(root), { version: 1, current: 'main', orgs: [] });
  assert.equal(ensureOrgLayout(root).current, 'main');
});

// 釘住「衝突停手會留下部分已搬的中間態」這個刻意的設計（不回滾），不是釘錯誤訊息的字面。
// 若有人日後把實作改成自動回滾，這條會紅；改動這裡前先確認那是有意的行為變更。
test('O1 ⑮：衝突停手 → 衝突項之前的已搬走且不回滾、兩份都原封不動、orgs.json 不寫出；重跑停在同一項不再前進', (t) => {
  const root = tmpRoot(t);
  // LEGACY 順序：workflows、memory 在 settings.json 之前，schedules.json 在之後
  makeLegacy(root, ['workflows', 'memory', 'settings.json', 'schedules.json']);
  const home = path.join(root, 'orgs', 'main');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'settings.json'), '新位置的設定', 'utf8');

  assert.throws(() => ensureOrgLayout(root), (e) => e instanceof OrgsError && e.code === 'CONFLICT' && e.message.includes('settings.json'));

  // ① 排在衝突項前面、沒衝突的項目已經搬進 orgs/main/，而且不會被搬回去
  assert.deepEqual(ls(home), ['memory', 'settings.json', 'workflows']);
  assert.equal(fs.readFileSync(path.join(home, 'workflows', 'mark.txt'), 'utf8'), '記號-workflows');
  assert.equal(fs.readFileSync(path.join(home, 'memory', 'mark.txt'), 'utf8'), '記號-memory');
  assert.ok(!fs.existsSync(path.join(root, 'workflows')), '已搬走的不回滾');
  assert.ok(!fs.existsSync(path.join(root, 'memory')), '已搬走的不回滾');
  // ② 衝突項兩份內容都原封不動
  assert.equal(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'), '新位置的設定');
  assert.equal(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'), '內容-settings.json');
  // ③ orgs.json 沒寫出來——現場是「部分已搬＋沒有清單檔」的中間態
  assert.deepEqual(ls(root), ['orgs', 'schedules.json', 'settings.json']);
  assert.ok(!fs.existsSync(path.join(root, 'orgs.json')), '清單這次不會寫出來');

  // ④ 重跑的真實結果：剩下的第一項就是衝突項，立刻再丟一次錯，排在它後面的 schedules.json 一步都沒前進
  assert.throws(() => ensureOrgLayout(root), (e) => e instanceof OrgsError && e.code === 'CONFLICT' && e.message.includes('settings.json'));
  assert.deepEqual(ls(home), ['memory', 'settings.json', 'workflows'], '重跑不會多搬任何東西');
  assert.deepEqual(ls(root), ['orgs', 'schedules.json', 'settings.json'], '重跑不會自己修好');
  assert.ok(!fs.existsSync(path.join(root, 'orgs.json')));

  // ⑤ 人工解掉衝突項（舊的那份改名移開）後，重跑就能把剩下的搬完
  fs.renameSync(path.join(root, 'settings.json'), path.join(root, '舊設定備份.json'));
  const got = ensureOrgLayout(root);
  assert.deepEqual(got.orgs.map((o) => o.id), ['main']);
  assert.deepEqual(ls(home), ['memory', 'schedules.json', 'settings.json', 'workflows']);
  assert.deepEqual(ls(root), ['orgs', 'orgs.json', '舊設定備份.json']);
});

test('O1 ⑯：根層的 orgs-trash（移出組織用的回收夾）不算 stray、不被念、也不會被搬進組織夾', (t) => {
  const root = tmpRoot(t);
  makeLegacy(root);
  fs.mkdirSync(path.join(root, 'orgs-trash', 'b-team-20260918T000000'), { recursive: true });
  fs.writeFileSync(path.join(root, 'orgs-trash', 'b-team-20260918T000000', 'settings.json'), '被移出的組織', 'utf8');
  fs.writeFileSync(path.join(root, '我的筆記.txt'), '別動我', 'utf8');

  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try { ensureOrgLayout(root); } finally { console.warn = orig; }

  const stray = warns.filter((w) => w.includes('不認識的項目'));
  assert.equal(stray.length, 1, '只該為真正的雜項念一次');
  assert.ok(!stray[0].includes('orgs-trash'), `orgs-trash 不准被列為 stray：${stray[0]}`);
  assert.ok(stray[0].includes('我的筆記.txt'), '使用者自己放的筆記還是要提醒');

  // 回收夾原地不動：沒被搬進 orgs/main/，內容也沒變
  assert.ok(!fs.existsSync(path.join(root, 'orgs', 'main', 'orgs-trash')), '不准被搬進組織夾');
  assert.equal(fs.readFileSync(path.join(root, 'orgs-trash', 'b-team-20260918T000000', 'settings.json'), 'utf8'), '被移出的組織');
  assert.deepEqual(ls(root), ['orgs', 'orgs-trash', 'orgs.json', '我的筆記.txt'].sort());
});
