#!/usr/bin/env node
/**
 * dsh-audit —— 离线审计 DSH 会话日志，输出「结论 + 处方」。
 *
 * 用法：
 *   node bin/dsh-audit.mjs <session目录 | session.v4.jsonl.zstd | sessions根目录>
 *   node bin/dsh-audit.mjs ~/.dsh/sessions --json
 *
 * 不需要启动 DSH，不需要 API key：只读本地已落盘的 session 日志。
 */

import { statSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSession, listSessionDirs } from '../lib/core/session.mjs';
import { analyze } from '../lib/core/analyze.mjs';
import { prescribe } from '../lib/core/prescribe.mjs';
import { renderReport } from '../lib/core/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const USAGE = `
dsh-audit — 离线审计 DSH 会话日志，输出「结论 + 处方」

用法：
  dsh-audit <session目录 | session.v4.jsonl.zstd | sessions根目录> [选项]
  dsh-audit <目录> --json

选项：
  --json              输出机器可读 JSON（数组，每个会话一项）
  --tool-limit=N      文本报告里工具表最多显示 N 行（默认 10，也可写成 --tool-limit N）
  -h, --help          显示本帮助
  -V, --version       显示版本号

退出码：
  0  至少一个会话分析成功
  1  全部会话读取失败
  2  参数错误（缺目标路径 / 路径不存在 / 选项值非法）

示例：
  dsh-audit ~/.dsh/sessions --json
  dsh-audit <会话目录> --tool-limit=5
`.trim();

/** 版本号从最近的 package.json 读（仓库内是根包，npm 安装后是插件包） */
function pkgVersion() {
  try {
    return JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

function fail(message) {
  console.error(`错误：${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = { target: null, json: false, toolLimit: 10, help: false, version: false };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--version' || a === '-V') out.version = true;
    else if (a === '--json') out.json = true;
    else if (a === '--tool-limit') {
      const v = Number(args[++i]);
      if (!Number.isFinite(v) || v < 0) fail('--tool-limit 需要一个非负整数');
      out.toolLimit = v;
    } else if (a.startsWith('--tool-limit=')) {
      const v = Number(a.split('=')[1]);
      if (!Number.isFinite(v) || v < 0) fail('--tool-limit 需要一个非负整数');
      out.toolLimit = v;
    } else if (!a.startsWith('--')) out.target = a;
    else fail(`未知选项：${a}（用 --help 查看用法）`);
  }
  return out;
}

function resolveSessions(target) {
  if (!target) throw new Error('缺少目标路径');
  if (!existsSync(target)) throw new Error(`路径不存在：${target}`);

  const st = statSync(target);
  if (st.isFile()) return [target];

  // 目录本身就是会话目录：里面直接有 .jsonl.zstd。
  // 不再靠路径里是否含 "session-" 判断 —— 用户可能把会话目录改名或放在别处。
  const hasLog = readdirSync(target).some((n) => n.endsWith('.jsonl.zstd'));
  if (hasLog) return [target];

  const dirs = listSessionDirs(target);
  if (dirs.length) return dirs;
  throw new Error(`目录下没有可审计的会话日志：${target}`);
}

function runOne(dir) {
  const model = analyze(loadSession(dir));
  const verdict = prescribe(model);
  return { model, verdict };
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (args.version) {
    console.log(pkgVersion());
    return;
  }
  let targets;
  try {
    targets = resolveSessions(args.target);
  } catch (e) {
    fail(e.message);
  }

  const results = [];
  for (const t of targets) {
    try {
      const { model, verdict } = runOne(t);
      results.push({ target: t, model, verdict });
    } catch (e) {
      if (args.json) results.push({ target: t, error: e.message });
      else console.error(`跳过 ${t}：${e.message}`);
    }
  }

  // 全部目标都失败时以非零码退出：否则脚本化调用会误以为成功
  const allFailed = results.length > 0 && results.every((r) => r.error);
  const exitCode = allFailed ? 1 : 0;

  if (args.json) {
    const payload = results.map((r) =>
      r.error
        ? { target: r.target, error: r.error }
        : {
            target: r.target,
            session: r.model.header,
            source: r.model.source,
            totals: r.model.totals,
            tools: r.model.tools,
            repeats: r.model.repeats,
            steps: r.model.steps,
            headline: r.verdict.headline,
            conclusions: r.verdict.conclusions,
            notes: r.verdict.notes,
          },
    );
    console.log(JSON.stringify(payload, null, 2));
    if (exitCode) process.exit(exitCode);
    return;
  }

  for (const r of results) {
    if (r.error) continue;
    console.log(renderReport(r.model, r.verdict, { toolLimit: args.toolLimit }));
  }

  if (results.length > 1) {
    console.log('══ 多会话速览 ═══════════════════════════════════');
    console.log('  实测总量    请求  工具  处方  会话');
    for (const r of results) {
      if (r.error) {
        console.log(`  ${'—'.padStart(10)} ${'—'.padStart(4)} ${'—'.padStart(5)} ${'—'.padStart(4)}  ${r.target}（读取失败）`);
        continue;
      }
      console.log(
        `  ${String(r.model.totals.totalReal).padStart(9)} ${String(r.model.totals.requests).padStart(5)} ${String(r.model.totals.toolCalls).padStart(5)} ${String(r.verdict.conclusions.length).padStart(5)}  ${r.model.header?.id ?? r.target}`,
      );
    }
    console.log('');
  }

  if (exitCode) process.exit(exitCode);
}

main();
