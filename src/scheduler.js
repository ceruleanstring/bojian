// scheduler — 排程器：server 內建 tick、到點全發（不限流＝定案）、
// 觸發指紋防重、錯過偵測（睡眠關機同路）、疊發偵測、擋時限提醒升級（複數提前量＋離線補升）。
// 時鐘一律用注入的 now()；tick 冪等，每分鐘重跑安全。
import { parseWhen } from './runner.js';
import { pushNotice, hasFingerprint } from './notices.js';
import { preflight } from './preflight.js';

const GRACE_MS = 90_000; // 到點 90 秒內算「準時」，更早＝錯過
export const LEAD_MS = {
  '10m': 10 * 60e3, '30m': 30 * 60e3, '1h': 3600e3, '2h': 2 * 3600e3, '3h': 3 * 3600e3,
  '6h': 6 * 3600e3, '12h': 12 * 3600e3, '1d': 86400e3, '2d': 2 * 86400e3,
};
export const LEAD_LABEL = {
  '10m': '10 分鐘後', '30m': '30 分鐘後', '1h': '1 小時後', '2h': '2 小時後', '3h': '3 小時後',
  '6h': '6 小時後', '12h': '12 小時後', '1d': '明天', '2d': '兩天後',
};

// 排程欄位驗證（建立／更新／匯入共用——健檢 P2-02）：一律驗「合併後的整體」，錯就丟人話
export function validateSchedule(s) {
  const bad = (msg) => { throw new Error(msg); };
  if (!['weekly', 'daily', 'monthly', 'once'].includes(s.freq)) bad('頻率要是 週/天/月/單次 其中之一');
  if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(s.time ?? '08:00'))) bad('時間要是 00:00 到 23:59 的「時:分」');
  if (s.freq === 'weekly' && !(Number.isInteger(s.weekday) && s.weekday >= 1 && s.weekday <= 7)) bad('星期要是 1（週一）到 7（週日）');
  if (s.freq === 'monthly' && !(Number.isInteger(s.day) && s.day >= 1 && s.day <= 31)) bad('每月日期要是 1 到 31');
  if (s.freq === 'once' && !parseWhen(s.at)) bad('單次排程要有看得懂的時刻（例如 2026-09-01T14:00）');
  if (s.enabled !== undefined && typeof s.enabled !== 'boolean') bad('啟用狀態要是開或關');
  if (s.auto_makeup !== undefined && typeof s.auto_makeup !== 'boolean') bad('自動補跑要是開或關');
  if (s.name !== undefined && typeof s.name !== 'string') bad('名稱要是文字');
  const leads = s.remind_leads ?? [];
  const leadOk = (l) => (typeof l === 'string' ? !!LEAD_MS[l] : !!(l && typeof l === 'object' && parseWhen(l.at)));
  if (!Array.isArray(leads) || !leads.every(leadOk)) bad(`提前提醒要是 ${Object.keys(LEAD_MS).join('/')} 或 {at: 時刻}`);
}

// 本機時區的「YYYY-MM-DDTHH:mm」（occurrence 鍵與顯示共用）
export function fmtLocal(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function timeParts(sched) {
  const [h, m] = String(sched.time ?? '08:00').split(':').map(Number);
  return { h: h || 0, m: m || 0 };
}

// 排程在 refMs 當天（含前後推移 dayOffset）的觸發時刻；不符頻率回 null
function dueOnDay(sched, dayMs) {
  const { h, m } = timeParts(sched);
  const d = new Date(dayMs);
  d.setHours(h, m, 0, 0);
  if (sched.freq === 'daily') return d.getTime();
  if (sched.freq === 'weekly') {
    const dow = d.getDay() === 0 ? 7 : d.getDay(); // 1=週一…7=週日
    return dow === (sched.weekday ?? 1) ? d.getTime() : null;
  }
  if (sched.freq === 'monthly') {
    // 29–31 號在短月份不存在。夾到當月最後一天——不夾的話二月整個月靜默不跑，
    // 連「錯過」通知都不會發（沒有 occurrence 就沒有東西可錯過），使用者要到缺月報才發現（2026-09-18 審查）
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    return d.getDate() === Math.min(sched.day ?? 1, last) ? d.getTime() : null;
  }
  return null;
}

// 這個時刻是不是這條排程「真實的一次」（健檢 H2）：任意合法日期不准冒充 occurrence 多跑一份
export function isOccurrence(sched, occKey) {
  const d = parseWhen(occKey);
  if (!d) return false;
  if (fmtLocal(d.getTime()) !== String(occKey)) return false; // 鍵必須是規範化字串，避免同刻異寫繞過指紋
  if (sched.freq === 'once') {
    const a = parseWhen(sched.at);
    return !!a && a.getTime() === d.getTime();
  }
  return dueOnDay(sched, d.getTime()) === d.getTime();
}

// 最近一次「應觸發時刻」（<= beforeMs）；once 只有一發
export function prevDue(sched, beforeMs) {
  if (sched.freq === 'once') {
    const d = parseWhen(sched.at);
    return d && d.getTime() <= beforeMs ? d.getTime() : null;
  }
  for (let i = 0; i < 62; i++) {
    const t = dueOnDay(sched, beforeMs - i * 86400e3);
    if (t !== null && t <= beforeMs) return t;
  }
  return null;
}

// 區間內全部應觸發時刻（行事曆月視圖用）
export function occurrencesInRange(sched, fromMs, toMs) {
  if (sched.freq === 'once') {
    const d = parseWhen(sched.at);
    return d && d.getTime() >= fromMs && d.getTime() < toMs ? [d.getTime()] : [];
  }
  const out = [];
  for (let day = fromMs; day < toMs; day += 86400e3) {
    const t = dueOnDay(sched, day);
    if (t !== null && t >= fromMs && t < toMs) out.push(t);
  }
  return out;
}

// 下一次「應觸發時刻」（> afterMs）
export function nextDue(sched, afterMs) {
  if (sched.freq === 'once') {
    const d = parseWhen(sched.at);
    return d && d.getTime() > afterMs ? d.getTime() : null;
  }
  for (let i = 0; i < 62; i++) {
    const t = dueOnDay(sched, afterMs + i * 86400e3);
    if (t !== null && t > afterMs) return t;
  }
  return null;
}

export function createScheduler({ store, runner, kick = () => {}, now = () => Date.now() }) {
  let timer = null;

  const wfOf = (sched) => {
    const [category, ...rest] = String(sched.workflow_id ?? '').split('/');
    return { category, id: rest.join('/') };
  };

  // 該排程有沒有還沒跑完的自動 run（疊發偵測）
  function unfinishedScheduleRun(sched) {
    const { category, id } = wfOf(sched);
    try {
      for (const rid of store.listRuns(category, id)) {
        const r = store.readRun(category, id, rid);
        if (r.source === 'schedule' && r.schedule_id === sched.id && r.status !== 'done') return r;
      }
    } catch { /* 流程被刪等情況：交給 startRun 的失敗路徑 */ }
    return null;
  }

  // 觸發一次（到點／補跑／通知上的「照跑」）。失敗丟人話錯誤，由呼叫端決定通知或回 HTTP
  function fire(sched, { makeup = false } = {}) {
    const { category, id } = wfOf(sched);
    // 開跑前健檢對排程也要生效（2026-09-18 審查）：手動按開始會被 409 擋下的流程，掛上排程後照樣到點就跑，
    // 必填上傳是空的、產檔權限沒開就靜默降級——使用者隔天拿到一份沒資料、格式也不對的成品，而且標著「完成」。
    // 上傳欄位排程填不了，一律當空值送進健檢，讓 R6 擋下來，不准退回 default 文字混過去。
    const def = store.readWorkflow(category, id);
    const given = sched.overrides_params ?? {};
    const values = Object.fromEntries((def.params ?? []).map((p) => {
      const v = given[p.key];
      const empty = v === undefined || v === null || String(v).trim() === '';
      return [p.key, empty ? (p.input === 'file' ? '' : p.default) : v];
    }));
    const blocks = preflight(def, values).issues.filter((i) => i.level === 'block');
    if (blocks.length) {
      throw new Error(`開跑前健檢有 ${blocks.length} 處要先修：${blocks.map((b) => b.title).filter(Boolean).join('；')}`);
    }
    const run = runner.startRun(category, id, given, { source: 'schedule', makeup });
    // 在 run 上補記排程身分（startRun 剛寫完，讀最新再補——單寫者紀律）
    const r = store.readRun(category, id, run.run_id);
    r.schedule_id = sched.id;
    store.writeRun(category, id, run.run_id, r);
    kick(category, id, run.run_id);
    return run;
  }

  // 單次覆寫查詢
  const overrideOf = (sched, occKey) => (sched.overrides ?? {})[occKey] ?? null;

  function tickOnce() {
    const nowMs = now();
    const scheds = store.readSchedules();
    const fired = [];

    // 舊版落盤的非法排程（健檢 M4）：隔離不處理、發修復提示——不准擅自猜一個時間繼續跑
    const valid = [];
    for (const sched of scheds) {
      try {
        validateSchedule(sched);
        valid.push(sched);
      } catch (e) {
        pushNotice(store, {
          type: 'invalid_schedule', title: `排程「${sched.name ?? sched.workflow_id}」設定有誤，已暫停處理`,
          desc: `${e.message}——打開「排程清單」修正它`, schedule_id: sched.id,
          actions: [], fingerprint: `invalid@${sched.id}`,
        }, nowMs);
      }
    }

    // 1) 到點／錯過／疊發
    for (const sched of valid.filter((s) => s.enabled !== false)) {
      // 候選＝最近一次基準時刻＋全部「移動」覆寫的基準（健檢 P1-02：改期可跨月／跨下個週期，
      // 只看最近基準會被更新的週期蓋掉、被移走的那次永遠不觸發）；指紋仍用基準鍵，冪等不變
      const cands = new Map(); // occKey → 基準時刻 ms
      const latest = prevDue(sched, nowMs);
      if (latest !== null) cands.set(fmtLocal(latest), latest);
      for (const occKey of Object.keys(sched.overrides ?? {})) {
        const base = overrideOf(sched, occKey)?.move ? parseWhen(occKey)?.getTime() : null;
        if (base != null) cands.set(occKey, base);
      }
      for (const [occKey, baseMs] of cands) {
      const ov = overrideOf(sched, occKey);
      const fireMs = ov?.move ? (parseWhen(ov.move)?.getTime() ?? baseMs) : baseMs;
      if (fireMs > nowMs) continue; // 這次被移到未來
      const fp = `${sched.id}@${occKey}`;
      const notices = store.readNotices();
      if (hasFingerprint(notices, fp)) continue;
      const mark = (extra = {}) => pushNotice(store, { type: 'trigger', fingerprint: fp, schedule_id: sched.id, occ: occKey, ...extra }, nowMs);

      if (ov?.action === 'skip') { mark({ note: 'skipped' }); continue; }

      const onTime = nowMs - fireMs <= GRACE_MS;
      const busy = unfinishedScheduleRun(sched);
      if (busy && onTime) {
        mark({ note: 'overlap' });
        pushNotice(store, {
          type: 'overlap', title: `上一輪還沒跑完：${sched.name ?? sched.workflow_id}`,
          desc: `這次（${occKey.replace('T', ' ')}）到點了，但上一輪自動執行還在進行——要照跑一份新的，還是跳過這次？`,
          schedule_id: sched.id, occ: occKey, actions: ['force-run', 'skip'], fingerprint: `${fp}#n`,
        }, nowMs);
        continue;
      }
      if (onTime || sched.auto_makeup) {
        try {
          fire(sched, { makeup: !onTime });
          mark({ note: onTime ? 'fired' : 'makeup' });
        } catch (e) {
          mark({ note: 'start_failed' });
          pushNotice(store, {
            type: 'start_failed', title: `排程開跑失敗：${sched.name ?? sched.workflow_id}`,
            desc: e.message, schedule_id: sched.id, occ: occKey, actions: ['force-run'], fingerprint: `${fp}#n`,
          }, nowMs);
        }
      } else {
        mark({ note: 'missed' });
        pushNotice(store, {
          type: 'missed', title: `錯過排程：${sched.name ?? sched.workflow_id}`,
          desc: `${occKey.replace('T', ' ')} 到點時剝繭沒開著——要現在補跑嗎？`,
          schedule_id: sched.id, occ: occKey, actions: ['makeup', 'skip'], fingerprint: `${fp}#n`,
        }, nowMs);
      }
      fired.push(fp);
      }
    }

    // 2) 等時刻步驟到點喚醒＋收集提醒對象
    const timed = []; // {ms, label, blockedBy, fpBase}
    for (const { category, id } of store.listWorkflows()) {
      for (const rid of store.listRuns(category, id)) {
        // 壞掉的 run.yaml 只跳過這一筆。不包起來的話例外會逃出整個 tickOnce、被 start() 的空 catch
        // 無聲吞掉，於是每分鐘都死在同一個檔案上：等時刻步驟再也不會醒、失敗通知與提醒全部停擺，
        // 而畫面上一點異常都看不到（2026-09-18 審查；姊妹掃描器 todoItems／scanRunSteps 本來就有這道）
        let r;
        try { r = store.readRun(category, id, rid); } catch { continue; }
        if (r.status === 'done') continue;
        for (const [nodeId, step] of Object.entries(r.steps ?? {})) {
          // 無人值守失敗：自動 run 的步驟重試用盡仍失敗 → 通知（人話原因＋重試），不默默終止
          if (r.source === 'schedule' && step.status === 'failed') {
            const fnode = r.def.nodes.find((n) => n.id === nodeId);
            pushNotice(store, {
              type: 'step_failed', title: `「${fnode?.title ?? nodeId}」這步失敗（${r.workflow.name}）`,
              desc: step.error ?? '原因不明', actions: ['retry'],
              run: { category, id, run_id: rid, node: nodeId }, fingerprint: `${rid}#${nodeId}#failed`,
            }, nowMs);
          }
          if (step.status !== 'waiting_time' || !step.wake_at) continue;
          const wakeMs = new Date(step.wake_at).getTime();
          if (wakeMs <= nowMs) {
            runner.resumeTime(category, id, rid, nodeId);
            kick(category, id, rid);
          } else {
            const node = r.def.nodes.find((n) => n.id === nodeId);
            const blocked = Object.entries(r.steps)
              .filter(([, s]) => ['waiting_review', 'waiting_human', 'waiting_branch', 'waiting_data', 'waiting_check', 'time_pending'].includes(s.status))
              .map(([bid]) => r.def.nodes.find((n) => n.id === bid)?.title ?? bid);
            timed.push({
              ms: wakeMs, label: `${node?.title ?? nodeId}（${r.workflow.name}）`,
              blockedBy: blocked, fpBase: `${rid}#${nodeId}`, leads: r.def.nodes.find((n) => n.id === nodeId)?.remind_leads,
            });
          }
        }
      }
    }
    // 排程的下一發也算提醒對象（含被移到未來的覆寫；被移走／跳過的那發提醒時刻跟著走）
    for (const sched of valid.filter((s) => s.enabled !== false)) {
      const targets = new Map(); // occKey → 基準時刻
      const nx = nextDue(sched, nowMs);
      if (nx !== null) targets.set(fmtLocal(nx), nx);
      for (const [occKey, o] of Object.entries(sched.overrides ?? {})) {
        if (o?.move && parseWhen(occKey)) targets.set(occKey, parseWhen(occKey).getTime());
      }
      for (const [occKey, baseMs] of targets) {
        const o = overrideOf(sched, occKey);
        if (o?.action === 'skip') continue;
        const eff = o?.move ? (parseWhen(o.move)?.getTime() ?? baseMs) : baseMs;
        if (eff <= nowMs) continue;
        timed.push({ ms: eff, label: `${sched.name ?? sched.workflow_id} 自動開跑`, blockedBy: [], fpBase: `${sched.id}@${occKey}`, leads: sched.remind_leads });
      }
    }

    // 3) 擋時限提醒升級（複數提前量；離線期間該升的一次補發、逾最久排最前）
    const dueReminders = [];
    for (const t of timed) {
      for (const lead of t.leads ?? []) {
        let remindMs = null;
        let leadLabel = '';
        if (typeof lead === 'string' && LEAD_MS[lead]) { remindMs = t.ms - LEAD_MS[lead]; leadLabel = LEAD_LABEL[lead]; }
        else if (lead && typeof lead === 'object' && lead.at) { const d = parseWhen(lead.at); if (d) { remindMs = d.getTime(); leadLabel = '自訂提醒'; } }
        if (remindMs === null || remindMs > nowMs) continue;
        dueReminders.push({ remindMs, t, leadKey: typeof lead === 'string' ? lead : `at:${lead.at}`, leadLabel });
      }
    }
    dueReminders.sort((a, b) => a.remindMs - b.remindMs); // 逾最久排最前
    for (const { t, leadKey, leadLabel } of dueReminders) {
      const blockNote = t.blockedBy.length ? `——還卡著：${t.blockedBy.join('、')}` : '';
      pushNotice(store, {
        type: 'reminder', title: `${leadLabel}：${t.label}`,
        desc: `${fmtLocal(t.ms).replace('T', ' ')}${blockNote}`,
        fingerprint: `${t.fpBase}#${leadKey}`, actions: [],
      }, nowMs);
    }

    return { fired, reminders: dueReminders.length };
  }

  return {
    tickOnce,
    fire,
    nextDue: (sched, after = now()) => nextDue(sched, after),
    prevDue: (sched, before = now()) => prevDue(sched, before),
    start(intervalMs = 60_000) {
      if (timer) return;
      timer = setInterval(() => { try { tickOnce(); } catch { /* tick 失敗下一分鐘再來，不炸 server */ } }, intervalMs);
      timer.unref?.();
      try { tickOnce(); } catch { /* 開機首刻同上 */ }
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
