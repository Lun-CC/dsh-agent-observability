/**
 * 打包清单断言（prepack 的最后一步）。
 *
 * 为什么不直接跑 `npm pack --dry-run`：prepack 阶段跑 pack 会递归触发 prepack。
 * 所以这里做**静态**校验：按 package.json 的 files 白名单，逐个断言必需文件
 * 真实存在于盘上，并检查发布门控字段与版本一致性。
 *
 * 用法：node scripts/verify-pack.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
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
  'cordis.patch.yml',
  'README.md',
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

// 发布门控
if (!pkg.engines?.dsh) fail('缺 engines.dsh —— 无兼容门控，任何 dsh 版本都会加载');
if (pkg.dsh?.manifestVersion !== 1) fail('缺 dsh.manifestVersion: 1');
if (!pkg.dsh?.bundle?.patch) fail('缺 dsh.bundle.patch —— 插件页不会显示');
if (!pkg.icon) fail('缺 icon 字段');
if (pkg.license !== 'MIT') fail('license 字段应为 MIT');
if (pkg.publishConfig?.access !== 'public') fail('缺 publishConfig.access: public');
if (pkg.private === true) fail('private: true 会导致无法发布');

// 版本一致性
if (pkg.version !== rootPkg.version) {
  fail(`版本不一致：包 ${pkg.version} vs 仓库根 ${rootPkg.version}`);
}

// 包名与条目 id 不应与已发布的 dsh-audit 冲突
const patchText = readFileSync(join(PKG, 'cordis.patch.yml'), 'utf8');
if (/- id:\s*dsh-audit\s*$/m.test(patchText)) {
  fail('cordis.patch.yml 的条目 id 仍是 dsh-audit（与 npm 上同名包冲突），应为 dsh-cost-audit');
}

if (problems.length) {
  console.error('打包清单校验失败：');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`打包清单校验通过：${requireFiles.length} 个文件齐备，门控字段与版本一致（${pkg.version}）`);
