# CHANGELOG

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/) `Major.Minor.Patch`。
`0.1`–`0.3` 为立项论证期（仅文档）；`0.4` 起进入代码实现期，版本号同时覆盖文档与代码。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，分类为：新增 / 修复 / 优化 / 移除。

---

## [0.9.0] - 2026-10-21

按用户反馈重做信息架构：**文件继续详细，页面只留能立刻做决定的那些**。

### 变更

- **一次对话 = 一条记录**。之前主会话 + 2 个 subagent 会在列表里平铺成 3 条，
  看着像"同一次对话被分析了三次"。现在按 `parentSession` 归组：列表一条，
  头部显示子会话数，成本求和；子会话明细折叠在下面
- **首屏只有三样东西**：几个数字 → 一句判断 → 几条建议。完整报告（逐步账单、证据、口径）
  折叠进 `<details>`，不再一进来就糊一屏
- **建议改成"标签 + 动作 + 可省"**：每条只留
  `上下文只增不减` / `对长会话启用 compaction…` / `怎么改：在 agent/pre-step 上…` /
  右侧 `可省 1,583,598–3,695,063（10–24%）`。证据和推导留在文件里
- 一句话判断由 UI 现算（与卡片同一分母），不再复用会啰嗦的 `headline`

### 修复

- **`parentSession` 字段名用错（0.7.0 的修复实际没生效）**：会话头里是
  `parentSession` 不是 `parentId`。`isTopLevel()` 用 `header.parentId ?? null` 判空，
  结果**永远成立** → subagent 仍然会顶掉 `latest.txt`，subagent 也被当成独立对话。
  现在两个名字都认
- 汇总占比小于 1% 时显示 `0–0%` → 改显示 `<1%`

### 新增（数据侧）

- 摘要增加 `rootId`（归组依据）、`verdict`（一句话判断）、`prescriptions[]`
  （label / severity / confidence / action / howTo / saving）；`headline` 保留给文件消费者
- `scripts/backfill-summaries.mjs --force`：摘要结构升级后重算历史报告
- 测试 40 → 42；新增"页面内联脚本可被解析"（模板写错会整页白屏，这条能挡住）与对话聚合用例

---

## [0.8.0] - 2026-10-21

Web UI。报告不再只躺在 `$DSH_HOME/dsh-audit/` 里等人去翻 txt ——
插件在宿主端口上开一个页面，并在界面右下角放一个入口。

### 新增

- `lib/webui.mjs`：自包含报告页（无外部资源、跟随深浅色）+ 入口按钮脚本
- 路由（挂在宿主的 `ctx.webServer` 上）：
  - `GET /dsh-cost-audit/` 报告页
  - `GET /dsh-cost-audit/api/list` 报告列表 + latest
  - `GET /dsh-cost-audit/api/report?id=` 单份摘要 + 正文
- 双通道注入入口按钮：
  - 浏览器形态用 `webServer.tapIndex()` 改 index.html
  - 桌面壳形态推 `webserver/index-inject` 的 `{kind:'script', text}` 行
    （桌面端 index.html 静态直出，tapIndex 不生效；`script-src` 加载失败会中断启动，故用内联）
- 每次审计额外写 `report-<id>.json`（结构化摘要，Web UI 直接消费）与 `latest.json`
- `scripts/backfill-summaries.mjs`：给旧版遗留的 `.txt` 报告补 `.json`，
  升级后历史报告也能出现在页面上（同一份日志重算，不伪造数字）
- 配置项 `ui`（默认 `true`），关掉后路由与按钮都不注册，仍照常写文件
- 测试 32 → 40（新增 `test/plugin-ui.test.mjs` 8 条：路由注册、接口形状、
  id 校验、信任栅栏、注入幂等、`ui:false`）

### 修复

- **空会话的结论文案会误导**：`buildHeadline` 对 0 请求会输出
  「未发现结构性浪费」，读起来像"审计通过"。改为「未发生模型调用（空会话或中断会话），
  不产出账单，本次不给处方」
- **信任栅栏过严导致页面打不开**：原先照搬 `Sec-Fetch-Site: cross-site` 一票否决，
  实测把浏览器扩展/程序化打开的标签页也挡在门外（页面只剩一个 `forbidden`）。
  改为：回环 Host 直接放行，仍保留 Origin 同源校验。理由是本插件所有路由都是只读 GET，
  跨站页面读不到响应体（无 ACAO），拒绝它换不来安全性
- 列表页两处数据绑定错误：`totalTokens` 字段不存在（应为 `totals.totalReal`）、
  报告总数恒为 1

### 优化

- 页面默认选中"有实际请求的"报告 —— 空会话值得记录，但不该占住首屏
- 保留策略同时清理 `.txt` 与同名 `.json`，不留半份

---

## [0.7.0] - 2026-10-21

发布就绪整改。按外部评审（`dsh-audit-plugin-review.md`）逐条修 P0 与多数 P1。
其中**一个 P0 是静默失效**：`agent/turn-stopping` 的契约从来就不对，报告全靠 flush 兜着。

### 修复

- **P0-1 `agent/turn-stopping` 载荷契约不符（静默失效）**：首参是
  `{ agent, turn, signal }` 而非 Session，代码却当 Session 用 → 该路径**从未触发过审计**，
  还把 flush 拿到的真实 Session 覆盖掉。已删除该 hook，只保留 `session/flush`
  （官方签名 `'session/flush'(this: Scoped<Session>, session: Session)`，载荷本身即 Session，
  且在持久化检查点上 awaited，已覆盖 turn 结束）
- **P0-4 `latest.txt` 被 subagent 顶掉**：改为仅当 `header.parentId == null && delegationDepth === 0`
  才写 `latest.txt`；subagent 仍各留一份 `report-<id>.txt`
- **P0-4 输出无界**：新增保留策略 `maxReports`（默认 200）/ `maxAgeDays`（默认 7），
  每次审计后按 mtime 清理；`errors.log` 超过 `maxErrorLogBytes` 自动轮转为 `.1`
- **P1-3 非原子写**：所有报告与调试文件改为「临时文件 + rename」，进程被杀不留半截文件
- **P2 空会话误判为"形状未适配"**：`adapter.mjs` 的候选探测从 `length > 0` 改为
  `Array.isArray`，真正 0 事件属合法空会话，不再写 `errors.log` 淹没真错误

### 新增

- **P0-2 兼容门控**：`engines.dsh: >=0.2.0-rc.2`、`engines.node`、`dsh.manifestVersion: 1`。
  声明 `engines.dsh` 后官方会忽略 `peerDependencies` 的 `@deepseek-ai/dsh*` 区间，
  因此只声明它、不写 peerDeps
- **P0-3 许可与随包文件**：仓库根与包内各放 MIT `LICENSE`；`files` 补
  `LICENSE`/`CHANGELOG.md`/`icon`；`scripts/prepare-pack.mjs` 在打包前把根 CHANGELOG
  临时复制进包、`cleanup-pack.mjs` 打包后删除（单一真源，不维护两份）
- **P0-3 显示元数据**：`icon`（128×128 PNG，由 `scripts/make-icon.mjs` 代码生成，可复现）、
  `publishConfig.access: public`
- **P0-5 文档**：插件 README 重写，补配置项表（9 项）、隐私说明（含 `debugShape` 的副作用）、
  兼容版本、卸载方式、示例输出，以及与 npm 上 `dsh-audit`（插件生态体检）的区别
- **P1-5 打包校验**：`scripts/verify-pack.mjs` 静态断言 11 个必需文件齐备、门控字段存在、版本一致；
  挂到插件包 `prepack`
- **P1-6 CI**：`.github/workflows/ci.yml` —— 版本一致性、core 同步无漂移、四组测试、
  打包清单断言、图标可复现（`git diff --exit-code`）
- **测试** 21 → 32：新增 CLI 端到端 4 条（多帧 zstd 解码、口径、处方、空目录退出码）、
  插件新增 7 条（inject 收缩、subagent 不顶 latest、tokenMeter 降级、空会话、保留策略等）

### 修复（规格之外，评审建议反了）

- **P1-1 的"正解"不是把 tokenMeter 从 inject 移走**。按评审建议改成
  `inject: ['sessionQuery']` 后实测发现：报告里平台定价整块消失 —— 因为 Cordis 禁止
  读取未注入的服务（`cannot get property "tokenMeter" without inject`，可选链救不了）。
  那等于废掉插件唯一的差异化能力。正解是 Cordis 的 `ctx.get(name)`
  （原文：*Read a service from the store without the inject requirement*），
  它返回服务或 `undefined`，天然是可选依赖。现为
  `inject: ['sessionQuery']` + `ctx.get('tokenMeter')`，两条需求同时满足。
  真机复验：新会话报告重新出现「平台定价」区块（`baseline.kind = none`，空会话）

### 优化

- 报告头部新增 `生成时间`（ISO 时间戳），用户可判断报告新旧
- 去抖从"全局 3 秒"改为**按会话** `minIntervalMs`，并发会话不会互相吞掉审计
- 新增 `debugTriggers`：每次触发在 `errors.log` 记一行触发路径，用于排查"为什么没出报告"
- CLI：目录识别不再依赖路径里是否含 `session-`（改为探测目录内是否有 `.jsonl.zstd`）；
  所有目标都失败时以非零码退出

### 移除

- 移除 `agent/turn-stopping` 监听（契约不符，且 Agent 在 0.2.1-rc.2 未公开 session 访问器）
- 移除"从 inject 里去掉 tokenMeter"的做法

### 未做（明确延期）

- **P1-2 `export const Config`**：`@deepseek-ai/schemastery` 无法从 profile 解析
  （已实测 `ERR_MODULE_NOT_FOUND`），而第三方插件（如 `billion-context`）的做法是
  自带 `zod` 这类普通依赖、完全不 import 一方包。加硬依赖会抬高 `file:` 安装的失败面，
  且 schema 契约无法在隔离实例里验证。延到 0.8，与「Web 设置面板」一起做
- **P1-4 每 turn 全量重算**：仍是 `readSession` + 全量 analyze。增量解析需要
  `header.lastSeq` 之类的稳定游标，待验证后再改（当前会话到 1,071 事件时同步 CPU 压力可感）
- **P2 最小 UI / 离线 CLI 入包**：`bin/dsh-audit.mjs` 仍未进包，用户拿不到离线 CLI

---

## [0.6.0] - 2026-10-21

分发形态修正。上一版把插件做成了「靠 profile patch 插入的叶子插件」——
能跑，但**在 Web UI 的插件页里根本不显示，也无法被一条命令安装**。
本版改为官方 bundle 形态，并实测验证了整条安装链路。

### 新增

- `packages/dsh-audit-plugin/cordis.patch.yml`：bundle 自挂载清单（`- insert:` 形式）
- `package.json` 增加 `dsh.bundle.patch` 与 `files` 白名单，移除 `private`，描述改中英双语
- `packages/dsh-audit-plugin/README.md`：插件独立说明（安装、输出、口径、依赖取舍）

### 修复

- **插件页不显示**：根因是 `dsh-plugin-manager` 的 `listBundles()` 只枚举 bundle 包
  （`bundleManifest()` 读 `dsh.bundle`），非 bundle 的选中项会被标 `not-bundle`。
  上一版既不是依赖也没进 `dsh.profile.bundles`，因此完全不可见。改为 bundle 形态后实测出现于「已安装」
- **无法一条命令安装**：改为 bundle 后，`dsh plugin --profile web add <pkg>` 会同时
  写 `dependencies` 与 `dsh.profile.bundles`（经 `reconcile`），装完即默认启用

### 优化

- README 安装章节从「复制 + 手工改 patch」简化为一条命令，并保留手工方式作为原理说明
- 明确「只有文件输出、无 UI 面板」是刻意选择，不是缺失

### 实测结论（已写入 README 约束表）

| 事实 | 依据 |
|---|---|
| 插件页只枚举 bundle 包 | `listBundles()` 读 `manifest.dsh.profile.bundles` + `dependencies`，逐项 `bundleManifest()`，缺 bundle 判 `not-bundle` |
| `link:` 协议会半途失败 | 依赖写入 manifest 但未落 `node_modules`，随后 `reconcile` 报 `cannot resolve profile bundle`；改 `file:` 正常 |
| 兼容性只校验声明过的 peerDependencies | `evaluatePluginCompatibility()` 只遍历 `@deepseek-ai/dsh*` 前缀的 peer；未声明直接返回可用，不声明反而不会被版本区间卡住 |

---

## [0.5.0] - 2026-10-21

插件化。新增宿主内运行的 DSH 插件与侦察插件，用一方服务取代离线解析，
并把「平台定价的逐节点 token」接进报告 —— 这是离线 CLI 做不到的部分。

### 新增

- `packages/dsh-audit-plugin/`：真正的 DSH 插件。挂在 `agent/turn-stopping` 与 `session/flush`，
  `readSession()` 取事件、`tokenMeter.measure()` 取平台定价，报告写入 `$DSH_HOME/dsh-audit/`
- `packages/dsh-audit-probe/`：侦察插件。dump 服务方法名、事件负载字段、`measure()` 真实返回
- `lib/adapter.mjs`：把 `readSession` 快照归一成分析内核的输入，并给节点打上「系统提示 / 用户消息 / 工具结果 · read」标签
- `scripts/sync-core.mjs`：把 `src/lib` 同步进插件包（保持单一真源），并校验相对依赖完整性
- 报告新增「平台定价」区块：`baseline.kind`、`logRevision`、逐节点 token 与事件标签
- 证据：`2026-10-21-探针实测记录.jsonl`、`2026-10-21-探针摘要.json`、
  `2026-10-21-readSession形状.json`、`2026-10-21-宿主内插件报告样本.txt`
- 测试 10 → 21（新增插件冒烟 4、适配与端到端 7）

### 修复

- **`inject` 不能为空数组**：Cordis 下未注入的服务读取会抛
  `cannot get property "x" without inject`，首版插件因此拿不到任何服务
- **`session/flush` 的 payload 就是 Session**：首版按 `{ session }` 包装去找，永远拿不到，
  `measure()` 调用不成立
- **`readSession` 的头部字段是 `snapshot.session` 不是 `snapshot.header`**：缺失时报告会话 id 显示成 `?`。
  同时 `analyze()` 改为兼容两种形状（磁盘上的扁平字段 / 宿主内的 `data` 包装）
- **宿主内模式打印了无意义的磁盘统计**（`0 B → 解压 0 B · 0 帧`）：改为打印来源与事件路径
- `plugin.test.mjs` 的 `inject` 断言随实际约束更新（由 `[]` 改为三个必需服务）

### 优化

- 插件全部副作用包在 try/catch，失败只写 `errors.log`，绝不向宿主事件链抛异常
- 同一 turn 内多次 flush 用 `minIntervalMs` 去抖，避免重复计算
- `debugShape` 形状诊断默认关闭（形状已确认），需要时再开

### 移除

- 移除「把插件写成 bundle 清单包」的设想：`dsh.bundle` 是补丁清单层，
  叶子插件只需一个 Cordis 模块 + profile 里一条 `insert` 补丁

### 已知限制

- `ctx.tools.register` 的工具注册**未启用**：需要 `output.render` 的 ContentBlock 契约，
  而本轮测试环境（profile 副本）被
  `400 Illegal API invocation from an unapproved channel` 拦住，无法真机验证
- 宿主内未观测到 `baseline.kind = usage` 的样本：该值需要一次成功的 provider 调用作锚点，
  而渠道校验只在官方客户端实例上通过

---

## [0.4.1] - 2026-10-21

真机验证后修正。用 `dsh web`（workbuddy provider，用户配额）跑了一个 6 步真实任务，
新日志立刻暴露出两处**自指假阳性**和一处误判 —— 都是离线样本里恰好没触发的。

### 修复

- **读取含 `not found` 字样的源码被误判为「读取失败」**：`src/lib/analyze.mjs` 自身含有字面量
  `'path/target not found'`，读它时被自己的内容命中，7 次读取里 3 次被误判失败，
  直接污染了失败率与无产出步判定。改为强模式（`ENOENT` / `找不到路径` 等 OS 措辞）全局匹配、
  弱模式（泛化 `not found`）只在 ≤400 字符的短结果上匹配
- **读取含 `[exit code: N]` 字样的文件被误判失败**：`test/metrics.test.mjs` 里作为测试数据写了
  `[exit code: 1]`。退出码标记改为**只认结果末尾**（shell 包装器是追加在尾部）
- **`context-growth` 把末步误判为上下文膨胀**：答案步会一次性消费前面读到的全部工具结果，
  表现为体量突增（本样本 +13,640）。规则改为排除末步，只统计可持续的增长

### 新增

- `heavy-ingest` 规则：某一步的未缓存输入主要由上一步的工具结果构成 → 提示「先定位再读取」
- 口径补充：工具结果在上一步追加，只在下一步被**首次计价且不享缓存折扣**，这是全价成本的主要入口
- `docs/evidence/2026-10-21-dsh-web实时会话审计报告.txt`：真机会话样本
- 测试 8 → 10，新增两个自指假阳性的回归用例

### 优化

- 失败判定改为三层：`isError` → 末尾退出码 → 短结果文本模式，优先级明确

---

## [0.4.0] - 2026-10-21

方向 A（上下文体检 + 处方）首次落地为可运行工具。零依赖 ESM，Node ≥ 22.15。
在**本机 5 个真实会话日志**上验证，并用实测纠正了三个凭文档推不出的错误假设。

### 新增

- `bin/dsh-audit.mjs`：CLI。接受 session 目录 / `.zstd` 文件 / sessions 根目录，支持 `--json`
- `src/lib/session.mjs`：**多帧 zstd 解码**。DSH 的 `session.v4.jsonl.zstd` 是 append-only
  多帧拼接（实测 46,190 B / 60 帧 / 解压 130,547 B），Node 的 `zstdDecompressSync` 只解第一帧，
  必须按 magic 扫描逐帧解压；帧边界误判时与后续帧合并重试
- `src/lib/analyze.mjs`：度量与归因模型。产出逐步账单（体量 / 新输入 / 命中率 / 输出 / 工具 / 失败）、
  按工具聚合、重复动作识别、上下文增长曲线、无产出步标记
- `src/lib/prescribe.mjs`：6 条处方规则 + **弃权机制**
  （`barren-steps` / `spill` / `repeat-failure` / `cache` / `context-growth` / `static-floor`）
- `src/lib/report.mjs`：文本报告，首屏结论、其次逐步账单、末附口径说明
- `test/metrics.test.mjs`：6 个口径回归测试，全部通过
- `docs/evidence/2026-10-21-真实会话审计报告.txt`：真实会话样本输出
- `README.md`、`.gitignore`、`package.json`

### 修复

- **修正 usage 字段语义**：实测 9/9 步满足 `total = input + cacheRead + cacheWrite + output`，
  即 `inputTokens` 是**未缓存**输入。首版用 `cacheRead / inputTokens` 算命中率，得出 758% 的荒谬值；
  改为 `cacheRead / effInput`，同一会话命中率为 88.4%（单步 96–98%）
- **修正「工具结果回填是主要成本来源」的判断**：该会话工具结果估算仅占体量 5.9%，
  且无单条结果达到 spill 阈值。规则改为先看占比，不足即弃权并说明，不再硬出处方
- **修正失败分类顺序**：`Get-ChildItem` 缺路径同时带「找不到路径」与 `[exit code: 1]`，
  首版按退出码归类，导致处方方向选错（探测 vs 补环境事实）。改为文本证据优先，envShare 由 0.5 升至 4/6，
  处方正确切换到「把环境事实写进 AGENTS.md」
- 修正空会话被当作「分析完成」输出「未发现浪费」的假阳性：无 `assistant/message` 时改为跳过并说明
- 修正测试期望值：汇总命中率分母是**所有步**体量之和，不是单步体量

### 优化

- 报告首屏从「整体 token 数」改为「最该先改的那一条 + 可省区间」
- 处方输出带三要素：做什么 / 怎么做 / 预计省（含口径与上界依据）
- 弃权记录单列一节，让「没说什么」对用户可见

### 移除

- 移除「按 `inputTokens` 计算缓存命中率」的口径
- 移除无证据支撑的「上下文污染是主要成本」的默认叙事

---

## [0.3.0] - 2026-10-21

方向脑暴与可行性判定。把 v0.1 的五个技术未知项从猜测变为查证，并在此基线上批量判定 12 个方向。
新增文档 `docs/01-方向脑暴与可行性-v0.3.md`。

### 新增

- **核实 v0.1 五个未知项，全部有确定答案**：
  事件词汇表（`docs/event-producer-consumer.md`、`docs/agent-lifecycle.md`）、
  session 格式 V4 版本化（`docs/session-format-status.md`）、
  subagent 嵌套（`subagent/start|end` + `traceSession` 递归 lineage）、
  token 逐事件归因（`docs/subsystems/token-meter.md`）、
  历史读取（`docs/subsystems/session-query.md`）
- 平台能力清单：可 deny/transform 的瀑布扩展点（`tools/pre-execute` 等 10 个）、
  `ctx.tokenMeter.measure()` 返回 `TokenSurfaceNode{seq, tokens}` 逐事件定价、
  `ctx.sessionQuery` 四接口 + SQLite 全文检索、`ctx.otel` 双通道、spill `maxInlineTokens`、
  compaction 双触发链（`agent/pre-step` 压力 / `agent/request-error` 溢出）
- 12 个方向的"存在 / 可行 / 受众"三关判定表
- 决赛者对比：A 上下文体检 + 处方、B 预执行拦截、C 压缩审计
- 推荐形态"账单 + 处方"：四条上下文污染路径 × 可测依据 × 处方
- 核实 `ctx.tools.register(definition) => disposer` 无 `tool → 注册者` 查询接口，
  确立插件归因只能走 bundle manifest 静态对齐（第七节）
- 新识别竞品：Zoria-Lind/dsh-token-optimizer(20★)、dream12347/dsh-session-manager(90★)、JingxuanC/causal-memory(99★)

### 修复

- 修正 v0.1 "token 归因是最难的技术活"——`ctx.tokenMeter` 已提供逐事件定价，数据层免费
- 修正 v0.1 护城河假设"得真读懂 ctx 和事件流，抄不走"——数据管道已被平台商品化，可抄；
  真护城河只剩分摊模型与处方库
- 修正隐含假设"插件只能监听"——瀑布可 deny / transform，拦截是合法能力

### 优化

- 把 v0.2 的"解读成本 ⇒ 受众递减"从观察升级为可复用的淘汰工具，本轮据此淘汰 4 类方向

### 移除

- 移除"轨迹时间轴可视化"作为独立方向（dsh-maze 87★ 全覆盖）
- 移除"成本展示"作为独立方向（数据层免费 + dsh-cost-meter 481★ 上限）
- 移除"回放实验台"（与官方 resume/fork/search/replay 重复）
- 移除"会话回归检测"（与 maze 多会话对比重叠，且需稳定基准任务）

---

## [0.2.0] - 2026-10-21

数据核验修订版。对 v0.1 的市场分析做根基性更正。

### 修复

- **修正核心前提**：v0.1 称"两万多仓库里没有一个像样的轨迹复盘工具"，核验后不成立。
  `topic:dsh-plugin` 下 trajectory 语义仓库 44 个，6 个直接竞品，
  `lamost423/dsh-maze`(87★) 已发 v1.0.0、上 npm、覆盖 v0.1 全部三个候选维度
- **修正因果倒置**：v0.1 认为"上下文类项目星少是因为做的人少、被发现得少"。
  实际原因是受众规模——每多一层解读成本，受众掉一个数量级
- **修正验收标准**：v0.1 以"有人提 issue"为成功标志，但主仓库 `has_issues: false`，只开 Discussions
- 修正 `topic:dsh-plugin` 计数 21,296 → 21,304
- 修正 DSH 星数 256,483 → 256,492

### 新增

- `docs/evidence/2026-10-21-github-核验数据.md`：全部核验原始数据，可复现
- 赛道天花板表（六档维度 × 该维度最高星），确立"解读成本 ↑ ⇒ 受众 ↓"经验规律
- 星速数据：`dsh-our-free-model` ≈1,195 星/天、`dsh-ops` ≈275 星/天，
  指向发布时机与分发渠道而非实现深度决定声量
- 新识别竞品 6 个：dsh-maze(87★)、dsh-cost-meter(481★)、unStone/dsh-xray(7★)、
  cc-safety-net(1,716★)、flameox(218★)、dsh-trail(6★)
- 决策分岔"作品 or 产品"及其对方案选型的对照表（v0.2 第 6 节）
- 归因方向 (b)：首个不可逆分叉点检测 + 前缀归因，作为唯一同时具备市场空间与智识含量的候选
- 验证主仓库 `has_issues=false` / `has_discussions=true` / `subscribers=1,083`

### 优化

- 第五节的三个判断题从"三选一"改为带真实数据的版本
- 风险 3"方向被抄的速度可能很快"由推测升级为事实

### 移除

- 移除 "trajectory 分析是空白" 的整段论证
- 移除 "插件安全审计是空白"（dsh.so 平台自带扫描 + 4 个竞品）
- 移除 "多 profile 成本归因是空白"（4 个竞品）
- 移除命名首选 `dsh-xray`（GitHub 5 处占用，语义亦被 unStone/dsh-xray 占据）
- 移除"皮肤宠物 3,000 星起步说明上下文管理被低估"这一推论

---

## [0.1.0] - 2026-10-21

初版立项备忘。提出 DSH 轨迹分析插件方向，含市场概览、五个候选空白、
技术机制推测、风险评估、语言选型取舍、协作原则、三个开工判断题、命名候选。

> v0.1 未落盘为独立文件，其内容由 v0.2 第 1 节的核验表与第 8 节的变更记录留存。
