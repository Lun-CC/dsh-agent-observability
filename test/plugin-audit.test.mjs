/**
 * 插件逻辑测试：适配层 + 端到端（假 ctx）。
 *
 * 用 2026-10-21 探针实测到的真实形状构造数据：
 *   - listEvents 记录只有 { sessionId, seq, type, time, surface }，没有 data
 *   - measure 返回 { logRevision, baseline:{kind}, totalTokens, surfaceTokens, nodes[] }
 *   - session/flush 的 payload 本身就是 Session
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eventsFromSnapshot, normalizeEvent, loadedFromSnapshot, attachMeasure } from '../packages/dsh-audit-plugin/lib/adapter.mjs';
import { analyze } from '../packages/dsh-audit-plugin/lib/core/analyze.mjs';

const home = mkdtempSync(join(tmpdir(), 'dsh-audit-plugin-'));
process.env.DSH_HOME = home;

const { apply } = await import('../packages/dsh-audit-plugin/lib/index.js');

/** 造一个两轮的会话：S1 一个失败调用，S2 成功。
 *  形状按 2026-10-21 实测：{ session: <header>, inheritedEventCount, events[] } */
function snapshot() {
  return {
    session: { id: 'session-test', cwd: 'E:\\x', createdAt: 1, version: 4, agentPreset: 'standard' },
    inheritedEventCount: 0,
    events: [
      {
        seq: 2,
        type: 'assistant/message',
        time: 2,
        data: { turn: 1, step: 1, usage: { inputTokens: 9000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 200, totalTokens: 9200 } },
      },
      { seq: 3, type: 'tool/call', time: 3, data: { callId: 'a', name: 'read', arguments: '{"file_path":"E:/nope"}', turn: 1, step: 1 } },
      {
        seq: 4,
        type: 'tool/result',
        time: 4,
        data: { turn: 1, step: 1, message: { toolCallId: 'a', isError: false, content: [{ type: 'text', text: '找不到路径：E:/nope' }] } },
      },
      {
        seq: 5,
        type: 'assistant/message',
        time: 5,
        data: { turn: 2, step: 2, usage: { inputTokens: 120, cacheReadTokens: 9200, cacheWriteTokens: 0, outputTokens: 150, totalTokens: 9470 } },
      },
    ],
  };
}

test('适配：从 events 字段取事件并归一', () => {
  const got = eventsFromSnapshot(snapshot());
  assert.ok(got, '应取到事件数组');
  assert.equal(got.where, 'snapshot.events');
  assert.equal(got.events.length, 4);
  assert.equal(got.events[0].type, 'assistant/message');
  assert.equal(got.events[0].seq, 2);
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
  assert.throws(() => loadedFromSnapshot({ header: {} }), /无法从 sessionQuery\.readSession/);
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

test('端到端：turn-stopping 触发后写出报告文件', async () => {
  const ctx = {
    on(ev, fn) {
      (this._h ??= {})[ev] = fn;
    },
    sessionQuery: { readSession: async () => snapshot() },
    tokenMeter: {
      measure: () => ({ logRevision: 5, baseline: { kind: 'usage' }, totalTokens: 9470, surfaceTokens: 9300, nodes: [{ seq: 4, tokens: 40 }] }),
    },
  };
  apply(ctx, { minIntervalMs: 0 });
  const session = { header: { id: 'session-test' }, log: {}, surfaceManager: {} };
  ctx._h['agent/turn-stopping'](session);
  await new Promise((r) => setTimeout(r, 150));

  const file = join(home, 'dsh-audit', 'report-session-test.txt');
  assert.ok(existsSync(file), '应写出报告');
  const text = readFileSync(file, 'utf8');
  assert.match(text, /实测/);
  assert.match(text, /平台定价（tokenMeter\.measure/);
  assert.match(text, /baseline\.kind = usage/);
  assert.match(text, /工具结果 · read/);
});

test('端到端：readSession 抛错时只记 err，不向上抛', async () => {
  const ctx = {
    on(ev, fn) {
      (this._h ??= {})[ev] = fn;
    },
    sessionQuery: {
      readSession: async () => {
        throw new Error('boom');
      },
    },
    tokenMeter: { measure: () => ({}) },
  };
  apply(ctx, { minIntervalMs: 0 });
  assert.doesNotThrow(() => ctx._h['agent/turn-stopping']({ header: { id: 'session-bad' } }));
  await new Promise((r) => setTimeout(r, 120));
  const logFile = join(home, 'dsh-audit', 'errors.log');
  assert.ok(existsSync(logFile));
  assert.match(readFileSync(logFile, 'utf8'), /boom/);
});
