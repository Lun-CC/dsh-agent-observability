# dsh-audit-plugin

DeepSeek Harness 的**会话级成本审计**插件。每次会话落盘后自动审计，
把 token 花在哪些节点上算清楚，并给出可执行的修改建议。

> 不是画时间轴，是回答「哪一步白花了钱、改什么能省回来」。

**与 `dsh-audit` 的区别**：npm 上的 `dsh-audit`（作者 xiaoxiao2026）做的是
**插件生态体检**（插件健康度、安全扫描、打分），与本插件的
**会话成本审计**（token 花在哪、怎么省）是两件事。为避免 loader 条目 id 冲突，
本插件的挂载 id 是 `dsh-cost-audit`。两者可以同时安装。

---

## 安装

```bash
dsh plugin --profile web add dsh-audit-plugin
```

装完在 Web UI 的「插件」页 →「已安装插件」里可见，默认启用。

本地开发用 `file:`（`link:` 会半途失败：写了 manifest 但没落 `node_modules`）：

```bash
dsh plugin --profile web add file:/绝对路径/packages/dsh-audit-plugin
```

## 卸载

```bash
dsh plugin --profile web remove dsh-audit-plugin
rm -rf "$DSH_HOME/dsh-audit"        # Windows: %USERPROFILE%\.dsh\dsh-audit
```

---

## 输出

```
$DSH_HOME/dsh-audit/latest.txt              最近一次顶层会话的完整报告
$DSH_HOME/dsh-audit/report-<sessionId>.txt  按会话归档（subagent 也各有一份）
$DSH_HOME/dsh-audit/report-<sessionId>.json 同一份结果的结构化摘要（Web UI 消费）
$DSH_HOME/dsh-audit/errors.log              仅出错时出现
```

- `latest.txt` **只由顶层会话写**（`parentId == null`），subagent 的报告不会顶掉主报告
- 首行带 `生成时间`，能判断报告新旧
- 保留策略：最多 `maxReports` 份、最旧 `maxAgeDays` 天，超出自动清理

## Web UI

插件会给宿主 Web 界面加一个入口和一个报告页，**不需要改前端代码**：

```
http://127.0.0.1:<dsh端口>/dsh-cost-audit/
```

- 右下角一个「¥ 成本报告」按钮，点开就是这个页面（`target=_blank`）
- 左侧按**对话**列出（subagent 归到主会话下，不单独占一条）
- 右侧顺序固定：数字卡片 → 一句话判断 → 建议卡（标签 / 动作 / 怎么改 / 可省多少）
- 完整报告（逐步账单、证据、口径）折叠在 `<details>` 里，不占首屏
- 默认选中"有实际请求"的对话：空会话不该占住首屏
- 页面自包含（无外部资源、无 CDN），跟随系统深浅色

实现方式（两种注入通道，覆盖两种宿主形态）：

| 形态 | 通道 | 说明 |
|---|---|---|
| 浏览器打开的 Web UI | `webServer.tapIndex(html => …)` | 直接改写 index.html |
| 桌面壳（Electron） | `webserver/index-inject` 推 `{ kind:'script', text }` 行 | 桌面端 index.html 从安装包静态直出，tapIndex 不生效；`script-src` 加载失败会中断启动，所以用内联 `script` 行 |

`ui: false` 可关掉整个 Web 部分：路由不注册、按钮不注入，插件仍照常写报告文件。

**升级后旧报告不显示？** 0.7.0 之前只写 `.txt`，Web UI 读 `.json`。跑一次回填即可
（用同一份会话日志重算，不伪造数字）：

```bash
node scripts/backfill-summaries.mjs --dry-run   # 先看会写哪些
node scripts/backfill-summaries.mjs
```

### 报告长什么样

```
会话 session-85cd41c9-… · preset standard
工作目录 E:\aibuild
生成时间 2026-10-21T23:22:28.104Z
来源 sessionQuery（宿主内）· 24 事件 · 事件路径 snapshot.events

══ 结论 ══════════════════════════════════════════
实测 119,083 token / 6 次请求，平均每步 19,847 token。最该先改的是「1 步一次性读入大量内容…」

── 1. 1 步一次性读入大量内容，合计 13,732 token 按未缓存全价计价
   ● 高 · 置信度 medium
   …
   → 做什么：先定位再读取：用 glob/grep 拿到结构后只读相关片段

══ 逐步账单（实测）══════════════════════════════
  步   体量    新输入   命中率   输出   工具  失败
  S1    16,257  16,257     0.0%    190     3     0
  …

══ 平台定价（tokenMeter.measure，实测）══════════
baseline.kind = estimated · logRevision 23 · 表面节点 4
表面定价累计 2,512 token（surfaceTokens 2,512，请求压力 10,729）
   1,986     8   系统提示
     392    11   用户消息
```

---

## 配置

写在 profile 的 `cordis.patch.yml` 里（`--dump-config` 可验证是否生效）：

```yaml
- id: dsh-cost-audit
  config:
    minIntervalMs: 5000
    maxReports: 100
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉后插件仍加载，但不产生任何副作用 |
| `autoReport` | `true` | 每次 `session/flush` 自动写报告 |
| `minIntervalMs` | `3000` | 同一会话两次审计的最小间隔，防高频 flush 反复重算 |
| `outDir` | `$DSH_HOME/dsh-audit` | 输出目录 |
| `maxReports` | `200` | 保留策略：最多保留多少份 `report-*.txt` |
| `maxAgeDays` | `7` | 保留策略：早于这么多天的报告会被清理 |
| `maxErrorLogBytes` | `262144` | `errors.log` 轮转阈值，超出改名为 `.1` |
| `debugShape` | `false` | 把 `readSession` 快照结构 dump 到 `debug-snapshot.json`（**见隐私说明**） |
| `debugTriggers` | `false` | 每次触发在 `errors.log` 记一行，用于排查"为什么没出报告" |
| `ui` | `true` | 是否提供 Web 报告页与右下角入口按钮（`/dsh-cost-audit/`） |

---

## 隐私

报告里会写入：会话 id、工作目录、事件类型标签、工具名、token 数值、
以及**处方条目里引用的工具调用序号**。

**不会**写入：对话正文、工具返回内容的正文、系统提示正文。

两个例外，都能关：

- `debugShape: true` 会把 `readSession` 快照的**首个事件完整 data** 写进
  `debug-snapshot.json` —— 新建会话的首个事件可能是种子消息，**可能含提示词内容**。
  排查完请立即改回 `false` 并删除该文件。
- `errors.log` 会记录错误堆栈，堆栈里可能含文件路径。内容不会上传到任何地方，只落本地盘。

所有输出只写本机 `$DSH_HOME/dsh-audit/`，插件**不发起任何网络请求**。

---

## 兼容性

- `engines.dsh: >=0.2.0-rc.2`（已在 0.2.0-rc.2 与 0.2.1-rc.2 上验证加载）
- `engines.node: ^22.19.0 || >=24`
- 依赖服务：`sessionQuery`（必需）、`tokenMeter`（**可选**，属开发者预览）
- 缺 `tokenMeter` 时不死锁：插件照常产出报告，只是平台定价区块标注为不可用，
  数字退回 `assistant/message.usage` + 字符估算口径

> 声明了 `engines.dsh` 之后，官方会**忽略** `peerDependencies` 的 `@deepseek-ai/dsh*` 区间，
> 所以这里只声明 `engines.dsh`，不写 peerDeps。据生态抽样（3,240 个插件），
> 声明 `engines.dsh` 的 781 个正是长期维护的那批。

---

## 口径（重要）

- 账单总额用 `assistant/message.data.usage`（provider 返回，实测）
- 逐节点归因用 `ctx.tokenMeter.measure().nodes[]`（平台按路由定价）
- **`measure().totalTokens` 不是账单**：它含完整请求包络，实测 `totalTokens 10,729` 而 `surfaceTokens 2,512`
- `baseline.kind` 三种取值：`none`（空会话）/ `estimated`（无用量锚点）/ `usage`（有成功调用作锚）
- 工具结果 token 是**字符估算**（CJK 1 字 ≈ 1 token，偏保守），报告里标为「估算」

---

## 触发路径

只监听 `session/flush`。它的官方签名是
`'session/flush'(this: Scoped<Session>, session: Session)`，
载荷本身就是 Session，并在持久化检查点上 awaited 触发，已覆盖 turn 结束。

曾经还挂过 `agent/turn-stopping`，但它的首参是 `{ agent, turn, signal }` 而非 Session，
那条路径**从未触发过审计**（0.7.0 已删除）。这也是为什么本插件用
`session/flush` 而不是"turn 结束时更完整"的直觉写法。

---

## 许可

MIT
