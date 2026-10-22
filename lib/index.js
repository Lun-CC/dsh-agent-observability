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

import { mkdirSync, writeFileSync, renameSync, statSync, readdirSync, unlinkSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { analyze } from './core/analyze.mjs';
import { prescribe } from './core/prescribe.mjs';
import { renderReport } from './core/report.mjs';
import { loadedFromSnapshot, attachMeasure } from './adapter.mjs';
import { renderPage, injectEntry, ENTRY_JS } from './webui.mjs';
import { decorateFixes, applyFix, revertFix, previewFix, resolveProfileDir } from './fixes.mjs';

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
  /** 在宿主 Web UI 提供报告页与入口按钮（/dsh-cost-audit/）。 */
  ui: true,
};

/**
 * 原子写：先写临时文件再 rename，避免半截文件。
 *
 * 失败（磁盘满 / 目标被占用 / rename 被拒）时必须清掉临时文件再抛出：
 * 残留的 `report-<id>.txt.tmp-<pid>` 会被 listSummaries/prune 当成报告文件扫到，
 * 也会在反复失败后堆积。导出给单测模拟 rename 失败用。
 */
export function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch { /* 临时文件可能根本没创建成功 */ }
    throw e;
  }
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

  /** 最近一次失败（给 /api/list 用：页面能显示"为什么没数据"，而不是静默空白）。 */
  let lastError = null;
  const lastWarnAt = new Map(); // phase:message -> ms

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

  /**
   * 记录"形状不认识/处理失败"这类静默故障：写 errors.log（同一秒级重复的
   * 只记 10 分钟一次，防止每次 flush 刷屏），并保留 lastError 供页面展示。
   * 回应 P1-3：payload 形状变化时旧实现直接 return，页面空、errors.log 也没有痕迹。
   */
  const warn = (phase, message) => {
    const msg = String(message ?? '');
    lastError = { phase, message: msg, at: new Date().toISOString() };
    const key = `${phase}:${msg}`;
    const now = Date.now();
    if ((lastWarnAt.get(key) ?? 0) + 600_000 > now) return;
    lastWarnAt.set(key, now);
    log(phase, msg);
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
        // 一并删掉同名 .json 摘要，避免只留半份
        try {
          unlinkSync(item.p.replace(/\.txt$/, '.json'));
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

  // 实测字段名是 parentSession（0.7.0 误用 parentId，导致判空永远成立、
  // subagent 会顶掉 latest.txt）。两个名字都认。
  const isTopLevel = (session) => {
    const h = session?.header ?? {};
    return (h.parentSession ?? h.parentId ?? null) === null && (h.delegationDepth ?? 0) === 0;
  };

  async function audit(session) {
    const id = session?.header?.id;
    // 形状变化（宿主升级）时不再静默：留痕 + 页面可见，否则用户只看到空页面
    if (!id) {
      warn('trigger', 'session/flush 载荷里没有 header.id —— 宿主事件形状可能变了，本次不审计');
      return null;
    }
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

      // 结构化摘要供 Web UI 直接消费，省得前端解析文本
      const top = isTopLevel(session);
      const summary = buildSummary({ id, top, loaded, model, verdict, measured });
      writeAtomic(join(outDir, `report-${id}.json`), JSON.stringify(summary, null, 1));

      // latest.* 只由顶层会话写：subagent 的报告不应顶掉主报告
      if (top) {
        writeAtomic(join(outDir, 'latest.txt'), text);
        writeAtomic(join(outDir, 'latest.json'), JSON.stringify(summary, null, 1));
      }

      lastRunAt.set(id, Date.now());
      prune();
      return { id, text, model, verdict, measured };
    } catch (e) {
      // 报告失败必须留痕：否则页面看起来只是"还没生成"
      warn('audit', e?.stack ?? String(e));
      return null;
    } finally {
      inFlight.delete(id);
    }
  }

  try {
    ctx.on('session/flush', (session) => {
      if (cfg.debugTriggers) log('trigger', `session/flush id=${session?.header?.id ?? '?'} top=${isTopLevel(session)}`);
      if (!cfg.autoReport) return;
      void audit(session);
    });
  } catch (e) {
    log('hook:flush', String(e?.message ?? e));
  }

  // ── 生命周期：反注册 ─────────────────────────────────────────────────
  // 宿主 dispose 插件（HMR / dshmarket hot-mount / 配置重载）时，webServer 路由与
  // index tap 不会随插件 scope 自动清理：dsh-host-webserver 的 register/tapIndex
  // 返回 disposer，必须自己调用。不撤就会在同一宿主进程里留下 5 条 exact route，
  // 下次 apply 逐条撞 `webserver: duplicate exact route "<path>"` —— 这就是
  // errors.log 里 2026-10-21T16:44 / 2026-10-22T09:39 两批重复路由的成因
  // （用 HEAD 版 index.js + 假宿主可复现：apply → dispose → apply 恰好得到 5 条
  // 与生产日志同形的 duplicate 行）。
  const uiDisposers = [];
  let uiDisposed = false;
  const disposeUi = () => {
    if (uiDisposed) return;
    uiDisposed = true;
    for (let i = uiDisposers.length - 1; i >= 0; i--) {
      try {
        uiDisposers[i]();
      } catch (e) {
        log('ui:dispose', String(e?.message ?? e));
      }
    }
    uiDisposers.length = 0;
  };
  const trackDisposer = (d) => {
    if (typeof d !== 'function') return;
    if (uiDisposed) {
      // 插件已 dispose 之后才异步注册（inject 回调晚到）→ 立即补撤销，别留孤儿路由
      try { d(); } catch { /* ignore */ }
      return;
    }
    uiDisposers.push(d);
  };
  // 交给 Cordis effect 管理（与对照实现 dsh-whale-widget 的写法一致）；
  // 没有 effect 的假 ctx 也支持直接调用 apply 的返回值。
  try {
    if (typeof ctx.effect === 'function') ctx.effect(() => disposeUi, `${name}:webui`);
  } catch (e) {
    log('ui:effect', String(e?.message ?? e));
  }

  // ── Web UI ────────────────────────────────────────────────────────────
  if (cfg.ui) {
    // 桌面壳的结构化注入行必须在插件加载期就挂上（宿主启动时收集一次并缓存）
    try {
      ctx.on('webserver/index-inject', (table) => {
        try {
          if (!Array.isArray(table)) return;
          const already = table.some((r) => r && r.kind === 'script' && String(r.text ?? '').includes('dca-entry'));
          if (already) return;
          // kind:'script' 由桌面壳 createElement+textContent 执行，加载失败不会中断启动
          table.push({ kind: 'script', text: ENTRY_JS });
        } catch (e) {
          log('ui:index-inject', String(e?.message ?? e));
        }
      });
    } catch (e) {
      log('ui:hook', String(e?.message ?? e));
    }

    // 幂等保护：正常路径只会 wire 一次（webServer 已就绪走 tryGet，否则等 inject
    // 回调），这里再兜一层，避免宿主以不同时机重复触发注入回调时重复注册。
    let wired = false;
    const wire = (webServer) => {
      if (wired) return;
      if (!webServer || typeof webServer.register !== 'function') return;
      wired = true;
      const routes = [
        ['/dsh-cost-audit', () => ({ html: renderPage() })],
        ['/dsh-cost-audit/', () => ({ html: renderPage() })],
        [
          '/dsh-cost-audit/api/list',
          () => {
            const reports = listSummaries(outDir);
            let latest = null;
            try {
              latest = JSON.parse(readFileSync(join(outDir, 'latest.json'), 'utf8')).id ?? null;
            } catch { /* 还没有顶层报告 */ }
            const pick = resolveProfileDir(home);
            // profile：多 profile 时必须让用户选，不能按 mtime 猜（见 fixes.mjs 注释）
            return {
              json: {
                conversations: groupConversations(reports),
                reports,
                latest,
                outDir,
                profile: { chosen: pick.dir, profiles: pick.profiles, ambiguous: !!pick.ambiguous },
                lastError,
              },
            };
          },
        ],
        [
          '/dsh-cost-audit/api/report',
          (req) => {
            const id = queryOf(req).get('id');
            if (!safeId(id)) return { status: 400, json: { error: 'bad id' } };
            let summary = null;
            try {
              summary = JSON.parse(readFileSync(join(outDir, `report-${id}.json`), 'utf8'));
            } catch { /* 不存在 */ }
            let text = null;
            try {
              text = readFileSync(join(outDir, `report-${id}.txt`), 'utf8');
            } catch { /* 不存在 */ }
            if (!summary && !text) return { status: 404, json: { error: 'not found' } };
            // 同一对话下的其它会话（subagent），用于在详情里给出"子会话成本"
            const rootId = summary?.rootId ?? summary?.id ?? id;
            const siblings = listSummaries(outDir)
              .filter((r) => (r.rootId ?? r.id) === rootId && r.id !== id)
              .map((r) => ({ id: r.id, top: !!r.top, totals: r.totals, generatedAt: r.generatedAt }));
            // 整改可用性在读时计算：应用/撤销之后立刻反映到页面
            const pick = resolveProfileDir(home);
            if (summary) {
              summary.prescriptions = decorateFixes(summary.prescriptions, { profileDir: pick.dir, cwd: summary.session?.cwd });
            }
            return { json: { summary, text, siblings, profile: { chosen: pick.dir, profiles: pick.profiles, ambiguous: !!pick.ambiguous } } };
          },
        ],
        [
          '/dsh-cost-audit/api/fix',
          async (req) => {
            if (req.method !== 'POST') return { status: 405, json: { error: 'method not allowed' } };
            // 自定义头是 CSRF 防线：跨站请求带不上它（会先触发 preflight）
            if (String(req.headers['x-dsh-audit'] ?? '') !== '1') return { status: 403, json: { error: 'missing x-dsh-audit header' } };
            const body = await readJsonBody(req);
            if (!body || typeof body.id !== 'string') return { status: 400, json: { error: 'bad body' } };
            // profile 由页面显式选择（多 profile 时不能猜）；不传则按"唯一才用"处理
            const profile = typeof body.profile === 'string' && body.profile ? body.profile : undefined;
            const pick = resolveProfileDir(home, profile);
            if (body.action === 'preview') {
              return {
                json: {
                  ok: true,
                  preview: previewFix(body.id, { cwd: body.cwd, profileDir: pick.dir, profiles: pick.profiles }),
                  profile: { chosen: pick.dir, profiles: pick.profiles, ambiguous: !!pick.ambiguous },
                },
              };
            }
            const result = body.action === 'revert'
              ? revertFix(body.id, { dshHome: home, cwd: body.cwd, profile })
              : applyFix(body.id, { dshHome: home, cwd: body.cwd, profile });
            if (result.changed) log('fix', `${body.action} ${body.id} → ${result.file ?? ''}`);
            return { json: { ok: result.changed, ...result } };
          },
        ],
      ];

      for (const [path, fn] of routes) {
        try {
          // register 返回 disposer：必须保留，dispose 插件时路由才会撤销
          trackDisposer(webServer.register({
            kind: 'exact',
            path,
            handler: async (req, res) => {
              try {
                if (!allowedRequest(req, ctx)) {
                  res.statusCode = 403;
                  res.setHeader('content-type', 'text/plain; charset=utf-8');
                  res.end('forbidden');
                  return;
                }
                const out = (await fn(req, res)) ?? {};
                const status = out.status ?? 200;
                if (out.html !== undefined) {
                  res.statusCode = status;
                  res.setHeader('content-type', 'text/html; charset=utf-8');
                  res.setHeader('cache-control', 'no-store');
                  res.end(out.html);
                  return;
                }
                res.statusCode = status;
                res.setHeader('content-type', 'application/json; charset=utf-8');
                res.setHeader('cache-control', 'no-store');
                res.end(JSON.stringify(out.json ?? {}));
              } catch (e) {
                log('route', `${path} ${e?.stack ?? e}`);
                try {
                  res.statusCode = 500;
                  res.end('internal error');
                } catch { /* ignore */ }
              }
            },
          }));
        } catch (e) {
          log('route:register', `${path} ${e?.message ?? e}`);
        }
      }

      // 浏览器形态：直接改 index.html
      try {
        if (typeof webServer.tapIndex === 'function') trackDisposer(webServer.tapIndex(injectEntry));
      } catch (e) {
        log('route:tapIndex', String(e?.message ?? e));
      }
    };

    try {
      const existing = tryGet(ctx, 'webServer');
      if (existing) wire(existing);
      else if (typeof ctx.inject === 'function') {
        ctx.inject(['webServer'], (scoped) => {
          try {
            wire(scoped?.webServer ?? tryGet(scoped, 'webServer'));
          } catch (e) {
            log('ui:inject', String(e?.message ?? e));
          }
        });
      }
    } catch (e) {
      log('ui', String(e?.message ?? e));
    }
  }

  // Cordis 把插件 startup 的返回值当 effect body：返回 disposer 后，宿主 dispose
  // 插件时路由会被撤销；假 ctx 也可以直接调用它。
  return disposeUi;
}

/**
 * 把按会话的报告聚合成"一次对话"。
 *
 * 为什么必须聚合：一次任务里 subagent 会各留一个会话（实测：主会话 + 2 个 subagent
 * = 3 份报告）。UI 上按会话平铺，用户看到的是"同一次对话被分析了三次"，
 * 既碎片又对不上账。这里按 rootId 归组，总成本求和，主会话当详情入口。
 */
function groupConversations(reports) {
  const groups = new Map();
  for (const r of reports) {
    const key = r.rootId ?? r.id;
    let g = groups.get(key);
    if (!g) {
      g = {
        rootId: key,
        primaryId: null,
        hasTop: false,
        sessions: 0,
        subSessions: 0,
        totalReal: 0,
        requests: 0,
        toolCalls: 0,
        failedCalls: 0,
        latestAt: '',
        headline: '',
        checklist: [],
        parts: [],
      };
      groups.set(key, g);
    }
    const totals = r.totals ?? {};
    g.sessions += 1;
    g.totalReal += totals.totalReal ?? 0;
    g.requests += totals.requests ?? 0;
    g.toolCalls += totals.toolCalls ?? 0;
    g.failedCalls += totals.failedCalls ?? 0;
    g.parts.push({ id: r.id, top: !!r.top, totalReal: totals.totalReal ?? 0, requests: totals.requests ?? 0, generatedAt: r.generatedAt });
    if (!g.latestAt || String(r.generatedAt ?? '') > g.latestAt) g.latestAt = r.generatedAt ?? '';

    // 详情入口优先主会话；没有主会话时用最新一份（reports 已按时间倒序）
    const takeOver = (r.top && !g.hasTop) || !g.primaryId;
    if (takeOver) {
      g.primaryId = r.id;
      g.hasTop = g.hasTop || !!r.top;
      g.headline = r.headline ?? '';
      g.checklist = r.prescriptions ?? [];
    }
  }
  return [...groups.values()]
    .map(({ hasTop, ...g }) => ({ ...g, subSessions: g.sessions - 1 }))
    .sort((a, b) => String(b.latestAt).localeCompare(String(a.latestAt)));
}

/** 读服务但不要求 inject（Cordis 的 ctx.get 语义），失败返回 null。 */
function tryGet(ctx, name) {
  try {
    if (typeof ctx?.get === 'function') return ctx.get(name) ?? null;
  } catch { /* ignore */ }
  try {
    return ctx?.[name] ?? null;
  } catch {
    return null;
  }
}

/** 读 JSON 请求体（限 64KB，超了就断开）。 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = '';
    const done = (v) => {
      try { req.removeListener('data', onData); } catch { /* ignore */ }
      resolve(v);
    };
    const onData = (chunk) => {
      data += chunk;
      if (data.length > 64 * 1024) done(null);
    };
    req.on('data', onData);
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

function queryOf(req) {
  try {
    return new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function safeId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(id);
}

/** 报告摘要列表，按生成时间倒序。 */
function listSummaries(outDir) {
  try {
    return readdirSync(outDir)
      .filter((f) => f.startsWith('report-') && f.endsWith('.json'))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(outDir, f), 'utf8'));
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.generatedAt ?? '').localeCompare(String(a.generatedAt ?? '')));
  } catch {
    return [];
  }
}

/**
 * 最小信任栅栏。
 *
 * 策略（比 dsh-whale-widget 宽松一处，理由见下）：
 *   1. Host 必须是回环，或由宿主 `connection.requestRejection` 认可；否则 403（fail-closed）
 *   2. 带 Origin 时必须与 Host 同源；否则 403
 *
 * **不**因为 `Sec-Fetch-Site: cross-site` 一票否决：本插件所有路由都是只读 GET，
 * 跨站页面读不到响应体（没有 ACAO 头），拒绝它换不来安全性，却会把
 * 「浏览器扩展/程序化打开的标签页」挡在门外（实测：扩展发起的导航会被标成 cross-site）。
 */
function allowedRequest(req, ctx) {
  try {
    const host = String(req?.headers?.host ?? '').toLowerCase();
    if (!host) return false;

    // Origin 与 Host 必须同源（对只读接口而言，这条是防"页面被嵌进别处再借用户浏览器读"）
    const origin = req?.headers?.origin;
    if (typeof origin === 'string' && origin && origin !== 'null') {
      try {
        if (new URL(origin).host.toLowerCase() !== host) return false;
      } catch {
        return false;
      }
    }

    const hn = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    const loopback = hn === 'localhost' || hn.endsWith('.localhost') || hn === '::1' || /^127\.\d+\.\d+\.\d+$/.test(hn);
    if (loopback) return true;

    const conn = tryGet(ctx, 'connection');
    if (conn && typeof conn.requestRejection === 'function') {
      const code = conn.requestRejection(req);
      return code === undefined || code === null || code === false;
    }
    return false;
  } catch {
    return false;
  }
}

/** 一句话判断：UI 首屏只留这一行，不重复卡片里的数字。 */
function buildVerdictLine(conclusions, totals) {
  if (!(totals.requests > 0)) return '空会话，没有模型调用，不产出账单。';
  const top = conclusions[0];
  if (!top) return '未发现结构性浪费，不需要改配置。';
  const total = Math.max(1, totals.totalReal ?? 0);
  const lo = Math.round(((top.prescription?.expectedSavingTokens?.[0] ?? 0) / total) * 100);
  const hi = Math.round(((top.prescription?.expectedSavingTokens?.[1] ?? 0) / total) * 100);
  const share = lo === hi ? `${lo}%` : `${lo}–${hi}%`;
  return `${top.label ?? top.id}是最值得先改的一条，预计能省回 ${share} 的成本。`;
}

/**
 * 供 Web UI 的结构化摘要。
 * 导出后可以拿旧报告重新生成摘要，让升级前遗留的 .txt 报告也能出现在 Web UI 里。
 */
export function buildSummary({ id, top, loaded, model, verdict, measured }) {
  const t = model.totals ?? {};
  const denom = (t.inputReal ?? 0) + (t.cacheReadReal ?? 0);
  const parentId = model.header?.parentSession ?? null;
  return {
    id,
    // 一次对话 = 一个 rootId：subagent 会话归到发起它的主会话下
    rootId: parentId ?? id,
    top,
    generatedAt: loaded.generatedAt,
    session: { cwd: model.header?.cwd ?? null, preset: model.header?.agentPreset ?? null, events: model.events },
    headline: verdict.headline ?? '',
    totals: {
      totalReal: t.totalReal ?? 0,
      requests: t.requests ?? 0,
      toolCalls: t.toolCalls ?? 0,
      failedCalls: t.failedCalls ?? 0,
      barrenSteps: t.barrenSteps ?? 0,
      hitRate: denom > 0 ? (t.cacheReadReal ?? 0) / denom : null,
    },
    // 结构化建议：UI 直接用，不必解析正文
    prescriptions: (verdict.conclusions ?? []).map((c) => ({
      id: c.id,
      label: c.label ?? c.id,
      severity: c.severity,
      confidence: c.confidence,
      action: c.prescription?.action ?? '',
      howTo: c.prescription?.howTo ?? '',
      saving: c.prescription?.expectedSavingTokens ?? [0, 0],
    })),
    // 一句话判断（UI 首屏用）。headline 保留给文件/其它消费者，它比这个长得多。
    verdict: buildVerdictLine(verdict.conclusions ?? [], t),
    measured: measured ? { baselineKind: measured.baselineKind, nodeSum: measured.nodeSum, surfaceTokens: measured.surfaceTokens } : null,
  };
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
