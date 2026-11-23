// 多智能体群聊 + 对话里的代码「运行」按钮（沙箱）。独立脚本：不改动主对话页的代码，只在侧栏加一个「群聊」区和一个覆盖面板。
(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const el = (tag, props = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) { if (k === 'on') for (const [e, f] of Object.entries(v)) node.addEventListener(e, f); else if (k === 'style') node.style.cssText = v; else if (v !== undefined && v !== null) node[k] = v; }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined) node.append(kid);
    return node;
  };
  let csrf = '';
  async function api(path, options = {}) {
    const response = await fetch(path, { credentials: 'same-origin', ...options, headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), 'X-CSRF-Token': csrf, ...(options.headers || {}) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '请求失败：' + response.status);
    return data;
  }
  const MODES = { pm: '产品经理带队（推荐）：你只和产品经理说话，它按各模型的擅长分配任务', chat: '群聊（@ 点名，没点名则大家轮流回）', roundtable: '圆桌讨论（多轮，最后总结）', pipeline: '接力（后一位基于前面的产出）', supervisor: '主管调度（第一位是主管）' };

  // ---------- 代码块「运行」按钮 ----------
  let sandboxOk = false;
  const LANG = { python: 'python', py: 'python', python3: 'python', js: 'node', javascript: 'node', node: 'node', mjs: 'node', bash: 'bash', sh: 'bash', shell: 'bash' };
  function runnersFor(text) {
    const out = []; const re = /```([A-Za-z0-9_+-]*)[^\n]*\n([\s\S]*?)```/g; let m;
    while ((m = re.exec(text))) { const lang = LANG[m[1].toLowerCase()]; if (lang && m[2].trim()) out.push({ lang, code: m[2] }); }
    return out;
  }
  function attachRunners(bubble) {
    if (!sandboxOk || !bubble) return;
    const text = bubble.textContent || '';
    if (bubble.dataset.running === '1' || bubble.dataset.runText === text.trim()) return;
    bubble.dataset.runText = text.trim();
    bubble.parentElement.querySelector(':scope > .run-bar')?.remove();
    const blocks = runnersFor(text);
    if (!blocks.length) return;
    const output = el('pre', { style: 'white-space:pre-wrap;margin:6px 0 0;padding:8px;border:1px solid var(--line);border-radius:8px;font-size:12px;max-height:240px;overflow:auto', hidden: true });
    const bar = el('div', { className: 'run-bar', style: 'display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:6px;flex:0 0 100%;box-sizing:border-box;padding-left:var(--run-indent,0)' },
      blocks.map((b, i) => el('button', { type: 'button', className: 'secondary', style: 'height:28px;padding:0 10px;font-size:12px', textContent: `▶ 在沙箱运行第 ${i + 1} 段（${b.lang}）`, on: { click: async ev => {
        const btn = ev.currentTarget; btn.disabled = true; bubble.dataset.running = '1'; output.hidden = false; output.textContent = '运行中…';
        try {
          const r = await api('/api/sandbox/run', { method: 'POST', body: JSON.stringify({ language: b.lang, code: b.code }) });
          output.textContent = `退出码 ${r.exitCode ?? '无'}${r.timedOut ? '（超时被终止）' : ''} · ${r.durationMs} ms\n` + (r.stdout ? r.stdout : '') + (r.stderr ? '\n[stderr]\n' + r.stderr : '') + (r.changed?.length ? '\n[写入工作区文件] ' + r.changed.join(', ') : '');
        } catch (x) { output.textContent = '运行失败：' + x.message; } finally { btn.disabled = false; delete bubble.dataset.running; }
      } } })), output);
    const host = bubble.parentElement; if (host.classList.contains('message')) { host.style.flexWrap = 'wrap'; bar.style.setProperty('--run-indent', '44px'); }
    host.append(bar);
  }
  const scanBubbles = () => document.querySelectorAll('#messages .message.assistant .bubble, #groupPanel .gmsg.agent .bubble').forEach(attachRunners);

  // 模型名 → [默认身份, 默认擅长]；只是按名字给的建议，用户可以在设置里随意改
  const HINTS = [[/claude|opus|sonnet|haiku/i, '资深架构师与写作者', '长文写作、代码、严谨推理'], [/gpt|o1|o3|o4/i, '全能工程师', '通用问答、代码、工具调用'], [/deepseek/i, '算法与后端工程师', '代码、数学与推理、性价比高'], [/qwen|通义/i, '中文内容专家', '中文理解、多语言、代码'], [/gemini/i, '资料研究员', '超长上下文、多模态、检索总结'], [/glm|智谱/i, '办公文案助理', '中文对话、办公写作'], [/kimi|moonshot/i, '阅读与总结专员', '长文阅读与总结'], [/doubao|豆包/i, '创意文案', '中文创作、日常对话']];
  const hintFor = name => HINTS.find(([re]) => re.test(name)) || [0, '全能助手', '通用对话与分析'];
  const safeName = text => String(text).replace(/[@\s/]+/g, '').slice(0, 20) || '模型';

  // ---------- 群聊面板 ----------
  let groups = [], current = null, agents = [], busy = null, listBox, panel, msgBox, input, titleEl, sendBtn, stopBtn, chipsEl, statusEl;
  const labelColor = label => `hsl(${[...label].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)} 55% 45%)`;

  function bubbleFor(message) {
    const isUser = message.role === 'user';
    const bubble = el('div', { className: 'bubble', style: 'white-space:pre-wrap;word-break:break-word', textContent: message.content });
    const name = isUser ? '你' : message.label;
    const row = el('div', { className: 'gmsg ' + (isUser ? 'user' : 'agent'), style: 'display:flex;flex-direction:column;gap:3px;max-width:88%;' + (isUser ? 'align-self:flex-end;align-items:flex-end' : 'align-self:flex-start') },
      el('div', { style: 'font-size:12px;font-weight:650;color:' + (isUser ? 'var(--muted)' : labelColor(name)) }, name + (message.partial ? '（已中断）' : ''), message.task ? el('span', { style: 'font-weight:400;color:var(--muted)', textContent: '　任务：' + message.task }) : null), bubble);
    return { row, bubble };
  }
  const scrollDown = () => { msgBox.scrollTop = msgBox.scrollHeight; };
  const setStatus = text => { if (statusEl) statusEl.textContent = text || ''; };
  const TRY = { pm: ['帮我做一个产品需求文档（PRD）', '评估一下这个方案的风险，并给出改进建议', '帮我写一段文案，再检查代码实现是否可行'], chat: ['大家怎么看这个方案？', '@' + '成员名 先说说你的看法'], roundtable: ['讨论一下：先做 A 还是先做 B？'], pipeline: ['把这段需求拆成任务并逐步实现'], supervisor: ['完成这个任务：整理本周的工作要点'] };
  function renderChips() {
    chipsEl.replaceChildren(...(current ? current.members.map(m => el('button', { type: 'button', className: 'gchip', title: (m.role || '成员') + (m.strengths ? ' · 擅长：' + m.strengths : '') + '（点一下插入 @）', textContent: m.label + (m.role ? ' · ' + m.role : ''), style: 'border-color:' + labelColor(m.label), on: { click: () => { input.value += (input.value && !input.value.endsWith(' ') ? ' ' : '') + '@' + m.label + ' '; input.focus(); } } })) : []));
  }
  function renderEmpty() {
    if (msgBox.children.length || !current) return;
    const tries = TRY[current.mode] || [];
    msgBox.append(el('div', { className: 'gempty' }, el('div', { textContent: current.mode === 'pm' ? '说出你的需求，' + (current.pm?.label || '产品经理') + '会按每位成员的擅长分工，再汇总答复你。' : '发一条消息开始，用 @名称 可以点名某位成员。' }),
      el('div', { className: 'gtry' }, tries.map(t => el('button', { type: 'button', textContent: t, on: { click: () => { input.value = t; input.focus(); } } })))));
  }

  async function loadList() {
    try { groups = (await api('/api/groups')).groups; } catch { groups = []; }
    renderList();
  }
  function renderList() {
    listBox.replaceChildren(...(groups.length ? groups.map(g => el('div', { className: 'chat' + (current?.id === g.id ? ' active' : '') },
      el('button', { type: 'button', className: 'chat-title', textContent: '👥 ' + g.title, title: g.members.map(m => m.label).join('、'), on: { click: () => openGroup(g.id) } }),
      el('button', { type: 'button', className: 'del', textContent: '×', title: '删除群聊', on: { click: async e => { e.stopPropagation(); if (!await ymConfirm('删除群聊“' + g.title + '”？', { danger: true, okText: '确定' })) return; try { await api('/api/groups/' + g.id, { method: 'DELETE' }); if (current?.id === g.id) closePanel(); loadList(); } catch (x) { ymAlert(x.message); } } } }))) : [el('div', { className: 'empty-list', textContent: '还没有群聊' })]));
  }
  // 群聊用量：Token 与费用（价格由主账号按模型设置；没设价格的模型只显示 Token）
  async function showUsage() {
    if (!current) return;
    const box = el('div', { className: 'gedit-wrap' });
    const body = el('div', { className: 'modal', style: 'color:var(--ink);border-radius:14px;padding:18px;width:min(720px,100%);max-height:90vh;overflow:auto;display:grid;gap:10px' });
    box.append(body); document.body.append(box);
    const close = el('button', { type: 'button', className: 'secondary', textContent: '关闭', on: { click: () => box.remove() } });
    try {
      const r = await api('/api/groups/' + current.id + '/usage'), cur = r.currency, n = v => Number(v || 0).toLocaleString();
      const money = v => r.priced ? cur + (Math.round((v || 0) * 10000) / 10000).toLocaleString() : '未设价格';
      const table = (rows, key, title) => el('table', { style: 'width:100%;border-collapse:collapse;font-size:13px' },
        el('thead', {}, el('tr', {}, [title, '调用', '输入', '输出', '合计 Token', '费用'].map(t => el('th', { style: 'text-align:left;padding:4px 6px;border-bottom:1px solid var(--line)', textContent: t })))),
        el('tbody', {}, rows.length ? rows.map(x => el('tr', {}, [x[key], n(x.calls), n(x.inputTokens), n(x.outputTokens), n(x.totalTokens), money(x.cost)].map(v => el('td', { style: 'padding:4px 6px;border-bottom:1px solid var(--line);word-break:break-all', textContent: String(v) })))) : [el('tr', {}, el('td', { colSpan: 6, style: 'padding:6px', textContent: '本月还没有用量' }))]));
      body.replaceChildren(el('h3', { style: 'margin:0', textContent: '群聊用量 · ' + current.title }),
        el('div', { style: 'font-size:13px', textContent: `本月（${r.month}）共 ${n(r.thisMonth.total.calls)} 次调用，${n(r.thisMonth.total.totalTokens)} tokens，费用 ${money(r.thisMonth.total.cost)}；累计 ${n(r.allTime.total.totalTokens)} tokens，费用 ${money(r.allTime.total.cost)}。` }),
        el('h4', { style: 'margin:6px 0 0', textContent: '本月 · 每位成员' }), table(r.thisMonth.members, 'label', '成员'),
        el('h4', { style: 'margin:6px 0 0', textContent: '本月 · 每个模型' }), table(r.thisMonth.models, 'model', '模型'),
        el('div', { style: 'font-size:12px;color:var(--muted)', textContent: 'Token 为模型服务商返回的用量；服务商没有返回用量的调用只计次数。' }),
        el('div', { style: 'display:flex;justify-content:flex-end' }, close));
    } catch (x) { body.replaceChildren(el('div', { style: 'color:#d33', textContent: x.message }), el('div', { style: 'display:flex;justify-content:flex-end' }, close)); }
  }
  async function openGroup(id) {
    try {
      const data = await api('/api/groups/' + id);
      current = data.group; panel.hidden = false; $('#app').classList.remove('menu-open');
      titleEl.textContent = current.title + ' · ' + current.members.map(m => m.label).join('、') + ' · ' + MODES[current.mode].split('（')[0];
      msgBox.replaceChildren(...data.messages.map(m => bubbleFor(m).row));
      renderChips(); renderEmpty(); setStatus('');
      renderList(); scrollDown(); scanBubbles(); if (!matchMedia('(max-width:760px)').matches) input.focus();
    } catch (x) { ymAlert(x.message); }
  }
  function closePanel() { panel.hidden = true; current = null; renderList(); }

  async function send() {
    const message = input.value.trim();
    if (!message || !current || busy) return;
    input.value = ''; msgBox.querySelector('.gempty')?.remove(); msgBox.append(bubbleFor({ role: 'user', content: message }).row); scrollDown(); setStatus((current.pm?.label || '成员') + ' 正在思考…');
    busy = new AbortController(); sendBtn.hidden = true; stopBtn.hidden = false;
    let bubbles = new Map(), failure = '';
    try {
      const response = await fetch(`/api/groups/${current.id}/send`, { method: 'POST', credentials: 'same-origin', signal: busy.signal, headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'X-CSRF-Token': csrf }, body: JSON.stringify({ message }) });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || '请求失败：' + response.status);
      const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
      const handle = block => {
        let event = 'message', data = '';
        for (const line of block.split('\n')) { if (line.startsWith('event:')) event = line.slice(6).trim(); else if (line.startsWith('data:')) data += line.slice(5).trim(); }
        if (!data) return; const value = JSON.parse(data);
        if (event === 'turn_start') { const b = bubbleFor({ role: 'agent', label: value.label, content: '…', task: value.task }); bubbles.set(value.label, { ...b, text: '' }); msgBox.append(b.row); scrollDown(); setStatus([...bubbles.keys()].join('、') + ' 正在发言…'); }
        else if (event === 'delta') { const b = bubbles.get(value.label); if (b) { b.text += value.text; b.bubble.textContent = b.text; scrollDown(); } }
        else if (event === 'turn_end') { const b = bubbles.get(value.label); if (b) { attachRunners(b.bubble); bubbles.delete(value.label); } setStatus(bubbles.size ? [...bubbles.keys()].join('、') + ' 正在发言…' : (current.mode === 'pm' ? current.pm?.label + ' 正在整理…' : '')); }
        else if (event === 'note') msgBox.append(el('div', { style: 'align-self:center;font-size:12px;color:var(--muted)', textContent: value.text }));
        else if (event === 'error') failure = value.error;
        else if (event === 'done') { current = value.group; loadList(); }
      };
      for (;;) { const { done, value } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); let i; while ((i = buffer.indexOf('\n\n')) >= 0) { handle(buffer.slice(0, i)); buffer = buffer.slice(i + 2); } }
    } catch (x) { if (x.name !== 'AbortError') failure = x.message; }
    if (failure) msgBox.append(el('div', { className: 'bubble error', style: 'align-self:center', textContent: failure }));
    busy = null; sendBtn.hidden = false; stopBtn.hidden = true; setStatus(''); scrollDown();
  }

  // 新建 / 编辑群聊
  const DEFAULT_MEMBERS = 4;
  async function editGroup(group) {
    let models = [];
    try { agents = (await api('/api/agents')).agents; } catch { agents = []; }
    try { models = (await api('/api/models')).models; } catch { models = []; }
    const modelSelect = value => { const sel = el('select', { style: 'max-width:170px' }, el('option', { value: '', textContent: '默认模型' }), models.map(m => el('option', { value: m.ref, textContent: (m.label || m.model) + (m.providerName ? ' · ' + m.providerName : '') }))); sel.value = value || ''; return sel; };
    const agentSelect = value => { const sel = el('select', { style: 'max-width:140px' }, el('option', { value: '', textContent: '不绑定智能体' }), agents.map(a => el('option', { value: a.id, textContent: a.name }))); sel.value = value || ''; return sel; };
    const rows = el('div', { style: 'display:grid;gap:8px' });
    const addRow = m => {
      const label = el('input', { placeholder: '名称', maxLength: 30, value: m?.label || '', style: 'width:100px' }), model = modelSelect(m?.model), agent = agentSelect(m?.agentId);
      const role = el('input', { placeholder: '身份，如“后端工程师”', maxLength: 200, value: m?.role || '', style: 'flex:1;min-width:130px' });
      const strengths = el('input', { placeholder: '擅长，如“写代码、排错”（产品经理据此分工）', maxLength: 200, value: m?.strengths || '', style: 'flex:2;min-width:180px' });
      const row = el('div', { className: 'gedit-row gedit-member' }, label, model, agent, role, strengths, el('button', { type: 'button', className: 'secondary', textContent: '移除', on: { click: () => row.remove() } }));
      model.addEventListener('change', () => { // 换模型时，身份/擅长还是空的就按新模型填默认值
        const info = models.find(x => x.ref === model.value); if (!info) return;
        const h = hintFor(info.model + ' ' + (info.label || ''));
        if (!role.value.trim()) role.value = h[1]; if (!strengths.value.trim()) strengths.value = h[2];
        if (!label.value.trim()) label.value = safeName(info.label || info.model);
      });
      row.read = () => ({ label: label.value.trim(), model: model.value || undefined, agentId: agent.value || undefined, role: role.value.trim(), strengths: strengths.value.trim() });
      rows.append(row);
    };
    const addAllModels = () => {
      const used = new Set([...rows.children].map(r => r.read().model).filter(Boolean));
      const names = new Set([...rows.children].map(r => r.read().label));
      for (const m of models) {
        if (rows.children.length >= 12) break;
        if (used.has(m.ref)) continue;
        let name = safeName(m.label || m.model), n = 2; while (names.has(name)) name = safeName(m.label || m.model) + n++;
        names.add(name); addRow({ label: name, model: m.ref, role: hintFor(m.model + ' ' + (m.label || ''))[1], strengths: hintFor(m.model + ' ' + (m.label || ''))[2] });
      }
    };
    (group?.members || []).forEach(addRow);
    if (!group) { // 新建时默认 4 位成员（取前 4 个可用模型，不够就用默认模型补齐），之后可以用“添加成员”继续加
      const names = new Set(); const fresh = (base) => { let name = safeName(base), n = 2; while (names.has(name)) name = safeName(base) + n++; names.add(name); return name; };
      for (const m of models.slice(0, DEFAULT_MEMBERS)) { const h = hintFor(m.model + ' ' + (m.label || '')); addRow({ label: fresh(m.label || m.model), model: m.ref, role: h[1], strengths: h[2] }); }
      for (let i = rows.children.length; i < DEFAULT_MEMBERS; i++) addRow({ label: fresh('成员' + (i + 1)) });
    }
    const title = el('input', { placeholder: '群聊名称', maxLength: 60, value: group?.title || '' });
    const mode = el('select', {}, Object.entries(MODES).map(([v, t]) => el('option', { value: v, textContent: t }))); mode.value = group?.mode || 'pm';
    const rounds = el('input', { type: 'number', min: 1, max: 6, value: group?.rounds || (mode.value === 'pm' ? 4 : 2), style: 'width:70px' });
    const pmLabel = el('input', { maxLength: 30, value: group?.pm?.label || '产品经理', style: 'width:110px' }), pmModel = modelSelect(group?.pm?.model), pmAgent = agentSelect(group?.pm?.agentId);
    const pmBox = el('div', { className: 'gedit-row gedit-pm', style: 'border-style:dashed' }, el('strong', { textContent: '产品经理' }), pmLabel, pmModel, pmAgent, el('span', { style: 'font-size:12px;color:var(--muted)', textContent: '建议选最强的推理模型' }));
    const syncMode = () => { pmBox.hidden = mode.value !== 'pm'; };
    mode.addEventListener('change', syncMode); syncMode();
    const err = el('div', { style: 'color:#d33;font-size:13px' });
    const dialog = el('div', { className: 'gedit-wrap' },
      el('div', { className: 'modal', style: 'color:var(--ink);border-radius:14px;padding:18px;width:min(760px,100%);max-height:90vh;overflow:auto;display:grid;gap:10px' },
        el('h3', { style: 'margin:0', textContent: group ? '群聊设置' : '新建群聊' }), title,
        el('label', {}, '方式 ', mode), pmBox,
        el('div', { style: 'font-size:12px;color:var(--muted)', textContent: '默认 4 位成员，需要更多可以点“添加成员”（最多 12 位）。每个模型一个身份（名称 + 身份 + 擅长）。产品经理会根据“擅长”把任务分给最合适的人。身份和擅长是按模型名给的默认建议，你可以随意修改。' }), rows,
        el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' },
          el('button', { type: 'button', className: 'secondary', textContent: '＋ 添加成员', on: { click: () => rows.children.length < 12 && addRow() } }),
          el('button', { type: 'button', className: 'secondary', textContent: '＋ 把我能用的所有模型都加进来', on: { click: addAllModels } })),
        el('label', {}, '最多分配轮数 / 讨论轮数 ', rounds), err,
        el('div', { style: 'display:flex;gap:8px;justify-content:flex-end' },
          el('button', { type: 'button', className: 'secondary', textContent: '取消', on: { click: () => dialog.remove() } }),
          el('button', { type: 'button', className: 'primary', textContent: '保存', on: { click: async () => {
            try {
              const body = JSON.stringify({ title: title.value, mode: mode.value, rounds: Number(rounds.value) || 2, members: [...rows.children].map(r => r.read()), ...(mode.value === 'pm' ? { pm: { label: pmLabel.value.trim() || '产品经理', model: pmModel.value || undefined, agentId: pmAgent.value || undefined } } : {}) });
              const data = group ? await api('/api/groups/' + group.id, { method: 'PATCH', body }) : await api('/api/groups', { method: 'POST', body });
              dialog.remove(); await loadList(); openGroup(data.group.id);
            } catch (x) { err.textContent = x.message; }
          } } }))));
    document.body.append(dialog);
  }

  document.head.append(el('style', { textContent: `
#groupPanel{background:#f7f7f9;color:var(--ink)}html[data-theme=dark] #groupPanel{background:#0f1117}
#groupPanel textarea,#groupPanel .bubble{background:#fff;color:#252832}
html[data-theme=dark] #groupPanel textarea,html[data-theme=dark] #groupPanel .bubble{background:#171a23;color:var(--ink)}
#groupPanel .bubble.error{background:#fff1f2;color:#9d3842;border:1px solid #f0c2c7}
html[data-theme=dark] #groupPanel .bubble.error{background:#2a1a1e;color:#ffb4bd;border-color:#5b2a33}
#groupPanel .gchips{display:flex;gap:6px;overflow-x:auto;padding:8px 14px;border-bottom:1px solid var(--line);scrollbar-width:none}
#groupPanel .gchip{flex:none;border:1px solid var(--line);border-radius:999px;padding:3px 10px;font-size:12px;background:transparent;color:var(--ink);cursor:pointer}
#groupPanel .gstatus{padding:4px 16px;font-size:12px;color:var(--muted);min-height:22px}
#groupPanel .gempty{margin:auto;max-width:520px;padding:24px;text-align:center;color:var(--muted);display:grid;gap:10px}
#groupPanel .gtry{display:flex;gap:8px;flex-wrap:wrap;justify-content:center}
#groupPanel .gtry button{border:1px solid var(--line);border-radius:12px;background:transparent;color:var(--ink);padding:6px 10px;font-size:13px;cursor:pointer}
#groupPanel .gcomposer{display:flex;gap:8px;padding:10px 14px calc(10px + env(safe-area-inset-bottom));border-top:1px solid var(--line)}
#groupPanel .gmsg{max-width:88%}
.gedit-wrap *{box-sizing:border-box}.gedit-wrap .modal>*{min-width:0}.gedit-wrap select,.gedit-wrap input{max-width:100%}
.gedit-row{display:flex;gap:6px;flex-wrap:wrap;padding:8px;border:1px solid var(--line);border-radius:10px}
.gedit-wrap{position:fixed;inset:0;background:#0006;z-index:50;display:grid;place-items:center;padding:16px}
@media(max-width:760px){
  #groupPanel .gmsg{max-width:94%}
  #groupPanel textarea,.gedit-wrap input,.gedit-wrap select{font-size:16px}
  .gedit-wrap{padding:0;place-items:stretch}
  .gedit-wrap .modal{width:100%!important;max-height:100vh!important;height:100%;border-radius:0!important}
  .gedit-wrap .modal{overflow-x:hidden;padding:14px!important;box-sizing:border-box}
  .gedit-row{flex-direction:column}
  .gedit-row>*{width:100%!important;max-width:none!important;min-width:0!important;flex:none!important}
}` }));
  function build() {
    const chatList = $('#chatList'); if (!chatList || $('#groupList')) return;
    listBox = el('div', { className: 'chat-list', id: 'groupList', style: 'max-height:28%;overflow:auto' });
    const recentLabel = chatList.previousElementSibling && chatList.previousElementSibling.classList.contains('label') ? chatList.previousElementSibling : chatList; // 群聊区放在“最近对话”标题之前，别把普通对话挤到群聊下面
    recentLabel.before(el('div', { className: 'label', textContent: '群聊（多智能体）' }), el('button', { type: 'button', className: 'new group-new', title: '新建群聊', style: 'margin:0 0 6px', textContent: '＋ 新建群聊', on: { click: () => editGroup(null) } }), listBox);
    const main = $('.main'); main.style.position = 'relative';
    titleEl = el('div', { style: 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:650' });
    msgBox = el('div', { style: 'flex:1;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:12px' });
    input = el('textarea', { rows: 2, placeholder: '说出你的需求（产品经理带队时由它分工，也可 @名称 点名）  Enter 发送，Shift+Enter 换行', style: 'flex:1;resize:none;border:1px solid var(--line);border-radius:10px;padding:8px', on: { keydown: e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } } } });
    sendBtn = el('button', { type: 'button', className: 'primary', textContent: '发送', style: 'height:40px;padding:0 16px', on: { click: send } });
    stopBtn = el('button', { type: 'button', className: 'secondary', textContent: '停止', hidden: true, style: 'height:40px;padding:0 16px', on: { click: () => busy?.abort() } });
    chipsEl = el('div', { className: 'gchips' }); statusEl = el('div', { className: 'gstatus' });
    panel = el('div', { id: 'groupPanel', hidden: true, style: 'position:absolute;inset:0;z-index:5;display:flex;flex-direction:column' },
      el('div', { style: 'display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--line)' }, titleEl,
        el('button', { type: 'button', className: 'secondary', textContent: '用量', on: { click: showUsage } }),
        el('button', { type: 'button', className: 'secondary', textContent: '设置', on: { click: () => current && editGroup(current) } }),
        el('button', { type: 'button', className: 'secondary', textContent: '关闭', on: { click: closePanel } })),
      chipsEl, msgBox, statusEl, el('div', { className: 'gcomposer' }, input, sendBtn, stopBtn));
    main.append(panel);
    loadList();
  }

  async function boot() {
    for (let i = 0; i < 120; i++) {
      if ($('#app') && !$('#app').hidden) break;
      await new Promise(r => setTimeout(r, 500));
    }
    if (!$('#app') || $('#app').hidden) return setTimeout(boot, 3000);
    try { csrf = (await api('/api/auth/session')).csrfToken || ''; sandboxOk = (await api('/api/sandbox')).available; } catch { return setTimeout(boot, 5000); }
    build();
    setInterval(scanBubbles, 1500);
  }
  boot();
})();
