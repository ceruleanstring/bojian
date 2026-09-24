// 固定種子亂數（LCG，與 reviews/對照測試-2026-09-23/gen-data.mjs 逐字同一條公式）——同一個 seed 每次產出一模一樣
export function makeRng(seed) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1)); // 含兩端
  return { rnd, pick, int };
}
