/**
 * 插件冒烟测试：用假 ctx 验证 apply() 不抛错、能挂事件、能写探针记录。
 * 真实宿主行为在 docs/evidence 里记录，这里只锁"不添乱"这条底线。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-audit-home-'));
process.env.DSH_HOME = home;

const { apply, name, inject } = await import('../packages/dsh-audit-probe/lib/index.js');

function fakeCtx() {
  const handlers = new Map();
  return {
    handlers,
    on(ev, fn) {
      const list = handlers.get(ev) ?? [];
      list.push(fn);
      handlers.set(ev, list);
    },
    tokenMeter: {
      measure() {
        return {
          logRevision: 12,
          baseline: { kind: 'usage' },
          totalTokens: 9640,
          surfaceTokens: 9500,
          surfaceDeltaTokens: 140,
          nodes: [
            { seq: 3, tokens: 120, heuristicTokens: 118 },
            { seq: 7, tokens: 80, heuristicTokens: 80 },
          ],
        };
      },
    },
    sessions: {},
  };
}

test('插件元数据齐全，且声明了必需的服务注入', () => {
  assert.equal(name, 'dsh-audit-probe');
  // 实测结论：Cordis 下不 inject 就读不到服务（抛 cannot get property ... without inject），
  // 所以 inject 不能是空数组，必须显式声明要用的三个服务。
  assert.deepEqual([...inject].sort(), ['sessionQuery', 'sessions', 'tokenMeter']);
});

test('apply 不抛错并挂上事件', () => {
  const ctx = fakeCtx();
  assert.doesNotThrow(() => apply(ctx, {}));
  assert.ok(ctx.handlers.get('session/flush')?.length >= 1, '应挂上 session/flush');
});

test('session/flush 时记录 measure 结果与 baseline.kind', () => {
  const ctx = fakeCtx();
  apply(ctx, {});
  for (const fn of ctx.handlers.get('session/flush')) fn({ session: { id: 'session-x' }, sessionId: 'session-x' });

  const file = join(home, 'dsh-audit', 'probe.jsonl');
  assert.ok(existsSync(file), '应写出 probe.jsonl');
  const records = readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  assert.ok(records.some((r) => r.phase === 'loaded'));
  assert.ok(records.some((r) => r.phase === 'services'));
  const m = records.find((r) => r.phase === 'measure' && r.ok);
  assert.ok(m, '应有一条成功的 measure 记录');
  assert.equal(m.baselineKind, 'usage');
  assert.equal(m.nodeCount, 2);
});

test('缺少 tokenMeter 时不抛错，只记一条原因', () => {
  const ctx = fakeCtx();
  delete ctx.tokenMeter;
  assert.doesNotThrow(() => apply(ctx, {}));
  for (const fn of ctx.handlers.get('session/flush')) fn({ session: { id: 's' } });
  const records = readFileSync(join(home, 'dsh-audit', 'probe.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.ok(records.some((r) => r.phase === 'measure' && r.ok === false));
});
