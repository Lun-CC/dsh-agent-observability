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
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-audit-ui-'));
process.env.DSH_HOME = home;

const { apply, writeAtomic } = await import('../packages/dsh-audit-plugin/lib/index.js');
const { renderPage, injectEntry, ENTRY_JS, ENTRY_SNIPPET } = await import('../packages/dsh-audit-plugin/lib/webui.mjs');

const usage = (i, c, o) => ({ inputTokens: i, cacheReadTokens: c, cacheWriteTokens: 0, outputTokens: o, totalTokens: i + c + o });

function snapshot(id, parentId = null) {
  return {
    session: { id, cwd: 'E:\\x', createdAt: 1, version: 4, agentPreset: 'standard', parentId },
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
  const effects = [];
  return {
    _h: handlers,
    _routes: routes,
    _taps: taps,
    _effects: effects,
    on(ev, fn) {
      handlers[ev] = fn;
    },
    // 模拟 Cordis Fiber#effect：execute 返回 disposer，dispose 时调用
    effect(execute) {
      const d = execute();
      effects.push(d);
      return () => {
        const i = effects.indexOf(d);
        if (i !== -1) effects.splice(i, 1);
        if (typeof d === 'function') d();
      };
    },
    get(name) {
      if (name === 'webServer') return this._webServer;
      if (name === 'tokenMeter') return { measure: () => ({ logRevision: 1, baseline: { kind: 'usage' }, totalTokens: 1, surfaceTokens: 1, nodes: [] }) };
      return undefined;
    },
    sessionQuery: { readSession: async (id) => snapshot(id, id.includes('child') ? 'session-ui' : null) },
    // 模拟 Cordis 的 inject：依赖就绪后触发回调。默认同步触发；用例可关闭后手动触发，
    // 以覆盖「apply 时 webServer 尚未就绪」的分支。
    inject(names, cb) {
      this._injected = names;
      this._injectCb = cb;
      if (this._autoInject) cb(this);
    },
    _autoInject: true,
    _webServer: {
      register(route) {
        // 与 dsh-host-webserver 一致：重复注册是硬错误（errors.log 里那批 duplicate 就是它）
        if (routes.has(route.path)) throw new Error(`webserver: duplicate exact route "${route.path}"`);
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
      tapIndex(fn) {
        taps.push(fn);
        return () => {
          const i = taps.indexOf(fn);
          if (i !== -1) taps.splice(i, 1);
        };
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

test('页面内联脚本可被解析（模板写错会整页白屏）', () => {
  const page = renderPage();
  const m = page.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, '页面应有内联脚本');
  assert.doesNotThrow(() => new Function(m[1]), '内联脚本必须语法正确');
  const entry = ENTRY_JS.match(/^\(function/);
  assert.ok(entry, '入口脚本应是可执行表达式');
  assert.doesNotThrow(() => new Function(ENTRY_JS));
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

test('api/list 暴露 profile 与 lastError（静默失败在页面可见）', async () => {
  const ctx = await bootWithReport();
  const first = JSON.parse((await call(ctx._routes.get('/dsh-cost-audit/api/list'))).body);
  assert.ok(first.profile && Array.isArray(first.profile.profiles), '返回 profile 候选');
  assert.equal(first.lastError, null);

  // 模拟宿主事件形状变化（宿主升级后 flush 载荷变了）
  ctx._h['session/flush']({ header: {} });
  await tick(30);

  const second = JSON.parse((await call(ctx._routes.get('/dsh-cost-audit/api/list'))).body);
  assert.ok(second.lastError, '形状变化必须留下 lastError，否则页面只显示空');
  assert.equal(second.lastError.phase, 'trigger');
  assert.match(second.lastError.message, /header\.id/);
  assert.match(readFileSync(join(home, 'dsh-audit', 'errors.log'), 'utf8'), /header\.id/);
});

test('摘要带结构化建议（标签 + 动作 + 可省区间）', async () => {
  await bootWithReport();
  const s = JSON.parse(readFileSync(join(home, 'dsh-audit', 'report-session-ui.json'), 'utf8'));
  assert.ok(Array.isArray(s.prescriptions));
  assert.equal(s.rootId, 'session-ui');
  assert.equal(s.top, true);
  // 首屏那句话必须短：它不是 headline，不能把数字再抄一遍
  assert.ok(typeof s.verdict === 'string' && s.verdict.length > 0);
  assert.ok(s.verdict.length < 60, `verdict 应短，实际 ${s.verdict.length} 字：${s.verdict}`);
  assert.doesNotMatch(s.verdict, /实测 .* token \/ .* 次请求/, 'verdict 不该重复账单数字');
});

test('一次对话 = 一条记录：subagent 归到主会话下', async () => {
  const ctx = await bootWithReport();
  // 子会话（parentId 指向主会话）
  ctx._h['session/flush']({ header: { id: 'session-ui-child', parentId: 'session-ui', delegationDepth: 1 }, log: {} });
  await tick(160);

  const list = await call(ctx._routes.get('/dsh-cost-audit/api/list'));
  const data = JSON.parse(list.body);
  const conv = data.conversations.find((c) => c.rootId === 'session-ui');
  assert.ok(conv, '应有 session-ui 这条对话');
  assert.equal(conv.sessions, 2, '主会话 + 1 个子会话');
  assert.equal(conv.subSessions, 1);
  assert.equal(conv.primaryId, 'session-ui', '详情入口应是主会话，不是 subagent');
  assert.equal(data.conversations.length, 1, '同一次对话不应被拆成两条');

  // 详情里能拿到子会话成本
  const rep = await call(ctx._routes.get('/dsh-cost-audit/api/report'), { url: '/dsh-cost-audit/api/report?id=session-ui' });
  const detail = JSON.parse(rep.body);
  assert.equal(detail.siblings.length, 1);
  assert.equal(detail.siblings[0].id, 'session-ui-child');
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

test('apply 返回反注册函数：dispose 后路由与 tapIndex 全部撤销', () => {
  const ctx = fakeCtx();
  const off = apply(ctx, { minIntervalMs: 0 });
  assert.equal(
    typeof off,
    'function',
    'apply 必须返回反注册函数（Cordis effect body）：宿主 dispose 插件后不撤销路由，HMR/重复 apply 会撞 duplicate',
  );
  assert.equal(ctx._routes.size, 5);
  assert.equal(ctx._taps.length, 1);
  off();
  assert.equal(ctx._routes.size, 0, 'dispose 后必须撤销全部路由');
  assert.equal(ctx._taps.length, 0, 'dispose 后必须撤销 tapIndex 注入');
  assert.doesNotThrow(() => off(), '反注册必须幂等（Cordis 可能调用两次）');
});

test('宿主 Cordis 生命周期：ctx.effect 注册的反注册钩子在 dispose 时调用', () => {
  const ctx = fakeCtx();
  apply(ctx, { minIntervalMs: 0 });
  assert.equal(ctx._effects.length, 1, '应通过 ctx.effect 注册一个反注册钩子');
  ctx._effects[0](); // 模拟宿主 fiber dispose 插件
  assert.equal(ctx._routes.size, 0, 'fiber dispose 后路由必须撤销');
  assert.equal(ctx._taps.length, 0, 'fiber dispose 后 tapIndex 必须移除');
  assert.doesNotThrow(() => ctx._effects[0]());
});

test('重复 apply（HMR / dshmarket hot-mount）不产生 duplicate route', async () => {
  const outDir = join(home, 'dsh-audit');
  const errFile = join(outDir, 'errors.log');
  const before = existsSync(errFile) ? readFileSync(errFile, 'utf8') : '';
  const ctx = fakeCtx();
  const off1 = apply(ctx, { minIntervalMs: 0 });
  off1();
  const off2 = apply(ctx, { minIntervalMs: 0 }); // 模拟宿主卸载插件后再次 apply
  assert.equal(ctx._routes.size, 5, '重新 apply 后应仍是 5 条路由，而不是叠加成 10 条');
  assert.equal(ctx._taps.length, 1, 'tapIndex 不应重复注入');
  off2();
  const after = existsSync(errFile) ? readFileSync(errFile, 'utf8') : '';
  const added = after.slice(before.length);
  assert.doesNotMatch(added, /route:register/, `重复 apply 不应注册失败：${added}`);
  assert.doesNotMatch(added, /duplicate/, `重复 apply 不应出现 duplicate 路由：${added}`);
});

test('webServer 未就绪时等 inject 回调注册，回调重复触发也只注册一次', () => {
  const ctx = fakeCtx();
  const server = ctx._webServer;
  ctx._webServer = undefined; // apply 时 webServer 还没就绪
  ctx._autoInject = false;
  const off = apply(ctx, { minIntervalMs: 0 });
  assert.deepEqual(ctx._injected, ['webServer'], '应通过 ctx.inject 等待 webServer');
  assert.equal(ctx._routes.size, 0, 'webServer 未就绪时不应注册路由');

  ctx._webServer = server;
  ctx._injectCb(ctx); // 宿主 webServer 就绪后触发注入回调
  assert.equal(ctx._routes.size, 5);
  assert.equal(ctx._taps.length, 1);
  ctx._injectCb(ctx); // 宿主重复触发：wire 幂等，不能再注册一遍
  assert.equal(ctx._routes.size, 5, '重复触发注入回调不应叠加路由');
  assert.equal(ctx._taps.length, 1, '重复触发注入回调不应重复注入 index');

  off();
  assert.equal(ctx._routes.size, 0);
  assert.equal(ctx._taps.length, 0);
});

test('ui:false 时不注册任何路由（插件仍写报告）', async () => {
  const ctx = fakeCtx();
  apply(ctx, { minIntervalMs: 0, ui: false });
  ctx._h['session/flush']({ header: { id: 'session-noui' }, log: {} });
  await tick();
  assert.equal(ctx._routes.size, 0);
  assert.ok(existsSync(join(home, 'dsh-audit', 'report-session-noui.txt')));
});

test('写盘为临时文件 + rename 原子写：无 .tmp- 残留，latest.txt 带 ISO 生成时间', async () => {
  await bootWithReport();
  const outDir = join(home, 'dsh-audit');
  const names = readdirSync(outDir);
  const leftovers = names.filter((n) => n.includes('.tmp-'));
  assert.deepEqual(leftovers, [], `写盘失败会残留半截临时文件：${leftovers.join(', ')}`);

  const latestJson = JSON.parse(readFileSync(join(outDir, 'latest.json'), 'utf8'));
  assert.ok(latestJson.generatedAt, 'latest.json 必须有 generatedAt，否则无法判断报告新旧');
  const latestTxt = readFileSync(join(outDir, 'latest.txt'), 'utf8');
  assert.match(
    latestTxt,
    /生成时间 \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    'latest.txt 必须带 ISO 生成时间（用户要能判断这份报告有多旧）',
  );
  // 会话报告 txt/json 成对出现且 json 可解析
  for (const ext of ['txt', 'json']) assert.ok(existsSync(join(outDir, `report-session-ui.${ext}`)));
  assert.equal(JSON.parse(readFileSync(join(outDir, 'report-session-ui.json'), 'utf8')).id, 'session-ui');
});

test('writeAtomic rename 失败时清掉临时文件并抛出', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-audit-atomic-'));
  const target = join(dir, 'target-is-a-dir');
  mkdirSync(target); // rename 到目录上必然失败
  assert.throws(() => writeAtomic(target, 'hello'));
  const leftovers = readdirSync(dir).filter((n) => n.includes('.tmp-'));
  assert.deepEqual(leftovers, [], 'rename 失败后必须清掉临时文件，否则会被 prune/listSummaries 扫到');
});

test('errors.log 超过阈值时按写盘时机轮转（不是只在启动时检查）', async () => {
  const ctx = fakeCtx();
  apply(ctx, { minIntervalMs: 0, ui: false, debugTriggers: true, maxErrorLogBytes: 400 });
  for (let i = 0; i < 12; i++) ctx._h['session/flush']({ header: { id: `session-rot-${i}` }, log: {} });
  await tick(120);
  const outDir = join(home, 'dsh-audit');
  const rotated = join(outDir, 'errors.log.1');
  assert.ok(existsSync(rotated), '超过 maxErrorLogBytes 后应轮转到 errors.log.1');
  assert.ok(statSync(rotated).size > 0, '轮转档不应为空');
  // 轮转是在「追加前」检查的：当前文件最多超出阈值一行
  const size = statSync(join(outDir, 'errors.log')).size;
  assert.ok(size <= 400 + 200, `轮转后当前 errors.log 应回落到阈值附近，实际 ${size} B`);
});
