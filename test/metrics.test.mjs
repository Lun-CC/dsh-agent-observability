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
