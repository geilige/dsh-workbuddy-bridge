#!/usr/bin/env node
'use strict';
/**
 * verify.js —— 校验一个 DSH 会话日志是否满足 DSH 读取器的硬性约束
 *
 *   node verify.js <session.v4.jsonl.zstd>
 *   node verify.js --all                # 校验 ~/.dsh/sessions 下全部会话
 *
 * 这些约束来自 app.asar 里的校验代码（读日志时直接抛 SessionFormatError）：
 *   - surface-eligible 的事件必须带 surfaceOp:'append'（user/assistant/system/message、tool/result）
 *   - 非 surface-eligible 的事件不许带 surfaceOp
 *   - seq 必须严格递增
 *   - replace 型 surfaceOp 只能引用更早的 seq
 *   - session/title.messageSeqs 必须指向已存在的更早 user/message
 */
const fs = require('fs');
const path = require('path');
const L = require('./lib');

const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result']);

// 真实样本里各类型事件的顶层/data 字段（用于发现漏字段）
const SHAPE = {
  'user/message': { top: ['type', 'seq', 'time', 'data', 'surfaceOp'], data: ['content', 'source', 'role', 'id'] },
  'assistant/message': { top: ['type', 'seq', 'time', 'data', 'surfaceOp'], data: ['turn', 'step', 'message'] },
  'tool/call': { top: ['type', 'seq', 'time', 'data'], data: ['turn', 'step', 'callId', 'name', 'arguments'] },
  'tool/result': { top: ['type', 'seq', 'time', 'data', 'surfaceOp'], data: ['turn', 'step', 'message'] },
  'session/title': { top: ['type', 'seq', 'time', 'data'], data: ['title', 'messageSeqs', 'source'] },
  'turn/start': { top: ['type', 'seq', 'time', 'data'], data: ['turn'] },
  'turn/end': { top: ['type', 'seq', 'time', 'data'], data: ['turn', 'reason'] },
  'step/start': { top: ['type', 'seq', 'time', 'data'], data: ['turn', 'step'] },
  'step/end': { top: ['type', 'seq', 'time', 'data'], data: ['turn', 'step'] },
};

function verify(file) {
  const errs = [], warns = [];
  let evs = [];
  try { evs = [...L.dshEvents(file)]; } catch (e) { return { errs: ['解压/解析失败: ' + e.message], warns }; }
  if (!evs.length) return { errs: ['空日志'], warns };

  const head = evs[0];
  if (head.type !== 'session') errs.push('首行不是 session 头');
  if (head.version !== 4) errs.push('version 不是 4: ' + head.version);
  if (!head.cwd) errs.push('session 头缺 cwd');
  const expectId = 'session-' + path.basename(path.dirname(file)).replace(/^session-/, '');
  if (head.id !== expectId) errs.push(`session.id(${head.id}) 与目录名(${expectId}) 不一致`);

  const seqs = new Set();
  const userSeqs = new Set();
  // 工具生命周期：assistant/message 的 {type:'tool-call'} 块 announce，tool/call 必须匹配，tool/result 关掉
  let lifecycles = new Map();
  const pendingInboxIds = [];
  let prev = -1;
  for (const e of evs.slice(1)) {
    if (typeof e.seq !== 'number') { errs.push(`事件 ${e.type} 缺 seq`); continue; }
    if (e.seq <= prev) errs.push(`seq 未递增：${prev} → ${e.seq}（${e.type}）`);
    prev = e.seq;
    seqs.add(e.seq);

    if (SURFACE_TYPES.has(e.type)) {
      if (e.surfaceOp === undefined) errs.push(`${e.type}@${e.seq} 缺 surfaceOp（DSH 会报 SessionFormatError）`);
      else if (e.surfaceOp !== 'append' && typeof e.surfaceOp !== 'object') errs.push(`${e.type}@${e.seq} surfaceOp 非法`);
    } else if (e.surfaceOp !== undefined) {
      errs.push(`${e.type}@${e.seq} 不是 surface-eligible 却带了 surfaceOp`);
    }
    if (typeof e.surfaceOp === 'object' && e.surfaceOp) {
      if (e.surfaceOp.startSeq >= e.seq || e.surfaceOp.endSeq >= e.seq) errs.push(`${e.type}@${e.seq} replace 引用了更晚的 seq`);
    }

    const sh = SHAPE[e.type];
    if (sh) {
      for (const k of sh.top) if (!(k in e)) errs.push(`${e.type}@${e.seq} 缺顶层字段 ${k}`);
      for (const k of sh.data) if (!(k in (e.data || {}))) errs.push(`${e.type}@${e.seq} 缺 data.${k}`);
    }
    // 消息事件必须带 id / role / source.kind；assistant 还要 provider+model
    if (['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'].includes(e.type)) {
      const msg = e.type === 'user/message' ? e.data : (e.data.message || {});
      const roleOf = { 'system/message': 'system', 'developer/message': 'developer', 'user/message': 'user', 'assistant/message': 'assistant', 'tool/result': 'tool' }[e.type];
      if (typeof msg.id !== 'string' || !msg.id) errs.push(`${e.type}@${e.seq} 缺 message.id（DSH: lacks an identified message）`);
      if (msg.role !== roleOf) errs.push(`${e.type}@${e.seq} message.role=${msg.role}，应为 ${roleOf}`);
      const src = msg.source || {};
      if (typeof src.kind !== 'string' || !src.kind) errs.push(`${e.type}@${e.seq} 缺 message.source.kind`);
      if (!Array.isArray(msg.content)) errs.push(`${e.type}@${e.seq} message.content 不是数组`);
      if (e.type === 'assistant/message' && (src.kind !== 'model' || !src.provider || !src.model)) errs.push(`assistant/message@${e.seq} source 需 kind=model + provider + model`);
      if (e.type === 'assistant/message') {
        if (!Number.isSafeInteger(e.data.turn) || e.data.turn < 0) errs.push(`assistant/message@${e.seq} data.turn 非法`);
        if (!Number.isSafeInteger(e.data.step) || e.data.step < 0) errs.push(`assistant/message@${e.seq} data.step 非法`);
        if (!Array.isArray(e.data.stream)) errs.push(`assistant/message@${e.seq} data.stream 必须是数组（DSH: invalid settlement fields）`);
      }
      if (e.type === 'tool/result' && (src.kind !== 'tool' || !src.callId)) errs.push(`tool/result@${e.seq} source 需 kind=tool + callId`);
    }
    if (e.type === 'user/message') {
      userSeqs.add(e.seq);
      if (e.data.role !== 'user') errs.push(`user/message@${e.seq} data.role=${e.data.role}`);
      if (!Array.isArray(e.data.content)) errs.push(`user/message@${e.seq} content 不是数组`);
    }
    if (e.type === 'assistant/message') {
      const m = e.data.message || {};
      if (m.role !== 'assistant') errs.push(`assistant/message@${e.seq} message.role=${m.role}`);
      if (!Array.isArray(m.content)) errs.push(`assistant/message@${e.seq} message.content 不是数组`);
      for (const b of m.content || []) {
        if (b && b.type === 'tool-call') {
          if (!b.id) errs.push(`assistant/message@${e.seq} tool-call 块缺 id`);
          else if (lifecycles.has(b.id)) errs.push(`assistant/message@${e.seq} 重复 announce ${b.id}`);
          else lifecycles.set(b.id, { name: b.name, arguments: b.arguments, state: 'advertised' });
        }
      }
    }
    if (e.type === 'tool/call') {
      const lc = lifecycles.get(e.data.callId);
      if (!lc) errs.push(`tool/call ${e.data.callId}@${e.seq} 没有 announce（DSH 报 no advertised tool lifecycle）`);
      else if (lc.state !== 'advertised') errs.push(`tool/call ${e.data.callId}@${e.seq} 重复启动`);
      else if (lc.name !== e.data.name) errs.push(`tool/call ${e.data.callId}@${e.seq} name 与 announce 不一致`);
      else if (lc.arguments !== e.data.arguments) errs.push(`tool/call ${e.data.callId}@${e.seq} arguments 与 announce 不一致`);
      else lc.state = 'started';
    }
    // DSH 只对 surfaceOp:'append' 的 tool/result 做生命周期校验；
    // replace 型是改写更早的结果（压缩/截断），不参与
    if (e.type === 'tool/result' && e.surfaceOp === 'append') {
      const cid = ((e.data.message || {}).toolCallId) || '';
      if (!lifecycles.has(cid)) errs.push(`tool/result ${cid}@${e.seq} 没有对应生命周期`);
      else lifecycles.delete(cid);
    }
    if (e.type === 'step/end' || e.type === 'turn/end') {
      for (const [id, lc] of lifecycles) errs.push(`${e.type}@${e.seq} 之前工具 ${id} 未关闭（${lc.state}）`);
      lifecycles = new Map();
    }
    if (e.type === 'tool/result') {
      const m = e.data.message || {};
      if (m.role !== 'tool') errs.push(`tool/result@${e.seq} message.role=${m.role}`);
      if (!m.toolCallId) errs.push(`tool/result@${e.seq} 缺 message.toolCallId`);
    }
    if (e.type === 'agent/inbox/spliced' && Array.isArray(e.data.inserted) && e.data.inserted.length) {
      for (const it of e.data.inserted) {
        if (it && it.role === 'user' && it.id) pendingInboxIds.push(it.id);
      }
    }
    if (e.type === 'user/message') {
      const id = e.data.id;
      const i = pendingInboxIds.indexOf(id);
      if (i >= 0) pendingInboxIds.splice(i, 1);
      else warns.push(`user/message@${e.seq} 的 id 不在之前的 inbox spliced 里`);
    }
    if (e.type === 'session/title') {
      for (const s of e.data.messageSeqs || []) {
        if (!userSeqs.has(s)) warns.push(`session/title 引用了不存在的 user seq ${s}`);
      }
    }
  }

  // turn / step 配对
  let openTurn = null;
  const openStep = new Map();
  for (const e of evs) {
    if (e.type === 'turn/start') openTurn = e.data.turn;
    if (e.type === 'turn/end' && openTurn !== e.data.turn) warns.push(`turn/end ${e.data.turn} 与当前 turn ${openTurn} 不匹配`);
    if (e.type === 'step/start') openStep.set(`${e.data.turn}/${e.data.step}`, true);
    if (e.type === 'step/end' && !openStep.get(`${e.data.turn}/${e.data.step}`)) warns.push(`step/end ${e.data.turn}/${e.data.step} 没有对应的 step/start`);
  }
  return { errs, warns, stats: { events: evs.length, users: userSeqs.size } };
}

module.exports = { verify, SURFACE_TYPES };

if (require.main !== module) return;

const arg = process.argv[2];
let files = [];
if (arg === '--all') files = L.dshSessionFiles().map((f) => f.file);
else if (arg) files = [arg];
else { console.error('用法: node verify.js <file> | --all'); process.exit(2); }

let bad = 0;
for (const f of files) {
  const r = verify(f);
  const tag = r.errs.length ? '✗' : (r.warns.length ? '!' : '✓');
  console.log(`${tag} ${path.basename(path.dirname(f))}  ${JSON.stringify(r.stats || {})}`);
  for (const e of r.errs.slice(0, 8)) console.log('    ERR ', e);
  for (const w of r.warns.slice(0, 4)) console.log('    warn', w);
  if (r.errs.length) bad++;
}
console.log(`\n${files.length} 个文件，${bad} 个不合格`);
process.exit(bad ? 1 : 0);
