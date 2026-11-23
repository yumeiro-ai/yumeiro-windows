// 聊天首页（参考 Cindy 的首页）：没有对话时，输入框直接放在页面中央、品牌标识下面，建议做成竖排列表；
// 工作区放进左侧栏（文件夹 + 最近的协作任务），点一下就进入。
(() => {
  const $ = s => document.querySelector(s);
  let hero = false, brand = null, composerWrap = null, main = null;

  // ---------- 1. 首页输入框居中 ----------
  function nameOfUser() { const t = ($('#userEmail')?.textContent || '').trim(); return (t.split('@')[0] || '').trim(); }
  function enterHero(welcome) {
    if (hero) return; hero = true;
    composerWrap = $('.composer-wrap'); main = $('.main'); if (!composerWrap || !main) { hero = false; return; }
    welcome.classList.add('home-hero'); document.body.classList.add('home-hero-on');
    brand = document.createElement('div'); brand.className = 'hero-brand';
    const mark = document.createElement('img'); mark.src = '/mascot.png'; mark.alt = ''; mark.onerror = () => { const m = document.createElement('div'); m.className = 'brand-mark'; m.textContent = 'Y'; mark.replaceWith(m); };
    const word = document.createElement('span'); word.className = 'hero-word'; word.textContent = 'Yumeiro';
    brand.append(mark, word);
    const sug = welcome.querySelector('.suggestions');
    welcome.insertBefore(brand, welcome.firstChild);
    welcome.insertBefore(composerWrap, sug || null);
    const ta = $('#prompt'); if (ta) { ta.dataset.oldPlaceholder = ta.placeholder; const n = nameOfUser(); ta.placeholder = '你好' + (n ? '，' + n : '') + '！今天想一起处理什么？'; }
  }
  function leaveHero() {
    if (!hero) return; hero = false;
    document.body.classList.remove('home-hero-on'); $('#welcome')?.classList.remove('home-hero');
    brand?.remove(); brand = null;
    if (composerWrap && main) main.append(composerWrap);
    const ta = $('#prompt'); if (ta && ta.dataset.oldPlaceholder) ta.placeholder = ta.dataset.oldPlaceholder;
  }
  // 当前页面的选中态：没有对话时“开启新对话”高亮（就是首页）；有对话时左侧对话列表里当前那一条高亮（原有逻辑）
  function syncHero() { const w = $('#welcome'); if (!w || $('#app')?.hidden) return; w.hidden ? leaveHero() : enterHero(w); $('.new')?.classList.toggle('current', !w.hidden); }
  function watchWelcome() {
    const w = $('#welcome'); if (!w) return false;
    new MutationObserver(syncHero).observe(w, { attributes: true, attributeFilter: ['hidden'] });
    new MutationObserver(syncHero).observe($('#app'), { attributes: true, attributeFilter: ['hidden'] });
    syncHero(); return true;
  }

  // ---------- 2. 左侧栏：工作区（文件夹 + 最近任务）----------
  const ago = at => { const m = Math.max(0, Math.round((Date.now() - at) / 60000)); return m < 1 ? '刚刚' : m < 60 ? m + ' 分钟' : m < 1440 ? Math.round(m / 60) + ' 小时' : Math.round(m / 1440) + ' 天'; };
  let box = null, list = null, openIds = new Set(JSON.parse(localStorage.getItem('ym.sbOpen') || '[]'));
  const saveOpen = () => { try { localStorage.setItem('ym.sbOpen', JSON.stringify([...openIds])); } catch { /* 忽略 */ } };
  function mountSidebar() {
    if (box) return true;
    const chatList = $('#chatList'); if (!chatList) return false;
    box = document.createElement('div'); box.className = 'sb-ws';
    const head = document.createElement('div'); head.className = 'sb-ws-head';
    const label = document.createElement('span'); label.className = 'label'; label.textContent = '工作区';
    const add = document.createElement('button'); add.type = 'button'; add.className = 'sb-ws-add'; add.title = '新建工作区'; add.setAttribute('aria-label', '新建工作区'); add.textContent = '＋';
    add.addEventListener('click', () => window.YumeiroWS?.create(() => loadWorkspaces(true)));
    head.append(label, add);
    list = document.createElement('div'); list.className = 'sb-ws-list';
    box.append(head, list);
    chatList.after(box); return true;
  }
  let lastLoad = 0, currentWs = '';
  const markWs = () => document.querySelectorAll('.sb-ws-row').forEach(r => { const on = r.dataset.wsId === currentWs && currentWs !== ''; r.classList.toggle('current', on); r.setAttribute('aria-current', on ? 'page' : 'false'); });
  window.addEventListener('yumeiro:workspace-open', e => { currentWs = (e.detail && e.detail.id) || ''; markWs(); });
  async function loadWorkspaces(force) {
    if ($('#app')?.hidden || !mountSidebar()) return;
    if (force !== true && Date.now() - lastLoad < 15000) return; lastLoad = Date.now();
    let data, chatsByWs = {}; try { const r = await fetch('/api/workspaces', { credentials: 'same-origin' }); if (!r.ok) return; data = await r.json(); } catch { return; }
    try { const r = await fetch('/api/conversations', { credentials: 'same-origin' }); if (r.ok) for (const c of (await r.json()).conversations || []) if (c.workspaceId) (chatsByWs[c.workspaceId] ||= []).push(c); } catch { /* 没有也不影响工作区列表 */ }
    const items = (data.workspaces || []).sort((a, b) => ((b.recent?.[0]?.createdAt) || b.createdAt) - ((a.recent?.[0]?.createdAt) || a.createdAt)).slice(0, 8);
    list.replaceChildren();
    if (!items.length) { const e = document.createElement('button'); e.type = 'button'; e.className = 'sb-ws-empty sb-link'; e.textContent = '＋ 新建一个工作区'; e.addEventListener('click', () => window.YumeiroWS?.create(() => loadWorkspaces(true))); list.append(e); return; }
    for (const w of items) {
      const open = openIds.has(w.id), runs = w.recent || [];
      const row = document.createElement('button'); row.type = 'button'; row.className = 'sb-ws-row' + (open ? ' open' : '');
      const caret = document.createElement('span'); caret.className = 'sb-caret'; caret.textContent = open ? '▾' : '▸';
      const ico = document.createElement('span'); ico.textContent = open ? '📂' : '📁';
      const name = document.createElement('span'); name.className = 'sb-ws-name'; name.textContent = w.name; name.title = w.name;
      const gear = document.createElement('span'); gear.className = 'sb-gear'; gear.title = '工作区设置'; gear.setAttribute('role', 'button'); gear.setAttribute('aria-label', '工作区设置'); gear.textContent = '⚙';
      gear.addEventListener('click', e => { e.stopPropagation(); window.YumeiroWS?.settings(w, () => loadWorkspaces(true)); });
      row.dataset.wsId = w.id; if (currentWs === w.id) row.classList.add('current'); row.setAttribute('aria-current', currentWs === w.id ? 'page' : 'false');
      row.append(caret, ico, name, gear);
      row.addEventListener('click', () => { open ? openIds.delete(w.id) : openIds.add(w.id); saveOpen(); loadWorkspaces(true); });
      row.addEventListener('dblclick', () => window.YumeiroWS?.open(w, data.runner));
      list.append(row);
      if (open) {
        const sub = document.createElement('div'); sub.className = 'sb-runs';
        const enter = document.createElement('button'); enter.type = 'button'; enter.className = 'sb-run sb-enter'; enter.textContent = '打开工作区 ›'; enter.addEventListener('click', () => window.YumeiroWS?.open(w, data.runner));
        sub.append(enter);
        const wsChats = chatsByWs[w.id] || [];
        const newChat = document.createElement('button'); newChat.type = 'button'; newChat.className = 'sb-run sb-enter'; newChat.textContent = '＋ 在这里新建对话';
        newChat.addEventListener('click', async () => {
          try {
            const csrf = await fetch('/api/auth/session', { credentials: 'same-origin' }).then(x => x.json()).then(x => x.csrfToken);
            const r = await fetch('/api/conversations', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ workspace_id: w.id }) });
            const d = await r.json(); if (!r.ok) throw new Error(d.error || '新建失败');
            await window.yumeiroReloadChats?.(); window.yumeiroSelectChat?.(d.conversation.id); loadWorkspaces(true);
          } catch (e) { window.ymAlert?.(e.message); }
        });
        sub.append(newChat);
        for (const c of wsChats.slice(0, 6)) {
          const a = document.createElement('button'); a.type = 'button'; a.className = 'sb-run sb-chat'; a.addEventListener('click', () => window.yumeiroSelectChat?.(c.id));
          const ic = document.createElement('span'); ic.textContent = '💬';
          const t = document.createElement('span'); t.className = 'sb-run-t'; t.textContent = c.title || '新对话'; t.title = c.title || '新对话';
          a.append(ic, t); sub.append(a);
        }
        if (wsChats.length > 6) { const more = document.createElement('button'); more.type = 'button'; more.className = 'sb-run sb-enter'; more.textContent = '全部 ' + wsChats.length + ' 段对话 ›'; more.addEventListener('click', () => window.YumeiroWS?.open(w, data.runner, 'chats')); sub.append(more); }
        for (const r of runs.slice(0, 3)) {
          const a = document.createElement('button'); a.type = 'button'; a.className = 'sb-run'; a.addEventListener('click', () => window.YumeiroWS?.open(w, data.runner, 'tasks'));
          const t = document.createElement('span'); t.className = 'sb-run-t'; t.textContent = r.task;
          const tm = document.createElement('span'); tm.className = 'sb-run-time'; tm.textContent = ago(r.createdAt);
          a.append(t, tm); sub.append(a);
        }
        if (!runs.length && !wsChats.length) { const e = document.createElement('div'); e.className = 'sb-ws-empty'; e.textContent = '还没有对话和协作任务'; sub.append(e); }
        list.append(sub);
      }
    }
  }

  let tries = 0;
  const timer = setInterval(() => { const ok = watchWelcome(); mountSidebar(); if (ok || ++tries > 200) clearInterval(timer); }, 400);
  new MutationObserver(() => { if (!$('#app')?.hidden) loadWorkspaces(); }).observe(document.body, { attributes: true, subtree: true, attributeFilter: ['hidden'] });
  setInterval(() => { if (!document.hidden) loadWorkspaces(); }, 60000);
  addEventListener('focus', loadWorkspaces);
  window.addEventListener('yumeiro:reply-done', loadWorkspaces);
  window.addEventListener('yumeiro:chat-linked', () => loadWorkspaces(true));
  window.addEventListener('yumeiro:workspaces-changed', () => { currentWs = ''; markWs(); loadWorkspaces(true); });
  // 账号菜单里的“工作区”：打开侧栏（手机上是抽屉）并展开工作区区块
  window.addEventListener('yumeiro:open-workspaces', () => { $('#app')?.classList.add('menu-open'); loadWorkspaces(true); box?.scrollIntoView({ block: 'nearest' }); });
  // ---------- 3. 把当前聊天关联到工作区（关联后随工作区一起导出给其他 AI 工具）----------
  let wsCache = [];
  async function linkDialog(chat) {
    let list = wsCache;
    try { const r = await fetch('/api/workspaces', { credentials: 'same-origin' }); if (r.ok) list = wsCache = (await r.json()).workspaces || []; } catch { /* 用缓存 */ }
    if (!list.length) { window.ymAlert?.('还没有工作区。先在左侧“工作区”旁点 ＋ 新建一个，再把聊天关联进去。'); return; }
    const v = await window.ymForm('关联到工作区', [{ name: 'ws', label: '工作区', type: 'select', value: chat.workspaceId || '', options: [{ value: '', label: '不关联' }, ...list.map(w => ({ value: w.id, label: w.name }))], hint: '关联后，这段聊天会和工作区的文件、任务记录一起导出（“🤖 导出给 AI 工具”），其他软件里的模型也能读到。只导出你自己的聊天。' }], { okText: '保存' });
    if (!v) return;
    const csrf = await fetch('/api/auth/session', { credentials: 'same-origin' }).then(r => r.json()).then(d => d.csrfToken).catch(() => '');
    const r = await fetch('/api/conversations/' + encodeURIComponent(chat.id), { method: 'PATCH', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ workspace_id: v.ws }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { window.ymAlert?.(d.error || '保存失败'); return; }
    chat.workspaceId = d.conversation?.workspaceId || null; decorateCrumb(); if (chat.workspaceId) openIds.add(chat.workspaceId), saveOpen(); loadWorkspaces(true);
  }
  function decorateCrumb() {
    const crumb = $('#crumb'), chat = window.yumeiroCurrentChat?.(); if (!crumb || !chat || !chat.id) return;
    crumb.querySelectorAll('.crumb-link').forEach(x => x.remove());
    const ws = wsCache.find(w => w.id === chat.workspaceId);
    const b = document.createElement('button'); b.type = 'button'; b.className = 'crumb-link';
    b.textContent = chat.workspaceId ? '📁 ' + (ws ? ws.name : '已关联工作区') : '📁 关联工作区'; b.title = '把这段聊天关联到工作区，导出时一起带走';
    b.addEventListener('click', () => linkDialog(chat)); crumb.append(b);
    const r = document.createElement('button'); r.type = 'button'; r.className = 'crumb-link'; r.textContent = '✎ 重命名'; r.title = '自己给这段聊天起名（起过名就不会再被 AI 自动改掉）';
    r.addEventListener('click', () => window.yumeiroRename?.(chat)); crumb.append(r);
    const ph = document.createElement('button'); ph.type = 'button'; ph.className = 'crumb-link'; ph.textContent = '📱 发到手机'; ph.title = '生成二维码，用手机扫一扫就能接着聊这一段';
    ph.addEventListener('click', () => window.ymPhoneQr?.(location.origin + '/?open=chat:' + encodeURIComponent(chat.id), chat.title || '这段对话')); crumb.append(ph);
  }
  const crumbEl = () => $('#crumb');
  const crumbTimer = setInterval(() => { const c = crumbEl(); if (!c) return; clearInterval(crumbTimer); new MutationObserver(() => { if (!c.querySelector('.crumb-link')) decorateCrumb(); }).observe(c, { childList: true }); decorateCrumb(); }, 500);


  // ---------- 4. 侧栏分区可收起：群聊、最近对话（和“工作区”一样，对话多了也不乱）----------
  const foldState = JSON.parse(localStorage.getItem('ym.fold') || '{}');
  const saveFold = () => { try { localStorage.setItem('ym.fold', JSON.stringify(foldState)); } catch { /* 忽略 */ } };
  function foldSection(label, contents, key, countOf) {
    if (!label || label.dataset.fold) return;
    label.dataset.fold = key; label.classList.add('sb-fold-head'); label.setAttribute('role', 'button'); label.tabIndex = 0;
    const caret = document.createElement('span'); caret.className = 'sb-fold-caret';
    const count = document.createElement('span'); count.className = 'sb-fold-count';
    const text = label.textContent; label.textContent = ''; const t = document.createElement('span'); t.textContent = text; label.append(caret, t, count);
    const apply = () => { const c = !!foldState[key]; contents.forEach(e => e.classList.toggle('sb-folded', c)); caret.textContent = c ? '▸' : '▾'; label.setAttribute('aria-expanded', String(!c)); const n = countOf(); count.textContent = n ? String(n) : ''; };
    const toggle = () => { foldState[key] = !foldState[key]; saveFold(); apply(); };
    label.addEventListener('click', toggle); label.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    contents.forEach(e => new MutationObserver(apply).observe(e, { childList: true }));
    apply();
  }
  function mountFolds() {
    const chatList = $('#chatList'), groupList = $('#groupList'); if (!chatList) return false;
    const recent = [...document.querySelectorAll('.sidebar > .label')].find(l => l.textContent.includes('最近对话'));
    foldSection(recent, [chatList], 'chats', () => chatList.querySelectorAll('.chat').length);
    if (groupList) { const gl = [...document.querySelectorAll('.sidebar > .label')].find(l => l.textContent.includes('群聊')); foldSection(gl, [$('.group-new'), groupList].filter(Boolean), 'groups', () => groupList.querySelectorAll('.chat').length); }
    return !!recent && !!groupList;
  }
  let foldTries = 0; const foldTimer = setInterval(() => { if (mountFolds() || ++foldTries > 60) clearInterval(foldTimer); }, 500);

  // ---------- 5. 发到手机：二维码弹层 + 扫码后打开对应对话 / 工作区 ----------
  window.ymPhoneQr = (link, title) => window.ymQr(link, '发到手机：' + title, { tip: '用 Yumeiro 手机软件的“扫一扫”扫描，会直接打开这里。也可以用手机相机扫，用浏览器打开（需要先在手机浏览器里登录同一个账号）。' });
  (function openFromLink() {
    const params = new URLSearchParams(location.search), target = params.get('open'); if (!target) return;
    let tries = 0; const timer = setInterval(async () => {
      if (++tries > 60) return clearInterval(timer);
      if ($('#app')?.hidden !== false || !window.yumeiroSelectChat) return;
      clearInterval(timer);
      const [kind, id] = target.split(':');
      params.delete('open'); history.replaceState(null, '', location.pathname + (params.toString() ? '?' + params : '') + location.hash);
      if (kind === 'chat' && id) window.yumeiroSelectChat(id);
      else if (kind === 'workspace' && id) { try { const d = await (await fetch('/api/workspaces', { credentials: 'same-origin' })).json(); const w = (d.workspaces || []).find(x => x.id === id); if (w) window.YumeiroWS?.open(w, d.runner); } catch { /* 忽略 */ } }
    }, 500);
  })();
})();
