# CHANGELOG

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/) `Major.Minor.Patch`。
`0.1`–`0.3` 为立项论证期（仅文档）；`0.4` 起进入代码实现期，版本号同时覆盖文档与代码。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，分类为：新增 / 修复 / 优化 / 移除。

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
