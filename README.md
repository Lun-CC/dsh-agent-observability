# dsh-audit-plugin

让 DeepSeek Harness 的每次对话都留下一份成本账单：花了多少 token、哪一步贵、改什么能省回来。
装好后每个 turn 结束自动审计（只监听 `session/flush`），Web 界面右下角会多一个「¥ 成本报告」入口。

> 它不画时间轴，只回答两个问题：钱花在哪，怎么少花。

## 它能回答什么

- 这次对话实测花了多少 token、多少次请求，平均每步多少
- 哪一步贵：一次性读入大文件、整步空跑、上下文只增不减、工具结果没落盘……
- 每条结论都带证据和置信度；证据不够时插件会明确写「弃权」，而不是硬凑一条建议
- 建议可以直接执行：点按钮写 profile 配置或项目 `AGENTS.md`，有备份、能撤销

和 npm 上另一个 `dsh-audit`（插件生态体检）不是一回事。本插件的挂载 id 是 `dsh-cost-audit`，
避免 loader 条目冲突，两者可以同时装。

## 安装

要求：Node `^22.19.0 || >=24`（用内置 zstd 解压），DSH `>=0.2.0-rc.2`。

```bash
dsh plugin --profile web add dsh-audit-plugin
```

装完在 Web UI 的「插件」页能看到它，默认启用。等当前这轮对话结束，第一份报告就有了。
桌面端同样适用；要装到别的 profile，把 `--profile` 换成对应名字。

也可以在 DSH 的插件市场里搜 `dsh-audit-plugin` 安装。

升级：

```bash
dsh plugin --profile web add dsh-audit-plugin@latest
```

升级后旧报告仍保留在 `$DSH_HOME/dsh-audit/`。

## 用起来

- 右下角「¥ 成本报告」按钮，或直接打开 `http://127.0.0.1:<DSH 端口>/dsh-cost-audit/`
- 首屏三样东西：数字卡片 → 一句话判断 → 建议卡（标签 / 动作 / 怎么改 / 可省多少）
- 左边按对话列出，subagent 挂在发起它的主会话下；完整账单、证据、口径折叠在页面底部
- 页面自包含，不加载外部资源，跟随系统深浅色

不想开页面也可以直接读文件：

```
$DSH_HOME/dsh-audit/latest.txt              最近一次顶层会话的完整报告（首行带生成时间）
$DSH_HOME/dsh-audit/latest.json             同一份结果的结构化摘要（页面用）
$DSH_HOME/dsh-audit/report-<sessionId>.txt  按会话归档（subagent 也各有一份）
$DSH_HOME/dsh-audit/report-<sessionId>.json
$DSH_HOME/dsh-audit/errors.log              只在出错时出现；插件不会把异常抛进事件链
```

`$DSH_HOME` 未设置时默认 `~/.dsh`（Windows 是 `%USERPROFILE%\.dsh`）。脚本里请写
`${DSH_HOME:-$HOME/.dsh}`，不要直接把空变量用在 `rm -rf` 里。

报告默认保留最新的 200 份、最多 7 天，超出自动清理；写盘都是「临时文件 + rename」，
进程被杀不会留下半截文件。

## 离线 CLI

包内自带命令行工具，装完插件后位于 profile 的 `node_modules/.bin/` 下（没加 PATH 就写完整路径）：

```bash
dsh-audit ~/.dsh/sessions/<分组目录>/session-xxxx   # 分析一个会话
dsh-audit ~/.dsh/sessions                            # 整个 sessions 根目录（多会话速览）
dsh-audit ~/.dsh/sessions --tool-limit 5             # 工具表最多列 5 条
dsh-audit ~/.dsh/sessions --json                     # 机器可读
dsh-audit --help
```

目标可以是 sessions 根、分组目录、会话目录或 `.jsonl.zstd` 文件，向下递归三层，不要求固定布局；
路径含中文或空格时用引号包住。退出码：`0` 至少一个会话成功，`1` 全部失败，`2` 参数错误。

不装插件也可以一次性跑：

```bash
npx --yes --package=dsh-audit-plugin dsh-audit <路径>
```

离线 CLI 只看本地已落盘的会话日志，所以没有「平台定价」区块——那部分要靠宿主内的 `ctx.tokenMeter`。

## 一键整改

每条建议右侧有「应用此修改」按钮：先预览（目标文件 + 将写入的片段），确认后才写入。

| 建议 | 改什么 | 落到哪 |
|---|---|---|
| 上下文只增不减 | 启用工具结果裁剪（旧结果只留头尾） | `cordis.patch.yml` → `tool-result-pruner` |
| 工具结果未落盘 | spill 阈值 12500 → 3000（对 `read` 无效） | `cordis.patch.yml` → `spill-policy.maxInlineTokens` |
| 一次性读太多 | 先 glob/grep 定位，超过 300 行分段读 | 项目 `AGENTS.md` |
| 整步空跑 | 写入环境事实（真实 cwd + package.json 里的命令） | 项目 `AGENTS.md` |

缓存失效、静态底噪不给自动方案——硬改配置只会写进一条不生效的东西。

安全约定：

- 只追加带标记的块（`# >>> dsh-cost-audit:<id>` … `# <<<`），不动你已有的任何一行
- 写前备份 `<文件>.bak-<时间戳>`，按钮变成「已应用 · 撤销」后可一键还原
- 幂等，重复点不会重复写
- 配置类改动重启 DSH 后生效，`AGENTS.md` 下一次任务就生效
- 写之前识别编码：`cordis.patch.yml` 或 `AGENTS.md` 不是合法 UTF-8（GBK、UTF-16、带 BOM）时拒绝自动写入
- 多个 profile 都装了本插件时，页面要求先选目标 profile，选之前不写任何文件

## 配置

写在 profile 的 `cordis.patch.yml` 里。profile 目录是 `$DSH_HOME/profiles/<profile>`：

```yaml
- id: dsh-cost-audit
  config:
    minIntervalMs: 3000
    maxReports: 200
```

改完可以用 `dsh --profile web --dump-config` 确认真的进了组装树。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉后插件仍加载，但不产生副作用 |
| `autoReport` | `true` | 每次 `session/flush` 自动写报告 |
| `minIntervalMs` | `3000` | 同一会话两次审计的最小间隔（毫秒），按会话计 |
| `outDir` | `$DSH_HOME/dsh-audit` | 报告输出目录 |
| `maxReports` | `200` | 最多保留多少份会话报告 |
| `maxAgeDays` | `7` | 早于这么多天的报告会被清理 |
| `maxErrorLogBytes` | `262144`（256 KiB） | `errors.log` 轮转阈值，超出改名为 `.1` |
| `debugShape` | `false` | 把 `readSession` 快照结构 dump 到 `debug-snapshot.json`（见隐私） |
| `debugTriggers` | `false` | 每次触发在 `errors.log` 记一行，排查「为什么没出报告」 |
| `ui` | `true` | 是否提供报告页与右下角入口；关掉后仍照常写报告文件 |

## 隐私

报告里会写入：会话 id、工作目录、事件类型标签、工具名、token 数值，以及处方里引用的工具调用序号。

**不会**写入：对话正文、工具返回内容的正文、系统提示正文。

两个例外，都能关：

- `debugShape: true` 会把 `readSession` 快照的首个事件完整 data 写进 `debug-snapshot.json`，
  新建会话的首个事件可能是种子消息，可能含提示词内容。排查完请改回 `false` 并删除该文件。
- `errors.log` 会记录错误堆栈，堆栈里可能含文件路径。

所有输出只写本机 `$DSH_HOME/dsh-audit/`，插件不发起任何网络请求。

## 怎么计数

- 账单总额用 `assistant/message.data.usage`（provider 返回的实测值）
- 逐节点归因用 `ctx.tokenMeter.measure().nodes[]`（平台按路由定价；`tokenMeter` 是开发者预览服务，缺失时降级，不阻塞加载）
- `measure().totalTokens` 不是账单：它含完整请求包络，实测会远大于表面定价
- 工具结果 token 是字符估算（CJK 1 字约 1 token，偏保守），报告里标为「估算」

## 已知限制

- `read` 被 `spill-policy` 写死豁免：调 `maxInlineTokens` 对 `read` 的大结果零收益，
  所以插件只对非 read 工具开 spill 处方，`read` 改开「先定位、分段读」处方
- compaction 剪掉的节点仍计入 carry，长会话的滞留成本会偏高
- 插件级 schema 归因未实现（`ctx.tools.register()` 不暴露工具注册者）
- token 估算在中文场景高估约 10–20%
- 每次 flush 全量重算（同步 CPU），当前量级可接受；增量解析还没做
- 没有 `export const Config`，因此没有 Web 设置面板，配置只能写 `cordis.patch.yml`

## 卸载

```bash
dsh plugin --profile web remove dsh-audit-plugin
```

报告目录不会自动删除，手动清理：

```pwsh
# PowerShell
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\dsh-audit"
```

```bash
# bash
rm -rf "${DSH_HOME:-$HOME/.dsh}/dsh-audit"
```

## 许可

MIT