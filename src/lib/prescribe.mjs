/**
 * 处方引擎：把度量结果变成「结论 + 可执行修改」。
 *
 * 设计原则（针对 v0.3 记下的风险「处方不准就是噪音」）：
 *   1. 每条处方必须带证据（具体 seq、具体数字），否则不出。
 *   2. 证据不足时**明确弃权**并说明原因，不猜。弃权记录进 notes，用户能看见我们没说什么。
 *   3. 省下的量一律给区间和口径（实测 / 估算），不给单一确定数字。
 *   4. 规则按「先看结构性问题、再看体量性问题」排序 —— 无产出步比省几个 token 重要得多。
 */

const MIN_RESULT_TOKENS = 2000; // 单条工具结果的估算 token 超过此值，才谈 spill
const MIN_CARRY_STEPS = 2;
const RESULT_SHARE_FLOOR = 0.05; // 工具结果占实测上下文体量低于 5%，认为"不是成本来源"
const CACHE_HIT_FLOOR = 0.5;
const GROWTH_RATIO_FLOOR = 1.8;

const fmt = (n) => Math.round(n).toLocaleString('en-US');
const pct = (x) => `${(x * 100).toFixed(1)}%`;

export function prescribe(model) {
  const out = [];
  const notes = [];
  const { totals, calls, repeats, growth, system, steps } = model;

  // ── R1 无产出步：整步工具全失败，付了整步成本，买到零信息 ──────────────
  const barren = steps.filter((s) => s.barren);
  if (barren.length) {
    const cost = totals.barrenCostEst;
    const detail = barren.slice(0, 3).map((s) => {
      const fails = calls.filter((c) => c.step === s.step && c.failure);
      const why = [...new Set(fails.map((f) => f.failure))].join(' / ');
      return `T${s.turn}S${s.step} · ${s.toolCalls} 次调用全部失败（${why}）· 该步 ${fmt(s.stepCost)} token · seq ${fails.map((f) => f.seq).join(', ')}`;
    });

    // 失败原因是否集中在"目标不存在"这类环境事实缺失上
    const envMiss = calls.filter((c) => c.failure === 'path/target not found').length;
    const envShare = totals.failedCalls > 0 ? envMiss / totals.failedCalls : 0;

    out.push({
      id: 'barren-steps',
      severity: barren.length >= 2 || cost / Math.max(1, totals.stepCostReal) > 0.15 ? 'high' : 'medium',
      title: `${barren.length} 步完全无产出（工具全失败），占会话总成本 ${pct(cost / Math.max(1, totals.stepCostReal))}`,
      finding: `这 ${barren.length} 步发起了 ${barren.reduce((a, s) => a + s.toolCalls, 0)} 次工具调用，全部失败，没有带回任何新信息，但每一步都付了完整上下文的价格。${
        envShare > 0.5 ? `失败集中在「目标不存在」（${envMiss}/${totals.failedCalls}），属于环境事实缺失，不是模型判断失误。` : ''
      }`,
      evidence: detail,
      prescription: {
        action:
          envShare > 0.5
            ? '把项目路径、入口文件、可用命令这类环境事实写进 AGENTS.md，让 agent 第一次就不必试探'
            : '在执行前加一步廉价探测（列目录 / 确认命令存在），避免整步投入后才发现前提不成立',
        howTo:
          envShare > 0.5
            ? '在 AGENTS.md 里给出「本仓库根目录 / 构建命令 / 日志位置」三行事实；这些内容进 system prompt 后随缓存复用，几乎零边际成本'
            : '在 tools/pre-execute 对首次访问的路径做存在性预检，失败即回注候选路径而不是让 agent 空跑一步',
        expectedSavingTokens: [Math.round(cost * 0.5), Math.round(cost * 0.85)],
        basis: '实测口径：被消除的步其 stepCost 不再发生；上界按 85% 计，因为仍需一步确认正确路径',
      },
      confidence: 'high',
    });
  }

  // ── R2 超长工具结果滞留（先看占比，占比不够就不谈）────────────────────
  const share = totals.carryShareOfEffInput;
  if (share < RESULT_SHARE_FLOOR) {
    notes.push({
      rule: 'spill',
      status: 'abstained',
      reason: `工具结果的估算滞留成本只占实测上下文体量的 ${pct(share)}（${fmt(totals.carryTokensEst)} / ${fmt(totals.effInputReal)}），不是本会话的成本来源。开 spill 不会有可见收益。`,
    });
  } else {
    const offenders = calls
      .filter((c) => c.resultTokens >= MIN_RESULT_TOKENS && c.carrySteps >= MIN_CARRY_STEPS)
      .sort((a, b) => b.carryTokens - a.carryTokens);
    if (offenders.length) {
      const saving = offenders.reduce((a, c) => a + Math.max(0, c.resultTokens - MIN_RESULT_TOKENS) * c.carrySteps, 0);
      out.push({
        id: 'spill',
        severity: 'medium',
        title: `${offenders.length} 条工具结果未走 spill，在上下文里滞留到会话结束`,
        finding: `最大一条估算 ${fmt(offenders[0].resultTokens)} token，被重发 ${offenders[0].carrySteps} 次。`,
        evidence: offenders.slice(0, 3).map((c) => `seq ${c.seq} · ${c.name} · ${fmt(c.resultTokens)} tok × ${c.carrySteps} 步 = ${fmt(c.carryTokens)} tok`),
        prescription: {
          action: '开启工具结果 spill，超长结果落盘，只回 locator 与预览',
          howTo: '在 profile 的 bundle 配置里启用 spill-policy，设 maxInlineTokens（建议 2000–4000）',
          expectedSavingTokens: [Math.round(saving * 0.6), Math.round(saving * 0.9)],
          basis: '估算：未计 agent 后续按需回读的补充开销',
        },
        confidence: 'medium',
      });
    } else {
      notes.push({
        rule: 'spill',
        status: 'abstained',
        reason: `工具结果占体量 ${pct(share)}，但没有任何单条结果同时满足「≥${MIN_RESULT_TOKENS} token」且「滞留 ≥${MIN_CARRY_STEPS} 步」，不构成结构性浪费。`,
      });
    }
  }

  // ── R3 重复的失败动作 ────────────────────────────────────────────────
  const badRepeats = repeats.filter((r) => r.failures >= 1 && r.count >= 2);
  if (badRepeats.length) {
    const seqSet = new Set(badRepeats.flatMap((r) => r.seqs));
    const wasted = calls.filter((c) => seqSet.has(c.seq)).reduce((a, c) => a + c.resultTokens, 0);
    out.push({
      id: 'repeat-failure',
      severity: 'high',
      title: `${badRepeats.length} 组动作被完全重复执行，且至少失败一次`,
      finding: '同一工具 + 同一组参数被执行多次。这类重复几乎不产生新信息。',
      evidence: badRepeats.slice(0, 3).map((r) => `${r.name} ×${r.count}（失败 ${r.failures} 次）· seq ${r.seqs.join(', ')}`),
      prescription: {
        action: '在 tools/pre-execute 拦下原参数重复的失败动作，把已有错误回注为提示',
        howTo: '注册 pre-execute 监听：参数指纹命中且历史有失败 → 返回 transform 注入错误摘要，或 deny',
        expectedSavingTokens: [Math.round(wasted * 0.5), Math.round(wasted * 1.0)],
        basis: '估算：被拦下的调用其新结果不再进入上下文',
      },
      confidence: 'high',
    });
  }

  // ── R4 缓存命中（用正确口径：cacheRead / effInput）────────────────────
  if (totals.cacheReadReal + totals.cacheWriteReal === 0) {
    notes.push({
      rule: 'cache',
      status: 'abstained',
      reason: '全部步骤的 cacheReadTokens / cacheWriteTokens 均为 0，无法区分「没有命中」与「该 provider 不上报缓存」，不开处方。',
    });
  } else if (totals.hitRate < CACHE_HIT_FLOOR) {
    out.push({
      id: 'cache',
      severity: totals.effInputReal > 100_000 ? 'high' : 'medium',
      title: `前缀缓存命中率仅 ${pct(totals.hitRate)}，每次请求都在重算上下文`,
      finding: `实测上下文体量 ${fmt(totals.effInputReal)} token，命中缓存 ${fmt(totals.cacheReadReal)} token。前缀一变，后面全部失效。`,
      evidence: growth.slice(0, 5).map((g) => `S${g.step} · 体量 ${fmt(g.effInput)} · 新输入 ${fmt(g.newInput)}`),
      prescription: {
        action: '稳定请求前缀：易变内容（时间戳、随机 id、动态清单）移出头部',
        howTo: '检查 system-prompt/assemble 的拼装顺序，确认 AGENTS.md 里没有每次变化的内容',
        expectedSavingTokens: [Math.round(totals.effInputReal * 0.2), Math.round(totals.effInputReal * 0.5)],
        basis: '实测口径：命中率提升后这部分按折扣计价，折扣率取决于 provider',
      },
      confidence: 'medium',
    });
  } else {
    notes.push({
      rule: 'cache',
      status: 'pass',
      reason: `前缀缓存命中率 ${pct(totals.hitRate)}，复用良好，无需处方。`,
    });
  }

  // ── R5 重读入步：一步之内把大量内容灌进上下文，且全部按未缓存全价计 ──────
  const heavy = steps.filter((s) => s.ingest?.heavy);
  if (heavy.length) {
    const cost = totals.ingestCostEst;
    const top = heavy.sort((a, b) => b.usage.inputTokens - a.usage.inputTokens)[0];
    out.push({
      id: 'heavy-ingest',
      severity: cost / Math.max(1, totals.totalReal) > 0.1 ? 'high' : 'medium',
      title: `${heavy.length} 步一次性读入大量内容，合计 ${fmt(cost)} token 按未缓存全价计价`,
      finding: `工具结果在上一步追加，只会在下一步被首次计价且不走缓存折扣。${top ? `第 ${top.step} 步未缓存输入 ${fmt(top.usage.inputTokens)} token，其中约 ${pct(top.ingest.share)} 来自上一步的工具结果。` : ''}`,
      evidence: heavy
        .slice(0, 3)
        .map((s) => `S${s.step} · 未缓存输入 ${fmt(s.usage.inputTokens)} · 上一步工具结果 ${fmt(s.ingest.prevResultTokens)}（占 ${pct(s.ingest.share)}）`),
      prescription: {
        action: '先定位再读取：用 glob/grep 拿到结构后只读相关片段，不要在一个步骤里整份读取多个文件',
        howTo: '对超过 2,000 token 的结果开启 spill，让 agent 按需回读；或按 offset/limit 分段读',
        expectedSavingTokens: [Math.round(cost * 0.3), Math.round(cost * 0.55)],
        basis: '估算：按只读必要片段后进入上下文的量削减 45–70% 计',
      },
      confidence: 'medium',
    });
  }

  // ── R6 上下文单调膨胀（排除末步：答案步会一次性消费全部工具结果）──────────
  // 末步增长几乎总是"把前面读到的结果用掉"，不是膨胀，不能计入。
  const durable = growth.slice(0, Math.max(0, growth.length - 1));
  const positive = durable.filter((g) => g.delta > 0).length;
  if (durable.length >= 4 && positive / durable.length > 0.8) {
    const first = durable[0].effInput;
    const last = durable[durable.length - 1].effInput;
    const ratio = first > 0 ? last / first : 0;
    if (ratio >= GROWTH_RATIO_FLOOR) {
      out.push({
        id: 'context-growth',
        severity: ratio >= 3 ? 'high' : 'medium',
        title: `上下文体量从 ${fmt(first)} 涨到 ${fmt(last)}（×${ratio.toFixed(1)}），全程只增不减`,
        finding: '没有任何回收机制，每步的请求都包含之前所有的工具结果。',
        evidence: durable.slice(0, 6).map((g) => `S${g.step} 体量 ${fmt(g.effInput)}（${g.delta >= 0 ? '+' : ''}${fmt(g.delta)}）`),
        prescription: {
          action: '对长会话启用 compaction 压力阈值，或对已完成子任务的工具结果做剪枝',
          howTo: '在 agent/pre-step 上设更低的压力阈值，让 compaction 提前介入',
          expectedSavingTokens: [Math.round(totals.effInputReal * 0.15), Math.round(totals.effInputReal * 0.35)],
          basis: '估算：压缩后每步体量下降，累计降幅取决于压缩比',
        },
        confidence: 'medium',
      });
    }
  }

  // ── R6 静态底噪 ──────────────────────────────────────────────────────
  const firstInput = growth.length ? growth[0].effInput : 0;
  if (system.tokensEst > 0 && firstInput > 0 && system.tokensEst / firstInput > 0.3) {
    out.push({
      id: 'static-floor',
      severity: 'medium',
      title: `静态上下文约占首步体量的 ${pct(system.tokensEst / firstInput)}，每个请求都在重复支付`,
      finding: `system/message 估算 ${fmt(system.tokensEst)} token，首步体量 ${fmt(firstInput)} token。这部分与任务无关。`,
      evidence: [`system/message 事件 ${system.messages} 条，估算 ${fmt(system.tokensEst)} token`],
      prescription: {
        action: '削减常驻上下文：停用未使用插件的工具 schema，精简 AGENTS.md',
        howTo: '需 bundle manifest 才能把 schema 成本归因到具体插件（当前版本未实现）',
        expectedSavingTokens: [Math.round(system.tokensEst * 0.15), Math.round(system.tokensEst * 0.4)],
        basis: '估算：按可裁剪比例计；真实节省 = 单请求固定成本 × 请求数',
      },
      confidence: 'low',
    });
  }

  out.sort((a, b) => (b.prescription.expectedSavingTokens[1] ?? 0) - (a.prescription.expectedSavingTokens[1] ?? 0));

  return { conclusions: out, notes, headline: buildHeadline(model, out) };
}

function buildHeadline(model, conclusions) {
  const { totals } = model;
  const base = `实测 ${fmt(totals.totalReal)} token / ${totals.requests} 次请求，平均每步 ${fmt(totals.avgStepCost)} token。`;
  if (!conclusions.length) {
    return `${base}未发现结构性浪费：缓存命中 ${pct(totals.hitRate)}，工具失败 ${totals.failedCalls}/${totals.toolCalls}，无无产出步。`;
  }
  const top = conclusions[0];
  const lo = conclusions.reduce((a, c) => a + (c.prescription.expectedSavingTokens[0] ?? 0), 0);
  const hi = conclusions.reduce((a, c) => a + (c.prescription.expectedSavingTokens[1] ?? 0), 0);
  return `${base}最该先改的是「${top.title}」，预计可省 ${fmt(lo)}–${fmt(hi)} token（占总量 ${pct(lo / Math.max(1, totals.totalReal))}–${pct(hi / Math.max(1, totals.totalReal))}）。`;
}
