/**
 * 度量口径的回归测试。
 *
 * 这些断言对应 2026-10-21 在真实会话上踩到的三个坑，任何一个回退都会让账单失真：
 *   1. total = input(未缓存) + cacheRead + cacheWrite + output
 *   2. 命中率的分母是 effInput，不是 inputTokens（否则会算出 >100%）
 *   3. 文本证据优先于退出码分类（Get-ChildItem 缺路径同时带「找不到」与 exit 1）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, failureSignal } from '../src/lib/analyze.mjs';
import { prescribe } from '../src/lib/prescribe.mjs';

const usage = (input, cacheRead, output, cacheWrite = 0) => ({
  inputTokens: input,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: cacheWrite,
  outputTokens: output,
  totalTokens: input + cacheRead + cacheWrite + output,
});

const stepEvent = (seq, step, u) => ({ type: 'assistant/message', seq, time: seq, data: { turn: 1, step, usage: u } });

const loaded = (events) => ({
  file: 'memory',
  bytesOnDisk: 0,
  frames: 1,
  bytesDecoded: 0,
  badLines: 0,
  frameWarnings: 0,
  events,
});

test('恒等式：total = 未缓存输入 + 缓存读 + 缓存写 + 输出', () => {
  const u = usage(277, 9600, 220);
  assert.equal(u.totalTokens, 10_097);
  const m = analyze(loaded([{ type: 'session', seq: 0, id: 's1' }, stepEvent(1, 1, u)]));
  assert.equal(m.totals.totalReal, 10_097);
});

test('命中率分母是 effInput，不会超过 100%', () => {
  const m = analyze(
    loaded([
      { type: 'session', seq: 0, id: 's1' },
      stepEvent(1, 1, usage(9432, 0, 208)),
      stepEvent(2, 2, usage(277, 9600, 220)),
    ]),
  );
  const s2 = m.steps[1];
  assert.equal(s2.effInput, 9_877);
  assert.ok(s2.hitRate > 0.97 && s2.hitRate <= 1, `hitRate=${s2.hitRate}`);
  // 汇总命中率的分母是**所有步**的体量之和，所以第一步 0% 命中会把整体拉低
  const totalEff = 9432 + (277 + 9600);
  assert.equal(m.totals.hitRate, 9600 / totalEff);
  assert.ok(m.totals.hitRate < s2.hitRate, '汇总命中率应低于单步命中率（首步未命中）');
  assert.ok(m.totals.hitRate <= 1);
});

test('无产出步：该步工具全失败才算', () => {
  const events = [
    { type: 'session', seq: 0, id: 's1' },
    stepEvent(1, 1, usage(1000, 0, 100)),
    stepEvent(2, 2, usage(10, 1000, 100)),
    { type: 'tool/call', seq: 3, data: { callId: 'a', name: 'pwsh', arguments: '{}', turn: 1, step: 1 } },
    { type: 'tool/result', seq: 4, data: { turn: 1, step: 1, message: { toolCallId: 'a', isError: false, content: [{ type: 'text', text: '找不到路径\n[exit code: 1]' }] } } },
    { type: 'tool/call', seq: 5, data: { callId: 'b', name: 'pwsh', arguments: '{"command":"ls"}', turn: 1, step: 2 } },
    { type: 'tool/result', seq: 6, data: { turn: 1, step: 2, message: { toolCallId: 'b', isError: false, content: [{ type: 'text', text: 'ok' }] } } },
  ];
  const m = analyze(loaded(events));
  assert.equal(m.steps[0].barren, true, 'S1 工具全失败 → 无产出');
  assert.equal(m.steps[1].barren, false, 'S2 工具成功 → 不是无产出');
  assert.equal(m.totals.barrenSteps, 1);
});

test('失败分类：文本证据优先于退出码', () => {
  const ev = {
    data: { message: { isError: false, content: [{ type: 'text', text: "Get-ChildItem : 找不到路径“D:\\nope”\r\n[exit code: 1]" }] } },
  };
  assert.equal(failureSignal(ev), 'path/target not found');
});

test('纯退出码失败能被识别（isError 为 false 时）', () => {
  const ev = { data: { message: { isError: false, content: [{ type: 'text', text: 'boom\n[exit code: 2]' }] } } };
  assert.equal(failureSignal(ev), 'exit 2');
});

test('成功的工具结果不报失败', () => {
  const ev = { data: { message: { isError: false, content: [{ type: 'text', text: 'all good\n[exit code: 0]' }] } } };
  assert.equal(failureSignal(ev), null);
});

test('读取成功但内容含 not found 的文件，不得判为失败（真实踩坑）', () => {
  // 本仓库的 analyze.mjs 里就有字面量 'path/target not found'，
  // 首版在读取它时把自己的源码判成了「读取失败」。
  const source = `export function failureSignal() {\n  return STRONG_ERR.test(text) ? 'path/target not found' : null;\n}\n// `.padEnd(2000, 'x');
  const ev = { data: { message: { isError: false, content: [{ type: 'text', text: source }] } } };
  assert.equal(failureSignal(ev), null, '长结果（文件内容）不参与弱模式匹配');
});

test('短结果里的 not found 仍然判失败（真实错误信息）', () => {
  const ev = { data: { message: { isError: false, content: [{ type: 'text', text: 'Error: not found: /nope/a.md' }] } } };
  assert.equal(failureSignal(ev), 'path/target not found');
});

test('正文中间出现 [exit code: 1] 的文件，不得判为失败（真实踩坑）', () => {
  // test/metrics.test.mjs 里作为测试数据写了 '[exit code: 1]'，
  // 让它跟着自己的源码被判成了「失败」。退出码只认结果末尾。
  const source = `const t = '找不到路径\\n[exit code: 1]';\n${'// filler\n'.repeat(200)}export {};\n`;
  const ev = { data: { message: { isError: false, content: [{ type: 'text', text: source }] } } };
  assert.equal(failureSignal(ev), null);
});

test('末尾带非零退出码仍然判失败', () => {
  const ev = { data: { message: { isError: false, content: [{ type: 'text', text: `long output...\n[exit code: 1]  ` }] } } };
  assert.equal(failureSignal(ev), 'exit 1');
});

// ── spill 豁免（2026-10-22 真机踩坑）──────────────────────────────────────
// spill-policy/lib/types/index.js 里写死了 `exec.name === 'read'` 直接放行。
// 之前我们把 read 的大结果也算进 spill 处方，用户照做后一条都没落盘 —— 处方是假的。

function sessionWithTool(toolName, chars) {
  const events = [
    { type: 'session', data: { id: 's1' } },
    { type: 'tool/call', seq: 1, time: 1, data: { callId: 'c1', name: toolName, arguments: '', step: 1, turn: 1 } },
    { type: 'tool/result', seq: 2, time: 2, data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'x'.repeat(chars) }] } } },
  ];
  for (let i = 0; i < 4; i++) events.push(stepEvent(10 + i, 2 + i, usage(5000, 40000, 100)));
  return loaded(events);
}

test('read 的大结果被标记为 spill 豁免', () => {
  const m = analyze(sessionWithTool('read', 40000));
  assert.equal(m.calls[0].spillExempt, true);
  assert.ok(m.calls[0].resultTokens >= 2000);
});

test('非 read 工具的大结果不豁免', () => {
  const m = analyze(sessionWithTool('pwsh', 40000));
  assert.equal(m.calls[0].spillExempt, false);
});

test('read 主导时不开 spill 处方（开了也没用）', () => {
  const v = prescribe(analyze(sessionWithTool('read', 40000)));
  const ids = v.conclusions.map((c) => c.id);
  assert.ok(!ids.includes('spill'), 'read 的结果 spill 管不了，不该出这张卡');
  assert.ok(ids.includes('heavy-ingest'), '应改为「分段读」处方');
  const card = v.conclusions.find((c) => c.id === 'heavy-ingest');
  assert.match(card.finding, /spill/);
});

test('非 read 的超长结果仍然开 spill 处方', () => {
  const m = analyze(sessionWithTool('pwsh', 40000));
  // 让工具结果的滞留成本占到体量 5% 以上，spill 规则才不再弃权
  const v = prescribe(m);
  const ids = v.conclusions.map((c) => c.id);
  const spillNote = v.notes.find((n) => n.rule === 'spill');
  assert.ok(
    ids.includes('spill') || (spillNote && /占体量/.test(spillNote.reason)),
    '要么出 spill 处方，要么明确写清弃权原因',
  );
});

test('同一 id 的处方不会重复出两张卡', () => {
  const v = prescribe(analyze(sessionWithTool('read', 40000)));
  const ids = v.conclusions.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
});
