// AI 指引对话：右侧抽屉。两种模式：
//  使用向导 —— 问“怎么用 / 怎么配置”，AI 会给出步骤和跳转按钮，也可以一步步带你配置；
//  任务引导 —— 说出想做的事，AI 一步步追问（给选项可点选），最后生成项目文件，可保存到工作区、在线预览、下载 zip 或本地使用包。
(() => {
  const KEY = 'yumeiro.guide.';
  const el = (tag, props = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) { if (k === 'on') for (const [e, f] of Object.entries(v)) node.addEventListener(e, f); else if (k === 'style') node.style.cssText = v; else if (k in node) node[k] = v; else node.setAttribute(k, v); }
    node.append(...kids.flat().filter(x => x != null && x !== false));
    return node;
  };
  let csrf = '', drawer = null, mode = 'help', busy = false, listEl = null, inputEl = null, sendBtn = null;
  const state = { help: [], task: [] }; // 每项：{role, content, text?, options?, actions?, files?}
  const GREETING = {
    help: { text: '你好，我是 Yumeiro 的指引助手。想了解哪个功能、怎么配置，直接问我；也可以让我“带你一步步配置”。', options: ['带我完成首次配置', '怎么用语音通话', '怎么让多个智能体协作', '怎么把项目下载到本地用'] },
    task: { text: '告诉我你想做什么，我会一步步问你几个问题，然后帮你生成项目文件。生成后可以在线预览、保存到工作区，或下载到本地使用。', options: ['做一个个人主页', '做一个待办清单网页', '写一份项目方案文档', '做一个小游戏'] }
  };
  const load = m => { try { const v = JSON.parse(localStorage.getItem(KEY + m) || '[]'); return Array.isArray(v) ? v.slice(-40) : []; } catch { return []; } };
  const store = m => { try { localStorage.setItem(KEY + m, JSON.stringify(state[m].slice(-40))); } catch { /* 存储满了就算了 */ } };
  async function api(path, options = {}) {
    const headers = { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) };
    const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '请求失败：' + response.status);
    return data;
  }
  const style = el('style', {}, `
    .ym-guide{position:fixed;top:0;right:0;bottom:0;width:min(460px,100vw);z-index:70;display:flex;flex-direction:column;background:var(--ym-card,#fff);color:var(--ink);border-left:1px solid var(--line);box-shadow:var(--shadow)}
    .ym-guide[hidden]{display:none}
    .ym-guide header{display:flex;gap:6px;align-items:center;padding:10px 12px;border-bottom:1px solid var(--line)}
    .ym-guide header .grow{flex:1} .ym-guide header button{border:1px solid var(--line);background:transparent;color:inherit;border-radius:9px;padding:5px 10px;cursor:pointer;font-size:13px}
    .ym-guide header button.on{background:var(--accent,#e95164);border-color:var(--accent,#e95164);color:#fff}
    .ym-guide .gl{flex:1;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:12px}
    .ym-guide .gm{max-width:92%;padding:9px 12px;border-radius:12px;white-space:pre-wrap;word-break:break-word;line-height:1.65;font-size:14px}
    .ym-guide .gm.user{align-self:flex-end;background:var(--accent-soft,#fff0f2);border:1px solid var(--line)} .ym-guide .gm.assistant{align-self:flex-start;border:1px solid var(--line)}
    .ym-guide .gm.err{color:#d33}
    .ym-guide .gchips{display:flex;gap:6px;flex-wrap:wrap} .ym-guide .gchips button,.ym-guide .gact button,.ym-guide .gfile button,.ym-guide .gfile a{border:1px solid var(--line);background:transparent;color:inherit;border-radius:16px;padding:5px 12px;cursor:pointer;font-size:13px;text-decoration:none}
    .ym-guide .gchips button:hover,.ym-guide .gact button:hover{border-color:var(--accent,#e95164);color:var(--accent,#e95164)}
    .ym-guide .gact button{background:var(--accent,#e95164);border-color:var(--accent,#e95164);color:#fff}
    .ym-guide .gfile{border:1px solid var(--line);border-radius:12px;padding:10px 12px;font-size:13px;display:flex;flex-direction:column;gap:8px;align-self:stretch}
    .ym-guide .gfile pre{margin:0;max-height:200px;overflow:auto;font-size:12px;background:rgba(127,127,127,.12);padding:8px;border-radius:8px;white-space:pre-wrap}
    .ym-guide .gfile .row{display:flex;gap:6px;flex-wrap:wrap;align-items:center} .ym-guide .gfile select,.ym-guide .gfile input{height:30px;border:1px solid var(--line);border-radius:8px;padding:0 8px;background:transparent;color:inherit}
    .ym-guide form{display:flex;gap:8px;padding:10px 12px;border-top:1px solid var(--line)} .ym-guide textarea{flex:1;min-height:42px;max-height:120px;resize:vertical;border:1px solid var(--line);border-radius:10px;padding:8px;background:transparent;color:inherit;font:inherit}
    .ym-guide form button{border:0;background:var(--accent,#e95164);color:#fff;border-radius:10px;padding:0 16px;cursor:pointer} .ym-guide form button:disabled{opacity:.5}
    .ym-guide .gnote{font-size:12px;color:var(--muted);padding:0 14px 6px}`);
  document.head.append(style);

  const fmtSize = n => n > 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B';
  // 发给服务器的历史：只有最新一条带文件的回复保留文件内容，其余只留文件名
  function history() {
    const list = state[mode].filter(m => m.content).slice(-14);
    const lastWithFiles = list.map(m => Boolean(m.files?.length)).lastIndexOf(true);
    return list.map((m, i) => {
      if (m.role !== 'assistant' || !m.files?.length) return { role: m.role, content: m.content };
      const blocks = i === lastWithFiles ? m.files.map(f => '<<<FILE path="' + f.path + '">>>\n' + f.content + '\n<<<END>>>').join('\n') : '（已生成文件：' + m.files.map(f => f.path).join('、') + '）';
      return { role: 'assistant', content: (m.text || '') + '\n' + blocks };
    });
  }
  const bubble = m => el('div', { class: 'gm ' + m.role + (m.error ? ' err' : ''), textContent: m.text ?? m.content });
  function fileCard(files) {
    const box = el('div', { class: 'gfile' }), result = el('div', { class: 'row' });
    box.append(el('strong', { textContent: '生成了 ' + files.length + ' 个文件' }));
    for (const f of files) {
      const pre = el('pre', { hidden: true, textContent: f.content });
      box.append(el('div', { class: 'row' }, el('span', { textContent: '📄 ' + f.path + '（' + fmtSize(new Blob([f.content]).size) + '）' }), el('button', { type: 'button', textContent: '查看', on: { click: () => { pre.hidden = !pre.hidden; } } })), pre);
    }
    const select = el('select', {}, el('option', { value: '', textContent: '＋ 新建工作区' })), name = el('input', { placeholder: '新工作区名称', value: 'AI 引导项目', maxLength: 60 });
    const save = el('button', { type: 'button', textContent: '保存到工作区', on: { click: async () => {
      save.disabled = true; result.replaceChildren(el('span', { textContent: '保存中…' }));
      try {
        const r = await api('/api/guide/save', { method: 'POST', body: JSON.stringify({ files, ...(select.value ? { workspaceId: select.value } : { newWorkspaceName: name.value }) }) });
        const link = (label, href) => el('a', { href, textContent: label });
        result.replaceChildren(el('span', { textContent: '✅ 已保存到“' + r.name + '”（同名旧文件已自动备份）' }),
          r.hasIndex ? el('button', { type: 'button', textContent: '🌐 在线预览', on: { click: async () => { try { const p = await api(`/api/workspaces/${r.workspaceId}/preview-link`, { method: 'POST', body: '{}' }); window.open(p.url, '_blank', 'noopener'); } catch (e) { ymAlert(e.message); } } } }) : null,
          link('📦 下载 zip', `/api/workspaces/${r.workspaceId}/export`), link('💻 本地使用包', `/api/workspaces/${r.workspaceId}/export?local=1`), link('📁 打开工作区', '/workspaces'));
      } catch (e) { result.replaceChildren(el('span', { style: 'color:#d33', textContent: e.message })); }
      save.disabled = false;
    } } });
    api('/api/workspaces').then(r => { if (!r.runner) { box.append(el('p', { class: 'gnote', style: 'padding:0', textContent: '提示：服务器还没有安装智能体运行器，暂时不能保存到工作区。' })); save.disabled = true; } for (const w of r.workspaces || []) select.append(el('option', { value: w.id, textContent: w.name })); }).catch(() => {});
    select.addEventListener('change', () => { name.hidden = Boolean(select.value); });
    box.append(el('div', { class: 'row' }, select, name, save), result);
    return box;
  }
  function render() {
    listEl.replaceChildren();
    const items = state[mode].length ? state[mode] : [{ role: 'assistant', ...GREETING[mode], content: '' }];
    items.forEach((m, index) => {
      listEl.append(bubble(m));
      if (m.files?.length) listEl.append(fileCard(m.files));
      if (m.actions?.length) listEl.append(el('div', { class: 'gact gchips' }, m.actions.map(a => el('button', { type: 'button', textContent: a.label + ' →', on: { click: () => { location.href = a.href; } } }))));
      if (m.options?.length && index === items.length - 1) listEl.append(el('div', { class: 'gchips' }, m.options.map(o => el('button', { type: 'button', textContent: o, on: { click: () => ask(o) } }))));
    });
    listEl.scrollTop = listEl.scrollHeight;
  }
  async function ask(text) {
    text = String(text || '').trim();
    if (!text || busy) return;
    busy = true; sendBtn.disabled = true; inputEl.value = '';
    state[mode].push({ role: 'user', content: text }); store(mode); render();
    listEl.append(el('div', { class: 'gm assistant', textContent: '思考中…' })); listEl.scrollTop = listEl.scrollHeight;
    const current = mode;
    try {
      const r = await api('/api/guide/chat', { method: 'POST', body: JSON.stringify({ mode: current, messages: history() }) });
      state[current].push({ role: 'assistant', content: r.text || (r.files?.length ? '已生成文件' : '（没有内容）'), text: r.text, options: r.options, actions: r.actions, files: r.files });
    } catch (e) { state[current].push({ role: 'assistant', content: '', text: e.message, error: true }); }
    store(current); busy = false; sendBtn.disabled = false; if (mode === current) render();
  }
  function build() {
    const tabHelp = el('button', { type: 'button', textContent: '使用向导', class: 'on', on: { click: () => setMode('help') } });
    const tabTask = el('button', { type: 'button', textContent: '任务引导', on: { click: () => setMode('task') } });
    const setMode = m => { mode = m; tabHelp.classList.toggle('on', m === 'help'); tabTask.classList.toggle('on', m === 'task'); inputEl.placeholder = m === 'help' ? '问我任何关于 Yumeiro 的问题…' : '说说你想做什么…'; render(); };
    listEl = el('div', { class: 'gl' });
    inputEl = el('textarea', { placeholder: '问我任何关于 Yumeiro 的问题…', rows: 2, maxLength: 4000 });
    sendBtn = el('button', { type: 'submit', textContent: '发送' });
    inputEl.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(inputEl.value); } });
    const form = el('form', { on: { submit: e => { e.preventDefault(); ask(inputEl.value); } } }, inputEl, sendBtn);
    const clear = el('button', { type: 'button', textContent: '清空', title: '清空当前模式的对话', on: { click: async () => { if (state[mode].length && !await ymConfirm('清空当前对话？')) return; state[mode] = []; store(mode); render(); } } });
    drawer = el('aside', { class: 'ym-guide', hidden: true, role: 'dialog', 'aria-label': 'AI 指引' },
      el('header', {}, tabHelp, tabTask, el('span', { class: 'grow' }), clear, el('button', { type: 'button', textContent: '✕', 'aria-label': '关闭', on: { click: () => { drawer.hidden = true; } } })),
      listEl, el('div', { class: 'gnote', textContent: 'AI 的建议可能有误；涉及密钥只在对应设置页填写，不要发给我。' }), form);
    document.body.append(drawer);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && drawer && !drawer.hidden) drawer.hidden = true; });
  }
  // 同一时间只允许一个 boot 在等接口，避免定时器重复进入、把按钮插入多次
  let booting = null;
  function boot() { return booting || (booting = bootOnce().finally(() => { booting = null; })); }
  async function bootOnce() {
    try { const session = await api('/api/auth/session'); if (!session.authenticated) return false; csrf = session.csrfToken || ''; } catch { return false; }
    const anchor = document.getElementById('speakButton') || document.getElementById('drawButton') || document.getElementById('historyButton') || document.getElementById('memoryButton') || document.getElementById('settings');
    if (!anchor) return false;
    if (document.getElementById('guideButton')) return true;
    state.help = load('help'); state.task = load('task');
    anchor.before(el('button', { class: 'icon-button', id: 'guideButton', type: 'button', title: 'AI 指引（使用向导 / 任务引导）', 'aria-label': 'AI 指引', textContent: '🧭', on: { click: () => { if (!drawer) build(); drawer.hidden = !drawer.hidden; if (!drawer.hidden) { render(); inputEl.focus(); } } } }));
    return true;
  }
  let tries = 0;
  const timer = setInterval(async () => { if (await boot() || ++tries > 200) clearInterval(timer); }, 1500);
  setTimeout(() => boot().then(ok => { if (ok) clearInterval(timer); }), 1200);
})();
