/**
 * dsh-audit —— 在 DSH 进程内运行的会话审计插件。
 *
 * 与离线 CLI（bin/dsh-audit.mjs）的分工：
 *   - 离线版：解开 appender-only 多帧 zstd，按字符估算结果大小，全流程可复现
 *   - 本插件：直接读一方服务，能用 `ctx.tokenMeter.measure()` 拿到
 *     **平台按实际路由定价的逐节点 token**，这是离线版给不了的
 *
 * 所有形状都来自 2026-10-21 的探针实测（docs/evidence/2026-10-21-探针摘要.json）：
 *   - session/flush 的 payload 本身就是 Session
 *   - 不声明 inject 读不到任何服务（会抛 "cannot get property X without inject"）
 *   - measure() 的 baseline.kind 观察到 none / estimated / usage 三种
 *
 * 宿主安全约束：任何失败只写一行 err 文件，绝不向事件链抛出。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { analyze } from './core/analyze.mjs';
import { prescribe } from './core/prescribe.mjs';
import { renderReport } from './core/report.mjs';
import { loadedFromSnapshot, attachMeasure } from './adapter.mjs';

export const name = 'dsh-audit';

/** 不声明 inject 就读不到服务 —— 这条是实测出来的硬约束。 */
export const inject = ['sessions', 'sessionQuery', 'tokenMeter'];

/**
 * 默认配置。不导出成 `Config` 的原因：一方插件用的是 schemastery schema，
 * 而本包不引入任何 peer 依赖（profile 里解析不到 @deepseek-ai/*）。
 * 因此配置在 apply 内部做默认值合并，缺省即可工作。
 */
const DEFAULTS = {
  /** 关闭审计（仍会加载插件，不产生任何副作用）。 */
  enabled: true,
  /** 每次 turn 结束自动写报告。 */
  autoReport: true,
  /** 自动报告的最小间隔（毫秒），避免高频 flush 反复重算。 */
  minIntervalMs: 3000,
  /** 输出目录，默认 $DSH_HOME/dsh-audit。 */
  outDir: null,
  /** 首次审计时 dump readSession 快照的顶层结构，便于适配层对齐形状。
   *  形状已在 2026-10-21 确认（{ session, inheritedEventCount, events }），默认关闭。 */
  debugShape: false,
};

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) };
  if (!cfg.enabled) return;

  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const outDir = cfg.outDir || join(home, 'dsh-audit');
  let lastSession = null;
  let lastRun = 0;
  let running = false;

  const writeOut = (file, text) => {
    try {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(file, text, 'utf8');
      return true;
    } catch {
      return false;
    }
  };

  const err = (phase, e) => {
    writeOut(join(outDir, 'errors.log'), `${new Date().toISOString()} [${phase}] ${e?.stack ?? e}\n`);
  };

  /** 一次完整审计：读日志 → 分析 → 处方 → 拼上平台定价 → 落盘。 */
  async function audit(session) {
    const id = session?.header?.id;
    if (!id || running) return null;
    if (Date.now() - lastRun < cfg.minIntervalMs) return null;
    running = true;
    try {
      const snapshot = await ctx.sessionQuery.readSession(id);
      if (cfg.debugShape) {
        try {
          writeOut(
            join(outDir, 'debug-snapshot.json'),
            JSON.stringify(
              {
                topKeys: Object.keys(snapshot ?? {}),
                header: snapshot?.header ?? null,
                headerType: typeof snapshot?.header,
                eventsLen: Array.isArray(snapshot?.events) ? snapshot.events.length : null,
                firstEvent: snapshot?.events?.[0] ?? null,
                firstEventKeys: snapshot?.events?.[0] ? Object.keys(snapshot.events[0]) : null,
              },
              null,
              1,
            ),
          );
        } catch (e) {
          err('debug-shape', e);
        }
      }
      const loaded = loadedFromSnapshot(snapshot, `session-query:${id}`);
      const model = analyze(loaded);
      model.__loaded = loaded;

      // 平台定价（可能失败：measure 需要 live Session）
      let measured = null;
      let nodes = [];
      try {
        measured = attachMeasure(model, ctx.tokenMeter.measure(session));
        nodes = measured.nodes;
        measured = measured.measured;
      } catch (e) {
        err('measure', e);
      }

      const verdict = prescribe(model);
      let text = renderReport(model, verdict);
      if (measured) text += renderMeasuredSection(measured, nodes);
      else text += '\n（本次未取得平台定价：tokenMeter.measure 不可用）\n';

      writeOut(join(outDir, `report-${id}.txt`), text);
      writeOut(join(outDir, 'latest.txt'), text);
      lastRun = Date.now();
      return { id, text, model, verdict, measured };
    } catch (e) {
      err('audit', e);
      return null;
    } finally {
      running = false;
    }
  }

  // turn 结束时是最完整的时点（包含 assistant/message 与 usage）
  try {
    ctx.on('agent/turn-stopping', (session) => {
      lastSession = session ?? lastSession;
      if (cfg.autoReport && lastSession) void audit(lastSession);
    });
  } catch (e) {
    err('hook:turn-stopping', e);
  }

  // flush 作为兜底：某些路径（中断、错误）不会走到 turn-stopping
  try {
    ctx.on('session/flush', (session) => {
      if (session?.header?.id) lastSession = session;
      if (cfg.autoReport && lastSession) void audit(lastSession);
    });
  } catch (e) {
    err('hook:flush', e);
  }
}

/** 平台定价区块：这是插件相对离线 CLI 的增量。 */
function renderMeasuredSection(measured, nodes) {
  const L = [];
  const fmt = (n) => Math.round(Number(n ?? 0)).toLocaleString('en-US');
  L.push('');
  L.push('══ 平台定价（tokenMeter.measure，实测）══════════');
  L.push(`baseline.kind = ${measured.baselineKind} · logRevision ${measured.logRevision} · 表面节点 ${measured.nodeCount}`);
  L.push(`表面定价累计 ${fmt(measured.nodeSum)} token（surfaceTokens ${fmt(measured.surfaceTokens)}，请求压力 ${fmt(measured.totalTokens)}）`);
  if (measured.baselineKind !== 'usage') {
    L.push('注意：kind 不是 usage，说明没有可复用的 provider 用量锚点，逐节点数字偏估算口径。');
  }
  L.push('');
  L.push('  token   seq   事件');
  for (const n of nodes.slice(0, 12)) {
    L.push(`  ${fmt(n.tokens).padStart(6)} ${String(n.seq).padStart(5)}   ${n.label}`);
  }
  L.push('');
  return L.join('\n');
}
