/**
 * 整改（一键应用/撤销）测试。
 *
 * 这套逻辑会写用户磁盘上的配置，所以测试要盯三件事：
 *   1. 只追加带标记的块，不动用户原有内容
 *   2. 幂等：重复应用不重复写
 *   3. 撤销能整块删掉，恢复到应用前的样子
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyFix, revertFix, previewFix, resolveProfileDir, appliedFixes, decorateFixes, FIX_RULES } from '../packages/dsh-audit-plugin/lib/fixes.mjs';

const ORIGINAL_PATCH = `# 用户自己的 patch
- insert:
    - id: dsh-cost-audit
      name: dsh-audit-plugin
`;

/** 造一个最小可用 DSH_HOME：profiles/web 里装着本插件。 */
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'dca-fix-'));
  const profile = join(home, 'profiles', 'web');
  mkdirSync(profile, { recursive: true });
  writeFileSync(
    join(profile, 'package.json'),
    JSON.stringify({ dependencies: { 'dsh-audit-plugin': 'file:x' }, dsh: { profile: { bundles: ['dsh-audit-plugin'] } } }, null, 2),
  );
  writeFileSync(join(profile, 'cordis.patch.yml'), ORIGINAL_PATCH);
  const project = join(home, 'project');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', build: 'tsc' } }, null, 2));
  return { home, profile, project };
}

test('能定位到装着本插件的 profile', () => {
  const { home, profile } = makeHome();
  assert.equal(resolveProfileDir(home).dir, profile);
});

test('多 profile：不按 mtime 猜，报歧义并列出候选', () => {
  const { home, profile } = makeHome();
  const other = join(home, 'profiles', 'desktop');
  mkdirSync(other, { recursive: true });
  writeFileSync(
    join(other, 'package.json'),
    JSON.stringify({ dependencies: { 'dsh-audit-plugin': 'file:x' }, dsh: { profile: { bundles: ['dsh-audit-plugin'] } } }, null, 2),
  );
  // 把另一个 profile 的 mtime 改得更新：旧实现会选它，新实现必须拒绝
  writeFileSync(join(other, 'cordis.patch.yml'), '# desktop 自己\n');

  const pick = resolveProfileDir(home);
  assert.equal(pick.dir, null);
  assert.equal(pick.ambiguous, true);
  assert.deepEqual(pick.profiles.map((p) => p.name), ['desktop', 'web']);

  const r = applyFix('spill', { dshHome: home });
  assert.equal(r.changed, false);
  assert.equal(r.ambiguous, true);
  assert.match(r.message, /desktop/);
  assert.match(r.message, /web/);
  // 两个文件都必须原封不动
  assert.equal(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8'), ORIGINAL_PATCH);
  assert.equal(readFileSync(join(other, 'cordis.patch.yml'), 'utf8'), '# desktop 自己\n');
});

test('多 profile：显式选一个才写，且只写选中的那个', () => {
  const { home, profile } = makeHome();
  const other = join(home, 'profiles', 'desktop');
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'package.json'), JSON.stringify({ dependencies: { 'dsh-audit-plugin': 'file:x' } }, null, 2));
  writeFileSync(join(other, 'cordis.patch.yml'), '# desktop 自己\n');

  const wrong = applyFix('spill', { dshHome: home, profile: 'nope' });
  assert.equal(wrong.changed, false);
  assert.match(wrong.message, /没有装本插件/);

  const r = applyFix('spill', { dshHome: home, profile: 'web' });
  assert.equal(r.changed, true);
  assert.equal(r.file, join(profile, 'cordis.patch.yml'));
  assert.match(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8'), /spill-policy/);
  assert.equal(readFileSync(join(other, 'cordis.patch.yml'), 'utf8'), '# desktop 自己\n');
});

test('目标 patch 不是 UTF-8（GBK/UTF-16/BOM）时拒绝写入且不改文件', () => {
  const { home, profile } = makeHome();
  const file = join(profile, 'cordis.patch.yml');
  const gbk = Buffer.from([0x23, 0x20, 0xd6, 0xd0, 0xce, 0xc4, 0x0a]); // "# 中文" 的 GBK 字节
  writeFileSync(file, gbk);

  const r = applyFix('spill', { dshHome: home });
  assert.equal(r.changed, false);
  assert.match(r.message, /不是合法 UTF-8/);
  assert.deepEqual(readFileSync(file), gbk, '编码不认识时必须原样保留');
  assert.equal(readdirSync(profile).filter((f) => f.includes('.bak-')).length, 0, '拒绝时不该留备份');
});

test('AGENTS.md 不是 UTF-8 时拒绝自动写，并给出可手动粘贴的片段', () => {
  const { home, project } = makeHome();
  const file = join(project, 'AGENTS.md');
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]);
  writeFileSync(file, gbk);

  const r = applyFix('heavy-ingest', { dshHome: home, cwd: project });
  assert.equal(r.changed, false);
  assert.match(r.message, /可手动在文件末尾追加/);
  assert.match(r.message, /读代码前先用 glob/);
  assert.deepEqual(readFileSync(file), gbk);
});

test('应用配置类整改：只追加带标记的块', () => {
  const { home, profile } = makeHome();
  const r = applyFix('spill', { dshHome: home });

  assert.equal(r.changed, true);
  const text = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8');
  assert.ok(text.startsWith(ORIGINAL_PATCH.trimEnd()), '原有内容必须原样保留');
  assert.match(text, /# >>> dsh-cost-audit:spill/);
  assert.match(text, /- id: spill-policy/);
  assert.match(text, /maxInlineTokens: 3000/);
  assert.match(text, /# <<< dsh-cost-audit:spill/);

  // 备份存在
  const backups = readdirSync(profile).filter((f) => f.includes('.bak-'));
  assert.equal(backups.length, 1);
});

test('幂等：重复应用不重复写入', () => {
  const { home, profile } = makeHome();
  applyFix('spill', { dshHome: home });
  const once = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8');
  const again = applyFix('spill', { dshHome: home });

  assert.equal(again.changed, false);
  assert.match(again.message, /已经应用过了/);
  assert.equal(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8'), once);
});

test('撤销：整块删除，其它内容不动', () => {
  const { home, profile } = makeHome();
  applyFix('spill', { dshHome: home });
  const r = revertFix('spill', { dshHome: home });

  assert.equal(r.changed, true);
  const text = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8');
  assert.equal(text.trim(), ORIGINAL_PATCH.trim(), '撤销后应回到原样');
  assert.doesNotMatch(text, /dsh-cost-audit:spill/);
});

test('tool-result-pruner：同时写 disabled 与完整 config', () => {
  const { home, profile } = makeHome();
  applyFix('context-growth', { dshHome: home });
  const text = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8');
  // patch 的 config 是整体替换，三个键缺一不可
  assert.match(text, /disabled: false/);
  assert.match(text, /thresholdChars: 4096/);
  assert.match(text, /headChars: 2048/);
  assert.match(text, /tailChars: 512/);
});

test('AGENTS.md 类整改：用真实 cwd 与 package.json 命令', () => {
  const { home, project } = makeHome();
  const r = applyFix('barren-steps', { dshHome: home, cwd: project });

  assert.equal(r.changed, true);
  const text = readFileSync(join(project, 'AGENTS.md'), 'utf8');
  assert.match(text, /<!-- dsh-cost-audit:barren-steps -->/);
  assert.ok(text.includes(project), '应写入真实仓库路径');
  assert.match(text, /npm run test/);
  assert.match(text, /npm run build/);

  const back = revertFix('barren-steps', { dshHome: home, cwd: project });
  assert.equal(back.changed, true);
  assert.doesNotMatch(readFileSync(join(project, 'AGENTS.md'), 'utf8'), /dsh-cost-audit:barren-steps/);
});

test('读入类整改写的是约定而不是占位空话', () => {
  const { home, project } = makeHome();
  applyFix('heavy-ingest', { dshHome: home, cwd: project });
  const text = readFileSync(join(project, 'AGENTS.md'), 'utf8');
  assert.match(text, /glob/);
  assert.match(text, /offset \/ limit/);
});

test('预览给出目标文件与将写入的内容，且不落盘', () => {
  const { home, project, profile } = makeHome();
  const before = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8');
  const pv = previewFix('spill', { profileDir: profile, cwd: project });

  assert.equal(pv.kind, 'patch');
  assert.equal(pv.target, join(profile, 'cordis.patch.yml'));
  assert.match(pv.text, /spill-policy/);
  assert.equal(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8'), before, '预览不能改文件');
  void home;
});

test('decorateFixes 标出哪些能自动改、是否已应用', () => {
  const { home, profile } = makeHome();
  applyFix('spill', { dshHome: home });
  const list = decorateFixes(
    [{ id: 'spill' }, { id: 'cache' }, { id: 'context-growth' }],
    { profileDir: profile },
  );
  assert.equal(list[0].fix.applied, true);
  assert.equal(list[1].fix, null, '缓存类只能人工判断，不硬给自动方案');
  assert.equal(list[2].fix.applied, false);
});

test('没有 profile 时应用失败但不抛异常', () => {
  const empty = mkdtempSync(join(tmpdir(), 'dca-empty-'));
  const r = applyFix('spill', { dshHome: empty });
  assert.equal(r.changed, false);
  assert.match(r.message, /找不到/);
});

test('所有整改规则都有标题与目标类型', () => {
  for (const [id, rule] of Object.entries(FIX_RULES)) {
    assert.ok(rule.title, `${id} 缺 title`);
    assert.ok(['patch', 'agents'].includes(rule.kind), `${id} kind 非法`);
    if (rule.kind === 'patch') assert.ok(rule.entry, `${id} 缺 entry`);
  }
});

// ── API 层 ────────────────────────────────────────────────────────────

const home = mkdtempSync(join(tmpdir(), 'dca-api-'));
process.env.DSH_HOME = home;

const { apply, inject } = await import('../packages/dsh-audit-plugin/lib/index.js');

function fakeCtxWithRoutes() {
  const handlers = {};
  const routes = new Map();
  const ctx = {
    _h: handlers,
    on: (e, f) => (handlers[e] = f),
    get: (n) => (n === 'webServer' ? ctx._webServer : undefined),
    sessionQuery: {
      readSession: async (id) => ({
        session: { id, cwd: 'E:\\x', createdAt: 1, version: 4, agentPreset: 'standard' },
        inheritedEventCount: 0,
        events: [{ seq: 2, type: 'assistant/message', time: 2, data: { turn: 1, step: 1, usage: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1, totalTokens: 11 } } }],
      }),
    },
  };
  ctx._webServer = { register: (r) => routes.set(r.path, r), tapIndex: () => () => {} };
  return { ctx, routes };
}

/** 假 req：事件流 + headers，够 readJsonBody 用。 */
function fakeReq({ method = 'GET', headers = {}, body = null } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = '/dsh-cost-audit/api/fix';
  req.headers = { host: '127.0.0.1:3080', ...headers };
  req.removeListener = req.off.bind(req);
  if (body) setTimeout(() => { req.emit('data', JSON.stringify(body)); req.emit('end'); }, 0);
  else setTimeout(() => req.emit('end'), 0);
  return req;
}

async function callRoute(route, req) {
  const res = {
    statusCode: 200,
    _h: {},
    setHeader(k, v) { this._h[k.toLowerCase()] = v; },
    end(b) { this._body = b; },
  };
  await route.handler(req, res);
  return { status: res.statusCode, body: res._body };
}

test('API：GET 方法被拒，缺 x-dsh-audit 头被拒（CSRF 防线）', async () => {
  const { ctx, routes } = fakeCtxWithRoutes();
  apply(ctx, { ui: true });
  const route = routes.get('/dsh-cost-audit/api/fix');
  assert.ok(route, '应注册 /api/fix');

  const get = await callRoute(route, fakeReq({ method: 'GET' }));
  assert.equal(get.status, 405);

  const noHeader = await callRoute(route, fakeReq({ method: 'POST', body: { id: 'spill', action: 'apply' } }));
  assert.equal(noHeader.status, 403);
});

test('API：带正确头时可以预览（不落盘）', async () => {
  const { ctx, routes } = fakeCtxWithRoutes();
  apply(ctx, { ui: true });
  const route = routes.get('/dsh-cost-audit/api/fix');

  const r = await callRoute(route, fakeReq({ method: 'POST', headers: { 'x-dsh-audit': '1' }, body: { id: 'spill', action: 'preview', cwd: home } }));
  assert.equal(r.status, 200);
  const data = JSON.parse(r.body);
  assert.equal(data.ok, true);
  assert.match(data.preview.text, /spill-policy/);
});

test('API：多 profile 时无 profile 拒绝写入并列出候选；显式 profile 只写选中', async () => {
  const { ctx, routes } = fakeCtxWithRoutes();
  apply(ctx, { ui: true });
  const a = join(home, 'profiles', 'web');
  const b = join(home, 'profiles', 'desktop');
  const pkg = JSON.stringify({ dependencies: { 'dsh-audit-plugin': 'file:x' }, dsh: { profile: { bundles: ['dsh-audit-plugin'] } } });
  for (const [dir, text] of [[a, '# web\n'], [b, '# desktop\n']]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), pkg);
    writeFileSync(join(dir, 'cordis.patch.yml'), text);
  }
  const route = routes.get('/dsh-cost-audit/api/fix');

  const r1 = await callRoute(route, fakeReq({ method: 'POST', headers: { 'x-dsh-audit': '1' }, body: { id: 'spill', action: 'apply' } }));
  const d1 = JSON.parse(r1.body);
  assert.equal(d1.changed, false);
  assert.equal(d1.ambiguous, true);
  assert.match(d1.message, /web/);
  assert.match(d1.message, /desktop/);
  assert.equal(readFileSync(join(a, 'cordis.patch.yml'), 'utf8'), '# web\n', '拒绝时不能动任何文件');

  const r2 = await callRoute(route, fakeReq({ method: 'POST', headers: { 'x-dsh-audit': '1' }, body: { id: 'spill', action: 'apply', profile: 'desktop' } }));
  const d2 = JSON.parse(r2.body);
  assert.equal(d2.changed, true);
  assert.match(readFileSync(join(b, 'cordis.patch.yml'), 'utf8'), /spill-policy/);
  assert.equal(readFileSync(join(a, 'cordis.patch.yml'), 'utf8'), '# web\n', '只写选中的 profile');
});

void inject;
