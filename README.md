# dsh-audit

审计 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的会话成本，
**输出结论与可执行处方，而不是一张时间轴。**

> 不是「看 agent 干了什么」，是「哪一步白花了钱，改什么能省回来」。

两种运行方式，同一套分析内核：

| 模式 | 入口 | 数据来源 | 能拿到什么 |
|---|---|---|---|
| **离线 CLI** | `bin/dsh-audit.mjs` | 本地 `session.v4.jsonl.zstd` | 事件、provider usage、按字符估算的结果体量 |
| **宿主内插件** | `packages/dsh-audit-plugin` | `ctx.sessionQuery` + `ctx.tokenMeter` | 上述全部，外加**平台按实际路由定价的逐节点 token** |

---

## 它不做的事

生态里已经有人把「把事件流画到时间轴上」做完了（`lamost423/dsh-maze`，87★，v1.0.0）。
本工具刻意错开那个位置：

| | 时间轴类工具 | dsh-audit |
|---|---|---|
| 首屏 | 一张长图 | 一句话结论 + 一条可执行修改 |
| 输出 | 发生了什么 | 哪一步无产出、占多少成本、改什么 |
| 用户要做的事 | 自己读懂图，再决定 | 照着改一行配置 / 加三条事实 |

理由见 `docs/01-方向脑暴与可行性-v0.3.md`：在这个生态里，每多一层解读成本，受众掉一个数量级。

---

## 用法

零依赖，Node ≥ 22.15（需要内置 zstd）。

```bash
# 单个会话
node bin/dsh-audit.mjs ~/.dsh/sessions/--E-aibuild--/session-xxxx

# 直接给 .zstd 文件
node bin/dsh-audit.mjs ~/.dsh/sessions/.../session.v4.jsonl.zstd

# 整个 sessions 根目录（多会话速览）
node bin/dsh-audit.mjs ~/.dsh/sessions

# 机器可读
node bin/dsh-audit.mjs ~/.dsh/sessions --json
```

不需要启动 DSH，不需要 API key —— 只读本地已落盘的 `session.v4.jsonl.zstd`。

样本输出：`docs/evidence/2026-10-21-真实会话审计报告.txt`

---

## 在 DSH 内运行（插件）

插件挂在 profile 里，每个 `session/flush` 自动审计当前会话，写到 `$DSH_HOME/dsh-audit/`：

```
$DSH_HOME/dsh-audit/latest.txt              最近一次**顶层**会话的完整报告（subagent 不会顶掉它）
$DSH_HOME/dsh-audit/report-<sessionId>.txt  按会话归档
$DSH_HOME/dsh-audit/errors.log              仅出错时出现，宿主内绝不抛异常
```

报告首行带 `生成时间`；保留策略为最多 200 份 / 最旧 7 天，超出自动清理。
挂载条目 id 是 **`dsh-cost-audit`**（npm 上已有的 `dsh-audit` 是"插件生态体检"，两者不同）。

安装只有一条命令（bundle 形态，`dsh plugin` 会同时写依赖和 `dsh.profile.bundles`）：

```bash
# 本地开发用 file:；发布到 npm 后直接 add dsh-audit-plugin
dsh plugin --profile web add file:/绝对路径/packages/dsh-audit-plugin
```

装完在 Web UI 的**「插件」页 → 已安装**里可见，默认启用，之后每个 turn 自动审计。
本地改了代码需要 `node scripts/sync-core.mjs` 重新同步内核，再重启 dsh 生效。

> 注意：**必须包成 bundle**（`package.json` 里 `dsh.bundle.patch` 指向自挂载清单）。
> 只往 `cordis.patch.yml` 里 insert 一个叶子插件的话，它能跑，但插件页里根本不显示 ——
> `listBundles()` 只枚举 bundle 包，非 bundle 的选中项会被标成 `not-bundle` 报错。
> 这一点是实测确认的，不是推断。

### 宿主内的硬约束（都是实测踩出来的，不是文档写的）

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

**目前只写文件，没有 UI 面板。** 装上后插件页能看到开关，但报告要去 `$DSH_HOME/dsh-audit/` 看。
不加 Web 面板是有意的：插件不碰界面，装坏了也不会把界面搞崩。

宿主内样本：`docs/evidence/2026-10-21-宿主内插件报告样本.txt`

---

## 真实数据验证（2026-10-21，本机 5 个会话）

跑在真实日志上，纠正了三个凭文档推不出来的错误假设：

| 假设 | 实测 | 后果 |
|---|---|---|
| `cacheReadTokens / inputTokens` 是命中率 | ❌ 会算出 758% | 恒等式是 `total = input + cacheRead + cacheWrite + output`，`inputTokens` 是**未缓存**部分。命中率分母必须是 `effInput` |
| 工具结果回填是主要成本来源 | ❌ 本样本工具结果仅占体量 5.9% | 「上下文污染」在这类探索型会话里不成立，处方会变成噪音 |
| 缓存未命中是普遍问题 | ❌ 该会话命中率 88.4%（单步 96–98%） | 「缓存税」规则必须带证据才出，否则弃权 |

真正跑出来的第一诊断是另一回事：**9 步里有 2 步工具全失败（4/6 次失败是路径不存在），这两步占了会话总成本的 20.1%** —— 花的是整步上下文的价格，买到的信息是零。

这几条都写成了回归测试（`test/metrics.test.mjs`，6/6 通过），改坏了会红。

---

## 成本归因模型（核心假设，可以被质疑）

1. token 总量是**实测**，来自 `assistant/message.data.usage`（provider 返回）。
2. 工具本身不烧 token；只有它**留在 surface 里的结果**会被后续每次请求重发。
3. `carryTokens(result) = 结果 token 估算 × (lastStep − result.step)`
4. 一步内所有工具调用都失败 → 该步为**无产出步**：付了整步成本，买到零信息。

### 已知偏差

- 早被 compaction 剪掉的节点仍被计入 carry（日志无 compaction 事件时无法校正）
- token 估算按 CJK 1 字 ≈ 1 token，中文场景高估约 10–20%
- 「无产出步」只抓工具全失败，抓不到「工具成功但结果无用」
- 插件级归因（schema 税）**未实现**：`ctx.tools.register()` 不暴露 `tool → 注册者`，
  只能走 bundle manifest 静态对齐（见 `docs/01-*` 第七节）

### 弃权机制

证据不足时规则**主动弃权**并说明原因，而不是硬给一条处方。
弃权记录会打印在报告里，用户能看见我们没说什么。这是为了避免「处方不准 = 噪音」。

---

## 目录

```
bin/dsh-audit.mjs                    离线 CLI 入口
src/lib/session.mjs                  多帧 zstd 解码 + 日志加载 + token 估算
src/lib/analyze.mjs                  度量与归因模型（口径定义都在这里）
src/lib/prescribe.mjs                处方规则 + 弃权机制
src/lib/report.mjs                   文本报告
packages/dsh-audit-plugin/           宿主内插件（lib/core 由 sync-core 生成）
packages/dsh-audit-probe/            侦察插件：dump 服务面、事件负载、measure 返回
scripts/sync-core.mjs                把 src/lib 同步进插件包
test/                                口径 / 插件 / 适配 三层回归测试
docs/                                立项备忘、可行性判定、实测证据、样本报告
```

## 下一步

- [x] 插件化：用 `ctx.sessionQuery` + `ctx.tokenMeter` 取代离线解析
- [ ] 注册 `audit_session` 工具，让 agent 自己也能查（需要先在官方客户端里验证 `ctx.tools.register` 的 `output.render` 契约）
- [ ] 插件级 schema 归因（静态 manifest 对齐）
- [ ] compaction 事件接入后校正 carry 模型
- [ ] 预执行拦截（`tools/pre-execute`）作为处方的执行端，而不只是建议

## 许可

MIT
