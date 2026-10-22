/**
 * 把 src/lib 的分析内核同步进插件包，并把仓库根的离线 CLI 派生一份进包。
 *
 * 为什么需要这一步：插件会被拷进 profile 的 node_modules 独立运行，
 * 无法相对引用仓库里的 src/lib。复制一份是唯一不改代码结构的办法，
 * 由本脚本保证"只有一份真源"（src/lib、bin/dsh-audit.mjs），
 * 插件里的 lib/core/ 与 bin/ 都是派生物。
 *
 * 1.0.0 起离线 CLI 随 npm 包发布：`dsh-audit` 命令指向派生出来的
 * packages/dsh-audit-plugin/bin/dsh-audit.mjs。派生规则只有一条字符串替换：
 *   `from '../src/lib/x.mjs'`  →  `from '../lib/core/x.mjs'`
 * 除 import 路径外，包内 CLI 必须与仓库根逐字相同（test/cli-pack.test.mjs 断言）。
 *
 * 用法：node scripts/sync-core.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src', 'lib');
const DST = join(ROOT, 'packages', 'dsh-audit-plugin', 'lib', 'core');
const BIN_SRC = join(ROOT, 'bin', 'dsh-audit.mjs');
const BIN_DST = join(ROOT, 'packages', 'dsh-audit-plugin', 'bin', 'dsh-audit.mjs');

const SYNCED = ['session.mjs', 'analyze.mjs', 'prescribe.mjs', 'report.mjs'];

mkdirSync(DST, { recursive: true });
const done = [];
for (const f of SYNCED) {
  copyFileSync(join(SRC, f), join(DST, f));
  done.push(f);
}

// 生成一个说明文件，避免有人直接改 core/ 里的副本
writeFileSync(
  join(DST, 'README.md'),
  [
    '# 派生目录，不要手改',
    '',
    '这里的文件由 `node scripts/sync-core.mjs` 从 `src/lib/` 复制而来。',
    '要改逻辑请改 `src/lib/`，然后重新运行同步脚本。',
    '',
    `同步的文件：${SYNCED.join('、')}`,
    '',
  ].join('\n'),
  'utf8',
);

// 自检：确认复制后的文件互相之间的相对 import 仍然成立
const imports = new Set();
for (const f of done) {
  const text = readFileSync(join(DST, f), 'utf8');
  for (const m of text.matchAll(/from\s+'(\.\/[^']+)'/g)) imports.add(m[1].replace('./', ''));
}
const missing = [...imports].filter((i) => !done.includes(i));
if (missing.length) {
  console.error(`同步后缺少依赖文件：${missing.join(', ')}`);
  process.exit(1);
}

// ─── 离线 CLI：根部真源 → 包内派生副本 ────────────────────────────────
/** 唯一允许的差异：相对 import 从 ../src/lib/ 指到包内的 ../lib/core/ */
const IMPORT_REWRITE = /from '\.\.\/src\/lib\/([^']+)'/g;

const rootCli = readFileSync(BIN_SRC, 'utf8');
if (!rootCli.startsWith('#!/usr/bin/env node')) {
  console.error('bin/dsh-audit.mjs 缺少可执行 shebang');
  process.exit(1);
}

let rewrites = 0;
const pkgCli = rootCli.replace(IMPORT_REWRITE, (_m, rel) => {
  rewrites += 1;
  return `from '../lib/core/${rel}'`;
});

if (rewrites === 0) {
  console.error('派生失败：根 CLI 里没有找到 ../src/lib/ 相对 import');
  process.exit(1);
}
if (/from '\.\.\/src\//.test(pkgCli)) {
  console.error('派生失败：包内 CLI 仍残留 ../src/ 相对引用');
  process.exit(1);
}
// 派生后每个相对 import 都必须指向包里真实存在的 core 文件
for (const m of pkgCli.matchAll(/from '([^']+)'/g)) {
  const rel = m[1];
  if (rel.startsWith('node:')) continue; // 内置模块
  const file = rel.replace(/^\.\.\/lib\/core\//, '');
  if (file === rel || !SYNCED.includes(file)) {
    console.error(`派生失败：包内 CLI 引用了未同步的模块 ${rel}`);
    process.exit(1);
  }
}

mkdirSync(dirname(BIN_DST), { recursive: true });
writeFileSync(BIN_DST, pkgCli, 'utf8');

console.log(`已同步 ${done.length} 个文件到 packages/dsh-audit-plugin/lib/core/`);
console.log(`相对依赖校验通过：${[...imports].join(', ') || '(无)'}`);
console.log(`已派生离线 CLI：bin/dsh-audit.mjs → packages/dsh-audit-plugin/bin/dsh-audit.mjs（改写 ${rewrites} 处 import）`);
