/**
 * dsh-audit-probe —— 侦察插件。
 *
 * 目的不是产出报告，而是**把真实形状 dump 出来**，让正式插件不必猜：
 *   1. ctx 上各服务的实际方法名（sessions / sessionQuery / tokenMeter / tools）
 *   2. 事件负载的字段结构（session/flush、agent/turn-stopping、tool/call 等）
 *   3. ctx.tokenMeter.measure() 的真实返回，尤其是 baseline.kind
 *      —— 这决定账单是"实测"还是"估算"，是 v0.4 遗留的唯一未知项
 *
 * 设计约束（宿主里跑，不能添乱）：
 *   - 全部逻辑包在 try/catch 里，任何失败都只写一行 error 记录，绝不抛出。
 *   - 不注册工具、不改配置、不阻塞事件链（不 await 重活，同步写小文件）。
 *   - 输出追加到 $DSH_HOME/dsh-audit/probe.jsonl，便于离线读。
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const name = 'dsh-audit-probe';

/**
 * 必须声明 inject：Cordis 不允许在未注入的情况下读取服务，
 * 直接访问 ctx.tokenMeter 会抛 `cannot get property "x" without inject`。
 * 这条是实测出来的（见 docs/evidence 探针记录），不是文档明写的。
 */
export const inject = ['sessions', 'sessionQuery', 'tokenMeter'];

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const OUT_DIR = join(HOME, 'dsh-audit');
const OUT_FILE = join(OUT_DIR, 'probe.jsonl');

function write(record) {
  try {
    mkdirSync(OUT_DIR, { recursive: true });
    appendFileSync(OUT_FILE, `${JSON.stringify({ t: Date.now(), ...record })}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 安全取对象自有属性名（含原型链上的一层，便于看到 class 方法）。 */
function surfaceOf(obj, limit = 60) {
  if (!obj) return null;
  const seen = new Set();
  const out = [];
  let cur = obj;
  let depth = 0;
  while (cur && depth < 3 && out.length < limit) {
    for (const k of Object.getOwnPropertyNames(cur)) {
      if (k === 'constructor' || seen.has(k)) continue;
      seen.add(k);
      let type = typeof obj[k];
      if (type === 'object' && obj[k] !== null) type = Array.isArray(obj[k]) ? 'array' : 'object';
      out.push(`${k}:${type}`);
      if (out.length >= limit) break;
    }
    cur = Object.getPrototypeOf(cur);
    depth++;
  }
  return out;
}

/** 深拷贝并截断，避免把大 payload 写爆。 */
function preview(value, maxChars = 1200, depth = 0) {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'string') return value.length > maxChars ? `${value.slice(0, maxChars)}…(${value.length})` : value;
  if (t === 'number' || t === 'boolean') return value;
  if (t === 'function') return `[fn ${value.name || 'anonymous'}]`;
  if (depth >= 3) return Array.isArray(value) ? `[array ${value.length}]` : '[object]';
  if (Array.isArray(value)) {
    return value.slice(0, 4).map((v) => preview(v, Math.floor(maxChars / 2), depth + 1));
  }
  const out = {};
  for (const k of Object.keys(value).slice(0, 25)) {
    out[k] = preview(value[k], Math.floor(maxChars / 3), depth + 1);
  }
  return out;
}

export function apply(ctx, config = {}) {
  const enabled = config.enabled !== false;
  if (!enabled) return;

  write({ phase: 'loaded', cwd: process.cwd(), dshHome: HOME });

  // ── 1. 服务面侦察 ────────────────────────────────────────────────
  const serviceNames = ['sessions', 'sessionQuery', 'tokenMeter', 'tools', 'llm', 'agent', 'session'];
  const surfaces = {};
  for (const s of serviceNames) {
    try {
      surfaces[s] = surfaceOf(ctx[s]);
    } catch (e) {
      surfaces[s] = `error: ${e?.message ?? e}`;
    }
  }
  write({ phase: 'services', surfaces });

  // ── 2. 事件负载侦察 ──────────────────────────────────────────────
  // 只挂轻量事件，避免在高频事件上做重活。
  const events = ['session/created', 'session/flush', 'agent/turn-stopping', 'step/end'];
  for (const ev of events) {
    try {
      ctx.on(ev, (payload) => {
        try {
          write({
            phase: 'event',
            event: ev,
            payloadKeys: payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 30) : typeof payload,
            payload: preview(payload),
          });
          // session/flush 时尝试测量 tokenMeter，验证 baseline.kind
          if (ev === 'session/flush') probeMeasure(ctx, payload);
        } catch (e) {
          write({ phase: 'error', event: ev, message: e?.message ?? String(e) });
        }
      });
    } catch (e) {
      write({ phase: 'on-failed', event: ev, message: e?.message ?? String(e) });
    }
  }

  write({ phase: 'ready', events });
}

/** 尝试多种途径拿到 Session 并调用 tokenMeter.measure，记录真实返回。 */
function probeMeasure(ctx, payload) {
  const tm = ctx.tokenMeter;
  if (!tm) {
    write({ phase: 'measure', ok: false, reason: 'ctx.tokenMeter 不存在' });
    return;
  }
  // 实测结论：session/flush 的 payload **本身就是 Session 对象**
  // （自有键为 log / surfaceManager / header / eventsSnapshot …），不是 { session } 包装。
  const candidates = [];
  if (payload && typeof payload === 'object' && payload.header && payload.log) candidates.push(['payload(session)', payload]);
  if (payload?.session) candidates.push(['payload.session', payload.session]);
  try {
    const id = payload?.header?.id ?? payload?.sessionId;
    if (id && typeof ctx.sessions?.get === 'function') candidates.push(['ctx.sessions.get', ctx.sessions.get(id)]);
  } catch { /* ignore */ }

  if (!candidates.length) {
    write({ phase: 'measure', ok: false, reason: '拿不到 Session 对象', candidatesTried: [] });
    return;
  }

  for (const [how, session] of candidates) {
    try {
      const m = tm.measure(session);
      write({
        phase: 'measure',
        ok: true,
        via: how,
        sessionId: session?.header?.id ?? null,
        baselineKind: m?.baseline?.kind ?? null,
        baseline: preview(m?.baseline),
        logRevision: m?.logRevision ?? null,
        totalTokens: m?.totalTokens ?? null,
        surfaceTokens: m?.surfaceTokens ?? null,
        surfaceDeltaTokens: m?.surfaceDeltaTokens ?? null,
        nodeCount: Array.isArray(m?.nodes) ? m.nodes.length : null,
        nodeSample: Array.isArray(m?.nodes) ? preview(m.nodes.slice(0, 4)) : null,
      });
      probeEvents(ctx, session);
      return;
    } catch (e) {
      write({ phase: 'measure', ok: false, via: how, message: e?.message ?? String(e) });
    }
  }
}

/** dump sessionQuery.listEvents 的返回结构，供正式插件写适配层。 */
function probeEvents(ctx, session) {
  const id = session?.header?.id;
  const q = ctx.sessionQuery;
  if (!id || !q || typeof q.listEvents !== 'function') {
    write({ phase: 'events-probe', ok: false, reason: 'listEvents 不可用', id: id ?? null });
    return;
  }
  q.listEvents(id)
    .then((records) => {
      const types = {};
      for (const r of records ?? []) {
        const k = r?.type ?? r?.kind ?? r?.event?.type ?? '?';
        types[k] = (types[k] ?? 0) + 1;
      }
      write({
        phase: 'events-probe',
        ok: true,
        id,
        count: Array.isArray(records) ? records.length : null,
        recordKeys: Array.isArray(records) && records[0] ? Object.keys(records[0]) : null,
        firstRecord: Array.isArray(records) ? preview(records[0], 900) : null,
        lastRecord: Array.isArray(records) ? preview(records[records.length - 1], 600) : null,
        typeHistogram: types,
      });
    })
    .catch((e) => write({ phase: 'events-probe', ok: false, id, message: e?.message ?? String(e) }));
}
