# dsh-audit

审计 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的会话成本，
**输出结论与可执行处方，而不是一张时间轴。**

> 不是「看 agent 干了什么」，是「哪一步白花了钱，改什么能省回来」。

两种运行方式，同一套分析内核：

| 模式 | 入口 | 数据来源 | 能拿到什么 |
|---|---|---|---|
| **离线 CLI** | `dsh-audit`（随 npm 包安装，1.0.0 起）或 `node bin/dsh-audit.mjs` | 本地 `session.v4.jsonl.zstd` | 事件、provider usage、按字符估算的结果体量 |
| **宿主内插件** | npm 包 `dsh-audit-plugin`（挂载 id `dsh-cost-audit`） | `ctx.sessionQuery` + `ctx.tokenMeter` | 上述全部，外加**平台按实际路由定价的逐节点 token**，以及带「应用此修改」按钮的 Web 报告页 |

---

## 版本与状态

| 项 | 值 |
|---|---|
| 版本 | **1.0.0**（2026-10-22，首个公开发布） |
| npm 包 | `dsh-audit-plugin`（插件挂载条目 id 是 `dsh-cost-audit`） |
| 仓库 | [github.com/Lun-CC/dsh-agent-observability](https://github.com/Lun-CC/dsh-agent-observability)（离线 CLI + 插件 monorepo） |
| Node | `^22.19.0 || >=24`（依赖内置 zstd 解压） |
| DSH | `engines.dsh: >=0.2.0-rc.2`，已在 0.2.0-rc.2 / 0.2.1-rc.2 实测加载 |
| 发布说明 | [`docs/release/2026-10-22-v1.0.0.md`](docs/release/2026-10-22-v1.0.0.md) |
| 发布手册 | [`RELEASE.md`](RELEASE.md)（检查单、精确命令、回滚策略） |
| 变更日志 | [`CHANGELOG.md`](CHANGELOG.md) |

> 仓库已公开：<https://github.com/Lun-CC/dsh-agent-observability>（issue / PR 走 GitHub，
> 私有报告请勿贴真实会话内容）。

1.0.0 的含义是**发布面稳定**：npm 安装链路、报告文件格式（`report-<id>.txt/json`）、
Web 页面路由（`/dsh-cost-audit/*`）、离线 CLI 参数在此后按语义化版本演进。
不稳定的是宿主能力：`ctx.tokenMeter` 属开发者预览服务，宿主 API 变动会影响
「平台定价」区块，插件会降级而不是崩溃（见[兼容范围](#兼容范围)）。

---

## 它不做的事

生态里已经有人把「把事件流画到时间轴上」做完了（`lamost423/dsh-maze`，87★，v1.0.0）。
本工具刻意错开那个位置：

| | 时间轴类工具 | dsh-audit |
|---|---|---|
| 首屏 | 一张长图 | 一句话结论 + 一条可执行修改 |
| 输出 | 发生了什么 | 哪一步无产出、占多少成本、改什么 |
| 用户要做的事 | 自己读懂图，再决定 | 照着改一行配置 / 加三条事实，或直接点按钮 |

理由见 `docs/01-方向脑暴与可行性-v0.3.md`：在这个生态里，每多一层解读成本，受众掉一个数量级。

> **与 npm 上 `dsh-audit` 的区别**：`dsh-audit`（作者 xiaoxiao2026）做的是**插件生态体检**
> （插件健康度、安全扫描、打分），本插件做的是**会话成本审计**（token 花在哪、怎么省）。
> 两者不是一件事，可以同时安装；为避免 loader 条目 id 冲突，本插件挂载 id 是 `dsh-cost-audit`。

---

## 安装

### 从 npm 安装（发布后）

```bash
dsh plugin --profile web add dsh-audit-plugin
```

装完即默认启用，同时得到离线 CLI（包内 `bin` 入口，命令名 `dsh-audit`，1.0.0 起）：

```bash
# 装过插件：CLI 在 profile 的 node_modules/.bin/ 下（pnpm 链入），可直接调用
"${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/.bin/dsh-audit" <会话目录>
# 把该目录加进 PATH 后，可直接：dsh-audit <会话目录>

# 不安装、只想跑一次（发布后）
npx --yes --package=dsh-audit-plugin dsh-audit <会话目录>
```

> `$DSH_HOME` 未设置时默认是 `~/.dsh`（Windows `%USERPROFILE%\.dsh`）；bash 里写
> `${DSH_HOME:-$HOME/.dsh}` 才和默认安装一致，别把裸 `$DSH_HOME` 直接用在 `rm -rf` 里。

> Windows PowerShell 里环境变量写作 `$env:DSH_HOME`，路径写法如
> `"$env:DSH_HOME\profiles\web\node_modules\.bin\dsh-audit" <会话目录>`。

插件是 **bundle 形态**（`package.json` 的 `dsh.bundle.patch` 指向自挂载清单），
`dsh plugin add` 会同时写 `dependencies` 与 `dsh.profile.bundles`，**不要**手工往
`cordis.patch.yml` 里 insert 叶子插件 —— 那样能跑，但插件页里不显示
（`listBundles()` 只枚举 bundle 包，非 bundle 会被标成 `not-bundle`）。

### 本地开发安装

```bash
dsh plugin --profile web add file:<绝对路径>/packages/dsh-audit-plugin
```

`link:` 会在半途失败（写了 manifest 但没落 `node_modules`），用 `file:`。
改了 `src/lib` 之后先跑 `node scripts/sync-core.mjs` 同步内核进插件包，再重启 dsh 生效。

### 升级

```bash
dsh plugin --profile web add dsh-audit-plugin@latest
```

升级后旧报告仍在 `$DSH_HOME/dsh-audit/`。0.8.0 之前的报告只有 `.txt`，
Web 页面读 `.json`；跑一次 `node scripts/backfill-summaries.mjs` 回填（用同一份日志重算，不伪造数字）。

### 卸载

```bash
dsh plugin --profile web remove dsh-audit-plugin
rm -rf "${DSH_HOME:-$HOME/.dsh}/dsh-audit"     # Windows: Remove-Item -Recurse "$env:USERPROFILE\.dsh\dsh-audit"
```

`remove` 会清掉 profile 里的依赖与 bundle 声明；报告目录不会自动删，需要手动清。

---

## 装完首屏能看到什么

1. **Web UI「插件」页 → 已安装**：`dsh-audit-plugin` 可见、默认启用。
2. **右下角「¥ 成本报告」按钮**：点开就是报告页 `http://127.0.0.1:<宿主端口>/dsh-cost-audit/`。
   页面自包含（无外部资源、无 CDN），跟随系统深浅色；左侧按**对话**列出
   （subagent 归到发起它的主会话下），右侧是数字卡片 → 一句话判断 → 建议卡，
   完整报告折叠在 `<details>` 里。
3. **每个 `session/flush` 自动审计**（持久化检查点，覆盖 turn 结束），报告落到
   `$DSH_HOME/dsh-audit/`，不需要手动触发；新装后要等第一个 turn 结束才有第一份报告。
4. **建议可以直接执行**：建议卡右侧「应用此修改」按钮会先给预览（目标文件 + 将写入的片段），
   确认后写入 profile 的 `cordis.patch.yml`（spill 阈值、工具结果裁剪）或项目 `AGENTS.md`
   （读取约定、环境事实），写前备份、可一键撤销。命令行等价：`node scripts/apply-fix.mjs --list`。

输出文件：

```
$DSH_HOME/dsh-audit/latest.txt              最近一次**顶层**会话的完整报告（subagent 不会顶掉它），首行带生成时间
$DSH_HOME/dsh-audit/latest.json             同一份结果的结构化摘要（Web 页面消费）
$DSH_HOME/dsh-audit/report-<sessionId>.txt  按会话归档（subagent 也各有一份）
$DSH_HOME/dsh-audit/report-<sessionId>.json 按会话归档的结构化摘要
$DSH_HOME/dsh-audit/errors.log              仅出错时出现；宿主内绝不向事件链抛异常
$DSH_HOME/dsh-audit/debug-snapshot.json     仅 debugShape: true 时出现，排查完请删除
```

保留策略：最多 `maxReports`（默认 200）份 / 最旧 `maxAgeDays`（默认 7）天，超出自动清理；
`errors.log` 超过 `maxErrorLogBytes`（默认 256 KiB）轮转为 `errors.log.1`。

---

## 用法（离线 CLI）

零依赖、不需要启动 DSH、不需要 API key —— 只读本地已落盘的 `session.v4.jsonl.zstd`。
1.0.0 起 CLI 就打在 npm 包里，命令名 `dsh-audit`（包内 `bin/dsh-audit.mjs` 由
`scripts/sync-core.mjs` 从仓库根的同名文件派生，行为一致）。

装过插件后入口在 profile 的 `node_modules/.bin/dsh-audit`（pnpm 本地链入；不加进 PATH
就写完整路径，或用 `npx --yes --package=dsh-audit-plugin` 前缀）。下文统一写 `dsh-audit`。

```bash
# 三种跑法（任选其一）
dsh-audit ~/.dsh/sessions                                     # 已把 profile 的 .bin 加进 PATH
"${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/.bin/dsh-audit" ~/.dsh/sessions   # 直接给路径
npx --yes --package=dsh-audit-plugin dsh-audit ~/.dsh/sessions         # 不安装（发布后）
node bin/dsh-audit.mjs ~/.dsh/sessions                                 # 仓库内开发

dsh-audit --help                                               # 用法 / 选项 / 退出码
dsh-audit --version                                            # 1.0.0

# 单个会话
dsh-audit ~/.dsh/sessions/<分组目录>/session-xxxx        # 分析一个会话目录

# 直接给 .zstd 文件
dsh-audit ~/.dsh/sessions/.../session.v4.jsonl.zstd

# 整个 sessions 根目录（多会话速览）
dsh-audit ~/.dsh/sessions

# 机器可读
dsh-audit ~/.dsh/sessions --json

# 文本报告工具表只列 5 条（两种写法等价）
dsh-audit ~/.dsh/sessions --tool-limit=5
```

参数：`<session 目录 | 单个文件>`、`--json`、`--tool-limit=<N>` / `--tool-limit N`
（文本报告工具表最多列 N 条，默认 10）、`-h/--help`、`-V/--version`；未知选项报错。
退出码：`0` 至少一个会话成功，`1` 全部失败，`2` 参数错误（缺目标 / 路径不存在 / 选项值非法）。

目标路径可以给 **sessions 根目录、某个分组目录、单个会话目录或单个 `.jsonl.zstd` 文件**：
CLI 向下最多递归 3 层找 `*.jsonl.zstd`，不假设 `sessions/<cwd 分组>/session-<id>/` 的固定
两级结构（拷进来的旧日志、被改名/搬移的会话目录也能扫到）；同一目录有多个日志时取 mtime
最新的那个。路径含中文/空格用引号包住即可；Windows 下把 `~/.dsh` 换成
`$env:USERPROFILE\.dsh`（例如 `dsh-audit "$env:USERPROFILE\.dsh\sessions"`）。

样本输出：`docs/evidence/2026-10-21-真实会话审计报告.txt`。
宿主内样本：`docs/evidence/2026-10-21-宿主内插件报告样本.txt`。

---

## 隐私与数据

报告里会写入：**会话 id、工作目录、事件类型标签、工具名、token 数值**，
以及处方条目里引用的工具调用序号。

**不会**写入：对话正文、工具返回内容的正文、系统提示正文。

两个例外，都能关：

- `debugShape: true` 会把 `readSession` 快照的**首个事件完整 data** 写进 `debug-snapshot.json` ——
  新建会话的首个事件可能是种子消息，**可能含提示词内容**。排查完请立即改回 `false` 并删除该文件。
- `errors.log` 会记录错误堆栈，堆栈里可能含文件路径。

所有输出只写本机 `$DSH_HOME/dsh-audit/`，插件**不发起任何网络请求**，不上传任何数据。
Web 报告页只监听宿主回环端口；页面与查询路由都是只读 GET，唯一的写接口是整改
`POST /dsh-cost-audit/api/fix`（要求 `x-dsh-audit: 1` 自定义头，跨站带不上会先触发 preflight）。

---

## 已知限制

这些是边界，不是待修 bug；写在这里免得被当成故障：

1. **token 口径分离**：账单总额以 `assistant/message.data.usage` 为准；
   `ctx.tokenMeter.measure().totalTokens` **不是账单**（它含完整请求包络，实测
   `totalTokens 10,729` 而 `surfaceTokens 2,512`）。逐节点归因看 `nodes[]`。
2. **`read` 被 `spill-policy` 写死豁免**：源码里 `if (exec.name === 'read') return decision`，
   read 的结果永远不会落盘，调 `maxInlineTokens` 对它**零收益**。所以插件只对非 read 工具
   （pwsh / web_fetch 等）开 spill 处方，read 的大结果改开「先定位、分段读」处方。
3. **compaction 剪掉的节点仍计入 carry**：日志无 compaction 事件时无法校正，
   长会话的滞留成本会偏高。
4. **插件级 schema 归因未实现**：`ctx.tools.register()` 不暴露 `tool → 注册者`，
   只能走 bundle manifest 静态对齐（方案见 `docs/01-*` 第七节）。
5. **token 估算偏保守**：结果体量按字符估算（CJK 1 字 ≈ 1 token），中文场景高估约 10–20%；
   报告里凡估算都标「估算」，不混进实测口径。
6. **「无产出步」只抓工具全失败**，抓不到「工具成功但结果无用」。
7. **空会话 / 中断会话不给处方**：没有模型调用就没有账单，报告会明确说「不产出账单」。
8. **每次 flush 全量重算**：`readSession` + 全量 analyze 是同步 CPU；当前实测量级可接受，
   增量解析需要稳定的 `header.lastSeq` 游标，尚未接入。
9. **`export const Config` 未做**：`@deepseek-ai/schemastery` 在 profile 内解析不到
   （实测 `ERR_MODULE_NOT_FOUND`），所以没有 Web 设置面板，配置只能写在 profile 的
   `cordis.patch.yml` 里（`--dump-config` 可验证）。
10. **`tokenMeter` 缺失时**：插件不会死锁，报告照常产出，但「平台定价」区块标注不可用，
    数字退回 usage + 字符估算口径。
11. **多个 profile 都装了插件时**，自动整改不会替你猜：页面顶部会要求先选择目标 profile
    （命令行等价 `node scripts/apply-fix.mjs ... --profile <name>`），选完才写入。按 mtime
    猜可能写到你没在看的那个环境，所以这条从 1.0.0 起改为显式选择；只装了一个 profile
    时自动使用它，不做兜底猜测。
12. **会话目录是符号链接时不跟随**：扫描用 `withFileTypes` 目录项，符号链接会被当成普通文件跳过
    （防止链接成环无限递归）。需要审计软链目录时，先把真实目录路径直接传给 CLI。

---

## 兼容范围

| 项 | 要求 | 依据 |
|---|---|---|
| Node | `^22.19.0 || >=24` | `packages/dsh-audit-plugin/package.json` 的 `engines.node` |
| DSH | `>=0.2.0-rc.2` | `engines.dsh`；声明后官方忽略 `peerDependencies` 的 `@deepseek-ai/dsh*` 区间，因此只声明它 |
| 必需服务 | `sessionQuery` | `inject: ['sessionQuery']` |
| 可选服务 | `tokenMeter`（开发者预览） | `ctx.get('tokenMeter')` 读取，缺了降级 |
| 包形态 | bundle（`dsh.bundle.patch` + `manifestVersion: 1`） | 非 bundle 在插件页不可见 |
| 平台 | Windows / macOS / Linux | 本机以 Windows + Web/桌面壳为主实测 |
| 默认数据目录 | `$DSH_HOME`，未设置时 `~/.dsh`（Windows `%USERPROFILE%\.dsh`） | 代码 `process.env.DSH_HOME \|\| join(homedir(), '.dsh')` |

`engines.dsh` 只校验**声明过的**兼容区间：宿主 API 有破坏性变更时会被门控提前拦下，
代价是新的宿主版本可能需要显式放宽区间。

---

## 真实数据验证（2026-10-21，本机 5 个会话）

跑在真实日志上，纠正了三个凭文档推不出来的错误假设：

| 假设 | 实测 | 后果 |
|---|---|---|
| `cacheReadTokens / inputTokens` 是命中率 | ❌ 会算出 758% | 恒等式是 `total = input + cacheRead + cacheWrite + output`，`inputTokens` 是**未缓存**部分。命中率分母必须是 `effInput` |
| 工具结果回填是主要成本来源 | ❌ 本样本工具结果仅占体量 5.9% | 「上下文污染」在这类探索型会话里不成立，处方会变成噪音 |
| 缓存未命中是普遍问题 | ❌ 该会话命中率 88.4%（单步 96–98%） | 「缓存税」规则必须带证据才出，否则弃权 |

真正跑出来的第一诊断是另一回事：**9 步里有 2 步工具全失败（4/6 次失败是路径不存在），
这两步占了会话总成本的 20.1%** —— 花的是整步上下文的价格，买到的信息是零。

0.11.0 又用平台自己的 `spill-policy` 代码离线回放了 11 个真实会话 / 343 条工具结果，
证实 `read` 豁免：阈值 12500 时 0 条落盘；阈值 3000 时只有 3 条非 read 结果落盘，
`read` 的两条原样不动（详见 `CHANGELOG.md` 0.11.0）。

这几条都写成了回归测试（`test/metrics.test.mjs` 等），改坏了会红。

---

## 成本归因模型（核心假设，可以被质疑）

1. token 总量是**实测**，来自 `assistant/message.data.usage`（provider 返回）。
2. 工具本身不烧 token；只有它**留在 surface 里的结果**会被后续每次请求重发。
3. `carryTokens(result) = 结果 token 估算 × (lastStep − result.step)`
4. 一步内所有工具调用都失败 → 该步为**无产出步**：付了整步成本，买到零信息。

### 弃权机制

证据不足时规则**主动弃权**并说明原因，而不是硬给一条处方。
弃权记录会打印在报告里，用户能看见我们没说什么。这是为了避免「处方不准 = 噪音」。

---

## 宿主内的硬约束（都是实测踩出来的，不是文档写的）

| 事实 | 后果 |
|---|---|
| 不声明 `inject` 就读不到任何服务 | 直接访问 `ctx.tokenMeter` 抛 `cannot get property "x" without inject`，`inject` 不能是空数组 |
| 想"可选依赖"要用 `ctx.get(name)` | 未注入的服务只能用 `ctx.get()` 读（官方原文：*without the inject requirement*）；可选链 `ctx.x?.y` 救不了 |
| `agent/turn-stopping` 的首参**不是** Session | 官方签名是 `(this: Scoped<Agent>, payload: { agent, turn, signal })`；按 Session 用会静默失效。审计窗口应挂 `session/flush` |
| `session/flush` 的 payload **本身就是 Session** | 不是 `{ session }` 包装，直接传给 `measure()` |
| `readSession()` 返回 `{ session, inheritedEventCount, events }` | 头部在 `session` 上，不叫 `header`；事件流里不含 `session` 类型事件，需合成一条否则报告头显示 `?` |
| `listEvents()` 只返回 `{ sessionId, seq, type, time, surface }` | **没有 `data`**，做分析必须用 `readSession` |
| `measure()` 的 `baseline.kind` 有 `none` / `estimated` / `usage` 三种 | 空会话是 `none`；无成功用量锚点时是 `estimated`；只有 `usage` 才可当实测口径 |
| `measure()` 的 `totalTokens` ≠ 账单 | 实测 `totalTokens` 10729 而 `surfaceTokens` 2512；逐节点 `nodes[]` 才是可用信息 |
| 复制出来的 profile 跑不了模型调用 | 被 `400 Illegal API invocation from an unapproved channel` 拦下 —— 渠道校验按官方客户端，不是凭证问题 |
| 插件页只枚举 **bundle 包** | 叶子插件能跑但页面上不显示；`listBundles()` 会把非 bundle 的选中项标成 `not-bundle` |
| 兼容性只校验**声明过的** `@deepseek-ai/dsh*` peerDependencies | 不声明就永远不被版本区间卡住；代价是 API 破坏性变更时不会提前告警 |

因此插件的定位很明确：**`tokenMeter` 是归因器件，不是计费器件。**
账单总额仍以 `assistant/message.data.usage` 为准；`tokenMeter.nodes[]` 用来回答「这笔钱记在谁头上」。

---

## 目录

```
bin/dsh-audit.mjs                    离线 CLI 入口（真源；sync-core 生成插件包内副本）
packages/dsh-audit-plugin/bin/dsh-audit.mjs  包内 CLI（1.0.0 起随 npm 包发布）
src/lib/session.mjs                  多帧 zstd 解码 + 日志加载 + token 估算
src/lib/analyze.mjs                  度量与归因模型（口径定义都在这里）
src/lib/prescribe.mjs                处方规则 + 弃权机制
src/lib/report.mjs                   文本报告
packages/dsh-audit-plugin/           宿主内插件（lib/core 由 sync-core 生成）
packages/dsh-audit-plugin/lib/webui.mjs   报告页 + 入口按钮
packages/dsh-audit-plugin/lib/fixes.mjs   处方 → 可执行整改
packages/dsh-audit-probe/            侦察插件：dump 服务面、事件负载、measure 返回
scripts/sync-core.mjs                把 src/lib 同步进插件包
scripts/apply-fix.mjs                整改的命令行版
scripts/backfill-summaries.mjs       给旧 .txt 报告补 .json 摘要
test/                                口径 / 插件 / UI / 整改 / CLI / 打包清单 回归测试
docs/reviews/                        发布就绪评审与整改对照
docs/release/                        面向用户的发布说明
docs/evidence/                       实测证据与样本报告
RELEASE.md                           发布手册（维护者用）
```

## 下一步

- [x] 插件化：用 `ctx.sessionQuery` + `ctx.tokenMeter` 取代离线解析
- [x] Web 报告页 + 右下角入口 + 按对话聚合（0.8 / 0.9）
- [x] 处方 → 可执行整改：写 `cordis.patch.yml` / `AGENTS.md`，预览 / 备份 / 撤销（0.10）
- [x] 修正 `read` 豁免导致的假 spill 处方（0.11）
- [x] 离线 CLI 入包：`bin/dsh-audit.mjs` 随 npm 包发布，命令名 `dsh-audit`（1.0.0）
- [ ] 注册 `audit_session` 工具，让 agent 自己也能查（需要先在官方客户端里验证 `ctx.tools.register` 的 `output.render` 契约）
- [ ] 插件级 schema 归因（静态 manifest 对齐）
- [ ] compaction 事件接入后校正 carry 模型
- [ ] 预执行拦截（`tools/pre-execute`）作为处方的执行端，而不只是建议
- [ ] `export const Config` + Web 设置面板（`schemastery` 在 profile 内不可解析，需自带 schema 依赖后再做）
- [ ] 增量解析：按 `header.lastSeq` 缓存，避免每次 flush 全量重算

## 许可

MIT，见 [`LICENSE`](LICENSE)。
