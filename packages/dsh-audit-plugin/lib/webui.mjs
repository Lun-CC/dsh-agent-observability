/**
 * Web UI 部分：一个自包含的报告页 + 一段注入到宿主 index.html 的入口脚本。
 *
 * 扩展点来自实测（对照本机已安装的 dsh-whale-widget）：
 *   - `ctx.webServer.register({ kind:'exact', path, handler(req,res) })` 挂路由，Node 原生 req/res
 *   - `ctx.webServer.tapIndex(html => html)` 变换 SPA 的 index.html（浏览器形态）
 *   - `ctx.on('webserver/index-inject', table => …)` 推结构化注入行（桌面壳形态；
 *     桌面端 index.html 从安装包静态直出，tapIndex 不生效）
 *
 * 设计取舍：不做"往会话界面里塞面板"，而是
 *   **一个独立页面 + 一个入口按钮**。
 * 理由：面板要依赖应用内部 DOM/CSS 结构，破坏面大；独立页面只用浏览器原生能力，
 * 插件被关掉最多是按钮 404，页面本身不会影响宿主。
 */

/**
 * 入口按钮的脚本主体（不含 <script> 标签）。
 *
 * 两种注入形态共用同一段：
 *   - 浏览器形态：包成 <script>…</script> 交给 tapIndex
 *   - 桌面壳形态：作为 `webserver/index-inject` 的 `kind: 'script'` 行正文
 *     （桌面壳会 createElement + textContent 执行，不会因加载失败而中断启动）
 *
 * 全程 try/catch：按钮加不上也不能影响宿主界面。
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
:root{--bg:#f6f8fb;--panel:#fff;--ink:#0f172a;--muted:#5b6b82;--line:#dfe6ef;--accent:#0284c7;--warn:#b45309;--ok:#15803d}
@media (prefers-color-scheme:dark){:root{--bg:#0b1220;--panel:#111a2b;--ink:#e6edf7;--muted:#93a4bd;--line:#243044;--accent:#38bdf8;--warn:#fbbf24;--ok:#34d399}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
header{padding:18px 24px;border-bottom:1px solid var(--line);display:flex;align-items:baseline;gap:14px;flex-wrap:wrap}
h1{font-size:16px;margin:0;font-weight:650}
.meta{color:var(--muted);font-size:12px}
main{display:grid;grid-template-columns:300px 1fr;gap:0;min-height:calc(100vh - 62px)}
@media (max-width:860px){main{grid-template-columns:1fr}}
nav{border-right:1px solid var(--line);overflow:auto;max-height:calc(100vh - 62px)}
@media (max-width:860px){nav{border-right:none;border-bottom:1px solid var(--line);max-height:44vh}}
.item{padding:10px 16px;border-bottom:1px solid var(--line);cursor:pointer}
.item:hover{background:rgba(127,127,127,.07)}
.item[aria-current="true"]{background:rgba(56,189,248,.12);box-shadow:inset 3px 0 0 var(--accent)}
.item .id{font:600 12px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}
.item .sub{color:var(--muted);font-size:11px;margin-top:2px}
section{padding:20px 24px;overflow:auto;max-height:calc(100vh - 62px)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:16px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.card .k{color:var(--muted);font-size:11px}
.card .v{font:650 18px/1.3 ui-monospace,SFMono-Regular,Consolas,monospace}
.headline{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:8px;padding:12px 14px;margin-bottom:16px}
pre{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px;overflow:auto;font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre}
.empty{color:var(--muted);padding:40px 0;text-align:center}
button{font:inherit;padding:5px 12px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--ink);cursor:pointer}
button:hover{border-color:var(--accent)}
.err{color:var(--warn)}
</style></head>
<body>
<header>
  <h1>会话成本报告</h1>
  <span class="meta" id="meta">加载中…</span>
  <button id="refresh" style="margin-left:auto">刷新</button>
</header>
<main>
  <nav id="list"><div class="empty">加载中…</div></nav>
  <section id="view"><div class="empty">选择左侧任意会话查看报告</div></section>
</main>
<script>
const $ = (s) => document.querySelector(s);
const fmt = (n) => (n == null ? '—' : Math.round(n).toLocaleString('en-US'));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let current = null;
let totalReports = 0;

async function j(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
  return r.json();
}

function renderList(data) {
  const nav = $('#list');
  const items = data.reports || [];
  totalReports = items.length;
  if (!items.length) { nav.innerHTML = '<div class="empty">还没有报告。<br>发生一次会话后自动生成。</div>'; return; }
  nav.innerHTML = items.map((r) => \`
    <div class="item" data-id="\${esc(r.id)}" aria-current="\${r.id === current}">
      <div class="id">\${esc(r.id.replace(/^session-/, '').slice(0, 18))}\${r.top ? ' · 主会话' : ''}</div>
      <div class="sub">\${esc((r.generatedAt || '').replace('T', ' ').slice(0, 19))} · \${fmt(r.totals && r.totals.totalReal)} tok</div>
      <div class="sub">\${esc((r.headline || '').slice(0, 34))}\${(r.headline || '').length > 34 ? '…' : ''}</div>
    </div>\`).join('');
  for (const el of nav.querySelectorAll('.item')) {
    el.onclick = () => { current = el.dataset.id; load(current); renderList(data); };
  }
}

function renderReport(d) {
  const s = d.summary || {};
  const t = s.totals || {};
  $('#meta').textContent = '生成于 ' + (s.generatedAt || '?') + (totalReports ? ' · 共 ' + totalReports + ' 份报告' : '');
  $('#view').innerHTML = \`
    <div class="cards">
      <div class="card"><div class="k">实测 token</div><div class="v">\${fmt(t.totalReal)}</div></div>
      <div class="card"><div class="k">请求</div><div class="v">\${fmt(t.requests)}</div></div>
      <div class="card"><div class="k">工具调用</div><div class="v">\${fmt(t.toolCalls)}</div></div>
      <div class="card"><div class="k">失败</div><div class="v">\${fmt(t.failedCalls)}</div></div>
      <div class="card"><div class="k">无产出步</div><div class="v">\${fmt(t.barrenSteps)}</div></div>
      <div class="card"><div class="k">缓存命中</div><div class="v">\${t.hitRate == null ? '—' : Math.round(t.hitRate * 100) + '%'}</div></div>
    </div>
    \${s.headline ? '<div class="headline">' + esc(s.headline) + '</div>' : ''}
    <pre>\${esc(d.text || '(无正文)')}</pre>\`;
}

async function load(id) {
  try {
    renderReport(await j('/dsh-cost-audit/api/report?id=' + encodeURIComponent(id)));
  } catch (e) {
    $('#view').innerHTML = '<div class="empty err">读取失败：' + esc(e.message) + '</div>';
  }
}

async function boot() {
  try {
    const data = await j('/dsh-cost-audit/api/list');
    renderList(data);
    // 默认选中：优先"有实际请求的"报告 —— 空会话也值得记录，但不该占住首屏
    const reports = data.reports || [];
    const byId = (id) => reports.find((r) => r.id === id);
    const withWork = (r) => r && (r.totals?.requests || 0) > 0;
    const preferred = [byId(data.latest), ...reports].find(withWork) || byId(data.latest) || reports[0];
    const first = current || (preferred && preferred.id);
    if (first) { current = first; await load(first); }
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
