---
name: session-bridge
slug: dsh-workbuddy-bridge
displayName: DSH 与 WorkBuddy 互通
description: 在 DeepSeek Harness（DSH 桌面版）与 WorkBuddy 之间双向搬运会话。用于「把 DSH 对话导入 WorkBuddy」「把 WorkBuddy 会话导出到 DSH」「DSH 会话列表/归档状态查看」「导入后侧栏看不到」「同名会话去重」等场景。支持多帧 zstd 解析、归档会话过滤、会话索引写入、id 冲突保护。
version: 1.0.0
author: 黄兴东
license: MIT
tags: [dsh, deepseek-harness, workbuddy, session, migration, zstd]
---

# DSH ⇄ WorkBuddy 互通

两个应用各存一套会话，格式完全不同。这个技能负责互转，并处理两边索引（不写索引 = 应用里看不到）。

## 目录

| 位置 | 内容 |
|---|---|
| `~/.dsh/sessions/--<cwd slug>--/session-<uuid>/session.v4.jsonl.zstd` | DSH 会话正文（**多帧 zstd**） |
| `~/.dsh/storages/workspace.json` | DSH 注册表：工作区 → 会话、`archivedSessionIds` 归档名单 |
| `~/.dsh/storages/session_projcache/sessions/<id>.json` | DSH 投影缓存（**可缺**，缺了由日志重建） |
| `~/.workbuddy/projects/<slug>/<uuid>.jsonl` | WorkBuddy 会话正文（单文件 JSONL，parentId 串链） |
| `~/.workbuddy/workbuddy.db` 表 `sessions` | WorkBuddy 会话索引（UI 靠它列） |

## 命令速查

脚本都在 `~/.workbuddy/skills/session-bridge/scripts/`。

```bash
# ---- 看 ----
node dsh2wb.js --list        # DSH 会话：id / 是否归档 / 所属工作区 / 大小 / 时间
node wb2dsh.js --list        # WorkBuddy 会话：id / 消息数 / cwd / 标题

# ---- DSH → WorkBuddy ----
node dsh2wb.js --dry                     # 空跑：看会导哪些、跳过哪些
node dsh2wb.js                           # 导全部「非归档、非空」会话
node dsh2wb.js --only 15496ff2           # 只导一条（id 片段即可）
python wbdb.py --apply                   # 写 WorkBuddy 的 sessions 索引（必须做，否则侧栏不显示）

# ---- WorkBuddy → DSH ----
node wb2dsh.js --only dfef09aa --cwd D:/DeepSeekHarnessWork
node wb2dsh.js --latest --dry            # 先空跑看事件数
node wb2dsh.js --only xxx --new-id       # DSH 已有同 id 时另存一条
node wb2dsh.js --only xxx --overwrite    # 强制覆盖同名 DSH 会话

# ---- 校验 ----
node verify.js --all                     # 按 DSH 读取器的硬约束体检全部会话
node verify.js <session.v4.jsonl.zstd>   # 单个

# ---- 维护 ----
python wbdb.py --prune-archived          # 把「DSH 已归档」的导入会话从 WorkBuddy 移除（行 + jsonl 进回收目录）
python wbdb.py --list                    # 看某 cwd 下的会话行
```

## 硬规则（踩过的坑，按此执行）

1. **归档会话默认不导**。DSH 只归档不删除，`~/.dsh/sessions/**` 里混着已归档会话。归档名单在 `workspace.json` 的 `global.archivedSessionIds`（带 `session-` 前缀）。确实要连带归档一起导才加 `--include-archived`。
2. **`cwd` 必须和 WorkBuddy 当前打开的工作区完全一致**（盘符 + 大小写）。UI 按 `user_id + cwd` 过滤，写错一条都看不到。倒推：`~/.workbuddy/projects/d-X/` ↔ `cwd='D:/X'`。
3. **`user_id` 用当前登录账号**，不是随便一个旧账号。取法：`~/.workbuddy/<uuid>/sidebar-list-snapshot.json` 里最新改动的那个目录名（`wbdb.py` 自动识别，也可 `--user` 指定）。
4. **DSH 的 zstd 是多帧的**。`zlib.zstdDecompressSync` / `createZstdDecompress` 只解第一帧，解出来永远只有 203 字节的 session 头。必须按 magic `28 B5 2F FD` 切帧逐帧解（`lib.js` 已实现）。
5. **不写 DSH 投影缓存**。官方文档：`session_projcache` 记录缺失或过期一律视为「不存在」，由读取方从日志重建。所以反向导出只写日志 + 注册表。
6. **`surfaceOp:'append'` 不能漏**。`system/message`、`developer/message`、`user/message`、
   `assistant/message`、`tool/result` 这 5 类必须带顶层 `surfaceOp:'append'`，其它类型**不许**带。
   漏了 DSH 打开就报 `SessionFormatError: user/message surfaceOp requires an object`。
   `wb2dsh.js` 会自动补并在写完后跑 `verify.js`。
7. **同名保护**。两个方向默认遇到同 id **跳过**并提示，绝不静默覆盖：导入方向 `--overwrite` / `--new-id`，导出方向同理。
8. **改库先备份**。`wbdb.py` 用 sqlite backup API 备份 `workbuddy.db`（应用在跑也安全）；`wb2dsh.js` 备份 `workspace.json` 到 `.bak-<时间>`。
9. **导出后要重开应用**。WorkBuddy 侧栏有 `sidebar-list-snapshot.json` 渲染缓存，DSH 启动时读注册表 —— 两者都需要重启才刷新列表。

## 事件映射

| DSH | WorkBuddy |
|---|---|
| `user/message`（`source.kind==='user'`） | `message` / `role:user` / `content[{type:'input_text'}]` |
| `assistant/message` 的 `text` 段 | `message` / `role:assistant` |
| `assistant/message` 的 `reasoning` 段 | `reasoning`（`rawContent[{type:'reasoning_text'}]`） |
| `tool/call` | `function_call`（`arguments` 保持 JSON 字符串） |
| `tool/result` | `function_call_result`（`isError` → `status:'failed'`） |
| `compaction/summary` | assistant 消息，前缀「【DSH 上下文压缩摘要】」 |
| `session/title` | `ai-title`（**侧栏标题读的是这个**，不是 DB 的 `title`） |
| `turn/start` `step/start` `step/end` `turn/end` | 无（导出时按「每条用户消息 = 一个 turn」自动生成） |

反向导出时这些会被丢掉：`session-meta`、`file-history-snapshot`、以及用户消息开头的 `<system-reminder data-role="user-context...">`（WorkBuddy 注入的系统上下文，剥掉后才不会污染 DSH 的对话）。

## 工具生命周期（第二个硬约束）

DSH 的 fold 里有一张 `toolLifecycles` 表，规则是：

1. `assistant/message` 的 `content` 里出现 `{type:'tool-call', id, name, arguments}` 就等于 **announce** 这次调用
2. `tool/call` 必须命中同 id 的 announce，且 `name`、`arguments` **字符串完全相等**，state 要是 `advertised`
3. `tool/result`（`surfaceOp:'append'`）把它删掉
4. `step/end`、`turn/end` 时表必须为空（`assertNoUnresolvedTools`），然后 `step/end` 会清表

所以导出时必须按这个顺序补齐：
```
assistant/message{content:[reasoning?, {type:'tool-call',...}]}   ← announce
  tool/call  →  tool/result                                      ← 同一 step 关掉
step/end → step/start → assistant/message{content:[text]} → step/end → turn/end
```
漏了 announce，DSH 打开报 `tool/call xxx has no advertised tool lifecycle`；step/end 前没关掉，报 `unresolved tool`。

## 消息事件形状（第三个硬约束）

`assertMessageEventShape` 对 5 类消息事件逐条校验：

| 事件 | message 从哪取 | 必需 |
|---|---|---|
| `user/message` | `data` 本身 | `id` 非空、`role:'user'`、`source.kind` 字符串、`content` 数组 |
| `assistant/message` | `data.message` | `id`、`role:'assistant'`、`source:{kind:'model', provider, model}`（provider/model 都要非空）、`content` 数组 |
| `tool/result` | `data.message` | `id`、`role:'tool'`、`source:{kind:'tool', callId}`、`toolCallId === source.callId` |
| `system/message` | `data.message` | `source.kind:'system-prompt'` |
| `developer/message` | `data.message` | — |

少了任何一个，DSH 报 `session event at seq N lacks an identified message` 或 `message has invalid source`。

另外 `assistant/message` / `assistant/attempt` 的 `data` 还要满足 settlement 校验：
`turn`、`step` 必须是非负安全整数，**`stream` 必须存在且是数组**（可以是 `[]`）。
缺 `stream` 报 `has invalid settlement fields`。

## 故障排查

| 现象 | 查什么 |
|---|---|
| WorkBuddy 侧栏没有导入的会话 | `cwd` 是否与当前工作区一致；`user_id` 是否当前账号；是否重启过 |
| DSH 里看不到导出的会话 | `workspace.json` 的 `tables.workspaces[<id>].sessionIds` 是否含该 id；`path` 是否与 cwd 一致 |
| DSH 会话打开是空的 | 删掉 `session_projcache/sessions/<id>.json` 强制重建；再不行用 `node dsh2wb.js --only <id>` 回读验证日志是否可解 |
| 导出的 DSH 会话标题不对 | 改日志末尾 `session/title` 的 `title`，并把缓存文件删掉 |
| DSH 报 `lacks an identified message` / `invalid source` | 消息事件缺 `message.id`，或 assistant 的 `source` 缺 `provider`/`model` |
| DSH 报 `… has no advertised tool lifecycle` | `tool/call` 前面缺 `assistant/message` 的 `tool-call` 块，或 `arguments` 与 announce 不一致；跑 `verify.js` 定位 |
| DSH 报 `… unresolved tool` | `step/end` 前有 `tool/call` 没收到 `tool/result` |
| DSH 报 `SessionFormatError: … surfaceOp …` | 事件漏了 `surfaceOp:'append'`；跑 `node verify.js <文件>` 定位 |
| 两边同 id 冲突 | 导出加 `--new-id` 另存，或 `--overwrite` 覆盖 |

## 环境要求

- Node ≥ 22.15（要 `zlib.zstdCompressSync/zstdDecompressSync`）
- Python 3（只用标准库 `sqlite3`）
- 两个应用都建议**先退出再搬**（写索引不需要退出，但读列表要重启）
