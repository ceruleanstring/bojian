// 題目 pass 之前的「完整性閘」（2026-09-25，Codex 審查 E2）：一趟結果先證明「真的跑完、預期的查核真的跑過、成品沒夾假話」，
// 才輪到題目自己的品質條件（數字命中、冤枉率…）。單一實作放這裡，免得每題各長一套「缺資料就當過」的預設。
// 用法：const g = completenessGates({ runStatus, steps, expectChecked: ['numbers', …], falseClaims }); pass = g.ok && 題目條件；g.reasons 逐條寫進 misses／notes。

// 一步有「有效的查核紀錄」＝check 是物件且帶字串 status（pass／blocked／redone／missing…）；null／undefined＝這步沒查核（查核關、或 cc 邊）
export const hasCheck = (step) => !!step && !!step.check && typeof step.check === 'object' && typeof step.check.status === 'string';

export function completenessGates({ runStatus = null, steps = {}, expectChecked = [], falseClaims = 0 } = {}) {
  const reasons = [];
  if (runStatus !== 'done') reasons.push(`流程沒跑完（status=${runStatus ?? '沒給'}，要 done）`);
  const unchecked = (Array.isArray(expectChecked) ? expectChecked : []).filter((nid) => !hasCheck(steps?.[nid]));
  if (unchecked.length) reasons.push(`查核沒跑：${unchecked.join('、')} 沒有查核紀錄`);
  const fc = Number(falseClaims) || 0;
  if (fc > 0) reasons.push(`成品夾假話 ${fc} 句`);
  return { ok: reasons.length === 0, reasons, unchecked, false_claims: fc };
}
