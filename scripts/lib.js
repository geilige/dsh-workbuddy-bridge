'use strict';
/**
 * lib.js —— DSH ⇄ WorkBuddy 会话互转的公共底层
 *
 * 两个存储的事实（2026-10-20 实测）：
 *
 * DSH  ~/.dsh/sessions/--<cwd slug>--/session-<uuid>/session.v4.jsonl.zstd
 *   - **多帧 zstd**：每个事件一帧，Node 的 zstdDecompressSync/createZstdDecompress 只解第一帧
 *     → 必须按 magic 28 B5 2F FD 切帧，逐帧解压，失败就与后一帧合并重试
 *   - 事件：{type, seq, time, data}，seq 单调递增；首行是 {type:'session', version:4, id, createdAt, cwd}
 *   - 归档/注册表：~/.dsh/storages/workspace.json
 *       global.archivedSessionIds[]        ← 归档的会话 id（带 session- 前缀）
 *       tables.workspaces[wid].path/.sessionIds[]  ← 工作区 → 会话
 *   - 投影缓存：~/.dsh/storages/session_projcache/sessions/<id>.json
 *     官方 doc：「A malformed or stale record reads as absent, and consumers that
 *     require a cold value own any log refold」→ 缺了/坏了会被当作不存在并由日志重建，
 *     所以反向导出可以完全不写这个缓存。
 *
 * WorkBuddy  ~/.workbuddy/projects/<slug>/<uuid>.jsonl
 *   - 单文件 JSONL，事件按 parentId 串链
 *   - 索引：~/.workbuddy/workbuddy.db 表 sessions（id/cwd/user_id/title/...）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const HOME_DSH = path.join(os.homedir(), '.dsh');
const HOME_WB = path.join(os.homedir(), '.workbuddy');
const DSH_SESSIONS = path.join(HOME_DSH, 'sessions');
const DSH_REGISTRY = path.join(HOME_DSH, 'storages', 'workspace.json');
const WB_PROJECTS = path.join(HOME_WB, 'projects');
const WB_DB = path.join(HOME_WB, 'workbuddy.db');

// ---------- 通用 ----------
const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJSON = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2), 'utf8');
const ts = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) : '-');
const uid = () => crypto.randomUUID();
const uuidish = () => {
  const h = crypto.randomBytes(8).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7${h.slice(12, 15)}-a${h.slice(15, 18)}-${crypto.randomBytes(6).toString('hex')}`;
};

/** cwd → DSH 会话桶目录名：D:\A\B → --D-A-B-- */
const dshBucket = (cwd) => '--' + cwd.replace(/[:\\/]+/g, '-').replace(/^-+|-+$/g, '') + '--';
/** cwd → WorkBuddy projects 目录名：D:\A\B → d-A-B */
const wbSlug = (cwd) => cwd.replace(/^([A-Za-z]):/, (m, d) => d.toLowerCase()).replace(/[\\/]/g, '-');
const normCwd = (p) => (p || '').replace(/\\/g, '/');

// ---------- DSH 读取 ----------
function decodeZstdFrames(buf) {
  let offs = [];
  let i = 0;
  while ((i = buf.indexOf(MAGIC, i)) !== -1) { offs.push(i); i++; }
  if (!offs.length) return [buf];                       // 未压缩
  const parts = [];
  for (let k = 0; k < offs.length; k++) {
    const s = offs[k];
    let done = false;
    for (let j = k + 1; j <= offs.length && !done; j++) {
      const e = j < offs.length ? offs[j] : buf.length;
      try {
        parts.push(zlib.zstdDecompressSync(buf.subarray(s, e)));
        done = true;
        k = j - 1;
      } catch (_) { /* 合并下一帧重试 */ }
    }
    if (!done) throw new Error('zstd frame decode failed at ' + s);
  }
  return parts;
}

/** 逐帧流式出事件，避免 190MB 会话一次性进内存 */
function* dshEvents(file) {
  const buf = fs.readFileSync(file);
  let rest = '';
  for (const chunk of decodeZstdFrames(buf)) {
    rest += chunk.toString('utf8');
    let idx;
    while ((idx = rest.indexOf('\n')) !== -1) {
      const line = rest.slice(0, idx);
      rest = rest.slice(idx + 1);
      if (!line.trim()) continue;
      try { yield JSON.parse(line); } catch (_) { /* 坏行跳过 */ }
    }
  }
  if (rest.trim()) { try { yield JSON.parse(rest); } catch (_) {} }
}

function dshSessionFiles() {
  const out = [];
  if (!fs.existsSync(DSH_SESSIONS)) return out;
  for (const bucket of fs.readdirSync(DSH_SESSIONS)) {
    const bd = path.join(DSH_SESSIONS, bucket);
    if (!fs.statSync(bd).isDirectory()) continue;
    for (const s of fs.readdirSync(bd)) {
      const f = path.join(bd, s, 'session.v4.jsonl.zstd');
      if (fs.existsSync(f)) out.push({ id: s, bucket, file: f, mtime: fs.statSync(f).mtimeMs });
    }
  }
  return out;
}

/** 注册表：{archived:Set, workspaces:[{id,path,sessionIds}], raw} */
function dshRegistry() {
  const raw = fs.existsSync(DSH_REGISTRY) ? readJSON(DSH_REGISTRY) : { global: {}, tables: { workspaces: {} } };
  const archived = new Set(raw.global?.archivedSessionIds || []);
  const workspaces = Object.entries(raw.tables?.workspaces || {}).map(([id, w]) => ({ id, ...w }));
  return { raw, archived, workspaces };
}

function sessionMeta(file) {
  // 只解第一帧拿 session 头
  const buf = fs.readFileSync(file);
  const s = buf.indexOf(MAGIC);
  if (s < 0) return {};
  const next = buf.indexOf(MAGIC, s + 4);
  try {
    const txt = zlib.zstdDecompressSync(buf.subarray(s, next > 0 ? next : buf.length)).toString('utf8');
    return JSON.parse(txt.split('\n').find((l) => l.trim()));
  } catch (_) { return {}; }
}

// ---------- DSH 写出 ----------
/** 每个事件压成一帧，与 DSH 自己的追加写法一致 */
function writeDshSession(file, events) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const parts = events.map((e) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(e) + '\n', 'utf8')));
  fs.writeFileSync(file, Buffer.concat(parts));
  return fs.statSync(file).size;
}

/** 把会话挂到对应工作区（按 path 匹配，没有就建），并从归档里摘掉 */
function registerDshSession(registry, sessionId, cwd) {
  const w = normCwd(cwd);
  let ws = registry.workspaces.find((x) => normCwd(x.path).toLowerCase() === w.toLowerCase());
  const now = new Date().toISOString();
  if (!ws) {
    const id = uid();
    registry.raw.tables.workspaces[id] = {
      path: cwd.replace(/\//g, '\\'),
      title: path.basename(w) || cwd,
      sessionIds: [sessionId],
      createdAt: now,
      updatedAt: now,
    };
    registry.raw.global.workspaceIds = [...new Set([...(registry.raw.global.workspaceIds || []), id])];
    ws = { id };
  } else {
    const entry = registry.raw.tables.workspaces[ws.id];
    entry.sessionIds = [...new Set([...(entry.sessionIds || []), sessionId])];
    entry.updatedAt = now;
  }
  const arch = registry.raw.global.archivedSessionIds || [];
  registry.raw.global.archivedSessionIds = arch.filter((x) => x !== sessionId);
  return ws.id;
}

function backupDshRegistry() {
  if (!fs.existsSync(DSH_REGISTRY)) return null;
  const dst = `${DSH_REGISTRY}.bak-${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`;
  fs.copyFileSync(DSH_REGISTRY, dst);
  return dst;
}

// ---------- WorkBuddy 读取 ----------
function wbSessionFiles() {
  const out = [];
  if (!fs.existsSync(WB_PROJECTS)) return out;
  for (const slug of fs.readdirSync(WB_PROJECTS)) {
    const d = path.join(WB_PROJECTS, slug);
    if (!fs.statSync(d).isDirectory()) continue;
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith('.jsonl')) continue;
      out.push({ id: f.replace(/\.jsonl$/, ''), slug, file: path.join(d, f), mtime: fs.statSync(path.join(d, f)).mtimeMs });
    }
  }
  return out;
}

function* wbEvents(file) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch (_) {}
  }
}

const stripInjectedContext = (t) => {
  // WorkBuddy 会把 <system-reminder data-role="user-context|additional-data"> 塞进用户消息，
  // 一条消息里可能连着好几个块 —— 循环剥，直到不再以 reminder 开头
  let s = (t || '').trim();
  for (let i = 0; i < 8; i++) {
    const m = s.match(/^<system-reminder[^>]*>[\s\S]*?<\/system-reminder>\s*/);
    if (!m) break;
    s = s.slice(m[0].length);
  }
  if (/^<system-reminder/.test(s)) {          // 没闭合的残块，整段丢掉
    const i = s.indexOf('</system-reminder>');
    s = i >= 0 ? s.slice(i + '</system-reminder>'.length) : '';
  }
  // WorkBuddy 把用户原话包在 <user_query> 里
  const q = s.match(/^<user_query>([\s\S]*)<\/user_query>$/);
  if (q) s = q[1];
  return s.trim();
};

module.exports = {
  MAGIC, HOME_DSH, HOME_WB, DSH_SESSIONS, DSH_REGISTRY, WB_PROJECTS, WB_DB,
  readJSON, writeJSON, ts, uid, uuidish,
  dshBucket, wbSlug, normCwd,
  decodeZstdFrames, dshEvents, dshSessionFiles, dshRegistry, sessionMeta,
  writeDshSession, registerDshSession, backupDshRegistry,
  wbSessionFiles, wbEvents, stripInjectedContext,
};
