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

import { messageText, estimateTokens } from './session.mjs';

/** 从工具结果里识别失败信号。注意：shell 非零退出码不会置 isError。 */
export function failureSignal(resultEvent) {
  const m = resultEvent?.data?.message;
  if (!m) return null;
  const text = messageText(m);
  // 先按文本证据分类，再看退出码 —— 因为 Get-ChildItem 之类的失败同时带
  // 「找不到路径」与 exit 1，按文本归类信息量更大，处方方向也不同。
  if (/not found|找不到|no such file|does not exist|command not found/i.test(text)) return 'path/target not found';
  if (/permission denied|拒绝访问|access is denied/i.test(text)) return 'permission denied';
  const exit = text.match(/\[exit code:\s*(-?\d+)\]/i);
  if (exit && exit[1] !== '0') return `exit ${exit[1]}`;
  if (m.isError) return 'pipeline error';
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

  return {
    header: header
      ? { id: header.id, cwd: header.cwd, createdAt: header.createdAt, agentPreset: header.agentPreset, version: header.version }
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
    },
  };
}
