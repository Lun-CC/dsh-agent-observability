/**
 * 发布包结构测试：这些断言只有「打包后装到别人机器上」才会炸，本地开发全绿也没用。
 *
 * 覆盖：
 *   1. files 白名单必须覆盖插件入口可达的全部相对模块（漏一个 → 装完 import 失败）
 *   2. 离线 CLI 随包发布，且包内副本与仓库根真源逐字一致（仅 import 路径不同）
 *   3. 包内 CLI 能真的跑起来（import 路径在包内解析成功）
 *   4. 发布门控字段、仓库根/插件包版本一致、无 npm 运行期依赖
 *   5. prepack 的打包清单断言本身可通过（prepare-pack → verify-pack → cleanup）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = join(ROOT, 'packages', 'dsh-audit-plugin');
const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'));
const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const covered = (rel) => (pkg.files ?? []).some((f) => rel === f || rel.startsWith(`${f}/`));
const stripNode = (spec) => (spec.startsWith('node:') ? null : spec);

/** files 白名单是否覆盖入口动态可达的全部相对模块 */
function reachableModules(entryRel) {
  const seen = new Set();
  const queue = [entryRel];
  while (queue.length) {
    const rel = queue.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const abs = join(PKG, rel);
    assert.ok(existsSync(abs), `入口可达模块在盘上不存在：${rel}`);
    const text = readFileSync(abs, 'utf8');
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)) {
      const spec = stripNode(m[1]);
      if (!spec || !spec.startsWith('.')) continue;
      queue.push(resolve(dirname(abs), spec).slice(PKG.length + 1).replaceAll('\\', '/'));
    }
  }
  return seen;
}

test('files 白名单覆盖插件入口可达的全部相对模块', () => {
  const mods = reachableModules('lib/index.js');
  assert.ok(mods.size >= 8, `入口可达模块数异常偏少：${mods.size}`);
  for (const rel of mods) {
    assert.ok(covered(rel), `运行期模块未进 files 白名单，装完会 import 失败：${rel}`);
  }
});

test('离线 CLI 随包发布：bin 字段、files 白名单、与根真源逐字一致', () => {
  assert.equal(pkg.bin?.['dsh-audit'], 'bin/dsh-audit.mjs', '包必须声明 dsh-audit 命令（不带 ./ 前缀，npm publish 会移除 ./-前缀的 bin）');
  assert.ok(covered('bin/dsh-audit.mjs'), 'bin/dsh-audit.mjs 必须在 files 白名单里（否则命令不存在）');

  const pkgCli = readFileSync(join(PKG, 'bin', 'dsh-audit.mjs'), 'utf8');
  const rootCli = readFileSync(join(ROOT, 'bin', 'dsh-audit.mjs'), 'utf8');
  const expected = rootCli.replace(/from '\.\.\/src\/lib\/([^']+)'/g, "from '../lib/core/$1'");

  assert.equal(pkgCli, expected, '包内 CLI 与仓库根 CLI 漂移了：请运行 node scripts/sync-core.mjs');
  assert.ok(pkgCli.startsWith('#!/usr/bin/env node'), 'CLI 缺 shebang，装完会「不是可执行文件」');
  assert.ok(!pkgCli.includes('../src/'), '包内 CLI 残留 ../src/ 引用');
  assert.match(pkgCli, /from '\.\.\/lib\/core\/session\.mjs'/);
});

test('包内 CLI 能直接运行（import 在包内解析成功）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-audit-pack-'));
  const sessionDir = join(dir, '--E-x--', 'session-pack-fixture');
  mkdirSync(sessionDir, { recursive: true });
  const usage = (input, cacheRead, output) => ({
    inputTokens: input,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: 0,
    outputTokens: output,
    totalTokens: input + cacheRead + output,
  });
  const events = [
    { type: 'session', seq: 0, time: 1, version: 4, id: 'session-pack-fixture', cwd: '/x', agentPreset: 'standard' },
    { type: 'assistant/message', seq: 1, time: 2, data: { turn: 1, step: 1, usage: usage(1000, 0, 100) } },
    { type: 'assistant/message', seq: 2, time: 3, data: { turn: 1, step: 2, usage: usage(50, 1000, 60) } },
  ];
  const frame = zstdCompressSync(Buffer.from(events.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8'));
  writeFileSync(join(sessionDir, 'session.v4.jsonl.zstd'), frame);

  const out = execFileSync(process.execPath, [join(PKG, 'bin', 'dsh-audit.mjs'), sessionDir, '--json'], {
    encoding: 'utf8',
  });
  const [r] = JSON.parse(out);
  assert.equal(r.totals.requests, 2);
  assert.equal(r.totals.totalReal, 1100 + 1110);
});

test('发布门控：版本一致、engines、bundle patch、无 npm 运行期依赖', () => {
  assert.equal(pkg.version, rootPkg.version, '仓库根与插件包版本必须一致');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.ok(pkg.engines?.node, '缺 engines.node');
  assert.ok(pkg.engines?.dsh, '缺 engines.dsh');
  assert.equal(pkg.dsh?.manifestVersion, 1);
  assert.ok(pkg.dsh?.bundle?.patch, '缺 dsh.bundle.patch');
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.publishConfig?.access, 'public');
  assert.notEqual(pkg.private, true);
  assert.ok(pkg.author, '缺 author');
  assert.ok(typeof pkg.description === 'string' && pkg.description.length >= 40);

  for (const g of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = pkg[g];
    assert.ok(!deps || Object.keys(deps).length === 0, `插件不应有 ${g}（宿主已提供全部能力）`);
  }
});

test('files 白名单不夹带开发期文件', () => {
  const allowed = new Set(['lib', 'bin', 'cordis.patch.yml', 'README.md', 'README.en.md', 'CHANGELOG.md', 'LICENSE', 'icon']);
  for (const f of pkg.files ?? []) assert.ok(allowed.has(f), `files 白名单包含非发布内容：${f}`);
  // 发布内容必须在盘上真实存在
  for (const rel of ['README.md', 'README.en.md', 'LICENSE', 'icon', 'cordis.patch.yml']) {
    assert.ok(existsSync(join(PKG, rel)), `发布内容缺失：${rel}`);
  }
  assert.ok(statSync(join(PKG, 'README.en.md')).size < 12 * 1024, '英文 README 过大，npm 包应保持精简');
});

test('prepack 的打包清单断言可通过（prepare-pack → verify-pack → cleanup）', () => {
  const run = (script) => execFileSync(process.execPath, [join(ROOT, 'scripts', script)], { encoding: 'utf8', stdio: 'pipe' });
  try {
    run('prepare-pack.mjs');
    const out = run('verify-pack.mjs');
    assert.match(out, /打包清单校验通过/);
  } finally {
    run('cleanup-pack.mjs');
  }
  assert.ok(!existsSync(join(PKG, 'CHANGELOG.md')), 'postpack 之后不应残留临时 CHANGELOG.md');
});
