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

import { existsSync, readFileSync, writeFileSync, readdirSync, copyFileSync, unlinkSync } from 'node:fs';
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

/** 本插件的包名（profile 清单里认它）。 */
const PKG = 'dsh-audit-plugin';

/** 所有「装了本插件」的 profile（按名字排序，保证展示稳定）。 */
export function listProfileDirs(dshHome) {
  const root = join(dshHome, 'profiles');
  if (!existsSync(root)) return [];
  const hits = [];
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = join(root, d.name);
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      const inBundles = (pkg.dsh?.profile?.bundles ?? []).includes(PKG);
      const inDeps = Object.hasOwn(pkg.dependencies ?? {}, PKG);
      if (inBundles || inDeps) hits.push({ name: d.name, dir });
    } catch { /* 跳过损坏/无清单的目录 */ }
  }
  return hits.sort((a, b) => a.name.localeCompare(b.name));
}

/** 多个 profile 时的候选提示：绝不替用户按 mtime 猜。 */
export function profileChoiceMessage(profiles) {
  return [
    `检测到 ${profiles.length} 个装了本插件的 profile，无法确定要写入哪一个：`,
    ...profiles.map((p) => `  - ${p.name}  (${p.dir})`),
    '为避免写错环境，插件不会按修改时间猜；请在页面上选择目标 profile，或命令行传 --profile <name>。',
  ].join('\n');
}

/**
 * 选定整改写入的目标 profile。
 *
 * 旧实现按 package.json 的 mtime 取最新 —— 多 profile 时会把 patch 写进
 * 另一个装了插件的 profile，属于「静默改错环境」。现在：
 *   - 显式指定（UI 选择 / --profile）：必须在候选里，否则拒绝
 *   - 未指定：恰好一个 → 用它；零个 → 报没有；多个 → 报歧义并列出候选
 *
 * 返回 { dir, profiles, ambiguous, error }。
 */
export function resolveProfileDir(dshHome, explicit) {
  const profiles = listProfileDirs(dshHome);
  const norm = (p) => String(p ?? '').replace(/[\\/]+$/, '').toLowerCase();
  if (explicit) {
    const hit = profiles.find((p) => p.name === explicit || norm(p.dir) === norm(explicit));
    if (hit) return { dir: hit.dir, profiles, ambiguous: false };
    return { dir: null, profiles, ambiguous: false, error: `指定的 profile 没有装本插件：${explicit}` };
  }
  if (profiles.length === 1) return { dir: profiles[0].dir, profiles, ambiguous: false };
  if (profiles.length === 0) return { dir: null, profiles, ambiguous: false, error: '找不到装着本插件的 profile 目录' };
  return { dir: null, profiles, ambiguous: true };
}

/** 严格按 UTF-8 读文本：编码不对就报错，绝不「读坏再写回」毁掉 GBK/UTF-16 文件。 */
function readTextFile(file) {
  let buf;
  try {
    buf = readFileSync(file);
  } catch {
    return { exists: false, text: '' };
  }
  if (buf.length === 0) return { exists: true, text: '' };
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { exists: true, error: '带 UTF-8 BOM' };
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) return { exists: true, error: '是 UTF-16 编码' };
  try {
    return { exists: true, text: new TextDecoder('utf-8', { fatal: true }).decode(buf) };
  } catch {
    return { exists: true, error: '不是合法 UTF-8（可能是 GBK）' };
  }
}

function countOf(hay, needle) {
  let n = 0;
  let i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) {
    n += 1;
    i += needle.length;
  }
  return n;
}

/** 写前备份、写后回读校验；校验失败或抛错都还原原内容（至少不留半坏文件）。 */
function writeChecked(file, before, next, verify, existed) {
  const bak = existed ? `${file}.bak-${stamp()}` : null;
  const restore = () => {
    try {
      if (existed) writeFileSync(file, before, 'utf8');
      else unlinkSync(file);
    } catch { /* 还原失败只能放弃，错误消息里已说明 */ }
  };
  try {
    if (bak) copyFileSync(file, bak);
    writeFileSync(file, next, 'utf8');
    const after = readTextFile(file);
    if (!after.error && verify(after.text)) return { ok: true, bak };
    restore();
    return { ok: false, bak };
  } catch (e) {
    restore();
    return { ok: false, bak, error: e?.message ?? String(e) };
  }
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
export function previewFix(id, { cwd, profileDir, profiles } = {}) {
  const rule = FIX_RULES[id];
  if (!rule) return null;
  if (rule.kind === 'patch') {
    const lines = [`- id: ${rule.entry}`];
    if (rule.disabled !== undefined) lines.push(`  disabled: ${rule.disabled}`);
    lines.push('  config:');
    lines.push(...toYaml(rule.config, 2));
    return {
      kind: 'patch',
      target: profileDir ? join(profileDir, 'cordis.patch.yml') : join('$DSH_HOME', 'profiles', '<profile>', 'cordis.patch.yml'),
      text: lines.join('\n'),
      note: rule.note,
      profiles: profiles ?? [],
    };
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

/** 应用一个整改。返回 {changed, file, message}。 */
export function applyFix(id, { dshHome, cwd, profile } = {}) {
  const rule = FIX_RULES[id];
  if (!rule) return { changed: false, message: `没有可自动执行的整改：${id}` };

  if (rule.kind === 'patch') {
    const pick = resolveProfileDir(dshHome, profile);
    if (!pick.dir) {
      return pick.ambiguous
        ? { changed: false, ambiguous: true, profiles: pick.profiles, message: profileChoiceMessage(pick.profiles) }
        : { changed: false, profiles: pick.profiles, message: pick.error ?? '找不到装着本插件的 profile 目录' };
    }
    const file = join(pick.dir, 'cordis.patch.yml');
    const cur = readTextFile(file);
    if (cur.error) return { changed: false, file, message: `${file} ${cur.error}，为避免写坏已拒绝写入` };
    const before = cur.text ?? '';
    if (before.includes(MARK(id))) return { changed: false, file, message: '已经应用过了（要重写请先撤销）' };

    const lines = [`- id: ${rule.entry}`];
    if (rule.disabled !== undefined) lines.push(`  disabled: ${rule.disabled}`);
    lines.push('  config:');
    lines.push(...toYaml(rule.config, 2));
    const block = ['', `${MARK(id)} (${new Date().toISOString()})`, ...lines, MARK_END(id), ''].join('\n');

    const w = writeChecked(
      file,
      before,
      `${before.replace(/\s*$/, '')}\n${block}`,
      (t) => t.includes(MARK(id)) && countOf(t, MARK(id)) === 1,
      cur.exists,
    );
    if (!w.ok) return { changed: false, file, message: `写入后回读校验失败，已回滚${w.error ? `：${w.error}` : ''}` };
    return { changed: true, file, bak: w.bak, message: `已写入 ${file}，重启 DSH 后生效` };
  }

  // AGENTS.md
  if (!cwd) return { changed: false, message: '不知道项目目录，无法写 AGENTS.md' };
  const file = join(cwd, 'AGENTS.md');
  const cur = readTextFile(file);
  const body = buildAgentsSection(id, cwd);
  const section = ['', `<!-- dsh-cost-audit:${id} -->`, `## ${rule.title}（dsh-cost-audit 生成）`, '', body, `<!-- /dsh-cost-audit:${id} -->`, ''].join('\n');
  if (cur.error) {
    return { changed: false, file, message: `${file} ${cur.error}，为避免毁掉该文件已拒绝自动写入。可手动在文件末尾追加：\n\n${section}` };
  }
  const before = cur.text ?? '';
  if (before.includes(`dsh-cost-audit:${id}`)) return { changed: false, file, message: '已经应用过了' };

  const endMark = `<!-- /dsh-cost-audit:${id} -->`;
  const w = writeChecked(
    file,
    before,
    `${before.replace(/\s*$/, '')}\n${section}`,
    (t) => t.includes(endMark) && countOf(t, endMark) === 1,
    cur.exists,
  );
  if (!w.ok) return { changed: false, file, message: `写入后回读校验失败，已回滚${w.error ? `：${w.error}` : ''}` };
  return { changed: true, file, bak: w.bak, message: `已写入 ${file}` };
}

/** 撤销：按标记整块删除，不碰其它内容。 */
export function revertFix(id, { dshHome, cwd, profile } = {}) {
  const rule = FIX_RULES[id];
  if (!rule) return { changed: false, message: `没有可撤销的整改：${id}` };

  let file = null;
  if (rule.kind === 'patch') {
    const pick = resolveProfileDir(dshHome, profile);
    if (pick.ambiguous) return { changed: false, ambiguous: true, profiles: pick.profiles, message: profileChoiceMessage(pick.profiles) };
    if (!pick.dir) return { changed: false, profiles: pick.profiles, message: pick.error ?? '定位不到目标文件' };
    file = join(pick.dir, 'cordis.patch.yml');
  } else {
    if (!cwd) return { changed: false, message: '不知道项目目录，无法定位 AGENTS.md' };
    file = join(cwd, 'AGENTS.md');
  }

  const cur = readTextFile(file);
  if (!cur.exists) return { changed: false, message: '目标文件不存在' };
  if (cur.error) return { changed: false, file, message: `${file} ${cur.error}，为避免写坏已拒绝自动撤销，请手工删除标记段` };

  // patch 用注释标记，AGENTS.md 用 HTML 注释
  const pairs = rule.kind === 'patch'
    ? [[MARK(id), MARK_END(id)]]
    : [[`<!-- dsh-cost-audit:${id} -->`, `<!-- /dsh-cost-audit:${id} -->`]];
  const [start, end] = pairs[0];
  const text = cur.text;
  const i = text.indexOf(start);
  const j = text.indexOf(end);
  if (i < 0 || j < 0) return { changed: false, message: '没有找到已应用的记录' };

  const next = `${text.slice(0, i)}${text.slice(j + end.length)}`.replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n');
  const w = writeChecked(file, text, next, (t) => !t.includes(start), true);
  if (!w.ok) return { changed: false, file, message: `撤销后回读校验失败，已回滚${w.error ? `：${w.error}` : ''}` };
  return { changed: true, file, bak: w.bak, message: '已撤销，重启 DSH 后生效' };
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
