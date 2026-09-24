import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  classifyInit, fetchConnectors, toolsFor, toolPrefix, labelOf, isReadTool, READ_VERBS, CONNECT_LINK, normalizeCache, connectedServers,
} from '../src/connectors.js';
import { createHostAdapter, HostError, CALENDAR_TOOLS, CALENDAR_BLOCKED } from '../src/host-adapter.js';
import { CONNECTOR_INIT } from './fixtures.js';

const AT = '2026-09-22T10:00:00.000Z';
const cache = () => classifyInit(CONNECTOR_INIT, AT);
const byName = (c, n) => c.servers.find((s) => s.name === n);

// 假子行程：stream-json 一行一筆；killed＝被收手
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.stdin = { written: '', write(s) { this.written += s; }, end() { this.ended = true; }, on() {} };
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

test('連線 US-100：清單只列 claude.ai 與使用者自設的服務（外掛自帶的不列）；label 去掉 claude.ai 前綴；狀態原樣', () => {
  const c = cache();
  assert.equal(c.checked_at, AT);
  assert.deepEqual(c.servers.map((s) => s.name), [
    'claude.ai Gmail', 'claude.ai Google Drive', 'claude.ai Google Calendar', 'claude.ai Canva', 'claude.ai Notion', 'claude.ai Windsor.ai', 'my-crm',
  ]);
  assert.ok(!c.servers.some((s) => s.source === 'plugin'), 'source: plugin 不列');
  assert.equal(byName(c, 'claude.ai Gmail').label, 'Gmail');
  assert.equal(byName(c, 'my-crm').label, 'my-crm');
  assert.equal(byName(c, 'claude.ai Notion').status, 'needs-auth');
  assert.equal(byName(c, 'claude.ai Windsor.ai').status, 'failed');
  for (const s of c.servers) {
    for (const k of ['name', 'label', 'status', 'source', 'summary', 'read_tools', 'blocked_tools']) assert.ok(k in s, `契約欄位 ${k}`);
  }
  assert.equal(toolPrefix('claude.ai Google Drive'), 'mcp__claude_ai_Google_Drive__');
  assert.equal(toolPrefix('my-crm'), 'mcp__my_crm__');
  assert.equal(labelOf('claude.ai Windsor.ai'), 'Windsor.ai');
});

test('連線 US-102：只讀白名單——讀類動詞才放行；寄信／刪信／建草稿／加標籤／轉寄、分享／建檔／刪檔、建行程、匯出設計、認不得的動詞一律擋', () => {
  const c = cache();
  const gmail = byName(c, 'claude.ai Gmail');
  assert.deepEqual(gmail.read_tools.map((t) => t.replace('mcp__claude_ai_Gmail__', '')).sort(),
    ['get_draft', 'get_message', 'get_thread', 'list_drafts', 'list_labels', 'search_threads']);
  for (const w of ['send_message', 'trash_message', 'trash_thread', 'create_draft', 'delete_draft', 'label_message', 'forward', 'reply', 'untrash_thread', 'update_draft', 'apply_sensitive_message_label', 'mark_thread_spam']) {
    assert.ok(gmail.blocked_tools.includes(`mcp__claude_ai_Gmail__${w}`), `Gmail ${w} 要擋`);
    assert.ok(!gmail.read_tools.includes(`mcp__claude_ai_Gmail__${w}`));
  }
  const drive = byName(c, 'claude.ai Google Drive');
  for (const w of ['copy_file', 'create_file', 'share_file', 'trash_file', 'update_file']) assert.ok(drive.blocked_tools.includes(`mcp__claude_ai_Google_Drive__${w}`), `Drive ${w} 要擋`);
  for (const r of ['download_file_content', 'read_file_content', 'search_files', 'list_recent_files', 'get_file_metadata']) assert.ok(drive.read_tools.includes(`mcp__claude_ai_Google_Drive__${r}`), `Drive ${r} 可讀`);
  const cal = byName(c, 'claude.ai Google Calendar');
  for (const w of ['create_event', 'update_event', 'delete_event', 'respond_to_event']) assert.ok(cal.blocked_tools.includes(`mcp__claude_ai_Google_Calendar__${w}`), `行事曆 ${w} 要擋`);
  const canva = byName(c, 'claude.ai Canva');
  assert.deepEqual(canva.read_tools.map((t) => t.replace('mcp__claude_ai_Canva__', '')).sort(), ['get-assets', 'help', 'read-design', 'resolve-shortlink', 'search-designs']);
  assert.ok(canva.blocked_tools.includes('mcp__claude_ai_Canva__export-design'), '匯出設計不算讀，擋');
  const crm = byName(c, 'my-crm');
  assert.deepEqual(crm.read_tools.sort(), ['mcp__my_crm__getCustomer', 'mcp__my_crm__lookup_order'], 'camelCase 與 lookup 也認得');
  assert.deepEqual(crm.blocked_tools.sort(), ['mcp__my_crm__frobnicate', 'mcp__my_crm__syncAll'], '認不得的動詞＝擋');
  // 名單列死：寫類動詞不可能混進白名單
  for (const w of ['send', 'create', 'delete', 'trash', 'update', 'share', 'export', 'label', 'forward', 'reply', 'copy', 'apply', 'mark', 'generate', 'comment']) assert.ok(!READ_VERBS.includes(w), w);
  assert.equal(isReadTool('mcp__x__getX', 'mcp__x__'), true);
  // 服務之間的前綴不串台：Google Calendar 的工具不算進別家
  assert.ok(!gmail.read_tools.some((t) => !t.startsWith('mcp__claude_ai_Gmail__')));
});

test('連線 US-100：每家一句人話——已知幾家寫死、其他家通用句、沒授權／連不上各一句', () => {
  const c = cache();
  assert.equal(byName(c, 'claude.ai Gmail').summary, '可讀信、搜信。寄信、刪信、建草稿都擋著');
  assert.match(byName(c, 'my-crm').summary, /^可以讀 2 種資料；會改東西的 2 種動作擋著$/);
  assert.match(byName(c, 'claude.ai Notion').summary, /還沒授權/);
  assert.match(byName(c, 'claude.ai Windsor.ai').summary, /連不上/);
  assert.deepEqual(byName(c, 'claude.ai Notion').read_tools, [], '沒授權的沒有工具');
});

test('連線 ADR-006：抓清單＝讀到 system/init 就收手（殺子行程，不讓它進到模型呼叫）；init 前的 hook 訊息與跨塊切斷都照讀；旗標不推 --strict-mcp-config', async () => {
  const line = JSON.stringify(CONNECTOR_INIT);
  let args;
  let extra;
  let child2;
  const killed2 = [];
  const p2 = fetchConnectors({ spawnFn: (a, x) => { args = a; extra = x; return (child2 = fakeChild()); }, killFn: (c) => { killed2.push(c); c.kill(); }, now: () => Date.parse(AT) });
  child2.stdout.emit('data', `${JSON.stringify({ type: 'system', subtype: 'hook_started' })}\n${line.slice(0, 30)}`);
  assert.equal(killed2.length, 0);
  child2.stdout.emit('data', `${line.slice(30)}\n`);
  const got = await p2;
  assert.equal(killed2.length, 1, '讀到 init 當下就殺');
  assert.equal(child2.killed, true);
  assert.equal(got.checked_at, AT);
  assert.equal(got.servers.length, 7);
  child2.stdout.emit('data', `${JSON.stringify({ type: 'result', result: 'x' })}\n`); // 殺完後再來的訊息不影響
  assert.ok(args.includes('stream-json') && args.includes('--verbose') && args.includes('-p'), args.join(' '));
  assert.ok(!args.includes('--strict-mcp-config'), '要看得到使用者的服務');
  assert.equal(args[args.indexOf('--tools') + 1], '', '不送內建工具定義');
  assert.equal(child2.stdin.ended, true, 'prompt 走 stdin 且關上');
  // 實測 init 一出模型請求就發了、殺不及：模型 API 位址指到本機沒人聽的埠＝連不上、不花額度（清單不走這個位址）
  assert.equal(extra.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9');
  assert.equal(extra.env.PATH ?? extra.env.Path, process.env.PATH ?? process.env.Path, '其他環境變數照帶（claude 要找得到）');
});

test('連線：沒讀到 init 就結束／逾時／claude 不在 → 人話錯誤，逾時也殺子行程', async () => {
  let child;
  const p = fetchConnectors({ spawnFn: () => (child = fakeChild()), killFn: (c) => c.kill() });
  child.stdout.emit('data', '{"type":"system","subtype":"hook_started"}\n');
  child.emit('close', 1);
  await assert.rejects(p, (e) => e instanceof HostError && /重新檢查/.test(e.message));

  let slow;
  const t = fetchConnectors({ spawnFn: () => (slow = fakeChild()), killFn: (c) => c.kill(), timeoutMs: 20 });
  await assert.rejects(t, (e) => e instanceof HostError && e.code === 'TIMEOUT');
  assert.equal(slow.killed, true, '逾時要收手');

  let gone;
  const u = fetchConnectors({ spawnFn: () => (gone = fakeChild()), killFn: (c) => c.kill() });
  gone.emit('error', new Error('ENOENT'));
  await assert.rejects(u, (e) => e instanceof HostError && e.code === 'UNAVAILABLE');
});

test('連線：toolsFor 只給勾的那幾家、只算已連上的；沒勾的服務整家列進擋的清單；壞快取＝當沒抓過', () => {
  const c = cache();
  const t = toolsFor(c, ['claude.ai Gmail', 'claude.ai Notion', '不存在的']);
  assert.deepEqual(t.names, ['claude.ai Gmail'], '沒授權／不在清單的不給');
  assert.deepEqual(t.labels, ['Gmail']);
  assert.ok(t.read.every((x) => x.startsWith('mcp__claude_ai_Gmail__')) && t.read.length === 6);
  assert.ok(t.blocked.includes('mcp__claude_ai_Gmail__send_message'));
  assert.ok(t.others.includes('mcp__claude_ai_Google_Drive__*') && t.others.includes('mcp__claude_ai_Google_Calendar__*'), '沒勾的整家擋');
  assert.ok(!t.others.includes('mcp__claude_ai_Gmail__*'), '勾的那家不整家擋');
  assert.deepEqual(toolsFor(null, ['claude.ai Gmail']).names, []);
  assert.deepEqual(normalizeCache({ nope: 1 }), { checked_at: null, servers: [] });
  assert.deepEqual(connectedServers(c).map((s) => s.label), ['Gmail', 'Google Drive', 'Google Calendar', 'Canva', 'my-crm']);
  assert.equal(CONNECT_LINK, 'https://claude.ai/settings/connectors');
});

test('連線 US-101／102 端到端：勾了 Gmail 的步驟——不推 --strict-mcp-config、讀類逐一放行、寄信刪信不在放行清單且在擋的清單、別家整家擋；不用萬用放行', async () => {
  let args;
  let child;
  const adapter = createHostAdapter({ lean: true, spawnFn: (a) => { args = a; return (child = fakeChild()); } });
  const p = adapter.executeNode({ nodeId: 'n', title: '讀信', instruction: '讀近 7 天來信', upstream: '', connectors: toolsFor(cache(), ['claude.ai Gmail']) });
  child.stdout.emit('data', 'ok');
  child.emit('close', 0);
  await p;
  const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'));
  const denied = args.slice(args.indexOf('--disallowedTools') + 1);
  assert.ok(!args.includes('--strict-mcp-config'));
  assert.ok(allowed.includes('mcp__claude_ai_Gmail__search_threads') && allowed.includes('mcp__claude_ai_Gmail__get_message'));
  for (const w of ['send_message', 'trash_message', 'create_draft', 'forward']) {
    assert.ok(!allowed.includes(`mcp__claude_ai_Gmail__${w}`), `${w} 不在放行`);
    assert.ok(denied.includes(`mcp__claude_ai_Gmail__${w}`), `${w} 在擋的清單`);
  }
  assert.ok(!allowed.some((t) => t.endsWith('__*')), '放行清單沒有萬用');
  assert.ok(denied.includes('mcp__claude_ai_Google_Drive__*'), '沒勾的雲端硬碟整家擋');
  assert.ok(!allowed.some((t) => t.includes('Google_Drive') || t.includes('Calendar')), '只摸得到勾的那家');
  assert.match(child.stdin.written, /# 這一步可以讀的外部服務[^\n]*\n- Gmail/);
  // 勾雲端硬碟＋行事曆：刪檔、分享、建行程都擋
  let a2;
  let c2;
  const ad2 = createHostAdapter({ lean: true, spawnFn: (a) => { a2 = a; return (c2 = fakeChild()); } });
  const p2 = ad2.executeNode({ nodeId: 'n', title: 'x', instruction: 'x', upstream: '', connectors: toolsFor(cache(), ['claude.ai Google Drive', 'claude.ai Google Calendar']) });
  c2.emit('close', 0);
  await p2;
  const al2 = a2.slice(a2.indexOf('--allowedTools') + 1, a2.indexOf('--disallowedTools'));
  const de2 = a2.slice(a2.indexOf('--disallowedTools') + 1);
  for (const w of ['mcp__claude_ai_Google_Drive__trash_file', 'mcp__claude_ai_Google_Drive__share_file', 'mcp__claude_ai_Google_Calendar__create_event', 'mcp__claude_ai_Google_Calendar__delete_event']) {
    assert.ok(!al2.includes(w) && de2.includes(w), w);
  }
});

test('連線 ADR-006 第 5 點：CALENDAR_TOOLS 不再是萬用——只列行事曆讀類工具，寫類在 CALENDAR_BLOCKED', () => {
  assert.ok(Array.isArray(CALENDAR_TOOLS));
  assert.ok(!CALENDAR_TOOLS.some((t) => t.includes('*')), '不准萬用');
  assert.ok(CALENDAR_TOOLS.includes('mcp__claude_ai_Google_Calendar__list_events'));
  for (const w of ['create_event', 'update_event', 'delete_event']) {
    assert.ok(!CALENDAR_TOOLS.includes(`mcp__claude_ai_Google_Calendar__${w}`));
    assert.ok(CALENDAR_BLOCKED.includes(`mcp__claude_ai_Google_Calendar__${w}`));
  }
});
