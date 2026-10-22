/**
 * 会话度量与成本归因模型。
 *
 * ── 数据口径（2026-10-21 用本机真实会话实测确认，9/9 步成立）─────────────
 *   assistant/message.data.usage 的字段语义：
 *     inputTokens      = **未命中缓存**的新输入（全价）
 *     cacheReadTokens  = 命中缓存的前缀（折扣价，通常占绝大部分）
 *     cacheWriteTokens = 写入缓存（当前样本恒为 0）
 *     outputTokens     = 输出
 *     totalTokens      = input + output + cacheRead + cacheWrite  ← 恒等式成立
 *
 *   因此：
 *     effInput  = input + cacheRead + cacheWrite   （这一请求实际送进去的全部上下文）
 *     stepCost  = effInput + output                （一步的体量）
 *     hitRate   = cacheRead / effInput             （前缀复用率）
 *
 *   注意：绝不能用 cacheRead / inputTokens 算命中率 —— 会得到 >100% 的荒谬值。
 *
 * ── 归因模型（本项目的核心假设，必须能被质疑）────────────────────────────
 *   1. token 总量是**实测**（provider 返回）。按工具拆出来的数字是**估算**。
 *   2. 工具本身不烧 token，只有它留在 surface 里的结果会被后续每次请求重发。
 *   3. carryTokens(result) = 结果 token 估算 × (lastStep - result.step)
 *   4. 若一步内所有工具调用都失败，该步为「无产出步」——它买到的信息为零，
 *      但付了完整一步的成本。这是「从哪一步开始跑偏」最硬的信号。
 *
 * ── 已知偏差 ──────────────────────────────────────────────────────────────
 *   - 早被 compaction 剪掉的节点仍被计入 carry（日志里没有 compaction 事件时无法校正）
 *   - token 估算按 CJK 1 字 ≈ 1 token，对中文偏保守（高估约 10–20%）
 *   - 「无产出步」只统计工具全失败，不含"工具成功但结果无用"的情形
 */

import { messageText, estimateTokens, estimateTokensOfficial, SPILL_EXEMPT_TOOLS } from './session.mjs';

/**
 * 从工具结果里识别失败信号。
 *
 * 两个必须守住的边界（都是真数据踩出来的）：
 *  1. shell 非零退出码**不会**置 isError，必须从文本读 `[exit code: N]`。
 *  2. 不能对整段结果做宽松的 `not found` 匹配 —— 读文件时结果就是文件内容，
 *     任何包含 "not found" 字样的源码都会被判成「读取失败」。
 *     本文件自己就含有字面量 'path/target not found'，首版读它时自我命中。
 *     所以：强模式（ENOENT / 找不到路径 等 OS 措辞）可全局匹配；
 *     弱模式（泛化的 not found）只在短结果上匹配，且要求结果本身像错误信息。
 */
const STRONG_ERR = /ENOENT|No such file or directory|找不到路径|cannot find the path|command not found|is not recognized as the name|ItemNotFoundException|EACCES|Permission denied|拒绝访问/i;
const WEAK_ERR = /not found|找不到|does not exist/i;
const SHORT_RESULT = 400; // 字符数；超过此长度视为"内容"，不再做弱模式匹配

export function failureSignal(resultEvent) {
  const m = resultEvent?.data?.message;
  if (!m) return null;
  const text = messageText(m);

  const classify = () => (/EACCES|Permission denied|拒绝访问/i.test(text) ? 'permission denied' : 'path/target not found');

  if (m.isError) return 'pipeline error';

  // 退出码标记只在结果**末尾**才算数：shell 包装器是追加在尾部。
  // 否则读取任何"正文里提到 [exit code: 1]"的文件都会被误判为失败
  // （test/metrics.test.mjs 里就有这种测试数据）。
  const exitAtEnd = text.trimEnd().match(/\[exit code:\s*(-?\d+)\]\s*$/i);
  const exitAny = text.length <= SHORT_RESULT ? text.match(/\[exit code:\s*(-?\d+)\]/i) : null;
  const exit = exitAtEnd ?? exitAny;
  if (exit && exit[1] !== '0') {
    return STRONG_ERR.test(text) ? classify() : `exit ${exit[1]}`;
  }

  // 没有非零退出码时，只在短结果上认错误文本（避免把文件内容当错误）
  if (text.length <= SHORT_RESULT) {
    if (STRONG_ERR.test(text)) return classify();
    if (WEAK_ERR.test(text)) return 'path/target not found';
  }
  return null;
}

/** 参数归一化，用于识别"重复的同一个动作"。 */
export function argsKey(name, raw) {
  if (!raw) return `${name}|`;
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return `${name}|${String(raw).trim().toLowerCase().slice(0, 200)}`;
  }
  const flat = [];
  const walk = (v) => {
    if (v === null || v === undefined) return;
    if (typeof v === 'object') {
      for (const k of Object.keys(v).sort()) walk(v[k]);
    } else {
      flat.push(String(v).replace(/[\\/]+/g, '/').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 160));
    }
  };
  walk(obj);
  return `${name}|${flat.join('~')}`;
}

const ZERO = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };

export function analyze(loaded) {
  const ev = loaded.events;
  const of = (t) => ev.filter((e) => e.type === t);
  const header = of('session')[0];

  const steps = of('assistant/message').map((e) => {
    const u = { ...ZERO, ...(e.data.usage ?? {}) };
    const effInput = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
    return {
      seq: e.seq,
      turn: e.data.turn,
      step: e.data.step,
      usage: u,
      effInput,
      stepCost: effInput + u.outputTokens,
      hitRate: effInput > 0 ? u.cacheReadTokens / effInput : 0,
      at: e.time,
    };
  });

  const lastStep = steps.length ? steps[steps.length - 1].step : 0;

  const resultByCall = new Map();
  for (const r of of('tool/result')) {
    const id = r.data?.message?.toolCallId ?? r.data?.message?.id;
    if (id) resultByCall.set(id, r);
  }

  const calls = of('tool/call').map((c) => {
    const d = c.data ?? {};
    const id = d.callId ?? d.message?.id;
    const name = d.name ?? d.message?.name ?? 'unknown';
    const args = d.arguments ?? '';
    const r = resultByCall.get(id);
    const text = r ? messageText(r.data.message) : '';
    const tokens = estimateTokens(text);
    const step = d.step ?? 0;
    return {
      seq: c.seq,
      id,
      name,
      args,
      argsKey: argsKey(name, args),
      turn: d.turn ?? 0,
      step,
      hasResult: Boolean(r),
      resultTokens: tokens,
      // 平台判定 spill 用的口径（4 字符/token），与我们自己的估算是两个数
      resultTokensOfficial: estimateTokensOfficial(text),
      // read 的结果被 spill-policy 显式豁免，调阈值对它完全无效
      spillExempt: SPILL_EXEMPT_TOOLS.has(name),
      resultBytes: Buffer.byteLength(text, 'utf8'),
      failure: r ? failureSignal(r) : null,
      carrySteps: r ? Math.max(0, lastStep - step) : 0,
      carryTokens: r ? tokens * Math.max(0, lastStep - step) : 0,
    };
  });

  // 每步的工具结果情况 → 判定「无产出步」
  const callsByStep = new Map();
  for (const c of calls) {
    const list = callsByStep.get(c.step) ?? [];
    list.push(c);
    callsByStep.set(c.step, list);
  }
  for (const s of steps) {
    const list = callsByStep.get(s.step) ?? [];
    s.toolCalls = list.length;
    s.failedCalls = list.filter((c) => c.failure).length;
    s.newInput = s.usage.inputTokens;
    // 无产出步：这一步发起了工具调用，但全部失败
    s.barren = list.length > 0 && s.failedCalls === list.length;
  }

  // 「重读入步」：该步的未缓存输入主要来自上一步的工具结果。
  // 工具结果在上一步 assistant 消息之后才追加，所以只在下一步被计价，且是全价。
  for (let i = 1; i < steps.length; i++) {
    const prev = steps[i - 1];
    const prevResults = (callsByStep.get(prev.step) ?? []).reduce((a, c) => a + c.resultTokens, 0);
    const newIn = steps[i].usage.inputTokens;
    steps[i].ingest = {
      prevResultTokens: prevResults,
      share: newIn > 0 ? prevResults / newIn : 0,
      heavy: newIn >= 5000 && prevResults >= newIn * 0.6,
    };
  }

  const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);

  const totals = {
    requests: steps.length,
    inputReal: sum(steps, (s) => s.usage.inputTokens),
    cacheReadReal: sum(steps, (s) => s.usage.cacheReadTokens),
    cacheWriteReal: sum(steps, (s) => s.usage.cacheWriteTokens),
    outputReal: sum(steps, (s) => s.usage.outputTokens),
    totalReal: sum(steps, (s) => s.usage.totalTokens),
    effInputReal: sum(steps, (s) => s.effInput),
    stepCostReal: sum(steps, (s) => s.stepCost),
    toolCalls: calls.length,
    toolResultTokensEst: sum(calls, (c) => c.resultTokens),
    carryTokensEst: sum(calls, (c) => c.carryTokens),
    failedCalls: calls.filter((c) => c.failure).length,
    barrenSteps: steps.filter((s) => s.barren).length,
    heavyIngestSteps: steps.filter((s) => s.ingest?.heavy).length,
    ingestCostEst: sum(steps.filter((s) => s.ingest?.heavy), (s) => s.usage.inputTokens),
  };
  totals.hitRate = totals.effInputReal > 0 ? totals.cacheReadReal / totals.effInputReal : 0;
  totals.failRate = totals.toolCalls > 0 ? totals.failedCalls / totals.toolCalls : 0;
  totals.avgStepCost = steps.length ? totals.stepCostReal / steps.length : 0;
  // 无产出步买到的信息为零，却付了整步成本
  totals.barrenCostEst = sum(steps.filter((s) => s.barren), (s) => s.stepCost);
  // 工具结果在实测输入体量里的占比 —— 判断"上下文污染"是否真是成本来源
  totals.carryShareOfEffInput = totals.effInputReal > 0 ? totals.carryTokensEst / totals.effInputReal : 0;

  const byTool = new Map();
  for (const c of calls) {
    const t = byTool.get(c.name) ?? { name: c.name, calls: 0, failures: 0, resultTokens: 0, carryTokens: 0, bytes: 0 };
    t.calls++;
    if (c.failure) t.failures++;
    t.resultTokens += c.resultTokens;
    t.carryTokens += c.carryTokens;
    t.bytes += c.resultBytes;
    byTool.set(c.name, t);
  }
  const tools = [...byTool.values()].sort((a, b) => b.resultTokens - a.resultTokens);

  const byKey = new Map();
  for (const c of calls) {
    const g = byKey.get(c.argsKey) ?? { key: c.argsKey, name: c.name, hits: [], args: c.args };
    g.hits.push(c);
    byKey.set(c.argsKey, g);
  }
  const repeats = [...byKey.values()]
    .filter((g) => g.hits.length >= 2)
    .map((g) => ({
      name: g.name,
      args: g.args,
      count: g.hits.length,
      failures: g.hits.filter((h) => h.failure).length,
      seqs: g.hits.map((h) => h.seq),
    }))
    .sort((a, b) => b.count - a.count || b.failures - a.failures);

  const growth = steps.map((s, i) => ({
    step: s.step,
    turn: s.turn,
    effInput: s.effInput,
    newInput: s.usage.inputTokens,
    output: s.usage.outputTokens,
    delta: i === 0 ? s.effInput : s.effInput - steps[i - 1].effInput,
  }));

  const systemEvents = of('system/message');
  const systemTokensEst = estimateTokens(systemEvents.map((e) => messageText(e.data?.message)).join('\n'));

  // session 事件有两种形状：磁盘上是扁平字段（{type,version,id,cwd,...}），
  // 宿主内由快照合成的可能是 data 包装。两种都认，避免 header 变成 undefined。
  const sessionEvent = of('session')[0];
  const headerSource = sessionEvent && (sessionEvent.data?.id ? sessionEvent.data : sessionEvent);

  return {
    header: headerSource
      ? {
          id: headerSource.id,
          cwd: headerSource.cwd,
          createdAt: headerSource.createdAt,
          agentPreset: headerSource.agentPreset,
          version: headerSource.version,
          // 用于把 subagent 会话归到同一次对话下（UI 按对话聚合，而不是按会话碎片化）
          // 实测字段名是 parentSession（不是 parentId）；两者都认，兼容不同版本
          parentSession: headerSource.parentSession ?? headerSource.parentId ?? null,
          delegationDepth: headerSource.delegationDepth ?? 0,
          origin: headerSource.origin ?? null,
        }
      : null,
    frames: loaded.frames,
    events: ev.length,
    steps,
    calls,
    repeats,
    growth,
    tools,
    totals,
    system: { messages: systemEvents.length, tokensEst: systemTokensEst },
    source: {
      file: loaded.file,
      bytesOnDisk: loaded.bytesOnDisk,
      bytesDecoded: loaded.bytesDecoded,
      badLines: loaded.badLines,
      frameWarnings: loaded.frameWarnings,
      inHost: loaded.inHost ?? false,
      eventsFrom: loaded.eventsFrom ?? null,
      generatedAt: loaded.generatedAt ?? null,
    },
  };
}
