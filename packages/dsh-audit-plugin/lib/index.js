/**
 * dsh-cost-audit —— 在 DSH 进程内运行的会话成本审计插件。
 *
 * 与离线 CLI（bin/dsh-audit.mjs）的分工：
 *   - 离线版：解开 append-only 多帧 zstd，按字符估算结果大小，全流程可复现
 *   - 本插件：直接读一方服务，能用 `ctx.tokenMeter.measure()` 拿到
 *     **平台按实际路由定价的逐节点 token**，这是离线版给不了的
 *
 * ── 触发路径（0.7.0 修正）──────────────────────────────────────────────
 * 只用 `session/flush` 一个触发点。官方签名是
 *   'session/flush'(this: Scoped<Session>, session: Session)
 * 载荷**本身就是 Session**，且它在持久化检查点上 awaited 触发，已覆盖 turn 结束。
 *
 * 上一版还挂了 `agent/turn-stopping`，并把首参当 Session —— 官方签名是
 *   'agent/turn-stopping'(this: Scoped<Agent>, payload: { agent, turn, signal })
 * 首参是包装对象而非 Session，所以那条路径**从未触发过审计**，
 * 还把 flush 拿到的真实 Session 覆盖成了 {turn, signal}。已删除。
 * Agent 在 0.2.1-rc.2 未公开 session 访问器，因此没有可靠的替代写法。
 *
 * ── 宿主安全约束 ───────────────────────────────────────────────────────
 *   - 任何失败只写日志，绝不向事件链抛出
 *   - 写盘一律临时文件 + rename（进程被杀不留半截文件）
 *   - 输出目录有保留策略，不会无界增长
 */

import { mkdirSync, writeFileSync, renameSync, statSync, readdirSync, unlinkSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { analyze } from './core/analyze.mjs';
import { prescribe } from './core/prescribe.mjs';
import { renderReport } from './core/report.mjs';
import { loadedFromSnapshot, attachMeasure } from './adapter.mjs';

export const name = 'dsh-cost-audit';

/**
 * 只注入真正必需的服务。
 *
 * `tokenMeter` 不进 inject 的原因：官方失败矩阵规定「注入的服务不可用 → 条目会一直等待依赖」，
 * 缺 tokenMeter 的环境里插件会**永不激活**。但它又不能简单地"不注入直接读属性"——
 * Cordis 会抛 `cannot get property "tokenMeter" without inject`。
 *
 * 正解是 Cordis 提供的 `ctx.get(name)`：「Read a service from the store **without the
 * inject requirement**」。它返回服务或 undefined，天然就是"可选依赖"。
 * 这样既不会因缺 tokenMeter 而卡死，也不会丢掉平台定价这个唯一差异化能力。
 */
export const inject = ['sessionQuery'];

const DEFAULTS = {
  /** 关闭审计（插件仍加载，不产生副作用）。 */
  enabled: true,
  /** 每次 flush 自动写报告。 */
  autoReport: true,
  /** 同一会话两次审计的最小间隔（毫秒）。 */
  minIntervalMs: 3000,
  /** 输出目录，默认 $DSH_HOME/dsh-audit。 */
  outDir: null,
  /** 保留策略：最多保留的报告文件数。 */
  maxReports: 200,
  /** 保留策略：早于这么多天的报告会被清理。 */
  maxAgeDays: 7,
  /** errors.log 轮转阈值（字节）。 */
  maxErrorLogBytes: 256 * 1024,
  /** 首次审计时 dump readSession 快照结构（排查适配问题用，默认关）。 */
  debugShape: false,
  /** 每次触发在 errors.log 记一行触发路径（排查用，默认关）。 */
  debugTriggers: false,
};

/** 原子写：先写临时文件再 rename，避免半截文件。 */
function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) };
  if (!cfg.enabled) return;

  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const outDir = cfg.outDir || join(home, 'dsh-audit');

  const lastRunAt = new Map(); // sessionId -> ms
  const inFlight = new Set();

  const log = (phase, message) => {
    try {
      ensureDir(outDir);
      const file = join(outDir, 'errors.log');
      try {
        if (statSync(file).size > cfg.maxErrorLogBytes) renameSync(file, `${file}.1`);
      } catch { /* 文件不存在，忽略 */ }
      appendFileSync(file, `${new Date().toISOString()} [${phase}] ${message}\n`, 'utf8');
    } catch { /* 日志失败不能再抛 */ }
  };

  /** 保留策略：按 mtime 清理过期/超量的 report-*.txt。 */
  const prune = () => {
    try {
      const now = Date.now();
      const maxAgeMs = cfg.maxAgeDays * 86400_000;
      const files = readdirSync(outDir)
        .filter((f) => f.startsWith('report-') && f.endsWith('.txt'))
        .map((f) => {
          const p = join(outDir, f);
          try {
            return { p, mtime: statSync(p).mtimeMs };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => b.mtime - a.mtime);

      let removed = 0;
      files.forEach((item, i) => {
        if (!(now - item.mtime > maxAgeMs) && i < cfg.maxReports) return;
        try {
          unlinkSync(item.p);
          removed++;
        } catch { /* ignore */ }
      });
      if (removed) log('prune', `清理 ${removed} 份过期报告`);
    } catch (e) {
      log('prune', String(e?.message ?? e));
    }
  };

  /**
   * 取 tokenMeter，按**可选依赖**处理。
   *
   * 两条路径，按优先级：
   *   1. `ctx.get('tokenMeter')` —— Cordis 官方提供的"不注入也能读"入口，
   *      服务不存在时返回 undefined，不会抛错
   *   2. `ctx.tokenMeter` —— 仅当它真的在 inject 里时才可用（保留以兼容未来的注入方式）
   *
   * 直接写 `ctx.tokenMeter?.measure()` 在未注入时**会抛**
   * `cannot get property "tokenMeter" without inject`，可选链救不了。
   */
  const readTokenMeter = () => {
    try {
      if (typeof ctx.get === 'function') {
        const viaGet = ctx.get('tokenMeter');
        if (viaGet) return viaGet;
      }
    } catch { /* 继续走下面的兜底 */ }
    try {
      return ctx.tokenMeter ?? null;
    } catch {
      return null;
    }
  };

  const isTopLevel = (session) => {
    const h = session?.header ?? {};
    return (h.parentId ?? null) === null && (h.delegationDepth ?? 0) === 0;
  };

  async function audit(session) {
    const id = session?.header?.id;
    if (!id) return null;
    if (inFlight.has(id)) return null;
    const last = lastRunAt.get(id) ?? 0;
    if (Date.now() - last < cfg.minIntervalMs) return null;

    inFlight.add(id);
    try {
      const snapshot = await ctx.sessionQuery.readSession(id);
      if (cfg.debugShape) {
        try {
          writeAtomic(
            join(outDir, 'debug-snapshot.json'),
            JSON.stringify(
              {
                topKeys: Object.keys(snapshot ?? {}),
                headerKeys: snapshot?.session ? Object.keys(snapshot.session) : null,
                session: snapshot?.session ?? null,
                eventsLen: Array.isArray(snapshot?.events) ? snapshot.events.length : null,
                firstEvent: snapshot?.events?.[0] ?? null,
              },
              null,
              1,
            ),
          );
        } catch (e) {
          log('debug-shape', String(e?.message ?? e));
        }
      }

      const loaded = loadedFromSnapshot(snapshot, `session-query:${id}`);
      loaded.generatedAt = new Date().toISOString();
      const model = analyze(loaded);
      model.__loaded = loaded;

      // 平台定价属于可选能力：缺失时降级为「只用 usage 口径」，报告照常产出。
      let measured = null;
      let nodes = [];
      const tm = readTokenMeter();
      if (tm && typeof tm.measure === 'function') {
        try {
          const attached = attachMeasure(model, tm.measure(session));
          measured = attached.measured;
          nodes = attached.nodes;
        } catch (e) {
          log('measure', String(e?.message ?? e));
        }
      }

      const verdict = prescribe(model);
      let text = renderReport(model, verdict);
      if (measured) text += renderMeasuredSection(measured, nodes);
      else text += '\n（本次未取得平台定价：tokenMeter 不可用或调用失败，数字仅按 usage/字符估算口径）\n';

      ensureDir(outDir);
      writeAtomic(join(outDir, `report-${id}.txt`), text);

      // latest.txt 只由顶层会话写：subagent 的报告不应顶掉主报告
      if (isTopLevel(session)) writeAtomic(join(outDir, 'latest.txt'), text);

      lastRunAt.set(id, Date.now());
      prune();
      return { id, text, model, verdict, measured };
    } catch (e) {
      log('audit', e?.stack ?? String(e));
      return null;
    } finally {
      inFlight.delete(id);
    }
  }

  try {
    ctx.on('session/flush', (session) => {
      if (cfg.debugTriggers) log('trigger', `session/flush id=${session?.header?.id ?? '?'} top=${isTopLevel(session)}`);
      if (!cfg.autoReport || !session?.header?.id) return;
      void audit(session);
    });
  } catch (e) {
    log('hook:flush', String(e?.message ?? e));
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
