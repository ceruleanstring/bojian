// notices — 通知中心（D20）：系統事件存放、指紋去重、已處理留痕。不做業務判斷，事件由 scheduler/server 產生。
// notices.json 是扁平清單；type='trigger' 是純觸發指紋（防重發防重跑，UI 不顯示）。

export const NOTICE_TYPES = ['trigger', 'missed', 'overlap', 'start_failed', 'step_failed', 'snapshot_failed', 'reminder'];

export function hasFingerprint(list, fp) {
  return list.some((n) => n.fingerprint === fp);
}

// 去重合併：同指紋只發一次（含已處理——重啟不重發，ADR-005）。回傳新通知或 null（已存在）
export function pushNotice(store, notice, nowMs = Date.now()) {
  const list = store.readNotices();
  if (notice.fingerprint && hasFingerprint(list, notice.fingerprint)) return null;
  const n = {
    id: `n-${nowMs.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    status: notice.type === 'trigger' ? 'done' : 'unread',
    created_at: new Date(nowMs).toISOString(),
    ...notice,
  };
  list.push(n);
  store.writeNotices(list);
  return n;
}

// 標記已處理（留痕；動作結果一句話）
export function resolveNotice(store, noticeId, note = null) {
  const list = store.readNotices();
  const n = list.find((x) => x.id === noticeId);
  if (!n) throw new Error('這則通知不存在（可能已被清理）');
  n.status = 'done';
  n.resolved_at = new Date().toISOString();
  if (note) n.result = note;
  store.writeNotices(list);
  return n;
}
