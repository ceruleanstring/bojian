// 排版輪 畫布效能資料：把資料副本複製到 --data（已存在就沿用），在裡面產生一條大 Workflow。
// 每組「蒐集 → 三支同時做 → 彙整」＝5 步；--groups 40 ＝ 200 步（w200）。
// --choose N：前 N 組的「蒐集」出口改擇一（藏起來的分岔節點，每條路有條件）＝ w200c。
// 用法：node bojian/tools/perf-fixture.mjs --from <資料副本> --data <效能資料夾> [--cat 效能] [--id w200] [--groups 40] [--choose 0]
// 絕不寫 bojian/data（--data 指到它就停）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateWorkflow } from '../src/schema.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i];
  return o;
}
const a = args(process.argv.slice(2));
if (!a.data) { console.error('要 --data <效能資料夾>'); process.exit(2); }
const dst = path.resolve(a.data);
if (dst.toLowerCase().startsWith(path.resolve(HERE, '..', 'data').toLowerCase())) { console.error('不准寫 bojian/data'); process.exit(2); }
const cat = a.cat ?? '效能';
const wid = a.id ?? 'w200';
const G = Number(a.groups ?? 40);
const choose = Number(a.choose ?? 0);

function copyDir(from, to) { // cpSync 在這台會崩，逐檔複製
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const pa = path.join(from, e.name), pb = path.join(to, e.name);
    if (e.isDirectory()) copyDir(pa, pb); else if (e.isFile()) fs.copyFileSync(pa, pb);
  }
}
if (!fs.existsSync(dst)) {
  if (!a.from) { console.error(`${dst} 不存在，要 --from <資料副本>`); process.exit(2); }
  copyDir(path.resolve(a.from), dst);
}

const nodes = [];
for (let g = 0; g < G; g++) {
  const id = (s) => `g${g}${s}`;
  const t = (i, title, next) => ({ id: id(i), title, executor: 'ai', stop_point: g % 7 === 3 && i === 'c' ? 'always' : 'never', instruction: `第 ${g + 1} 組 ${title}：整理上一步產出。`, next });
  const bs = ['b1', 'b2', 'b3'];
  if (g < choose) {
    nodes.push(t('a', `蒐集 ${g + 1}`, [id('ch')]));
    nodes.push({ id: id('ch'), title: `擇一 ${g + 1}`, kind: 'branch', instruction: `看第 ${g + 1} 組蒐集結果決定走哪條`, next: [], branches: bs.map((k, j) => ({ label: `情況 ${j + 1}：資料屬第 ${j + 1} 類`, next: id(k) })) });
  } else {
    nodes.push(t('a', `蒐集 ${g + 1}`, bs.map(id)));
  }
  for (const k of bs) nodes.push(t(k, `分頭處理 ${g + 1}-${k.slice(1)}`, [id('c')]));
  nodes.push(t('c', `彙整 ${g + 1}`, g < G - 1 ? [`g${g + 1}a`] : []));
}
const def = { format: 1, name: `效能測試 ${G * 5} 步${choose ? `（${choose} 組擇一）` : ''}`, params: [], nodes };
validateWorkflow(def); // 定義不合法就丟錯，不寫檔
const dir = path.join(dst, 'workflows', cat, wid);
fs.mkdirSync(path.join(dir, 'history'), { recursive: true });
fs.writeFileSync(path.join(dir, 'workflow.yaml'), JSON.stringify(def, null, 1));
fs.writeFileSync(path.join(dir, 'history', 'v1.yaml'), JSON.stringify({ diff_note: '建立', source: 'create', def }, null, 1));
console.log(JSON.stringify({ nodes: nodes.length, dir }));
