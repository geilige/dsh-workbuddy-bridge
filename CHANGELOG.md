# Changelog

## 1.0.0 (2026-10-20)

首个可用版本。

- DSH → WorkBuddy：批量导入，默认跳过归档会话，写入 `sessions` 表
- WorkBuddy → DSH：单条导出，注册到工作区，退出归档名单
- `verify.js`：复刻 DSH 读取器的硬约束（surfaceOp、消息形状、settlement、工具生命周期、turn/step 配对）
- 双向同名保护：`--overwrite` / `--new-id`
- 修复四层 `SessionFormatError`：surfaceOp 缺失、工具无 announce、消息缺 id、settlement 缺 stream
