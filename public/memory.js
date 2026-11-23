// 记忆面板：查看 / 添加 / 编辑 / 置顶 / 删除长期记忆，以及三个开关。记忆由服务端保存，换模型、换对话都会自动带上。
(() => {
  let csrf = '', panel = null, state = { memories: [], prefs: { enabled: true, auto: true, crossChat: true }, limit: 200 };
  const el = (tag, props = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'on') for (const [e, f] of Object.entries(v)) node.addEventListener(e, f);
      else if (k === 'style') node.style.cssText = v;
      else if (k in node) node[k] = v; else node.setAttribute(k, v);
    }
    node.append(...kids.flat().filter(x => x != null && x !== false));
    return node;
  };
  async function api(path, options = {}) {
    const headers = { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) };
    const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
    let data = {}; try { data = await response.json(); } catch { /* 无正文 */ }
    if (!response.ok) throw new Error(data.error || '请求失败：' + response.status);
    return data;
  }
  const send = (method, path, body) => api(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });

  function render() {
    if (!panel) return;
    const body = panel.querySelector('[data-body]'); body.replaceChildren();
    const error = el('div', { style: 'color:#c0392b;min-height:18px;font-size:13px' });
    const run = async fn => { try { error.textContent = ''; await fn(); await load(); } catch (e) { error.textContent = e.message; } };
    const toggle = (key, label, hint) => el('label', { style: 'display:flex;gap:8px;align-items:flex-start;margin:6px 0' },
      el('input', { type: 'checkbox', checked: state.prefs[key], on: { change: e => run(() => send('PUT', '/api/memory/prefs', { [key]: e.target.checked })) } }),
      el('span', {}, el('strong', {}, label), el('br'), el('span', { style: 'color:#777b86;font-size:12px' }, hint)));
    const input = el('input', { placeholder: '添加一条要长期记住的内容，例如：我主要用 TypeScript', maxLength: 300, style: 'flex:1;min-width:0;padding:8px;border:1px solid #e7e8ec;border-radius:8px' });
    const add = () => run(async () => { if (!input.value.trim()) return; await send('POST', '/api/memories', { text: input.value, pinned: true }); input.value = ''; });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
    body.append(
      toggle('enabled', '启用记忆', '关闭后不读取、不保存，已有记忆保留'),
      toggle('auto', '自动记录', '每轮对话后自动提取值得长期记住的内容（会消耗少量额度）'),
      toggle('crossChat', '参考往期对话', '新对话里主题相近时，带上往期对话的要点'),
      el('div', { style: 'display:flex;gap:8px;margin:12px 0 6px' }, input, el('button', { class: 'primary', type: 'button', on: { click: add } }, '添加')),
      error,
      el('p', { style: 'color:#777b86;font-size:12px;margin:4px 0' }, '对话里说“记住：……”也会直接保存。置顶的记忆每次都会带上；其余按话题相关性挑选。已保存 ' + state.memories.length + ' / ' + state.limit + ' 条。'));
    const list = el('div', { style: 'max-height:42vh;overflow:auto;border-top:1px solid #e7e8ec' });
    if (!state.memories.length) list.append(el('p', { style: 'color:#777b86;padding:12px 0' }, '还没有记忆。聊几轮后会自动出现，也可以手动添加。'));
    for (const item of state.memories) {
      const text = el('span', { style: 'flex:1;min-width:0;word-break:break-word;cursor:text', title: '点击修改', on: { click: async () => {
        const next = await ymPrompt('修改这条记忆', item.text);
        if (next !== null && next.trim() && next.trim() !== item.text) run(() => send('PATCH', '/api/memories/' + item.id, { text: next }));
      } } }, item.text, el('span', { style: 'color:#999;font-size:11px;margin-left:6px' }, (item.kind === 'profile' ? '偏好/身份' : '事实') + (item.source === 'auto' ? ' · 自动' : '')));
      list.append(el('div', { style: 'display:flex;gap:6px;align-items:flex-start;padding:8px 0;border-bottom:1px solid #f0f1f4' },
        el('button', { type: 'button', class: 'secondary', title: item.pinned ? '取消置顶' : '置顶（每次都带上）', style: 'padding:2px 8px', on: { click: () => run(() => send('PATCH', '/api/memories/' + item.id, { pinned: !item.pinned })) } }, item.pinned ? '★' : '☆'),
        text,
        el('button', { type: 'button', class: 'secondary', title: '删除', style: 'padding:2px 8px', on: { click: () => run(() => send('DELETE', '/api/memories/' + item.id)) } }, '✕')));
    }
    body.append(list, el('div', { class: 'modal-actions', style: 'margin-top:12px' },
      el('button', { type: 'button', class: 'secondary', on: { click: async () => { if (state.memories.length && await ymConfirm('确定清空全部记忆？此操作不能撤销。', { danger: true, okText: '确定' })) run(() => send('DELETE', '/api/memories')); } } }, '清空全部')));
  }
  async function load() { state = await api('/api/memories'); render(); }
  async function open() {
    if (!panel) {
      panel = el('div', { class: 'modal-backdrop', hidden: true, on: { click: e => { if (e.target === panel) panel.hidden = true; } } },
        el('div', { class: 'modal', style: 'width:min(560px,100%)' },
          el('div', { class: 'modal-head' }, el('h2', {}, '记忆'), el('button', { type: 'button', class: 'secondary', on: { click: () => { panel.hidden = true; } } }, '关闭')),
          el('p', { style: 'margin:4px 0 8px' }, '这里的内容在所有对话、所有模型之间共享。切换模型或新开对话后，相关记忆会自动带上。'),
          el('div', { 'data-body': '' })));
      document.body.append(panel);
    }
    panel.hidden = false;
    try { await load(); } catch (e) { panel.querySelector('[data-body]').textContent = e.message; }
  }
  // 同一时间只允许一个 boot 在等接口，避免定时器重复进入、把按钮插入多次
  let booting = null;
  function boot() { return booting || (booting = bootOnce().finally(() => { booting = null; })); }
  async function bootOnce() {
    try {
      const session = await api('/api/auth/session');
      if (!session.authenticated) return false;
      csrf = session.csrfToken || '';
    } catch { return false; }
    const anchor = document.getElementById('settings');
    if (!anchor || document.getElementById('memoryButton')) return !!anchor;
    anchor.before(el('button', { class: 'icon-button', id: 'memoryButton', type: 'button', title: '记忆', 'aria-label': '记忆', textContent: '🧠', on: { click: open } }));
    return true;
  }
  let tries = 0;
  const timer = setInterval(async () => { if (await boot() || ++tries > 200) clearInterval(timer); }, 1500);
  boot().then(ok => { if (ok) clearInterval(timer); });
})();
