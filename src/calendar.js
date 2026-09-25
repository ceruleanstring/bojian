// calendar — 行事曆聚合：三源＝排程觸發展開＋等時刻步驟＋Google 快照底圖（唯讀）。
// 抓取本身走 host-adapter（ADR-005）；快照解析任何失敗一律降級不丟錯（照 porter 模式）。
import yaml from 'js-yaml';
import { parseWhen } from './runner.js';
import { occurrencesInRange, fmtLocal, validateSchedule } from './scheduler.js';

export function snapshotPrompt(month) {
  return [
    '你是行事曆快照員。請用你可用的行事曆工具，讀出使用者 Google 行事曆在指定月份的全部行程。',
    '只輸出一個 ```yaml 圍欄，內容是 events 清單；沒有工具或讀不到就輸出 ```yaml 圍欄包 error: 一句人話原因。',
    '格式：',
    '```yaml',
    'events:',
    '  - title: 行程標題',
    '    start: 2026-08-27T14:00',
    '    end: 2026-08-27T15:00',
    '    source_id: 事件唯一識別（有就填）',
    '```',
    '',
    `# 指定月份`,
    month,
  ].join('\n');
}

// 失敗一律回 null（呼叫端translate成「抓不到＋原因」，不畫壞資料）
export function parseSnapshot(text) {
  const m = /```yaml\s*\n([\s\S]*?)```/.exec(text ?? '');
  if (!m) return null;
  let data;
  try { data = yaml.load(m[1]); } catch { return null; }
  if (data && typeof data.error === 'string') return { error: data.error };
  if (!data || !Array.isArray(data.events)) return null;
  const events = [];
  for (const e of data.events) {
    if (!e || typeof e.title !== 'string') continue;
    const start = parseWhen(e.start);
    if (!start) continue;
    events.push({
      title: e.title,
      start: fmtLocal(start.getTime()),
      end: parseWhen(e.end) ? fmtLocal(parseWhen(e.end).getTime()) : null,
      source_id: typeof e.source_id === 'string' ? e.source_id : null,
    });
  }
  return { events };
}

const WAITING_HUMAN_SET = ['waiting_review', 'waiting_human', 'waiting_branch', 'waiting_data'];

// 掃全部未完 run 的等時刻／時間未定步驟（月視圖與 todos 共用）
export function scanRunSteps(store) {
  const timed = [];
  const pending = [];
  for (const { category, id } of store.listWorkflows()) {
    for (const rid of store.listRuns(category, id)) {
      let r;
      try { r = store.readRun(category, id, rid); } catch { continue; }
      if (r.status === 'done') continue;
      for (const [nodeId, step] of Object.entries(r.steps ?? {})) {
        const node = r.def.nodes.find((n) => n.id === nodeId);
        const ref = { category, id, run_id: rid, node: nodeId, title: node?.title ?? nodeId, workflow_name: r.workflow.name, executor: node?.executor ?? 'ai' };
        if (step.status === 'waiting_time' && step.wake_at) timed.push({ ...ref, wake_at: step.wake_at, linked_event_id: step.linked_event_id ?? null, linked_keep: step.linked_keep ?? null });
        if (step.status === 'time_pending') pending.push({ ...ref, note: step.time_note ?? '' });
      }
    }
  }
  return { timed, pending };
}

// 月視圖聚合。month='YYYY-MM'
export function monthView({ store, month, now = Date.now() }) {
  const fromMs = new Date(`${month}-01T00:00`).getTime();
  const to = new Date(`${month}-01T00:00`);
  to.setMonth(to.getMonth() + 1);
  const toMs = to.getTime();
  const inRange = (ms) => ms >= fromMs && ms < toMs;

  const notices = store.readNotices();
  const trig = new Map(notices.filter((n) => n.type === 'trigger').map((n) => [n.fingerprint, n.note]));
  const events = [];

  // 1) 排程觸發展開（含單次覆寫與過去狀態標色）；設定有誤的排程不進月曆（健檢 M4：修復提示走通知與排程清單）
  for (const sched of store.readSchedules()) {
    try { validateSchedule(sched); } catch { continue; }
    // 這個月的場次＝基準落在本月的＋被「移動」覆寫移進本月的（健檢 P1-02：跨月改期不消失）
    const occs = new Map(); // occKey → 基準時刻 ms
    for (const baseMs of occurrencesInRange(sched, fromMs, toMs)) occs.set(fmtLocal(baseMs), baseMs);
    for (const [occKey, o] of Object.entries(sched.overrides ?? {})) {
      const movedMs = o?.move ? parseWhen(o.move)?.getTime() : null;
      const baseMs = parseWhen(occKey)?.getTime();
      if (movedMs != null && baseMs != null && inRange(movedMs)) occs.set(occKey, baseMs);
    }
    for (const [occ, baseMs] of occs) {
      const ov = (sched.overrides ?? {})[occ];
      const showMs = ov?.move ? (parseWhen(ov.move)?.getTime() ?? baseMs) : baseMs;
      if (!inRange(showMs)) continue;
      const note = trig.get(`${sched.id}@${occ}`);
      // 停用排程照樣出現（灰標「已暫停」）——否則暫停後沒有入口可以恢復（健檢 P2-03）
      let kind = sched.enabled === false ? 'paused' : 'auto';
      if (kind !== 'paused') {
        if (ov?.action === 'skip' || note === 'skipped') kind = 'skipped';
        else if (note === 'makeup') kind = 'makeup';
        else if (note === 'missed' || note === 'start_failed') kind = 'missed';
      }
      const at = fmtLocal(showMs);
      events.push({
        date: at.slice(0, 10), time: at.slice(11), kind,
        title: `${sched.name ?? sched.workflow_id} 自動開跑`,
        sid: sched.id, occ, repeat: sched.freq !== 'once',
      });
    }
  }

  // 2) 等時刻步驟＋時間未定
  const { timed, pending } = scanRunSteps(store);
  for (const t of timed) {
    const ms = new Date(t.wake_at).getTime();
    if (!inRange(ms)) continue;
    const at = fmtLocal(ms);
    events.push({
      date: at.slice(0, 10), time: at.slice(11),
      kind: t.executor === 'human' ? 'human' : 'auto',
      title: `${t.title}（${t.workflow_name}）`,
      run: { category: t.category, id: t.id, run_id: t.run_id, node: t.node },
    });
  }

  // 3) Google 快照底圖（唯讀）
  const snap = store.readSnapshot();
  if (snap?.events) {
    for (const e of snap.events) {
      const ms = parseWhen(e.start)?.getTime();
      if (ms === undefined || ms === null || !inRange(ms)) continue;
      events.push({ date: e.start.slice(0, 10), time: e.start.slice(11), kind: 'goog', title: e.title, source_id: e.source_id });
    }
  }

  events.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  return {
    month,
    today: fmtLocal(now).slice(0, 10),
    snapshot: snap ? { fetched_at: snap.fetched_at ?? null, status: snap.status ?? 'ok', reason: snap.reason ?? null } : null,
    events,
    time_pending: pending,
  };
}

// 綁定事件異動比對：流程建的 Google 事件在 Google 側被改 → 出「跟著移」卡；keep 過的同時刻不再吵
export function linkedShifts(store) {
  const snap = store.readSnapshot();
  if (!snap?.events) return [];
  const byId = new Map(snap.events.filter((e) => e.source_id).map((e) => [e.source_id, e]));
  const out = [];
  for (const t of scanRunSteps(store).timed) {
    if (!t.linked_event_id) continue;
    const ev = byId.get(t.linked_event_id);
    if (!ev) continue;
    const newMs = parseWhen(ev.start)?.getTime();
    const curMs = new Date(t.wake_at).getTime();
    if (!newMs || newMs === curMs) continue;
    if (t.linked_keep && parseWhen(t.linked_keep)?.getTime() === newMs) continue; // 使用者選過「保持」
    out.push({
      key: `${t.run_id}#${t.node}`,
      title: `Google 上這場改了：${ev.title}`,
      desc: `${fmtLocal(curMs).replace('T', ' ')} → ${fmtLocal(newMs).replace('T', ' ')}。剝繭的「${t.title}」還排在原時間——要跟著移嗎？`,
      run: { category: t.category, id: t.id, run_id: t.run_id, node: t.node },
      to: fmtLocal(newMs),
    });
  }
  return out;
}

export { WAITING_HUMAN_SET };
