// store — 流程庫檔案樹讀寫（ADR-002：YAML＋版本快照＋原子寫入）。不管執行、不管 UI。
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

export class StoreError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function atomicWrite(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, filePath); // 先寫暫存檔再改名，避免半套
}

function readYaml(filePath, subject) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    throw new StoreError(`找不到${subject}`, 'NOT_FOUND');
  }
  try {
    return yaml.load(text);
  } catch {
    throw new StoreError(`${subject}的檔案讀不懂（可能被手動改壞）`, 'CORRUPT');
  }
}

// 檔名護欄：擋路徑跳脫與 Windows 禁字（參考檔與產出物共用）
export function safeFileName(name) {
  const n = String(name ?? '').trim();
  if (!n || /[\\/:*?"<>|]/.test(n) || n.includes('..')) throw new StoreError(`檔名「${name}」不合法（不能含路徑符號）`, 'BAD_NAME');
  return n;
}

// 路徑段護欄（健檢 P2-01）：分類／流程 id／run id／垃圾桶鍵組路徑前必過，擋 ..、斜線與 Windows 禁字
function safeSegment(value, subject) {
  const n = String(value ?? '').trim();
  if (!n || /[\\/:*?"<>|]/.test(n) || n === '.' || n.includes('..')) {
    throw new StoreError(`${subject}「${value}」不合法（不能含路徑符號）`, 'BAD_NAME');
  }
  return n;
}

export function createStore(dataDir) {
  const wfDir = (category, id) => path.join(dataDir, 'workflows', safeSegment(category, '分類'), safeSegment(id, '流程'));
  const wfFile = (category, id) => path.join(wfDir(category, id), 'workflow.yaml');
  const historyDir = (category, id) => path.join(wfDir(category, id), 'history');
  const runDir = (category, id, runId) => path.join(wfDir(category, id), 'runs', safeSegment(runId, '執行紀錄'));
  const refDir = (category, id) => path.join(wfDir(category, id), 'files');
  const outDir = (category, id, runId) => path.join(runDir(category, id, runId), 'out');
  const promptDir = (category, id, runId) => path.join(runDir(category, id, runId), 'prompts');
  const presetsFile = path.join(dataDir, 'presets.json');
  const usageFile = path.join(dataDir, 'usage.jsonl');
  const schedulesFile = path.join(dataDir, 'schedules.json');
  const noticesFile = path.join(dataDir, 'notices.json');
  const snapshotFile = path.join(dataDir, 'calendar-snapshot.json');

  // 頂層 JSON 檔共用小工具：檔案不存在＝空狀態（刪檔即回滾——ADR-005）；
  // 檔案存在但讀不懂＝明確報錯擋住後續寫入，不准把壞檔當空資料再覆蓋掉（健檢 P1-01）。
  // 快照類（可重抓的快取）例外走 lenient：壞了視為沒有，重抓即復原。
  function readJsonOr(file, fallback, { lenient = false } = {}) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      // 只有「檔案不存在」才算空狀態；其他讀取錯誤（是資料夾、權限）不准偽裝成沒資料（健檢 L1）
      if (e.code === 'ENOENT' || lenient) return fallback;
      throw new StoreError(`「${path.basename(file)}」讀不到（${e.code ?? '未知原因'}）——檢查這個檔案的狀態再繼續`, 'CORRUPT');
    }
    try {
      return JSON.parse(text);
    } catch {
      if (lenient) return fallback;
      throw new StoreError(`「${path.basename(file)}」讀不懂（可能被改壞）——把它修好或刪掉再繼續；剝繭不會動這個壞檔`, 'CORRUPT');
    }
  }

  function listHistoryVersions(category, id) {
    const dir = historyDir(category, id);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .map((f) => /^v(\d+)\.yaml$/.exec(f))
      .filter(Boolean)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
  }

  return {
    dataDir,

    listWorkflows() {
      const root = path.join(dataDir, 'workflows');
      if (!fs.existsSync(root)) return [];
      const out = [];
      for (const category of fs.readdirSync(root)) {
        const catPath = path.join(root, category);
        if (!fs.statSync(catPath).isDirectory()) continue;
        for (const id of fs.readdirSync(catPath)) {
          if (!fs.existsSync(path.join(catPath, id, 'workflow.yaml'))) continue;
          let name = id;
          try {
            name = readYaml(path.join(catPath, id, 'workflow.yaml'), '流程').name ?? id;
          } catch {
            // 壞檔仍列出（讀取時才報錯），名字先用 id
          }
          out.push({ category, id, name });
        }
      }
      return out;
    },

    readWorkflow(category, id) {
      return readYaml(wfFile(category, id), `流程「${id}」`);
    },

    writeWorkflow(category, id, def) {
      atomicWrite(wfFile(category, id), yaml.dump(def, { lineWidth: -1 }));
      if (listHistoryVersions(category, id).length === 0) {
        const snapshot = { diff_note: '建立', source: 'create', def };
        atomicWrite(path.join(historyDir(category, id), 'v1.yaml'), yaml.dump(snapshot, { lineWidth: -1 }));
      }
    },

    listCategories() {
      const root = path.join(dataDir, 'workflows');
      if (!fs.existsSync(root)) return [];
      return fs.readdirSync(root).filter((c) => fs.statSync(path.join(root, c)).isDirectory());
    },

    createCategory(name) {
      fs.mkdirSync(path.join(dataDir, 'workflows', safeSegment(name, '分類名稱')), { recursive: true });
    },

    moveWorkflow(category, id, toCategory) {
      const from = wfDir(category, id);
      if (!fs.existsSync(path.join(from, 'workflow.yaml'))) throw new StoreError(`找不到流程「${id}」`, 'NOT_FOUND');
      const to = wfDir(toCategory, id);
      if (fs.existsSync(to)) throw new StoreError(`「${toCategory}」分類裡已有同名流程`, 'CONFLICT');
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to); // 整個資料夾搬——履歷、run 紀錄一起走
    },

    restoreLatest(category, id) {
      const versions = listHistoryVersions(category, id);
      if (versions.length === 0) throw new StoreError(`流程「${id}」沒有可還原的版本`, 'NOT_FOUND');
      const latest = readYaml(path.join(historyDir(category, id), `v${versions.at(-1)}.yaml`), '版本快照');
      atomicWrite(wfFile(category, id), yaml.dump(latest.def, { lineWidth: -1 }));
      return latest.def;
    },

    listVersions(category, id) {
      return listHistoryVersions(category, id).map((v) => {
        const snap = readYaml(path.join(historyDir(category, id), `v${v}.yaml`), '版本快照');
        return { version: v, diff_note: snap.diff_note, source: snap.source, at: snap.at ?? null };
      });
    },

    readVersion(category, id, version) {
      return readYaml(path.join(historyDir(category, id), `v${version}.yaml`), `版本 v${version}`);
    },

    // 核可提議／退回時升版：現行檔與快照一起寫
    bumpVersion(category, id, def, diffNote, source) {
      const versions = listHistoryVersions(category, id);
      const n = (versions.at(-1) ?? 0) + 1;
      atomicWrite(path.join(historyDir(category, id), `v${n}.yaml`),
        yaml.dump({ diff_note: diffNote, source, at: new Date().toISOString(), def }, { lineWidth: -1 }));
      atomicWrite(wfFile(category, id), yaml.dump(def, { lineWidth: -1 }));
      return n;
    },

    // 手動編輯（畫布／欄位）存檔：進履歷。十分鐘內的連續編輯合併成同一版，免得灌版本
    saveManualEdit(category, id, def) {
      const versions = this.listVersions(category, id);
      const last = versions.at(-1);
      const recent = last && last.source === 'manual' && last.at
        && Date.now() - new Date(last.at).getTime() < 10 * 60_000;
      if (recent) {
        atomicWrite(path.join(historyDir(category, id), `v${last.version}.yaml`),
          yaml.dump({ diff_note: last.diff_note, source: 'manual', at: last.at, def }, { lineWidth: -1 }));
        atomicWrite(wfFile(category, id), yaml.dump(def, { lineWidth: -1 }));
        return last.version;
      }
      return this.bumpVersion(category, id, def, '手動編輯（畫布／欄位）', 'manual');
    },

    // 退回：以舊版為現行版，並再記一版（歷史完整，不刪不改舊快照）
    rollback(category, id, version) {
      const snap = this.readVersion(category, id, version);
      this.bumpVersion(category, id, snap.def, `退回 v${version}`, 'rollback');
      return snap.def;
    },

    readProposals() {
      const f = path.join(dataDir, 'proposals', 'queue.yaml');
      if (!fs.existsSync(f)) return [];
      return readYaml(f, '提議佇列') ?? [];
    },

    writeProposals(list) {
      atomicWrite(path.join(dataDir, 'proposals', 'queue.yaml'), yaml.dump(list, { lineWidth: -1 }));
    },

    // 垃圾桶（US-016）：整資料夾搬走，30 天內可復原
    trashWorkflow(category, id) {
      const from = wfDir(category, id);
      if (!fs.existsSync(path.join(from, 'workflow.yaml'))) throw new StoreError(`找不到流程「${id}」`, 'NOT_FOUND');
      let name = id;
      try { name = readYaml(path.join(from, 'workflow.yaml'), '流程').name ?? id; } catch { /* 壞檔也可丟 */ }
      const key = `${Date.now().toString(36)}-${category}-${id}`;
      const dest = path.join(dataDir, 'trash', key);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(from, dest);
      atomicWrite(path.join(dest, 'meta.yaml'), yaml.dump({ category, id, name, trashed_at: new Date().toISOString() }));
      return key;
    },

    listTrash() {
      const root = path.join(dataDir, 'trash');
      if (!fs.existsSync(root)) return [];
      return fs.readdirSync(root)
        .filter((k) => fs.existsSync(path.join(root, k, 'meta.yaml')))
        .map((k) => ({ key: k, ...readYaml(path.join(root, k, 'meta.yaml'), '垃圾桶紀錄') }));
    },

    restoreTrash(key) {
      const src = path.join(dataDir, 'trash', safeSegment(key, '垃圾桶紀錄'));
      const meta = readYaml(path.join(src, 'meta.yaml'), '垃圾桶紀錄');
      let id = meta.id;
      while (fs.existsSync(wfDir(meta.category, id))) id = `${meta.id}-復原${Math.random().toString(36).slice(2, 5)}`;
      fs.rmSync(path.join(src, 'meta.yaml'));
      fs.mkdirSync(path.dirname(wfDir(meta.category, id)), { recursive: true });
      fs.renameSync(src, wfDir(meta.category, id));
      return { category: meta.category, id };
    },

    purgeTrash(maxAgeDays = 30) {
      const cutoff = Date.now() - maxAgeDays * 86_400_000;
      for (const t of this.listTrash()) {
        if (new Date(t.trashed_at).getTime() < cutoff) {
          fs.rmSync(path.join(dataDir, 'trash', t.key), { recursive: true, force: true });
        }
      }
    },

    newRunId() {
      const t = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const stamp = `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}`;
      return `r-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
    },

    // ---- 參考檔（D19：步驟掛附件／範本）----
    writeRefFile(category, id, name, buf) {
      const p = path.join(refDir(category, id), safeFileName(name));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, buf);
    },
    listRefFiles(category, id) {
      const dir = refDir(category, id);
      return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
    },
    deleteRefFile(category, id, name) {
      fs.rmSync(path.join(refDir(category, id), safeFileName(name)), { force: true });
    },
    refFilePath(category, id, name) {
      const p = path.join(refDir(category, id), safeFileName(name));
      return fs.existsSync(p) ? p : null;
    },
    readRefText(category, id, name) {
      const p = this.refFilePath(category, id, name);
      if (!p) throw new StoreError(`參考檔「${name}」不見了`, 'NOT_FOUND');
      return fs.readFileSync(p, 'utf8');
    },

    // ---- 產出物（D19：步驟輸出存成檔案）----
    writeArtifact(category, id, runId, name, text) {
      const p = path.join(outDir(category, id, runId), safeFileName(name));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text, 'utf8');
      return name;
    },
    listArtifacts(category, id, runId) {
      const dir = outDir(category, id, runId);
      return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
    },
    // 產檔輪：工人在這趟的產出資料夾開工——確保存在並回絕對路徑；產完由 runner 確認檔案真的在
    runOutDir(category, id, runId) {
      const dir = outDir(category, id, runId);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
    artifactExists(category, id, runId, name) {
      return fs.existsSync(path.join(outDir(category, id, runId), safeFileName(name)));
    },
    readArtifact(category, id, runId, name) {
      const p = path.join(outDir(category, id, runId), safeFileName(name));
      if (!fs.existsSync(p)) throw new StoreError(`產出檔「${name}」不見了`, 'NOT_FOUND');
      return fs.readFileSync(p);
    },

    // ---- 常用預設庫（D19：複製式——選用＝把內容複製進步驟）----
    listPresets() {
      return readJsonOr(presetsFile, {});
    },
    savePreset(field, name, text) {
      const all = this.listPresets();
      (all[field] ??= []);
      const hit = all[field].find((p) => p.name === name);
      if (hit) hit.text = text;
      else all[field].push({ name, text });
      atomicWrite(presetsFile, JSON.stringify(all, null, 2));
    },
    deletePreset(field, name) {
      const all = this.listPresets();
      all[field] = (all[field] ?? []).filter((p) => p.name !== name);
      atomicWrite(presetsFile, JSON.stringify(all, null, 2));
    },

    // ---- 排程／通知／Google 快照（D20，ADR-005）----
    readSchedules() {
      return readJsonOr(schedulesFile, []);
    },
    writeSchedules(list) {
      atomicWrite(schedulesFile, JSON.stringify(list, null, 2));
    },
    readNotices() {
      return readJsonOr(noticesFile, []);
    },
    writeNotices(list) {
      atomicWrite(noticesFile, JSON.stringify(list, null, 2));
    },
    readSnapshot() {
      return readJsonOr(snapshotFile, null, { lenient: true }); // 快照是快取，壞了重抓即可
    },
    writeSnapshot(snap) {
      atomicWrite(snapshotFile, JSON.stringify(snap, null, 2));
    },

    writeRun(category, id, runId, run) {
      atomicWrite(path.join(runDir(category, id, runId), 'run.yaml'), yaml.dump(run, { lineWidth: -1 }));
    },

    readRun(category, id, runId) {
      return readYaml(path.join(runDir(category, id, runId), 'run.yaml'), `執行紀錄「${runId}」`);
    },

    listRuns(category, id) {
      const dir = path.join(wfDir(category, id), 'runs');
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).filter((f) => fs.existsSync(path.join(dir, f, 'run.yaml'))).sort();
    },

    // 刪一次執行（2026-09-02 定案：跑到一半不想跑完的要能清）：連 run.yaml、產出檔、卷宗整夾刪除，不進垃圾桶
    deleteRun(category, id, runId) {
      const dir = runDir(category, id, runId);
      if (!fs.existsSync(path.join(dir, 'run.yaml'))) throw new StoreError(`找不到執行紀錄「${runId}」`, 'NOT_FOUND');
      fs.rmSync(dir, { recursive: true, force: true });
    },

    // 跨流程最近執行（儀表板輪）：runId 以時間戳開頭，字典序＝時間序
    listRecentRuns(limit = 20) {
      const all = [];
      for (const w of this.listWorkflows()) {
        for (const runId of this.listRuns(w.category, w.id)) all.push({ ...w, runId });
      }
      all.sort((a, b) => b.runId.localeCompare(a.runId));
      return all.slice(0, limit);
    },

    // ---- prompt 卷宗（儀表板輪）：每步送出宿主的指示全文，存進該次執行資料夾 ----
    writePromptRecord(category, id, runId, name, text) {
      const p = path.join(promptDir(category, id, runId), safeFileName(name));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text, 'utf8');
    },
    listPromptRecords(category, id, runId) {
      const dir = promptDir(category, id, runId);
      return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
    },
    readPromptRecord(category, id, runId, name) {
      const p = path.join(promptDir(category, id, runId), safeFileName(name));
      if (!fs.existsSync(p)) throw new StoreError(`這一步的指示卷宗「${name}」不存在（改版前跑的舊紀錄沒有卷宗）`, 'NOT_FOUND');
      return fs.readFileSync(p, 'utf8');
    },

    // ---- 用量帳本（儀表板輪）：append-only JSONL，一次宿主呼叫一行 ----
    appendUsage(entry) {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.appendFileSync(usageFile, `${JSON.stringify(entry)}\n`, 'utf8');
    },
    readUsage({ sinceMs = null } = {}) {
      let text;
      try {
        text = fs.readFileSync(usageFile, 'utf8');
      } catch (e) {
        if (e.code === 'ENOENT') return []; // 還沒記過帳＝空帳本
        throw new StoreError(`用量帳本讀不到（${e.code ?? '未知原因'}）`, 'CORRUPT');
      }
      const out = [];
      for (const line of text.split('\n')) {
        const s = line.trim();
        if (!s) continue;
        try {
          const entry = JSON.parse(s);
          if (!sinceMs || new Date(entry.at).getTime() >= sinceMs) out.push(entry);
        } catch { /* append 中斷的殘行跳過，不擋整本帳 */ }
      }
      return out;
    },
  };
}
