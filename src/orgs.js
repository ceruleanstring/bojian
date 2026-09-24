// orgs — 組織清單的唯一真相＋舊扁平版面自動遷移。純 fs + path，不碰 store／server（可單獨測）。
// 版面：data/orgs.json（清單）＋ data/orgs/<id>/（每組織一整套資料）。根層只准有這兩個。
import fs from 'node:fs';
import path from 'node:path';

// 「移出組織」的回收夾名字。這個字串 server.js 也要用——寫兩份的話，改名會讓開機掃描把它當成
// 使用者亂放的資料夾而跳警告（實際發生過）。
export const ORGS_TRASH = 'orgs-trash';

export class OrgsError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

// 舊版（扁平單一組織）直接躺在資料根的項目——全部原樣搬進 orgs/main/
export const LEGACY = Object.freeze([
  'workflows', 'memory', 'shared', 'logs', 'uploads', 'proposals', 'trash',
  'settings.json', 'schedules.json', 'notices.json', 'usage.jsonl',
  'presets.json', 'calendar-snapshot.json',
]);

export const DEFAULT_ORG = 'main';

const orgsFile = (root) => path.join(root, 'orgs.json');
const orgsRoot = (root) => path.join(root, 'orgs');

// Windows 保留裝置名（CON／PRN／AUX／NUL／COM1–9／LPT1–9）：不分大小寫、帶副檔名也算（con.txt 一樣寫不進 NTFS）。
// 與 src/store.js 的 safeFileName（RESERVED_NAMES）同源，兩處規則必須一致；改一邊要同步改另一邊。
// 這裡刻意重抄而不 import：orgs.js 不依賴其他模組，才能單獨測。
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

// id 只進路徑，永遠 ASCII 小寫——組織名字（中文）只存該組織 settings.json 的 company_name，不進路徑
export function validOrgId(id) {
  return typeof id === 'string' && /^[a-z0-9-]{1,32}$/.test(id) && !RESERVED_NAMES.test(id);
}

// 同一毫秒連叫也不重複：時間部分單調遞增（同程序內）；四碼亂數防跨程序撞。沿用專案 id 風格（wf-mtkajzu7-hq24）
let lastTick = 0;
export function newOrgId() {
  lastTick = Math.max(Date.now(), lastTick + 1);
  return `org-${lastTick.toString(36)}-${Math.random().toString(36).slice(2, 6).padEnd(4, '0')}`;
}

export function orgDir(root, id) {
  if (!validOrgId(id)) throw new OrgsError(`組織代號「${id}」不合法（只能小寫英數與減號）`, 'BAD_ID');
  return path.join(orgsRoot(root), id);
}

export function readOrgs(root) {
  let text;
  try {
    text = fs.readFileSync(orgsFile(root), 'utf8');
  } catch {
    return { version: 1, current: DEFAULT_ORG, orgs: [] };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return rebuildOrgs(root); // 清單壞掉不准讓整個站開不起來
  }
  return {
    version: data?.version ?? 1,
    current: typeof data?.current === 'string' ? data.current : DEFAULT_ORG,
    orgs: Array.isArray(data?.orgs) ? data.orgs : [],
  };
}

// orgs.json 被改壞（手動編輯、磁碟半寫）時的自救：壞檔改名留證據，依 orgs/ 底下實際資料夾重建一份。
// 資料夾本來就是真相，清單只是附註——寧可清單重生，也不要整個站開不起來。
function rebuildOrgs(root) {
  const kept = `${orgsFile(root)}.bad-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try { fs.renameSync(orgsFile(root), kept); } catch { /* 改名失敗（被鎖／權限）：重建照做，壞檔等一下被蓋掉 */ }
  let dirs = [];
  try {
    dirs = fs.readdirSync(orgsRoot(root), { withFileTypes: true })
      .filter((d) => d.isDirectory() && validOrgId(d.name)).map((d) => d.name).sort();
  } catch { /* 連 orgs/ 都沒有：交給 ensureOrgLayout 補預設組織 */ }
  const next = {
    version: 1,
    current: dirs[0] ?? DEFAULT_ORG,
    orgs: dirs.map((id) => ({ id, created_at: new Date().toISOString() })),
  };
  writeOrgs(root, next);
  console.warn(`[orgs] 組織清單 orgs.json 讀不懂，已改名保留成「${path.basename(kept)}」，並依 orgs/ 底下實際的資料夾重建：${dirs.join('、') || '一個組織夾都沒有，稍後會自動建預設組織'}`);
  return next;
}

export function writeOrgs(root, data) {
  const file = orgsFile(root);
  fs.mkdirSync(root, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file); // 先寫暫存檔再改名，避免半套
}

// 防呆：BOJIAN_DATA_DIR 被指到組織夾本身，會生出 orgs/main/orgs/main/ 套娃
function assertNotOrgDir(root) {
  if (path.basename(path.dirname(root)) !== 'orgs') return;
  if (!fs.existsSync(path.join(root, '..', '..', 'orgs.json'))) return;
  throw new OrgsError(`「${root}」是組織資料夾，請把 BOJIAN_DATA_DIR 指向它的上兩層`, 'NESTED');
}

export function ensureOrgLayout(rootInput) {
  const root = path.resolve(rootInput);
  assertNotOrgDir(root);
  fs.mkdirSync(orgsRoot(root), { recursive: true });

  // 1. 舊扁平版面搬家：同磁碟改名，瞬間完成、不複製。dest 已在＝絕不合併覆蓋，交人工
  const legacy = LEGACY.filter((n) => fs.existsSync(path.join(root, n)));
  if (legacy.length) {
    const home = path.join(orgsRoot(root), DEFAULT_ORG);
    fs.mkdirSync(home, { recursive: true });
    // 停手時前面已搬走的項目刻意不回滾（資料沒丟，只是換了位置；自動回滾是新的出錯面）——所以錯誤訊息要把現場講清楚
    const moved = [];
    for (const name of legacy) {
      const dest = path.join(home, name);
      if (fs.existsSync(dest)) {
        throw new OrgsError([
          `資料夾搬家停在「${name}」：舊位置和新位置各有一份同名的「${name}」，怕蓋掉你的資料所以停手，沒有任何一份被覆蓋或合併。`,
          `　卡住的兩份：${path.join(root, name)}　和　${dest}`,
          `　已經搬到新位置的（不會自動搬回去）：${moved.join('、') || '（沒有）'}`,
          `　還留在舊位置的：${legacy.slice(moved.length).join('、')}`,
          '　組織清單 orgs.json 這次沒有寫出來；直接重開會停在同一個地方，不會自己修好。',
          `　你可以這樣做：① 打開上面那兩個路徑，看哪一份「${name}」才是要留的，把不要的改名或搬走，再重開一次；`,
          '　② 或執行 node bojian/tools/migrate-orgs.mjs --rollback，把已經搬走的全部還原成舊版面，之後再處理。',
        ].join('\n'), 'CONFLICT');
      }
      fs.renameSync(path.join(root, name), dest);
      moved.push(name);
    }
  }

  // 2. 對帳：資料夾才是真相，清單只是附註
  const before = readOrgs(root);
  const dirs = fs.readdirSync(orgsRoot(root), { withFileTypes: true })
    .filter((d) => d.isDirectory() && validOrgId(d.name))
    .map((d) => d.name);
  const seen = new Set();
  const orgs = [];
  for (const o of before.orgs) {
    const id = String(o?.id ?? '').toLowerCase(); // NTFS 不分大小寫：Main 與 main 是同一夾
    if (!dirs.includes(id) || seen.has(id)) continue; // 夾不見了／重複登記 → 移除
    seen.add(id);
    orgs.push({ ...o, id });
  }
  for (const id of dirs.sort()) { // 使用者手動複製夾進來也認得
    if (seen.has(id)) continue;
    seen.add(id);
    orgs.push({ id, created_at: new Date().toISOString() });
  }
  if (!orgs.length) { // 全新安裝，或組織夾全被刪光：至少留一個預設組織
    fs.mkdirSync(path.join(orgsRoot(root), DEFAULT_ORG), { recursive: true });
    orgs.push({ id: DEFAULT_ORG, created_at: new Date().toISOString() });
  }
  const current = orgs.some((o) => o.id === before.current) ? before.current : orgs[0].id;

  const next = { version: before.version ?? 1, current, orgs };
  if (JSON.stringify(next) !== JSON.stringify(before)) writeOrgs(root, next);

  // 3. 根層不認識的檔（使用者自己放的筆記）：不動、不擋，只提醒
  // orgs-trash 是「移出組織」自己建的（server.js DELETE /api/orgs/:id 把整夾改名搬進去），不是使用者亂放的東西
  const known = new Set(['orgs', 'orgs.json', ORGS_TRASH]);
  const strays = fs.readdirSync(root).filter((n) => !known.has(n) && !n.startsWith('orgs.json.tmp-'));
  if (strays.length) console.warn(`[orgs] 資料根有不認識的項目，已原地留著不動：${strays.join('、')}`);

  return next;
}
