/**
 * 打包清单断言（prepack 的最后一步）。
 *
 * 为什么不直接跑 `npm pack --dry-run`：prepack 阶段跑 pack 会递归触发 prepack。
 * 所以这里做**静态**校验：按 package.json 的 files 白名单，逐个断言必需文件
 * 真实存在于盘上，并检查发布门控字段、版本一致性、离线 CLI 的派生成分。
 *
 * 用法：node scripts/verify-pack.mjs
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = join(ROOT, 'packages', 'dsh-audit-plugin');
const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'));
const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const problems = [];
const fail = (msg) => problems.push(msg);

/** files 白名单里的路径必须存在（目录只要求非空） */
const requireFiles = [
  'lib/index.js',
  'lib/adapter.mjs',
  'lib/webui.mjs',
  'lib/fixes.mjs',
  'lib/core/analyze.mjs',
  'lib/core/session.mjs',
  'lib/core/prescribe.mjs',
  'lib/core/report.mjs',
  'bin/dsh-audit.mjs',
  'cordis.patch.yml',
  'README.md',
  'README.en.md',
  'CHANGELOG.md', // 由 prepare-pack 临时提供
  'LICENSE',
  'icon',
];

for (const rel of requireFiles) {
  if (!existsSync(join(PKG, rel))) fail(`缺文件：${rel}`);
  if (!(pkg.files ?? []).some((f) => rel === f || rel.startsWith(`${f}/`))) {
    fail(`文件不在 files 白名单：${rel}`);
  }
}

// files 白名单不允许夹带开发期文件（源码、测试、脚本、评审）
const ALLOWED_FILES = new Set([
  'lib',
  'bin',
  'cordis.patch.yml',
  'README.md',
  'README.en.md',
  'CHANGELOG.md',
  'LICENSE',
  'icon',
]);
for (const f of pkg.files ?? []) {
  if (!ALLOWED_FILES.has(f)) fail(`files 白名单包含非发布内容：${f}`);
}

// 发布门控
if (!pkg.engines?.dsh) fail('缺 engines.dsh —— 无兼容门控，任何 dsh 版本都会加载');
if (!pkg.engines?.node) fail('缺 engines.node');
if (pkg.dsh?.manifestVersion !== 1) fail('缺 dsh.manifestVersion: 1');
if (!pkg.dsh?.bundle?.patch) fail('缺 dsh.bundle.patch —— 插件页不会显示');
if (!pkg.icon) fail('缺 icon 字段');
if (pkg.license !== 'MIT') fail('license 字段应为 MIT');
if (pkg.publishConfig?.access !== 'public') fail('缺 publishConfig.access: public');
if (pkg.private === true) fail('private: true 会导致无法发布');
if (!pkg.description || pkg.description.length < 40) fail('description 太短（npm 搜索与卡片展示需要）');
if (!pkg.author) fail('缺 author —— 首次公开发布需要作者信息');

// 版本一致性
if (pkg.version !== rootPkg.version) {
  fail(`版本不一致：包 ${pkg.version} vs 仓库根 ${rootPkg.version}`);
}
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) fail(`版本号不是 x.y.z：${pkg.version}`);

// 包名与条目 id 不应与已发布的 dsh-audit 冲突
const patchText = readFileSync(join(PKG, 'cordis.patch.yml'), 'utf8');
if (/- id:\s*dsh-audit\s*$/m.test(patchText)) {
  fail('cordis.patch.yml 的条目 id 仍是 dsh-audit（与 npm 上同名包冲突），应为 dsh-cost-audit');
}

// 运行期不得有 npm 依赖：插件只允许用 node: 内置模块 + 宿主注入的能力
const depGroups = ['dependencies', 'peerDependencies', 'optionalDependencies', 'bundledDependencies'];
for (const g of depGroups) {
  const deps = pkg[g];
  if (Array.isArray(deps) && deps.length) fail(`${g} 不应有内容（${deps.join(', ')}）`);
  if (deps && !Array.isArray(deps) && Object.keys(deps).length) fail(`${g} 不应有内容（${Object.keys(deps).join(', ')}）`);
}

// ─── 离线 CLI 必须随包发布，且与仓库根真源逐字一致（仅 import 路径不同）───
const cliRel = pkg.bin?.['dsh-audit'];
if (cliRel !== 'bin/dsh-audit.mjs') {
  fail(`bin.dsh-audit 应为 bin/dsh-audit.mjs（不要 ./ 前缀：npm publish 会把 ./-前缀的 bin 视为无效并静默移除），实际 ${cliRel ?? '(缺失)'}`);
}
const cliPath = join(PKG, 'bin', 'dsh-audit.mjs');
if (existsSync(cliPath)) {
  const pkgCli = readFileSync(cliPath, 'utf8');
  const rootCli = readFileSync(join(ROOT, 'bin', 'dsh-audit.mjs'), 'utf8');
  const expected = rootCli.replace(/from '\.\.\/src\/lib\/([^']+)'/g, "from '../lib/core/$1'");
  if (pkgCli !== expected) {
    fail('bin/dsh-audit.mjs 与仓库根 CLI 不同步 —— 请重新运行 node scripts/sync-core.mjs');
  }
  if (!pkgCli.startsWith('#!/usr/bin/env node')) fail('bin/dsh-audit.mjs 缺 shebang');
  if (/from '\.\.\/src\//.test(pkgCli)) fail('bin/dsh-audit.mjs 残留 ../src/ 相对引用，tarball 里会断');
  for (const m of pkgCli.matchAll(/from '([^']+)'/g)) {
    const rel = m[1];
    if (!rel.startsWith('.')) continue; // node: 内置
    const target = join(PKG, 'bin', rel);
    if (!existsSync(target)) fail(`bin/dsh-audit.mjs 的 import 目标不存在：${rel}`);
  }
}

// 分析内核必须是 src/lib 的逐字副本
const CORE = ['session.mjs', 'analyze.mjs', 'prescribe.mjs', 'report.mjs'];
for (const f of CORE) {
  const a = readFileSync(join(ROOT, 'src', 'lib', f), 'utf8');
  const b = readFileSync(join(PKG, 'lib', 'core', f), 'utf8');
  if (a !== b) fail(`lib/core/${f} 与 src/lib/${f} 不一致 —— 请重新运行 node scripts/sync-core.mjs`);
}

// 缺文件但白名单是目录时，再兜底断言目录非空
for (const dir of ['lib', 'bin']) {
  const p = join(PKG, dir);
  if (existsSync(p) && readdirSync(p).length === 0) fail(`${dir}/ 是空目录`);
}

if (problems.length) {
  console.error('打包清单校验失败：');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`打包清单校验通过：${requireFiles.length} 个文件齐备，门控字段与版本一致（${pkg.version}）`);
console.log('离线 CLI 已随包发布：bin/dsh-audit.mjs 与仓库根真源一致（仅 import 路径不同）');
