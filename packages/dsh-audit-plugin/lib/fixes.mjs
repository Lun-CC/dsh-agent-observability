/**
 * 可执行的整改。
 *
 * 为什么需要：报告里"建议开 spill"这种话，用户看完还得自己去翻配置。
 * 这里把处方映射到**真实存在的配置项**或**项目约定文件**上，一键写入并可撤销。
 *
 * 配置项来自本机 --dump-config 的实测（2026-10-22）：
 *   - spill-policy        { maxInlineTokens: 12500 }         ← 阈值太高，2k 的结果根本不落盘
 *   - tool-result-pruner  { thresholdChars, headChars, tailChars } + disabled: true
 *   - compaction-basic    { auto: false } + disabled: true
 *
 * 注意：patch 层的 `config` 是**整体替换**而非深合并，所以每个块都写全所有键。
 * 另：compaction 的生效实例在 preset 分组内部（`- id: compaction` 嵌套行），
 * 顶层 patch 改不到 —— 所以这里不碰 compaction，改用顶层可达的 tool-result-pruner。
 *
 * 安全约束：
 *   - 只追加带标记的块，不修改用户已有内容
 *   - 写前备份为 <文件>.bak-<时间戳>
 *   - 撤销按标记整块删除
 *   - 任何失败都不抛出到宿主
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

/** 处方 id → 整改动作。没有列出的处方属于"只能人工判断"，不硬给自动方案。 */
export const FIX_RULES = {
  spill: {
    kind: 'patch',
    title: '调低 spill 阈值',
    entry: 'spill-policy',
    config: { maxInlineTokens: 3000 },
    note: '超过 3000 token 的工具结果落盘，只回 locator 与预览。注意：read 的结果被豁免，此项对 read 无效',
    requiresRestart: true,
  },
  'context-growth': {
    kind: 'patch',
    title: '启用工具结果裁剪',
    entry: 'tool-result-pruner',
    config: { thresholdChars: 4096, headChars: 2048, tailChars: 512 },
    disabled: false,
    note: '旧工具结果只保留头尾，中间折叠；上下文不再只增不减',
    requiresRestart: true,
  },
  'heavy-ingest': {
    kind: 'agents',
    title: '写入读取约定',
    section: 'reading',
    text: [
      '读代码前先用 glob / grep 定位，不要整目录整份读取。',
      '单文件超过 300 行时用 offset / limit 分段读，只取相关片段。',
      '一个步骤里不要同时整份读取多个文件。',
    ],
  },
  'barren-steps': {
    kind: 'agents',
    title: '写入环境事实',
    section: 'env',
    text: [], // 由 buildEnvFacts 现场填充
  },
};

const MARK = (id) => `# >>> dsh-cost-audit:${id}`;
const MARK_END = (id) => `# <<< dsh-cost-audit:${id}`;

/** 极简 YAML 输出（只支持标量 / 一层嵌套对象），够写 patch 块用。 */
function toYaml(obj, indent = 0) {
  const pad = '  '.repeat(indent);
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out.push(`${pad}${k}:`);
      out.push(...toYaml(v, indent + 1));
    } else if (Array.isArray(v)) {
      out.push(`${pad}${k}: [${v.map((x) => String(x)).join(', ')}]`);
    } else if (typeof v === 'string') {
      out.push(`${pad}${k}: ${v}`);
    } else {
      out.push(`${pad}${k}: ${v}`);
    }
  }
  return out;
}

/**
 * 找到装着本插件的 profile 目录。
 * 不依赖进程 argv（桌面端拿不到），改用"哪个 profile 的清单里有我"这种自证方式。
 */
export function resolveProfileDir(dshHome) {
  const root = join(dshHome, 'profiles');
  if (!existsSync(root)) return null;
  const hits = [];
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = join(root, d.name);
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      const inBundles = (pkg.dsh?.profile?.bundles ?? []).includes('dsh-audit-plugin');
      const inDeps = Object.hasOwn(pkg.dependencies ?? {}, 'dsh-audit-plugin');
      if (inBundles || inDeps) hits.push({ dir, mtime: statSync(join(dir, 'package.json')).mtimeMs });
    } catch { /* 跳过损坏/无清单的目录 */ }
  }
  hits.sort((a, b) => b.mtime - a.mtime);
  return hits[0]?.dir ?? null;
}

/** 当前已应用了哪些整改（按标记扫描）。 */
export function appliedFixes(profileDir) {
  const state = {};
  if (!profileDir) return state;
  let text = '';
  try {
    text = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8');
  } catch {
    return state;
  }
  for (const id of Object.keys(FIX_RULES)) if (text.includes(MARK(id))) state[id] = true;
  return state;
}

/** 生成将要写入的片段（供 UI 预览）。 */
export function previewFix(id, { cwd, profileDir } = {}) {
  const rule = FIX_RULES[id];
  if (!rule) return null;
  if (rule.kind === 'patch') {
    const lines = [`- id: ${rule.entry}`];
    if (rule.disabled !== undefined) lines.push(`  disabled: ${rule.disabled}`);
    lines.push('  config:');
    lines.push(...toYaml(rule.config, 2));
    return { kind: 'patch', target: join(profileDir ?? '$DSH_HOME/profiles/<profile>', 'cordis.patch.yml'), text: lines.join('\n'), note: rule.note };
  }
  return { kind: 'agents', target: join(cwd ?? '<项目目录>', 'AGENTS.md'), text: buildAgentsSection(id, cwd), note: '写入项目约定文件，下一次任务生效' };
}

/** AGENTS.md 段落内容。 */
function buildAgentsSection(id, cwd) {
  const rule = FIX_RULES[id];
  if (id === 'barren-steps') return buildEnvFacts(cwd);
  return rule.text.map((l) => `- ${l}`).join('\n');
}

/** 尽量从项目里读真实环境事实，读不到就留占位而不是瞎写。 */
function buildEnvFacts(cwd) {
  const facts = [];
  if (cwd) facts.push(`- 仓库根目录：\`${cwd}\``);
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    const scripts = Object.entries(pkg.scripts ?? {});
    if (scripts.length) {
      facts.push('- 可用命令：');
      for (const [k, v] of scripts.slice(0, 8)) facts.push(`  - \`npm run ${k}\` → \`${v}\``);
    }
  } catch { /* 没有 package.json 就跳过 */ }
  if (!facts.length) facts.push('- （在此补充：仓库根目录、构建命令、日志位置）');
  return facts.join('\n');
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

/** 应用一个整整改。返回 {changed, file, message}。 */
export function applyFix(id, { dshHome, cwd } = {}) {
  const rule = FIX_RULES[id];
  if (!rule) return { changed: false, message: `没有可自动执行的整改：${id}` };

  if (rule.kind === 'patch') {
    const profileDir = resolveProfileDir(dshHome);
    if (!profileDir) return { changed: false, message: '找不到装着本插件的 profile 目录' };
    const file = join(profileDir, 'cordis.patch.yml');
    let before = '';
    try {
      before = readFileSync(file, 'utf8');
    } catch { /* 文件可能不存在 */ }
    if (before.includes(MARK(id))) return { changed: false, message: '已经应用过了' };

    const lines = [`- id: ${rule.entry}`];
    if (rule.disabled !== undefined) lines.push(`  disabled: ${rule.disabled}`);
    lines.push('  config:');
    lines.push(...toYaml(rule.config, 2));
    const block = ['', `${MARK(id)} (${new Date().toISOString()})`, ...lines, MARK_END(id), ''].join('\n');

    try {
      if (before) copyFileSync(file, `${file}.bak-${stamp()}`);
      writeFileSync(file, `${before.replace(/\s*$/, '')}\n${block}`, 'utf8');
    } catch (e) {
      return { changed: false, message: `写入失败：${e.message}` };
    }
    return { changed: true, file, message: `已写入 ${file}，重启 DSH 后生效` };
  }

  // AGENTS.md
  if (!cwd) return { changed: false, message: '不知道项目目录，无法写 AGENTS.md' };
  const file = join(cwd, 'AGENTS.md');
  let before = '';
  try {
    before = readFileSync(file, 'utf8');
  } catch { /* 新建 */ }
  if (before.includes(`dsh-cost-audit:${id}`)) return { changed: false, message: '已经应用过了' };

  const body = buildAgentsSection(id, cwd);
  const section = ['', `<!-- dsh-cost-audit:${id} -->`, `## ${rule.title}（dsh-cost-audit 生成）`, '', body, `<!-- /dsh-cost-audit:${id} -->`, ''].join('\n');
  try {
    if (before) copyFileSync(file, `${file}.bak-${stamp()}`);
    writeFileSync(file, `${before.replace(/\s*$/, '')}\n${section}`, 'utf8');
  } catch (e) {
    return { changed: false, message: `写入失败：${e.message}` };
  }
  return { changed: true, file, message: `已写入 ${file}` };
}

/** 撤销：按标记整块删除，不碰其它内容。 */
export function revertFix(id, { dshHome, cwd } = {}) {
  const rule = FIX_RULES[id];
  if (!rule) return { changed: false, message: `没有可撤销的整改：${id}` };

  const file = rule.kind === 'patch'
    ? (() => {
        const p = resolveProfileDir(dshHome);
        return p ? join(p, 'cordis.patch.yml') : null;
      })()
    : (cwd ? join(cwd, 'AGENTS.md') : null);
  if (!file) return { changed: false, message: '定位不到目标文件' };

  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { changed: false, message: '目标文件不存在' };
  }

  // patch 用注释标记，AGENTS.md 用 HTML 注释
  const pairs = rule.kind === 'patch'
    ? [[MARK(id), MARK_END(id)]]
    : [[`<!-- dsh-cost-audit:${id} -->`, `<!-- /dsh-cost-audit:${id} -->`]];
  const [start, end] = pairs[0];
  const i = text.indexOf(start);
  const j = text.indexOf(end);
  if (i < 0 || j < 0) return { changed: false, message: '没有找到已应用的记录' };

  const next = `${text.slice(0, i)}${text.slice(j + end.length)}`.replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n');
  try {
    copyFileSync(file, `${file}.bak-${stamp()}`);
    writeFileSync(file, next, 'utf8');
  } catch (e) {
    return { changed: false, message: `撤销失败：${e.message}` };
  }
  return { changed: true, file, message: '已撤销，重启 DSH 后生效' };
}

/** 给摘要里的每条处方挂上"能不能自动改"。 */
export function decorateFixes(prescriptions, { profileDir, cwd } = {}) {
  const applied = appliedFixes(profileDir);
  return (prescriptions ?? []).map((p) => {
    // 处方自己声明了不可自动改（例如"平台根本不生效"这类），就别给按钮
    const rule = p.fixable === false ? null : FIX_RULES[p.id];
    return {
      ...p,
      fix: rule
        ? { title: rule.title, kind: rule.kind, applied: !!applied[p.id], requiresRestart: !!rule.requiresRestart, note: rule.note ?? '写入项目约定文件，下一次任务生效' }
        : null,
    };
  });
}
