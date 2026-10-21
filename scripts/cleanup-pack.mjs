/**
 * postpack：清掉 prepare-pack 临时复制进来的文件，保持工作区干净。
 * LICENSE 是常驻文件，不删。
 */

import { unlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = join(ROOT, 'packages', 'dsh-audit-plugin', 'CHANGELOG.md');

if (existsSync(tmp)) {
  unlinkSync(tmp);
  console.log('已清理临时 CHANGELOG.md');
}
