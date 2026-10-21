/**
 * 回填：给旧版遗留的 report-*.txt 补出 report-*.json 摘要。
 *
 * 为什么需要：0.7.0 之前只写文本，Web UI 读的是 .json。升级后旧报告在页面上是空的，
 * 用户会以为"历史丢了"。这里用**同一份会话日志、同一套分析模型**重新算一遍摘要，
 * 不伪造任何数字 —— 只是把同一结果补成机器可读格式。
 *
 * 用法：
 *   node scripts/backfill-summaries.mjs            # 只补缺 .json 的
 *   node scripts/backfill-summaries.mjs --dry-run  # 只看会写哪些
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { loadSession } from '../src/lib/session.mjs';
import { analyze } from '../src/lib/analyze.mjs';
import { prescribe } from '../src/lib/prescribe.mjs';
import { buildSummary } from '../packages/dsh-audit-plugin/lib/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const OUT_DIR = join(DSH_HOME, 'dsh-audit');
const SESSIONS = join(DSH_HOME, 'sessions');

const dryRun = process.argv.includes('--dry-run');

/** 在 $DSH_HOME/sessions 里按目录名找会话目录（形如 session-<uuid>）。 */
function findSessionDir(id) {
  let groups = [];
  try {
    groups = readdirSync(SESSIONS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return null;
  }
  for (const g of groups) {
    const p = join(SESSIONS, g, id);
    if (existsSync(p)) return p;
  }
  return null;
}

if (!existsSync(OUT_DIR)) {
  console.log(`没有输出目录：${OUT_DIR}`);
  process.exit(0);
}

const txts = readdirSync(OUT_DIR).filter((f) => f.startsWith('report-') && f.endsWith('.txt'));
let written = 0;
let skipped = 0;
let failed = 0;

for (const f of txts) {
  const id = f.slice('report-'.length, -'.txt'.length);
  const jsonPath = join(OUT_DIR, `report-${id}.json`);
  if (existsSync(jsonPath)) {
    skipped++;
    continue;
  }
  const dir = findSessionDir(id);
  if (!dir) {
    console.log(`跳过 ${id}：找不到会话目录`);
    failed++;
    continue;
  }
  try {
    const loaded = loadSession(dir);
    loaded.inHost = false;
    loaded.generatedAt = new Date().toISOString();
    const model = analyze(loaded);
    const verdict = prescribe(model);
    const summary = buildSummary({
      id,
      top: !model.header?.parentId,
      loaded,
      model,
      verdict,
      measured: null,
    });
    if (dryRun) {
      console.log(`会写 ${jsonPath}（${summary.totals.totalReal} token / ${summary.totals.requests} 请求）`);
    } else {
      const tmp = `${jsonPath}.tmp`;
      writeFileSync(tmp, JSON.stringify(summary, null, 1), 'utf8');
      renameSync(tmp, jsonPath);
    }
    written++;
  } catch (e) {
    console.log(`失败 ${id}：${e.message}`);
    failed++;
  }
}

console.log(`${dryRun ? '[dry-run] ' : ''}补出 ${written} 份摘要，跳过 ${skipped} 份（已有），失败 ${failed} 份`);
void ROOT;
