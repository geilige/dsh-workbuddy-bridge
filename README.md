# DSH 与 WorkBuddy 互通

把 [DeepSeek Harness](https://deepseek.com)（DSH 桌面版）的对话搬进 WorkBuddy，或者反过来把 WorkBuddy 的会话搬进 DSH。

两个应用各存一套格式，都没有「导入/导出对话」的入口：

| | DSH | WorkBuddy |
|---|---|---|
| 正文 | `session.v4.jsonl.zstd`（**多帧** zstd） | `<uuid>.jsonl`（单文件 JSONL，parentId 串链） |
| 索引 | `~/.dsh/storages/workspace.json` | `~/.workbuddy/workbuddy.db` 表 `sessions` |

这个技能负责格式转换 **+ 写各自的索引**。只转文件不写索引，应用里是看不到的。

## 功能

- **DSH → WorkBuddy**：批量导入，默认跳过已归档会话，写入 `sessions` 表
- **WorkBuddy → DSH**：单条导出，自动挂到对应工作区、退出归档名单
- **体检**：按 DSH 读取器的硬约束逐条校验，不合格不落盘
- **防覆盖**：两个方向遇到同 id 都跳过并提示

## 安装

丢进 WorkBuddy 的技能目录：

```bash
git clone https://github.com/geilige/dsh-workbuddy-bridge.git ~/.workbuddy/skills/session-bridge
```

或者在 SkillHub 里搜「DSH 与 WorkBuddy 互通」一键安装。

**运行要求**：Node ≥ 22.15（`zlib.zstdCompressSync`）、Python 3（只用标准库）。
目前只在 Windows 上验证过。

## 用法

```bash
cd ~/.workbuddy/skills/session-bridge/scripts

node dsh2wb.js --list       # DSH 有哪些会话、哪些已归档
node wb2dsh.js --list       # WorkBuddy 有哪些会话

node dsh2wb.js              # DSH → WorkBuddy（跳过归档）
python wbdb.py --apply      # 写 WorkBuddy 的会话索引

node wb2dsh.js --latest --cwd D:/YourWorkspace   # WorkBuddy → DSH
node verify.js --all        # 按 DSH 读取器规则体检
```

常用参数：

| 参数 | 作用 |
|---|---|
| `--dry` | 空跑，只统计不落盘 |
| `--only <id片段>` | 只处理一条 |
| `--include-archived` | 连 DSH 归档会话一起导（默认不导） |
| `--cwd <路径>` | 指定目标工作区（必须与应用里打开的一致） |
| `--overwrite` / `--new-id` | 目标已存在同 id 时：覆盖 / 另存 |

## 踩过的坑（实现细节）

1. **DSH 的 zstd 是多帧的**，一个事件一帧。Node 的 `zstdDecompressSync` 只解第一帧，解出来永远只有 203 字节的会话头 —— 必须按 magic `28 B5 2F FD` 切帧逐帧解。
2. **归档不等于删除**。DSH 只归档，`~/.dsh/sessions/**` 里混着归档会话；归档名单在 `workspace.json` 的 `global.archivedSessionIds`。
3. **索引里的 `cwd` / `user_id` 必须和当前环境一致**。UI 按「账号 + 工作区」过滤，写错一条都看不到。
4. **DSH 的会话日志有 4 层硬校验**：`surfaceOp:'append'` → 工具生命周期（`tool/call` 必须先由 `assistant/message` 的 `tool-call` 块 announce）→ 消息形状（`message.id`、assistant 的 `provider/model`）→ settlement（`turn`/`step`/`stream`）。少一个就 `SessionFormatError`。
5. **不写 DSH 的 `session_projcache`**。官方文档写明缺失/过期记录会被当作不存在、由日志重建；判断导入是否真的成功，看有没有生成这个缓存文件。

完整踩坑记录见 [docs/迁移笔记.md](docs/迁移笔记.md)。

## 安全提示

脚本会读写 `~/.workbuddy/workbuddy.db` 和 `~/.dsh/storages/workspace.json`，改前自动备份 `*.bak-<时间>`。
不联网、不读密钥、无遥测。

## 许可

MIT
