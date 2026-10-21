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

import { statSync, existsSync } from 'node:fs';
import { loadSession, listSessionDirs, estimateTokens } from '../src/lib/session.mjs';
import { analyze } from '../src/lib/analyze.mjs';
import { prescribe } from '../src/lib/prescribe.mjs';
import { renderReport } from '../src/lib/report.mjs';

function parseArgs(argv) {
  const out = { target: null, json: false, toolLimit: 10 };
  for (const a of argv.slice(2)) {
    if (a === '--json') out.json = true;
    else if (a.startsWith('--tool-limit=')) out.toolLimit = Number(a.split('=')[1]);
    else if (!a.startsWith('--')) out.target = a;
  }
  return out;
}

function resolveSessions(target) {
  if (!target) throw new Error('缺少目标路径');
  if (!existsSync(target)) throw new Error(`路径不存在：${target}`);

  const st = statSync(target);
  if (st.isFile()) return [target];

  // 目录：可能是单个 session 目录，也可能是 sessions 根目录
  if (existsSync(`${target}`) && target.includes('session-')) return [target];
  const dirs = listSessionDirs(target);
  if (dirs.length) return dirs;
  return [target]; // 交给 loadSession 里的目录探测
}

function runOne(dir) {
  const model = analyze(loadSession(dir));
  const verdict = prescribe(model);
  return { model, verdict };
}

function main() {
  const args = parseArgs(process.argv);
  let targets;
  try {
    targets = resolveSessions(args.target);
  } catch (e) {
    console.error(`错误：${e.message}`);
    process.exit(2);
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
}

main();
