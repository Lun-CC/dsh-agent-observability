/** 文本报告渲染。首屏是结论，明细在下面 —— 与「账单+处方」的产品形态一致。 */

const fmt = (n) => Math.round(Number(n ?? 0)).toLocaleString('en-US');
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const SEV = { high: '● 高', medium: '○ 中', low: '· 低' };

export function renderReport(model, verdict, opts = {}) {
  const L = [];
  const { totals, tools, steps } = model;
  const h = model.header ?? {};

  L.push('');
  L.push(`会话 ${h.id ?? '?'}${h.agentPreset ? ` · preset ${h.agentPreset}` : ''}`);
  if (h.cwd) L.push(`工作目录 ${h.cwd}`);
  if (model.source.inHost) {
    L.push(`来源 sessionQuery（宿主内）· ${model.events} 事件 · 事件路径 ${model.source.eventsFrom ?? '?'}`);
  } else {
    L.push(`日志 ${model.source.bytesOnDisk.toLocaleString('en-US')} B → 解压 ${model.source.bytesDecoded.toLocaleString('en-US')} B · ${model.frames} 帧 · ${model.events} 事件`);
  }

  // 空会话 / 中断会话：没有发生过模型调用，不产出账单，避免"无浪费"的假阳性结论
  if (totals.requests === 0) {
    L.push('');
    L.push('══ 跳过 ══════════════════════════════════════════');
    L.push(`未发生任何模型调用（${model.events} 个事件，无 assistant/message）。空会话或中断会话，不产出账单。`);
    L.push('');
    return L.join('\n');
  }

  L.push('');
  L.push('══ 结论 ══════════════════════════════════════════');
  L.push(verdict.headline);
  L.push('');

  verdict.conclusions.forEach((c, i) => {
    L.push(`── ${i + 1}. ${c.title}`);
    L.push(`   ${SEV[c.severity] ?? c.severity}  · 置信度 ${c.confidence}`);
    L.push(`   ${c.finding}`);
    for (const e of c.evidence) L.push(`     · ${e}`);
    const s = c.prescription.expectedSavingTokens;
    L.push(`   → 做什么：${c.prescription.action}`);
    L.push(`   → 怎么做：${c.prescription.howTo}`);
    L.push(`   → 预计省：${fmt(s[0])}–${fmt(s[1])} token（${c.prescription.basis}）`);
    L.push('');
  });

  if (verdict.notes.length) {
    L.push('══ 没说的部分（弃权 / 已通过）══════════════════');
    for (const n of verdict.notes) L.push(`· [${n.rule}] ${n.status === 'pass' ? '通过' : '弃权'} — ${n.reason}`);
    L.push('');
  }

  L.push('══ 逐步账单（实测）══════════════════════════════');
  L.push('  步   体量    新输入   命中率   输出   工具  失败');
  for (const s of steps) {
    L.push(
      `  S${String(s.step).padEnd(2)} ${fmt(s.effInput).padStart(8)} ${fmt(s.newInput).padStart(7)} ${pct(s.hitRate).padStart(8)} ${fmt(s.usage.outputTokens).padStart(6)} ${String(s.toolCalls ?? 0).padStart(5)} ${String(s.failedCalls ?? 0).padStart(5)}${s.barren ? '   ← 无产出' : ''}`,
    );
  }
  L.push('');

  L.push('══ 工具（结果体量为估算）═══════════════════════');
  L.push('  工具        调用  失败   结果tok');
  for (const t of tools.slice(0, opts.toolLimit ?? 10)) {
    L.push(`  ${String(t.name).padEnd(11)} ${String(t.calls).padStart(4)} ${String(t.failures).padStart(5)} ${fmt(t.resultTokens).padStart(9)}`);
  }
  L.push('');

  L.push('══ 口径 ══════════════════════════════════════════');
  L.push(`实测（provider 返回）：未缓存输入 ${fmt(totals.inputReal)} · 缓存命中 ${fmt(totals.cacheReadReal)}（${pct(totals.hitRate)}）· 输出 ${fmt(totals.outputReal)} · 合计 ${fmt(totals.totalReal)}`);
  L.push(`实测上下文体量：${fmt(totals.effInputReal)} · 每步均值 ${fmt(totals.avgStepCost)}`);
  L.push(`估算（结果字数推算）：工具结果 ${fmt(totals.toolResultTokensEst)} · 滞留 ${fmt(totals.carryTokensEst)}（占体量 ${pct(totals.carryShareOfEffInput)}）`);
  L.push(`请求 ${totals.requests} 次 · 工具 ${totals.toolCalls} 次 · 失败 ${totals.failedCalls} 次（${pct(totals.failRate)}）· 无产出步 ${totals.barrenSteps} 个 · 重复动作 ${model.repeats.length} 组`);
  L.push('');
  L.push('字段语义（实测校验）：total = input(未缓存) + cacheRead + cacheWrite + output。');
  L.push('「体量」= input + cacheRead + cacheWrite，即该请求实际送入的全部上下文。');
  L.push('「无产出步」= 该步发起了工具调用但全部失败。滞留成本 = 结果 token × 其后仍发生的请求数。');
  L.push('');

  return L.join('\n');
}
