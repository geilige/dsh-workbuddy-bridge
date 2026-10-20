#!/usr/bin/env node
'use strict';
/**
 * wb2dsh.js —— WorkBuddy 会话 → DSH
 *
 *   node wb2dsh.js --list                        # 列 WorkBuddy 会话
 *   node wb2dsh.js --latest                      # 最近一条导到 DSH
 *   node wb2dsh.js --only dfef09aa --cwd D:/DeepSeekHarnessWork
 *   node wb2dsh.js --only dfef09aa --dry         # 只算不写
 *
 * 写出：
 *   ~/.dsh/sessions/--D-X--/session-<uuid>/session.v4.jsonl.zstd   （每事件一帧）
 *   ~/.dsh/storages/workspace.json                                  （挂到工作区 + 取消归档）
 * 不写 session_projcache：官方文档写明「缺失/过期记录视为不存在，由读取方从日志重建」。
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
const LATEST = has('latest');
const ONLY = arg('only', null);
const FORCE_CWD = arg('cwd', null);
const TZ = 'Asia/Shanghai';

const files = L.wbSessionFiles();

if (LIST) {
  const rows = files.map((f) => {
    let cwd = '', title = '', nMsg = 0, last = 0;
    for (const o of L.wbEvents(f.file)) {
      if (o.cwd && !cwd) cwd = L.normCwd(o.cwd);
      if (o.type === 'ai-title') title = o.aiTitle || title;
      if (o.type === 'message') { nMsg++; last = o.timestamp || last; }
    }
    return { id: f.id, cwd, title, nMsg, last: last || f.mtime, kb: Math.round(fs.statSync(f.file).size / 1024) };
  }).sort((a, b) => b.last - a.last);
  console.log('ID'.padEnd(40), '消息', '大小', ' 最后活动     ', '工作区 / 标题');
  for (const r of rows) {
    console.log(r.id.padEnd(40), String(r.nMsg).padStart(4), (r.kb + 'KB').padStart(7), L.ts(r.last), ' ', (r.cwd || '-').slice(-24), '|', (r.title || '').slice(0, 28));
  }
  console.log(`\n共 ${rows.length} 条（.workbuddy/projects/**）`);
  process.exit(0);
}

let target;
if (ONLY) target = files.find((f) => f.id.startsWith(ONLY)) || files.find((f) => f.id.includes(ONLY));
else if (LATEST) target = files.slice().sort((a, b) => b.mtime - a.mtime)[0];
if (!target) { console.error('找不到会话，用 --list 看 id'); process.exit(2); }

// ---------- 读 WorkBuddy 事件 ----------
const events = [...L.wbEvents(target.file)];
let cwd = FORCE_CWD ? L.normCwd(FORCE_CWD) : '';
let title = '';
let createdAt = 0;
for (const o of events) {
  if (!cwd && o.cwd) cwd = L.normCwd(o.cwd);
  if (o.type === 'ai-title' && o.aiTitle) title = title || o.aiTitle;
  if (!createdAt && o.timestamp) createdAt = o.timestamp;
}
if (!cwd) cwd = L.normCwd(process.cwd());

const seqStart = [];
const out = [];
let seq = 0;
const emit = (type, time, data) => {
  const ev = { type, seq: seq++, time, data: data === undefined ? {} : data };
  out.push(ev);
  return ev;
};

const SID = 'session-' + target.id;
const winCwd = cwd.replace(/\//g, '\\');
out.push({ type: 'session', version: 4, id: SID, createdAt: createdAt || Date.now(), cwd: winCwd, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' });
emit('permission/preset', createdAt, { preset: 'workspace-write' });
emit('sandbox/mode', createdAt, { mode: 'workspace-write' });
emit('approval/policy', createdAt, { policy: 'ask' });

let turn = 0, step = 0, stepOpen = false, inTurn = false;
let pendingReasoning = '';
let firstUserSeq = null;
let nU = 0, nA = 0, nC = 0, nR = 0, nRes = 0;

const openStep = (time) => {
  step++;
  emit('step/start', time, { turn, step });
  stepOpen = true;
};
const closeStep = (time) => {
  if (!stepOpen) return;
  emit('step/end', time, { turn, step });
  stepOpen = false;
};
const closeTurn = (time) => {
  closeStep(time);
  if (inTurn) emit('turn/end', time, { turn, reason: { kind: 'completed' } });
  inTurn = false;
};
const openTurn = (time, userText) => {
  turn++;
  step = 0;
  const rid = L.uid();
  const mid = L.uid();            // 收件箱条目和 user/message 必须同 id，DSH 才对得上
  if (userText !== null) {
    emit('agent/inbox/spliced', time, {
      target: 'next-turn', start: 0,
      inserted: [{ content: [{ type: 'text', text: userText }], source: { kind: 'user', rpcId: rid, clientTimeZone: TZ }, role: 'user', id: mid }],
    });
  }
  emit('turn/start', time, { turn });
  if (userText !== null) emit('agent/inbox/spliced', time, { target: 'next-turn', start: 0, removedCount: 1, inserted: [] });
  openStep(time);
  if (userText !== null) {
    const ev = emit('user/message', time, {
      content: [{ type: 'text', text: userText }],
      source: { kind: 'user', rpcId: rid, clientTimeZone: TZ },
      role: 'user', id: mid,
    });
    if (firstUserSeq === null) firstUserSeq = ev.seq;
    nU++;
  }
  inTurn = true;
};

// 工具生命周期：DSH 要求 tool/call 必须由同一 step 内更早的 assistant/message
// 的 content[{type:'tool-call', id, name, arguments}] 「announce」，且 step/end 前必须被 tool/result 关掉。
let callQueue = [];
let callIndex = new Map();

const flushCalls = (time) => {
  if (!callQueue.length) return;
  if (!inTurn) openTurn(time, null);
  if (!stepOpen) openStep(time);
  const content = [];
  if (pendingReasoning) { content.push({ type: 'reasoning', text: pendingReasoning }); pendingReasoning = ''; }
  for (const c of callQueue) content.push({ type: 'tool-call', id: c.callId, name: c.name, arguments: c.arguments });
  emit('assistant/message', time, { turn, step, message: { role: 'assistant', id: L.uid(), content, source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' } } });
  for (const c of callQueue) {
    emit('tool/call', time, { turn, step, callId: c.callId, name: c.name, arguments: c.arguments });
    const r = c.result;
    emit('tool/result', time, {
      turn, step,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId: c.callId },
        toolCallId: c.callId,
        content: [{ type: 'text', text: r ? r.text : '（迁移：原始会话没有记录这次工具调用的结果）' }],
        isError: r ? r.isError : true,
        id: L.uid(),
      },
      ...(r && r.isError ? { error: { name: 'ToolError' } } : {}),
    });
    nC++;
    if (r) nRes++;
  }
  callQueue = [];
  callIndex.clear();
  closeStep(time);
};

for (let ei = 0; ei < events.length; ei++) {
  const o = events[ei];
  const time = o.timestamp || createdAt || Date.now();
  if (o.type === 'reasoning') {
    const t = (o.rawContent || []).map((x) => x.text || '').join('\n').trim();
    if (t) { pendingReasoning += (pendingReasoning ? '\n' : '') + t; nR++; }
    continue;
  }
  if (o.type === 'message' && o.role === 'user') {
    const t = L.stripInjectedContext((o.content || []).map((c) => c.text || '').join('\n'));
    if (!t) continue;                                  // 纯系统注入，丢掉
    flushCalls(time);
    closeTurn(time);
    openTurn(time, t);
    pendingReasoning = '';
    continue;
  }
  if (o.type === 'message' && o.role === 'assistant') {
    const t = (o.content || []).map((c) => c.text || '').join('\n').trim();
    if (!inTurn) openTurn(time, null);
    flushCalls(time);
    if (!stepOpen) openStep(time);
    const content = [];
    if (pendingReasoning) { content.push({ type: 'reasoning', text: pendingReasoning }); pendingReasoning = ''; }
    if (t) content.push({ type: 'text', text: t });
    if (content.length) {
      emit('assistant/message', time, { turn, step, message: { role: 'assistant', id: L.uid(), content, source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' } } });
      nA++;
    }
    // 后面紧跟工具调用 → 同一个 turn 继续跑下一个 step；否则这个 turn 收尾
    const nxt = events.slice(ei + 1).find((x) => x.type === 'message' || x.type === 'function_call' || x.type === 'function_call_result');
    if (nxt && nxt.type === 'function_call') { closeStep(time); openStep(time); }
    else closeTurn(time);
    continue;
  }
  if (o.type === 'function_call') {
    if (!inTurn) openTurn(time, null);
    const callId = o.callId || L.uid();
    const args = typeof o.arguments === 'string' ? o.arguments : JSON.stringify(o.arguments || {});
    const c = { callId, name: o.name || 'tool', arguments: args, result: null, time };
    callQueue.push(c);
    callIndex.set(callId, c);
    continue;
  }
  if (o.type === 'function_call_result') {
    const c = callIndex.get(o.callId);
    if (!c) continue;                                  // 没有对应 call 的孤儿结果，丢掉
    c.result = { text: (o.output && o.output.text) || '', isError: o.status === 'failed' };
    continue;
  }
}

flushCalls(createdAt || Date.now());
if (pendingReasoning && inTurn) {
  if (!stepOpen) openStep(createdAt || Date.now());
  emit('assistant/message', createdAt || Date.now(), {
    turn, step,
    message: { role: 'assistant', id: L.uid(), content: [{ type: 'reasoning', text: pendingReasoning }], source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' } },
  });
  pendingReasoning = '';
}
closeTurn(createdAt || Date.now());

if (!title) {
  const firstUser = events.find((o) => o.type === 'message' && o.role === 'user');
  title = firstUser ? L.stripInjectedContext((firstUser.content || []).map((c) => c.text || '').join('')).split('\n')[0].slice(0, 40) : 'WorkBuddy 会话导入';
}
emit('session/title', createdAt || Date.now(), { title, messageSeqs: firstUserSeq ? [firstUserSeq] : [], source: { kind: 'fallback' } });
out.push({ type: 'session/end-seed', seq: seq++, time: Date.now(), data: {} });

// surface-eligible 的事件必须带 surfaceOp:'append'，否则 DSH 报
// SessionFormatError: user/message surfaceOp requires ...（读日志时直接失败）
const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result', 'system/message']);
for (const e of out) {
  if (SURFACE_TYPES.has(e.type)) e.surfaceOp = 'append';
  // assistant/message 的 settlement 校验要求 data.stream 必须是数组（可空）
  if (e.type === 'assistant/message' && !Array.isArray(e.data.stream)) e.data.stream = [];
}

// ---------- 落盘 ----------
const OVERWRITE = has('overwrite');
const NEW_ID = has('new-id');
let sid = SID;
if (fs.existsSync(path.join(L.DSH_SESSIONS, L.dshBucket(cwd), sid, 'session.v4.jsonl.zstd'))) {
  if (NEW_ID) {
    sid = 'session-' + L.uid();
    out[0].id = sid;
  } else if (!OVERWRITE) {
    console.error(`DSH 里已存在 ${sid}（多半就是从 DSH 导过来的那条）。`);
    console.error('  要覆盖原会话加 --overwrite；要另存一条加 --new-id。');
    process.exit(3);
  }
}
const dshFile = path.join(L.DSH_SESSIONS, L.dshBucket(cwd), sid, 'session.v4.jsonl.zstd');
const summary = { id: sid, wbId: target.id, cwd, title, events: out.length, user: nU, assistant: nA, tool: nC, reasoning: nR, file: dshFile };

if (DRY) {
  console.log('DRY', JSON.stringify(summary, null, 2));
  process.exit(0);
}

const reg = L.dshRegistry();
const bak = L.backupDshRegistry();
const bytes = L.writeDshSession(dshFile, out);
const wsId = L.registerDshSession(reg, sid, cwd);
L.writeJSON(L.DSH_REGISTRY, reg.raw);

// 落盘后立刻跑一遍 DSH 读取器的硬约束校验（surfaceOp / seq / 字段）
const v = require('./verify').verify(dshFile);
if (v.errs.length) {
  console.error(`\n✗ 校验不通过（DSH 打开会报 SessionFormatError）：`);
  for (const e of v.errs.slice(0, 10)) console.error('   ', e);
  process.exit(4);
}
console.log(`  校验   通过（${v.stats.events} 事件 / ${v.stats.users} 条用户消息${v.warns.length ? '，' + v.warns.length + ' 条 warn' : ''}）`);

const stateDir = path.join(L.HOME_WB, 'session-bridge');
fs.mkdirSync(stateDir, { recursive: true });
const mapFile = path.join(stateDir, 'exported-to-dsh.json');
let map = [];
try { map = JSON.parse(fs.readFileSync(mapFile, 'utf8')); } catch (_) {}
map = map.filter((x) => x.id !== sid).concat([{ ...summary, bytes, workspaceId: wsId, at: Date.now() }]);
fs.writeFileSync(mapFile, JSON.stringify(map, null, 2), 'utf8');

console.log(`✓ 已导出到 DSH`);
console.log(`  会话   ${sid}`);
console.log(`  标题   ${title}`);
console.log(`  cwd    ${cwd}`);
console.log(`  事件   ${out.length}（user ${nU} / assistant ${nA} / tool ${nC} / reasoning ${nR}）`);
console.log(`  文件   ${dshFile}  ${(bytes / 1048576).toFixed(2)}MB`);
console.log(`  注册   workspace ${wsId}`);
if (bak) console.log(`  备份   ${bak}`);
console.log(`\n重开 DSH 桌面版即可看到；投影缓存不写，DSH 会自己从日志重建。`);
