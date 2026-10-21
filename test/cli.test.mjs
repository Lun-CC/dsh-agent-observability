/**
 * 离线 CLI 端到端测试。
 *
 * 覆盖两件只有真跑 CLI 才能验证的事：
 *   1. 多帧 zstd（append-only 日志每次 flush 追加一个独立帧）必须全部解出来，
 *      只解第一帧会静默丢事件 —— 这是 0.4 版踩过的坑
 *   2. CLI 的 JSON 输出形状与口径（用量恒等式、无产出步、失败分类）
 *
 * 夹具在临时目录现场生成，不依赖本机任何真实会话。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin', 'dsh-audit.mjs');

const usage = (input, cacheRead, output) => ({
  inputTokens: input,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: 0,
  outputTokens: output,
  totalTokens: input + cacheRead + output,
});

/** 造一个会话目录：日志按 3 个帧写入，模拟 append-only 的真实落盘方式。 */
function makeSession() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-audit-cli-'));
  // 按真实布局：<root>/<cwd 分组>/<session-xxx>/session.v4.jsonl.zstd
  const sessionDir = join(dir, '--E-x--', 'session-cli-fixture');
  mkdirSync(sessionDir, { recursive: true });

  const frame1 = [
    { type: 'session', seq: 0, time: 1, version: 4, id: 'session-cli-fixture', cwd: '/x', agentPreset: 'standard' },
    // S1：两步里唯一一次调用失败；S2 成功
    { type: 'assistant/message', seq: 1, time: 2, data: { turn: 1, step: 1, usage: usage(9000, 0, 200) } },
    { type: 'tool/call', seq: 2, time: 3, data: { callId: 'a', name: 'read', arguments: '{"file_path":"/nope"}', turn: 1, step: 1 } },
  ];
  const frame2 = [
    { type: 'tool/result', seq: 3, time: 4, data: { turn: 1, step: 1, message: { toolCallId: 'a', isError: false, content: [{ type: 'text', text: 'Error: not found: /nope' }] } } },
  ];
  const frame3 = [
    { type: 'assistant/message', seq: 4, time: 5, data: { turn: 1, step: 2, usage: usage(120, 9000, 150) } },
  ];

  const encode = (arr) => zstdCompressSync(Buffer.from(arr.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8'));
  // 三个独立帧直接拼接 —— 与 append-only flush 的落盘形态一致
  writeFileSync(join(sessionDir, 'session.v4.jsonl.zstd'), Buffer.concat([encode(frame1), encode(frame2), encode(frame3)]));

  return dir;
}

function runJson(target) {
  const out = execFileSync(process.execPath, [CLI, target, '--json'], { encoding: 'utf8' });
  return JSON.parse(out);
}

test('多帧 zstd：3 个帧里的 5 条事件全部解出', () => {
  const dir = makeSession();
  const [result] = runJson(dir);
  const [single] = runJson(join(dir, '--E-x--', 'session-cli-fixture'));

  for (const r of [result, single]) {
    assert.ok(r.source, '应有 source 信息');
    assert.equal(r.totals.requests, 2, `应识别 2 次请求，实际 ${r.totals.requests}`);
    assert.equal(r.totals.toolCalls, 1);
  }
});

test('口径：用量恒等式与无产出步', () => {
  const dir = makeSession();
  const [r] = runJson(dir);
  // S1 9000+200=9200，S2 120+9000+150=9270
  assert.equal(r.totals.totalReal, 9200 + 9270);
  assert.equal(r.totals.inputReal, 9000 + 120);
  assert.equal(r.totals.cacheReadReal, 9000);
  // S1 唯一一次工具调用失败 → 无产出步
  assert.equal(r.totals.barrenSteps, 1);
  assert.equal(r.totals.failedCalls, 1);
  assert.equal(r.totals.toolCalls, 1);
});

test('CLI 对有处方的会话给出结论条目', () => {
  const dir = makeSession();
  const [r] = runJson(dir);
  assert.ok(Array.isArray(r.conclusions));
  assert.ok(r.conclusions.length >= 1, '无产出步应触发处方');
  assert.ok(r.conclusions.some((c) => c.id === 'barren-steps'));
  assert.ok(typeof r.headline === 'string' && r.headline.length > 0);
});

test('空目录不崩：没有任何 session 目录时给出可读错误', () => {
  const empty = mkdtempSync(join(tmpdir(), 'dsh-audit-empty-'));
  let failed = false;
  try {
    execFileSync(process.execPath, [CLI, empty, '--json'], { encoding: 'utf8', stdio: 'pipe' });
  } catch {
    failed = true;
  }
  assert.ok(failed, '没有会话时应以非零码退出，而不是静默成功');
});
