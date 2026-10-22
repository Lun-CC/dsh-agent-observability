/**
 * 命令行版整改：给没有打开 Web UI 的场景用（也方便先试后改）。
 *
 * 用法：
 *   node scripts/apply-fix.mjs --list
 *   node scripts/apply-fix.mjs --id=spill --dry-run
 *   node scripts/apply-fix.mjs --id=spill
 *   node scripts/apply-fix.mjs --id=spill --revert
 *   node scripts/apply-fix.mjs --id=spill --profile=web   # 多 profile 时必须显式指定
 *
 * 与插件内一键整改用的是同一份 lib/fixes.mjs，行为一致。
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { applyFix, revertFix, previewFix, FIX_RULES, resolveProfileDir, appliedFixes } from '../packages/dsh-audit-plugin/lib/fixes.mjs';

const argv = process.argv.slice(2);
const arg = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};
const flag = (name) => argv.includes(`--${name}`);

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
const cwd = arg('cwd') || process.cwd();
const profileName = arg('profile');
const pick = resolveProfileDir(dshHome, profileName);

if (flag('list') || !arg('id')) {
  if (pick.profiles.length > 1) {
    console.log(`装了本插件的 profile 有 ${pick.profiles.length} 个：`);
    for (const p of pick.profiles) console.log(`  - ${p.name}  (${p.dir})`);
    console.log('多 profile 时必须用 --profile=<name> 指定要改哪个，不会按 mtime 猜。');
  } else {
    console.log(`已装在本插件的 profile：${pick.dir ?? '（没找到）'}`);
  }
  const applied = appliedFixes(pick.dir);
  console.log('可执行的整改：');
  for (const [id, rule] of Object.entries(FIX_RULES)) {
    console.log(`  ${applied[id] ? '[已应用]' : '[      ]'} ${id.padEnd(16)} ${rule.kind === 'patch' ? '改配置' : '写 AGENTS.md'} · ${rule.title}`);
  }
  console.log('\n用 --id=<名称> 应用，加 --dry-run 只看不改。');
  process.exit(0);
}

const id = arg('id');
if (!FIX_RULES[id]) {
  console.error(`没有这个整改：${id}`);
  process.exit(2);
}

if (flag('dry-run')) {
  const pv = previewFix(id, { cwd, profileDir: pick.dir, profiles: pick.profiles });
  console.log(`目标：${pv.target}\n`);
  console.log(pv.text);
  console.log(`\n（dry-run，未写入）`);
  process.exit(0);
}

const result = flag('revert')
  ? revertFix(id, { dshHome, cwd, profile: profileName })
  : applyFix(id, { dshHome, cwd, profile: profileName });
console.log(result.message);
if (!result.changed) process.exit(1);
const profileDir = result.file?.endsWith('cordis.patch.yml') ? result.file.replace(/[\\/]cordis\.patch\.yml$/, '') : pick.dir;

// 改配置时顺手验证一下组装后的配置真的变了（有 dsh 可执行文件才有意义）
if (result.file?.endsWith('cordis.patch.yml') && profileDir) {
  const name = profileDir.split(/[\\/]/).pop();
  // Windows 上 node_modules/.bin/dsh 是没有扩展名的 shell 脚本，直接 execFile 跑不起来，
  // 依次尝试 dsh.cmd / dsh.exe，都不行就安静跳过。
  const candidates = [process.env.DSH_BIN, `${process.env.DSH_BIN}.cmd`, `${process.env.DSH_BIN}.exe`, 'dsh.cmd', 'dsh'].filter(Boolean);
  const rule = FIX_RULES[id];
  const key = Object.keys(rule.config ?? {})[0];
  let verified = false;
  /** npx 布局下真正的入口是 node_modules/@deepseek-ai/dsh/lib/bin.js，用 node 直接跑它最稳。 */
  const entryFromBin = process.env.DSH_BIN
    ? join(process.env.DSH_BIN, '..', '..', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    : null;
  const invocations = [];
  for (const bin of candidates) invocations.push([bin, ['--profile', name, '--dump-config']]);
  if (entryFromBin && existsSync(entryFromBin)) invocations.unshift([process.execPath, [entryFromBin, '--profile', name, '--dump-config']]);

  for (const [bin, args] of invocations) {
    try {
      const out = execFileSync(bin, args, { encoding: 'utf8', timeout: 90_000 });
      const line = out.split('\n').find((l) => l.includes(key));
      console.log(`组装后配置里的 ${key}：${line ? line.trim() : '（没找到，可能被其它层覆盖）'}`);
      verified = true;
      break;
    } catch { /* 换下一个候选 */ }
  }
  if (!verified) console.log('（跳过配置校验：没找到可执行的 dsh，可用 dsh --dump-config 自行确认）');
}

console.log('\n注意：配置改动需要重启 DSH 才生效。');
