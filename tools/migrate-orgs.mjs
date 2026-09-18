// 多組織輪 O1：把扁平資料根搬成「orgs.json ＋ orgs/<組織>/」的一次性遷移工具。
// 搬家邏輯全在 src/orgs.js，這支只做三件事：備份 → 呼叫它 → 前後對帳報表（講人話）。
// 用法：node bojian/tools/migrate-orgs.mjs [資料根] [--dry-run|--verify|--rollback] [--no-backup]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureOrgLayout, readOrgs, orgDir, LEGACY, DEFAULT_ORG, OrgsError } from '../src/orgs.js';
import { createStore } from '../src/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KNOWN = ['--dry-run', '--verify', '--rollback', '--no-backup', '--help', '-h'];

const HELP = `把剝繭的資料根從「舊的扁平版面」搬成「多組織版面」。

用法：
  node bojian/tools/migrate-orgs.mjs [資料根] [旗標]

資料根不給就用 bojian/data（相對於本檔的 ../data）。

旗標：
  --dry-run     只印搬移計畫，磁碟一個字都不動
  --verify      只對帳（正式搬完會自動跑一次，這裡是單獨再跑）
  --rollback    還原成舊的扁平版面（把 orgs/<組織>/ 的東西搬回根層、刪掉 orgs.json）
  --no-backup   跳過自動備份（預設會先備份整個資料根）
  --help        這份說明

預設流程（不給旗標）：
  備份整個資料根到 <資料根>-backups/pre-orgs-<時間戳>/ → 搬家 → 自動對帳

搬完、還原完都可以重跑，不會壞第二次（冪等）。`;

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('-')));
const positional = argv.filter((a) => !a.startsWith('-'));
if (flags.has('--help') || flags.has('-h')) { console.log(HELP); process.exit(0); }
const unknown = [...flags].filter((f) => !KNOWN.includes(f));
if (unknown.length) { console.error(`不認得的旗標：${unknown.join(' ')}\n\n${HELP}`); process.exit(2); }
const modes = ['--dry-run', '--verify', '--rollback'].filter((f) => flags.has(f));
if (modes.length > 1) { console.error(`${modes.join(' 和 ')} 一次只能選一個`); process.exit(2); }

const root = path.resolve(positional[0] ?? path.join(HERE, '..', 'data'));
const backupsRoot = `${root}-backups`;
const orgsFile = path.join(root, 'orgs.json');
const orgsRoot = path.join(root, 'orgs');

// 講人話：檔名 → 這是什麼東西
const HUMAN = {
  workflows: '工作流程', memory: '記憶（習慣卡與人物卡）', shared: '共用檔案', logs: '工作單紀錄',
  uploads: '上傳暫存', proposals: '提案', trash: '垃圾桶',
  'settings.json': '設定', 'schedules.json': '排程', 'notices.json': '通知',
  'usage.jsonl': '用量帳本', 'presets.json': '常用設定組', 'calendar-snapshot.json': '行事曆快照',
};
const say = (s = '') => console.log(s);
const size = (b) => (b < 1024 ? `${b} byte` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

// 一個項目底下有幾個檔、共幾 byte、第一層有幾個子項（資料夾就整棵走完）
function tally(p) {
  const st = fs.statSync(p);
  if (!st.isDirectory()) return { files: 1, bytes: st.size, children: 0 };
  let files = 0; let bytes = 0; let children = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    children++;
    const sub = tally(path.join(p, e.name));
    files += sub.files; bytes += sub.bytes;
  }
  return { files, bytes, children };
}

// 掃某一層底下的舊版面項目 → Map<名字, 帳>
function scan(dir) {
  const out = new Map();
  for (const name of LEGACY) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) out.set(name, tally(p));
  }
  return out;
}

// 「5 個分類、23 個檔案、412 KB」——單一檔案就只說大小
const shape = (name, t) => (t.children ? `${t.children} 個${name === 'workflows' ? '分類' : '子項'}、` : '') + `${t.files} 個檔案、${size(t.bytes)}`;

function copyDir(from, to) { // cpSync 在這台機器會崩（見 perf-fixture.mjs），逐檔複製
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name); const b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b); else if (e.isFile()) fs.copyFileSync(a, b);
  }
}

function backup(why) {
  const dest = path.join(backupsRoot, `pre-orgs-${stamp()}`);
  copyDir(root, dest);
  const t = tally(dest);
  say(`已備份整個資料根（${why}）：${dest}`);
  say(`  備份內容：${t.files} 個檔案、${size(t.bytes)}。出事了就把這夾裡的東西搬回去。`);
  return dest;
}

const newestBackup = () => {
  let list = [];
  try { list = fs.readdirSync(backupsRoot).filter((n) => n.startsWith('pre-orgs-')).sort(); } catch { return null; }
  return list.length ? path.join(backupsRoot, list.at(-1)) : null;
};

function requireRoot() {
  if (fs.existsSync(root)) return;
  console.error(`資料根不存在：${root}`);
  process.exit(2);
}

// ---- 對帳 ----
// before：遷移前算好的帳（Map）。standalone --verify 拿不到，就用最新一份備份當「之前」。
function verify(before, { beforeFrom = '遷移前的現場清點' } = {}) {
  let bad = false;
  say('');
  say('對帳報表');
  say('────────');

  // 檢查一：根層只該剩 orgs.json 與 orgs/
  const stay = fs.readdirSync(root).filter((n) => n !== 'orgs' && n !== 'orgs.json' && !n.startsWith('orgs.json.tmp-'));
  const leftBehind = stay.filter((n) => LEGACY.includes(n));
  const strays = stay.filter((n) => !LEGACY.includes(n));
  if (leftBehind.length) {
    bad = true;
    say(`✗ 檢查一：資料根還有該搬走卻留在原地的東西：${leftBehind.join('、')}`);
  } else {
    say('✓ 檢查一：資料根乾淨了，只剩組織清單 orgs.json 和 orgs/ 資料夾。');
  }
  if (strays.length) say(`  （順帶一提：${strays.join('、')} 不是剝繭認識的東西，原地留著沒動，不算錯。）`);

  // 檢查二：逐項比對檔案數與總 byte 數
  const list = readOrgs(root);
  const home = orgDir(root, list.current);
  if (!before) {
    bad = true;
    say('✗ 檢查二：找不到「之前」的帳（沒有備份可比），無法對帳。');
  } else if (!before.size) {
    say('✓ 檢查二：沒有東西需要對帳（動手前這裡就已經是新版面了）。');
  } else {
    let ok = 0;
    for (const [name, was] of before) {
      const p = path.join(home, name);
      if (!fs.existsSync(p)) {
        bad = true;
        say(`✗ 檢查二：「${HUMAN[name] ?? name}」（${name}）搬過去之後不見了。`);
        continue;
      }
      const now = tally(p);
      if (now.files !== was.files || now.bytes !== was.bytes) {
        bad = true;
        say(`✗ 檢查二：「${HUMAN[name] ?? name}」（${name}）對不起來——之前 ${was.files} 個檔案 ${size(was.bytes)}，現在 ${now.files} 個檔案 ${size(now.bytes)}。`);
      } else ok++;
    }
    if (!bad) say(`✓ 檢查二：${ok} 個項目一個不差（檔案數與總大小逐項比對，${beforeFrom}）。`);
  }

  // 檢查三：印出可以人肉核對的數字
  say('');
  say(`目前的組織：${list.orgs.map((o) => o.id).join('、') || '（空）'}；正在用的是「${list.current}」。`);
  try {
    const store = createStore(home);
    say(`從「${list.current}」讀得到：`);
    say(`  工作流程 ${store.listWorkflows().length} 個`);
    say(`  排程 ${store.readSchedules().length} 筆`);
    say(`  通知 ${store.readNotices().length} 筆`);
    say(`  用量紀錄 ${store.readUsage().length} 筆`);
    say('  這四個數字請跟你印象中的對一下，對不上就回頭用備份。');
  } catch (e) {
    bad = true;
    say(`✗ 檢查三：讀不出「${list.current}」的內容（${e.message}）。`);
  }

  say('');
  say(bad ? '結果：對帳沒過，上面標 ✗ 的要處理。' : '結果：全部對得起來，可以開站了。');
  return !bad;
}

// ---- 三種模式 ----
function dryRun() {
  requireRoot();
  const before = scan(root);
  say(`資料根：${root}`);
  say('');
  if (!before.size) {
    say(fs.existsSync(orgsFile)
      ? '沒有要搬的東西——這份資料已經是多組織版面了，正式跑也只會重新對帳一次。'
      : '沒有要搬的東西——這個資料夾裡找不到任何剝繭的舊資料。');
  } else {
    say(`打算做的事（實際跑會照這個順序做，現在磁碟一個字都不會動）：`);
    say(`1. 先把整個資料根複製一份到 ${path.join(backupsRoot, 'pre-orgs-<時間戳>')}／（加 --no-backup 可跳過）`);
    say(`2. 把下面 ${before.size} 個項目原地改名搬進 orgs/${DEFAULT_ORG}/：`);
    let files = 0; let bytes = 0;
    for (const [name, t] of before) {
      files += t.files; bytes += t.bytes;
      say(`   · 把「${HUMAN[name] ?? name}」（${name}）搬進 orgs/${DEFAULT_ORG}/：${shape(name, t)}`);
    }
    say(`   合計 ${files} 個檔案、${size(bytes)}（同一顆磁碟改名，不複製，很快）`);
    say(`3. 寫一份組織清單 orgs.json（目前使用的組織＝${DEFAULT_ORG}）`);
    say(`4. 自動對帳：逐項比對檔案數與總大小，再印出四個可以人肉核對的數字`);
  }
  const strays = fs.existsSync(root) ? fs.readdirSync(root).filter((n) => !LEGACY.includes(n) && n !== 'orgs' && n !== 'orgs.json') : [];
  if (strays.length) say(`\n不會動到的東西（不是剝繭認識的）：${strays.join('、')}`);
  say('');
  say('這是預演，什麼都沒改。要真的搬，把 --dry-run 拿掉再跑一次。');
  return true;
}

function migrate() {
  requireRoot();
  const before = scan(root);
  say(`資料根：${root}`);
  say('');
  if (!before.size) {
    say('沒有要搬的東西（已經是多組織版面，或這裡沒有舊資料），所以也不備份，直接對帳。');
  } else if (flags.has('--no-backup')) {
    say('照你的指示跳過備份（--no-backup）。');
  } else {
    backup('搬家前');
  }
  say('');
  for (const [name, t] of before) {
    say(`把「${HUMAN[name] ?? name}」（${name}）搬進 orgs/${DEFAULT_ORG}/：${shape(name, t)}`);
  }
  ensureOrgLayout(root);
  if (before.size) say(`搬完了，共 ${before.size} 個項目。`);
  return verify(before);
}

function rollback() {
  requireRoot();
  const dirs = (() => {
    try { return fs.readdirSync(orgsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
  })();
  if (!fs.existsSync(orgsFile) && !dirs.length) {
    say(`資料根：${root}`);
    say('本來就是舊的扁平版面（沒有 orgs.json，也沒有 orgs/ 資料夾），不用還原。');
    return true;
  }
  if (dirs.length > 1) {
    console.error(`這裡有 ${dirs.length} 個組織（${dirs.join('、')}），舊版面只裝得下一個，還原會撞在一起，所以停手。`);
    console.error('請先自己決定留哪一個、把其他組織的資料夾移走，再跑一次。');
    return false;
  }
  const current = dirs.includes(readOrgs(root).current) ? readOrgs(root).current : (dirs[0] ?? DEFAULT_ORG);
  const home = path.join(orgsRoot, current);
  const moving = fs.existsSync(home) ? fs.readdirSync(home) : [];

  say(`資料根：${root}`);
  say(`要把組織「${current}」的東西搬回舊的扁平位置，共 ${moving.length} 個項目。`);
  say('');
  if (moving.length && !flags.has('--no-backup')) backup('還原前');

  for (const name of moving) {
    const src = path.join(home, name);
    const dest = path.join(root, name);
    if (fs.existsSync(dest)) {
      console.error(`「${name}」在舊位置已經有一份了，怕蓋掉資料所以停手，請自己確認後留一份再跑。`);
      return false;
    }
    const t = tally(src);
    fs.renameSync(src, dest);
    say(`把「${HUMAN[name] ?? name}」（${name}）搬回資料根：${shape(name, t)}`);
  }
  fs.rmSync(orgsFile, { force: true });
  try { fs.rmdirSync(home); } catch { /* 還有東西就留著 */ }
  try { fs.rmdirSync(orgsRoot); } catch { /* 還有別的組織夾就留著 */ }
  say('');
  say(fs.existsSync(orgsRoot)
    ? '已還原成扁平版面，組織清單 orgs.json 已刪除；orgs/ 底下還有東西所以留著。'
    : '已還原成扁平版面：組織清單 orgs.json 已刪除，orgs/ 資料夾也清掉了。');
  return true;
}

// ---- 進入點 ----
let ok = false;
try {
  if (flags.has('--dry-run')) ok = dryRun();
  else if (flags.has('--rollback')) ok = rollback();
  else if (flags.has('--verify')) {
    requireRoot();
    const b = newestBackup();
    say(`資料根：${root}`);
    if (b) say(`拿來當「之前」的是最新一份備份：${b}`);
    else say('找不到備份，所以只能檢查現況（沒有「之前」可以比）。');
    ok = verify(b ? scan(b) : null, { beforeFrom: '對照最新一份備份' });
  } else ok = migrate();
} catch (e) {
  console.error(e instanceof OrgsError ? `停手了：${e.message}` : e);
  process.exit(1);
}
process.exit(ok ? 0 : 1);
