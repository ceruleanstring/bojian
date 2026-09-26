// 初次體驗輪（US-116）：模擬導覽的示範趟——範例「跟主管報告季度業績」預錄的一趟假資料。
// 全部寫死在這一檔（每步產出、查核結果、每次交卷、成品），格式照真趟 run 物件，執行頁的渲染函式直接吃。
// 這份資料只活在前端：不打任何 API、不寫任何執行紀錄、不進用量。app.js 依卡片把它切成「跑到第幾步」的樣子（demoRunFor）。
// 數字全是示範，不是真的（每份產出結尾都標「示範資料，非真實數字」）。
(function () {
  const AT = '2026-09-25T09:00:00.000Z';
  const at = (min) => new Date(Date.parse(AT) + min * 60000).toISOString();

  const def = {
    format: 1,
    name: '跟主管報告季度業績',
    params: [
      { key: 'script_length', label: '講稿長度', default: '3 分鐘' },
      { key: 'data_range', label: '資料範圍', default: '本季' },
      { key: 'report_pages', label: '報告頁數', default: '5 頁內' },
    ],
    supervisor: { enabled: true },
    check: { enabled: true },
    nodes: [
      { id: 'fetch-data', title: '抓資料（銷售系統）', executor: 'ai', stop_point: 'never', instruction: '這是剝繭的內建範例流程，不連任何真實系統。請生成一份擬真的示範用銷售資料：資料範圍取「{{data_range}}」，逐月列出訂單數、營收、對上月增減百分比，再附一份前十商品排行（品名、件數、營收）。輸出用表格文字呈現，結尾註明「（示範資料，非真實數字）」。', constraints: ['逐月列出訂單數、營收、對上月增減', '結尾註明「示範資料，非真實數字」'], next: ['organize'] },
      { id: 'organize', title: '整理歸納', executor: 'ai', stop_point: 'always', instruction: '把上一步的銷售資料整理成月度彙總表（按月份排、金額加千分位）與前十商品排行。表格之外加三行以內的摘要，指出最值得注意的變化。', review_focus: '數字跟第 1 步一樣、摘要不超過三行', constraints: ['數字一律照第 1 步的原始資料', '摘要三行以內'], next: ['analyze'] },
      { id: 'analyze', title: '分析重點', executor: 'ai', stop_point: 'never', instruction: '根據整理後的彙總，找出本期三個最重要的重點（成長動能、風險、異常），每點附一句原因推測與一句建議。條列呈現。', constraints: ['只講三個重點', '每點附原因與建議各一句'], next: ['compose'] },
      { id: 'compose', title: '做成報告＋講稿', executor: 'ai', stop_point: 'always', instruction: '把前面步驟的彙總與重點做成兩份產出：1) 報告大綱：控制在 {{report_pages}}，每頁一行標題＋兩行內容要點；2) 口頭講稿：長度 {{script_length}}，開場一句、重點三段、收尾一句，口語化。', review_focus: '報告不超過頁數、講稿的數字跟彙總一致', constraints: ['報告大綱不超過 {{report_pages}}', '講稿長度 {{script_length}}'], next: ['present'] },
      { id: 'present', title: '上台報告', executor: 'human', stop_point: 'always', instruction: '拿著上一步的報告與講稿上台報告。完成後回來標記完成，可以順手留一句戰果（例如主管的反應），讓流程之後學著調整。', next: [] },
    ],
  };

  // 第 1 步的原始資料（後面每一步的數字都對回這裡）
  const RAW = [
    ['7 月', '1,180 筆', '1,234,567', '+4.2%'],
    ['8 月', '1,265 筆', '1,345,678', '+9.0%'],
    ['9 月', '1,402 筆', '1,456,789', '+8.3%'],
  ];
  const TOP = [
    ['絨面筆記本 A5', '612', '428,400'], ['黃銅書籤組', '540', '291,600'], ['手帳貼紙包', '1,030', '206,000'], ['鋼筆墨水 30ml', '388', '189,732'], ['帆布筆袋', '352', '158,400'],
    ['週計畫便條', '690', '131,100'], ['桌上收納盤', '214', '128,400'], ['木質印章組', '176', '123,200'], ['燙金信封 10 入', '455', '95,550'], ['迷你尺規套', '300', '72,000'],
  ];
  const rawRow = (r) => `${r[0]}｜${r[1]}｜${r[2]}｜${r[3]}`;
  const fetchOutput = [
    '本季（7～9 月）銷售資料',
    '',
    '月份｜訂單數｜營收｜對上月',
    ...RAW.map(rawRow),
    '季合計｜3,847 筆｜4,037,034｜—',
    '',
    '前十商品（品名｜件數｜營收）',
    ...TOP.map((t, i) => `${i + 1}. ${t[0]}｜${t[1]}｜${t[2]}`),
    '',
    '（示範資料，非真實數字）',
  ].join('\n');

  // 查核逐項表：12 個數字（三個月的訂單數、營收、增減率＝9，季合計兩個＝2，第一名商品營收＝1），每項抄原始資料原文
  const items12 = () => [
    ...RAW.flatMap((r) => [
      { claim: `${r[0]}訂單 ${r[1]}`, source: rawRow(r), scope: '本季', verdict: 'ok' },
      { claim: `${r[0]}營收 ${r[2]}`, source: rawRow(r), scope: '本季', verdict: 'ok' },
      { claim: `${r[0]}對上月 ${r[3]}`, source: rawRow(r), scope: '本季', verdict: 'ok' },
    ]),
    { claim: '季合計訂單 3,847 筆', source: '季合計｜3,847 筆｜4,037,034｜—', scope: '本季', verdict: 'ok' },
    { claim: '季合計營收 4,037,034', source: '季合計｜3,847 筆｜4,037,034｜—', scope: '本季', verdict: 'ok' },
    { claim: '第一名 絨面筆記本 A5 營收 428,400', source: '1. 絨面筆記本 A5｜612｜428,400', scope: '本季', verdict: 'ok' },
  ];
  const passCheck = (items, summary) => ({ status: 'pass', blocks: [], flags: [], missing: [], items, summary, note: '', attempts: 1 });

  const organizeOutput = [
    '月度彙總（本季）',
    '',
    '月份｜訂單數｜營收｜對上月',
    ...RAW.map(rawRow),
    '季合計｜3,847 筆｜4,037,034｜—',
    '',
    '前十商品',
    ...TOP.map((t, i) => `${i + 1}. ${t[0]}｜${t[1]} 件｜${t[2]}`),
    '',
    '摘要',
    '・營收連三個月成長，9 月 1,456,789 是本季最高，對上月 +8.3%。',
    '・前十商品合計 1,824,382，佔季營收 45.2%；絨面筆記本 A5 一項 428,400，佔一成。',
    '・手帳貼紙包件數最多（1,030 件）但單價低，營收只排第三。',
    '',
    '（示範資料，非真實數字）',
  ].join('\n');

  const analyzeOutput = [
    '本期三個重點',
    '',
    '1. 成長動能：營收連三個月成長，9 月 1,456,789 對上月 +8.3%。',
    '　原因推測：開學季帶動文具類，絨面筆記本 A5（428,400）與手帳貼紙包（1,030 件）撐起量。',
    '　建議：10 月延續文具組合的曝光，別讓開學季的熱度斷掉。',
    '2. 風險：前十商品佔季營收 45.2%，集中在文具類。',
    '　原因推測：其他品類（收納、印章）件數少，單一品類撐營收。',
    '　建議：下季把桌上收納盤（128,400）拉進主推，分散集中度。',
    '3. 異常：8 月對上月 +9.0% 是三個月裡最大的一跳。',
    '　原因推測：8 月中的滿額折扣把 9 月的一部分訂單提前吃掉。',
    '　建議：下次活動避開月底，讓月與月之間好比較。',
    '',
    '（示範資料，非真實數字）',
  ].join('\n');

  const composeOutput = (sept) => [
    '一、報告大綱（5 頁內）',
    '',
    '第 1 頁　本季總覽',
    '　・季營收 4,037,034、訂單 3,847 筆，三個月連續成長',
    '　・9 月 ' + sept + ' 為本季最高',
    '第 2 頁　月度走勢',
    '　・7 月 1,234,567 → 8 月 1,345,678（+9.0%）→ 9 月 ' + sept + '（+8.3%）',
    '　・8 月的一跳來自滿額折扣，9 月仍續漲',
    '第 3 頁　商品結構',
    '　・前十商品佔 45.2%，絨面筆記本 A5 一項 428,400',
    '　・手帳貼紙包 1,030 件量最大、營收排第三',
    '第 4 頁　風險與異常',
    '　・集中在文具類，其他品類件數少',
    '　・活動壓在月底，月與月不好比較',
    '第 5 頁　下季怎麼做',
    '　・延續文具組合曝光；把桌上收納盤拉進主推',
    '　・活動避開月底',
    '',
    '二、口頭講稿（3 分鐘）',
    '',
    '各位好，這一季我用一句話講：三個月連續成長，季營收 4,037,034。',
    '第一，動能在文具。開學季把絨面筆記本 A5 推到 428,400，手帳貼紙包賣了 1,030 件，9 月做到 ' + sept + '，是本季最高。',
    '第二，風險是太集中。前十商品佔了 45.2%，幾乎都是文具；收納、印章這些品類量還很小。',
    '第三，8 月那一跳 +9.0% 是折扣提前吃掉了 9 月的單，不是自然成長，下次活動我們避開月底。',
    '下一季的做法：文具組合繼續推，桌上收納盤拉進主推分散集中度。以上，請主管指教。',
    '',
    '（示範資料，非真實數字）',
  ].join('\n');

  const blockedFirst = {
    status: 'blocked',
    blocks: [{ kind: 'number-mismatch', claim: '9 月 1,456,798 為本季最高', source: '9 月｜1,402 筆｜1,456,789｜+8.3%', detail: '9 月營收寫成 1,456,798，原始資料是 1,456,789（尾數 98 與 89 對調）' }],
    flags: [],
    missing: [],
    items: items12().map((it) => (it.claim.startsWith('9 月營收') ? { ...it, claim: '9 月營收 1,456,798', verdict: 'mismatch' } : it)),
    summary: '9 月營收跟原始資料對不上，其餘 11 個數字都對得回去',
    note: '',
    attempts: 1,
  };

  const steps = {
    'fetch-data': {
      status: 'done', output: fetchOutput, started_at: at(0), finished_at: at(1),
      check: passCheck(items12(), '12 個數字全部對得回原始資料；兩條必守都做到'),
      attempts: [{ at: at(1), reason: 'first', output: fetchOutput, check: { status: 'pass', blocks: [], flags: [] } }],
      handoff: { text: '資料已備齊：7～9 月三個月的訂單、營收、增減，加前十商品。下一步照這份整理，數字不要動。' },
      memory: { cards: [], shared: { company: [], dept: [], refs: [] } },
    },
    organize: {
      status: 'done', output: organizeOutput, started_at: at(1), finished_at: at(3),
      check: passCheck(items12(), '12 個數字全部對得回第 1 步；摘要三行'),
      attempts: [{ at: at(2), reason: 'first', output: organizeOutput, check: { status: 'pass', blocks: [], flags: [] } }],
      handoff: { text: '彙總表與前十商品整理好了，摘要三行。下一步只挑三個重點，數字照彙總表。' },
      memory: { cards: [], shared: { company: [], dept: [], refs: [] } },
    },
    analyze: {
      status: 'done', output: analyzeOutput, started_at: at(3), finished_at: at(4),
      check: passCheck(items12().slice(0, 6).map((it) => ({ ...it, scope: '本季' })), '引用到的 6 個數字都對得回彙總表；三個重點各附原因與建議'),
      attempts: [{ at: at(4), reason: 'first', output: analyzeOutput, check: { status: 'pass', blocks: [], flags: [] } }],
      handoff: { text: '三個重點：成長動能、集中風險、8 月異常。下一步做成 5 頁大綱＋ 3 分鐘講稿，數字照彙總表。' },
      memory: { cards: [], shared: { company: [], dept: [], refs: [] } },
    },
    compose: {
      status: 'done', output: composeOutput('1,456,789'), started_at: at(4), finished_at: at(7),
      file: '季度業績報告.docx', file_note: '5 頁；講稿附在第二段',
      check: { status: 'redone', blocks: [], flags: [], missing: [], items: items12(), summary: blockedFirst.summary, note: '', attempts: 2, first_blocks: blockedFirst.blocks, recheck_blocks: [] },
      attempts: [
        { at: at(5), reason: 'first', output: composeOutput('1,456,798'), check: { status: 'blocked', blocks: blockedFirst.blocks, flags: [] } },
        { at: at(7), reason: 'redo', output: composeOutput('1,456,789'), file: { name: '季度業績報告.docx', size: 18432 }, check: { status: 'redone', blocks: [], flags: [], recheck_blocks: [] } },
      ],
      handoff: { text: '報告 5 頁、講稿 3 分鐘都好了。第一次交卷 9 月營收寫錯被查核攔下，重做後對上。' },
      memory: { cards: [], shared: { company: [], dept: [], refs: [] } },
    },
    present: {
      status: 'done', output: '報告完了。主管對第 3 頁的商品結構問得最細，想看前十商品的毛利；下季報告加一欄毛利。', started_at: at(7), finished_at: at(30),
      feedback: '主管對第 3 頁的圖很有興趣，數據問得很細。',
    },
  };

  const run = {
    run_id: 'demo-quarterly',
    workflow: { category: '範例', id: 'quarterly-report', name: def.name },
    def,
    status: 'done',
    source: 'manual',
    params: { script_length: '3 分鐘', data_range: '本季', report_pages: '5 頁內' },
    started_at: AT,
    finished_at: at(30),
    brief: { text: '示範趟：三個欄位照開跑表單的值跑；每一步的數字都要對得回第 1 步的原始資料。' },
    usage_by_node: {},
    memory: { identity: null, picks: {}, changed: [], notices: [] },
    interjections: [],
    steps,
    record: {
      text: '五步全過。第 1～3 步一次過關；第 4 步第一次交卷把 9 月營收寫成 1,456,798，查核員對回原始資料攔下，自動重做一次後 12 個數字全部對上；第 5 步由你上台報告。這趟是模擬，沒用你的額度。',
      suggestions: [],
      usage: { total: { input: 0, output: 0 } },
    },
    overview: {
      at: at(30),
      summary: [
        { text: '季營收 4,037,034、訂單 3,847 筆，三個月連續成長，9 月 1,456,789 最高。', cite: 'organize' },
        { text: '前十商品佔 45.2%，集中在文具類；下季把桌上收納盤拉進主推分散集中度。', cite: 'analyze' },
      ],
      charts: [{ kind: 'bar', title: '三個月營收', series: [{ label: '7 月', value: 1234567 }, { label: '8 月', value: 1345678 }, { label: '9 月', value: 1456789 }] }],
      dropped: [],
      stats: { steps_total: 5, steps_passed: 5, check_blocked: 1, recheck_unresolved: 0, duration_ms: 0 },
    },
  };

  window.BJDemo = {
    run,
    // 成品兩檔名（跑完那張卡列的「成品（示範）」）；docx 是第 4 步的產出檔，講稿是同一步產出的第二段
    artifacts: [
      { name: '季度業績報告.docx', note: '5 頁', node: 'compose' },
      { name: '講稿.md', note: '3 分鐘', node: 'compose' },
    ],
  };
})();
