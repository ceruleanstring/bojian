// 測試共用 fixture（非測試檔，node --test 不會執行）
export const PAR_DEF = {
  format: 1,
  name: '平行測試',
  params: [],
  nodes: [
    { id: 'start', title: '起步', executor: 'ai', stop_point: 'never', instruction: '起', next: ['fk'] },
    { id: 'fk', title: '同時做', kind: 'fork', next: ['t-a', 't-b'] },
    { id: 't-a', title: '做A', executor: 'ai', stop_point: 'never', instruction: 'A', next: ['jn'] },
    { id: 't-b', title: '做B', executor: 'ai', stop_point: 'never', instruction: 'B', next: ['jn'] },
    { id: 'jn', title: '會合', kind: 'join', next: ['final'] },
    { id: 'final', title: '收尾', executor: 'ai', stop_point: 'never', instruction: '收', next: [] },
  ],
};

// 畫布回饋輪：不用 fork/join 的同形流程——多出線＝並行、多入線＝會合
export const PAR_DIRECT_DEF = {
  format: 1,
  name: '直連並行測試',
  params: [],
  nodes: [
    { id: 'start', title: '起步', executor: 'ai', stop_point: 'never', instruction: '起', next: ['t-a', 't-b'] },
    { id: 't-a', title: '做A', executor: 'ai', stop_point: 'never', instruction: 'A', next: ['final'] },
    { id: 't-b', title: '做B', executor: 'ai', stop_point: 'never', instruction: 'B', next: ['final'] },
    { id: 'final', title: '收尾', executor: 'ai', stop_point: 'never', instruction: '收', next: [] },
  ],
};

export const DAG_DEF = {
  format: 1,
  name: '報帳流程',
  params: [],
  nodes: [
    { id: 'fill', title: '填報帳單', executor: 'ai', stop_point: 'never', instruction: '填好單據', next: ['amount-check'] },
    { id: 'amount-check', title: '金額分流', kind: 'branch', instruction: '依報帳金額判斷', branches: [
      { label: '金額五千以上', next: 'boss-sign' },
      { label: '五千以下', next: 'merge' },
    ], next: [] },
    { id: 'boss-sign', title: '主管簽核', executor: 'human', stop_point: 'always', instruction: '找主管簽名', next: ['merge'] },
    { id: 'merge', title: '簽核匯合', kind: 'join', next: ['par'] },
    { id: 'par', title: '同時進行', kind: 'fork', next: ['scan', 'mail'] },
    { id: 'scan', title: '掃描存檔', executor: 'ai', stop_point: 'never', instruction: '掃描歸檔', next: ['done-join'] },
    { id: 'mail', title: '寄出正本', executor: 'ai', stop_point: 'never', instruction: '裝袋寄出', next: ['done-join'] },
    { id: 'done-join', title: '收齊', kind: 'join', next: [] },
  ],
};
