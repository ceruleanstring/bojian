// docx 抽純文字——用剝繭自帶的 mammoth；打不開就丟錯（呼叫端判「檔打不開＝不過」）
import mammoth from 'mammoth';

export async function docxText(file) {
  const { value } = await mammoth.extractRawText({ path: file });
  return value ?? '';
}
