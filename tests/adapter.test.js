import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { createHostAdapter, HostError, resolveClaudeBin, defaultSpawn, LEAN_WORKER_SYSTEM, LEAN_GENERIC_SYSTEM, CALENDAR_TOOLS, CALENDAR_BLOCKED, readHostInit, CAGE_BASH_RULES, CAGE_CMD, CAGE_PATH, editRuleFor, WORKER_SETTINGS, killTree } from '../src/host-adapter.js';

// 假子行程：可控 stdout／stderr／結束碼／不結束
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  // 真 stream 有這兩支，假的也要有：stdout／stderr 要能定編碼（不然跨塊中文會被切壞），
  // stdin 要能掛 'error'（EPIPE 沒人接會炸掉整個行程）
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.stdin = { written: '', write(s) { this.written += s; }, end() {}, on() {} };
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

const NODE_ARGS = { nodeId: 'x', title: '整理歸納', instruction: '整理成表', upstream: '原始資料' };

test('成功：prompt 含步驟要求與上游產出、經 stdin 餵入；回傳 stdout 文字', async () => {
  let child;
  const adapter = createHostAdapter({ spawnFn: () => (child = fakeChild()) });
  const p = adapter.executeNode(NODE_ARGS);
  child.stdout.emit('data', '整理好的表格');
  child.emit('close', 0);
  assert.equal(await p, '整理好的表格');
  assert.ok(child.stdin.written.includes('整理歸納'));
  assert.ok(child.stdin.written.includes('整理成表'));
  assert.ok(child.stdin.written.includes('原始資料'));
  assert.ok(child.stdin.written.includes('不要反問'), '停點不是對話：prompt 要禁止反問使用者');
  assert.ok(child.stdin.written.includes('不提工具、連線、指令或系統名稱'), '缺什麼要說人話（排程與健檢輪）');
  assert.ok(child.stdin.written.includes('相同的語言'), '全篇語言跟指示一致（排程與健檢輪）');
});

test('產檔輪：fileMode → 放行寫檔（只限產出夾）與包裝指令（不放 Bash(node *)）、cwd＝產出夾、NODE_PATH 指自帶套件、prompt 帶產檔規則與檔名；沒 fileMode 一概不放', async () => {
  let child;
  let spawnArgs;
  let spawnExtra;
  const adapter = createHostAdapter({ spawnFn: (a, extra) => { spawnArgs = a; spawnExtra = extra; return (child = fakeChild()); } });
  const p = adapter.executeNode({ ...NODE_ARGS, attachments: ['C:/tmp/files/範本.docx'], fileMode: { cwd: 'C:/tmp/run-out', fileName: '報告.docx', templatePath: 'C:/tmp/files/範本.docx' } });
  child.stdout.emit('data', 'ok');
  child.emit('close', 0);
  await p;
  assert.equal(spawnArgs[spawnArgs.indexOf('--tools') + 1], 'WebSearch,WebFetch,Read,Write,Edit,Bash', '工具定義要送三件');
  assert.ok(spawnArgs.includes(editRuleFor('C:/tmp/run-out')), '寫檔只放行產出夾');
  for (const r of CAGE_BASH_RULES) assert.ok(spawnArgs.includes(r), `缺包裝規則 ${r}`);
  assert.ok(!spawnArgs.includes('Bash(node *)') && !spawnArgs.includes('Write') && !spawnArgs.includes('Edit') && !spawnArgs.includes('Bash'), '不准放行整個 node／整個 Write／Edit');
  assert.equal(spawnExtra.cwd, 'C:/tmp/run-out');
  assert.ok(spawnExtra.env.NODE_PATH.endsWith('node_modules'));
  assert.equal(spawnExtra.env.BOJIAN_CAGE_DIR, 'C:/tmp/run-out');
  assert.equal(spawnExtra.env.BOJIAN_CAGE_READ, 'C:/tmp/files/範本.docx');
  assert.equal(spawnExtra.env.BOJIAN_CAGE_LOG, undefined, '沒有 exec 就不寫 exec.log');
  assert.ok(child.stdin.written.includes('# 產檔規則') && child.stdin.written.includes('報告.docx') && child.stdin.written.includes('範本.docx'));
  assert.ok(child.stdin.written.includes('不准安裝任何套件'));
  assert.ok(child.stdin.written.includes(`執行腳本一律照這個寫法：${CAGE_CMD} 檔名.js`), '產檔規則也改走包裝指令');
  assert.ok(!child.stdin.written.includes('# 程式規則'), '產檔步驟由產檔規則段講，不重複程式規則段');
  const plain = adapter.renderPrompt(NODE_ARGS);
  assert.ok(!plain.includes('# 產檔規則'), '一般步驟沒有產檔規則段');
});

// ===== ADR-009：程式模式（exec）——每個 AI 步驟都能寫程式算數字，程式關進籠子 =====

test('籠子：包裝指令常數——CAGE_CMD 是 node "<正斜線絕對路徑>"；規則涵蓋正斜線／反斜線、不加引號／雙引號／單引號；沒有比它更寬的 Bash 規則', () => {
  assert.ok(path.isAbsolute(CAGE_PATH) && CAGE_PATH.endsWith(path.join('src', 'cage.mjs')));
  const fwd = CAGE_PATH.split('\\').join('/');
  assert.equal(CAGE_CMD, `node "${fwd}"`);
  assert.ok(CAGE_BASH_RULES.includes(`Bash(node ${fwd} *)`));
  assert.ok(CAGE_BASH_RULES.includes(`Bash(node "${fwd}" *)`));
  assert.ok(CAGE_BASH_RULES.includes(`Bash(node '${fwd}' *)`));
  const back = CAGE_PATH.split('/').join('\\');
  assert.ok(CAGE_BASH_RULES.includes(`Bash(node ${back} *)`) && CAGE_BASH_RULES.includes(`Bash(node "${back}" *)`));
  for (const r of CAGE_BASH_RULES) {
    assert.match(r, /^Bash\(node ['"]?.+cage\.mjs['"]? \*\)$/, `規則形狀不對：${r}`);
    assert.ok(!/^Bash\(node \*\)$/.test(r) && !/^Bash\(\*/.test(r), '不准出現 Bash(node *) 或更寬的');
  }
});

test('籠子：editRuleFor——Windows 路徑轉成 //<小寫碟號>/…/**、正斜線、去尾斜線、gitignore 特殊字元跳脫', () => {
  assert.equal(editRuleFor('C:\\Users\\someone\\AppData\\Local\\Temp\\run out'), 'Edit(//c/Users/someone/AppData/Local/Temp/run out/**)');
  assert.equal(editRuleFor('D:/work/bojian/data/runs/r-1/out/'), 'Edit(//d/work/bojian/data/runs/r-1/out/**)');
  assert.equal(editRuleFor('/tmp/run'), 'Edit(//tmp/run/**)');
  assert.equal(editRuleFor('C:/x/[2024] a*b?'), 'Edit(//c/x/\\[2024\\] a\\*b\\?/**)');
});

test('籠子：有 exec 沒 fileMode → --tools 三件、--allowedTools 只多 Edit(產出夾) 與包裝規則、env 帶對三個 BOJIAN_CAGE_*、cwd＝exec.cwd、prompt 含「# 程式規則」與包裝指令寫法', async () => {
  const a = capture();
  const adapter = createHostAdapter({ spawnFn: a.spawnFn });
  const args = { ...NODE_ARGS, attachments: ['C:/tmp/files/資料.csv', 'C:/tmp/files/名單.xlsx'], exec: { cwd: 'C:/tmp/run-out', logPath: 'C:/tmp/run/prompts/x.exec.log' } };
  await adapter.executeNode(args);
  assert.deepEqual(a.args, [
    '-p', '--output-format', 'json', '--permission-mode', 'default', '--settings', WORKER_SETTINGS,
    '--strict-mcp-config', '--disable-slash-commands',
    '--system-prompt', LEAN_WORKER_SYSTEM,
    '--tools', 'WebSearch,WebFetch,Read,Write,Edit,Bash',
    '--allowedTools', 'WebSearch', 'WebFetch', 'Read', editRuleFor('C:/tmp/run-out'), ...CAGE_BASH_RULES,
  ]);
  assert.equal(a.extra.cwd, 'C:/tmp/run-out');
  assert.equal(a.extra.env.BOJIAN_CAGE_DIR, 'C:/tmp/run-out');
  assert.equal(a.extra.env.BOJIAN_CAGE_READ, ['C:/tmp/files/資料.csv', 'C:/tmp/files/名單.xlsx'].join(path.delimiter));
  assert.equal(a.extra.env.BOJIAN_CAGE_LOG, 'C:/tmp/run/prompts/x.exec.log');
  assert.equal(a.extra.env.BOJIAN_CAGE_OUT, undefined, '沒給 outPath 就不帶（舊呼叫端）');
  assert.ok(a.extra.env.NODE_PATH.endsWith('node_modules'));
  const prompt = adapter.renderPrompt(args);
  assert.ok(prompt.includes('# 程式規則（嚴格遵守）'));
  assert.ok(prompt.includes(`執行程式一律照這個寫法：${CAGE_CMD} 檔名.js`), '工人要能照抄');
  assert.ok(prompt.includes('不准心算') && prompt.includes('不准安裝任何套件') && prompt.includes('不准連網') && prompt.includes('程式碼不要貼進產出'));
  assert.ok(prompt.includes('exceljs') && prompt.includes('pdfkit'), '可用套件要列出');
  assert.ok(!prompt.includes('# 產檔規則'), '不是產檔步驟');
  assert.ok(prompt.indexOf('# 程式規則') < prompt.indexOf('# 上一步的產出'), '程式規則段在上一步的產出之前');
  // 帶行李模式一樣開籠子
  const b = capture();
  await createHostAdapter({ spawnFn: b.spawnFn, lean: false }).executeNode(args);
  assert.deepEqual(b.args, ['-p', '--output-format', 'json', '--permission-mode', 'default', '--settings', WORKER_SETTINGS, '--allowedTools', 'WebSearch', 'WebFetch', 'Read', editRuleFor('C:/tmp/run-out'), ...CAGE_BASH_RULES]);
  assert.equal(b.extra.env.BOJIAN_CAGE_DIR, 'C:/tmp/run-out');
});

test('籠子：exec 與 fileMode 同時有 → cwd 取 exec.cwd、exec.log 照寫、exec.outPath → BOJIAN_CAGE_OUT、prompt 只有產檔規則段（含包裝指令）', async () => {
  const a = capture();
  const adapter = createHostAdapter({ spawnFn: a.spawnFn });
  const args = { ...NODE_ARGS, exec: { cwd: 'C:/tmp/run-out', logPath: 'C:/tmp/run/prompts/x.exec.log', outPath: 'C:/tmp/run/prompts/x.exec.out' }, fileMode: { cwd: 'C:/tmp/run-out', fileName: '報表.xlsx' } };
  await adapter.executeNode(args);
  assert.equal(a.extra.cwd, 'C:/tmp/run-out');
  assert.equal(a.extra.env.BOJIAN_CAGE_LOG, 'C:/tmp/run/prompts/x.exec.log');
  assert.equal(a.extra.env.BOJIAN_CAGE_OUT, 'C:/tmp/run/prompts/x.exec.out', 'ADR-010：完整 stdout 另存的路徑帶給籠子');
  assert.equal(a.extra.env.BOJIAN_CAGE_READ, '', '沒參考檔＝空字串');
  const prompt = adapter.renderPrompt(args);
  assert.ok(prompt.includes('# 產檔規則') && !prompt.includes('# 程式規則'));
  assert.ok(prompt.includes(CAGE_CMD));
});

test('籠子：沒 exec 也沒 fileMode → 工具定義不送三件、不放行任何 Edit(…)／Bash(…)、env 不帶籠子設定、prompt 沒有程式規則段', async () => {
  const a = capture();
  const adapter = createHostAdapter({ spawnFn: a.spawnFn });
  await adapter.executeNode({ ...NODE_ARGS, attachments: ['C:/tmp/files/資料.csv'] });
  assert.equal(a.args[a.args.indexOf('--tools') + 1], 'WebSearch,WebFetch,Read');
  assert.ok(!a.args.some((x) => x.startsWith('Edit(') || x.startsWith('Bash(') || x === 'Write' || x === 'Edit' || x === 'Bash'), a.args.join(' '));
  assert.deepEqual(a.extra, {});
  const prompt = adapter.renderPrompt({ ...NODE_ARGS, attachments: ['C:/tmp/files/資料.csv'] });
  assert.ok(!prompt.includes('# 程式規則') && !prompt.includes('cage.mjs'));
});

test('ADR-009 第 1、5 點：參考檔段標題改成「參考檔案／原始資料（…回這裡查…）」；「# 上一步的產出」底下多一行「不是原始資料」——第一步也有', () => {
  const adapter = createHostAdapter({});
  const withAtt = adapter.renderPrompt({ ...NODE_ARGS, attachments: ['C:/tmp/files/資料.csv'] });
  assert.ok(withAtt.includes('# 參考檔案／原始資料（先用你的檔案讀取能力逐一打開看；要下判斷、找異常、算數字時回這裡查，不要只靠上一步的整理）\n- C:/tmp/files/資料.csv'));
  assert.ok(withAtt.includes('# 上一步的產出（你的輸入）\n這是前面步驟整理過的內容，不是原始資料；跟原始資料衝突時以原始資料為準。\n原始資料'));
  const first = adapter.renderPrompt({ ...NODE_ARGS, upstream: '' });
  assert.ok(first.endsWith('# 上一步的產出（你的輸入）\n這是前面步驟整理過的內容，不是原始資料；跟原始資料衝突時以原始資料為準。\n（這是第一步，沒有上游輸入）'));
});

test('成品格式輪：檔名是 .pptx → 產檔規則段改教 pptxgenjs，並擋掉簡報的兩個翻車點', async () => {
  let child;
  const adapter = createHostAdapter({ spawnFn: () => (child = fakeChild()) });
  const p = adapter.executeNode({ ...NODE_ARGS, fileMode: { cwd: 'C:/tmp/run-out', fileName: '月報.pptx' } });
  child.stdout.emit('data', 'ok');
  child.emit('close', 0);
  await p;
  const w = child.stdin.written;
  assert.ok(w.includes('pptxgenjs') && w.includes('月報.pptx'), w);
  assert.ok(!w.includes('exceljs') && !w.includes('docxtemplater'), '別把其他格式的套件也塞給它');
  assert.ok(w.includes('一張投影片只放一個重點'), '擋「整段文章塞一張」');
  assert.ok(w.includes('不要指定成某個作業系統專有的'), '擋「自選 Windows 專有字型」——換一台電腦開就跑掉');
  assert.ok(w.includes('不寫 fontFace'), '教它把字型交給開啟的人');
});

test('步驟呼叫放行讀類工具（WebSearch/WebFetch/Read），不放行寫檔與執行；complete 不帶工具旗標', async () => {
  let child;
  let spawnArgs;
  const adapter = createHostAdapter({ spawnFn: (a) => { spawnArgs = a; return (child = fakeChild()); } });
  const p = adapter.executeNode(NODE_ARGS);
  child.stdout.emit('data', 'ok');
  child.emit('close', 0);
  await p;
  assert.ok(spawnArgs.includes('--allowedTools'));
  for (const t of ['WebSearch', 'WebFetch', 'Read']) assert.ok(spawnArgs.includes(t), `缺 ${t}`);
  for (const t of ['Write', 'Edit', 'Bash']) assert.ok(!spawnArgs.includes(t), `不准放行 ${t}`);
  assert.ok(!spawnArgs.some((x) => x.startsWith('Edit(') || x.startsWith('Bash(')), '沒開籠子＝連範圍規則也不放');
  let args2;
  const adapter2 = createHostAdapter({ spawnFn: (a) => { args2 = a; const c = fakeChild(); setTimeout(() => { c.stdout.emit('data', 'ok'); c.emit('close', 0); }, 0); return c; } });
  await adapter2.complete({ prompt: '掃描這份匯入內容' });
  assert.ok(!args2.includes('--allowedTools'), '匯入掃描等通用補全不放行工具（防外洩誘導）');
});

test('輸出格式：有給時 prompt 帶「產出格式要求」段落，沒給時不出現', async () => {
  let child;
  const adapter = createHostAdapter({ spawnFn: () => (child = fakeChild()) });
  const p = adapter.executeNode({ ...NODE_ARGS, outputFormat: 'Markdown 表格，欄位=日期/標題' });
  child.stdout.emit('data', 'ok');
  child.emit('close', 0);
  await p;
  assert.ok(child.stdin.written.includes('產出格式要求'));
  assert.ok(child.stdin.written.includes('Markdown 表格，欄位=日期/標題'));

  let child2;
  const adapter2 = createHostAdapter({ spawnFn: () => (child2 = fakeChild()) });
  const p2 = adapter2.executeNode(NODE_ARGS);
  child2.stdout.emit('data', 'ok');
  child2.emit('close', 0);
  await p2;
  assert.ok(!child2.stdin.written.includes('產出格式要求'));
});

test('進階欄位＋模型：prompt 帶角色/限制/風格/自檢段落，spawn 帶 --model', async () => {
  let child;
  let spawnArgs;
  const adapter = createHostAdapter({ spawnFn: (a) => { spawnArgs = a; return (child = fakeChild()); } });
  const p = adapter.executeNode({ ...NODE_ARGS, roleContext: '你是客服主管', constraints: '不承諾賠償金額', creativity: 'strict', reviewFocus: '數字要對得上', model: 'opus' });
  child.stdout.emit('data', 'ok');
  child.emit('close', 0);
  await p;
  assert.ok(spawnArgs.includes('--model') && spawnArgs.includes('opus'));
  for (const s of ['角色與情境', '你是客服主管', '限制條件', '不承諾賠償金額', '風格', '嚴謹精確', '自我檢查', '數字要對得上']) {
    assert.ok(child.stdin.written.includes(s), `prompt 缺「${s}」`);
  }
  // 沒給 model 時不帶 --model
  let child2;
  let args2;
  const adapter2 = createHostAdapter({ spawnFn: (a) => { args2 = a; return (child2 = fakeChild()); } });
  const p2 = adapter2.executeNode(NODE_ARGS);
  child2.stdout.emit('data', 'ok');
  child2.emit('close', 0);
  await p2;
  assert.ok(!args2.includes('--model'));
});

test('claude 不存在（spawn error）→ HostError UNAVAILABLE，訊息是人話', async () => {
  let child;
  const adapter = createHostAdapter({ spawnFn: () => (child = fakeChild()) });
  const p = adapter.executeNode(NODE_ARGS);
  child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
  await assert.rejects(p, (e) => e instanceof HostError && e.code === 'UNAVAILABLE' && e.message.includes('連不上 Claude') && e.message.includes('你的 Workflow 庫都在，不會不見。'));
});

test('結束碼非 0 → HostError FAILED，附 stderr 摘要', async () => {
  let child;
  const adapter = createHostAdapter({ spawnFn: () => (child = fakeChild()) });
  const p = adapter.executeNode(NODE_ARGS);
  child.stderr.emit('data', 'quota exceeded');
  child.emit('close', 1);
  await assert.rejects(p, (e) => e instanceof HostError && e.code === 'FAILED');
});

test('登入過期（訊息走 stdout、結束碼 1）→ HostError UNAVAILABLE，叫使用者去登入', async () => {
  let child;
  const adapter = createHostAdapter({ spawnFn: () => (child = fakeChild()) });
  const p = adapter.executeNode(NODE_ARGS);
  child.stdout.emit('data', 'Failed to authenticate: OAuth session expired and could not be refreshed');
  child.emit('close', 1);
  await assert.rejects(p, (e) => e instanceof HostError && e.code === 'UNAVAILABLE' && e.message.includes('登入') && e.message.includes('你的 Workflow 庫都在，不會不見。'));
});

// ===== A1（Codex 2026-09-25 審查）：主呼叫逾時要殺整棵子行程樹，並等它真的結束才回報 TIMEOUT =====
// 全部假 child／假 spawnFn／假 platform：不起、不殺任何真行程。
const TIMEOUT_MSG = '這一步等太久沒有回應，已先停下。可以按「重試這步」再來一次。';
const tick = () => new Promise((r) => setImmediate(r));
const KILL_PID = 999_999_998;

test('A1 逾時 win32：先起 taskkill /PID <pid> /T /F（此時還不 kill()）→ taskkill 結束後補 kill() → 子行程 close 之後才 onFail TIMEOUT；文案不變、標記已停乾淨', async () => {
  const calls = [];
  let child;
  let tk = null;
  const adapter = createHostAdapter({
    timeoutMs: 20,
    spawnFn: () => { child = fakeChild(); child.pid = KILL_PID; child.kill = () => calls.push('kill'); return child; },
    killTreeOpts: { spawnFn: (cmd, args) => { calls.push(['spawn', cmd, args]); tk = new EventEmitter(); return tk; }, platform: 'win32' },
  });
  let outcome = null;
  const p = adapter.executeNode(NODE_ARGS).then(() => { outcome = 'done'; }, (e) => { outcome = e; });
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(calls, [['spawn', 'taskkill', ['/PID', String(KILL_PID), '/T', '/F']]], '逾時先走 taskkill 帶 /PID /T /F，taskkill 還沒結束前不 kill()');
  assert.equal(outcome, null, '子行程樹還沒結束不准回報');
  tk.emit('exit', 0);
  assert.deepEqual(calls.slice(1), ['kill'], 'taskkill 結束後才補 kill()');
  await tick();
  assert.equal(outcome, null, 'kill() 之後、close 之前仍不准回報');
  child.emit('close', null);
  await p;
  assert.ok(outcome instanceof HostError && outcome.code === 'TIMEOUT', `close 之後才回報 TIMEOUT：${String(outcome)}`);
  assert.equal(outcome.message, TIMEOUT_MSG, '錯誤文案不變');
  assert.equal(outcome.stopConfirmed, true, '等到 close＝已確認停乾淨');
});

test('A1 逾時 非 win32：kill() 後等 close 才 onFail TIMEOUT（不碰 taskkill）', async () => {
  const calls = [];
  let child;
  const adapter = createHostAdapter({
    timeoutMs: 20,
    spawnFn: () => { child = fakeChild(); child.pid = KILL_PID; child.kill = () => calls.push('kill'); return child; },
    killTreeOpts: { spawnFn: (...a) => { calls.push(['spawn', ...a]); return new EventEmitter(); }, platform: 'linux' },
  });
  let outcome = null;
  const p = adapter.executeNode(NODE_ARGS).then(() => { outcome = 'done'; }, (e) => { outcome = e; });
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(calls, ['kill'], '非 win32 直接 kill()，不起 taskkill');
  assert.equal(outcome, null, 'kill() 之後、close 之前不准回報');
  child.emit('close', null);
  await p;
  assert.ok(outcome instanceof HostError && outcome.code === 'TIMEOUT' && outcome.message === TIMEOUT_MSG);
  assert.equal(outcome.stopConfirmed, true);
});

test('A1 逾時後 close 一直不來：等待上限（killWaitMs）到了仍 onFail TIMEOUT，且帶「未確認停乾淨」標記；文案不變', async () => {
  let child;
  const adapter = createHostAdapter({
    timeoutMs: 20,
    killWaitMs: 50,
    spawnFn: () => { child = fakeChild(); child.pid = KILL_PID; return child; },
    killTreeOpts: { spawnFn: () => new EventEmitter(), platform: 'linux' },
  });
  const t0 = Date.now();
  await assert.rejects(adapter.executeNode(NODE_ARGS), (e) => e instanceof HostError && e.code === 'TIMEOUT' && e.message === TIMEOUT_MSG
    && e.stopConfirmed === false && /還沒停乾淨/.test(e.detail ?? ''));
  assert.ok(Date.now() - t0 >= 60, '要等過 timeoutMs＋killWaitMs 才回報，不是立刻');
  assert.ok(child.killed, '上限到了也已經下過 kill()');
});

test('A1 逾時後遲來的 stdout／close 0 不會讓 onDone 被叫（帳本一筆都不記、結果仍是 TIMEOUT）', async () => {
  let child;
  const adapter = createHostAdapter({
    timeoutMs: 20,
    spawnFn: () => { child = fakeChild(); child.pid = KILL_PID; return child; },
    killTreeOpts: { spawnFn: () => new EventEmitter(), platform: 'linux' },
  });
  const entries = [];
  adapter.setUsageSink((u) => entries.push(u));
  let outcome = null;
  const p = adapter.executeNode({ ...NODE_ARGS, meta: { kind: 'step', run: 'r-late', node: 'x' } }).then(() => { outcome = 'done'; }, (e) => { outcome = e; });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(outcome, null);
  // 遲來的成功回覆：若 onDone 被叫，settleParsed 會把 usage 記進帳本
  child.stdout.emit('data', JSON.stringify({ type: 'result', is_error: false, result: '遲到的成品', usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: { m: {} } }));
  child.emit('close', 0);
  await p;
  assert.ok(outcome instanceof HostError && outcome.code === 'TIMEOUT', '逾時之後結果只能是 TIMEOUT');
  assert.deepEqual(entries, [], '遲來的 stdout 不得觸發 onDone（帳本沒有那一筆）');
});

test('complete：原文 prompt 直送 stdin、回 stdout 文字', async () => {
  let child;
  const adapter = createHostAdapter({ spawnFn: () => (child = fakeChild()) });
  const p = adapter.complete({ prompt: '把這件事拆成流程：訂餐廳' });
  child.stdout.emit('data', '好的\n```yaml\nname: x\n```');
  child.emit('close', 0);
  assert.ok((await p).includes('```yaml'));
  assert.equal(child.stdin.written, '把這件事拆成流程：訂餐廳');
});

// ===== --output-format json 解析＋用量帳本＋卷宗協定 =====
const jsonReply = (over = {}) => JSON.stringify({
  type: 'result', is_error: false, result: '整理好的表格', total_cost_usd: 0.0123,
  usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 },
  modelUsage: { 'claude-haiku-4-5': {} },
  ...over,
});

test('JSON 回覆：spawn 帶 json 格式、回 result 文字、usage 連同 meta 進帳本', async () => {
  let child;
  let spawnArgs;
  const adapter = createHostAdapter({ spawnFn: (a) => { spawnArgs = a; return (child = fakeChild()); } });
  const entries = [];
  adapter.setUsageSink((u) => entries.push(u));
  const p = adapter.executeNode({ ...NODE_ARGS, meta: { kind: 'step', run: 'r-1', node: 'x' } });
  child.stdout.emit('data', jsonReply());
  child.emit('close', 0);
  assert.equal(await p, '整理好的表格');
  assert.ok(spawnArgs.includes('json'), 'spawn 要帶 --output-format json');
  assert.equal(entries.length, 1);
  const u = entries[0];
  assert.equal(u.kind, 'step');
  assert.equal(u.run, 'r-1');
  assert.equal(u.input_tokens, 10);
  assert.equal(u.output_tokens, 20);
  assert.equal(u.cache_creation_input_tokens, 30);
  assert.equal(u.cache_read_input_tokens, 40);
  assert.equal(u.cost_usd, 0.0123);
  assert.equal(u.model, 'claude-haiku-4-5');
  assert.ok(u.at, '帳目要有時間戳');
});

test('JSON is_error → HostError FAILED 附宿主說明；帳照記（失敗的呼叫也花了 token）', async () => {
  let child;
  const adapter = createHostAdapter({ spawnFn: () => (child = fakeChild()) });
  const entries = [];
  adapter.setUsageSink((u) => entries.push(u));
  const p = adapter.executeNode(NODE_ARGS);
  child.stdout.emit('data', jsonReply({ is_error: true, result: '模型過載，稍後再試' }));
  child.emit('close', 0);
  await assert.rejects(p, (e) => e instanceof HostError && e.code === 'FAILED' && e.message.includes('模型過載'));
  assert.equal(entries.length, 1, 'is_error 也要記帳');
});

test('非 JSON 回覆（宿主版本差異防呆）→ 整段當純文字用、不記帳、不炸', async () => {
  let child;
  const adapter = createHostAdapter({ spawnFn: () => (child = fakeChild()) });
  const entries = [];
  adapter.setUsageSink((u) => entries.push(u));
  const p = adapter.complete({ prompt: '測', meta: { kind: 'compose' } });
  child.stdout.emit('data', '純文字回覆，不是 JSON');
  child.emit('close', 0);
  assert.equal(await p, '純文字回覆，不是 JSON');
  assert.equal(entries.length, 0);
});

test('complete 帶 meta：帳目 kind 歸戶正確', async () => {
  let child;
  const adapter = createHostAdapter({ spawnFn: () => (child = fakeChild()) });
  const entries = [];
  adapter.setUsageSink((u) => entries.push(u));
  const p = adapter.complete({ prompt: '測', meta: { kind: 'branch', run: 'r-2' } });
  child.stdout.emit('data', jsonReply({ result: '1. 走 A' }));
  child.emit('close', 0);
  assert.equal(await p, '1. 走 A');
  assert.equal(entries[0].kind, 'branch');
  assert.equal(entries[0].run, 'r-2');
});

test('卷宗協定：renderPrompt 與實際送進 stdin 的 prompt 一字不差', async () => {
  let child;
  const adapter = createHostAdapter({ spawnFn: () => (child = fakeChild()) });
  const args = { ...NODE_ARGS, roleContext: '你是客服主管', meta: { kind: 'step' }, model: 'opus' };
  const p = adapter.executeNode(args);
  child.stdout.emit('data', jsonReply());
  child.emit('close', 0);
  await p;
  assert.equal(adapter.renderPrompt(args), child.stdin.written);
});

// ===== buildPrompt 四新段 =====

test('buildPrompt：paramBlocks → 「# 欄位內容（原文）」段出現在「# 上一步的產出」之前，每塊帶 label 與原文', () => {
  const adapter = createHostAdapter({});
  const prompt = adapter.renderPrompt({
    ...NODE_ARGS,
    paramBlocks: [{ label: '來信', value: '寄件人：林小姐\n主旨：刮傷' }],
  });
  assert.ok(prompt.includes('# 欄位內容（原文）'));
  assert.ok(prompt.includes('【欄位：來信】'));
  assert.ok(prompt.includes('寄件人：林小姐\n主旨：刮傷'));
  assert.ok(prompt.indexOf('# 欄位內容（原文）') < prompt.indexOf('# 上一步的產出'), '欄位內容段要在上一步的產出之前');
});

test('buildPrompt：editRules → 「# 使用者在停點改過的要求（後面每一步都要守）」出現在「# 限制條件」之後，逐條列點', () => {
  const adapter = createHostAdapter({});
  const prompt = adapter.renderPrompt({
    ...NODE_ARGS,
    constraints: '不承諾賠償金額',
    editRules: ['每段不超過三句', '不用「親愛的」開頭'],
  });
  assert.ok(prompt.includes('# 使用者在停點改過的要求（後面每一步都要守）'));
  assert.ok(prompt.includes('- 每段不超過三句'));
  assert.ok(prompt.includes('- 不用「親愛的」開頭'));
  assert.ok(prompt.indexOf('# 限制條件') < prompt.indexOf('# 使用者在停點改過的要求'), '要在限制條件之後');
});

test('buildPrompt：redo → 「# 上一次交貨被查核退回（必須逐條修正，其餘保持）」出現在「# 交件前自我檢查」之後，blocks／missing 各一行', () => {
  const adapter = createHostAdapter({});
  const prompt = adapter.renderPrompt({
    ...NODE_ARGS,
    reviewFocus: '數字要對得上',
    redo: {
      blocks: [{ kind: 'number-mismatch', claim: '總數 13 件', source: '共 14 件', detail: '算式不成立：6+3+4+1=14' }],
      missing: [{ claim: '客戶滿意度', detail: '原始資料沒有調查結果' }],
    },
  });
  assert.ok(prompt.includes('# 上一次交貨被查核退回（必須逐條修正，其餘保持）'));
  assert.ok(prompt.includes('- 錯在哪：算式不成立：6+3+4+1=14｜成品寫：總數 13 件｜原始資料：共 14 件'));
  assert.ok(prompt.includes('- 原始資料沒有「客戶滿意度」，明寫未知或估計，不准編'));
  assert.ok(prompt.indexOf('# 交件前自我檢查') < prompt.indexOf('# 上一次交貨被查核退回'), '要在交件前自我檢查之後');
});

test('buildPrompt：redo 的 block 沒有 source（程式對數字攔的）→ 那一行只印「錯在哪：…｜成品寫：…」，不印空的「原始資料：」', () => {
  const adapter = createHostAdapter({});
  const prompt = adapter.renderPrompt({
    ...NODE_ARGS,
    redo: {
      blocks: [
        { kind: 'number-unsourced', claim: '退貨率 15.7%，比 7 月高', source: '', detail: '這個數字在程式輸出、數字檔、前面步驟與原始資料裡都找不到（可能是順口算的）；要用就讓程式印出來或寫進數字檔' },
        { kind: 'unsupported', claim: '成長最快是 C', source: '明細：C 第二', detail: '原始資料裡找不到根據' },
      ],
      missing: [],
    },
  });
  assert.ok(prompt.includes('- 錯在哪：這個數字在程式輸出、數字檔、前面步驟與原始資料裡都找不到（可能是順口算的）；要用就讓程式印出來或寫進數字檔｜成品寫：退貨率 15.7%，比 7 月高\n'), prompt);
  assert.ok(!prompt.includes('成品寫：退貨率 15.7%，比 7 月高｜原始資料：'), '沒有 source 就不印空的原始資料');
  assert.ok(prompt.includes('- 錯在哪：原始資料裡找不到根據｜成品寫：成長最快是 C｜原始資料：明細：C 第二'), '有 source 的照舊三段');
});

test('buildPrompt：checkNote → 「# 使用者的回話（這次必須照做）」緊接查核退回段之後；沒有 redo 也照樣出現在同一位置', () => {
  const adapter = createHostAdapter({});
  const prompt = adapter.renderPrompt({ ...NODE_ARGS, reviewFocus: '數字要對得上', checkNote: '這次要用千元為單位' });
  assert.ok(prompt.includes('# 使用者的回話（這次必須照做）'));
  assert.ok(prompt.includes('這次要用千元為單位'));
  assert.ok(prompt.indexOf('# 交件前自我檢查') < prompt.indexOf('# 使用者的回話'), '要在交件前自我檢查之後（沒有 redo 時緊接在同一位置）');
});

test('buildPrompt：四個新段都不給 → 輸出與現況逐字相同（固定樣本比對）', () => {
  const adapter = createHostAdapter({});
  const SAMPLE_ARGS = {
    nodeId: 'x', title: '整理歸納', instruction: '整理成表',
    roleContext: '你是客服主管', background: '過去三個月的客訴紀錄',
    constraints: '不承諾賠償金額', examples: '範例：客戶A 退貨 500 元',
    outputFormat: 'Markdown 表格，欄位=日期/標題', creativity: 'strict',
    reviewFocus: '數字要對得上', attachments: ['C:/tmp/files/範本.docx'],
    upstream: '原始資料',
  };
  const FIXED_SAMPLE = "你是「剝繭」流程裡的一個步驟執行者。只輸出這一步的產出內容本身——不要開場白、不要收尾語、不要解釋你做了什麼。\n這不是對話：沒有人會回覆你，你的產出會直接交給下一步（或給使用者過目，他只能核可或動手修改）。不要反問、不要邀請回覆、不要用「要哪個再說」收尾。任務要你提供多個選項時，自己選定一個推薦，讓產出以推薦版本為主體、備選附在後面標明。\n特例：如果要求裡指定的資料你拿不齊或拿不到——缺月份、缺欄位、少一段、工具不可用、搜尋無結果、上游沒交貨都算——第一行輸出「【資料不全】」加一句缺什麼，換行後再給你能給的部分。不准把「無項目」「找不到」這類空話當正式產出交出去。\n說明缺什麼時用使用者聽得懂的話講——只講「缺哪些資料、從哪裡拿得到」，不提工具、連線、指令或系統名稱。\n全篇使用與「要求」相同的語言，不夾雜其他語言的字詞（專有名詞照原文除外）。\n\n# 角色與情境\n你是客服主管\n\n# 這一步：整理歸納\n\n# 要求\n整理成表\n\n# 背景資料\n過去三個月的客訴紀錄\n\n# 限制條件（不可違反）\n不承諾賠償金額\n\n# 範例（照這個樣子）\n範例：客戶A 退貨 500 元\n\n# 參考檔案／原始資料（先用你的檔案讀取能力逐一打開看；要下判斷、找異常、算數字時回這裡查，不要只靠上一步的整理）\n- C:/tmp/files/範本.docx\n\n# 產出格式要求（嚴格遵守）\nMarkdown 表格，欄位=日期/標題\n\n# 風格\n嚴謹精確——照資料與要求寫，不自行發揮、不添加未經證實的內容。\n\n# 交件前自我檢查（使用者也會用同一標準驗收）\n數字要對得上\n\n# 上一步的產出（你的輸入）\n這是前面步驟整理過的內容，不是原始資料；跟原始資料衝突時以原始資料為準。\n原始資料";
  assert.equal(adapter.renderPrompt(SAMPLE_ARGS), FIXED_SAMPLE);
});

// ===== 工作單的「關於你」與「分類守則」兩段 =====

test('buildPrompt：coreNotes → 「# 關於你」段在「# 角色與情境」之前；groupRules → 「# 分類守則」段在「# 限制條件」之後、「# 使用者在停點改過的要求」之前；逐條列點', () => {
  const adapter = createHostAdapter({});
  const prompt = adapter.renderPrompt({
    ...NODE_ARGS,
    roleContext: '你是客服主管',
    constraints: '不承諾賠償金額',
    editRules: ['每段不超過三句'],
    coreNotes: ['不要恭維', '數字附來源'],
    groupRules: ['不提競品', '語氣：輕鬆'],
    groupName: '旅遊',
  });
  assert.ok(prompt.includes('# 關於你（每一步都照這些做；跟「要求」衝突時以「要求」為準）'));
  assert.ok(prompt.includes('- 不要恭維') && prompt.includes('- 數字附來源'));
  assert.ok(prompt.indexOf('# 關於你') < prompt.indexOf('# 角色與情境'), '關於你要在角色與情境之前');
  assert.ok(prompt.indexOf('# 關於你') > prompt.indexOf('不夾雜其他語言'), '關於你在開場五句之後');
  assert.ok(prompt.includes('# 分類守則（分類「旅遊」，一定要守）'));
  assert.ok(prompt.includes('- 不提競品') && prompt.includes('- 語氣：輕鬆'), '有名字的條原樣列');
  assert.ok(prompt.indexOf('# 限制條件') < prompt.indexOf('# 分類守則'), '群組段要在限制條件之後');
  assert.ok(prompt.indexOf('# 分類守則') < prompt.indexOf('# 使用者在停點改過的要求'), '群組段要在停點改過的要求之前');
  // 沒有角色與情境時，關於你段仍在「# 這一步」之前
  const noRole = adapter.renderPrompt({ ...NODE_ARGS, coreNotes: ['不要恭維'] });
  assert.ok(noRole.indexOf('# 關於你') < noRole.indexOf('# 這一步'));
});

test('buildPrompt：coreNotes／groupRules 空或沒給 → 兩段都不出現，輸出與現況逐字相同', () => {
  const adapter = createHostAdapter({});
  const base = adapter.renderPrompt({ ...NODE_ARGS, roleContext: '你是客服主管', constraints: '不承諾賠償金額' });
  assert.ok(!base.includes('# 關於你') && !base.includes('# 分類守則'));
  assert.equal(adapter.renderPrompt({ ...NODE_ARGS, roleContext: '你是客服主管', constraints: '不承諾賠償金額', coreNotes: [], groupRules: [], groupName: '旅遊' }), base);
});

test('卷宗協定：帶兩新段的 renderPrompt 與實際送進 stdin 的 prompt 一字不差', async () => {
  let child;
  const adapter = createHostAdapter({ spawnFn: () => (child = fakeChild()) });
  const args = { ...NODE_ARGS, roleContext: '你是客服主管', coreNotes: ['不要恭維'], groupRules: ['不提競品'], groupName: '旅遊', meta: { kind: 'step' } };
  const p = adapter.executeNode(args);
  child.stdout.emit('data', jsonReply());
  child.emit('close', 0);
  await p;
  assert.equal(adapter.renderPrompt(args), child.stdin.written);
  assert.ok(child.stdin.written.includes('# 關於你') && child.stdin.written.includes('# 分類守則'));
});

// ===== 工作單的監工交接段＋查網開關 =====

test('buildPrompt：supervisorNotes → 「# 監工交接」段出現在「# 上一步的產出」之前，逐條列點；空清單不出現', () => {
  const adapter = createHostAdapter({});
  const prompt = adapter.renderPrompt({ ...NODE_ARGS, supervisorNotes: ['開場：總表 14 件', '交接：按三類分節'] });
  assert.ok(prompt.includes('# 監工交接（這趟的備註，照做；跟「要求」衝突時以「要求」為準）'));
  assert.ok(prompt.includes('- 開場：總表 14 件'));
  assert.ok(prompt.includes('- 交接：按三類分節'));
  assert.ok(prompt.indexOf('# 監工交接') < prompt.indexOf('# 上一步的產出'), '要在上一步的產出之前');
  assert.ok(!adapter.renderPrompt({ ...NODE_ARGS, supervisorNotes: [] }).includes('# 監工交接'));
  assert.ok(!adapter.renderPrompt(NODE_ARGS).includes('# 監工交接'));
});

test('監工輪：web=false → --tools 與 --allowedTools 都不放行查網；缺省照舊放行', async () => {
  const spawnFor = async (args) => {
    let child;
    let spawnArgs;
    const adapter = createHostAdapter({ spawnFn: (a) => { spawnArgs = a; return (child = fakeChild()); } });
    const p = adapter.executeNode(args);
    child.stdout.emit('data', 'ok');
    child.emit('close', 0);
    await p;
    return spawnArgs;
  };
  const off = await spawnFor({ ...NODE_ARGS, web: false });
  assert.equal(off[off.indexOf('--tools') + 1], 'Read');
  assert.ok(!off.includes('WebSearch') && !off.includes('WebFetch'), `關了查網就一個都不准出現：${off}`);
  const on = await spawnFor(NODE_ARGS);
  assert.equal(on[on.indexOf('--tools') + 1], 'WebSearch,WebFetch,Read');
  assert.deepEqual(on.slice(on.indexOf('--allowedTools')), ['--allowedTools', 'WebSearch', 'WebFetch', 'Read']);
  const offFile = await spawnFor({ ...NODE_ARGS, web: false, fileMode: { cwd: 'C:/tmp/o', fileName: '報告.docx', templatePath: null } });
  assert.equal(offFile[offFile.indexOf('--tools') + 1], 'Read,Write,Edit,Bash', '產檔工具照放，只拿掉查網');
  assert.deepEqual(offFile.slice(offFile.indexOf('--allowedTools')), ['--allowedTools', 'Read', editRuleFor('C:/tmp/o'), ...CAGE_BASH_RULES]);
});

test('checkAvailable：結束碼 0 → true；spawn error → false', async () => {
  let child;
  const adapter = createHostAdapter({ spawnFn: () => (child = fakeChild()) });
  const p = adapter.checkAvailable();
  child.emit('close', 0);
  assert.equal(await p, true);
  const adapter2 = createHostAdapter({ spawnFn: () => (child = fakeChild()) });
  const p2 = adapter2.checkAvailable();
  child.emit('error', new Error('ENOENT'));
  assert.equal(await p2, false);
});

// ===== 不帶行李模式（BOJIAN_LEAN）：預設關；開了才換系統提示、只送用得到的工具定義 =====

// 自動應答的假子行程：spawn 參數留底，下一個 tick 回一筆 JSON 讓 promise 收斂
function capture(reply = jsonReply()) {
  const rec = {};
  rec.spawnFn = (a, extra) => {
    rec.args = a;
    rec.extra = extra;
    const c = fakeChild();
    setTimeout(() => { c.stdout.emit('data', reply); c.emit('close', 0); }, 0);
    return c;
  };
  return rec;
}

// 環境變數在測試間會互相污染：明確設定／清掉，跑完還原
async function withLeanEnv(value, fn) {
  const saved = process.env.BOJIAN_LEAN;
  if (value === undefined) delete process.env.BOJIAN_LEAN;
  else process.env.BOJIAN_LEAN = value;
  try { return await fn(); } finally {
    if (saved === undefined) delete process.env.BOJIAN_LEAN;
    else process.env.BOJIAN_LEAN = saved;
  }
}

const FM = { cwd: 'C:/tmp/run-out', fileName: '報告.docx' };

test('帶行李：明講關閉（lean:false）——executeNode／complete 的 spawn 參數與現況逐字相同', async () => {
  await withLeanEnv(undefined, async () => {
    const a = capture();
    const adapter = createHostAdapter({ spawnFn: a.spawnFn, lean: false });
    await adapter.executeNode(NODE_ARGS);
    assert.deepEqual(a.args, ['-p', '--output-format', 'json', '--permission-mode', 'default', '--settings', WORKER_SETTINGS, '--allowedTools', 'WebSearch', 'WebFetch', 'Read']);
    assert.equal(adapter.isLean(), false);

    const b = capture();
    await createHostAdapter({ spawnFn: b.spawnFn, lean: false }).executeNode({ ...NODE_ARGS, model: 'opus', fileMode: FM });
    assert.deepEqual(b.args, ['-p', '--output-format', 'json', '--permission-mode', 'default', '--settings', WORKER_SETTINGS, '--allowedTools', 'WebSearch', 'WebFetch', 'Read', editRuleFor('C:/tmp/run-out'), ...CAGE_BASH_RULES, '--model', 'opus']);

    const c = capture();
    await createHostAdapter({ spawnFn: c.spawnFn, lean: false }).complete({ prompt: '測' });
    assert.deepEqual(c.args, ['-p', '--output-format', 'json', '--permission-mode', 'default', '--settings', WORKER_SETTINGS]);
  });
});

test('不帶行李：沒給 option、沒設環境變數——預設就是輕裝', async () => {
  await withLeanEnv(undefined, async () => {
    const a = capture();
    const adapter = createHostAdapter({ spawnFn: a.spawnFn });
    assert.equal(adapter.isLean(), true);
    await adapter.executeNode(NODE_ARGS);
    assert.deepEqual(a.args, [
      '-p', '--output-format', 'json', '--permission-mode', 'default', '--settings', WORKER_SETTINGS,
      '--strict-mcp-config', '--disable-slash-commands',
      '--system-prompt', LEAN_WORKER_SYSTEM,
      '--tools', 'WebSearch,WebFetch,Read',
      '--allowedTools', 'WebSearch', 'WebFetch', 'Read',
    ]);

    const c = capture();
    await createHostAdapter({ spawnFn: c.spawnFn }).complete({ prompt: '測' });
    assert.deepEqual(c.args, [
      '-p', '--output-format', 'json', '--permission-mode', 'default', '--settings', WORKER_SETTINGS,
      '--strict-mcp-config', '--disable-slash-commands',
      '--system-prompt', LEAN_GENERIC_SYSTEM,
      '--tools', '',
    ]);
  });
});

test('不帶行李：option 明寫開啟——executeNode 依序帶六個輕裝旗標，--tools 只列用得到的，--allowedTools 清單原封不動接在後面', async () => {
  await withLeanEnv(undefined, async () => {
    const a = capture();
    const adapter = createHostAdapter({ spawnFn: a.spawnFn, lean: true });
    await adapter.executeNode(NODE_ARGS);
    assert.equal(adapter.isLean(), true);
    assert.deepEqual(a.args, [
      '-p', '--output-format', 'json', '--permission-mode', 'default', '--settings', WORKER_SETTINGS,
      '--strict-mcp-config', '--disable-slash-commands',
      '--system-prompt', LEAN_WORKER_SYSTEM,
      '--tools', 'WebSearch,WebFetch,Read',
      '--allowedTools', 'WebSearch', 'WebFetch', 'Read',
    ]);

    const b = capture();
    await createHostAdapter({ spawnFn: b.spawnFn, lean: true }).executeNode({ ...NODE_ARGS, model: 'opus', fileMode: FM });
    assert.deepEqual(b.args, [
      '-p', '--output-format', 'json', '--permission-mode', 'default', '--settings', WORKER_SETTINGS,
      '--strict-mcp-config', '--disable-slash-commands',
      '--system-prompt', LEAN_WORKER_SYSTEM,
      '--tools', 'WebSearch,WebFetch,Read,Write,Edit,Bash',
      '--allowedTools', 'WebSearch', 'WebFetch', 'Read', editRuleFor('C:/tmp/run-out'), ...CAGE_BASH_RULES,
      '--model', 'opus',
    ]);
    assert.equal(b.extra.cwd, 'C:/tmp/run-out', '產檔模式的工作目錄與 NODE_PATH 不受輕裝影響');
    assert.ok(b.extra.env.NODE_PATH.endsWith('node_modules'));

    const c = capture();
    await createHostAdapter({ spawnFn: c.spawnFn, lean: true }).complete({ prompt: '測' });
    assert.deepEqual(c.args, [
      '-p', '--output-format', 'json', '--permission-mode', 'default', '--settings', WORKER_SETTINGS,
      '--strict-mcp-config', '--disable-slash-commands',
      '--system-prompt', LEAN_GENERIC_SYSTEM,
      '--tools', '',
    ]);
    assert.ok(!c.args.includes('--allowedTools'), '通用補全照樣不放行工具');
  });
});

test('不帶行李：兩段系統提示是導出的常數（A/B 報告要引用原文）', () => {
  assert.match(LEAN_WORKER_SYSTEM, /^你是剝繭流程裡的一名工人。/);
  assert.ok(LEAN_WORKER_SYSTEM.includes('訊息沒要求的不要做'));
  // A／B 第二回合：輕裝工人每一步都自報資料不全、還編了沒有依據的數字，工人提示補三條規則
  assert.ok(LEAN_WORKER_SYSTEM.includes('就用手上的資料判斷'), '被要求判斷／評分／排序時要自己判斷');
  assert.ok(LEAN_WORKER_SYSTEM.includes('不要因為資料不完整就停下'), '只有必要原始資料真的沒給才回報資料不全');
  assert.ok(LEAN_WORKER_SYSTEM.includes('不准編'), '沒有的數字要寫未知，不准編');
  assert.match(LEAN_GENERIC_SYSTEM, /^只照接下來訊息裡的指示做事/);
  assert.ok(LEAN_GENERIC_SYSTEM.includes('只輸出訊息要求的格式'));
});

test('不帶行李：每筆用量帳都帶 lean 欄位（A/B 才分得出哪些呼叫是輕裝）', async () => {
  await withLeanEnv(undefined, async () => {
    for (const lean of [false, true]) {
      const a = capture();
      const adapter = createHostAdapter({ spawnFn: a.spawnFn, lean });
      const entries = [];
      adapter.setUsageSink((u) => entries.push(u));
      await adapter.executeNode({ ...NODE_ARGS, meta: { kind: 'step', run: 'r-1' } });
      await adapter.complete({ prompt: '測', meta: { kind: 'checker' } });
      assert.equal(entries.length, 2);
      for (const u of entries) assert.equal(u.lean, lean, `lean=${lean} 的帳目要標 lean`);
      assert.equal(entries[0].kind, 'step', '其他欄位照舊');
      assert.equal(entries[0].input_tokens, 10);
    }
  });
});

test('解析順序：option 明寫優先，其次環境變數 BOJIAN_LEAN，都沒有才落到預設輕裝', async () => {
  await withLeanEnv('1', async () => {
    const a = capture();
    const adapter = createHostAdapter({ spawnFn: a.spawnFn });
    assert.equal(adapter.isLean(), true);
    await adapter.executeNode(NODE_ARGS);
    assert.ok(a.args.includes('--strict-mcp-config') && a.args.includes('--tools'));
    assert.equal(createHostAdapter({ spawnFn: capture().spawnFn, lean: false }).isLean(), false, 'option 明寫 false 要蓋過環境變數');
    assert.equal(createHostAdapter({ spawnFn: capture().spawnFn, lean: true }).isLean(), true, 'option 明寫 true 也蓋過環境變數');
  });
  for (const legacyVal of ['0', 'false', 'off']) {
    await withLeanEnv(legacyVal, async () => {
      assert.equal(createHostAdapter({ spawnFn: capture().spawnFn }).isLean(), false, `BOJIAN_LEAN=${legacyVal} 要退回帶行李`);
    });
  }
});

test('BOJIAN_LEAN=0：退回帶行李——spawn 參數與帶行李版本逐字相同', async () => {
  await withLeanEnv('0', async () => {
    const a = capture();
    const adapter = createHostAdapter({ spawnFn: a.spawnFn });
    assert.equal(adapter.isLean(), false);
    await adapter.executeNode(NODE_ARGS);
    assert.deepEqual(a.args, ['-p', '--output-format', 'json', '--permission-mode', 'default', '--settings', WORKER_SETTINGS, '--allowedTools', 'WebSearch', 'WebFetch', 'Read']);
  });
});

// 連接器例外——探針（reviews/-實走-2026-09-09/連接器探針.md）判定停在第一層，
// 兇手是 --strict-mcp-config：不推它連接器就回來了，其餘輕裝旗標照推。
test('連接器例外：meta.mcp 的呼叫不推 --strict-mcp-config、--allowedTools 加行事曆工具；其餘呼叫照舊嚴格', async () => {
  const a = capture();
  const adapter = createHostAdapter({ spawnFn: a.spawnFn });
  await adapter.complete({ prompt: '抓快照', meta: { kind: 'snapshot', mcp: 'calendar' } });
  assert.ok(!a.args.includes('--strict-mcp-config'), '行事曆呼叫不能推 --strict-mcp-config');
  assert.ok(a.args.includes('--disable-slash-commands'), '其餘輕裝旗標照推');
  assert.ok(a.args.includes('--tools'), '--tools 照推（探針證實它不擋連接器）');
  assert.ok(a.args.includes('--allowedTools') && CALENDAR_TOOLS.every((t) => a.args.includes(t)), '權限閘要逐一放行行事曆讀類工具');

  const b = capture();
  await createHostAdapter({ spawnFn: b.spawnFn }).complete({ prompt: '查核', meta: { kind: 'check' } });
  assert.ok(b.args.includes('--strict-mcp-config'), '一般通用補全照舊嚴格');
  assert.equal(b.extra?.env?.MAX_THINKING_TOKENS, '0', '查核員關掉思考：kind=check 的子行程帶 MAX_THINKING_TOKENS=0');
  const b2 = capture();
  await createHostAdapter({ spawnFn: b2.spawnFn }).complete({ prompt: '交接', meta: { kind: 'supervisor' } });
  assert.equal(b2.extra?.env?.MAX_THINKING_TOKENS, undefined, '監工等其他通用補全不關思考');
  assert.ok(!CALENDAR_TOOLS.some((t) => b.args.includes(t)), '一般呼叫不放行行事曆工具');

  const c = capture();
  await createHostAdapter({ spawnFn: c.spawnFn }).executeNode({ ...NODE_ARGS, meta: { kind: 'step', mcp: 'calendar' } });
  assert.ok(!c.args.includes('--strict-mcp-config'));
  assert.ok(CALENDAR_TOOLS.every((t) => c.args.includes(t)) && c.args.includes('Read') && c.args.includes('WebSearch'), '行事曆工具是加上去的，讀類工具照舊');

  const d = capture();
  await createHostAdapter({ spawnFn: d.spawnFn }).executeNode({ ...NODE_ARGS, meta: { kind: 'step' } });
  assert.ok(d.args.includes('--strict-mcp-config') && !CALENDAR_TOOLS.some((t) => d.args.includes(t)), '沒有 mcp 的步驟照舊輕裝');
});

// ===== 工作單的「公司規範」與「分類規範」兩段（規範類每步都帶、全文貼進去；外圈在前：公司→分類→分類守則） =====

test('U1b ①：companyRules／deptRules → 「# 公司規範」「# 部門規範」在「# 限制條件」之後、「# 分類守則」之前；每檔「## 檔名」＋全文；空層不印段', () => {
  const adapter = createHostAdapter({});
  const prompt = adapter.renderPrompt({
    ...NODE_ARGS,
    roleContext: '你是客服主管',
    constraints: '不承諾賠償金額',
    editRules: ['每段不超過三句'],
    coreNotes: ['不要恭維'],
    groupRules: ['不提競品'],
    groupName: '旅遊',
    companyRules: [{ name: '員工手冊.md', text: '語氣要親切，不用敬語堆疊。' }, { name: '品牌語氣.txt', text: '不說「尊榮」。' }],
    deptRules: [{ name: '部門規範.docx', text: '報價一律含稅。' }],
  });
  assert.ok(prompt.includes('# 公司規範（每一步都照做；查核員也會對）'), prompt);
  assert.ok(prompt.includes('## 員工手冊.md\n語氣要親切，不用敬語堆疊。'));
  assert.ok(prompt.includes('## 品牌語氣.txt\n不說「尊榮」。'));
  assert.ok(prompt.includes('# 部門規範（分類「旅遊」，同上）'), prompt);
  assert.ok(prompt.includes('## 部門規範.docx\n報價一律含稅。'));
  const at = (h) => prompt.indexOf(h);
  assert.ok(at('# 關於你') < at('# 限制條件') && at('# 限制條件') < at('# 公司規範'), '公司規範在限制條件之後');
  assert.ok(at('# 公司規範') < at('# 部門規範') && at('# 部門規範') < at('# 分類守則'), '外圈在前：公司→部門→分類守則');
  assert.ok(at('# 分類守則') < at('# 使用者在停點改過的要求'), '分類守則仍在停點改過的要求之前');
  const onlyDept = adapter.renderPrompt({ ...NODE_ARGS, groupName: '旅遊', companyRules: [], deptRules: [{ name: 'd.md', text: 'x' }] });
  assert.ok(!onlyDept.includes('# 公司規範') && onlyDept.includes('# 部門規範（分類「旅遊」，同上）\n## d.md\nx'), '空層不印段');
});

test('U1b ①：兩層皆空或沒給 → 「規範」零命中，輸出與現況逐字相同', () => {
  const adapter = createHostAdapter({});
  const args = { ...NODE_ARGS, roleContext: '你是客服主管', constraints: '不承諾賠償金額', groupRules: ['不提競品'], groupName: '旅遊' };
  const base = adapter.renderPrompt(args);
  assert.equal((base.match(/規範/g) ?? []).length, 0);
  assert.equal(adapter.renderPrompt({ ...args, companyRules: [], deptRules: [] }), base);
});

test('U1b 卷宗協定：帶規範兩段的 renderPrompt 與實際送進 stdin 的 prompt 一字不差', async () => {
  let child;
  const adapter = createHostAdapter({ spawnFn: () => (child = fakeChild()) });
  const args = { ...NODE_ARGS, companyRules: [{ name: '手冊.md', text: '語氣要親切。' }], deptRules: [{ name: '部門.md', text: '含稅。' }], groupName: '旅遊', meta: { kind: 'step' } };
  const p = adapter.executeNode(args);
  child.stdout.emit('data', jsonReply());
  child.emit('close', 0);
  await p;
  assert.equal(adapter.renderPrompt(args), child.stdin.written);
  assert.ok(child.stdin.written.includes('## 手冊.md\n語氣要親切。'));
});

test('U1b 覆核該修：規範內文行首 # 全部降一級（# → ##、###### 封頂）——全文 ^# 開頭的行只剩系統段標題', () => {
  const adapter = createHostAdapter({});
  const prompt = adapter.renderPrompt({
    ...NODE_ARGS,
    groupName: '旅遊',
    companyRules: [{ name: '員工手冊.md', text: '# 員工手冊\n語氣要親切。\n## 請假\n前一天說。\n###### 六級\n#不是標題\n  # 縮排不算' }],
    deptRules: [{ name: '部門.md', text: '# 部門規範\n含稅。' }],
  });
  assert.ok(prompt.includes('## 員工手冊.md\n## 員工手冊\n語氣要親切。\n### 請假\n前一天說。\n###### 六級\n#不是標題\n  # 縮排不算'), prompt);
  assert.ok(prompt.includes('## 部門.md\n## 部門規範\n含稅。'));
  const h1 = prompt.split('\n').filter((l) => /^# /.test(l));
  assert.deepEqual(h1, ['# 這一步：整理歸納', '# 要求', '# 公司規範（每一步都照做；查核員也會對）', '# 部門規範（分類「旅遊」，同上）', '# 上一步的產出（你的輸入）'], '一級標題只剩系統段');
});

// ── 2026-09-18 真子行程迴歸（假 stream 驗不到編碼，只有真的 pipe 才會分塊）──

test('長中文產出不被切壞：stdout 跨 64KB 塊界的中文要原樣回來', async () => {
  const { spawn } = await import('node:child_process');
  const N = 60_000; // 「繭」3 bytes × 60000 ＝ 180KB，必定跨好幾個 64KB 塊界
  // 真子行程：由它自己生字，避免把 180KB 塞進命令列（Windows 命令列有長度上限）
  const code = `process.stdout.write(JSON.stringify({ type: 'result', result: '繭'.repeat(${N}) }))`;
  const adapter = createHostAdapter({ spawnFn: () => spawn(process.execPath, ['-e', code]) });
  const out = await adapter.complete({ prompt: 'x' });
  assert.equal(out.includes('�'), false, 'stdout 出現 U+FFFD＝跨塊的中文被切壞了');
  assert.equal(out.length, N, `產出長度應為 ${N}，實得 ${out.length}`);
});

test('子行程在工作單寫完前就死掉：回人話錯誤，不把行程炸掉', async () => {
  const { spawn } = await import('node:child_process');
  // 立刻結束、完全不讀 stdin 的子行程；工作單夠大才會留下沒排空的 write（EPIPE 的必要條件）
  const adapter = createHostAdapter({ spawnFn: () => spawn(process.execPath, ['-e', 'process.exit(1)']) });
  await assert.rejects(
    () => adapter.complete({ prompt: 'x'.repeat(2_000_000) }),
    (e) => e instanceof HostError,
    '應回 HostError，而不是讓未捕捉的 stdin EPIPE 把整個行程帶走',
  );
});

test('PDF 的產檔規則段：教 pdfkit、給內建字型的絕對路徑、講明不要去下載字型', async () => {
  let child;
  const adapter = createHostAdapter({ spawnFn: () => (child = fakeChild()) });
  const p = adapter.executeNode({ ...NODE_ARGS, fileMode: { cwd: 'C:/tmp/run-out', fileName: '月報.pdf' } });
  child.stdout.emit('data', 'ok');
  child.emit('close', 0);
  await p;
  const w = child.stdin.written;
  assert.ok(w.includes('pdfkit') && w.includes('月報.pdf'), w);
  assert.ok(w.includes("registerFont('tc'"), '一定要先註冊字型');
  assert.ok(w.includes('NotoSansTC-Regular.otf'), '給的是內建字型的絕對路徑');
  assert.ok(w.includes('不要去下載'), '擋「自己上網抓字型」');
  assert.ok(!w.includes('pptxgenjs') && !w.includes('exceljs'), '別把其他格式的套件塞給它');
});

// ---- 連線輪（ADR-006）：勾了服務才看得到外部服務；沒勾的步驟一字不變 ----
const CONN_GMAIL = {
  names: ['claude.ai Gmail'], labels: ['Gmail'],
  read: ['mcp__claude_ai_Gmail__search_threads', 'mcp__claude_ai_Gmail__get_message'],
  blocked: ['mcp__claude_ai_Gmail__send_message', 'mcp__claude_ai_Gmail__trash_message', 'mcp__claude_ai_Gmail__create_draft'],
  others: ['mcp__claude_ai_Google_Drive__*', 'mcp__claude_ai_Google_Calendar__*'],
};

test('連線：勾了服務的步驟不推 --strict-mcp-config、讀類逐一放行、寫類與別家進 --disallowedTools；沒勾的步驟照舊嚴格且一個外部工具都不列', async () => {
  await withLeanEnv(undefined, async () => {
    const a = capture();
    await createHostAdapter({ spawnFn: a.spawnFn }).executeNode({ ...NODE_ARGS, connectors: CONN_GMAIL });
    assert.deepEqual(a.args, [
      '-p', '--output-format', 'json', '--permission-mode', 'default', '--settings', WORKER_SETTINGS,
      '--disable-slash-commands',
      '--system-prompt', LEAN_WORKER_SYSTEM,
      '--tools', 'WebSearch,WebFetch,Read',
      '--allowedTools', 'WebSearch', 'WebFetch', 'Read', 'mcp__claude_ai_Gmail__search_threads', 'mcp__claude_ai_Gmail__get_message',
      '--disallowedTools', 'mcp__claude_ai_Gmail__send_message', 'mcp__claude_ai_Gmail__trash_message', 'mcp__claude_ai_Gmail__create_draft',
      'mcp__claude_ai_Google_Drive__*', 'mcp__claude_ai_Google_Calendar__*',
    ]);
    const b = capture();
    await createHostAdapter({ spawnFn: b.spawnFn }).executeNode({ ...NODE_ARGS });
    assert.ok(b.args.includes('--strict-mcp-config'), '沒勾的步驟照推 --strict-mcp-config');
    assert.ok(!b.args.includes('--disallowedTools') && !b.args.some((x) => x.startsWith('mcp__')), '沒勾＝看不到任何外部服務');
    const e = capture();
    await createHostAdapter({ spawnFn: e.spawnFn }).executeNode({ ...NODE_ARGS, connectors: { names: [], labels: [], read: [], blocked: [], others: [] } });
    assert.ok(e.args.includes('--strict-mcp-config'), '勾的服務一家都不能用（沒連上）＝照舊嚴格');
    // 同時要等時間（行事曆例外）：行事曆讀類照放行，不被「沒勾的服務整家擋」擋掉
    const c = capture();
    await createHostAdapter({ spawnFn: c.spawnFn }).executeNode({ ...NODE_ARGS, connectors: CONN_GMAIL, meta: { kind: 'step', mcp: 'calendar' } });
    const deny = c.args.slice(c.args.indexOf('--disallowedTools') + 1);
    assert.ok(!deny.includes('mcp__claude_ai_Google_Calendar__*'));
    assert.ok(CALENDAR_TOOLS.every((t) => c.args.includes(t)) && CALENDAR_BLOCKED.every((t) => deny.includes(t)));
    // 帶行李模式一樣加兩道閘
    const d = capture();
    await createHostAdapter({ spawnFn: d.spawnFn, lean: false }).executeNode({ ...NODE_ARGS, connectors: CONN_GMAIL });
    assert.ok(d.args.includes('mcp__claude_ai_Gmail__get_message') && d.args.includes('--disallowedTools') && !d.args.includes('mcp__claude_ai_Gmail__*'));
  });
});

test('連線：工作單多一段「這一步可以讀的外部服務」（只能讀）；沒勾不印；快照呼叫的寫類行事曆工具進 --disallowedTools', async () => {
  const withConn = createHostAdapter({ spawnFn: capture().spawnFn }).renderPrompt({ ...NODE_ARGS, connectors: CONN_GMAIL });
  assert.ok(withConn.includes('# 這一步可以讀的外部服務（只能搜尋、讀取、列出、下載；不能寄出、建立、修改、刪除或分享任何東西）\n- Gmail'));
  assert.ok(!createHostAdapter({ spawnFn: capture().spawnFn }).renderPrompt(NODE_ARGS).includes('外部服務'));
  const a = capture();
  await createHostAdapter({ spawnFn: a.spawnFn }).complete({ prompt: '抓快照', meta: { kind: 'snapshot', mcp: 'calendar' } });
  const deny = a.args.slice(a.args.indexOf('--disallowedTools') + 1);
  assert.ok(deny.includes('mcp__claude_ai_Google_Calendar__create_event') && deny.includes('mcp__claude_ai_Google_Calendar__delete_event'));
  assert.ok(!a.args.slice(a.args.indexOf('--allowedTools') + 1, a.args.indexOf('--disallowedTools')).some((t) => t.includes('create_event') || t.endsWith('*')));
});

test('連線：readHostInit 的預設殺法——子行程有 pid 就殺整棵（Windows 走 taskkill /T /F）；沒 pid 退回 kill()', async () => {
  let child;
  const killed = [];
  const p = readHostInit({ spawnFn: () => (child = (() => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = { write() {}, end() {}, on() {} }; c.kill = () => killed.push('kill'); return c; })()) });
  child.stdout.emit('data', '{"type":"system","subtype":"init","mcp_servers":[],"tools":[]}\n');
  const init = await p;
  assert.equal(init.subtype, 'init');
  assert.deepEqual(killed, ['kill'], '沒 pid 的假子行程只走 kill()');
});

// ===== 數字檔約定（US-110）：算數字的步驟把指標寫成 數字-<步驟id>.json，後步與產檔步驟先讀不重算 =====
const SAME_OLD_PROGRAM = '目前工作目錄就是這一步的資料夾。上一步已經算好的數字直接沿用，不要重算；只有這一步需要新的數字（算、統計、分組、排序、比對）而上一步沒給時，才寫一支短的 .js 放在目前目錄、用下面的包裝指令執行，程式只印你要用的那幾個數字，不要把整份資料印出來；不准心算、不准在腦中加總。';
const SAME_OLD_FILE = '只寫一支短程式、只做一件事：把上一步算好的數字與內容寫進檔案。數字直接沿用上一步的產出，不要重讀資料重算；不要另外寫驗證、清理、預覽、比對的腳本；檔案寫出來就結束，不要反覆改版。';

test('數字檔：程式規則段——有 numbersFile 多一句寫數字檔、有 priorNumbersFiles 多一句先讀不重算；兩個都沒有＝原段逐字不變', async () => {
  const adapter = createHostAdapter({ spawnFn: capture().spawnFn });
  const base = { cwd: 'C:/tmp/run-out', logPath: 'C:/tmp/run/prompts/x.exec.log' };
  const plain = adapter.renderPrompt({ ...NODE_ARGS, exec: base });
  const both = adapter.renderPrompt({ ...NODE_ARGS, exec: { ...base, numbersFile: '數字-c.json', priorNumbersFiles: ['數字-a.json', '數字-b.json'] } });
  const onlyWrite = adapter.renderPrompt({ ...NODE_ARGS, exec: { ...base, numbersFile: '數字-a.json', priorNumbersFiles: [] } });
  const WRITE = '如果這一步真的寫了程式算數字，算出來要用的數字除了印出來，還要由同一支程式寫成「數字-c.json」放目前目錄：JSON 物件，鍵＝指標名（用成品裡會出現的名稱），值＝數字（不是字串）。';
  const NOTE = '這些規則只管你怎麼做事：產出裡不要提到程式、數字檔，也不要寫「不需計算」「無需寫程式」這類話。';
  const READ = '目前目錄已有前面步驟算好的數字檔：「數字-a.json」、「數字-b.json」——先用 Read 打開讀，裡面有的數字直接用、不重算；只有它們沒有的數字才寫程式算。';
  assert.ok(both.includes(`\n${WRITE}\n`), `寫數字檔那句逐字：\n${both}`);
  assert.ok(both.includes(`\n${WRITE}\n${NOTE}\n`), '寫數字檔那句後面緊接「規則不滲進產出」那句');
  assert.ok(onlyWrite.includes(NOTE) && !plain.includes('不要提到程式、數字檔'), '有數字檔才多這句；沒帶欄位一句都不多');
  assert.ok(both.includes(`\n${READ}\n`), `先讀那句逐字：\n${both}`);
  assert.ok(both.includes(SAME_OLD_PROGRAM), '原本第一句（沿用、不心算）一字不動');
  assert.ok(both.indexOf(SAME_OLD_PROGRAM) < both.indexOf(READ) && both.indexOf(READ) < both.indexOf(WRITE), '順序：沿用→先讀→寫檔');
  assert.ok(both.indexOf(WRITE) < both.indexOf('執行程式一律照這個寫法'), '兩句都在包裝指令寫法之前');
  assert.ok(onlyWrite.includes('寫成「數字-a.json」') && !onlyWrite.includes('目前目錄已有前面步驟算好的數字檔'), '第一步沒有前面的數字檔＝不提');
  assert.ok(!plain.includes('數字檔') && !plain.includes('寫成「數字-'), '沒帶欄位＝一句都不多');
  // 除了多出來的兩行，其餘每一行逐字相同
  const strip = (s) => s.split('\n').filter((l) => l !== WRITE && l !== READ && l !== NOTE).join('\n');
  assert.equal(strip(both), plain, '規則段其他句子逐字不變');
});

test('數字檔：產檔規則段——有 priorNumbersFiles 把「數字直接沿用上一步的產出」那句改成先讀數字檔；沒有＝原句逐字不變；其餘句子不動', async () => {
  const adapter = createHostAdapter({ spawnFn: capture().spawnFn });
  const fm = { cwd: 'C:/tmp/run-out', fileName: '報表.xlsx' };
  const plain = adapter.renderPrompt({ ...NODE_ARGS, fileMode: fm });
  const withPrior = adapter.renderPrompt({ ...NODE_ARGS, fileMode: { ...fm, numbersFile: '數字-x.json', priorNumbersFiles: ['數字-a.json', '數字-b.json'] } });
  const noPrior = adapter.renderPrompt({ ...NODE_ARGS, fileMode: { ...fm, numbersFile: '數字-x.json', priorNumbersFiles: [] } });
  const NEW = '只寫一支短程式、只做一件事：把上一步算好的數字與內容寫進檔案。數字先讀目前目錄的數字檔：「數字-a.json」、「數字-b.json」（Read 打開、或在腳本裡 readFileSync）；數字檔裡有的直接用，沒有的才沿用上一步產出裡的數字；不要重讀原始資料重算；不要另外寫驗證、清理、預覽、比對的腳本；檔案寫出來就結束，不要反覆改版。';
  assert.ok(plain.includes(`\n${SAME_OLD_FILE}\n`), '沒數字檔＝原句逐字');
  assert.ok(noPrior.includes(`\n${SAME_OLD_FILE}\n`), '清單是空的也＝原句逐字');
  assert.ok(withPrior.includes(`\n${NEW}\n`), `有數字檔＝改成先讀那句：\n${withPrior}`);
  assert.ok(!withPrior.includes('數字直接沿用上一步的產出'), '原句被換掉，不是兩句並存');
  assert.equal(withPrior.replace(NEW, SAME_OLD_FILE), plain, '除了那一句，產檔段其餘逐字相同');
  assert.ok(!withPrior.includes('# 程式規則') && !withPrior.includes('寫成「數字-x.json」'), '產檔步驟沒有程式規則段，也不叫它寫自己的數字檔（規則由產檔段講）');
});

test('數字檔：renderPrompt 與實際送進 stdin 的一字不差（帶 exec 數字檔欄位）', async () => {
  let child;
  const adapter = createHostAdapter({ spawnFn: () => (child = fakeChild()) });
  const args = { ...NODE_ARGS, exec: { cwd: 'C:/tmp/run-out', logPath: 'C:/tmp/run/prompts/x.exec.log', numbersFile: '數字-b.json', priorNumbersFiles: ['數字-a.json'] } };
  const p = adapter.executeNode(args);
  child.stdout.emit('data', jsonReply());
  child.emit('close', 0);
  await p;
  assert.equal(adapter.renderPrompt(args), child.stdin.written);
  assert.ok(child.stdin.written.includes('寫成「數字-b.json」') && child.stdin.written.includes('「數字-a.json」——先用 Read 打開讀'));
});

// ===== L052 killTree 回歸（假 pid、假 spawn、假平台：不起任何真行程、不殺任何真行程）=====
const FAKE_PID = 999_999_999; // 遠超 Windows 實際 pid 範圍的假 pid；反正 spawnFn 是假的，不會真的下 taskkill

test('L052 killTree：win32 先起 taskkill /PID <pid> /T /F（此時還不 kill()），taskkill exit 後才補 kill()；taskkill 回 error 也補 kill()', () => {
  const calls = [];
  const child = { pid: FAKE_PID, kill: () => calls.push('kill') };
  let tk = null;
  const spawnFn = (cmd, args, opts) => { calls.push(['spawn', cmd, args, opts]); tk = new EventEmitter(); return tk; };
  killTree(child, { spawnFn, platform: 'win32' });
  assert.deepEqual(calls, [['spawn', 'taskkill', ['/PID', String(FAKE_PID), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }]], 'taskkill 先起、且起完還沒 kill()（先 kill 掉 cmd 的話底下的 claude 變孤兒）');
  tk.emit('exit', 0);
  assert.deepEqual(calls.slice(1), ['kill'], 'taskkill 結束後才 kill()');
  // taskkill 起來了但回 error（例如 ENOENT）：也要補 kill()
  const calls2 = [];
  const child2 = { pid: FAKE_PID, kill: () => calls2.push('kill') };
  let tk2 = null;
  killTree(child2, { spawnFn: () => (tk2 = new EventEmitter()), platform: 'win32' });
  assert.deepEqual(calls2, [], 'error 前不 kill()');
  tk2.emit('error', new Error('spawn taskkill ENOENT'));
  assert.ok(calls2.length >= 1 && calls2.every((c) => c === 'kill'), `error 後補 kill()：${JSON.stringify(calls2)}`);
});

test('L052 killTree：taskkill 起不來（spawnFn 丟錯）直接 kill()；非 win32 不碰 taskkill 直接 kill()；win32 但沒 pid 也直接 kill()；child 為 null 不炸', () => {
  const throwing = [];
  killTree({ pid: FAKE_PID, kill: () => throwing.push('kill') }, { spawnFn: () => { throw new Error('spawn 炸了'); }, platform: 'win32' });
  assert.deepEqual(throwing, ['kill'], 'spawn 丟錯＝直接 kill()');
  const spawned = [];
  const linux = [];
  killTree({ pid: FAKE_PID, kill: () => linux.push('kill') }, { spawnFn: (...a) => { spawned.push(a); return new EventEmitter(); }, platform: 'linux' });
  assert.deepEqual(linux, ['kill'], '非 win32 直接 kill()');
  const noPid = [];
  killTree({ kill: () => noPid.push('kill') }, { spawnFn: (...a) => { spawned.push(a); return new EventEmitter(); }, platform: 'win32' });
  assert.deepEqual(noPid, ['kill'], 'win32 沒 pid 直接 kill()');
  assert.deepEqual(spawned, [], '這兩條路都不該碰 taskkill');
  assert.doesNotThrow(() => killTree(null, { spawnFn: () => { throw new Error('不該被叫'); }, platform: 'win32' }), 'child 為 null 不炸');
  // kill() 自己丟錯（行程已經結束）也吞掉
  assert.doesNotThrow(() => killTree({ pid: FAKE_PID, kill: () => { throw new Error('ESRCH'); } }, { spawnFn: () => { throw new Error('x'); }, platform: 'win32' }));
});

// —— 一句話安裝輪：找 claude 執行檔（桌面版內建的 claude.exe 不在 PATH）——全部假 env／假 fs／假 spawn，不起真行程 ——
function fakeFs(existing) {
  // 測試跑在哪個平台都一樣：path.join 在 Windows 會把 / 換成 \，所以兩邊都正規化成 \ 再比
  const norm = (p) => String(p).toLowerCase().replace(/\//g, '\\');
  const set = new Set(existing.map(norm));
  return {
    existsSync: (p) => set.has(norm(p)),
    readdirSync: (dir) => {
      const prefix = norm(dir).replace(/[\\/]+$/, '') + '\\';
      const names = new Set();
      for (const p of set) if (p.startsWith(prefix)) names.add(p.slice(prefix.length).split('\\')[0]);
      if (!names.size) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return [...names];
    },
  };
}
const APPDATA = 'C:\\Users\\王 小明\\AppData\\Roaming';
const WIN_ENV = { APPDATA, PATH: 'C:\\Windows\\system32;C:\\Program Files\\nodejs', PATHEXT: '.COM;.EXE;.BAT;.CMD' };

test('找 claude ①：有 BOJIAN_CLAUDE_BIN 就用它（不看 PATH、不掃 APPDATA）；Windows 完整路徑走 cmd /d /s /c 加外引號、自己引參數', async () => {
  const bin = `${APPDATA}\\Claude\\claude-code\\2.1.281\\claude.exe`;
  const fs = fakeFs([`${WIN_ENV.PATH.split(';')[0]}\\claude.cmd`]); // PATH 上也有，仍以 env 為準
  assert.equal(resolveClaudeBin({ env: { ...WIN_ENV, BOJIAN_CLAUDE_BIN: bin }, fs, platform: 'win32' }), bin);
  assert.equal(resolveClaudeBin({ env: { BOJIAN_CLAUDE_BIN: '/opt/claude' }, fs: fakeFs([]), platform: 'darwin' }), '/opt/claude');
  // spawn 形狀：路徑含空白與中文，引號要對；含空白的參數與空字串參數也要引
  const calls = [];
  const spawnImpl = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return fakeChild(); };
  defaultSpawn(['-p', '--tools', '', '--system-prompt', '你 好 "引號"'], {}, { spawnImpl, bin, platform: 'win32' });
  assert.equal(calls[0].cmd, 'cmd');
  assert.deepEqual(calls[0].args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(calls[0].args[3], `""${bin}" -p --tools "" --system-prompt "你 好 \\"引號\\"""`);
  assert.equal(calls[0].opts.windowsVerbatimArguments, true);
  // PATH 上的裸字：寫法與以前一模一樣（不加 /s、不加外引號）
  defaultSpawn(['--version'], {}, { spawnImpl, bin: 'claude', platform: 'win32' });
  assert.deepEqual(calls[1].args, ['/c', 'claude', '--version']);
  assert.ok(!calls[1].opts.windowsVerbatimArguments);
  // 非 Windows：直接 spawn 路徑
  defaultSpawn(['--version'], {}, { spawnImpl, bin: '/opt/claude', platform: 'linux' });
  assert.equal(calls[2].cmd, '/opt/claude');
  assert.deepEqual(calls[2].args, ['--version']);
});

test('找 claude ②③：PATH 有就回裸字 claude；PATH 沒有 → 掃 %APPDATA%\\Claude\\claude-code\\*\\claude.exe 取版本最大（2.1.279 與 2.1.281 選 281）', () => {
  // ② PATH 上有 claude.cmd
  assert.equal(resolveClaudeBin({ env: WIN_ENV, fs: fakeFs(['C:\\Program Files\\nodejs\\claude.cmd']), platform: 'win32' }), 'claude');
  assert.equal(resolveClaudeBin({ env: { PATH: '/usr/local/bin:/usr/bin' }, fs: fakeFs(['/usr/local/bin/claude']), platform: 'darwin' }), 'claude');
  // ③ PATH 沒有 → 掃桌面版資料夾；2.1.10 要輸給 2.1.9？不：按數字比（10 > 9），所以還是 2.1.281 最大；沒有 claude.exe 的夾（9.9.9）不算
  const base = `${APPDATA}\\Claude\\claude-code`;
  const fs = fakeFs([`${base}\\2.1.279\\claude.exe`, `${base}\\2.1.281\\claude.exe`, `${base}\\2.1.10\\claude.exe`, `${base}\\9.9.9\\readme.txt`]);
  assert.equal(resolveClaudeBin({ env: WIN_ENV, fs, platform: 'win32' }), `${base}\\2.1.281\\claude.exe`);
  // 非 Windows 不掃 APPDATA
  assert.equal(resolveClaudeBin({ env: { ...WIN_ENV, PATH: '/usr/bin' }, fs, platform: 'darwin' }), null);
});

test('找 claude ④：都沒有 → null；defaultSpawn 不起任何行程、checkAvailable 為 false；executeNode 拒絕成現有的「連不上 Claude」', async () => {
  const bin = resolveClaudeBin({ env: WIN_ENV, fs: fakeFs([]), platform: 'win32' });
  assert.equal(bin, null);
  assert.equal(resolveClaudeBin({ env: { ...WIN_ENV, APPDATA: undefined }, fs: fakeFs([]), platform: 'win32' }), null, '沒有 APPDATA 也不炸');
  let spawned = 0;
  const spawnFn = (args, extra) => defaultSpawn(args, extra, { spawnImpl: () => { spawned++; return fakeChild(); }, bin, platform: 'win32' });
  const adapter = createHostAdapter({ spawnFn });
  assert.equal(await adapter.checkAvailable(), false);
  await assert.rejects(adapter.executeNode(NODE_ARGS), (e) => e instanceof HostError && e.code === 'UNAVAILABLE' && e.message.includes('連不上 Claude'));
  assert.equal(spawned, 0, '沒有 claude 就不該 spawn');
});
