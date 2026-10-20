#!/usr/bin/env node
'use strict';
/**
 * dsh2wb.js —— DSH 会话 → WorkBuddy
 *
 * 默认**不导归档会话**（归档名单来自 ~/.dsh/storages/workspace.json 的 global.archivedSessionIds）。
 *
 *   node dsh2wb.js --list                  # 列 DSH 会话 + 是否归档
 *   node dsh2wb.js                         # 导全部「非归档、非空」会话到 ~/.workbuddy
 *   node dsh2wb.js --include-archived      # 连归档一起导（旧行为）
 *   node dsh2wb.js --only 15496ff2         # 只导某条
 *   node dsh2wb.js --cwd D:/X --dry        # 空跑，只统计
 *
 * 落点：~/.workbuddy/projects/<slug>/<uuid>.jsonl
 * 清单：~/.workbuddy/session-bridge/last-manifest.json（供 wbdb.py 写索引）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('./lib');

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const LIST = has('list');
const DRY = has('dry');
const INCLUDE_ARCHIVED = has('include-archived');
const ONLY = arg('only', null);
const FORCE_CWD = arg('cwd', null);
const OVERWRITE = has('overwrite');
const NEW_ID = has('new-id');
const HOME_WB = path.resolve(arg('home', L.HOME_WB).replace(/^~/, os.homedir()));

const reg = L.dshRegistry();
const activeIds = new Set(reg.workspaces.flatMap((w) => w.sessionIds || []));

if (LIST) {
  const rows = L.dshSessionFiles().map((f) => {
    const m = L.sessionMeta(f.file);
    const archived = reg.archived.has(f.id);
    const ws = reg.workspaces.find((w) => (w.sessionIds || []).includes(f.id));
    return { id: f.id, cwd: L.normCwd(m.cwd), archived, registered: !!ws, createdAt: m.createdAt, mtime: f.mtime, kb: Math.round(fs.statSync(f.file).size / 1024) };
  }).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  console.log('ID'.padEnd(42), '归档', '工作区'.padEnd(26), '大小', ' 时间');
  for (const r of rows) {
    console.log(
      r.id.replace(/^session-/, '').padEnd(42),
      (r.archived ? '是' : '否').padEnd(4),
      (r.cwd || '-').slice(-26).padEnd(26),
      (r.kb + 'KB').padStart(7),
      ' ', L.ts(r.createdAt),
      r.registered ? '' : ' (未注册)'
    );
  }
  const nA = rows.filter((r) => r.archived).length;
  console.log(`\n共 ${rows.length} 条：活跃 ${rows.length - nA} / 归档 ${nA}`);
  process.exit(0);
}

const textOf = (content) => {
  if (!Array.isArray(content)) return '';
  const out = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    if (typeof c.text === 'string') out.push(c.text);
    else if (c.type === 'image') out.push('[图片]');
  }
  return out.join('\n').trim();
};

function convert(file, outDir, uuidOverride) {
  const uuid = uuidOverride || path.basename(path.dirname(file)).replace(/^session-/, '');
  const outPath = path.join(outDir, uuid + '.jsonl');
  const fd = DRY ? null : fs.openSync(outPath, 'w');
  const write = (o) => { if (fd !== null) fs.writeSync(fd, JSON.stringify(o) + '\n'); };

  let cwd = FORCE_CWD ? L.normCwd(FORCE_CWD) : null;
  let title = null, titleHint = '', firstUser = '';
  let parent = null;
  const push = (ev) => {
    if (parent) ev.parentId = parent;
    ev.id = L.uuidish();
    ev.sessionId = uuid;
    ev.cwd = cwd;
    write(ev);
    if (['message', 'reasoning', 'function_call', 'function_call_result'].includes(ev.type)) parent = ev.id;
  };

  const callNames = new Map();
  let nU = 0, nA = 0, nR = 0, nC = 0, nRes = 0, t0 = null, t1 = null;
  const events = [...L.dshEvents(file)];

  for (const o of events) {
    const d = o.data || {};
    if (o.type === 'session' && o.cwd && !cwd) cwd = L.normCwd(o.cwd);
    if (o.time) { if (!t0) t0 = o.time; t1 = o.time; }
    if (o.type === 'session/title' && d.title) title = title || d.title;
  }
  if (!cwd) cwd = L.normCwd(process.cwd());

  write({ type: 'session-meta', id: L.uuidish(), sessionId: uuid, timestamp: t0 || Date.now(), meta: { 'codebuddy.ai/hostKind': 'unopted' } });

  for (const o of events) {
    const d = o.data || {};
    const time = o.time || t1 || Date.now();
    if (o.type === 'user/message') {
      const kind = d.source && d.source.kind;
      if (kind && kind !== 'user') continue;              // runtime-context / skills 注入
      const body = textOf(d.content);
      if (!body) continue;
      if (!firstUser) firstUser = body.split('\n')[0].slice(0, 60);
      if (!titleHint && body.length >= 8 && !/^(你好|您好|继续|hi|hello|ok|嗯+|在吗|测试)[。.!！?？\s]*$/i.test(body)) {
        titleHint = body.split('\n')[0].replace(/\s+/g, ' ').slice(0, 48);
      }
      nU++;
      push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: body }], timestamp: time });
      continue;
    }
    if (o.type === 'assistant/message') {
      const content = (d.message && d.message.content) || [];
      const reasoning = content.filter((c) => c && c.type === 'reasoning').map((c) => c.text).join('\n').trim();
      const text = content.filter((c) => c && c.type !== 'reasoning').map((c) => (typeof c.text === 'string' ? c.text : '')).join('\n').trim();
      if (reasoning) { nR++; push({ type: 'reasoning', content: [], rawContent: [{ type: 'reasoning_text', text: reasoning }], timestamp: time }); }
      if (text) { nA++; push({ type: 'message', role: 'assistant', content: [{ type: 'text', text }], timestamp: time }); }
      continue;
    }
    if (o.type === 'tool/call') {
      const callId = d.callId || (d.message && d.message.toolCallId) || L.uid();
      let a = d.arguments;
      if (typeof a !== 'string') a = JSON.stringify(a || {});
      callNames.set(callId, d.name || 'tool');
      nC++;
      push({ type: 'function_call', name: d.name || 'tool', arguments: a, callId, providerData: { model: 'dsh-import', agent: 'cli' }, timestamp: time });
      continue;
    }
    if (o.type === 'tool/result') {
      const m = d.message || {};
      const callId = m.toolCallId || d.toolCallId || '';
      nRes++;
      push({
        type: 'function_call_result',
        name: callNames.get(callId) || 'tool',
        callId,
        status: m.isError ? 'failed' : 'completed',
        output: { type: 'text', text: textOf(m.content) },
        timestamp: time,
      });
      continue;
    }
    if (o.type === 'compaction/summary') {
      const body = textOf(d.summary);
      if (!body) continue;
      nA++;
      push({ type: 'message', role: 'assistant', content: [{ type: 'text', text: '【DSH 上下文压缩摘要】\n\n' + body }], timestamp: time });
    }
  }

  if (!title || title === '你好') title = titleHint || firstUser || title || '未命名 DSH 会话';
  write({ type: 'ai-title', aiTitle: title, sessionId: uuid, cwd, timestamp: t1 || Date.now() });
  if (fd !== null) fs.closeSync(fd);

  return {
    id: uuid, cwd, slug: L.wbSlug(cwd), title,
    created_at: t0 || Date.now(), updated_at: t1 || t0 || Date.now(),
    user: nU, assistant: nA, reasoning: nR, tool_call: nC, tool_result: nRes,
    jsonl: DRY ? null : outPath, bytes: DRY ? 0 : fs.statSync(outPath).size,
    src: file,
  };
}

// ---------- 主流程 ----------
let targets = L.dshSessionFiles().filter((f) => !ONLY || f.id.includes(ONLY));
const skipped = { archived: [], empty: [] };
if (!INCLUDE_ARCHIVED) {
  const before = targets.length;
  targets = targets.filter((f) => {
    if (reg.archived.has(f.id)) { skipped.archived.push(f.id); return false; }
    return true;
  });
  if (before !== targets.length) {
    console.log(`跳过归档会话 ${skipped.archived.length} 条：${skipped.archived.map((x) => x.replace('session-', '')).join(', ')}`);
  }
}

const results = [];
for (const f of targets) {
  try {
    const cwdProbe = FORCE_CWD ? L.normCwd(FORCE_CWD) : L.normCwd(L.sessionMeta(f.file).cwd || process.cwd());
    const outDir = path.join(HOME_WB, 'projects', L.wbSlug(cwdProbe));
    let uuidOverride = null;
    const sid = f.id.replace(/^session-/, '');
    if (!DRY && fs.existsSync(path.join(outDir, sid + '.jsonl'))) {
      if (NEW_ID) uuidOverride = L.uid();
      else if (!OVERWRITE) { console.log(`= ${sid}  已存在，跳过（要覆盖加 --overwrite，要另存加 --new-id）`); continue; }
    }
    if (!DRY) fs.mkdirSync(outDir, { recursive: true });
    const r = convert(f.file, DRY ? '' : outDir, uuidOverride);
    if (r.user === 0) { skipped.empty.push(r.id); if (!DRY) fs.rmSync(r.jsonl, { force: true }); continue; }
    results.push(r);
    console.log(`✓ ${r.id}  U${r.user} A${r.assistant} R${r.reasoning} T${r.tool_call}/${r.tool_result}  ${(r.bytes / 1048576).toFixed(2)}MB  ${r.cwd}  「${r.title}」`);
  } catch (e) {
    console.log(`✗ ${f.id}  ${e.message}`);
  }
}

if (!DRY) {
  const manDir = path.join(HOME_WB, 'session-bridge');
  fs.mkdirSync(manDir, { recursive: true });
  const manifest = path.join(manDir, 'last-manifest.json');
  // 与旧清单按 id 合并，--only 不会把全量清单冲掉
  let merged = results;
  try {
    const old = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    const byId = new Map(old.map((x) => [x.id, x]));
    for (const r of results) byId.set(r.id, r);
    merged = [...byId.values()].sort((a, b) => a.created_at - b.created_at);
  } catch (_) {}
  fs.writeFileSync(manifest, JSON.stringify(merged, null, 2), 'utf8');
  console.log(`\n清单：${manifest}`);
}

console.log(`可导入 ${results.length} 条；跳过 归档 ${skipped.archived.length} / 空会话 ${skipped.empty.length}`);
if (results.length) console.log('下一步：python wbdb.py --apply   （写 WorkBuddy 的 sessions 索引）');
