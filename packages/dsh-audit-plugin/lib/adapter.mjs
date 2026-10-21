/**
 * 适配层：把 DSH 一方服务返回的结构，转成分析内核能吃的形状。
 *
 * 这里的每一个字段名都来自 2026-10-21 的探针实测（见 docs/evidence/2026-10-21-探针摘要.json），
 * 不是按文档猜的：
 *   - `session/flush` 的 payload **本身就是 Session**（含 log / surfaceManager / header）
 *   - `ctx.sessionQuery.listEvents(id)` 返回 `{ sessionId, seq, type, time, surface }`
 *     —— **不含 data**，所以只能用来做概览，做分析必须用 readSession
 *   - `ctx.tokenMeter.measure(session)` 返回
 *     `{ logRevision, baseline:{kind,tokens}, totalTokens, surfaceTokens, surfaceDeltaTokens, nodes[{seq,tokens,heuristicTokens}] }`
 *   - `baseline.kind` 观察到三种取值：`none`（无表面）、`estimated`（无用量锚点）、
 *     `usage`（有可复用锚点，文档定义）
 *
 * readSession 的确切形状尚未在本机验证成功（渠道校验导致会话无法完成），
 * 因此 eventsFromSnapshot 写成多候选探测：拿到哪个用哪个，拿不到就明确报错，
 * 不静默返回空数组（否则会产出一份"没有浪费"的假报告）。
 */

/** 从多种可能的快照形状里取出事件数组。 */
export function eventsFromSnapshot(snapshot) {
  if (!snapshot) return null;
  const candidates = [
    ['snapshot.events', snapshot.events],
    ['snapshot.log', snapshot.log],
    ['snapshot.records', snapshot.records],
    ['snapshot.snapshot.events', snapshot.snapshot?.events],
    ['snapshot.log.events', snapshot.log?.events],
    ['snapshot.log.records', snapshot.log?.records],
  ];
  for (const [where, value] of candidates) {
    if (Array.isArray(value) && value.length > 0) return { where, events: value.map(normalizeEvent).filter(Boolean) };
  }
  return null;
}

/** 把一条原始事件记录归一成 { type, seq, time, data }。 */
export function normalizeEvent(record) {
  if (!record || typeof record !== 'object') return null;
  const type = record.type ?? record.event?.type ?? record.kind ?? null;
  if (!type) return null;
  const data = record.data ?? record.payload ?? record.event?.data ?? null;
  return {
    type,
    seq: record.seq ?? record.sequence ?? 0,
    time: record.time ?? record.timestamp ?? 0,
    data: data ?? {},
  };
}

/** 把 readSession 的结果包装成分析内核需要的 loaded 形状。 */
export function loadedFromSnapshot(snapshot, file = '(in-host)') {
  const got = eventsFromSnapshot(snapshot);
  if (!got) {
    throw new Error('无法从 sessionQuery.readSession 的返回中定位事件数组（形状未适配）');
  }
  const events = got.events.slice();

  // 实测（2026-10-21 debug-snapshot.json）：readSession 返回
  //   { session: <SessionHeader>, inheritedEventCount, events: [{type,seq,time,data}] }
  // 头部在 `session` 上，不叫 `header`；且事件流里不含 `session` 类型事件。
  // 缺这条合成事件时，报告头部的会话 id 会显示成 "?"。
  const header = snapshot?.header ?? snapshot?.session ?? null;
  if (header?.id && !events.some((e) => e.type === 'session')) {
    events.unshift({
      type: 'session',
      seq: -1,
      time: header.createdAt ?? 0,
      data: {
        id: header.id,
        cwd: header.cwd,
        createdAt: header.createdAt,
        version: header.version,
        agentPreset: header.agentPreset,
        isSeeded: header.isSeeded,
        delegationDepth: header.delegationDepth,
      },
    });
  }

  return {
    file,
    bytesOnDisk: 0,
    frames: 0,
    bytesDecoded: 0,
    badLines: 0,
    frameWarnings: 0,
    inHost: true,
    eventsFrom: got.where,
    events,
    __source: got.where,
  };
}

/**
 * 把 tokenMeter 的平台定价挂到分析结果上。
 *
 * 这是插件相对离线 CLI 的唯一增量：离线只能按字符估算结果大小，
 * 而这里拿到的是**平台按实际路由定价的每个 surface 节点的 token 数**。
 *
 * 注意口径：`measure()` 的 totalTokens 是"请求+响应压力"的完整包络，
 * 不等于账单总额（实测 totalTokens=10729 而 surfaceTokens=2512）；
 * 所以 totalTokens 只作参考，逐节点定价才是可用信息。
 */
export function attachMeasure(model, measurement) {
  if (!measurement) return { measured: null, nodes: [] };
  const byType = new Map();
  for (const ev of model.__loaded?.events ?? []) byType.set(ev.seq, ev);

  // 事件 seq → 可读标签
  const labelOf = (seq) => {
    const ev = byType.get(seq);
    if (!ev) return { label: `seq ${seq}`, type: '?' };
    if (ev.type === 'tool/result') {
      const callId = ev.data?.message?.toolCallId;
      const call = (model.calls ?? []).find((c) => c.id === callId);
      return { label: `工具结果 · ${call?.name ?? 'unknown'}`, type: ev.type };
    }
    if (ev.type === 'tool/call') return { label: `工具调用 · ${ev.data?.name ?? 'unknown'}`, type: ev.type };
    if (ev.type === 'system/message') return { label: '系统提示', type: ev.type };
    if (ev.type === 'user/message') return { label: '用户消息', type: ev.type };
    return { label: ev.type, type: ev.type };
  };

  const nodes = (measurement.nodes ?? [])
    .map((n) => ({ ...n, ...labelOf(n.seq) }))
    .sort((a, b) => b.tokens - a.tokens);

  const sum = (arr) => arr.reduce((a, x) => a + (x.tokens ?? 0), 0);
  return {
    measured: {
      baselineKind: measurement.baseline?.kind ?? null,
      logRevision: measurement.logRevision ?? null,
      totalTokens: measurement.totalTokens ?? null,
      surfaceTokens: measurement.surfaceTokens ?? null,
      nodeCount: nodes.length,
      nodeSum: sum(nodes),
    },
    nodes,
  };
}
