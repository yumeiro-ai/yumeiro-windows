// 侧边栏（类似 Chrome 的侧边栏）：一个可拖宽的右侧面板，把常用的东西放在一起——
//   🌐 浏览（多标签的内嵌浏览器 + 书签）  ✅ 待办（优先级 / 截止日期 / 分组与 #标签 / 子任务 / 拖动排序 / 筛选）  📝 便签（多张、搜索、固定）
//   ⏱ 专注（番茄钟）  🧮 计算（算式 + 单位换算）  📌 片段（常用语 / 提示词）
// 便签、待办、片段先存本机，登录后自动和服务器同步（按条目合并，多台设备各改各的不会互相覆盖）；AI 可以把便签 / 最近的对话整理成待办候选，由你确认后才加入。
// Ctrl+Shift+B 开关。桌宠会参与：待办到点提醒、专注结束提示、完成待办夸你。
(() => {
  const KEY = 'yumeiro.side';
  const el = (tag, props = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) { if (k === 'on') for (const [e, f] of Object.entries(v)) node.addEventListener(e, f); else if (k === 'style') node.style.cssText = v; else if (k in node) node[k] = v; else node.setAttribute(k, v); }
    node.append(...kids.flat().filter(x => x != null && x !== false));
    return node;
  };
  const defaults = {
    open: false, w: 400, tab: 'web', notes: [], noteId: '', todos: [], snippets: [], del: {}, u: 0,
    sessions: [], calMonth: '', calDay: '', habits: [], checks: [],
    tabs: [{ url: '', title: '新标签页' }], active: 0, marks: [],
    focus: { work: 25, rest: 5, phase: 'idle', endAt: 0, done: 0, day: '', todo: '', review: null },
    ui: { status: 'all', group: '', sort: 'manual', q: '', nq: '', statsRange: 14, statsHabit: '' }
  };
  let state = defaults;
  try { state = { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { /* 用默认值 */ }
  state.focus = { ...defaults.focus, ...(state.focus || {}) };
  state.ui = { ...defaults.ui, ...(state.ui || {}) };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* 存储满了就算了 */ } };
  const T = () => window.YumeiroTools;
  const emit = (name, detail) => { try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch { /* 忽略 */ } };
  const uid = () => Math.random().toString(36).slice(2, 11);
  const now = () => Date.now();
  const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const insertToChat = text => {
    const prompt = document.getElementById('prompt'); if (!prompt) return false;
    prompt.value = (prompt.value ? prompt.value.replace(/\s*$/, '\n') : '') + text; prompt.dispatchEvent(new Event('input', { bubbles: true })); prompt.focus(); return true;
  };
  const copy = async text => { try { await navigator.clipboard.writeText(text); return true; } catch { return false; } };

  // ---- 旧版数据迁移 / 补全字段 ----
  function normalize() {
    if (typeof state.note === 'string') { if (state.note.trim() && !state.notes.length) state.notes.push({ id: uid(), title: '', body: state.note, pin: false, at: now(), u: now() }); delete state.note; }
    state.notes = (state.notes || []).filter(n => n && n.id).map(n => ({ title: '', body: '', pin: false, at: n.u || now(), u: n.u || now(), ...n }));
    state.todos = (state.todos || []).filter(t => t && t.t).map((t, i) => ({ id: t.id || uid(), done: false, pri: 0, due: '', remind: '', asked: false, group: '', tags: [], sub: [], at: now(), u: t.at || now(), ...t, o: typeof t.o === 'number' ? t.o : -(t.at || now()) / 1000 + i * 1e-6 }));
    state.snippets = (state.snippets || []).filter(s => s && s.t).map(s => ({ id: s.id || uid(), u: now(), ...s }));
    state.sessions = (state.sessions || []).filter(s => s && s.id && s.day && s.min > 0 && now() - (s.at || s.u || now()) < 90 * 864e5).slice(0, 1000);
    state.habits = (state.habits || []).filter(h => h && h.id && h.name).map((h, i) => ({ icon: '', pom: 0, remind: '', at: now(), u: now(), o: i * 10, ...h, days: Array.from({ length: 7 }, (_, k) => Array.isArray(h.days) ? h.days[k] !== false : true) }));
    const alive = new Set(state.habits.map(h => h.id)), cutoff = T() ? T().ymd(new Date(Date.now() - 400 * 864e5)) : '';
    state.checks = (state.checks || []).filter(c => c && c.id && alive.has(c.h) && c.day >= cutoff).slice(0, 5000);
    state.del = state.del && typeof state.del === 'object' ? state.del : {};
  }
  normalize(); save();
  const touch = item => { item.u = now(); state.u = item.u; save(); scheduleSync(); };
  const removeItem = (col, item) => { state[col] = state[col].filter(x => x !== item); state.del[item.id] = now(); state.u = now(); save(); scheduleSync(); };

  // ---- 同步（登录后自动；多台设备按条目合并）----
  let syncTimer = 0, syncing = false, syncMsg = '尚未同步（仅保存在本机）', csrfToken = '';
  const pack = () => ({ notes: state.notes, todos: state.todos, snippets: state.snippets, sessions: state.sessions, habits: state.habits, checks: state.checks, del: state.del, u: state.u });
  const editing = () => panel && panel.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  async function getCsrf() {
    if (csrfToken) return csrfToken;
    const s = await (await fetch('/api/auth/session', { credentials: 'same-origin' })).json();
    if (!s.authenticated) throw new Error('未登录');
    return (csrfToken = s.csrfToken || '');
  }
  function scheduleSync() { clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, 3000); }
  function paintSync() { const n = document.getElementById('sdSync'); if (n) n.textContent = syncMsg; }
  async function syncNow() {
    if (syncing) { scheduleSync(); return; }
    syncing = true;
    try {
      const csrf = await getCsrf();
      const r = await fetch('/api/side', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ data: pack() }) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const merged = T().mergeSide(pack(), (await r.json()).data);
      Object.assign(state, { notes: merged.notes, todos: merged.todos, snippets: merged.snippets, sessions: merged.sessions, habits: merged.habits, checks: merged.checks, del: merged.del, u: merged.u });
      normalize(); save();
      const d = new Date(); syncMsg = '已同步 ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      announceTodos(); if (state.open && !editing()) render();
    } catch (e) { syncMsg = e.message === '未登录' ? '未登录：仅保存在本机' : '同步失败（' + e.message + '），稍后重试'; csrfToken = ''; }
    syncing = false; paintSync();
  }

  const style = el('style', {}, `
    #ymSide{position:fixed;top:0;right:0;bottom:0;z-index:55;width:var(--side-w,400px);max-width:100vw;display:none;flex-direction:column;background:var(--ym-card,#fff);color:var(--ink,#222);border-left:1px solid var(--line,#e3e3ea);box-shadow:-6px 0 24px #0001;font-size:13px}
    body.side-open #ymSide{display:flex}body.side-open{padding-right:var(--side-w,400px);box-sizing:border-box}
    @media(max-width:760px){body.side-open{padding-right:0}#ymSide{width:100vw!important}}
    #ymSide .sd-grip{position:absolute;left:-4px;top:0;bottom:0;width:8px;cursor:col-resize}#ymSide .sd-grip:hover{background:var(--accent-soft,#ede7ff)}
    #ymSide .sd-tabs{display:flex;gap:2px;padding:6px 8px 0;border-bottom:1px solid var(--line,#e3e3ea);align-items:flex-end;flex-wrap:wrap}
    #ymSide .sd-tab{border:0;background:transparent;color:var(--muted,#666);padding:6px 9px;border-radius:9px 9px 0 0;cursor:pointer;font:inherit}#ymSide .sd-tab.on{background:var(--accent-soft,#ede7ff);color:var(--accent,#7955c7);font-weight:650}
    #ymSide .sd-x{margin-left:auto;border:0;background:transparent;font-size:18px;cursor:pointer;color:var(--muted,#666);padding:4px 8px}
    #ymSide .sd-body{flex:1;overflow:auto;padding:10px 12px;display:flex;flex-direction:column;gap:8px;min-height:0}
    #ymSide .sd-foot{display:flex;align-items:center;gap:8px;padding:6px 12px;border-top:1px solid var(--line,#e3e3ea);color:var(--muted,#777);font-size:12px}#ymSide .sd-foot span{flex:1}
    #ymSide input,#ymSide textarea,#ymSide select{font:inherit;border:1px solid var(--line,#ddd);border-radius:8px;padding:6px 8px;background:transparent;color:inherit;min-width:0}
    #ymSide textarea{resize:vertical;min-height:140px}
    #ymSide button.sd-b{border:1px solid var(--line,#ddd);background:transparent;color:inherit;border-radius:8px;padding:4px 9px;cursor:pointer;font:inherit}#ymSide button.sd-b:hover{border-color:var(--accent,#7955c7);color:var(--accent,#7955c7)}
    #ymSide button.sd-p{border:0;background:var(--accent,#7955c7);color:#fff;border-radius:8px;padding:6px 12px;cursor:pointer;font:inherit}#ymSide button:disabled{opacity:.5;cursor:default}
    #ymSide .sd-row{display:flex;gap:6px;align-items:center}#ymSide .sd-row>input,#ymSide .sd-row>select{flex:1}#ymSide .sd-wrap{flex-wrap:wrap}#ymSide .sd-muted{color:var(--muted,#777);font-size:12px}
    #ymSide .sd-item{display:flex;gap:8px;align-items:center;padding:5px 2px;border-bottom:1px dashed var(--line,#e3e3ea)}#ymSide .sd-item span{flex:1;word-break:break-all}#ymSide .sd-item.done span{text-decoration:line-through;color:var(--muted,#999)}
    #ymSide .sd-note{cursor:pointer;padding:5px 6px;border-radius:8px;border:1px solid transparent}#ymSide .sd-note.on{background:var(--accent-soft,#ede7ff);border-color:var(--accent,#7955c7)}#ymSide .sd-note small{display:block;color:var(--muted,#888);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #ymSide .sd-todo{border-bottom:1px dashed var(--line,#e3e3ea);padding:5px 2px}#ymSide .sd-todo.over{outline:2px dashed var(--accent,#7955c7)}#ymSide .sd-todo.done .sd-tt{text-decoration:line-through;color:var(--muted,#999)}
    #ymSide .sd-trow{display:flex;gap:6px;align-items:flex-start}#ymSide .sd-tmain{flex:1;min-width:0}#ymSide .sd-tt{word-break:break-all}
    #ymSide .sd-chip{display:inline-block;padding:0 6px;margin:2px 4px 0 0;border-radius:99px;background:var(--accent-soft,#ede7ff);color:var(--accent,#7955c7);font-size:11px}#ymSide .sd-chip.red{background:#fee2e2;color:#b91c1c}
    #ymSide .sd-dot{width:10px;height:10px;border-radius:50%;margin-top:4px;cursor:pointer;flex-shrink:0;border:0;padding:0}#ymSide .sd-grab{cursor:grab;color:var(--muted,#999);user-select:none}
    #ymSide .sd-sub{margin:4px 0 2px 26px;display:flex;flex-direction:column;gap:3px}
    #ymSide .sd-ai{border:1px solid var(--accent,#7955c7);border-radius:10px;padding:8px;background:var(--accent-soft,#f6f2ff)}
    #ymSide .sd-cal{display:grid;grid-template-columns:repeat(7,1fr);gap:2px}#ymSide .sd-cal b{text-align:center;color:var(--muted,#888);font-weight:500;font-size:12px}
    #ymSide .sd-cell{border:1px solid transparent;border-radius:8px;background:transparent;color:inherit;padding:3px 0;min-height:44px;cursor:pointer;font:inherit;display:flex;flex-direction:column;align-items:center;gap:1px}#ymSide .sd-cell.out{opacity:.38}#ymSide .sd-cell.today{border-color:var(--accent,#7955c7)}#ymSide .sd-cell.sel{background:var(--accent-soft,#ede7ff)}#ymSide .sd-cell small{font-size:10px;line-height:1.2}
    #ymSide .sd-banner{border:1px solid var(--accent,#7955c7);border-radius:10px;padding:8px;background:var(--accent-soft,#f6f2ff)}
    #ymSide .sd-btabs{display:flex;gap:3px;overflow-x:auto;flex-shrink:0}#ymSide .sd-btab{display:flex;align-items:center;gap:4px;max-width:130px;padding:3px 6px;border:1px solid var(--line,#ddd);border-radius:8px;cursor:pointer;white-space:nowrap}#ymSide .sd-btab.on{background:var(--accent-soft,#ede7ff)}#ymSide .sd-btab span{overflow:hidden;text-overflow:ellipsis}
    #ymSide iframe{flex:1;min-height:260px;width:100%;border:1px solid var(--line,#ddd);border-radius:8px;background:#fff}
    #ymSide .sd-clock{font-size:42px;font-weight:700;text-align:center;font-variant-numeric:tabular-nums;margin:8px 0}
    #ymSide .sd-marks{display:flex;gap:6px;flex-wrap:wrap}
    #ymSide .sd-habit{border:1px solid var(--line,#e3e3ea);border-radius:12px;padding:8px;display:flex;flex-direction:column;gap:6px}#ymSide .sd-hrow{display:flex;gap:8px;align-items:center}
    #ymSide .sd-ck{width:34px;height:34px;border-radius:50%;border:2px solid var(--accent,#7955c7);background:transparent;color:#fff;font-size:18px;cursor:pointer;flex-shrink:0;padding:0}#ymSide .sd-ck.on{background:var(--accent,#7955c7)}
    #ymSide .sd-week{display:flex;gap:3px}#ymSide .sd-wd{width:20px;height:20px;border-radius:5px;border:1px solid var(--line,#ddd);font-size:10px;line-height:18px;text-align:center;cursor:pointer;padding:0;background:transparent;color:var(--muted,#888)}#ymSide .sd-wd.on{background:var(--accent,#7955c7);border-color:var(--accent,#7955c7);color:#fff}#ymSide .sd-wd.off{opacity:.35;cursor:default}
    #ymSide .sd-days{display:flex;gap:3px}#ymSide .sd-days button{width:24px;height:24px;border-radius:6px;border:1px solid var(--line,#ddd);background:transparent;color:inherit;cursor:pointer;font-size:11px;padding:0}#ymSide .sd-days button.on{background:var(--accent,#7955c7);color:#fff;border-color:var(--accent,#7955c7)}
    #ymSide .sd-cards{display:grid;grid-template-columns:repeat(2,1fr);gap:6px}#ymSide .sd-card{border:1px solid var(--line,#e3e3ea);border-radius:10px;padding:6px 8px}#ymSide .sd-card b{display:block;font-size:18px}
    #ymSide .sd-heat{display:grid;grid-auto-flow:column;grid-template-rows:repeat(7,12px);gap:2px}#ymSide .sd-heat i{width:12px;height:12px;border-radius:3px;background:var(--line,#e3e3ea)}
    #ymSide .sd-hbar{display:flex;align-items:center;gap:6px}#ymSide .sd-hbar span{flex:0 0 96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#ymSide .sd-hbar div{height:10px;border-radius:5px;background:var(--accent,#7955c7)}`);
  document.head.append(style);

  let panel, body, grip;
  const tabsDef = [['web', '🌐 浏览'], ['todo', '✅ 待办'], ['cal', '📅 日历'], ['habit', '✔ 打卡'], ['stats', '📈 统计'], ['note', '📝 便签'], ['focus', '⏱ 专注'], ['calc', '🧮 计算'], ['snip', '📌 片段']];
  const setWidth = w => { state.w = Math.max(300, Math.min(720, Math.round(w))); document.documentElement.style.setProperty('--side-w', state.w + 'px'); };

  // ---------- AI：把便签 / 对话整理成待办候选（要你确认才加入）----------
  let pendingAi = null, aiBusy = '';
  async function aiExtract(text, label) {
    if (aiBusy) return;
    aiBusy = label; pendingAi = null; render();
    try {
      const csrf = await getCsrf();
      const r = await fetch('/api/side/ai', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ text }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
      pendingAi = { items: (d.items || []).map(item => ({ ...item, on: true })), source: label };
    } catch (e) { pendingAi = { items: [], error: e.message === '未登录' ? '请先登录再使用 AI 整理' : e.message, source: label }; }
    aiBusy = ''; render();
  }
  function aiSection() {
    if (aiBusy) return el('div', { class: 'sd-ai', textContent: '✨ ' + aiBusy + '，AI 正在整理…' });
    if (!pendingAi) return null;
    const box = el('div', { class: 'sd-ai' });
    if (pendingAi.error) box.append(el('div', { textContent: '没整理成功：' + pendingAi.error }));
    else if (!pendingAi.items.length) box.append(el('div', { textContent: '没有从内容里找到需要去做的事。' }));
    else {
      box.append(el('div', { textContent: '✨ 从「' + pendingAi.source + '」整理出 ' + pendingAi.items.length + ' 件待办，勾选要加入的：' }));
      for (const item of pendingAi.items) box.append(el('label', { class: 'sd-item' }, el('input', { type: 'checkbox', checked: item.on, on: { change: e => { item.on = e.target.checked; } } }), el('span', { textContent: item.t + (item.due ? '  📅' + item.due : '') + (item.pri === 2 ? '  🔴' : item.pri === 1 ? '  🟡' : '') })));
    }
    box.append(el('div', { class: 'sd-row' },
      pendingAi.items.length && !pendingAi.error ? el('button', { class: 'sd-p', textContent: '加入待办', on: { click: () => {
        const picked = pendingAi.items.filter(i => i.on); let o = Math.min(0, ...state.todos.map(t => t.o)) - 10;
        for (const i of picked) { state.todos.push({ id: uid(), t: i.t, done: false, pri: i.pri || 0, due: i.due || '', remind: '', asked: false, group: '', tags: [], sub: [], o: (o -= 10), at: now(), u: now() }); }
        state.u = now(); save(); scheduleSync(); announceTodos(); pendingAi = null; state.tab = 'todo'; save(); render();
      } } }) : null,
      el('button', { class: 'sd-b', textContent: '关闭', on: { click: () => { pendingAi = null; render(); } } })));
    return box;
  }
  const recentChat = () => [...document.querySelectorAll('#messages .message')].slice(-12).map(n => (n.classList.contains('user') ? '用户：' : '助手：') + (n.querySelector('.bubble')?.textContent || '').trim().slice(0, 600)).join('\n');

  // ---------- 浏览 ----------
  const hist = []; let histAt = -1, frame = null, addr = null, hintEl = null, tabsEl = null;
  function go(raw, push = true) {
    const url = T()?.toUrl(raw); const tab = state.tabs[state.active];
    if (!url) { hintEl.textContent = '只能打开 http / https 网址，或输入关键词搜索'; return; }
    hintEl.textContent = '正在加载…有些网站不允许被内嵌（会显示空白或拒绝连接），可点 ↗ 用系统浏览器打开';
    tab.url = url; try { tab.title = new URL(url).hostname.replace(/^www\./, ''); } catch { tab.title = '网页'; }
    if (push) { hist.splice(histAt + 1); hist.push(url); histAt = hist.length - 1; }
    save(); renderTabs(); if (addr) addr.value = url; if (frame) frame.src = url;
  }
  function renderTabs() {
    if (!tabsEl) return;
    tabsEl.replaceChildren(...state.tabs.map((t, i) => el('div', { class: 'sd-btab' + (i === state.active ? ' on' : ''), title: t.url || '新标签页', on: { click: () => { state.active = i; save(); render(); } } },
      el('span', { textContent: t.title || '新标签页' }),
      state.tabs.length > 1 ? el('b', { textContent: '×', title: '关闭', on: { click: e => { e.stopPropagation(); state.tabs.splice(i, 1); state.active = Math.min(state.active, state.tabs.length - 1); save(); render(); } } }) : null)),
      el('button', { class: 'sd-b', textContent: '＋', title: '新标签页', on: { click: () => { if (state.tabs.length >= 6) return; state.tabs.push({ url: '', title: '新标签页' }); state.active = state.tabs.length - 1; save(); render(); } } }));
  }
  function viewWeb() {
    const tab = state.tabs[state.active] || state.tabs[0];
    tabsEl = el('div', { class: 'sd-btabs' }); renderTabs();
    addr = el('input', { type: 'text', placeholder: '输入网址或搜索词，回车打开', value: tab.url || '', 'aria-label': '地址栏' });
    addr.addEventListener('keydown', e => { if (e.key === 'Enter') go(addr.value); });
    hintEl = el('div', { class: 'sd-muted', textContent: '内嵌浏览器：和对话并排看网页、查资料。' });
    frame = el('iframe', { title: '内嵌浏览器', referrerPolicy: 'no-referrer' });
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads');
    if (tab.url) frame.src = tab.url;
    frame.addEventListener('load', () => { if (tab.url) hintEl.textContent = '已加载。若是空白或提示拒绝连接，该网站不允许被内嵌，可点 ↗ 用系统浏览器打开。'; });
    const nav = d => { const next = histAt + d; if (next >= 0 && next < hist.length) { histAt = next; go(hist[histAt], false); } };
    const marks = el('div', { class: 'sd-marks' }, [...[['必应', 'https://www.bing.com'], ['维基百科', 'https://zh.wikipedia.org'], ['GitHub', 'https://github.com'], ['MDN', 'https://developer.mozilla.org/zh-CN/']].map(([n, u]) => el('button', { class: 'sd-b', textContent: n, on: { click: () => go(u) } })),
      ...state.marks.map(m => el('button', { class: 'sd-b', textContent: '★ ' + m.t, title: m.url + '（右键删除）', on: { click: () => go(m.url), contextmenu: e => { e.preventDefault(); state.marks = state.marks.filter(x => x.url !== m.url); save(); render(); } } }))]);
    return [tabsEl,
      el('div', { class: 'sd-row' }, el('button', { class: 'sd-b', textContent: '◀', title: '后退', on: { click: () => nav(-1) } }), el('button', { class: 'sd-b', textContent: '▶', title: '前进', on: { click: () => nav(1) } }),
        el('button', { class: 'sd-b', textContent: '⟳', title: '刷新', on: { click: () => { if (frame.src) frame.src = frame.src; } } }), addr,
        el('button', { class: 'sd-b', textContent: '★', title: '收藏当前页', on: { click: () => { if (tab.url && !state.marks.some(m => m.url === tab.url)) { state.marks.push({ url: tab.url, t: tab.title || tab.url }); save(); render(); } } } }),
        el('button', { class: 'sd-b', textContent: '↗', title: '用系统浏览器打开', on: { click: () => { if (tab.url) window.open(tab.url, '_blank', 'noopener'); } } }),
        el('button', { class: 'sd-b', textContent: '📎', title: '把链接放进输入框', on: { click: () => { if (tab.url) insertToChat(tab.url); } } })),
      marks, hintEl, frame];
  }

  // ---------- 待办 ----------
  const expanded = new Set();
  const PRI_COLOR = ['#9ca3af', '#f59e0b', '#ef4444'], PRI_NAME = ['低', '中', '高'];
  function announceTodos() {
    const open = T().sortTodos(state.todos.filter(t => !t.done), 'pri');
    emit('yumeiro:todos', { open: open.length, first: (open[0]?.t || '').slice(0, 20), overdue: open.filter(t => T().overdue(t, today())).length });
  }
  function checkReminders() {
    const d = new Date(), hhmm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'), day = today();
    let changed = false;
    for (const t of state.todos) {
      if (t.done || !t.remind || t.asked || t.remind > hhmm) continue;
      const dayOk = t.due ? t.due <= day : now() - t.at < 36 * 3600e3;                 // 有截止日期：当天或之后到点提醒；没有：只提醒 36 小时内新建的
      if (!dayOk) continue;
      t.asked = true; t.u = now(); changed = true; emit('yumeiro:todo-due', { title: t.t.slice(0, 30) });
    }
    for (const h of state.habits) {                                                  // 习惯的提醒：到点且今天该打卡还没打
      if (!h.remind || h.remind > hhmm || !T().scheduled(h.days, day)) continue;
      const key = h.id + day; if (habitAsked.has(key) || habitDoneNow(h)) continue;
      habitAsked.add(key); emit('yumeiro:todo-due', { title: '打卡：' + h.name.slice(0, 20) });
    }
    if (changed) { save(); scheduleSync(); }
  }
  function viewTodo() {
    const day = today(), ui = state.ui;
    const input = el('input', { type: 'text', placeholder: '添加待办，可带 #标签，回车保存', maxLength: 140 });
    const pri = el('select', { title: '优先级' }, [['0', '⚪ 低'], ['1', '🟡 中'], ['2', '🔴 高']].map(([v, l]) => el('option', { value: v, textContent: l })));
    const due = el('input', { type: 'date', title: '截止日期（可选）' }), when = el('input', { type: 'time', title: '提醒时间（可选；有截止日期时，在当天到点提醒）' });
    const group = el('input', { type: 'text', placeholder: '分组', maxLength: 20, style: 'width:80px' });
    group.setAttribute('list', 'sdGroups');
    const groups = [...new Set(state.todos.map(t => t.group).filter(Boolean))];
    const add = () => {
      const parsed = T().parseTodoText(input.value); if (!parsed.t) return;
      state.todos.push({ id: uid(), t: parsed.t.slice(0, 200), done: false, pri: Number(pri.value), due: due.value, remind: when.value, asked: false, group: group.value.trim().slice(0, 24), tags: parsed.tags, sub: [], o: Math.min(0, ...state.todos.map(t => t.o)) - 10, at: now(), u: now() });
      state.u = now(); input.value = ''; save(); scheduleSync(); announceTodos(); render();
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
    const sel = (key, options) => el('select', { title: key, on: { change: e => { ui[key] = e.target.value; save(); render(); } } }, options.map(([v, l]) => el('option', { value: v, textContent: l, selected: ui[key] === v })));
    const q = el('input', { type: 'search', placeholder: '搜索待办 / 标签 / 子任务', value: ui.q, on: { input: e => { ui.q = e.target.value; save(); } } });
    q.addEventListener('keydown', e => { if (e.key === 'Enter') render(); }); q.addEventListener('change', render);
    const shown = T().sortTodos(T().filterTodos(state.todos, ui, day), ui.sort);
    const open = state.todos.filter(t => !t.done), late = open.filter(t => T().overdue(t, day)).length;
    const canDrag = ui.sort === 'manual' && ui.status === 'all' && !ui.q && !ui.group;
    const reorder = (fromId, toId) => {
      if (fromId === toId) return;
      const order = T().sortTodos(state.todos, 'manual'), from = order.findIndex(t => t.id === fromId), to = order.findIndex(t => t.id === toId);
      if (from < 0 || to < 0) return;
      const [moved] = order.splice(from, 1); order.splice(to, 0, moved);
      order.forEach((t, i) => { const o = i * 10; if (t.o !== o) { t.o = o; touch(t); } });
      render();
    };
    const editTitle = (item, span) => {
      const box = el('input', { type: 'text', value: item.t + item.tags.map(t => ' #' + t).join(''), style: 'width:100%' });
      const done = ok => { if (ok) { const p = T().parseTodoText(box.value); if (p.t) { item.t = p.t.slice(0, 200); item.tags = p.tags; touch(item); announceTodos(); } } render(); };
      box.addEventListener('keydown', e => { if (e.key === 'Enter') done(true); else if (e.key === 'Escape') done(false); });
      box.addEventListener('blur', () => done(true));
      span.replaceWith(box); box.focus(); box.select();
    };
    const row = item => {
      const late1 = T().overdue(item, day), subDone = item.sub.filter(s => s.done).length;
      const main = el('div', { class: 'sd-tmain' }, el('span', { class: 'sd-tt', textContent: item.t, title: '双击修改', on: { dblclick: e => editTitle(item, e.target) } }),
        el('div', {}, item.due ? el('span', { class: 'sd-chip' + (late1 ? ' red' : ''), textContent: (late1 ? '已逾期 ' : '📅 ') + item.due.slice(5), title: '点击修改截止日期', style: 'cursor:pointer', on: { click: async () => { const v = await ymPrompt('截止日期（YYYY-MM-DD，留空清除）', item.due); if (v === null) return; if (v === '' || /^\d{4}-\d{2}-\d{2}$/.test(v)) { item.due = v; item.asked = false; touch(item); render(); } } } }) : null,
          item.remind ? el('span', { class: 'sd-chip', textContent: '⏰ ' + item.remind }) : null, item.group ? el('span', { class: 'sd-chip', textContent: '📁 ' + item.group }) : null,
          ...item.tags.map(tag => el('span', { class: 'sd-chip', textContent: '#' + tag, style: 'cursor:pointer', on: { click: () => { ui.q = tag; save(); render(); } } })),
          item.sub.length ? el('span', { class: 'sd-chip', textContent: '☑ ' + subDone + '/' + item.sub.length }) : null,
          pomCount(item.id) ? el('span', { class: 'sd-chip', textContent: '🍅 ' + pomCount(item.id), title: '为这件事完成的番茄数' }) : null));
      const head = el('div', { class: 'sd-trow' },
        canDrag ? el('span', { class: 'sd-grab', textContent: '⠿', title: '拖动排序' }) : null,
        el('input', { type: 'checkbox', checked: item.done, on: { change: e => { toggleTodo(item, e.target.checked); render(); } } }),
        el('button', { class: 'sd-dot', style: 'background:' + PRI_COLOR[item.pri || 0], title: '优先级：' + PRI_NAME[item.pri || 0] + '（点击切换）', on: { click: () => { item.pri = ((item.pri || 0) + 1) % 3; touch(item); render(); } } }),
        main,
        el('button', { class: 'sd-b', textContent: expanded.has(item.id) ? '▾' : '▸', title: '子任务', on: { click: () => { if (expanded.has(item.id)) expanded.delete(item.id); else expanded.add(item.id); render(); } } }),
        item.done ? null : el('button', { class: 'sd-b', textContent: '▶', title: '为这件事开始一个番茄钟', on: { click: () => startFocus(item.id) } }),
        el('button', { class: 'sd-b', textContent: '→聊', title: '放进输入框，和她商量', on: { click: () => insertToChat(item.t) } }),
        el('button', { class: 'sd-b', textContent: '×', title: '删除', on: { click: () => { removeItem('todos', item); announceTodos(); render(); } } }));
      const wrap = el('div', { class: 'sd-todo' + (item.done ? ' done' : ''), 'data-id': item.id }, head);
      if (canDrag) {
        wrap.draggable = true;
        wrap.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', item.id); e.dataTransfer.effectAllowed = 'move'; });
        wrap.addEventListener('dragover', e => { e.preventDefault(); wrap.classList.add('over'); });
        wrap.addEventListener('dragleave', () => wrap.classList.remove('over'));
        wrap.addEventListener('drop', e => { e.preventDefault(); wrap.classList.remove('over'); reorder(e.dataTransfer.getData('text/plain'), item.id); });
      }
      if (expanded.has(item.id)) {
        const subIn = el('input', { type: 'text', placeholder: '添加子任务，回车', maxLength: 100 });
        subIn.addEventListener('keydown', e => { if (e.key === 'Enter' && subIn.value.trim() && item.sub.length < 30) { item.sub.push({ id: uid(), t: subIn.value.trim().slice(0, 100), done: false }); touch(item); render(); } });
        wrap.append(el('div', { class: 'sd-sub' }, ...item.sub.map(s => el('div', { class: 'sd-row' },
          el('input', { type: 'checkbox', checked: s.done, on: { change: e => { s.done = e.target.checked; touch(item); render(); } } }),
          el('span', { textContent: s.t, style: 'flex:1;' + (s.done ? 'text-decoration:line-through;color:#999' : '') }),
          el('button', { class: 'sd-b', textContent: '×', on: { click: () => { item.sub = item.sub.filter(x => x !== s); touch(item); render(); } } }))), subIn));
      }
      return wrap;
    };
    return [aiSection(),
      el('div', { class: 'sd-row sd-wrap' }, input, pri, el('button', { class: 'sd-p', textContent: '添加', on: { click: add } })),
      el('div', { class: 'sd-row sd-wrap' }, due, when, group, el('datalist', { id: 'sdGroups' }, groups.map(g => el('option', { value: g })))),
      el('div', { class: 'sd-row sd-wrap' }, sel('status', [['all', '全部'], ['open', '未完成'], ['today', '今天到期'], ['overdue', '已逾期'], ['done', '已完成']]), sel('group', [['', '全部分组'], ...groups.map(g => [g, g])]), sel('sort', [['manual', '手动排序'], ['pri', '按优先级'], ['due', '按截止日期']])),
      q,
      el('div', { class: 'sd-muted', textContent: (open.length ? '还有 ' + open.length + ' 件没做' : state.todos.length ? '全部完成，真棒！' : '还没有待办') + (late ? '，其中 ' + late + ' 件已逾期' : '') + (canDrag && shown.length > 1 ? ' · 可拖动排序' : '') }),
      ...shown.map(row),
      !shown.length && state.todos.length ? el('div', { class: 'sd-muted', textContent: '没有符合筛选条件的待办。' }) : null,
      el('div', { class: 'sd-row sd-wrap' },
        el('button', { class: 'sd-b', textContent: '✨ 从最近对话提取待办', title: '让 AI 读最近的几条对话，列出需要去做的事（你确认后才加入）', disabled: Boolean(aiBusy), on: { click: () => { const text = recentChat(); if (text.length < 8) { pendingAi = { items: [], error: '当前没有可读的对话内容', source: '最近对话' }; render(); } else aiExtract(text, '最近对话'); } } }),
        state.todos.some(t => t.done) ? el('button', { class: 'sd-b', textContent: '清除已完成', on: { click: () => { for (const t of state.todos.filter(x => x.done)) { state.del[t.id] = now(); } state.todos = state.todos.filter(t => !t.done); state.u = now(); save(); scheduleSync(); render(); } } }) : null)];
  }

  // ---------- 便签（多张）----------
  const noteTitle = n => n.title || (n.body.split('\n').find(l => l.trim()) || '').trim().slice(0, 24) || '空白便签';
  function viewNote() {
    const nq = state.ui.nq.trim().toLowerCase();
    const list = [...state.notes].sort((a, b) => (b.pin ? 1 : 0) - (a.pin ? 1 : 0) || b.u - a.u).filter(n => !nq || (n.title + '\n' + n.body).toLowerCase().includes(nq));
    let cur = state.notes.find(n => n.id === state.noteId) || list[0] || null;
    if (cur && !list.includes(cur) && nq) cur = list[0] || null;
    state.noteId = cur ? cur.id : '';
    const search = el('input', { type: 'search', placeholder: '搜索便签', value: state.ui.nq, on: { input: e => { state.ui.nq = e.target.value; save(); }, change: render } });
    search.addEventListener('keydown', e => { if (e.key === 'Enter') render(); });
    const create = () => { if (state.notes.length >= 100) return; const n = { id: uid(), title: '', body: '', pin: false, at: now(), u: now() }; state.notes.unshift(n); state.noteId = n.id; state.ui.nq = ''; state.u = now(); save(); scheduleSync(); render(); setTimeout(() => document.getElementById('sdNoteBody')?.focus(), 30); };
    const out = [aiSection(), el('div', { class: 'sd-row' }, search, el('button', { class: 'sd-p', textContent: '＋ 新便签', on: { click: create } })),
      el('div', { style: 'max-height:150px;overflow:auto;display:flex;flex-direction:column;gap:2px;flex-shrink:0' }, ...list.map(n => el('div', { class: 'sd-note' + (cur && n.id === cur.id ? ' on' : ''), on: { click: () => { state.noteId = n.id; save(); render(); } } },
        el('b', { textContent: (n.pin ? '⭐ ' : '') + noteTitle(n) }), el('small', { textContent: n.body.replace(/\s+/g, ' ').slice(0, 40) })))),
      !list.length ? el('div', { class: 'sd-muted', textContent: state.notes.length ? '没有符合搜索的便签。' : '还没有便签，点「＋ 新便签」开始记。' }) : null];
    if (cur) {
      const title = el('input', { type: 'text', placeholder: '标题（不写就用第一行）', value: cur.title, maxLength: 60, on: { input: e => { cur.title = e.target.value; touch(cur); }, change: render } });
      const count = el('div', { class: 'sd-muted', textContent: cur.body.length + ' 字' });
      const area = el('textarea', { id: 'sdNoteBody', placeholder: '随手记点什么…自动保存', value: cur.body, style: 'min-height:200px' });
      area.addEventListener('input', () => { cur.body = area.value; touch(cur); count.textContent = cur.body.length + ' 字'; });
      area.addEventListener('change', render);
      out.push(title, area, count, el('div', { class: 'sd-row sd-wrap' },
        el('button', { class: 'sd-b', textContent: cur.pin ? '取消固定' : '⭐ 固定', on: { click: () => { cur.pin = !cur.pin; touch(cur); render(); } } }),
        el('button', { class: 'sd-b', textContent: '放进输入框', on: { click: () => insertToChat(cur.body.trim()) } }),
        el('button', { class: 'sd-b', textContent: '复制', on: { click: async e => { e.target.textContent = (await copy(cur.body)) ? '已复制' : '复制失败'; } } }),
        el('button', { class: 'sd-b', textContent: '✨ 整理成待办', title: '让 AI 从这张便签里提取要做的事（你确认后才加入待办）', disabled: Boolean(aiBusy), on: { click: () => { if (cur.body.trim().length < 4) { pendingAi = { items: [], error: '便签内容太少', source: noteTitle(cur) }; render(); } else aiExtract(cur.body, noteTitle(cur)); } } }),
        el('button', { class: 'sd-b', textContent: '删除', on: { click: async () => { if (!cur.body.trim() || await ymConfirm('删除这张便签？', { danger: true, okText: '确定' })) { removeItem('notes', cur); state.noteId = ''; save(); render(); } } } })));
    }
    return out.filter(Boolean);
  }

  // ---------- 专注（番茄钟）----------
  const mmss = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
  function phaseTick() {
    const f = state.focus;
    if (f.day !== today()) { f.day = today(); f.done = 0; }
    if (f.phase !== 'idle' && now() >= f.endAt) {
      if (f.phase === 'work') {
        f.done++; f.phase = 'rest'; f.endAt = now() + f.rest * 60000;
        state.sessions.unshift({ id: uid(), day: today(), at: now(), min: f.work, todo: f.todo || '', u: now() }); state.sessions = state.sessions.slice(0, 1000); state.u = now(); scheduleSync(); applyPomHabits();
        f.review = f.todo && state.todos.some(t => t.id === f.todo && !t.done) ? { todo: f.todo } : null;
        emit('yumeiro:focus', { phase: 'work-end', minutes: f.work, done: f.done, title: titleOf(f.todo).slice(0, 20) });
      }
      else { f.phase = 'idle'; f.endAt = 0; emit('yumeiro:focus', { phase: 'rest-end' }); }
      save(); if (state.open && state.tab === 'focus') render();
    }
    const clock = document.getElementById('sdClock'); if (clock && f.phase !== 'idle') clock.textContent = mmss(f.endAt - now());
  }
  const titleOf = id => (state.todos.find(t => t.id === id) || {}).t || '';
  const pomCount = id => state.sessions.filter(s => s.todo === id).length;
  function toggleTodo(item, on) { item.done = on; item.da = on ? now() : 0; touch(item); announceTodos(); if (on) emit('yumeiro:todo-done', { title: item.t.slice(0, 20) }); }
  // 开始一个番茄钟，可以绑定一件待办（完成后记在这件待办名下，日历上也能看到当天的番茄）
  function startFocus(todoId) {
    const f = state.focus;
    if (f.phase === 'work') { if (todoId) f.todo = todoId; save(); state.tab = 'focus'; render(); return; }
    f.todo = todoId || f.todo || ''; f.review = null; f.phase = 'work'; f.endAt = now() + f.work * 60000; save();
    emit('yumeiro:focus', { phase: 'work-start', minutes: f.work, title: titleOf(f.todo).slice(0, 20) });
    state.tab = 'focus'; save(); if (!state.open) setOpen(true); else render();
  }
  const hhmm = ts => { const d = new Date(ts); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  function viewFocus() {
    const f = state.focus, label = f.phase === 'work' ? '专注中' : f.phase === 'rest' ? '休息中' : '准备开始';
    const num = (key, min, max) => el('input', { type: 'number', min, max, value: f[key], style: 'width:64px', on: { change: e => { f[key] = Math.max(min, Math.min(max, Number(e.target.value) || f[key])); save(); } } });
    const openTodos = T().sortTodos(state.todos.filter(t => !t.done), 'pri');
    if (f.todo && !state.todos.some(t => t.id === f.todo && !t.done)) f.todo = '';
    const pick = el('select', { title: '这一轮专注做哪件事（会记在这件待办名下）', style: 'flex:1', on: { change: e => { f.todo = e.target.value; save(); } } },
      el('option', { value: '', textContent: '不指定任务' }), ...openTodos.map(t => el('option', { value: t.id, textContent: (t.pri === 2 ? '🔴 ' : t.pri === 1 ? '🟡 ' : '') + t.t.slice(0, 30) + (pomCount(t.id) ? '  🍅' + pomCount(t.id) : ''), selected: f.todo === t.id })));
    const day = today(), mine = state.sessions.filter(s => s.day === day);
    const review = f.review && state.todos.find(t => t.id === f.review.todo && !t.done);
    return [
      review ? el('div', { class: 'sd-banner' }, el('div', { textContent: '🍅 这一轮完成了！「' + review.t.slice(0, 30) + '」做完了吗？' }),
        el('div', { class: 'sd-row', style: 'margin-top:6px' },
          el('button', { class: 'sd-p', textContent: '完成这件待办', on: { click: () => { toggleTodo(review, true); f.review = null; f.todo = ''; save(); render(); } } }),
          el('button', { class: 'sd-b', textContent: '还没，继续', on: { click: () => { f.review = null; save(); render(); } } }))) : null,
      el('div', { class: 'sd-muted', style: 'text-align:center', textContent: label + (f.todo ? ' · ' + titleOf(f.todo).slice(0, 24) : '') }),
      el('div', { class: 'sd-clock', id: 'sdClock', textContent: f.phase === 'idle' ? mmss(f.work * 60000) : mmss(f.endAt - now()) }),
      el('div', { class: 'sd-row' }, el('span', { textContent: '专注于' }), pick),
      el('div', { class: 'sd-row', style: 'justify-content:center' }, f.phase === 'idle'
        ? el('button', { class: 'sd-p', textContent: '开始专注', on: { click: () => startFocus(f.todo) } })
        : el('button', { class: 'sd-b', textContent: '放弃本轮', on: { click: () => { f.phase = 'idle'; f.endAt = 0; save(); render(); } } })),
      el('div', { class: 'sd-row', style: 'justify-content:center' }, el('span', { textContent: '专注' }), num('work', 1, 120), el('span', { textContent: '分钟 · 休息' }), num('rest', 1, 60), el('span', { textContent: '分钟' })),
      el('div', { class: 'sd-muted', style: 'text-align:center', textContent: '今天已完成 ' + mine.length + ' 个番茄 · 共 ' + mine.reduce((n, s) => n + s.min, 0) + ' 分钟 · 计时到点桌宠会提醒你' }),
      ...linkedHabitLines(),
      ...mine.slice(0, 8).map(s => el('div', { class: 'sd-item' }, el('span', { textContent: hhmm(s.at) + ' · ' + s.min + ' 分钟 · ' + (s.todo ? (titleOf(s.todo) || '（已删除的待办）') : '未指定任务') })))
    ];
  }

  // ---------- 日历：看每天的待办和番茄，点日期可以直接加待办 ----------
  const WEEK = ['一', '二', '三', '四', '五', '六', '日'];
  function viewCal() {
    const day = today(), [Y, M] = (state.calMonth || day.slice(0, 7)).split('-').map(Number);
    const sel = state.calDay || day, cells = T().monthGrid(Y, M - 1), stats = T().dayStats(state.todos, state.sessions, day);
    const shift = n => { const d = new Date(Y, M - 1 + n, 1); state.calMonth = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); save(); render(); };
    const head = el('div', { class: 'sd-row' }, el('button', { class: 'sd-b', textContent: '◀', title: '上个月', on: { click: () => shift(-1) } }),
      el('b', { textContent: Y + ' 年 ' + M + ' 月', style: 'flex:1;text-align:center' }),
      el('button', { class: 'sd-b', textContent: '今天', on: { click: () => { state.calMonth = ''; state.calDay = ''; save(); render(); } } }),
      el('button', { class: 'sd-b', textContent: '▶', title: '下个月', on: { click: () => shift(1) } }));
    const grid = el('div', { class: 'sd-cal' }, ...WEEK.map(w => el('b', { textContent: w })), ...cells.map(c => {
      const s = stats[c.date] || {};
      return el('button', { class: 'sd-cell' + (c.inMonth ? '' : ' out') + (c.date === day ? ' today' : '') + (c.date === sel ? ' sel' : ''), title: c.date, on: { click: () => { state.calDay = c.date; if (!c.inMonth) state.calMonth = c.date.slice(0, 7); save(); render(); } } },
        el('span', { textContent: String(c.day) }),
        s.open ? el('small', { textContent: '●' + s.open, style: 'color:' + (s.late ? '#ef4444' : 'var(--accent,#7955c7)') }) : s.done ? el('small', { textContent: '✓' + s.done, style: 'color:#16a34a' }) : null,
        s.pom ? el('small', { textContent: '🍅' + s.pom }) : null);
    }));
    const due = T().sortTodos(state.todos.filter(t => t.due === sel), 'pri'), late = sel === day ? T().sortTodos(state.todos.filter(t => T().overdue(t, day)), 'due') : [];
    const mine = state.sessions.filter(s => s.day === sel), mins = mine.reduce((n, s) => n + s.min, 0);
    const line = item => el('div', { class: 'sd-item' + (item.done ? ' done' : '') },
      el('input', { type: 'checkbox', checked: item.done, on: { change: e => { toggleTodo(item, e.target.checked); render(); } } }),
      el('span', { textContent: item.t + (pomCount(item.id) ? '  🍅' + pomCount(item.id) : '') + (item.due && item.due !== sel ? '  📅' + item.due.slice(5) : '') }),
      item.done ? null : el('button', { class: 'sd-b', textContent: '▶', title: '为这件事开始一个番茄钟', on: { click: () => startFocus(item.id) } }));
    const input = el('input', { type: 'text', placeholder: '给 ' + sel.slice(5) + ' 添加待办，回车', maxLength: 140 });
    input.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const p = T().parseTodoText(input.value); if (!p.t) return;
      state.todos.push({ id: uid(), t: p.t.slice(0, 200), done: false, pri: 0, due: sel, remind: '', asked: false, group: '', tags: p.tags, sub: [], o: Math.min(0, ...state.todos.map(t => t.o)) - 10, at: now(), u: now() });
      state.u = now(); save(); scheduleSync(); announceTodos(); render();
    });
    const when = new Date(sel + 'T00:00:00');
    return [head, grid,
      el('div', { class: 'sd-row' }, el('b', { textContent: (when.getMonth() + 1) + ' 月 ' + when.getDate() + ' 日 周' + '日一二三四五六'[when.getDay()] + (sel === day ? '（今天）' : ''), style: 'flex:1' }),
        el('span', { class: 'sd-muted', textContent: mine.length ? '🍅 ' + mine.length + ' 个 · ' + mins + ' 分钟' : '' })),
      input,
      late.length ? el('div', { class: 'sd-muted', textContent: '已逾期，还没做：' }) : null, ...late.map(line),
      due.length ? el('div', { class: 'sd-muted', textContent: '当天到期：' }) : null, ...due.map(line),
      !due.length && !late.length ? el('div', { class: 'sd-muted', textContent: '这一天没有安排。' }) : null,
      ...mine.slice(0, 6).map(s => el('div', { class: 'sd-item' }, el('span', { textContent: '🍅 ' + hhmm(s.at) + ' · ' + s.min + ' 分钟 · ' + (s.todo ? (titleOf(s.todo) || '（已删除的待办）') : '未指定任务') })))
    ];
  }

  // ---------- 计算 / 换算 ----------
  const calcLog = [];
  function viewCalc() {
    const input = el('input', { type: 'text', placeholder: '算式（如 (12+8)*3%）或换算（如 5km to mi、100 f 转 c）', autofocus: true });
    const out = el('div', { class: 'sd-item', style: 'font-size:16px' });
    const list = el('div');
    const paint = () => list.replaceChildren(...calcLog.slice(0, 8).map(r => el('div', { class: 'sd-item' }, el('span', { textContent: r.q + '  =  ' + r.a }), el('button', { class: 'sd-b', textContent: '放进输入框', on: { click: () => insertToChat(r.a) } }))));
    const run = () => {
      const q = input.value.trim(); if (!q) return;
      let r = T().calc(q), a;
      if (r.ok) a = r.text; else { const c = T().convert(q); if (c.ok) { a = c.text.split(' = ').pop(); r = c; } }
      if (!r.ok) { out.textContent = r.error; return; }
      out.textContent = a; calcLog.unshift({ q, a }); paint();
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
    paint();
    return [el('div', { class: 'sd-row' }, input, el('button', { class: 'sd-p', textContent: '计算', on: { click: run } })), out, list,
      el('div', { class: 'sd-muted', textContent: '支持 + − × ÷ ^ % 括号、sqrt/sin/cos/ln/log/pow/max/min、π；换算支持长度、重量、数据、时间、温度、速度、体积（含 斤、里、英寸 等）。' })];
  }

  // ---------- 片段 ----------
  function viewSnip() {
    const input = el('textarea', { placeholder: '保存常用语 / 提示词，之后一键放进输入框', style: 'min-height:70px' });
    return [input, el('button', { class: 'sd-p', textContent: '保存片段', on: { click: () => { const t = input.value.trim(); if (!t || state.snippets.length >= 100) return; state.snippets.unshift({ id: uid(), t: t.slice(0, 2000), u: now() }); state.u = now(); save(); scheduleSync(); render(); } } }),
      ...state.snippets.map(s => el('div', { class: 'sd-item' }, el('span', { textContent: s.t.length > 80 ? s.t.slice(0, 80) + '…' : s.t, title: s.t }),
        el('button', { class: 'sd-b', textContent: '放进输入框', on: { click: () => insertToChat(s.t) } }),
        el('button', { class: 'sd-b', textContent: '复制', on: { click: async e => { e.target.textContent = (await copy(s.t)) ? '已复制' : '失败'; } } }),
        el('button', { class: 'sd-b', textContent: '×', on: { click: () => { removeItem('snippets', s); render(); } } }))),
      !state.snippets.length ? el('div', { class: 'sd-muted', textContent: '还没有片段。' }) : null];
  }

  // ---------- 习惯打卡（和番茄钟联动：关联了番茄数的习惯，当天番茄够数就自动打卡）----------
  const habitAsked = new Set();
  const checkId = (h, day) => h.id.slice(0, 9) + '_' + day.replace(/-/g, '').slice(2);
  const findCheck = (h, day) => state.checks.find(c => c.id === checkId(h, day));
  const pomOn = day => state.sessions.filter(s => s.day === day).length;
  // 当天是否算已打卡：有打卡记录就以记录为准；没有记录时，关联了番茄且今天番茄够数也算
  const habitDoneOn = (h, day) => { const c = findCheck(h, day); return c ? c.v === 1 : Boolean(day === today() && h.pom > 0 && pomOn(day) >= h.pom); };
  const habitDoneNow = h => habitDoneOn(h, today());
  function setCheck(h, day, on) {
    let c = findCheck(h, day);
    if (c) { c.v = on ? 1 : 0; touch(c); }
    else { c = { id: checkId(h, day), h: h.id, day, v: on ? 1 : 0, u: now() }; state.checks.push(c); touch(c); }
    if (on && day === today()) emit('yumeiro:todo-done', { title: h.name.slice(0, 20) });
  }
  // 一个番茄完成后：把今天番茄够数、又还没有打卡记录的习惯记成已打卡（这样历史不会因为番茄记录只保留 90 天而丢）
  function applyPomHabits() {
    const day = today(), n = pomOn(day);
    for (const h of state.habits) if (h.pom > 0 && n >= h.pom && T().scheduled(h.days, day) && !findCheck(h, day)) setCheck(h, day, true);
  }
  const doneSetOf = h => { const s = T().habitDoneSet(state.checks, h.id); if (habitDoneNow(h)) s.add(today()); else if (findCheck(h, today())) s.delete(today()); return s; };
  function linkedHabitLines() {
    const day = today(), n = pomOn(day), linked = state.habits.filter(h => h.pom > 0 && T().scheduled(h.days, day));
    return linked.map(h => el('div', { class: 'sd-item' }, el('span', { textContent: (h.icon || '🌱') + ' ' + h.name + '：今天 ' + Math.min(n, h.pom) + '/' + h.pom + ' 个番茄' + (habitDoneNow(h) ? ' ✓ 已打卡' : '') })));
  }
  const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0], DAY_NAME = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 0: '日' };
  let newDays = [true, true, true, true, true, true, true];
  function viewHabit() {
    const day = today(), list = [...state.habits].sort((a, b) => (a.o || 0) - (b.o || 0));
    const due = list.filter(h => T().scheduled(h.days, day)), rest = list.filter(h => !T().scheduled(h.days, day)), doneN = due.filter(habitDoneNow).length;
    const name = el('input', { type: 'text', placeholder: '新习惯，如 早起、背单词、运动', maxLength: 30 });
    const icon = el('input', { type: 'text', placeholder: '🌱', maxLength: 4, style: 'width:48px;text-align:center' });
    const pom = el('select', { title: '关联番茄钟：当天完成这么多个番茄就自动打卡' }, el('option', { value: '0', textContent: '不关联番茄' }), ...[1, 2, 3, 4, 6, 8].map(n => el('option', { value: String(n), textContent: '🍅 ≥ ' + n + ' 个自动打卡' })));
    const remind = el('input', { type: 'time', title: '提醒时间（可选；到点还没打卡，桌宠会提醒）' });
    const dayBtns = el('div', { class: 'sd-days' }, DAY_ORDER.map(d => el('button', { type: 'button', class: newDays[d] ? 'on' : '', textContent: DAY_NAME[d], title: '周' + DAY_NAME[d], on: { click: e => { newDays[d] = !newDays[d]; e.target.classList.toggle('on', newDays[d]); } } })));
    const add = () => {
      const n = name.value.trim(); if (!n || state.habits.length >= 50) return;
      state.habits.push({ id: uid(), name: n.slice(0, 30), icon: icon.value.trim().slice(0, 4), pom: Number(pom.value), days: newDays.every(x => !x) ? [true, true, true, true, true, true, true] : [...newDays], remind: remind.value, o: Math.max(-10, ...state.habits.map(h => h.o || 0)) + 10, at: now(), u: now() });
      state.u = now(); newDays = [true, true, true, true, true, true, true]; save(); scheduleSync(); render();
    };
    name.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
    const card = h => {
      const set = doneSetOf(h), streak = T().habitStreak(set, h.days, day), n = pomOn(day), isDone = habitDoneNow(h);
      const week = T().lastDays(7, day).map(d => {
        const sch = T().scheduled(h.days, d), on = set.has(d);
        return el('button', { class: 'sd-wd' + (on ? ' on' : '') + (sch ? '' : ' off'), textContent: DAY_NAME[new Date(d + 'T00:00:00').getDay()], title: d + (sch ? (on ? '（已打卡，点击取消）' : '（点击补打卡）') : '（计划外）'), on: { click: () => { if (!sch) return; setCheck(h, d, !habitDoneOn(h, d)); render(); } } });
      });
      return el('div', { class: 'sd-habit' },
        el('div', { class: 'sd-hrow' },
          el('button', { class: 'sd-ck' + (isDone ? ' on' : ''), textContent: isDone ? '✓' : '', title: isDone ? '今天已打卡（点击取消）' : '打卡', on: { click: () => { setCheck(h, day, !isDone); render(); } } }),
          el('div', { style: 'flex:1;min-width:0' }, el('b', { textContent: (h.icon ? h.icon + ' ' : '') + h.name }),
            el('div', {}, el('span', { class: 'sd-chip', textContent: '🔥 ' + streak.current + ' 天', title: '当前连续（最长 ' + streak.best + ' 天）' }), el('span', { class: 'sd-chip', textContent: '最长 ' + streak.best }),
              h.pom ? el('span', { class: 'sd-chip', textContent: '🍅 ' + Math.min(n, h.pom) + '/' + h.pom, title: '今天的番茄进度，够数自动打卡' }) : null,
              h.remind ? el('span', { class: 'sd-chip', textContent: '⏰ ' + h.remind }) : null)),
          h.pom && !isDone ? el('button', { class: 'sd-b', textContent: '▶', title: '开始一个番茄钟', on: { click: () => startFocus('') } }) : null,
          el('button', { class: 'sd-b', textContent: '✎', title: '修改名称 / 关联番茄数', on: { click: async () => { const nm = await ymPrompt('习惯名称', h.name); if (nm === null) return; const pm = await ymPrompt('每天完成几个番茄自动打卡（0 = 不关联）', String(h.pom || 0)); h.name = (nm.trim() || h.name).slice(0, 30); if (pm !== null && /^\d+$/.test(pm.trim())) h.pom = Math.min(16, Number(pm)); touch(h); render(); } } }),
          el('button', { class: 'sd-b', textContent: '×', title: '删除这个习惯（打卡记录一起删除）', on: { click: async () => { if (await ymConfirm('删除习惯「' + h.name + '」和它的全部打卡记录？', { danger: true, okText: '确定' })) { removeItem('habits', h); state.checks = state.checks.filter(c => c.h !== h.id); save(); render(); } } } })),
        el('div', { class: 'sd-week' }, ...week));
    };
    return [
      el('div', { class: 'sd-muted', textContent: due.length ? '今天 ' + doneN + '/' + due.length + ' 已打卡' + (doneN === due.length ? ' · 全部完成，真棒！' : '') : state.habits.length ? '今天没有计划内的习惯' : '还没有习惯，先建一个吧' }),
      el('div', { class: 'sd-row sd-wrap' }, icon, name, el('button', { class: 'sd-p', textContent: '添加', on: { click: add } })),
      el('div', { class: 'sd-row sd-wrap' }, pom, remind), el('div', { class: 'sd-row' }, el('span', { class: 'sd-muted', textContent: '每周哪几天：' }), dayBtns),
      ...due.map(card),
      rest.length ? el('div', { class: 'sd-muted', textContent: '今天休息（不在计划日）：' }) : null, ...rest.map(card)
    ];
  }

  // ---------- 统计图表：番茄、完成的待办、习惯热力图、时间花在哪 ----------
  const SVGNS = 'http://www.w3.org/2000/svg';
  const svg = (tag, attrs = {}, ...kids) => { const n = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); n.append(...kids.filter(x => x != null)); return n; };
  function barChart(values, labels, color, unit) {
    const W = 340, H = 110, bw = (W - 8) / values.length, max = Math.max(1, ...values), step = Math.ceil(values.length / 7);
    const root = svg('svg', { viewBox: '0 0 ' + W + ' ' + (H + 16), width: '100%', role: 'img' });
    root.append(svg('line', { x1: 4, x2: W - 4, y1: H, y2: H, stroke: 'currentColor', 'stroke-opacity': '.25' }));
    values.forEach((v, i) => {
      const h = Math.round(v / max * (H - 16)), x = 4 + i * bw;
      root.append(svg('rect', { x: x + bw * 0.15, y: H - h, width: bw * 0.7, height: v ? Math.max(h, 2) : 0, rx: 2, fill: color }, svg('title', {}, labels[i] + '：' + v + unit)));
      if (v) root.append(svg('text', { x: x + bw / 2, y: H - h - 3, 'text-anchor': 'middle', 'font-size': 9, fill: 'currentColor' }, String(v)));
      if (i % step === 0 || i === values.length - 1) root.append(svg('text', { x: x + bw / 2, y: H + 12, 'text-anchor': 'middle', 'font-size': 9, fill: 'currentColor', 'fill-opacity': '.6' }, labels[i]));
    });
    return root;
  }
  function viewStats() {
    const day = today(), ui = state.ui, range = [7, 14, 30].includes(ui.statsRange) ? ui.statsRange : 14, days = T().lastDays(range, day), labels = days.map(d => d.slice(5));
    const sess = T().sessionsByDay(state.sessions, days), done = T().doneByDay(state.todos, days), week = T().lastDays(7, day);
    const wkSess = T().sessionsByDay(state.sessions, week), wkPom = wkSess.reduce((n, d) => n + d.pom, 0), wkMin = wkSess.reduce((n, d) => n + d.min, 0), wkDone = T().doneByDay(state.todos, week).reduce((n, v) => n + v, 0);
    const sets = Object.fromEntries(state.habits.map(h => [h.id, doneSetOf(h)]));
    let due = 0, ok = 0; for (const h of state.habits) { const r = T().habitRate(sets[h.id], h.days, week); due += r.due; ok += r.done; }
    const bestNow = Math.max(0, ...state.habits.map(h => T().habitStreak(sets[h.id], h.days, day).current));
    const cards = el('div', { class: 'sd-cards' },
      el('div', { class: 'sd-card' }, el('b', { textContent: '🍅 ' + wkPom }), el('span', { class: 'sd-muted', textContent: '近 7 天番茄 · ' + (wkMin >= 60 ? (wkMin / 60).toFixed(1) + ' 小时' : wkMin + ' 分钟') })),
      el('div', { class: 'sd-card' }, el('b', { textContent: '✅ ' + wkDone }), el('span', { class: 'sd-muted', textContent: '近 7 天完成的待办' })),
      el('div', { class: 'sd-card' }, el('b', { textContent: due ? Math.round(ok / due * 100) + '%' : '—' }), el('span', { class: 'sd-muted', textContent: '近 7 天习惯完成率' })),
      el('div', { class: 'sd-card' }, el('b', { textContent: '🔥 ' + bestNow }), el('span', { class: 'sd-muted', textContent: '最长的当前连续（天）' })));
    const rangeSel = el('select', { title: '统计范围', on: { change: e => { ui.statsRange = Number(e.target.value); save(); render(); } } }, [7, 14, 30].map(n => el('option', { value: n, textContent: '最近 ' + n + ' 天', selected: range === n })));
    // 热力图：最近 12 周，按（所选）习惯的每日完成比例上色；周一在最上面一行
    const habitSel = el('select', { title: '热力图看哪个习惯', on: { change: e => { ui.statsHabit = e.target.value; save(); render(); } } }, el('option', { value: '', textContent: '全部习惯' }), ...state.habits.map(h => el('option', { value: h.id, textContent: (h.icon || '') + ' ' + h.name, selected: ui.statsHabit === h.id })));
    const shown = ui.statsHabit ? state.habits.filter(h => h.id === ui.statsHabit) : state.habits;
    const base = new Date(day + 'T00:00:00'), back = (base.getDay() + 6) % 7 + 11 * 7, heat = el('div', { class: 'sd-heat' });
    for (let i = 0; i < 84; i++) {
      const d = T().ymd(new Date(base.getFullYear(), base.getMonth(), base.getDate() - back + i)), future = d > day, r = T().dayRatio(shown, sets, d);
      heat.append(el('i', { title: d + (future ? '' : r.due ? '：' + r.done + '/' + r.due : '：无计划'), style: future || !r.due ? 'opacity:' + (future ? '.15' : '.5') : 'background:var(--accent,#7955c7);opacity:' + (r.done ? 0.25 + 0.75 * r.ratio : 0.12) }));
    }
    const top = T().topTasks(state.sessions, state.todos, days), topMax = Math.max(1, ...top.map(r => r.min));
    return [
      cards,
      el('div', { class: 'sd-row' }, el('b', { textContent: '番茄专注（分钟）', style: 'flex:1' }), rangeSel),
      barChart(sess.map(d => d.min), labels, 'var(--accent,#7955c7)', ' 分钟'),
      el('b', { textContent: '完成的待办（件）' }), barChart(done, labels, '#16a34a', ' 件'),
      el('div', { class: 'sd-row' }, el('b', { textContent: '习惯热力图（近 12 周）', style: 'flex:1' }), habitSel),
      state.habits.length ? heat : el('div', { class: 'sd-muted', textContent: '先到「✔ 打卡」建几个习惯，这里就会出现热力图。' }),
      el('b', { textContent: '时间花在哪（最近 ' + range + ' 天，按番茄分钟）' }),
      ...(top.length ? top.map(r => el('div', { class: 'sd-hbar' }, el('span', { textContent: r.title, title: r.title }), el('div', { style: 'width:' + Math.max(4, Math.round(r.min / topMax * 160)) + 'px' }), el('small', { textContent: r.min + ' 分钟 · 🍅' + r.pom }))) : [el('div', { class: 'sd-muted', textContent: '这段时间还没有番茄记录。' })]),
      state.habits.length ? el('b', { textContent: '各习惯（最近 ' + range + ' 天）' }) : null,
      ...state.habits.map(h => { const r = T().habitRate(sets[h.id], h.days, days), s = T().habitStreak(sets[h.id], h.days, day); return el('div', { class: 'sd-item' }, el('span', { textContent: (h.icon || '🌱') + ' ' + h.name }), el('small', { textContent: r.done + '/' + r.due + '（' + Math.round(r.rate * 100) + '%）· 连续 ' + s.current + ' · 最长 ' + s.best })); })
    ];
  }

  const views = { web: viewWeb, todo: viewTodo, cal: viewCal, habit: viewHabit, stats: viewStats, note: viewNote, focus: viewFocus, calc: viewCalc, snip: viewSnip };
  function render() {
    if (!panel) return;
    for (const b of panel.querySelectorAll('.sd-tab')) b.classList.toggle('on', b.dataset.tab === state.tab);
    body.replaceChildren(...(views[state.tab] || viewWeb)().filter(Boolean));
  }
  function setOpen(on) {
    state.open = on; save();
    if (!panel) build();
    document.body.classList.toggle('side-open', on); setWidth(state.w);
    if (on) { render(); paintSync(); } else if (frame) { frame.src = 'about:blank'; }
    const b = document.getElementById('sideButton'); if (b) b.setAttribute('aria-pressed', String(on));
  }
  function build() {
    grip = el('div', { class: 'sd-grip', title: '拖动调整宽度' });
    grip.addEventListener('pointerdown', e => {
      e.preventDefault(); grip.setPointerCapture(e.pointerId);
      const move = ev => setWidth(innerWidth - ev.clientX), up = () => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); save(); };
      grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up);
    });
    body = el('div', { class: 'sd-body' });
    panel = el('aside', { id: 'ymSide', 'aria-label': '侧边栏' }, grip,
      el('div', { class: 'sd-tabs' }, tabsDef.map(([key, label]) => el('button', { class: 'sd-tab', type: 'button', textContent: label, 'data-tab': key, on: { click: () => { state.tab = key; save(); render(); } } })), el('button', { class: 'sd-x', type: 'button', textContent: '×', title: '关闭侧边栏（Ctrl+Shift+B）', 'aria-label': '关闭侧边栏', on: { click: () => setOpen(false) } })),
      body,
      el('div', { class: 'sd-foot' }, el('span', { id: 'sdSync', textContent: syncMsg }), el('button', { class: 'sd-b', type: 'button', textContent: '立即同步', title: '便签 / 待办 / 片段和服务器同步（登录后自动进行）', on: { click: syncNow } })));
    document.body.append(panel);
  }
  function boot() {
    const anchor = document.getElementById('guideButton') || document.getElementById('speakButton') || document.getElementById('drawButton') || document.getElementById('historyButton') || document.getElementById('memoryButton');
    if (!anchor || !document.getElementById('prompt')) return false;
    if (document.getElementById('sideButton')) return true;
    anchor.before(el('button', { id: 'sideButton', class: 'icon-button', type: 'button', title: '侧边栏：浏览、待办、便签、专注、计算、片段（Ctrl+Shift+B）', 'aria-label': '侧边栏', textContent: '🧰', on: { click: () => setOpen(!state.open) } }));
    if (state.open) setOpen(true);
    announceTodos(); syncNow();
    return true;
  }
  document.addEventListener('keydown', e => { if (e.ctrlKey && e.shiftKey && (e.key === 'B' || e.key === 'b') && document.getElementById('sideButton')) { e.preventDefault(); setOpen(!state.open); } });
  let tries = 0; const timer = setInterval(() => { if (boot() || ++tries > 200) clearInterval(timer); }, 1200);
  setInterval(phaseTick, 1000); setInterval(checkReminders, 5000);
  setInterval(announceTodos, 30 * 60000); setInterval(syncNow, 5 * 60000);
  window.addEventListener('focus', () => { if (document.getElementById('sideButton')) syncNow(); });
  window.YumeiroSide = { open: tab => { if (tab && views[tab]) { state.tab = tab; save(); } setOpen(true); }, close: () => setOpen(false), toggle: () => setOpen(!state.open), sync: syncNow,
    // 桌宠用：开始 / 停止番茄钟、读取状态（界面仍然在侧边栏的“专注”里）
    focus: {
      status: () => { const f = state.focus; return { phase: f.phase, endAt: f.endAt, work: f.work, rest: f.rest, done: f.done }; },
      start: () => { const f = state.focus; if (f.phase === 'idle') { f.todo = f.todo || ''; f.review = null; f.phase = 'work'; f.endAt = now() + f.work * 60000; save(); emit('yumeiro:focus', { phase: 'work-start', minutes: f.work, title: '' }); if (state.open && state.tab === 'focus') render(); } },
      stop: () => { const f = state.focus; if (f.phase !== 'idle') { f.phase = 'idle'; f.endAt = 0; save(); if (state.open && state.tab === 'focus') render(); } }
    } };
})();
