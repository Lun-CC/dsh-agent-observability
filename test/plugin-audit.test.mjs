/**
 * 插件逻辑测试：适配层 + 端到端（假 ctx）。
 *
 * 用 2026-10-21 探针实测到的真实形状构造数据：
 *   - readSession 返回 { session: <SessionHeader>, inheritedEventCount, events[] }
 *   - measure 返回 { logRevision, baseline:{kind}, totalTokens, surfaceTokens, nodes[] }
 *   - session/flush 的 payload 本身就是 Session
 *
 * 0.7.0 起只保留 session/flush 一个触发点：agent/turn-stopping 的首参是
 * { agent, turn, signal } 而不是 Session，挂在上面从来没生效过。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eventsFromSnapshot, normalizeEvent, loadedFromSnapshot, attachMeasure } from '../packages/dsh-audit-plugin/lib/adapter.mjs';
import { analyze } from '../packages/dsh-audit-plugin/lib/core/analyze.mjs';

const home = mkdtempSync(join(tmpdir(), 'dsh-audit-plugin-'));
process.env.DSH_HOME = home;

const { apply, inject } = await import('../packages/dsh-audit-plugin/lib/index.js');

const usage = (input, cacheRead, output) => ({
  inputTokens: input,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: 0,
  outputTokens: output,
  totalTokens: input + cacheRead + output,
});

/** 两轮的会话：S1 一个失败调用，S2 成功。 */
function snapshot(id = 'session-test', parentId = null) {
  return {
    session: { id, cwd: 'E:\\x', createdAt: 1, version: 4, agentPreset: 'standard', parentId },
    inheritedEventCount: 0,
    events: [
      { seq: 2, type: 'assistant/message', time: 2, data: { turn: 1, step: 1, usage: usage(9000, 0, 200) } },
      { seq: 3, type: 'tool/call', time: 3, data: { callId: 'a', name: 'read', arguments: '{"file_path":"E:/nope"}', turn: 1, step: 1 } },
      {
        seq: 4,
        type: 'tool/result',
        time: 4,
        data: { turn: 1, step: 1, message: { toolCallId: 'a', isError: false, content: [{ type: 'text', text: '找不到路径：E:/nope' }] } },
      },
      { seq: 5, type: 'assistant/message', time: 5, data: { turn: 1, step: 2, usage: usage(120, 9200, 150) } },
    ],
  };
}

const defaultMeter = {
  measure: () => ({ logRevision: 5, baseline: { kind: 'usage' }, totalTokens: 9470, surfaceTokens: 9300, nodes: [{ seq: 4, tokens: 40 }] }),
};

/**
 * 造一个假 ctx：只注入 sessionQuery。
 * tokenMeter 通过 `ctx.get()` 提供 —— 与真实 Cordis 一致：
 * 未注入的服务只能用 get 读，直接读属性会抛 without inject。
 */
function fakeCtx(opts = {}) {
  const handlers = {};
  const meter = opts.tokenMeter === false ? undefined : (opts.tokenMeter ?? defaultMeter);
  const ctx = {
    _h: handlers,
    on(ev, fn) {
      handlers[ev] = fn;
    },
    get(name) {
      return name === 'tokenMeter' ? meter : undefined;
    },
    sessionQuery: {
      readSession: async (id) => {
        if (opts.failRead) throw new Error('boom');
        return opts.snapshot ?? snapshot(id);
      },
    },
  };
  return ctx;
}

const outDir = join(home, 'dsh-audit');
const readOut = (name) => readFileSync(join(outDir, name), 'utf8');
const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));

test('inject 只声明必需服务；tokenMeter 通过 ctx.get 可选读取', async () => {
  assert.deepEqual(inject, ['sessionQuery']);

  // 只有 get('tokenMeter')、没有 ctx.tokenMeter 属性 —— 模拟未注入但服务存在的真实情形
  const ctx = fakeCtx();
  apply(ctx, { minIntervalMs: 0 });
  ctx._h['session/flush']({ header: { id: 'session-viaget' }, log: {} });
  await tick();

  const text = readOut('report-session-viaget.txt');
  assert.match(text, /平台定价（tokenMeter\.measure，实测）/, 'ctx.get 拿到的 meter 应产出平台定价区块');
});

test('只注册 session/flush 一个触发点，不再有 agent/turn-stopping', () => {
  const ctx = fakeCtx();
  apply(ctx, {});
  assert.deepEqual(Object.keys(ctx._h), ['session/flush']);
});

test('flush 触发审计并写出报告', async () => {
  const ctx = fakeCtx();
  apply(ctx, { minIntervalMs: 0 });
  ctx._h['session/flush']({ header: { id: 'session-test' }, log: {}, surfaceManager: {} });
  await tick();

  assert.ok(existsSync(join(outDir, 'report-session-test.txt')));
  const text = readOut('report-session-test.txt');
  assert.match(text, /实测/);
  assert.match(text, /生成时间/);
  assert.match(text, /平台定价（tokenMeter\.measure/);
  assert.match(text, /baseline\.kind = usage/);
  assert.match(text, /工具结果 · read/);
});

test('latest.txt 只由顶层会话写：subagent 不能顶掉主报告', async () => {
  const ctx = fakeCtx();
  apply(ctx, { minIntervalMs: 0 });

  ctx._h['session/flush']({ header: { id: 'session-main', parentId: null, delegationDepth: 0 }, log: {} });
  await tick();
  assert.ok(existsSync(join(outDir, 'latest.txt')));
  const mainText = readOut('latest.txt');
  assert.match(mainText, /session-main/);

  // subagent：parentId 非空
  ctx._h['session/flush']({ header: { id: 'session-child', parentId: 'session-main', delegationDepth: 1 }, log: {} });
  await tick();

  assert.ok(existsSync(join(outDir, 'report-session-child.txt')), 'subagent 仍应有自己的报告');
  assert.equal(readOut('latest.txt'), mainText, 'latest.txt 不应被 subagent 覆盖');
});

test('tokenMeter 缺失时降级：报告照常产出并标注口径', async () => {
  const ctx = fakeCtx({ tokenMeter: false });
  apply(ctx, { minIntervalMs: 0 });
  ctx._h['session/flush']({ header: { id: 'session-nom' }, log: {} });
  await tick();

  const text = readOut('report-session-nom.txt');
  assert.match(text, /未取得平台定价/);
  assert.doesNotMatch(text, /平台定价（tokenMeter\.measure，实测）/);
});

test('空会话（events 为 []）不报错、不写 errors.log', async () => {
  const ctx = fakeCtx({ snapshot: { session: { id: 'session-empty' }, inheritedEventCount: 0, events: [] } });
  apply(ctx, { minIntervalMs: 0 });
  assert.doesNotThrow(() => ctx._h['session/flush']({ header: { id: 'session-empty' }, log: {} }));
  await tick();

  assert.ok(existsSync(join(outDir, 'report-session-empty.txt')), '空会话也应产出（走跳过分支）');
  assert.ok(!existsSync(join(outDir, 'errors.log')), '空会话不应被当成形状未适配');
});

test('readSession 抛错只记日志，不向事件链抛出', async () => {
  const ctx = fakeCtx({ failRead: true });
  apply(ctx, { minIntervalMs: 0 });
  assert.doesNotThrow(() => ctx._h['session/flush']({ header: { id: 'session-bad' }, log: {} }));
  await tick();

  assert.ok(existsSync(join(outDir, 'errors.log')));
  assert.match(readOut('errors.log'), /boom/);
});

test('保留策略：超过 maxReports 时清理最旧报告', async () => {
  const ctx = fakeCtx();
  apply(ctx, { minIntervalMs: 0, maxReports: 1 });
  ctx._h['session/flush']({ header: { id: 'session-r1' }, log: {} });
  await tick();
  ctx._h['session/flush']({ header: { id: 'session-r2' }, log: {} });
  await tick(220);

  const reports = readdirSync(outDir).filter((f) => f.startsWith('report-') && f.endsWith('.txt'));
  assert.equal(reports.length, 1, `只应保留 1 份，实际 ${reports.length}：${reports.join(',')}`);
});

// ── 适配层 ────────────────────────────────────────────────────────────

test('适配：从 events 字段取事件并归一', () => {
  const got = eventsFromSnapshot(snapshot());
  assert.ok(got);
  assert.equal(got.where, 'snapshot.events');
  assert.equal(got.events.length, 4);
  assert.equal(got.events[0].type, 'assistant/message');
  assert.equal(got.events[0].seq, 2);
});

test('适配：空事件数组是合法状态，不当作形状未适配', () => {
  const got = eventsFromSnapshot({ events: [] });
  assert.ok(got, '空数组也应被识别');
  assert.equal(got.where, 'snapshot.events');
  assert.deepEqual(got.events, []);
});

test('适配：header 从 snapshot.session 取，缺失时会话 id 不该是问号', () => {
  const loaded = loadedFromSnapshot(snapshot());
  const model = analyze(loaded);
  assert.equal(model.header.id, 'session-test');
  assert.equal(model.header.cwd, snapshot().session.cwd, 'cwd 应原样透传，不丢反斜杠');
  assert.equal(model.events, 5, '4 条真实事件 + 1 条合成 session 事件');
});

test('适配：listEvents 那种无 data 的记录不会崩，data 落成空对象', () => {
  const rec = normalizeEvent({ sessionId: 's', seq: 9, type: 'session/title', time: 1, surface: 'append' });
  assert.equal(rec.type, 'session/title');
  assert.deepEqual(rec.data, {});
});

test('适配：定位不到事件时必须抛错，不能静默返回空', () => {
  assert.throws(() => loadedFromSnapshot({ session: { id: 'x' } }), /无法从 sessionQuery\.readSession/);
});

test('平台定价：工具结果节点能被正确标注', () => {
  const loaded = loadedFromSnapshot(snapshot());
  const model = analyze(loaded);
  model.__loaded = loaded;
  const { measured, nodes } = attachMeasure(model, {
    logRevision: 5,
    baseline: { kind: 'usage', tokens: 9470 },
    totalTokens: 9470,
    surfaceTokens: 9300,
    nodes: [
      { seq: 4, tokens: 40, heuristicTokens: 38 },
      { seq: 2, tokens: 200, heuristicTokens: 198 },
    ],
  });
  assert.equal(measured.baselineKind, 'usage');
  assert.equal(measured.nodeCount, 2);
  assert.equal(measured.nodeSum, 240);
  assert.equal(nodes[0].tokens, 200, '按 token 降序');
  assert.equal(nodes[1].label, '工具结果 · read');
});
