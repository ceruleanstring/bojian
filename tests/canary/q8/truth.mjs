// q8 標準答案：把寫出去的 orders.csv 重新讀回來、照陷阱規則正確處理後算（獨立於 gen.mjs，不抄產生器的物件）。
// 規則（＝題目指示）：訂單數算張數（訂單編號去重）；營收只算「完成」；8 月＝8/1 00:00～8/31 23:59（9/1 00:xx 不算）；
//   三種日期寫法都是 2026 年；金額去千分位；金額空白或「－」用 數量×單價 補。
// 另外算出「每種陷阱會誘導出的錯數字」（decoys）給 score 反向計分用。
import { readCsv } from '../lib/csv.mjs';

const RE_ISO = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;
const RE_SLASH = /^(\d{4})\/(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{2})$/;
const RE_ZH = /^(\d{1,2})月(\d{1,2})日 (\d{1,2}):(\d{2})$/;

// 回 { y, m, d, hh, mm, fmt }；認不出來就丟錯（資料是自己造的，認不出＝造壞了）
export function parseWhen(s) {
  const t = String(s ?? '').trim();
  let x;
  if ((x = RE_ISO.exec(t))) return { y: +x[1], m: +x[2], d: +x[3], hh: +x[4], mm: +x[5], fmt: 'iso' };
  if ((x = RE_SLASH.exec(t))) return { y: +x[1], m: +x[2], d: +x[3], hh: +x[4], mm: +x[5], fmt: 'slash' };
  if ((x = RE_ZH.exec(t))) return { y: 2026, m: +x[1], d: +x[2], hh: +x[3], mm: +x[4], fmt: 'zh' };
  throw new Error(`q8 truth：認不出的下單時間「${t}」`);
}

// 回 { value, kind: 'plain'|'comma'|'blank' }；整數，不用浮點
export function parseAmount(s, qty, price) {
  const t = String(s ?? '').trim();
  if (t === '' || t === '－' || t === '-') return { value: qty * price, kind: 'blank' };
  const kind = t.includes(',') ? 'comma' : 'plain';
  const n = Number(t.replace(/,/g, ''));
  if (!Number.isInteger(n)) throw new Error(`q8 truth：認不出的金額「${t}」`);
  return { value: n, kind };
}

const sum = (xs, f = (x) => x) => xs.reduce((a, x) => a + f(x), 0);
const r1 = (x) => Math.round(x * 10) / 10;

export function computeTruth(csvPath) {
  const recs = readCsv(csvPath);
  const rows = recs.map((r, i) => {
    const qty = Number(r['數量']); const price = Number(r['單價']);
    if (!Number.isInteger(qty) || !Number.isInteger(price)) throw new Error(`q8 truth：第 ${i + 2} 列數量／單價不是整數`);
    const when = parseWhen(r['下單時間']);
    const amt = parseAmount(r['金額'], qty, price);
    if (amt.value !== qty * price) throw new Error(`q8 truth：第 ${i + 2} 列金額 ${amt.value} ≠ 數量×單價 ${qty * price}`);
    return { id: r['訂單編號'], when, ch: r['通路'], name: r['商品'], qty, price, amt: amt.value, amtKind: amt.kind, status: r['狀態'] };
  });

  // 訂單編號去重（①）；同一張的列時間／通路／狀態必須一致
  const orders = new Map();
  for (const r of rows) {
    const o = orders.get(r.id);
    if (!o) { orders.set(r.id, { id: r.id, when: r.when, ch: r.ch, status: r.status, rows: [r], total: r.amt }); continue; }
    const same = ['y', 'm', 'd', 'hh', 'mm'].every((k) => o.when[k] === r.when[k]);
    if (!same || o.ch !== r.ch || o.status !== r.status) throw new Error(`q8 truth：訂單 ${r.id} 各列的時間／通路／狀態不一致`);
    o.rows.push(r); o.total += r.amt;
  }
  const all = [...orders.values()];
  const inMonth = (o, m) => o.when.y === 2026 && o.when.m === m;
  const augDone = all.filter((o) => inMonth(o, 8) && o.status === '完成');
  const julDone = all.filter((o) => inMonth(o, 7) && o.status === '完成');
  const augRefund = all.filter((o) => inMonth(o, 8) && o.status === '已退款');
  const augCancel = all.filter((o) => inMonth(o, 8) && o.status === '已取消');
  const sepDone = all.filter((o) => inMonth(o, 9) && o.status === '完成');
  const augDoneRows = augDone.flatMap((o) => o.rows);

  const aug_revenue = sum(augDone, (o) => o.total);
  const jul_revenue = sum(julDone, (o) => o.total);
  const byProd = {};
  for (const r of augDoneRows) byProd[r.name] = (byProd[r.name] ?? 0) + r.amt;
  const byCh = {};
  for (const o of augDone) byCh[o.ch] = (byCh[o.ch] ?? 0) + o.total;
  const channels = [...new Set(all.map((o) => o.ch))].sort();
  const aug_refund_amount = sum(augRefund, (o) => o.total);
  const aug_cancel_amount = sum(augCancel, (o) => o.total);

  const truth = {
    rows: rows.length,
    orders: all.length,
    aug_orders: augDone.length,
    aug_revenue,
    aov: Math.round(aug_revenue / augDone.length),
    jul_revenue,
    mom_pct: r1((aug_revenue - jul_revenue) / jul_revenue * 100),
    top3: Object.entries(byProd).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, rev]) => ({ name, rev })),
    channel_rev: Object.fromEntries(channels.map((c) => [c, byCh[c] ?? 0])),
    channel_share: Object.fromEntries(channels.map((c) => [c, r1((byCh[c] ?? 0) / aug_revenue * 100)])),
    aug_refund_orders: augRefund.length,
    aug_refund_amount,
    aug_cancel_orders: augCancel.length,
    aug_cancel_amount,
    aug_done_order_ids: augDone.map((o) => o.id),
  };

  // 每種陷阱誘導出的錯數字（成品出現任一個＝trap_hit）。type：count＝獨立整數、countUnit＝整數＋張／筆／件／單（小數字怕撞日期）、num＝金額
  const rowsDone = augDoneRows.length;
  const decoysRaw = [
    { trap: 1, key: 'orders_as_rows', label: '① 訂單數算成列數', type: 'count', value: rowsDone },
    { trap: 1, key: 'aov_by_rows', label: '① 客單價用列數除', type: 'num', value: Math.round(aug_revenue / rowsDone) },
    { trap: 2, key: 'rev_incl_refund', label: '② 營收含已退款', type: 'num', value: aug_revenue + aug_refund_amount },
    { trap: 2, key: 'rev_all_status', label: '② 營收含已取消與已退款', type: 'num', value: aug_revenue + aug_refund_amount + aug_cancel_amount },
    { trap: 2, key: 'refund_as_rows', label: '② 退款張數算成列數', type: 'countUnit', value: sum(augRefund, (o) => o.rows.length) },
    { trap: 3, key: 'rev_with_sep1', label: '③ 營收把 9/1 凌晨算進 8 月', type: 'num', value: aug_revenue + sum(sepDone, (o) => o.total) },
    { trap: 3, key: 'rev_iso_only', label: '③ 營收只認 2026-08-xx 寫法', type: 'num', value: sum(augDoneRows.filter((r) => r.when.fmt === 'iso'), (r) => r.amt) },
    { trap: 3, key: 'rev_no_zh', label: '③ 營收漏掉「8月x日」寫法', type: 'num', value: sum(augDoneRows.filter((r) => r.when.fmt !== 'zh'), (r) => r.amt) },
    { trap: 4, key: 'rev_no_comma', label: '④ 營收漏掉千分位金額', type: 'num', value: aug_revenue - sum(augDoneRows.filter((r) => r.amtKind === 'comma'), (r) => r.amt) },
    { trap: 5, key: 'rev_no_blank', label: '⑤ 營收漏掉空白金額', type: 'num', value: aug_revenue - sum(augDoneRows.filter((r) => r.amtKind === 'blank'), (r) => r.amt) },
  ];
  // 錯數字不准撞到正確數字（否則寫對的成品會被冤枉）；同值的錯數字只留一個
  const truthValues = new Set([
    truth.aug_orders, truth.aug_revenue, truth.aov, truth.jul_revenue,
    ...truth.top3.map((p) => p.rev), ...Object.values(truth.channel_rev),
    truth.aug_refund_orders, truth.aug_refund_amount, truth.aug_cancel_orders, truth.aug_cancel_amount,
  ]);
  const wan = (n) => (n >= 10000 ? Math.round(n / 1000) / 10 : null);
  const truthWan = new Set([...truthValues].map(wan).filter((x) => x !== null));
  const seen = new Set();
  const decoys = [];
  for (const d of decoysRaw) {
    if (truthValues.has(d.value)) throw new Error(`q8 truth：錯數字「${d.label}」＝${d.value} 撞到正確數字——換種子`);
    if (d.type === 'num' && wan(d.value) !== null && truthWan.has(wan(d.value))) throw new Error(`q8 truth：錯數字「${d.label}」＝${d.value} 的「萬」寫法撞到正確數字——換種子`);
    if (seen.has(d.value)) continue;
    seen.add(d.value);
    decoys.push(d);
  }
  truth.decoys = decoys;

  // 陷阱到底有沒有埋進檔裡（selfcheck 對這個）
  truth.trap_stats = {
    multi_row_orders: all.filter((o) => o.rows.length > 1).length,
    statuses: Object.fromEntries(['完成', '已取消', '已退款'].map((s) => [s, all.filter((o) => o.status === s).length])),
    formats: Object.fromEntries(['iso', 'slash', 'zh'].map((f) => [f, all.filter((o) => o.when.fmt === f).length])),
    aug31_late: all.filter((o) => inMonth(o, 8) && o.when.d === 31 && o.when.hh === 23).length,
    sep1_early: all.filter((o) => inMonth(o, 9) && o.when.d === 1 && o.when.hh === 0).length,
    comma_rows: rows.filter((r) => r.amtKind === 'comma').length,
    blank_rows: rows.filter((r) => r.amtKind === 'blank').length,
  };
  return truth;
}
