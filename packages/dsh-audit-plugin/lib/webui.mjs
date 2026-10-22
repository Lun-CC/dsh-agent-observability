/**
 * Web UI：一个自包含的报告页 + 一段注入到宿主 index.html 的入口脚本。
 *
 * 扩展点来自实测（对照本机已安装的 dsh-whale-widget）：
 *   - `ctx.webServer.register({ kind:'exact', path, handler(req,res) })` 挂路由，Node 原生 req/res
 *   - `ctx.webServer.tapIndex(html => html)` 变换 SPA 的 index.html（浏览器形态）
 *   - `ctx.on('webserver/index-inject', table => …)` 推结构化注入行（桌面壳形态；
 *     桌面端 index.html 从安装包静态直出，tapIndex 不生效）
 *
 * 设计原则（0.9.0 按用户反馈调整）：
 *   1. **首屏只有三样东西**：几个数字、一句结论、几条建议。正文折叠进 <details>。
 *      详细内容留在文件里，页面不承担"读完整报告"的职责。
 *   2. **一次对话 = 一条记录**。subagent 会话归到主会话下，不单独列，只作为成本明细。
 *   3. **建议说人话**：标签（4–6 字）+ 一句动作 + 可省多少，不铺证据。
 */

/**
 * 入口按钮的脚本主体（不含 <script> 标签）。
 *
 * 两种注入形态共用同一段：
 *   - 浏览器形态：包成 <script>…</script> 交给 tapIndex
 *   - 桌面壳形态：作为 `webserver/index-inject` 的 `kind: 'script'` 行正文
 *     （桌面壳会 createElement + textContent 执行，不会因加载失败而中断启动）
 */
export const ENTRY_JS = `(function(){
  try{
    if (document.getElementById('dca-entry')) return;
    var css = document.createElement('style');
    css.textContent = '#dca-entry{position:fixed;right:18px;bottom:18px;z-index:2147483000;display:flex;align-items:center;gap:6px;padding:8px 12px;border-radius:999px;border:1px solid rgba(120,140,180,.35);background:#111a2b;color:#e6edf7;font:500 12px/1 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.28);cursor:pointer;text-decoration:none;opacity:.92}#dca-entry:hover{opacity:1;border-color:#38bdf8}#dca-entry b{color:#38bdf8;font-weight:700}';
    document.head.appendChild(css);
    var a = document.createElement('a');
    a.id = 'dca-entry';
    a.href = '/dsh-cost-audit/';
    a.target = '_blank';
    a.rel = 'noopener';
    a.innerHTML = '<b>¥</b><span>成本报告</span>';
    document.body.appendChild(a);
  }catch(e){}
})();`;

export const ENTRY_SNIPPET = `<script>${ENTRY_JS}</script>`;

/** 把一段 HTML 注入到 index.html 的 </body> 前。 */
export function injectEntry(html) {
  if (typeof html !== 'string') return html;
  // 用 'dca-entry' 作为幂等标记：脚本里同时有 getElementById('dca-entry') 与 a.id='dca-entry'，
  // 不能用 id="dca-entry" 这种 HTML 属性写法去判（脚本里没有这种形态）。
  if (html.includes('dca-entry')) return html;
  return html.includes('</body>') ? html.replace('</body>', `${ENTRY_SNIPPET}</body>`) : html + ENTRY_SNIPPET;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** 报告页。自包含、无外部资源、跟随系统深浅色。 */
export function renderPage() {
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>会话成本报告 · dsh-cost-audit</title>
<style>
:root{--bg:#f6f8fb;--panel:#fff;--ink:#0f172a;--muted:#5b6b82;--line:#e2e8f0;--accent:#0284c7;
--high:#dc2626;--medium:#d97706;--low:#64748b;--ok:#15803d}
@media (prefers-color-scheme:dark){:root{--bg:#0b1220;--panel:#111a2b;--ink:#e6edf7;--muted:#93a4bd;--line:#233047;--accent:#38bdf8;
--high:#f87171;--medium:#fbbf24;--low:#94a3b8;--ok:#34d399}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
header{padding:14px 22px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:12px;flex-wrap:wrap}
h1{font-size:15px;margin:0;font-weight:650}
.muted{color:var(--muted);font-size:12px}
header .spacer{margin-left:auto}
main{display:grid;grid-template-columns:270px 1fr;min-height:calc(100vh - 56px)}
@media (max-width:860px){main{grid-template-columns:1fr}}
nav{border-right:1px solid var(--line);overflow:auto;max-height:calc(100vh - 56px)}
@media (max-width:860px){nav{border-right:none;border-bottom:1px solid var(--line);max-height:38vh}}
.item{padding:10px 16px;border-bottom:1px solid var(--line);cursor:pointer;border-left:3px solid transparent}
.item:hover{background:rgba(127,127,127,.06)}
.item[aria-current="true"]{background:rgba(56,189,248,.1);border-left-color:var(--accent)}
.item .id{font:600 12px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}
.item .sub{color:var(--muted);font-size:11px;margin-top:3px}
section{padding:18px 22px;overflow:auto;max-height:calc(100vh - 56px)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(108px,1fr));gap:9px;margin-bottom:14px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:9px 11px}
.card .k{color:var(--muted);font-size:11px}
.card .v{font:650 17px/1.25 ui-monospace,SFMono-Regular,Consolas,monospace;margin-top:2px}
.verdict{color:var(--muted);font-size:12.5px;margin:0 0 16px;line-height:1.5}
h2{font-size:11.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);margin:0 0 8px;font-weight:600}
.fix{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--low);border-radius:9px;padding:11px 13px;margin-bottom:9px}
.fix.high{border-left-color:var(--high)}
.fix.medium{border-left-color:var(--medium)}
.fix .top{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.fix .label{font-weight:650}
.fix .save{margin-left:auto;font:600 12px/1 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--ok);white-space:nowrap}
.fix .act{margin-top:5px;font-size:13px}
.fix .how{margin-top:4px;font-size:12px;color:var(--muted)}
.fix .foot{margin-top:8px;display:flex;align-items:center;gap:8px}
.fix .btn{font:500 12px/1 inherit;padding:5px 10px;border-radius:7px;border:1px solid var(--line);background:transparent;color:var(--ink);cursor:pointer}
.fix .btn:hover{border-color:var(--accent);color:var(--accent)}
.fix .btn.done{border-color:var(--ok);color:var(--ok)}
.fix .hint{font-size:11.5px;color:var(--muted)}
details{margin-top:12px;border:1px solid var(--line);border-radius:9px;background:var(--panel)}
summary{cursor:pointer;padding:9px 13px;font-size:12.5px;color:var(--muted);user-select:none}
summary:hover{color:var(--ink)}
pre{margin:0;padding:0 13px 13px;overflow:auto;font:11.5px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre;color:var(--ink)}
.sub-row{display:flex;justify-content:space-between;gap:10px;padding:6px 13px;font-size:12px;border-top:1px solid var(--line)}
.empty{color:var(--muted);padding:40px 0;text-align:center}
button{font:inherit;padding:5px 11px;border-radius:7px;border:1px solid var(--line);background:var(--panel);color:var(--ink);cursor:pointer}
button:hover{border-color:var(--accent)}
.err{color:var(--high)}
</style></head>
<body>
<header>
  <h1>会话成本报告</h1>
  <span class="muted" id="meta">加载中…</span>
  <button id="refresh" class="spacer">刷新</button>
</header>
<main>
  <nav id="list"><div class="empty">加载中…</div></nav>
  <section id="view"><div class="empty">选择左侧任意对话</div></section>
</main>
<script>
const $ = (s) => document.querySelector(s);
const fmt = (n) => (n == null ? '—' : Math.round(n).toLocaleString('en-US'));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const short = (id) => String(id || '').replace(/^session-/, '').slice(0, 8);
const when = (t) => String(t || '').replace('T', ' ').slice(5, 16);
// 注意：这段脚本是外层模板字符串的内容，写 \\n 会被外层先转义成真换行，
// 放进单引号字符串里就变成语法错误。统一用编码生成换行符。
const NL = String.fromCharCode(10, 10);
let convs = [], current = null;

async function j(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
  return r.json();
}

function renderNav() {
  const nav = $('#list');
  if (!convs.length) { nav.innerHTML = '<div class="empty">还没有报告。<br>发生一次对话后自动生成。</div>'; return; }
  nav.innerHTML = convs.map((c) => \`
    <div class="item" data-id="\${esc(c.primaryId)}" aria-current="\${c.primaryId === current}">
      <div class="id">\${esc(short(c.rootId))}</div>
      <div class="sub">\${esc(when(c.latestAt))} · \${fmt(c.totalReal)} tok</div>
      <div class="sub">\${c.subSessions > 0 ? c.subSessions + ' 个子会话' : '单会话'}\${c.checklist && c.checklist.length ? ' · ' + c.checklist.length + ' 条建议' : ''}</div>
    </div>\`).join('');
  for (const el of nav.querySelectorAll('.item')) {
    el.onclick = () => { current = el.dataset.id; renderNav(); load(current); };
  }
}

function shareText(p, total) {
  const lo = Array.isArray(p.saving) ? p.saving[0] : 0;
  const hi = Array.isArray(p.saving) ? p.saving[1] : 0;
  if (!(total > 0)) return '';
  const p1 = Math.round((lo / total) * 100);
  const p2 = Math.round((hi / total) * 100);
  return p2 < 1 ? '<1%' : (p1 === p2 ? p2 + '%' : p1 + '–' + p2 + '%');
}

function verdictLine(list, conv) {
  if (!((conv.requests || 0) > 0)) return '空会话，没有模型调用，不产出账单。';
  const top = list[0];
  if (!top) return '未发现结构性浪费，不需要改配置。';
  return (top.label || top.id) + ' 是最值得先改的一条，预计能省回 ' + shareText(top, conv.totalReal) + ' 的成本。';
}

function fixCards(list, total, cwd) {
  if (!list.length) return '<div class="verdict">这次对话没发现结构性浪费，不需要改配置。</div>';
  return '<h2>建议</h2>' + list.map((p) => {
    const lo = Array.isArray(p.saving) ? p.saving[0] : 0;
    const hi = Array.isArray(p.saving) ? p.saving[1] : 0;
    const share = shareText(p, total);
    return \`<div class="fix \${esc(p.severity || '')}">
      <div class="top">
        <span class="label">\${esc(p.label || p.id)}</span>
        \${p.confidence === 'low' ? '<span class="muted">低置信</span>' : ''}
        <span class="save">可省 \${fmt(lo)}–\${fmt(hi)}\${share ? '（' + share + '）' : ''}</span>
      </div>
      \${p.action ? '<div class="act">' + esc(p.action) + '</div>' : ''}
      \${p.howTo ? '<div class="how">怎么改：' + esc(p.howTo) + '</div>' : ''}
      \${p.fix ? '<div class="foot">' +
        '<button class="btn' + (p.fix.applied ? ' done' : '') + '" data-fix="' + esc(p.id) + '">' +
        (p.fix.applied ? '已应用 · 撤销' : '应用此修改：' + esc(p.fix.title)) + '</button>' +
        '<span class="hint">' + esc(p.fix.applied ? (p.fix.requiresRestart ? '重启 DSH 后生效' : '已写入') : p.fix.note) + '</span>' +
        '</div>' : ''}
    </div>\`;
  }).join('');
}

function render(conv, d) {
  const s = d.summary || {};
  const t = s.totals || {};
  // 兼容 0.8.x 的旧摘要（只有 conclusions，没有 prescriptions）
  const list = (s.prescriptions || s.conclusions || []).map((p) => ({ ...p, action: p.action || p.title || '' }));
  $('#meta').textContent = convs.length + ' 次对话 · 共 ' + fmt(convs.reduce((a, c) => a + (c.totalReal || 0), 0)) + ' token';

  const subs = d.siblings || [];
  const subTokens = subs.reduce((a, x) => a + ((x.totals && x.totals.totalReal) || 0), 0);

  $('#view').innerHTML = \`
    <div class="cards">
      <div class="card"><div class="k">本对话总消耗</div><div class="v">\${fmt(conv.totalReal)}</div></div>
      <div class="card"><div class="k">请求</div><div class="v">\${fmt(conv.requests)}</div></div>
      <div class="card"><div class="k">工具调用</div><div class="v">\${fmt(conv.toolCalls)}</div></div>
      <div class="card"><div class="k">失败</div><div class="v">\${fmt(conv.failedCalls)}</div></div>
      <div class="card"><div class="k">主会话缓存命中</div><div class="v">\${t.hitRate == null ? '—' : Math.round(t.hitRate * 100) + '%'}</div></div>
    </div>
    <p class="verdict">\${esc(verdictLine(list, conv))}</p>
    \${fixCards(list, conv.totalReal, (s.session && s.session.cwd) || '')}
    \${subs.length ? '<details><summary>子会话 ' + subs.length + ' 个 · 合计 ' + fmt(subTokens) + ' token</summary>' +
      subs.map((x) => '<div class="sub-row"><span>' + esc(short(x.id)) + '</span><span>' + fmt((x.totals || {}).totalReal) + ' tok · ' + fmt((x.totals || {}).requests) + ' 请求</span></div>').join('') +
      '</details>' : ''}
    <details><summary>完整报告（逐步账单、证据、口径）</summary><pre>\${esc(d.text || '(无正文)')}</pre></details>\`;
}

async function fixAction(p, action, cwd) {
  const r = await fetch('/dsh-cost-audit/api/fix', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-audit': '1' },
    body: JSON.stringify({ id: p.id, action, cwd }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || (r.status + ' ' + r.statusText));
  return j;
}

async function onFix(p, cwd) {
  try {
    if (p.fix && p.fix.applied) {
      if (!confirm('撤销「' + p.fix.title + '」？' + NL + '会删除插件写入的那一段，其它内容不动。')) return;
      const r = await fixAction(p, 'revert', cwd);
      alert(r.message || (r.ok ? '已撤销' : '未变更'));
    } else {
      const pv = await fixAction(p, 'preview', cwd);
      const text = pv.preview ? (pv.preview.target + NL + pv.preview.text) : '(无预览)';
      if (!confirm('将写入：' + NL + text + NL + '确认？')) return;
      const r = await fixAction(p, 'apply', cwd);
      alert(r.message || (r.ok ? '已应用' : '未变更'));
    }
    await boot();
  } catch (e) {
    alert('失败：' + e.message);
  }
}

async function load(id) {
  try {
    const conv = convs.find((c) => c.primaryId === id) || { totalReal: 0, requests: 0, toolCalls: 0, failedCalls: 0 };
    const d = await j('/dsh-cost-audit/api/report?id=' + encodeURIComponent(id));
    render(conv, d);
    const cwd = (d.summary && d.summary.session && d.summary.session.cwd) || '';
    for (const el of document.querySelectorAll('[data-fix]')) {
      const p = ((d.summary && d.summary.prescriptions) || []).find((x) => x.id === el.dataset.fix);
      if (p) el.onclick = () => onFix(p, cwd);
    }
  } catch (e) {
    $('#view').innerHTML = '<div class="empty err">读取失败：' + esc(e.message) + '</div>';
  }
}

async function boot() {
  try {
    const data = await j('/dsh-cost-audit/api/list');
    convs = data.conversations || [];
    renderNav();
    // 默认选"有实际请求"的对话：空会话值得记录，但不该占住首屏
    const preferred = convs.find((c) => (c.requests || 0) > 0) || convs[0];
    if (preferred) { current = preferred.primaryId; renderNav(); await load(current); }
    else $('#meta').textContent = '暂无报告';
  } catch (e) {
    $('#list').innerHTML = '<div class="empty err">接口不可用：' + esc(e.message) + '</div>';
    $('#meta').textContent = '';
  }
}
$('#refresh').onclick = () => boot();
boot();
</script>
</body></html>`;
}

export { esc };
