# dsh-audit

离线审计 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的会话日志，
**输出结论与可执行处方，而不是一张时间轴。**

> 不是「看 agent 干了什么」，是「哪一步白花了钱，改什么能省回来」。

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
bin/dsh-audit.mjs        CLI 入口
src/lib/session.mjs      多帧 zstd 解码 + 日志加载 + token 估算
src/lib/analyze.mjs      度量与归因模型（口径定义都在这里）
src/lib/prescribe.mjs    处方规则 + 弃权机制
src/lib/report.mjs       文本报告
test/metrics.test.mjs    口径回归测试
docs/                    立项备忘、可行性判定、原始数据、样本报告
```

## 下一步

- [ ] 插件化：包成 DSH bundle，用 `ctx.sessionQuery` + `ctx.tokenMeter` 取代离线解析
- [ ] 插件级 schema 归因（静态 manifest 对齐）
- [ ] compaction 事件接入后校正 carry 模型
- [ ] 预执行拦截（`tools/pre-execute`）作为处方的执行端，而不只是建议

## 许可

MIT
