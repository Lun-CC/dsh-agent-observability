/**
 * 把 src/lib 的分析内核同步进插件包。
 *
 * 为什么需要这一步：插件会被拷进 profile 的 node_modules 独立运行，
 * 无法相对引用仓库里的 src/lib。复制一份是唯一不改代码结构的办法，
 * 由本脚本保证"只有一份真源"（src/lib），插件里的 core/ 是派生物。
 *
 * 用法：node scripts/sync-core.mjs
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src', 'lib');
const DST = join(ROOT, 'packages', 'dsh-audit-plugin', 'lib', 'core');

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

console.log(`已同步 ${done.length} 个文件到 packages/dsh-audit-plugin/lib/core/`);
console.log(`相对依赖校验通过：${[...imports].join(', ') || '(无)'}`);
