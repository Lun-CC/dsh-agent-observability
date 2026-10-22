/**
 * DSH session log 读取与基础文本工具。
 *
 * 关键事实（2026-10-21 实测）：
 *   session 日志落盘为 `session.v4.jsonl.zstd`，且 append-only —— 每次 flush 追加一个
 *   独立 zstd 帧。Node 的 zstdDecompressSync 只解第一帧，必须逐帧拆分再拼接。
 *   实测样本：46,190 字节 / 60 帧 / 解压后 130,547 字节 / 111 条事件。
 */

import { zstdDecompressSync } from 'node:zlib';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 找出所有 zstd 帧起始偏移。 */
function frameOffsets(buf) {
  const out = [];
  let p = 0;
  while (p < buf.length) {
    const i = buf.indexOf(MAGIC, p);
    if (i === -1) break;
    out.push(i);
    p = i + 4;
  }
  return out;
}

/**
 * 解码多帧拼接的 zstd 日志。
 * 帧边界按 magic 扫描；若某帧单独解压失败，则与后续帧合并重试（magic 可能出现在压缩数据内部）。
 */
export function decodeZstdLog(buf) {
  const offs = frameOffsets(buf);
  if (offs.length === 0) throw new Error('不是 zstd 数据：未找到帧头');

  const chunks = [];
  let warnings = 0;

  for (let i = 0; i < offs.length; i++) {
    let decoded = null;
    let consumedTo = i;
    for (let j = i; j < offs.length; j++) {
      const end = j + 1 < offs.length ? offs[j + 1] : buf.length;
      try {
        decoded = zstdDecompressSync(buf.subarray(offs[i], end)).toString('utf8');
        consumedTo = j;
        break;
      } catch {
        /* 合并下一帧再试 */
      }
    }
    if (decoded === null) {
      warnings++;
    } else {
      chunks.push(decoded);
      i = consumedTo;
    }
  }

  return { text: chunks.join(''), frames: offs.length, warnings };
}

/** 读取并解析一个 session 目录（或直接给 .zstd 文件）。 */
export function loadSession(target) {
  let file = target;
  if (statSync(target).isDirectory()) {
    // 目录里可能不止一个日志（历史轮转/被拷进来的旧日志）。取最近修改的那个，
    // 而不是 readdir 的第一个 —— 保证同一输入在不同机器/不同文件系统顺序下结果一致。
    const hits = readdirSync(target).filter((n) => n.endsWith('.jsonl.zstd'));
    if (!hits.length) throw new Error(`目录内没有 .jsonl.zstd：${target}`);
    hits.sort((a, b) => {
      const ma = statSync(join(target, a)).mtimeMs;
      const mb = statSync(join(target, b)).mtimeMs;
      return mb - ma || a.localeCompare(b);
    });
    file = join(target, hits[0]);
  }

  const buf = readFileSync(file);
  const { text, frames, warnings } = decodeZstdLog(buf);

  const events = [];
  let badLines = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      badLines++;
    }
  }

  return {
    file,
    bytesOnDisk: buf.length,
    frames,
    frameWarnings: warnings,
    bytesDecoded: text.length,
    badLines,
    events: events.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)),
  };
}

/**
 * 列出一个目录下所有「会话目录」（直接含 .jsonl.zstd 的目录），最多递归 3 层。
 *
 * 不假设 sessions/<cwd 分组>/session-<id>/ 的固定两级结构：不同版本、被改名/搬移的
 * 会话目录、直接把 group 目录或 sessions 根目录传进来都能找到；结果排序，跨机器一致。
 */
export function listSessionDirs(root, maxDepth = 3) {
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 无权限/坏链接的目录跳过，不让一次扫描整体失败
    }
    if (entries.some((e) => e.isFile() && e.name.endsWith('.jsonl.zstd'))) {
      out.push(dir);
      return; // 已是一个会话目录，不再往下钻
    }
    if (depth >= maxDepth) return;
    for (const e of entries) if (e.isDirectory()) walk(join(dir, e.name), depth + 1);
  };
  walk(root, 0);
  out.sort();
  return out;
}

/**
 * 启发式 token 估算。CJK 按 1 token/字（偏保守上界），其余按 3.6 字符/token。
 * 这是估算，不是测量 —— 测量值来自 assistant/message.data.usage。
 */
export function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.codePointAt(0) >= 0x2e80) cjk++;
    else other++;
  }
  return Math.ceil(cjk + other / 3.6);
}

/**
 * 平台自己的估算口径：spill-policy / token-meter 用的是「4 字符 1 token + 每块 4 token 结构开销」。
 * 判断「平台会不会真的落盘这条结果」时必须用这个口径，用上面那个会错判。
 */
export function estimateTokensOfficial(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4) + 4;
}

/**
 * spill-policy 显式豁免的工具（读源码确认，勿凭印象改动）。
 * 源码：dsh-spill-policy/lib/types/index.js
 *   if (decision.kind !== 'accept' || Object.hasOwn(decision,'value') || exec.name === 'read') return decision;
 * 即：read 的结果永不落盘，调 maxInlineTokens 对它无效。
 */
export const SPILL_EXEMPT_TOOLS = new Set(['read']);

/** 从 message.content 抽出纯文本。 */
export function messageText(message) {
  if (!message?.content) return '';
  if (typeof message.content === 'string') return message.content;
  return message.content
    .map((b) => (typeof b === 'string' ? b : b?.text ?? (b?.type === 'tool-call' ? b.arguments ?? '' : '')))
    .filter(Boolean)
    .join('\n');
}
