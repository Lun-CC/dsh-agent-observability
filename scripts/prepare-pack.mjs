/**
 * prepack 第一步：把仓库根的 CHANGELOG 取进包目录。
 *
 * npm 的 `files` 白名单只能覆盖包目录内部，仓库根的 CHANGELOG.md 进不了包。
 * 又不想维护两份变更日志（必然漂移），所以打包前临时拷一份，
 * 由 postpack 的 cleanup-pack.mjs 删除。LICENSE 则是包目录内常驻文件，不参与复制。
 *
 * 用法：node scripts/prepare-pack.mjs（由插件包 prepack 调用）
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = join(ROOT, 'packages', 'dsh-audit-plugin');

const rootChangelog = join(ROOT, 'CHANGELOG.md');
if (!existsSync(rootChangelog)) {
  console.error('缺少仓库根 CHANGELOG.md');
  process.exit(1);
}

const text = readFileSync(rootChangelog, 'utf8');
const banner = '<!-- 本文件由 scripts/prepare-pack.mjs 在打包前从仓库根复制，请勿直接编辑。 -->\n\n';
writeFileSync(join(PKG, 'CHANGELOG.md'), banner + text, 'utf8');
console.log('已把 CHANGELOG.md 复制进包目录');
