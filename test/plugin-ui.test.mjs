/**
 * Web UI 测试：路由注册、JSON 接口、信任栅栏、入口注入。
 *
 * 用假 webServer / 假 req-res 验证，不依赖真实宿主：
 *   - 路由对象形状 `{ kind:'exact', path, handler(req,res) }` 来自对照实现
 *     （本机已安装的 dsh-whale-widget）
 *   - 入口脚本两种形态：tapIndex（浏览器）/ webserver/index-inject（桌面壳）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-audit-ui-'));
process.env.DSH_HOME = home;

const { apply } = await import('../packages/dsh-audit-plugin/lib/index.js');
const { renderPage, injectEntry, ENTRY_JS, ENTRY_SNIPPET } = await import('../packages/dsh-audit-plugin/lib/webui.mjs');

const usage = (i, c, o) => ({ inputTokens: i, cacheReadTokens: c, cacheWriteTokens: 0, outputTokens: o, totalTokens: i + c + o });

function snapshot(id) {
  return {
    session: { id, cwd: 'E:\\x', createdAt: 1, version: 4, agentPreset: 'standard' },
    inheritedEventCount: 0,
    events: [
      { seq: 2, type: 'assistant/message', time: 2, data: { turn: 1, step: 1, usage: usage(9000, 0, 200) } },
      { seq: 3, type: 'tool/call', time: 3, data: { callId: 'a', name: 'read', turn: 1, step: 1 } },
      { seq: 5, type: 'assistant/message', time: 5, data: { turn: 1, step: 2, usage: usage(120, 9200, 150) } },
    ],
  };
}

function fakeCtx() {
  const handlers = {};
  const routes = new Map();
  const taps = [];
  return {
    _h: handlers,
    _routes: routes,
    _taps: taps,
    on(ev, fn) {
      handlers[ev] = fn;
    },
    get(name) {
      if (name === 'webServer') return this._webServer;
      if (name === 'tokenMeter') return { measure: () => ({ logRevision: 1, baseline: { kind: 'usage' }, totalTokens: 1, surfaceTokens: 1, nodes: [] }) };
      return undefined;
    },
    sessionQuery: { readSession: async (id) => snapshot(id) },
    _webServer: {
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
      tapIndex(fn) {
        taps.push(fn);
        return () => {};
      },
    },
  };
}

/** 假 req/res，返回 { status, headers, body } */
async function call(route, { url = route.path, headers = { host: '127.0.0.1:3080' } } = {}) {
  const res = {
    statusCode: 200,
    _h: {},
    setHeader(k, v) {
      this._h[k.toLowerCase()] = v;
    },
    end(body) {
      this._body = body;
    },
  };
  await route.handler({ url, headers, method: 'GET' }, res);
  return { status: res.statusCode, headers: res._h, body: res._body };
}

const tick = (ms = 90) => new Promise((r) => setTimeout(r, ms));

async function bootWithReport() {
  const ctx = fakeCtx();
  apply(ctx, { minIntervalMs: 0 });
  ctx._h['session/flush']({ header: { id: 'session-ui', parentId: null, delegationDepth: 0 }, log: {} });
  await tick();
  return ctx;
}

test('页面与入口片段自包含、无外部资源', () => {
  const page = renderPage();
  assert.match(page, /^<!doctype html>/i);
  assert.match(page, /\/dsh-cost-audit\/api\/list/);
  assert.doesNotMatch(page, /https?:\/\//, '不应引用外部资源');
  assert.ok(ENTRY_SNIPPET.includes(ENTRY_JS));
  assert.match(ENTRY_JS, /dca-entry/);
});

test('injectEntry 注入到 </body> 前，且幂等', () => {
  const once = injectEntry('<html><body>hi</body></html>');
  assert.ok(once.includes('dca-entry'));
  assert.ok(once.indexOf('dca-entry') < once.indexOf('</body>'));
  assert.equal(injectEntry(once), once, '重复注入应无变化');
});

test('注册 4 条路由并挂上 tapIndex', async () => {
  const ctx = await bootWithReport();
  for (const p of ['/dsh-cost-audit', '/dsh-cost-audit/', '/dsh-cost-audit/api/list', '/dsh-cost-audit/api/report']) {
    assert.ok(ctx._routes.has(p), `缺路由 ${p}`);
  }
  assert.equal(ctx._taps.length, 1);
  assert.ok(ctx._taps[0]('<html><body></body></html>').includes('dca-entry'));
});

test('审计后写出结构化摘要 report-<id>.json 与 latest.json', async () => {
  await bootWithReport();
  const outDir = join(home, 'dsh-audit');
  for (const f of ['report-session-ui.json', 'latest.json']) {
    assert.ok(existsSync(join(outDir, f)), `缺 ${f}`);
    const s = JSON.parse(readFileSync(join(outDir, f), 'utf8'));
    assert.equal(s.id, 'session-ui');
    assert.equal(s.top, true);
    assert.ok(s.generatedAt);
    assert.equal(s.totals.requests, 2);
    assert.ok(typeof s.headline === 'string');
  }
});

test('api/list 返回报告列表与 latest', async () => {
  const ctx = await bootWithReport();
  const r = await call(ctx._routes.get('/dsh-cost-audit/api/list'));
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /application\/json/);
  const data = JSON.parse(r.body);
  assert.ok(Array.isArray(data.reports) && data.reports.length >= 1);
  assert.equal(data.latest, 'session-ui');
  assert.equal(data.reports[0].id, 'session-ui');
});

test('api/report 返回摘要与正文；非法 id 拒绝', async () => {
  const ctx = await bootWithReport();
  const route = ctx._routes.get('/dsh-cost-audit/api/report');

  const ok = await call(route, { url: '/dsh-cost-audit/api/report?id=session-ui' });
  assert.equal(ok.status, 200);
  const d = JSON.parse(ok.body);
  assert.equal(d.summary.id, 'session-ui');
  assert.match(d.text, /实测/);

  const bad = await call(route, { url: '/dsh-cost-audit/api/report?id=../../etc/passwd' });
  assert.equal(bad.status, 400, '路径穿越应被 id 校验拦下');

  const missing = await call(route, { url: '/dsh-cost-audit/api/report?id=session-nope' });
  assert.equal(missing.status, 404);
});

test('信任栅栏：非回环 Host 与非同源 Origin 被拒，回环放行', async () => {
  const ctx = await bootWithReport();
  const route = ctx._routes.get('/dsh-cost-audit/api/list');

  const ok = await call(route);
  assert.equal(ok.status, 200);

  const badOrigin = await call(route, { headers: { host: '127.0.0.1:3080', origin: 'http://evil.example' } });
  assert.equal(badOrigin.status, 403);

  // 非回环 Host 且宿主没提供 connection 栅栏 → fail-closed
  const remote = await call(route, { headers: { host: '10.0.0.5:3080' } });
  assert.equal(remote.status, 403);

  const sameOrigin = await call(route, { headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' } });
  assert.equal(sameOrigin.status, 200);

  // 跨站标记不单独拒绝：接口只读且无 ACAO，跨站读不到响应体；
  // 拒绝它反而会把扩展/程序化打开的标签页挡死（实测过）
  const crossSite = await call(route, { headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' } });
  assert.equal(crossSite.status, 200);
});

test('ui:false 时不注册任何路由（插件仍写报告）', async () => {
  const ctx = fakeCtx();
  apply(ctx, { minIntervalMs: 0, ui: false });
  ctx._h['session/flush']({ header: { id: 'session-noui' }, log: {} });
  await tick();
  assert.equal(ctx._routes.size, 0);
  assert.ok(existsSync(join(home, 'dsh-audit', 'report-session-noui.txt')));
});
