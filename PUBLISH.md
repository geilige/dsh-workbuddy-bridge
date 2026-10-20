# 发布说明（SkillHub）

## 一、打包

技能文件夹整体打成 zip，`.skill` 后缀只是改名的 zip。排除缓存和临时文件：

```bash
cd ~/.workbuddy && zip -r dsh-workbuddy-bridge-1.0.0.skill skills/session-bridge \
  -x "*/__pycache__/*" "*.pyc" "*/.DS_Store"
```

或直接解压改名即可（`.skill` ⇄ `.zip` 互转）。

## 二、上传

1. WorkBuddy 左侧「技能」→「技能管理」→「上传 / 发布技能」
2. 选 `dsh-workbuddy-bridge-1.0.0.skill`
3. 也可以到 skillhub.cn 右上角「发布 Skill」，选免费版，填信息后提交
4. 审核：平台安全审核 →（企业账号）管理员审核 → 通过后手动「上架」

## 三、审核前要准备的信息

- **技能名 / slug**：`dsh-workbuddy-bridge`
- **显示名称**：DSH 与 WorkBuddy 互通
- **一句话简介**：在 DeepSeek Harness 与 WorkBuddy 之间双向搬运对话记录
- **分类**：效率工具 / 开发工具
- **触发示例**（写 2~3 条用户能直接说的话）：
  1. 「把 DSH 桌面版的对话导入到 WorkBuddy」
  2. 「把这个 WorkBuddy 会话导出到 DSH」
  3. 「DSH 里打开导入的会话报 SessionFormatError，帮我看看」

## 四、审核风险点（提前在说明里写清）

1. **会写两个应用的数据目录**：`~/.workbuddy/workbuddy.db`、`~/.dsh/storages/workspace.json`。
   脚本自带备份，但审核方可能会问「为什么要改数据库」——
   答：应用只认自己的索引表/注册表，不写索引，会话就不会出现在列表里。
2. **依赖本机安装的两个应用**：不装 DSH 或 WorkBuddy 时脚本会直接报错退出，不会误改。
3. **仅 Windows 验证**：macOS 的路径推导未验证，说明里已注明。
4. **无网络请求、无密钥、无遥测**：全部是本地文件读写。

## 五、不想上架时的分发方式

| 方式 | 操作 |
|---|---|
| 直接发 zip | 对方解压到 `~/.workbuddy/skills/`，重启 WorkBuddy |
| GitHub 仓库 | 仓库根目录放 `SKILL.md` + `scripts/`，把地址发给别人 |
| 项目级共享 | 放到仓库的 `.workbuddy/skills/session-bridge/`，团队拉代码即用 |
