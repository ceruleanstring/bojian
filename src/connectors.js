// connectors — 連線（ADR-006）：使用者 Claude 上已連好的外部服務清單＋只讀白名單。
// 剝繭不保管任何帳密：只「看」宿主已經連好哪些服務（宿主啟動訊息 system/init），抓完就收手，不花額度。
// 宿主呼叫本身（起子行程、殺整棵、讀 init）在 host-adapter.readHostInit（ADR-001）；這裡只做分類、人話、快取形狀。
import { readHostInit } from './host-adapter.js';

// 去授權的地方（還沒授權／已不在清單上＝健檢擋下時指過去）
export const CONNECT_LINK = 'https://claude.ai/settings/connectors';

// 讀類動詞白名單（ADR-006 第 3 點，列死）：工具動作名的第一個字在這裡面才放行。
// 其餘一律當寫類擋掉——含建立草稿、加標籤、分享、匯出設計這類「不算寄出但會改東西」的。認不得＝擋。
export const READ_VERBS = Object.freeze([
  'get', 'list', 'search', 'read', 'query', 'find', 'fetch', 'download', 'suggest',
  'resolve', 'help', 'guide', 'describe', 'lookup', 'view', 'retrieve',
]);

// 服務全名 → 工具前綴：mcp__＋服務名把非英數字元換成 _＋__（宿主的命名規則，2026-09-22 實測）
export const toolPrefix = (name) => `mcp__${String(name).replace(/[^A-Za-z0-9]/g, '_')}__`;
// 畫面上的名字：去掉 claude.ai 前綴
export const labelOf = (name) => String(name).replace(/^claude\.ai\s+/i, '');

// 工具全名 → 動作名的第一個字（search_threads→search、get-assets→get、getUser→get）
function actionVerb(toolName, prefix) {
  const action = toolName.slice(prefix.length);
  const m = /^[A-Za-z][a-z]*/.exec(action);
  return m ? m[0].toLowerCase() : '';
}
export const isReadTool = (toolName, prefix) => READ_VERBS.includes(actionVerb(toolName, prefix));

// 已知幾家寫死人話；其他家走通用句
const KNOWN_SUMMARY = {
  Gmail: '可讀信、搜信。寄信、刪信、建草稿都擋著',
  'Google Drive': '可搜尋、讀取、下載檔案。建立、修改、分享、刪除都擋著',
  'Google Calendar': '可看行事曆與行程。建立、修改、刪除行程都擋著',
  Canva: '可搜尋、讀取設計。建立、修改、匯出設計都擋著',
  Notion: '可搜尋、讀取頁面。建立、修改、刪除頁面都擋著',
};
function summaryOf(label, status, readN, blockedN) {
  if (status === 'needs-auth') return '還沒授權——到 claude.ai 連好之後按「重新檢查」';
  if (status !== 'connected') return '連不上——稍後按「重新檢查」再試';
  if (KNOWN_SUMMARY[label] && readN) return KNOWN_SUMMARY[label];
  if (!readN) return `沒有只讀的動作可用；會改東西的 ${blockedN} 種動作擋著`;
  return `可以讀 ${readN} 種資料；會改東西的 ${blockedN} 種動作擋著`;
}

// init 訊息 → 契約形狀 { checked_at, servers:[{ name, label, status, source, summary, read_tools, blocked_tools }] }
// 只列 claude.ai 與使用者自設的服務；外掛自帶的（source: plugin）不列——那是開發工具，不是使用者的資料
export function classifyInit(init, checkedAt = new Date().toISOString()) {
  const tools = Array.isArray(init?.tools) ? init.tools.filter((t) => typeof t === 'string') : [];
  const servers = (Array.isArray(init?.mcp_servers) ? init.mcp_servers : [])
    .filter((s) => s && typeof s.name === 'string' && s.name && s.source !== 'plugin')
    .map((s) => {
      const prefix = toolPrefix(s.name);
      const mine = tools.filter((t) => t.startsWith(prefix));
      const read_tools = mine.filter((t) => isReadTool(t, prefix));
      const blocked_tools = mine.filter((t) => !isReadTool(t, prefix));
      const label = labelOf(s.name);
      const status = typeof s.status === 'string' ? s.status : 'failed';
      return {
        name: s.name, label, status, source: typeof s.source === 'string' ? s.source : '',
        summary: summaryOf(label, status, read_tools.length, blocked_tools.length), read_tools, blocked_tools,
      };
    });
  return { checked_at: checkedAt, servers };
}

// 抓一次清單（起子行程讀到 init 就收手）。spawnFn／killFn 可注入（測試不打真 claude）
export async function fetchConnectors({ spawnFn, killFn, timeoutMs, now = () => Date.now() } = {}) {
  const init = await readHostInit({ spawnFn, killFn, timeoutMs });
  return classifyInit(init, new Date(now()).toISOString());
}

export const EMPTY_CONNECTORS = Object.freeze({ checked_at: null, servers: [] });

// 快取壞掉或形狀不對＝當沒抓過
export function normalizeCache(cache) {
  if (!cache || typeof cache !== 'object' || !Array.isArray(cache.servers)) return { checked_at: null, servers: [] };
  return { checked_at: typeof cache.checked_at === 'string' ? cache.checked_at : null, servers: cache.servers.filter((s) => s && typeof s.name === 'string') };
}

// 已連上的服務（拆解器能耐表、預勾只准這些）
export const connectedServers = (cache) => normalizeCache(cache).servers.filter((s) => s.status === 'connected');

// 這一步勾的服務 → 給 adapter 的工具名：只給勾的那幾家、只給已連上的；
// read＝逐一放行的讀類工具全名，blocked＝這幾家的寫類工具（第二道保險），
// others＝快取裡其他服務（沒勾的）整家擋掉用的 mcp__X__*（擋是拒絕，不是放行）
export function toolsFor(cache, names) {
  const list = normalizeCache(cache).servers;
  const want = [...new Set((Array.isArray(names) ? names : []).filter((n) => typeof n === 'string'))];
  const picked = want.map((n) => list.find((s) => s.name === n)).filter((s) => s && s.status === 'connected');
  const pickedNames = new Set(picked.map((s) => s.name));
  return {
    names: picked.map((s) => s.name),
    labels: picked.map((s) => s.label ?? labelOf(s.name)),
    read: picked.flatMap((s) => (Array.isArray(s.read_tools) ? s.read_tools : [])),
    blocked: picked.flatMap((s) => (Array.isArray(s.blocked_tools) ? s.blocked_tools : [])),
    others: list.filter((s) => !pickedNames.has(s.name)).map((s) => `${toolPrefix(s.name)}*`),
  };
}
