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

// 不用 fork/join 的同形流程——多出線＝並行、多入線＝會合
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

// 連線輪：宿主啟動訊息 system/init 的形狀（2026-09-22 在這台機器實測的服務與工具名；工具只列會用到的幾家）
const tools = (server, names) => names.map((n) => `mcp__${server}__${n}`);
export const CONNECTOR_INIT = {
  type: 'system',
  subtype: 'init',
  mcp_servers: [
    { name: 'claude.ai Gmail', status: 'connected', source: 'claudeai' },
    { name: 'claude.ai Google Drive', status: 'connected', source: 'claudeai' },
    { name: 'claude.ai Google Calendar', status: 'connected', source: 'claudeai' },
    { name: 'claude.ai Canva', status: 'connected', source: 'claudeai' },
    { name: 'claude.ai Notion', status: 'needs-auth', source: 'claudeai' },
    { name: 'claude.ai Windsor.ai', status: 'failed', source: 'claudeai' },
    { name: 'plugin:data:bigquery', status: 'needs-auth', source: 'plugin' },
    { name: 'my-crm', status: 'connected', source: 'user' },
  ],
  tools: [
    'Read', 'WebSearch',
    ...tools('claude_ai_Gmail', ['apply_sensitive_message_label', 'create_draft', 'create_label', 'delete_draft', 'forward', 'get_draft', 'get_message',
      'get_thread', 'label_message', 'list_drafts', 'list_labels', 'mark_thread_spam', 'reply', 'search_threads', 'send_message', 'trash_message',
      'trash_thread', 'untrash_thread', 'update_draft']),
    ...tools('claude_ai_Google_Drive', ['copy_file', 'create_file', 'download_file_content', 'get_file_metadata', 'get_file_permissions',
      'list_recent_files', 'read_file_content', 'search_files', 'share_file', 'trash_file', 'update_file']),
    ...tools('claude_ai_Google_Calendar', ['create_event', 'delete_event', 'get_event', 'list_calendars', 'list_events', 'respond_to_event',
      'search_events', 'suggest_time', 'update_event']),
    ...tools('claude_ai_Canva', ['search-designs', 'read-design', 'get-assets', 'export-design', 'generate-design', 'comment-on-design', 'help', 'resolve-shortlink']),
    ...tools('my-crm'.replace(/[^A-Za-z0-9]/g, '_'), ['getCustomer', 'lookup_order', 'syncAll', 'frobnicate']),
    'mcp__plugin_data_bigquery__query',
  ],
};
