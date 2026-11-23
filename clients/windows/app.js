// Yumeiro 客户端自己的主界面：对话、IDE 工作区和模型选择都在这里（不是网页）。
// 所有服务器请求都经主进程代理；工作区编译器、编译器模型和普通对话模型分别管理。
(() => {
  const $ = id => document.getElementById(id);
  const app = window.yumeiroApp;
  const toast = (text, ms = 3200) => { const t = $('toast'); t.textContent = text; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ms); };

  const h = (tag, cls, ...kids) => { const e = document.createElement(tag); if (cls) e.className = cls; for (const k of kids) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k))); return e; };
  let lastX = 300, lastY = 60; document.addEventListener('pointerdown', e => { lastX = e.clientX; lastY = e.clientY; }, true);
  const pop = $('popMenu');
  function popMenu(x, y, items) {
    pop.replaceChildren();
    for (const it of items) { if (it === '-') { pop.append(document.createElement('hr')); continue; } const b = h('button', it.danger ? 'danger' : '', it.label); b.type = 'button'; b.onclick = () => { pop.hidden = true; it.run(); }; pop.append(b); }
    pop.hidden = false; const r = pop.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px'; pop.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
  }
  document.addEventListener('pointerdown', e => { if (!pop.hidden && !pop.contains(e.target)) pop.hidden = true; }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') pop.hidden = true; });
  // 弹窗：标题 + 内容 + 确定 / 取消（用于重命名、智能体编辑）
  function dialog(title, body, okText = '确定') {
    return new Promise(resolve => {
      const mask = h('div', 'dlg-mask'), box = h('div', 'dlg'), head = h('h3', '', title), foot = h('div', 'dlg-foot');
      const close = v => { mask.remove(); resolve(v); };
      const ok = h('button', 'primary-btn', okText), cancel = h('button', 'ghost-btn', '取消'); ok.type = cancel.type = 'button';
      ok.onclick = () => close(true); cancel.onclick = () => close(false); mask.addEventListener('pointerdown', e => { if (e.target === mask) close(false); });
      foot.append(cancel, ok); box.append(head, body, foot); mask.append(box); document.body.append(mask);
      const first = body.querySelector('input,textarea,select'); if (first) first.focus();
    });
  }
  async function askText(title, initial = '') { const input = h('input', 'fld'); input.value = initial; const ok = await dialog(title, input); return ok ? input.value.trim() : null; }
  const setTitle = (text, more) => { try { app.setTitle(text, more); } catch { /* 标题栏还没准备好 */ } };

  // 让桌宠（pet.js）等沿用网页写法的脚本也能请求 /api/…：相对路径的 /api/ 请求改走主进程代理
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!url.startsWith('/api/')) return realFetch(input, init);
    let body; try { body = init.body ? JSON.parse(init.body) : undefined; } catch { body = undefined; }
    const r = await app.api((init.method || 'GET').toUpperCase(), url, body);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.data, text: async () => JSON.stringify(r.data) };
  };
  const api = async (method, path, body) => {
    const r = await app.api(method, path, body);
    if (r.status === 401) { app.changeServer(); throw new Error('登录已过期，请重新登录'); }
    if (r.status === 0) throw new Error(r.error || '连不上服务器');
    if (r.status < 200 || r.status >= 300) throw new Error((r.data && r.data.error) || '请求失败（HTTP ' + r.status + '）');
    return r.data;
  };

  // ── Markdown（够用的子集；先转义再加标签，不会注入 HTML）──
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  function inline(text) {
    let s = esc(text);
    s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<i>$2</i>');
    s = s.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer noopener">$2</a>');
    return s;
  }
  function md(src) {
    const lines = String(src).replace(/\r\n/g, '\n').split('\n'), out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i], fence = /^```\s*([\w+-]*)\s*$/.exec(line);
      if (fence) {
        const code = []; i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i++]);
        i++; out.push('<pre><button class="cp" type="button">复制</button><code>' + esc(code.join('\n')) + '</code></pre>'); continue;
      }
      const h = /^(#{1,3})\s+(.*)$/.exec(line);
      if (h) { out.push('<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>'); i++; continue; }
      if (/^>\s?/.test(line)) { const q = []; while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, '')); out.push('<blockquote>' + inline(q.join('\n')).replace(/\n/g, '<br>') + '</blockquote>'); continue; }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        const ordered = /^\s*\d+[.)]\s+/.test(line), items = [];
        while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) items.push('<li>' + inline(lines[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, '')) + '</li>');
        out.push((ordered ? '<ol>' : '<ul>') + items.join('') + (ordered ? '</ol>' : '</ul>')); continue;
      }
      if (/^\s*\|.+\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
        const row = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => inline(c.trim()));
        const head = row(line); i += 2; const body = [];
        while (i < lines.length && /^\s*\|.+\|\s*$/.test(lines[i])) body.push(row(lines[i++]));
        out.push('<table><thead><tr>' + head.map(c => '<th>' + c + '</th>').join('') + '</tr></thead><tbody>' + body.map(r => '<tr>' + r.map(c => '<td>' + c + '</td>').join('') + '</tr>').join('') + '</tbody></table>'); continue;
      }
      if (!line.trim()) { i++; continue; }
      const para = []; while (i < lines.length && lines[i].trim() && !/^(```|#{1,3}\s|>|\s*([-*+]|\d+[.)])\s+)/.test(lines[i])) para.push(lines[i++]);
      out.push('<p>' + inline(para.join('\n')).replace(/\n/g, '<br>') + '</p>');
    }
    return out.join('');
  }

  // ── 状态 ──
  let convs = [], current = null, messages = [], models = [], agents = [], engines = [], workspaces = [], defaultModel = '', busy = false, streamId = 0, me = null, view = 'chat';
  let serviceUpdate = null, serviceUpdateChecked = false;
  let chatTarget = { kind: 'model', ref: '' };
  let activeWorkspaceId = '', activeFilePath = '', workspaceTree = [], workspaceFile = null;
  let workspaceEngine = '', workspaceModel = '', workspaceMode = 'readonly', workspaceRun = { status: 'idle', events: [], text: '' };
  const messagesEl = $('messages'), scrollEl = $('scroll'), promptEl = $('prompt'), sendBtn = $('send');
  const atBottom = () => scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 80;
  const toBottom = () => { scrollEl.scrollTop = scrollEl.scrollHeight; };
  const ago = t => { const m = (Date.now() - t) / 60000; return m < 1 ? '刚刚' : m < 60 ? Math.round(m) + ' 分钟前' : m < 1440 ? Math.round(m / 60) + ' 小时前' : Math.round(m / 1440) + ' 天前'; };

  function addMessage(role, content, opts = {}) {
    const div = document.createElement('div'); div.className = 'message ' + role;
    const av = document.createElement('div'); av.className = 'mavatar'; av.textContent = role === 'user' ? ((me && me.email || 'U')[0] || 'U').toUpperCase() : 'Y';
    const bubble = document.createElement('div'); bubble.className = 'bubble' + (opts.error ? ' error' : '');
    if (role === 'user') bubble.textContent = content; else bubble.innerHTML = md(content);
    if (opts.atts && opts.atts.length) bubble.append(attsBox(opts.atts));
    div.append(av, bubble); messagesEl.append(div); $('hello').hidden = true;
    return bubble;
  }
  // 消息气泡里的附件：图片显示缩略图（历史消息从服务器取），文件显示文件标签
  function attsBox(list) {
    const box = document.createElement('div'); box.className = 'msg-atts';
    for (const item of list) {
      if (item.doc) { const tag = document.createElement('button'); tag.type = 'button'; tag.className = 'tag'; const ext = document.createElement('span'); ext.className = 'att-ext'; ext.textContent = (attExt(item.name) || 'file').slice(0, 5).toUpperCase(); const name = document.createElement('span'); name.className = 'att-name'; name.textContent = item.name || '文件'; tag.title = '点开查看提取出的文字：' + (item.name || ''); tag.onclick = () => viewDoc(item); tag.append(ext, name); box.append(tag); continue; }
      const img = document.createElement('img'); img.alt = item.name || '图片'; img.title = '点击放大'; img.onclick = () => { if (img.src) lightbox(img.src); };
      if (item.src) img.src = item.src; else if (item.id) app.file('/api/attachments/' + encodeURIComponent(item.id)).then(url => { if (url) img.src = url; else img.remove(); }).catch(() => img.remove());
      box.append(img);
    }
    return box;
  }
  // 客户端内查看附件：图片放大；文件弹窗显示服务器提取出的文字（可复制），Esc 或点空白关闭
  function overlayView(...kids) {
    const layer = h('div', 'att-modal'); layer.setAttribute('role', 'dialog'); layer.append(...kids);
    const close = () => { layer.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    layer.addEventListener('click', e => { if (e.target === layer) close(); });
    document.addEventListener('keydown', onKey, true); document.body.append(layer);
    return close;
  }
  function lightbox(src) { const img = h('img', 'att-big'); img.src = src; let close = overlayView(img); img.onclick = () => close(); }
  async function viewDoc(item) {
    if (!item.id) { toast('这个文件还没有上传完成'); return; }
    const pre = h('pre', 'att-pre', '正在读取…'); let text = '';
    const copy = h('button', 'ghost-btn', '复制'); copy.onclick = () => { if (text) navigator.clipboard.writeText(text).then(() => toast('已复制'), () => toast('复制失败')); };
    const x = h('button', 'ghost-btn', '关闭');
    const close = overlayView(h('div', 'att-box', h('div', 'att-head', h('b', null, item.name || '文件'), h('span', 'att-actions', copy, x)), pre));
    x.onclick = () => close();
    const r = await app.text('/api/attachments/' + encodeURIComponent(item.id));
    if (r && r.status === 200) { text = r.text || ''; pre.textContent = text || '（文件是空的）'; }
    else pre.textContent = '读取失败：' + ((r && r.error) || '未知原因');
  }
  const msgAtts = m => [...(m.images || []).map(i => ({ id: i.id, name: i.name })), ...(m.files || []).map(f => ({ doc: true, id: f.id, name: f.name }))];
  messagesEl.addEventListener('click', e => {
    const cp = e.target.closest && e.target.closest('.cp');
    if (cp) { const code = cp.parentElement.querySelector('code'); navigator.clipboard.writeText(code ? code.textContent : '').then(() => { cp.textContent = '已复制'; setTimeout(() => { cp.textContent = '复制'; }, 1200); }).catch(() => {}); }
    const a = e.target.closest && e.target.closest('a[href]');
    if (a) { e.preventDefault(); app.openExternal(a.href); }
  });
  function renderMessages() {
    messagesEl.replaceChildren(); $('hello').hidden = messages.length > 0;
    for (const m of messages) addMessage(m.role === 'user' ? 'user' : 'assistant', m.content || '', { atts: m.role === 'user' ? msgAtts(m) : [] });
    toBottom();
  }
  function renderConvs() {
    const box = $('convs'), q = $('convFilter').value.trim().toLowerCase();
    box.replaceChildren();
    const list = convs.filter(c => !q || String(c.title).toLowerCase().includes(q));
    if (!list.length) { box.append(h('div', 'empty', convs.length ? '没有匹配的对话' : '新对话会显示在这里')); return; }
    const today = new Date(); today.setHours(0, 0, 0, 0); const d0 = today.getTime();
    const bucket = c => c.updatedAt >= d0 ? '今天' : c.updatedAt >= d0 - 864e5 ? '昨天' : c.updatedAt >= d0 - 6 * 864e5 ? '最近 7 天' : '更早';
    let last = '';
    for (const c of list) {
      const g = bucket(c); if (g !== last) { box.append(h('div', 'cgroup', g)); last = g; }
      const row = h('div', 'conv' + (c.id === current ? ' on' : '')); row.title = c.title || '新对话';
      const r1 = h('div', 'row1', h('span', 't', c.title || '新对话'), h('span', 'tm', ago(c.updatedAt)));
      const d = h('button', 'd', '删除'); d.type = 'button';
      d.addEventListener('click', e => { e.stopPropagation(); removeConv(c.id); });
      row.addEventListener('click', () => openConv(c.id)); row.append(r1, d); box.append(row);
    }
  }
  async function removeConv(id) { if (!await ymConfirm('删除这段对话？', { danger: true })) return; try { await api('DELETE', '/api/conversations/' + id); if (current === id) newChat(); await loadConvs(); } catch (x) { toast(x.message); } }
  async function renameConv() { if (!current) return; const name = await askText('重命名对话', $('ctitle').textContent); if (!name) return; try { await api('PATCH', '/api/conversations/' + current, { title: name }); $('ctitle').textContent = name; const c = convs.find(x => x.id === current); if (c) c.title = name; renderConvs(); } catch (x) { toast(x.message); } }
  function copyConv() { const text = messages.map(m => (m.role === 'user' ? '## 我\n' : '## Yumeiro\n') + (m.content || '')).join('\n\n'); navigator.clipboard.writeText(text).then(() => toast('已复制整段对话'), () => toast('复制失败')); }
  async function loadConvs() { const d = await api('GET', '/api/conversations'); convs = d.conversations || []; renderConvs(); }
  async function openConv(id) {
    show('chat');
    try { const d = await api('GET', '/api/conversations/' + id); current = id; messages = d.messages || []; $('ctitle').textContent = d.conversation.title || '新对话'; if (d.conversation.model) selectModel(d.conversation.model, true); renderMessages(); renderConvs(); promptEl.focus(); pushHist(); }
    catch (x) { toast(x.message); }
  }
  function newChat() { if (busy) return; show('chat'); current = null; messages = []; $('ctitle').textContent = '新对话'; messagesEl.replaceChildren(); $('hello').hidden = false; renderConvs(); promptEl.focus(); pushHist(); }

  // ── 对话模型 / 智能体；工作区编译器和编译器模型在 IDE 面板中独立管理 ──
  function emitModel() {
    const sel = $('modelSelect'), opt = sel.selectedOptions[0];
    window.yumeiroModel = chatTarget.ref || sel.value;
    window.dispatchEvent(new CustomEvent('yumeiro:model-change', { detail: { name: opt ? opt.textContent : '', ref: chatTarget.ref || sel.value, engine: '' } }));
  }
  // 模型与运行引擎（pi / codex / claude-code）分开选：label 形如“Cindy AI · DeepSeek V4 Pro · pi”
  const ENGINE_RE = /\s*[·•]\s*(pi|codex|claude-code)\s*$/i;
  const splitModel = m => { const label = m.label || m.model || m.ref, hit = ENGINE_RE.exec(label); return { base: hit ? label.replace(ENGINE_RE, '') : label, engine: m.engine || (hit ? hit[1].toLowerCase() : '') || 'default' }; };
  const ENGINE_NAME = { pi: 'Pi', codex: 'Codex', 'claude-code': 'Claude Code', default: '默认' };
  // 运行方式：「直接对话」走模型网关；选 Claude Code / Codex / Pi 则在所选项目里由该引擎干活（服务器下发每个模型支持的引擎）
  let chatEngine = '';
  const ENGINE_LABEL = { claude: 'Claude Code', codex: 'Codex', pi: 'Pi' };
  const groupOf = () => models.map(m => ({ m, ...splitModel(m) })).filter(x => x.base === $('modelSelect').value);
  function fillRunners(base, wantRef) {
    const rs = $('runnerSelect'); rs.replaceChildren();
    const list = models.map(m => ({ m, ...splitModel(m) })).filter(x => x.base === base);
    const add = (value, text) => { const o = document.createElement('option'); o.value = value; o.textContent = text; rs.append(o); };
    for (const x of list) add(x.m.ref, list.length < 2 && x.engine === 'default' ? '直接对话' : (ENGINE_NAME[x.engine] || x.engine));
    for (const e of engines) if (list.some(x => (x.m.engines || []).includes(e.engine))) add('engine:' + e.engine, '⌘ ' + (ENGINE_LABEL[e.engine] || e.label));
    const wantEngine = chatEngine && [...rs.options].some(o => o.value === 'engine:' + chatEngine) ? 'engine:' + chatEngine : '';
    rs.value = wantEngine || (wantRef && list.some(x => x.m.ref === wantRef) ? wantRef : (list[0] ? list[0].m.ref : ''));
    rs.parentElement.hidden = rs.options.length < 2;
    applyRunner(list);
  }
  function applyRunner(list) {
    const v = $('runnerSelect').value;
    if (v.startsWith('engine:')) {
      chatEngine = v.slice(7);
      const pick = (list || groupOf()).find(x => (x.m.engines || []).includes(chatEngine));
      if (pick) chatTarget.ref = pick.m.ref;
    } else { chatEngine = ''; chatTarget.ref = v; }
    updateEngineBar();
  }
  function updateEngineBar() {
    const on = chatTarget.kind === 'model' && Boolean(chatEngine);
    $('wsPill').hidden = !on; $('modePill').hidden = !on;
    if (!on) return;
    const ws = $('wsSelect'), keep = ws.value || activeWorkspaceId; ws.replaceChildren();
    for (const w of workspaces) { const o = document.createElement('option'); o.value = w.id; o.textContent = '项目：' + w.name; ws.append(o); }
    const n = document.createElement('option'); n.value = '__new'; n.textContent = '＋ 新建项目…'; ws.append(n);
    ws.value = [...ws.options].some(o => o.value === keep) ? keep : (workspaces[0] ? workspaces[0].id : '__new');
    const info = engines.find(e => e.engine === chatEngine), ms = $('modeSelect');
    ms.querySelector('option[value=edit]').hidden = !(info && info.maxMode === 'edit');
    if (ms.value === 'edit' && ms.querySelector('option[value=edit]').hidden) ms.value = 'readonly';
  }
  function selectModel(ref, silent) {
    const sel = $('modelSelect');
    if (chatTarget.kind === 'model') {
      const m = models.find(x => x.ref === ref); if (!m) return;
      sel.value = splitModel(m).base; fillRunners(sel.value, ref);
      if (!silent) emitModel(); else window.yumeiroModel = ref; return;
    }
    if ([...sel.options].some(o => o.value === ref)) { sel.value = ref; chatTarget.ref = ref; if (!silent) emitModel(); else window.yumeiroModel = ref; }
  }
  function fillChatSelect(items, empty = '暂无可用项') {
    const sel = $('modelSelect'); sel.replaceChildren();
    if (!items.length) { const o = document.createElement('option'); o.value = ''; o.textContent = empty; sel.append(o); return; }
    for (const item of items) { const o = document.createElement('option'); o.value = item.value; o.textContent = item.label; sel.append(o); }
    sel.value = chatTarget.ref && items.some(i => i.value === chatTarget.ref) ? chatTarget.ref : items[0].value; if (chatTarget.kind !== 'model') chatTarget.ref = sel.value;
  }
  function rebuildTargetOptions() {
    const kind = $('targetKind').value, wantRef = chatTarget.ref;
    chatTarget = { kind, ref: '' };
    $('runnerSelect').parentElement.hidden = kind !== 'model';
    if (kind === 'model') {
      const want = models.find(m => m.ref === wantRef) || models.find(m => m.ref === defaultModel) || models[0];
      const bases = [...new Set(models.map(m => splitModel(m).base))];
      fillChatSelect(bases.map(b => ({ value: b, label: b })), '服务器还没配置模型');
      if (want) { $('modelSelect').value = splitModel(want).base; fillRunners($('modelSelect').value, want.ref); } else $('runnerSelect').parentElement.hidden = true;
    } else fillChatSelect(agents.map(a => ({ value: a.id, label: a.name + (a.model ? ' · ' + a.model : '') })), '还没有创建智能体');
    $('viewBadge').textContent = kind === 'agent' ? '智能体' : '普通对话'; $('hint').textContent = ''; updateEngineBar();
    emitModel();
  }
  function renderServiceUpdateBanner(info) {
    const banner = $('serviceUpdateBanner'); if (!banner) return;
    banner.replaceChildren();
    if (!info || !info.updateAvailable || !info.latestVersion) { banner.hidden = true; return; }
    try { if (localStorage.getItem('service-update-dismiss:' + info.latestVersion) === '1') { banner.hidden = true; return; } } catch { /* localStorage may be unavailable */ }
    const text = h('div', 'update-text', h('b', '', '发现 Yumeiro 新版本 ' + info.latestVersion), h('div', '', '当前版本 ' + (info.currentVersion || '未知') + '，建议先备份再更新。'));
    const actions = h('div', 'update-actions');
    const open = h('button', 'primary', '查看发布页'); open.type = 'button'; open.onclick = () => { if (info.releaseUrl) window.open(info.releaseUrl, '_blank', 'noopener,noreferrer'); };
    const dismiss = h('button', '', '知道了'); dismiss.type = 'button'; dismiss.onclick = () => { try { localStorage.setItem('service-update-dismiss:' + info.latestVersion, '1'); } catch { /* ignore */ } banner.hidden = true; };
    actions.append(open, dismiss); banner.append(text, actions); banner.hidden = false;
  }
  async function loadServiceUpdate() {
    if (serviceUpdateChecked || me?.role !== 'admin') return;
    serviceUpdateChecked = true;
    try { serviceUpdate = await api('GET', '/api/admin/service-update'); renderServiceUpdateBanner(serviceUpdate); }
    catch { /* non-admin or offline: do not block the client */ }
  }
  async function loadModels() {
    const [modelData, agentData, engineData] = await Promise.all([
      api('GET', '/api/models'), api('GET', '/api/agents').catch(() => ({ agents: [] })), api('GET', '/api/engines').catch(() => ({ engines: [] }))
    ]);
    models = modelData.models || []; defaultModel = modelData.defaultModel || ''; agents = agentData.agents || []; engines = engineData.engines || [];
    workspaces = (await api('GET', '/api/workspaces').catch(() => ({ workspaces: [] }))).workspaces || [];
    const pinned = (() => { try { return localStorage.getItem('ym.defaultModel') || ''; } catch { return ''; } })();
    chatTarget.ref = (pinned && models.some(m => m.ref === pinned) ? pinned : '') || defaultModel || models[0]?.ref || '';
    rebuildTargetOptions();
    loadServiceUpdate();
  }
  $('targetKind').addEventListener('change', rebuildTargetOptions);
  $('runnerSelect').addEventListener('change', () => { applyRunner(); $('modelSelect').dispatchEvent(new Event('ym-commit')); });
  $('wsSelect').addEventListener('change', () => { if ($('wsSelect').value !== '__new') activeWorkspaceId = $('wsSelect').value; });
  $('modelSelect').addEventListener('change', () => { if (chatTarget.kind === 'model') { fillRunners($('modelSelect').value, ''); $('modelSelect').dispatchEvent(new Event('ym-commit')); } else { chatTarget.ref = $('modelSelect').value; $('modelSelect').dispatchEvent(new Event('ym-commit')); } });
  $('modelSelect').addEventListener('ym-commit', async () => {
    emitModel();
    if (chatTarget.kind === 'model' && current) { try { await api('PATCH', '/api/conversations/' + current, { model: chatTarget.ref }); } catch (x) { toast(x.message); } }
  });

  function renderWorkspaceRunEvents(box) {
    box.replaceChildren();
    for (const event of workspaceRun.events) {
      const row = document.createElement('div'); row.className = 'run-event ' + event.type;
      const label = document.createElement('b'); label.textContent = event.label || event.type;
      const text = document.createElement('span'); text.textContent = event.text || event.error || '';
      row.append(label, text); box.append(row);
    }
  }
  async function sendEngine(text) {
    const workspace = activeWorkspaceId;
    if (!workspace) { toast('请先在 IDE 工作区中选择项目'); show('workspaces'); return; }
    const engine = workspaceEngine, model = workspaceModel, mode = workspaceMode;
    if (!engine) { toast('请先选择编译器 / 运行引擎'); return; }
    text = String(text || promptEl.value).trim(); if (!text || busy) return;
    promptEl.value = ''; autosize(); setBusy(true); workspaceRun = { status: 'running', events: [], text: '' };
    const runEvents = $('runEvents'); if (runEvents) renderWorkspaceRunEvents(runEvents);
    const id = ++streamId; let failed = false, acc = '';
    try {
      await new Promise(resolve => {
        const off = app.onStream((sid, ev, data) => {
          if (sid !== id) return;
          if (ev === 'run') workspaceRun.runId = data.id;
          if (ev === 'step_start') workspaceRun.events.push({ type: 'step_start', label: data.label || ('步骤 ' + ((data.index ?? 0) + 1)), text: '运行中' });
          if (ev === 'delta') { acc += data.text || ''; workspaceRun.text = acc; const last = workspaceRun.events.at(-1); if (last) last.text = acc.slice(-1000); }
          if (ev === 'step_end') workspaceRun.events.push({ type: 'step_end', label: data.label || '步骤完成', text: data.text || '' });
          if (ev === 'error' || ev === 'http-error') { failed = true; workspaceRun.status = 'failed'; workspaceRun.events.push({ type: 'error', label: '错误', error: data.error || '运行失败' }); }
          if (ev === 'done') { workspaceRun.status = data.status || (failed ? 'failed' : 'completed'); if (data.final && !acc) acc = data.final; }
          if (ev === 'finished' || ev === 'end' || ev === 'done') { workspaceRun.status = failed ? 'failed' : (workspaceRun.status === 'running' ? 'completed' : workspaceRun.status); off(); resolve(); }
          if (runEvents) renderWorkspaceRunEvents(runEvents);
        });
        app.stream(id, '/api/workspaces/' + encodeURIComponent(workspace) + '/runs', { task: text, mode: 'pipeline', rounds: 1, maxSteps: 8, participants: [{ kind: 'engine', engine, model, mode, label: ({ claude: 'Claude Code', codex: 'Codex', pi: 'Pi' }[engine] || engine) }] });
      });
      if (acc) { messages.push({ role: 'assistant', content: acc }); if (view === 'chat') { addMessage('assistant', acc); toBottom(); } }
      await loadWorkspaceTree(workspace);
    } catch (x) { workspaceRun.status = 'failed'; workspaceRun.events.push({ type: 'error', label: '错误', error: x.message }); const runEvents = $('runEvents'); if (runEvents) renderWorkspaceRunEvents(runEvents); }
    setBusy(false); updateWorkspaceStatus();
  }

  // ── 选了引擎：在所选项目里由 Claude Code / Codex / Pi 执行，并把过程和结果显示在对话里 ──
  async function sendViaEngine(text) {
    text = String(text || promptEl.value).trim(); if (!text || busy) return;
    let ws = $('wsSelect').value;
    if (!ws || ws === '__new') {
      const name = await askText('新建项目（引擎在这个项目的文件夹里工作）', '聊天项目'); if (!name) return;
      try { const d = await api('POST', '/api/workspaces', { name }); workspaces.push(d.workspace); ws = d.workspace.id; updateEngineBar(); $('wsSelect').value = ws; } catch (x) { toast(x.message); return; }
    }
    activeWorkspaceId = ws;
    promptEl.value = ''; autosize(); setBusy(true);
    messages.push({ role: 'user', content: text }); addMessage('user', text); toBottom();
    const bubble = addMessage('assistant', ''); bubble.classList.add('typing');
    const label = ENGINE_LABEL[chatEngine] || chatEngine, id = ++streamId; let acc = '', failed = false, finalText = '';
    try {
      await new Promise(resolve => {
        const off = app.onStream((sid, ev, data) => {
          if (sid !== id) return;
          const stick = atBottom();
          if (ev === 'delta') { acc += data.text || ''; bubble.innerHTML = md(acc); }
          else if (ev === 'step_end' && data.text) finalText = data.text;
          else if (ev === 'error' || ev === 'http-error') { failed = true; bubble.classList.remove('typing'); bubble.classList.add('error'); bubble.textContent = data.error || '运行失败'; }
          if (stick) toBottom();
          if (ev === 'finished' || ev === 'error' || ev === 'http-error' || ev === 'end') { off(); resolve(); }
        });
        app.stream(id, '/api/workspaces/' + encodeURIComponent(ws) + '/runs', { task: text, mode: 'pipeline', rounds: 1, maxSteps: 8, participants: [{ kind: 'engine', engine: chatEngine, model: chatTarget.ref, mode: $('modeSelect').value, label }] });
      });
      bubble.classList.remove('typing');
      if (!failed) { const out = finalText || acc; if (out && out !== acc) bubble.innerHTML = md(out); messages.push({ role: 'assistant', content: out }); } else messages.pop();
      loadUsage();
    } catch (x) { toast(x.message); }
    setBusy(false);
  }

  // ── 发送 / 流式回复 ──
  // ── 附件：回形针 / 粘贴 / 拖进输入框。图片让模型看图；文件（PDF、Word、Excel、PowerPoint、文本、代码等）由服务器提取文字后交给模型 ──
  const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  const FILE_EXTS = 'pdf docx xlsx xlsm pptx odt ods odp epub rtf doc xls ppt txt md markdown csv tsv json jsonl log xml yaml yml toml ini conf cfg properties html htm css scss less js mjs cjs jsx ts tsx vue svelte py java kt swift c h cpp hpp cc cs go rs rb php lua r sql sh bash bat ps1 tex srt vtt diff patch gradle'.split(' ');
  let attCfg = { maxImages: 4, maxMb: 8, maxFiles: 5, maxDocKb: 8192 }, pending = [];
  function attExt(name) { const i = String(name || '').lastIndexOf('.'); return i > 0 ? String(name).slice(i + 1).toLowerCase() : ''; }
  const attStrip = $('attStrip'), attPicker = $('attPicker'), composerEl = $('composer');
  attPicker.accept = IMAGE_TYPES.join(',') + ',' + FILE_EXTS.map(ext => '.' + ext).join(',');
  async function loadAttCfg() { try { attCfg = { ...attCfg, ...(await api('GET', '/api/vision/config')) }; } catch { /* 用默认值 */ } }
  // 上传进度：主进程每 120ms 推一次已发送的字节数；传完之后服务器还要提取文字，这段时间显示“解析中…”。点 × 在上传途中 = 取消上传
  let uploadSeq = 0;
  function showAttProgress(entry) {
    if (!entry.bar) return;
    const done = Boolean(entry.id);
    entry.bar.parentElement.hidden = done;
    entry.bar.style.width = (entry.processing ? 100 : entry.pct || 0) + '%';
    entry.pctEl.textContent = done ? '' : entry.processing ? '解析中…' : (entry.pct || 0) + '%';
  }
  app.onUploadProgress((uid, current, total) => {
    const entry = pending.find(e => e.uid === uid); if (!entry || entry.id || !total) return;
    entry.pct = Math.min(99, Math.round(current / total * 100)); entry.processing = current >= total; showAttProgress(entry);
  });
  function paintAtt() {
    attStrip.replaceChildren(...pending.map(entry => {
      const chip = document.createElement('div'); chip.className = 'att-chip ' + (entry.image ? 'img' : 'doc') + (entry.id ? '' : ' up'); chip.title = entry.name;
      entry.pctEl = document.createElement('span'); entry.pctEl.className = 'att-pct';
      const prog = document.createElement('div'); prog.className = 'att-prog'; entry.bar = document.createElement('i'); prog.append(entry.bar);
      if (entry.image) { const img = document.createElement('img'); img.src = entry.url; img.alt = entry.name; chip.append(img, entry.pctEl); }
      else { const ext = document.createElement('span'); ext.className = 'att-ext'; ext.textContent = (attExt(entry.name) || 'file').slice(0, 5).toUpperCase(); const name = document.createElement('span'); name.className = 'att-name'; name.textContent = entry.name; chip.append(ext, name, entry.pctEl); }
      const x = document.createElement('button'); x.type = 'button'; x.textContent = '×'; x.title = entry.id ? '移除' : '取消上传';
      x.onclick = () => {
        pending.splice(pending.indexOf(entry), 1);
        if (entry.id) api('DELETE', '/api/attachments/' + encodeURIComponent(entry.id)).catch(() => {});
        else { entry.cancelled = true; app.uploadAbort(entry.uid); }
        paintAtt();
      };
      chip.append(prog, x); showAttProgress(entry); return chip;
    }));
  }
  function addAttachments(files) {
    for (const file of files) {
      const image = IMAGE_TYPES.includes(file.type), same = pending.filter(entry => entry.image === image).length;
      if (image && same >= attCfg.maxImages) { toast('一条消息最多带 ' + attCfg.maxImages + ' 张图片'); continue; }
      if (!image && same >= attCfg.maxFiles) { toast('一条消息最多带 ' + attCfg.maxFiles + ' 个文件'); continue; }
      const limitMb = image ? attCfg.maxMb : attCfg.maxDocKb / 1024;
      if (file.size > limitMb * 1048576) { toast(file.name + '：太大了（上限 ' + Math.round(limitMb * 10) / 10 + ' MB）'); continue; }
      const entry = { name: file.name || (image ? '图片' : '文件'), image, url: image ? URL.createObjectURL(file) : '', id: '', uid: ++uploadSeq, pct: 0, processing: false, cancelled: false };
      pending.push(entry); paintAtt();
      file.arrayBuffer().then(bytes => entry.cancelled ? { status: 0, aborted: true } : app.upload(entry.name, bytes, entry.uid)).then(r => {
        if (entry.cancelled || (r && r.aborted)) { if (r && r.status === 201 && r.data && r.data.attachment) api('DELETE', '/api/attachments/' + encodeURIComponent(r.data.attachment.id)).catch(() => {}); return; }   // 取消了：不提示；万一服务器已经收下了就顺手删掉
        if (r && r.status === 201 && r.data && r.data.attachment) { entry.id = r.data.attachment.id; paintAtt(); return; }
        throw new Error((r && r.data && r.data.error) || (r && r.error) || '上传失败（HTTP ' + (r && r.status) + '）');
      }).catch(error => { const i = pending.indexOf(entry); if (i >= 0) pending.splice(i, 1); paintAtt(); if (!entry.cancelled) toast(entry.name + '：' + error.message, 6000); });
    }
  }
  $('btnAttach').addEventListener('click', () => attPicker.click());
  attPicker.addEventListener('change', () => { addAttachments([...attPicker.files]); attPicker.value = ''; });
  promptEl.addEventListener('paste', e => { const files = [...((e.clipboardData && e.clipboardData.files) || [])]; if (files.length) { e.preventDefault(); addAttachments(files); } });
  composerEl.addEventListener('dragover', e => { if ([...((e.dataTransfer && e.dataTransfer.types) || [])].includes('Files')) { e.preventDefault(); composerEl.classList.add('drop'); } });
  composerEl.addEventListener('dragleave', () => composerEl.classList.remove('drop'));
  composerEl.addEventListener('drop', e => { composerEl.classList.remove('drop'); const files = [...((e.dataTransfer && e.dataTransfer.files) || [])]; if (files.length) { e.preventDefault(); addAttachments(files); } });

  function setBusy(on) { busy = on; sendBtn.classList.toggle('stop', on); sendBtn.title = on ? '停止生成' : '发送'; promptEl.disabled = false; }
  async function send(text) {
    text = String(text || promptEl.value).trim();
    const ready = pending.filter(e => e.id);
    if ((!text && !ready.length) || busy) return;
    if (pending.some(e => !e.id)) { toast('附件还在上传，请稍候'); return; }
    if (chatTarget.kind === 'model' && chatEngine) { if (ready.length) { toast('选了 Claude Code / Codex / Pi 时暂不支持附件，请先改回「直接对话」'); return; } return sendViaEngine(text); }
    if (!models.length && chatTarget.kind === 'model') { toast('服务器还没有配置模型，请先到设置里添加'); return; }
    if (!text) text = ready.every(e => !e.image) ? '请阅读我上传的文件，并总结其中的要点。' : '请看这张图片，描述并分析其中的内容。';
    promptEl.value = ''; autosize(); setBusy(true);
    try {
      if (!current) {
        const c = await api('POST', '/api/conversations', chatTarget.kind === 'agent' ? { agent_id: chatTarget.ref } : { model: chatTarget.ref });
        current = c.conversation.id; convs.unshift(c.conversation); renderConvs();
      }
      messages.push({ role: 'user', content: text }); addMessage('user', text, { atts: ready.map(e => e.image ? { src: e.url, name: e.name } : { doc: true, id: e.id, name: e.name }) }); toBottom();
      const sentAtts = ready.map(e => e.id); pending = []; paintAtt();
      const bubble = addMessage('assistant', ''); bubble.classList.add('typing');
      let acc = '', failed = false; const id = ++streamId;
      await new Promise(resolve => {
        const off = app.onStream((sid, ev, data) => {
          if (sid !== id) return;
          const stick = atBottom();
          if (ev === 'delta') { acc += data.text || ''; bubble.innerHTML = md(acc); }
          else if (ev === 'error') { failed = true; bubble.classList.remove('typing'); bubble.classList.add('error'); bubble.textContent = data.error || '回复失败'; }
          else if (ev === 'http-error') { failed = true; bubble.classList.remove('typing'); bubble.classList.add('error'); bubble.textContent = data.error || '请求失败（HTTP ' + data.status + '）'; if (data.status === 401) app.changeServer(); }
          else if (ev === 'done') { if (data.conversation) { $('ctitle').textContent = data.conversation.title || '新对话'; const c = convs.find(x => x.id === current); if (c) Object.assign(c, data.conversation); } }
          if (stick) toBottom();
          if (ev === 'done' || ev === 'finished' || ev === 'error' || ev === 'http-error' || ev === 'end') { off(); resolve(); }
        });
        app.stream(id, '/api/chat/stream', { conversation_id: current, message: text, ...(sentAtts.length ? { attachments: sentAtts } : {}) });
      });
      bubble.classList.remove('typing');
      if (!failed) messages.push({ role: 'assistant', content: acc });
      else messages.pop();
      await loadConvs(); loadUsage();
    } catch (x) { toast(x.message); }
    setBusy(false);
  }
  function stop() { app.streamAbort(streamId); }
  sendBtn.addEventListener('click', () => { if (busy) stop(); else send(); });
  function autosize() { promptEl.style.height = 'auto'; promptEl.style.height = Math.min(220, promptEl.scrollHeight) + 'px'; }
  promptEl.addEventListener('input', autosize);
  promptEl.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!busy) send(); } });
  document.querySelectorAll('.sugs button').forEach(b => b.addEventListener('click', () => { promptEl.value = b.dataset.s.replace(/\\n/g, '\n'); autosize(); promptEl.focus(); }));

  // ── 原生页面路由：功能页不再加载服务器网页 ──
  const pageTitle = { market: '市场', agents: '智能体', workspaces: '工作区', settings: '设置', admin: '管理' };
  const page = $('nativePage');
  const clearPage = (title, subtitle = '') => { page.className = 'native-page'; page.replaceChildren(); const h = document.createElement('div'); h.className = 'page-head'; const t = document.createElement('h1'); t.textContent = title; const s = document.createElement('p'); s.textContent = subtitle; h.append(t, s); page.append(h); return h; };
  const card = (title, body, cls = '') => { const el = document.createElement('article'); el.className = 'panel ' + cls; const h = document.createElement('h3'); h.textContent = title; el.append(h); const p = document.createElement('div'); p.className = 'panel-body'; if (body) p.append(typeof body === 'string' ? Object.assign(document.createElement('p'), { textContent: body }) : body); el.append(p); return el; };
  function workspaceById(id) { return workspaces.find(w => w.id === id); }
  function updateWorkspaceStatus() {
    const state = $('workspaceRunState'); if (state) state.textContent = workspaceRun.status === 'running' ? '运行中' : workspaceRun.status === 'failed' ? '失败' : workspaceRun.status === 'completed' ? '已完成' : '空闲';
    const engine = $('workspaceEngine'); if (engine) engine.value = workspaceEngine;
    const model = $('workspaceModel'); if (model) model.value = workspaceModel;
    const mode = $('workspaceMode'); if (mode) mode.value = workspaceMode;
  }
  function renderWorkspaceTree(box, entries = workspaceTree, prefix = '') {
    box.replaceChildren();
    if (!entries.length) { const empty = document.createElement('div'); empty.className = 'workspace-empty'; empty.textContent = '工作区暂无文件'; box.append(empty); return; }
    const sorted = [...entries].sort((a, b) => (a.path || '').localeCompare(b.path || ''));
    for (const item of sorted) {
      const rel = item.path || item.name || ''; const row = document.createElement('button'); row.type = 'button'; row.className = 'tree-item ' + (rel === activeFilePath ? 'active' : '');
      row.style.paddingLeft = (10 + rel.split('/').length * 10) + 'px'; row.textContent = rel.split('/').pop() || rel; row.title = rel;
      row.addEventListener('click', () => item.type === 'dir' ? toast('目录将在下次展开') : openWorkspaceFile(rel)); box.append(row);
    }
  }
  async function loadWorkspaceTree(id) {
    const data = await api('GET', '/api/workspaces/' + encodeURIComponent(id) + '/tree');
    workspaceTree = (data.files || []).map(file => ({ ...file, type: 'file' }));
    const box = $('workspaceTree'); if (box) renderWorkspaceTree(box);
  }
  async function openWorkspaceFile(path) {
    if (!activeWorkspaceId) return;
    try {
      const data = await api('GET', '/api/workspaces/' + encodeURIComponent(activeWorkspaceId) + '/files?path=' + encodeURIComponent(path));
      activeFilePath = path; workspaceFile = { path, content: data.content || '', binary: data.type === 'binary', truncated: Boolean(data.truncated), dirty: false };
      const title = $('workspaceFileName'); if (title) title.textContent = path;
      const editor = $('workspaceEditor'); if (editor) { editor.disabled = workspaceFile.binary; editor.value = workspaceFile.binary ? '这是二进制文件，不能在文本编辑器中打开。' : workspaceFile.content; }
      const save = $('workspaceSave'); if (save) save.disabled = workspaceFile.binary;
      const box = $('workspaceTree'); if (box) renderWorkspaceTree(box);
    } catch (x) { toast(x.message); }
  }
  async function saveWorkspaceFile() {
    if (!activeWorkspaceId || !workspaceFile || workspaceFile.binary) return;
    const editor = $('workspaceEditor');
    try { await api('PUT', '/api/workspaces/' + encodeURIComponent(activeWorkspaceId) + '/files?path=' + encodeURIComponent(activeFilePath), { content: editor.value }); workspaceFile.content = editor.value; workspaceFile.dirty = false; $('workspaceDirty').textContent = '已保存'; await loadWorkspaceTree(activeWorkspaceId); }
    catch (x) { toast(x.message); }
  }
  function renderWorkspaceIde() {
    const w = workspaceById(activeWorkspaceId); page.replaceChildren();
    const root = document.createElement('section'); root.className = 'workspace-ide';
    const top = document.createElement('header'); top.className = 'workspace-toolbar';
    const sideToggle = document.createElement('button'); sideToggle.className = 'icon'; sideToggle.title = '收起 / 展开侧栏'; sideToggle.textContent = '◧'; sideToggle.onclick = () => document.querySelector('.shell').classList.toggle('collapsed');
    const back = document.createElement('button'); back.className = 'ghost-btn'; back.textContent = '‹ 工作区'; back.onclick = () => { activeWorkspaceId = ''; activeFilePath = ''; workspaceFile = null; renderNative('workspaces'); };
    const title = document.createElement('strong'); title.textContent = w?.name || '工作区';
    const engineLabel = document.createElement('span'); engineLabel.className = 'workspace-pill'; engineLabel.textContent = '编译器与模型独立配置';
    top.append(sideToggle, back, title, engineLabel); root.append(top);
    const body = document.createElement('div'); body.className = 'workspace-body';
    const files = document.createElement('aside'); files.className = 'workspace-files';
    const fh = document.createElement('div'); fh.className = 'workspace-panel-title'; fh.textContent = '文件';
    const tree = document.createElement('div'); tree.id = 'workspaceTree'; tree.className = 'workspace-tree'; files.append(fh, tree);
    const center = document.createElement('section'); center.className = 'workspace-center';
    const fileHead = document.createElement('div'); fileHead.className = 'workspace-file-head'; const fileName = document.createElement('span'); fileName.id = 'workspaceFileName'; fileName.textContent = '选择一个文件'; const dirty = document.createElement('span'); dirty.id = 'workspaceDirty'; dirty.textContent = ''; const save = document.createElement('button'); save.id = 'workspaceSave'; save.className = 'primary-btn'; save.textContent = '保存'; save.disabled = true; save.onclick = saveWorkspaceFile; fileHead.append(fileName, dirty, save);
    const editor = document.createElement('textarea'); editor.id = 'workspaceEditor'; editor.className = 'workspace-editor'; editor.placeholder = '从左侧文件树选择文本文件'; editor.addEventListener('input', () => { if (workspaceFile) { workspaceFile.dirty = true; dirty.textContent = '未保存'; } });
    const output = document.createElement('div'); output.className = 'workspace-output'; const oh = document.createElement('div'); oh.className = 'workspace-panel-title'; oh.textContent = '运行输出'; const events = document.createElement('div'); events.id = 'runEvents'; events.className = 'run-events'; output.append(oh, events); center.append(fileHead, editor, output);
    const inspector = document.createElement('aside'); inspector.className = 'workspace-inspector'; const ih = document.createElement('div'); ih.className = 'workspace-panel-title'; ih.textContent = '编译器 / 模型';
    const engine = document.createElement('select'); engine.id = 'workspaceEngine'; for (const e of engines) { const o = document.createElement('option'); o.value = e.engine; o.textContent = e.label || e.engine; engine.append(o); }
    const model = document.createElement('select'); model.id = 'workspaceModel'; const mode = document.createElement('select'); mode.id = 'workspaceMode'; for (const value of ['readonly', 'edit']) { const o = document.createElement('option'); o.value = value; o.textContent = value === 'edit' ? '可编辑' : '只读'; mode.append(o); }
    const task = document.createElement('textarea'); task.id = 'workspaceTask'; task.placeholder = '描述要在工作区完成的任务…'; const run = document.createElement('button'); run.className = 'primary-btn workspace-run'; run.textContent = '运行任务'; run.onclick = () => { const text = task.value.trim(); if (text) sendEngine(text); };
    const state = document.createElement('div'); state.className = 'run-state'; state.innerHTML = '<span>状态：</span><b id="workspaceRunState">空闲</b>';
    inspector.append(ih, labelControl('编译器 / 运行引擎', engine), labelControl('模型', model), labelControl('权限', mode), task, run, state); body.append(files, center, inspector); root.append(body); page.append(root);
    function refreshEngineModels() { const item = engines.find(e => e.engine === engine.value); model.replaceChildren(); for (const name of item?.models || []) { const o = document.createElement('option'); o.value = name; o.textContent = name; model.append(o); } workspaceEngine = engine.value; workspaceModel = item?.defaultModel || item?.models?.[0] || ''; workspaceMode = item?.maxMode === 'edit' ? 'edit' : 'readonly'; if (workspaceModel) model.value = workspaceModel; mode.value = workspaceMode; mode.querySelector('option[value="edit"]').disabled = item?.maxMode !== 'edit'; updateWorkspaceStatus(); }
    engine.addEventListener('change', refreshEngineModels); model.addEventListener('change', () => { workspaceModel = model.value; }); mode.addEventListener('change', () => { workspaceMode = mode.value; }); refreshEngineModels(); renderWorkspaceTree(tree); renderWorkspaceRunEvents(events); updateWorkspaceStatus();
  }
  function labelControl(text, control) { const label = document.createElement('label'); label.className = 'workspace-control'; const span = document.createElement('span'); span.textContent = text; label.append(span, control); return label; }
  async function openWorkspace(id) { activeWorkspaceId = id; activeFilePath = ''; workspaceFile = null; renderWorkspaceIde(); renderWorkspaceAccess(workspaceById(id)); try { await loadWorkspaceTree(id); } catch (x) { toast(x.message); } }

  function renderWorkspaceAccess(w) {
    if (!w) return;
    const card = h('section', 'panel workspace-access');
    const heading = h('h3', '', '共享与成员');
    const visibility = { private: '仅自己', members: '指定成员', team: '全团队', public: '团队内公开' }[w.visibility || ((w.members || []).length ? 'members' : 'private')] || '仅自己';
    const summary = h('p', '', visibility + ' · ' + ((w.memberDetails || w.members || []).length) + ' 位成员');
    const list = h('div', 'workspace-members');
    const details = Array.isArray(w.memberDetails) ? w.memberDetails : (w.members || []).map(email => ({ id: '', email, displayName: email }));
    const refresh = next => { w = next || w; const i = workspaces.findIndex(x => x.id === w.id); if (i >= 0) workspaces[i] = w; summary.textContent = ({ private: '仅自己', members: '指定成员', team: '全团队', public: '团队内公开' }[w.visibility || 'private'] || '仅自己') + ' · ' + ((w.memberDetails || w.members || []).length) + ' 位成员'; list.replaceChildren(); for (const member of (w.memberDetails || (w.members || []).map(email => ({ id: '', email, displayName: email })))) { const row = h('div', 'workspace-member-row', h('span', '', (member.displayName || member.email) + (member.email && member.displayName !== member.email ? ' · ' + member.email : ''))); list.append(row); } };
    refresh(w); card.append(heading, summary, list);
    if (w.canManage) {
      const input = h('input', 'fld'); input.placeholder = '输入用户名或邮箱（至少 2 个字符）'; const results = h('div', 'workspace-member-results'); const search = h('button', 'ghost-btn', '搜索成员'); search.type = 'button';
      const runSearch = async () => { const q = input.value.trim(); if (q.length < 2) { results.replaceChildren(h('small', '', '请输入至少 2 个字符')); return; } try { const data = await api('GET', '/api/workspaces/' + encodeURIComponent(w.id) + '/members/search?q=' + encodeURIComponent(q)); results.replaceChildren(); for (const candidate of data.members || []) { const invite = h('button', 'ghost-btn', '邀请'); invite.type = 'button'; invite.onclick = async () => { try { const added = await api('POST', '/api/workspaces/' + encodeURIComponent(w.id) + '/members', { userId: candidate.id }); refresh(added.workspace); results.replaceChildren(); input.value = ''; toast(added.alreadyMember ? '成员已经在工作区中' : '成员已邀请'); } catch (x) { toast(x.message); } }; results.append(h('div', 'workspace-member-row', h('span', '', (candidate.displayName || candidate.email) + ' · ' + candidate.email), invite)); } if (!results.childNodes.length) results.append(h('small', '', '没有找到可邀请的普通成员')); } catch (x) { results.replaceChildren(h('small', '', '搜索失败：' + x.message)); } };
      search.onclick = runSearch; input.onkeydown = e => { if (e.key === 'Enter') runSearch(); }; card.append(h('div', 'workspace-invite', input, search), results);
    }
    page.append(card);
  }
  async function renderNativeOld(which) {
    if (which === 'workspaces') {
      if (activeWorkspaceId && workspaceById(activeWorkspaceId)) { renderWorkspaceIde(); renderWorkspaceAccess(workspaceById(activeWorkspaceId)); try { await loadWorkspaceTree(activeWorkspaceId); } catch (x) { toast(x.message); } return; }
      clearPage('工作区', '像 IDE 一样管理项目文件，并在同一个工作区中选择编译器与模型'); const bar = document.createElement('div'); bar.className = 'page-actions'; const input = document.createElement('input'); input.placeholder = '新工作区名称'; const add = document.createElement('button'); add.className = 'primary-btn'; add.textContent = '创建工作区'; add.onclick = async () => { try { const d = await api('POST', '/api/workspaces', { name: input.value.trim() || '未命名工作区' }); workspaces.unshift(d.workspace); input.value = ''; renderNative('workspaces'); } catch (x) { toast(x.message); } }; bar.append(input, add); page.append(bar); const box = document.createElement('div'); box.className = 'page-grid'; for (const w of workspaces) { const b = document.createElement('div'); b.className = 'market-card'; const h = document.createElement('h3'); h.textContent = w.name; const p = document.createElement('p'); p.textContent = (w.mine ? '我的工作区' : '成员工作区') + ' · ' + (w.members || []).length + ' 位成员'; const open = document.createElement('button'); open.className = 'ghost-btn'; open.textContent = '打开 IDE'; open.onclick = () => openWorkspace(w.id); b.append(h, p, open); box.append(b); } if (!workspaces.length) box.append(card('还没有工作区', '创建一个工作区后即可使用 Claude Code、Codex 或 Pi')); page.append(box);
    } else if (which === 'admin') {
      clearPage('管理', '服务器上的设置：成员、安全与熔断、套餐、模型价格、站点和智能体引擎（改动对所有人生效）');
      if (me?.role !== 'admin') { page.append(h('p', 'muted', '只有管理员可以使用这里。')); return; }
      const host = h('div', ''); host.style.cssText = 'max-width:1000px;margin:0 auto'; page.append(host);
      const engineBox = () => { const box = h('div', 'page-grid'); for (const e of engines) box.append(h('div', 'market-card', h('h3', '', e.label || e.engine), h('p', '', (e.ok === false ? '不可用' : '已启用') + ' · ' + ((e.models || []).join(', ') || '未配置模型')))); if (!engines.length) box.append(h('p', 'muted', '没有可用的智能体引擎。')); return box; };
      window.renderAdminPanels({ h, api, toast, setRow, selectOf, host, engineBox });
    }
  }
  async function renderNative(which) {
    if (which === 'settings') return renderSettings(lastSettingsSection);
    if (which === 'agents') return renderAgents();
    if (which === 'market') return renderMarket();
    return renderNativeOld(which);
  }
  // 浏览历史：标题栏的 ‹ › 在对话 / 功能页之间前进后退
  let navigating = false; const hist = []; let hpos = -1;
  function pushHist() { if (navigating) return; const e = { view, conv: view === 'chat' ? current : null }; const last = hist[hpos]; if (last && last.view === e.view && last.conv === e.conv) return; hist.splice(hpos + 1); hist.push(e); hpos = hist.length - 1; }
  async function goHist(step) { const i = hpos + step; if (i < 0 || i >= hist.length) return; hpos = i; const e = hist[i]; navigating = true; try { if (e.view === 'chat') { if (e.conv) await openConv(e.conv); else newChat(); show('chat'); } else show(e.view); } finally { navigating = false; } }
  function show(which) {
    view = which; const isChat = which === 'chat'; $('chat').hidden = !isChat; page.hidden = isChat;
    $('shell').classList.toggle('settings-mode', which === 'settings');
    document.querySelectorAll('.nav[data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === which));
    if (!isChat) { setTitle(pageTitle[which] || '', false); renderNative(which).catch(x => toast(x.message)); pushHist(); }
    else { setTitle($('ctitle').textContent || '新对话', Boolean(current)); promptEl.focus(); }
  }
  document.querySelectorAll('.nav[data-view]').forEach(b => b.addEventListener('click', () => show(b.dataset.view)));
  $('navNew').addEventListener('click', newChat);
  $('navMore').addEventListener('click', () => { const box = $('moreBox'); box.hidden = !box.hidden; $('navMore').setAttribute('aria-expanded', String(!box.hidden)); });
  $('buddy').addEventListener('click', () => newChat());
  $('convHead').addEventListener('click', () => { const box = $('convs'); box.hidden = !box.hidden; $('convHead').classList.toggle('closed', box.hidden); });
  $('btnSettings').addEventListener('click', () => show('settings'));
  $('btnPlus').addEventListener('click', () => { const r = $('btnPlus').getBoundingClientRect(); popMenu(r.left, r.top - 150, [{ label: '新建对话', run: newChat }, { label: '复制整段对话', run: copyConv }, '-', { label: '打开 IDE 工作区', run: () => show('workspaces') }]); });
  app.onChrome(name => {
    if (name === 'side') { $('shell').classList.remove('settings-mode'); $('shell').classList.toggle('collapsed'); }
    else if (name === 'back') goHist(-1); else if (name === 'forward') goHist(1);
    else if (name === 'more' && view === 'chat' && current) popMenu(lastX, 44, [{ label: '重命名', run: renameConv }, { label: '复制整段对话', run: copyConv }, '-', { label: '删除对话', danger: true, run: () => removeConv(current) }]);
  });
  new MutationObserver(() => { if (view === 'chat') setTitle($('ctitle').textContent || '新对话', Boolean(current)); }).observe($('ctitle'), { childList: true, characterData: true, subtree: true });
  $('openWorkspace').addEventListener('click', () => show('workspaces'));
  $('navSearch').addEventListener('click', () => { const f = $('convFilter'); f.hidden = !f.hidden; if (!f.hidden) f.focus(); else { f.value = ''; renderConvs(); } });
  $('convFilter').addEventListener('input', renderConvs);
  $('btnSide').addEventListener('click', () => document.querySelector('.shell').classList.toggle('collapsed'));
  $('btnSignOut').addEventListener('click', () => app.signOut());
  app.onGo(target => { if (target === 'chat' || target === '/') show('chat'); else if (target === '/market') show('market'); else if (target === '/workspaces') show('workspaces'); else if (target === '/settings' || target.startsWith('/settings?')) show('settings'); else if (target === '/admin/settings' || target.startsWith('/admin/')) show('admin'); });

  // ── 状态栏用量 ──
  const fmtNum = n => { n = Number(n) || 0; return n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K' : String(n); };
  async function loadUsage() {
    try { const d = await api('GET', '/api/usage/me'), u = d.usage || {}; $('slRight').textContent = '本月 ' + (u.calls || 0) + (u.monthlyCallLimit ? ' / ' + u.monthlyCallLimit : '') + ' 次 · ' + fmtNum(u.totalTokens || 0) + ' Token'; }
    catch { /* 取不到就不显示 */ }
  }

  // ── 设置页（左侧导航 + 右侧卡片）──
  let lastSettingsSection = 'general';
  const ICONS = {
    general: '<svg viewBox="0 0 16 16"><path d="M2.5 5h6M11.5 5h2M2.5 11h2M7.5 11h6"/><circle cx="10" cy="5" r="1.5"/><circle cx="6" cy="11" r="1.5"/></svg>',
    appearance: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.6"/><circle cx="5.6" cy="6.6" r=".7"/><circle cx="8.6" cy="5.2" r=".7"/><circle cx="10.6" cy="7.4" r=".7"/></svg>',
    pet: '<svg viewBox="0 0 16 16"><circle cx="5" cy="5.5" r="1.3"/><circle cx="11" cy="5.5" r="1.3"/><circle cx="3" cy="9" r="1.2"/><circle cx="13" cy="9" r="1.2"/><path d="M8 7.5c-2.2 0-3.8 2-3.8 3.6 0 1.2 1 1.7 2 1.7.7 0 1.2-.3 1.8-.3s1.1.3 1.8.3c1 0 2-.5 2-1.7C11.8 9.5 10.2 7.5 8 7.5z"/></svg>',
    model: '<svg viewBox="0 0 16 16"><path d="M8 2 13.5 5v6L8 14 2.5 11V5zM8 8v6M2.5 5 8 8l5.5-3"/></svg>',
    usage: '<svg viewBox="0 0 16 16"><path d="M3 13V8M7 13V4M11 13V6M14 13H2"/></svg>',
    remote: '<svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="8" rx="1.4"/><path d="M5.5 14h5M8 11v3"/></svg>',
    about: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.6"/><path d="M8 7.2v3.4M8 5.2v.2"/></svg>'
  };
  const SET_ITEMS = [['general', '通用'], ['appearance', '外观'], ['pet', '桌宠'], ['remote', '远程被控'], ['model', '模型'], ['usage', '用量'], ['about', '关于']];
  const sw = (on, fn) => { const b = h('button', 'switch' + (on ? ' on' : '')); b.type = 'button'; b.setAttribute('role', 'switch'); b.onclick = async () => { const v = !b.classList.contains('on'); b.classList.toggle('on', v); try { await fn(v); } catch (x) { b.classList.toggle('on', !v); toast(x.message); } }; return b; };
  const setRow = (title, desc, control) => h('div', 'set-row', h('div', 'txt', h('b', '', title), desc ? h('small', '', desc) : null), control);
  const selectOf = (opts, value, fn) => { const s = h('select'); for (const [v, l] of opts) { const o = h('option', '', l); o.value = v; s.append(o); } s.value = value; s.onchange = () => fn(s.value); return s; };

  async function renderSettings(section = 'general') {
    lastSettingsSection = section; page.className = 'native-page set'; page.replaceChildren();
    const nav = h('div', 'set-nav'), back = h('button', 'set-back', h('span', '', '←'), h('span', '', '设置')); back.type = 'button'; back.onclick = () => show('chat');
    const search = h('input', 'search'); search.placeholder = '搜索设置';
    nav.append(back, search);
    for (const [id, label] of SET_ITEMS) { const b = h('button', 'item' + (id === section ? ' on' : '')); b.type = 'button'; b.innerHTML = ICONS[id]; b.append(h('span', '', label)); b.dataset.label = label; b.onclick = () => renderSettings(id); nav.append(b); }
    search.oninput = () => { const q = search.value.trim(); nav.querySelectorAll('.item').forEach(b => { b.hidden = q && !b.dataset.label.includes(q); }); };
    const body = h('div', 'set-body'), col = h('div', 'set-col'); body.append(col);
    // 账号卡片
    const name = (me?.name || (me?.email || '').split('@')[0] || '已登录');
    const out = h('button', 'ghost-btn', '退出登录'), more = h('button', 'ghost-btn', '登录其他账号 / 换服务器'); out.type = more.type = 'button'; out.onclick = () => app.signOut(); more.onclick = () => app.changeServer();
    col.append(h('div', 'set-profile', h('div', 'avatar', (name[0] || 'U').toUpperCase()), h('div', 'info', h('b', '', name), h('small', '', (me?.email || '') + ' · ' + (me?.role === 'admin' ? '管理员' : '成员'))), h('div', 'btns', out, more)));
    page.append(nav, body); setTitle('设置', false);
    const pet = await app.petGet().catch(() => ({}));
    const host = (await app.getServer()).replace(/^https?:\/\//, '');
    if (section === 'general') {
      col.append(h('div', 'set-h', '服务器'), h('div', 'set-card', setRow('当前服务器', '客户端连接的 Yumeiro 服务器', h('code', '', host)), setRow('显示语言', '界面语言', h('span', '', '简体中文'))));
      col.append(h('div', 'set-h', '应用行为'), h('div', 'set-card',
        setRow('开机自启', '登录 Windows 后自动打开 Yumeiro，桌宠随之出现', sw(Boolean(pet.autostart), v => app.petSet({ autostart: v }))),
        setRow('关闭窗口时', '点关闭只是收起到托盘，桌宠继续陪着你；真正退出请用托盘菜单或标题栏 ☰ 菜单', h('span', '', '收起到托盘'))));
    } else if (section === 'appearance') {
      col.append(h('div', 'set-h', '主题'));
      const cur = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
      col.append(h('div', 'set-card', setRow('配色', '深色最适合配合壁纸使用', selectOf([['dark', '深色'], ['light', '浅色']], cur, v => { document.documentElement.dataset.theme = v; try { localStorage.setItem('yumeiro.theme', v); } catch { /* 存储不可用 */ } }))));
      col.append(h('div', 'set-h', '壁纸'));
      const card = h('div', 'set-card'), grid = h('div', 'wall-grid'), dimRow = h('div', ''); card.append(setRow('只在这台电脑上生效', '壁纸保存在本机，不会随服务器或账号改变，也不会被服务器的默认壁纸替换', h('span', '')), grid, dimRow); col.append(card);
      (async () => {
        let d = { items: [] }; try { d = await api('GET', '/api/wallpapers'); } catch { /* 读不到服务器壁纸库也不影响本机壁纸 */ }
        let choice = wallChoice(), dim = wallDimValue();
        const mark = () => grid.querySelectorAll('.wall-tile').forEach(t => t.classList.toggle('on', t.dataset.name === choice));
        const choose = async name => { choice = name; wallSet(name); mark(); await applyWall(d, choice, dim); };
        const mk = (name, label, style) => { const t = h('button', 'wall-tile' + (name === '' ? ' none' : '') + (name === choice ? ' on' : ''), h('span', '', label)); if (name === '') t.textContent = label; t.type = 'button'; t.dataset.name = name; if (style) t.style.backgroundImage = style; t.onclick = () => choose(name).catch(x => toast(x.message)); grid.append(t); return t; };
        mk('', '无壁纸');
        const pick = h('button', 'wall-tile', h('span', '', '＋ 从本机选图片')); pick.type = 'button';
        pick.onclick = async () => { const r = await app.wallPick(); if (r && r.ok) { await choose('local'); mk('local', '我的图片').style.backgroundImage = 'url("' + await app.wallGet() + '")'; toast('已设为壁纸（只在这台电脑上生效）'); } else if (r && r.error) toast(r.error); };
        grid.append(pick);
        if (choice === 'local') app.wallGet().then(url => { if (url) mk('local', '我的图片').style.backgroundImage = 'url("' + url + '")'; });
        for (const pr of WALL_PRESETS) mk('preset:' + pr[0], pr[1], pr[2]);
        const images = (d.items || []).filter(i => i.kind === 'image').slice(0, 24);
        for (const item of images) {
          const tile = mk('server:' + item.name, item.name.replace(/\.[^.]+$/, ''));
          app.file('/api/wallpapers/file/' + encodeURIComponent(item.name)).then(url => { if (url) tile.style.backgroundImage = 'url("' + url + '")'; });
        }
        const range = h('input'); range.type = 'range'; range.min = '0'; range.max = '80'; range.step = '5'; range.value = String(dim);
        range.oninput = () => { dim = Number(range.value); setDim(dim); };
        range.onchange = () => { dim = Number(range.value); wallDimSet(dim); };
        dimRow.append(setRow('壁纸遮罩', '数值越大壁纸越暗，文字更清楚', range));
      })();
    } else if (section === 'pet') {
      const set = patch => app.petSet(patch);
      col.append(h('div', 'set-h', '桌宠'), h('div', 'set-card',
        setRow('显示桌宠', '在桌面上显示梦色，可以拖动、点她、摸她', sw(pet.enabled !== false, v => set({ enabled: v }))),
        setRow('自己走动', '没人理她的时候在屏幕上溜达', sw(pet.wander !== false, v => set({ wander: v }))),
        setRow('漫游范围', '整个屏幕随便走，或只在她当前所在的高度左右走', selectOf([['screen', '整个屏幕'], ['bottom', '只在当前高度']], pet.roam || 'screen', v => set({ roam: v }))),
        setRow('大小', '', selectOf([[110, '小'], [150, '中'], [200, '大'], [260, '特大']], pet.size || 150, v => set({ size: Number(v) }))),
        setRow('安静模式', '不再冒台词气泡', sw(Boolean(pet.mute), v => set({ mute: v }))),
        setRow('主动找我说话', '根据你们聊过的事、待办和时间偶尔开口', sw(pet.proactive !== false, v => set({ proactive: v })))));
      col.append(h('div', 'set-h', '智能理解'), h('div', 'set-card',
        setRow('AI 台词与情绪理解', '让模型帮她想台词、判断你的情绪（会消耗模型额度）', sw(Boolean(pet.aiLines), v => set({ aiLines: v }))),
        setRow('识别表情图片', '你发表情包时用看图模型理解它（会消耗额度）', sw(pet.sticker !== false, v => set({ sticker: v })))));
    } else if (section === 'remote') {
      const card = h('div', 'set-card'), note = h('div', 'empty-state'), logBox = h('pre', ''); logBox.style.cssText = 'margin:8px 0 0;padding:8px 10px;max-height:150px;overflow:auto;font-size:11.5px;line-height:1.5;white-space:pre-wrap;opacity:.75;border-radius:10px;background:#00000026';
      const STATUS = { stopped: '已关闭', starting: '正在启动…', pairing: '正在配对…', online: '✅ 已连接，手机和网页能看到这台电脑', reconnecting: '⚠ 连接中断，正在重试', error: '⚠ 出错' };
      col.append(h('div', 'set-h', '远程被控（让手机 / 网页远程查看和操控这台电脑）'), card, note);
      let timer = 0;
      const draw = async () => {
        if (lastSettingsSection !== 'remote' || !document.body.contains(card)) { clearInterval(timer); return; }
        let st; try { st = await app.remoteGet(); } catch (x) { card.replaceChildren(h('div', 'empty-state', '读取状态失败：' + x.message)); return; }
        const unpair = h('button', 'ghost-btn', '取消配对'); unpair.type = 'button'; unpair.disabled = !st.paired;
        unpair.onclick = async () => { if (!confirm('取消配对后，这台电脑会从手机和网页的“远程控制”列表里消失，需要时再重新开启。确定吗？')) return; await app.remoteUnpair(); draw(); };
        card.replaceChildren(
          setRow('开启远程被控', '打开后，这台电脑只会向你的服务器发起连接（不用开放端口）；第一次打开会自动配对，不用输入配对码', sw(st.enabled, async v => { await app.remoteSet({ enabled: v }); draw(); })),
          setRow('当前状态', '', h('span', '', (STATUS[st.status] || st.status) + (st.note ? '：' + st.note : ''))),
          setRow('允许手机操作', '关闭时手机和网页只能看画面，不能点击和输入文字；改完会自动重连一次', sw(st.control, async v => { await app.remoteSet({ control: v }); draw(); })),
          setRow('这台电脑', st.paired ? '已配对，设备名：' + st.deviceName : '还没有配对（打开上面的开关会自动配对）', unpair));
        note.textContent = '怎么用：手机软件登录同一个服务器、同一个账号，进入“远程操控电脑”，就能看到这台电脑并操作；也可以在网页的“远程控制”里用。被控端随客户端运行：关闭窗口会收起到托盘继续运行，从托盘菜单退出才会停止。Windows 的锁屏和 UAC 弹窗界面系统不允许远程操作。';
        logBox.textContent = (st.log || []).join('\n'); if (st.log && st.log.length && !card.contains(logBox)) card.append(logBox);
      };
      draw(); timer = setInterval(draw, 2000);
    } else if (section === 'model') {
      const pinned = (() => { try { return localStorage.getItem('ym.defaultModel') || ''; } catch { return ''; } })();
      const opts = models.map(m => [m.ref, (m.label || m.model || m.ref) + (m.providerName ? ' · ' + m.providerName : '')]);
      col.append(h('div', 'set-h', '对话'), h('div', 'set-card', setRow('默认对话模型', '新建对话时默认使用；每次对话里也可以在输入框右下角临时切换', opts.length ? selectOf(opts, pinned || defaultModel || opts[0][0], v => { try { localStorage.setItem('ym.defaultModel', v); } catch { /* 存储不可用 */ } chatTarget.ref = v; if (chatTarget.kind === 'model') { $('modelSelect').value = v; emitModel(); } toast('已设为默认模型'); }) : h('span', '', '服务器还没有配置模型'))));
      col.append(h('div', 'set-h', '可用模型 (' + models.length + ')'));
      const list = h('div', 'set-card'); for (const m of models.slice(0, 60)) list.append(setRow(m.label || m.model || m.ref, m.providerName || '', h('code', '', m.ref))); if (!models.length) list.append(h('div', 'empty-state', '暂无')); col.append(list);
      const eng = h('div', 'set-card'); if (engines.length) for (const e of engines) eng.append(setRow(e.label || e.engine, (e.models || []).join('、') || '使用默认模型', h('span', '', e.ok === false ? '不可用' : '已启用'))); else eng.append(h('div', 'empty-state', '服务器未启用 Claude Code / Codex / Pi'));
      col.append(h('div', 'set-h', '智能体引擎'), eng);
    } else if (section === 'usage') {
      try {
        const d = await api('GET', '/api/usage/me'), u = d.usage || {};
        const bar = (v, max) => { const b = h('div', 'usage-bar'), i = document.createElement('i'); i.style.width = (max ? Math.min(100, Math.round(v / max * 100)) : 0) + '%'; b.append(i); return b; };
        const line = (label, v, max) => setRow(label, max ? v + ' / ' + max : v + '（不限）', bar(v, max));
        col.append(h('div', 'set-h', '用量 · ' + (d.month || '')), h('div', 'set-card', line('今日调用', u.todayCalls || 0, u.dailyLimit), line('本月调用', u.calls || 0, u.monthlyCallLimit), line('本月 Token', u.totalTokens || 0, u.monthlyTokenLimit)));
        for (const a of d.alerts || []) col.append(h('div', 'set-card', setRow('⚠ ' + (a.label || '额度提醒'), '已用 ' + (a.percent | 0) + '%', h('span', '', ''))));
        if (d.blocked) col.append(h('div', 'set-card', setRow('额度已用完', d.blocked, h('span', '', ''))));
        const hist = d.history || []; if (hist.length) { const c = h('div', 'set-card'); for (const x of hist.slice().reverse()) c.append(setRow(x.month, '', h('span', '', x.calls + ' 次 · ' + fmtNum(x.totalTokens) + ' Token'))); col.append(h('div', 'set-h', '历史'), c); }
      } catch (x) { col.append(h('div', 'set-card', h('div', 'empty-state', '读取用量失败：' + x.message))); }
    } else if (section === 'about') {
      const version = await app.version().catch(() => '');
      col.append(h('div', 'set-h', '关于'), h('div', 'set-card', h('dl', 'kv', h('dt', '', '客户端版本'), h('dd', '', version || '—'), h('dt', '', '服务器'), h('dd', '', host), h('dt', '', '登录账号'), h('dd', '', me?.email || ''), h('dt', '', '可用模型'), h('dd', '', String(models.length)), h('dt', '', '智能体'), h('dd', '', String(agents.length)), h('dt', '', '工作区'), h('dd', '', String(workspaces.length)))), h('div', 'empty-state', h('div', '', 'Powered by Yumeiro'), h('div', '', '使用 Cindy、Dash黄一孟 的项目进行制作 · 制作者：BYL'), h('div', '', '以 Apache License 2.0 开源；使用、修改、分发请保留署名与许可证')));
    }
  }

  // ── 智能体（原生增删改）──
  async function agentDialog(existing) {
    const skills = (await api('GET', '/api/skills').catch(() => ({ skills: [] }))).skills || [];
    const name = h('input', 'fld'), desc = h('input', 'fld'), prompt = h('textarea', 'fld'), model = h('select', 'fld'), shared = h('input'); shared.type = 'checkbox';
    name.value = existing?.name || ''; desc.value = existing?.description || ''; prompt.value = existing?.systemPrompt || '';
    const none = h('option', '', '使用默认模型'); none.value = ''; model.append(none); for (const m of models) { const o = h('option', '', (m.label || m.model || m.ref) + (m.providerName ? ' · ' + m.providerName : '')); o.value = m.ref; model.append(o); } model.value = existing?.model || '';
    const picked = new Set(existing?.skillIds || []), skillBox = h('div', '');
    for (const s of skills) { const cb = h('input'); cb.type = 'checkbox'; cb.checked = picked.has(s.id); cb.onchange = () => { if (cb.checked) picked.add(s.id); else picked.delete(s.id); }; const l = h('label', '', cb, ' ' + s.title); l.style.cssText = 'display:flex;gap:8px;align-items:center;padding:3px 0'; skillBox.append(l); }
    const form = h('div', 'form-grid', h('label', '', '名称', name), h('label', '', '一句话简介', desc), h('label', '', '系统提示词（这个智能体的角色与规则）', prompt), h('label', '', '模型', model),
      skills.length ? h('label', '', '绑定技能（最多 8 个）', skillBox) : null,
      me?.role === 'admin' ? h('label', '', h('span', '', shared, ' 共享给所有成员')) : null);
    shared.checked = Boolean(existing?.shared);
    const ok = await dialog(existing ? '编辑智能体' : '新建智能体', form, '保存'); if (!ok) return false;
    const body = { name: name.value.trim(), description: desc.value.trim(), systemPrompt: prompt.value.trim(), model: model.value || null, skillIds: [...picked] };
    if (me?.role === 'admin') body.shared = shared.checked;
    if (existing) await api('PATCH', '/api/agents/' + existing.id, body); else await api('POST', '/api/agents', body);
    return true;
  }
  async function reloadAgents() { agents = (await api('GET', '/api/agents').catch(() => ({ agents: [] }))).agents || []; rebuildTargetOptions(); }
  async function renderAgents() {
    clearPage('智能体', '给不同的事情配不同的角色：写好提示词、选好模型，聊天时一键切换');
    const add = h('button', 'primary-btn', '新建智能体'); add.type = 'button'; add.onclick = async () => { try { if (await agentDialog(null)) { await reloadAgents(); renderAgents(); toast('已创建'); } } catch (x) { toast(x.message); } };
    page.append(h('div', 'page-actions', add));
    const grid = h('div', 'page-grid'); page.append(grid);
    if (!agents.length) grid.append(h('div', 'panel empty-state', '还没有智能体。点右上的「新建智能体」创建第一个'));
    for (const a of agents) {
      const chat = h('button', 'ghost-btn', '开始对话'), edit = h('button', 'ghost-btn', '编辑'), del = h('button', 'ghost-btn danger-btn', '删除'); chat.type = edit.type = del.type = 'button';
      chat.onclick = () => { $('targetKind').value = 'agent'; rebuildTargetOptions(); $('modelSelect').value = a.id; chatTarget.ref = a.id; emitModel(); newChat(); show('chat'); };
      edit.onclick = async () => { try { if (await agentDialog(a)) { await reloadAgents(); renderAgents(); toast('已保存'); } } catch (x) { toast(x.message); } };
      del.onclick = async () => { if (!await ymConfirm('删除智能体「' + a.name + '」？', { danger: true })) return; try { await api('DELETE', '/api/agents/' + a.id); await reloadAgents(); renderAgents(); } catch (x) { toast(x.message); } };
      const tags = h('div', 'tags'); if (a.shared) tags.append(h('span', 'tag', '共享')); if (a.model) tags.append(h('span', 'tag', a.model)); if ((a.skillIds || []).length) tags.append(h('span', 'tag', a.skillIds.length + ' 个技能'));
      const foot = h('div', 'foot', h('span', '', a.mine ? '我创建的' : '他人共享'), h('span', '', ''));
      const btns = h('div', 'page-actions'); btns.style.margin = '8px 0 0'; btns.append(chat); if (a.mine || me?.role === 'admin') btns.append(edit, del);
      grid.append(h('div', 'market-card', h('h3', '', a.name || '未命名智能体'), h('p', '', a.description || '（没有简介）'), tags, foot, btns));
    }
  }

  // ── 市场（技能 / 机器人，可安装）──
  let marketTab = 'skills';
  async function renderMarket() {
    clearPage('市场', '浏览并安装技能和机器人，装好后在智能体里就能用');
    const d = await api('GET', '/api/market'); const lists = { skills: d.skills || [], bots: d.bots || [] };
    const seg = h('div', 'seg'); for (const [id, label] of [['skills', '技能'], ['bots', '机器人']]) { const b = h('button', id === marketTab ? 'on' : '', label + ' (' + lists[id].length + ')'); b.type = 'button'; b.onclick = () => { marketTab = id; renderMarket(); }; seg.append(b); }
    const search = h('input', 'fld'); search.placeholder = '搜索名称或描述'; search.style.maxWidth = '300px';
    page.append(h('div', 'page-actions', seg, search)); const grid = h('div', 'page-grid'); page.append(grid);
    const draw = () => {
      grid.replaceChildren(); const q = search.value.trim().toLowerCase();
      const items = lists[marketTab].filter(i => !q || (i.title + ' ' + (i.description || '')).toLowerCase().includes(q));
      if (!items.length) grid.append(h('div', 'panel empty-state', q ? '没有匹配的条目' : '市场里还没有内容'));
      for (const i of items) {
        const btn = h('button', i.installed ? 'ghost-btn' : 'primary-btn', i.installed ? '已安装' : '安装'); btn.type = 'button'; btn.disabled = Boolean(i.installed);
        btn.onclick = async () => { btn.disabled = true; btn.textContent = '安装中…'; try { await api('POST', '/api/market/install', { key: i.key, type: i.type }); i.installed = true; if (i.type === 'bot') await reloadAgents(); toast('已安装「' + i.title + '」'); draw(); } catch (x) { toast(x.message); btn.disabled = false; btn.textContent = '安装'; } };
        const tags = h('div', 'tags'); for (const tag of (i.tags || []).slice(0, 4)) tags.append(h('span', 'tag', tag));
        grid.append(h('div', 'market-card', h('h3', '', i.title || i.key), h('p', '', i.description || '暂无描述'), tags, h('div', 'foot', h('span', '', i.author || ''), btn)));
      }
    };
    search.oninput = draw; draw();
  }

  // ── 壁纸（读你在「设置 → 壁纸」里的选择）──
  const WALL_PRESETS = [['aurora', '极光', 'linear-gradient(135deg,#1d2b64,#f8cdda)'], ['dusk', '黄昏', 'linear-gradient(135deg,#355c7d,#6c5b7b,#c06c84)'], ['mint', '薄荷', 'linear-gradient(135deg,#a8edea,#fed6e3)'], ['ocean', '海湾', 'linear-gradient(135deg,#2193b0,#6dd5ed)'], ['sunrise', '日出', 'linear-gradient(135deg,#ff9a9e,#fecfef,#fecfef)'], ['forest', '森林', 'linear-gradient(135deg,#134e5e,#71b280)'], ['night', '夜空', 'linear-gradient(135deg,#0f2027,#203a43,#2c5364)'], ['sand', '沙丘', 'linear-gradient(135deg,#f6d365,#fda085)']];
  // 服务器的“暗度”是 0–80 的整数百分比；这里换算成深色遮罩的不透明度
  const setDim = dim => document.documentElement.style.setProperty('--dim', 'rgba(8,10,16,' + (0.15 + Math.max(0, Math.min(80, Number(dim) || 0)) / 100 * 0.75).toFixed(2) + ')');
  // 壁纸的选择只存在这台电脑上（localStorage + 用户数据目录里的一张图），不读也不写服务器上的壁纸偏好和默认壁纸
  const wallChoice = () => { try { return localStorage.getItem('yumeiro.wall') || ''; } catch { return ''; } };
  const wallSet = v => { try { localStorage.setItem('yumeiro.wall', v); } catch { /* 存储不可用 */ } };
  const wallDimValue = () => { try { const raw = localStorage.getItem('yumeiro.wallDim'), n = Number(raw); return raw !== null && Number.isFinite(n) ? Math.max(0, Math.min(80, n)) : 35; } catch { return 35; } };
  const wallDimSet = v => { try { localStorage.setItem('yumeiro.wallDim', String(Math.round(v))); } catch { /* 存储不可用 */ } };
  async function applyWall(d, choice, dim) {
    const wall = $('wall'); setDim(dim);
    const preset = WALL_PRESETS.find(pr => 'preset:' + pr[0] === choice);
    if (preset) { wall.style.backgroundImage = preset[2]; return; }
    if (choice === 'local') { const url = await app.wallGet(); wall.style.backgroundImage = url ? 'url("' + url + '")' : ''; if (!url) wallSet(''); return; }
    if (choice.startsWith('server:')) {
      const name = choice.slice(7), file = ((d && d.items) || []).find(i => i.name === name);
      if (!file || file.kind !== 'image') { wall.style.backgroundImage = ''; if (d && d.items && d.items.length) wallSet(''); return; }   // 服务器上已经没有这张图：悄悄回到“无壁纸”
      const url = await app.file('/api/wallpapers/file/' + encodeURIComponent(file.name));
      wall.style.backgroundImage = url ? 'url("' + url + '")' : ''; return;
    }
    wall.style.backgroundImage = '';
  }
  async function loadWallpaper() {
    const choice = wallChoice(); let d = null;
    if (choice.startsWith('server:')) { try { d = await api('GET', '/api/wallpapers'); } catch { /* 连不上就先不显示 */ } }
    try { await applyWall(d, choice, wallDimValue()); } catch { /* 没有壁纸就保持深色底 */ }
  }

  // ── 启动 ──
  (async () => {
    try {
      me = await api('GET', '/api/auth/session');
      if (!me.authenticated) { app.changeServer(); return; }
      $('meName').textContent = me.name || me.email || '已登录'; $('meAvatar').textContent = (me.email || 'U')[0].toUpperCase();
      const host = (await app.getServer()).replace(/^https?:\/\//, '');
      $('meHost').textContent = (me.role === 'admin' ? '管理员 · ' : '') + host; $('slLeft').textContent = 'Yumeiro · ' + host;
      $('navAdmin').hidden = me.role !== 'admin';
      await Promise.all([loadConvs(), loadModels(), loadAttCfg()]); loadWallpaper(); loadUsage(); setTitle('新对话', false); pushHist(); promptEl.focus();
    } catch (x) { toast(x.message, 6000); }
  })();
})();
