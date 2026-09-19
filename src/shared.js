// shared — 三層共用檔的純函式：規範轉純文字、字數上限、跨層鍵。不碰檔案系統、不呼叫 AI。
// 資料形狀見 規劃/2026-09-10-三層共用資料-設計.md §八：規範類（rule）每步都帶、參考類（ref）勾了才帶。
import mammoth from 'mammoth';

export class SharedError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export const RULE_EXTS = ['md', 'txt', 'docx'];
export const LIMITS = Object.freeze({ per_file: 4000, per_layer: 8000 });

const extOf = (name) => String(name ?? '').split('.').pop().toLowerCase();

// 規範轉純文字：md／txt 原文、docx 用 mammoth 取純文字；表格與 PDF 各回一句人話（BAD_KIND）
export async function extractRuleText(buf, name) {
  const ext = extOf(name);
  if (ext === 'md' || ext === 'txt') return buf.toString('utf8');
  if (ext === 'docx') return (await mammoth.extractRawText({ buffer: buf })).value;
  if (['xlsx', 'xls', 'csv'].includes(ext)) throw new SharedError('表格不是規範，請放參考', 'BAD_KIND');
  if (ext === 'pdf') throw new SharedError('PDF 還轉不了文字，請改上傳 docx 或貼文字', 'BAD_KIND');
  throw new SharedError(`規範只收 ${RULE_EXTS.join('、')}`, 'BAD_KIND');
}

// 上限：單檔 4,000、每層合計 8,000（chars＝轉成純文字後的長度；layerChars＝該層既有規範合計）；超限回一句、合格回 null
export function checkRuleLimits(chars, layerChars) {
  if (chars > LIMITS.per_file || chars + layerChars > LIMITS.per_layer) return '太長，請精簡或改放參考';
  return null;
}

// （上桌b）：共用檔「查看」形態——md／txt 看原文（text）、docx／xlsx／csv 走成品預覽排版（preview）、其他（pdf、圖）頁內看不了（null）
export function viewKind(name) {
  const ext = String(name ?? '').includes('.') ? extOf(name) : '';
  if (ext === 'md' || ext === 'txt') return 'text';
  if (['docx', 'xlsx', 'csv'].includes(ext)) return 'preview';
  return null;
}
// 網址來的檔名正規化：NFC（macOS 送來的 NFD 也對得到清單）＋去頭尾空白
export const normName = (s) => String(s ?? '').normalize('NFC').trim();

// 共用夾鑰匙：公司＝固定 _company；部門＝分類名
export const scopeKey = (scope, category) => (scope === 'company' ? '_company' : category);
// attachments 元素＝字串（流程層）｜{scope, name}（共用層）：顯示名標層、鍵不撞名
export const attName = (a) => (typeof a === 'string' ? a : `${a.name}（${a.scope === 'company' ? '組織' : '分類'}）`);
export const attKey = (a) => (typeof a === 'string' ? a : `${a.scope}:${a.name}`);
