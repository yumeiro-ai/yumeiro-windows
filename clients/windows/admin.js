// 管理员页面：在客户端里管理服务器端设置（成员、安全与熔断、套餐信息、模型价格、站点设置）。
// 这些都是“服务器上的设置”，改了对所有人生效；服务器自己也会检查管理员身份。
(() => {
  'use strict';
  const SYMBOLS = [['¥', '¥ 人民币'], ['$', '$ 美元'], ['€', '€ 欧元'], ['£', '£ 英镑'], ['₩', '₩ 韩元'], ['₽', '₽ 卢布'], ['₹', '₹ 卢比']];
  const BUILTIN = [['idcard', '身份证号（带校验）'], ['bank', '银行卡号（带校验）'], ['secret', '密钥 / 令牌'], ['phone', '手机号'], ['email', '邮箱地址']];
  const KIND = { dlp: '敏感内容', confidential: '机密工作区', breaker: '模型熔断', abuse: '请求过快', cost: '费用上限' };

  window.renderAdminPanels = function renderAdminPanels({ h, api, toast, setRow, selectOf, host, engineBox }) {
    const tabs = [['members', '成员'], ['safety', '安全与熔断'], ['plan', '套餐与授权'], ['pricing', '模型价格'], ['site', '站点设置'], ['engines', '智能体引擎']];
    const bar = h('div', 'page-actions'), body = h('div', ''); host.append(bar, body);
    const num = (value, ph) => { const i = h('input'); i.type = 'number'; i.min = '0'; i.step = 'any'; i.value = value ?? ''; i.placeholder = ph || ''; i.style.width = '110px'; return i; };
    const text = (value, ph, type = 'text') => { const i = h('input'); i.type = type; i.value = value ?? ''; i.placeholder = ph || ''; i.autocomplete = 'off'; return i; };
    const area = (value, ph) => { const t = h('textarea'); t.value = value ?? ''; t.placeholder = ph || ''; t.rows = 4; t.style.width = '100%'; return t; };
    const check = (label, on) => { const c = h('input'); c.type = 'checkbox'; c.checked = Boolean(on); return { box: c, row: h('label', '', c, ' ' + label) }; };
    const btn = (label, fn, cls = 'primary') => { const b = h('button', cls, label); b.type = 'button'; b.onclick = async () => { b.disabled = true; try { await fn(); } catch (e) { toast(e.message || String(e)); } finally { b.disabled = false; } }; return b; };
    const fmt = t => t ? new Date(t).toLocaleString() : '—';
    const panel = (title, ...kids) => h('article', 'panel', h('h3', '', title), h('div', 'panel-body', ...kids));
    const note = t => h('p', 'muted', t);
    let current = 'members';
    const show = async id => {
      current = id; bar.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.id === id));
      body.replaceChildren(h('p', 'muted', '正在读取…'));
      try { const out = await views[id](); body.replaceChildren(...[].concat(out)); } catch (e) { body.replaceChildren(h('p', 'muted', '读取失败：' + e.message)); }
    };
    const reload = () => show(current);

    const views = {
      // ── 成员 ──
      async members() {
        const d = await api('GET', '/api/admin/members'), list = d.members || [];
        const email = text('', '成员邮箱'), name = text('', '显示名（可选）'), pass = text('', '初始密码（至少 12 个字符）', 'password');
        const add = btn('添加成员', async () => { await api('POST', '/api/admin/members', { email: email.value.trim(), displayName: name.value.trim(), password: pass.value }); toast('已添加'); await reload(); });
        const rows = list.map(m => h('div', 'set-row', h('div', 'txt', h('b', '', m.displayName || m.email), h('small', '', m.email + (m.role === 'admin' ? ' · 管理员' : '') + (m.disabled ? ' · 已停用' : '') + (m.lastLoginAt ? ' · 最近登录 ' + fmt(m.lastLoginAt) : ''))),
          m.role === 'admin' ? h('span', '') : h('span', 'row-actions',
            btn(m.disabled ? '启用' : '停用', async () => { await api('PATCH', '/api/admin/members/' + m.id, { disabled: !m.disabled }); await reload(); }, 'secondary'),
            btn('删除', async () => { if (!await window.ymConfirm('确定删除 ' + m.email + '？这会删除他的全部数据。', { danger: true, okText: '删除' })) return; await api('DELETE', '/api/admin/members/' + m.id); await reload(); }, 'secondary'))));
        return [panel('添加成员', email, name, pass, add), panel('成员（' + list.length + '）', ...(rows.length ? rows : [note('还没有成员。')]))];
      },

      // ── 安全与熔断 ──
      async safety() {
        const d = await api('GET', '/api/admin/security'), dlp = d.dlp || {}, br = d.breaker || {}, em = d.emailDomains || {};
        const on = check('启用敏感内容拦截', dlp.enabled), mode = selectOf([['block', '拦截（不发给模型，并告警）'], ['warn', '只警告（放行，但记录并告警）']], dlp.mode || 'block', () => {});
        const builtin = {}; const builtinRows = BUILTIN.map(([id, label]) => { const c = check(label, dlp.builtin && dlp.builtin[id]); builtin[id] = c.box; return c.row; });
        const keywords = area((dlp.keywords || []).join('\n'), '自定义关键词，每行一个，不分大小写');
        const regexes = area((dlp.regexes || []).map(r => r.name + ' = ' + r.pattern).join('\n'), '自定义正则，每行：名称 = 正则');
        const allowIds = [...(d.providers || []), ...(d.engines || [])], allow = {};
        const allowRows = allowIds.map(it => { const c = check(it.name, (dlp.confidentialAllow || []).includes(it.id)); allow[it.id] = c.box; return c.row; });
        const emOn = check('只允许公司邮箱注册', em.enabled), emList = area((em.domains || []).join('\n'), '公司邮箱域名，每行一个，例如 example.com');
        const brOn = check('启用熔断', br.enabled !== false), thr = num(br.failureThreshold, '5'), open = num(br.openSeconds, '60'), rate = num(br.userRatePerMinute, '30'), day = num(br.dailyCostLimit, '0'), month = num(br.monthlyCostLimit, '0');
        const save = btn('保存', async () => {
          const rx = regexes.value.split('\n').map(l => l.trim()).filter(Boolean).map(l => { const i = l.indexOf('='); return i > 0 ? { name: l.slice(0, i).trim(), pattern: l.slice(i + 1).trim() } : { name: '自定义规则', pattern: l }; });
          await api('PUT', '/api/admin/security', {
            dlp: { enabled: on.box.checked, mode: mode.value, builtin: Object.fromEntries(Object.entries(builtin).map(([k, b]) => [k, b.checked])), keywords: keywords.value.split('\n'), regexes: rx, confidentialAllow: Object.entries(allow).filter(([, b]) => b.checked).map(([k]) => k) },
            emailDomains: { enabled: emOn.box.checked, domains: emList.value },
            breaker: { enabled: brOn.box.checked, failureThreshold: thr.value, openSeconds: open.value, userRatePerMinute: rate.value, dailyCostLimit: day.value, monthlyCostLimit: month.value } });
          toast('已保存，立即生效'); await reload();
        });
        const act = async payload => { await api('POST', '/api/admin/security/breaker', payload); await reload(); };
        const states = (d.states && d.states.models || []).map(s => h('div', 'set-row', h('div', 'txt', h('b', '', s.state === 'open' ? (s.manual ? '已手动暂停' : '已熔断') : s.state === 'half' ? '试探中' : '正常'), h('small', '', s.key + (s.reason ? '　' + s.reason : ''))),
          btn(s.state !== 'closed' ? '立即恢复' : '手动暂停', () => act({ action: s.state !== 'closed' ? 'reset' : 'trip', key: s.key }), 'secondary')));
        const users = (d.states && d.states.users || []).map(u => h('div', 'set-row', h('div', 'txt', h('b', '', u.email || u.userId), h('small', '', '请求太快，暂停中（约 ' + Math.ceil(u.retryAfterMs / 1000) + ' 秒）')), btn('解除', () => act({ action: 'reset-user', userId: u.userId }), 'secondary')));
        const events = (d.events || []).slice(0, 50).map(e => h('div', 'set-row', h('div', 'txt', h('b', '', '[' + (KIND[e.kind] || e.kind) + '] ' + (e.summary || '')), h('small', '', fmt(e.at) + (e.email ? '　' + e.email : '') + (e.model ? '　' + e.model : '')))));
        const cur = d.currency || '¥', costs = d.costs || { day: 0, month: 0 };
        return [note('这里只记录“谁、什么时候、命中了什么规则”，不会记录或显示被检测的内容本身。'),
          panel('注册邮箱限制', note('开启后，邀请、新建成员都只接受这些域名的邮箱（完整匹配，子域名要单独写）。已有成员不受影响。'), emOn.row, emList),
          panel('敏感内容拦截', note('成员发给模型的内容、以及引擎的指令，会在发出前检查，只检查这一轮新发出的内容。'), on.row, setRow('命中后', '', mode), ...builtinRows, keywords, regexes),
          panel('机密工作区', note('被标成“机密”的工作区默认不能发给任何模型或引擎，只有勾选的才允许（比如公司自己部署的模型）。当前机密工作区：' + ((d.labeled || []).map(x => x.name).join('、') || '无')), ...allowRows),
          panel('熔断与费用上限', brOn.row, setRow('模型连续失败几次就熔断', '', thr), setRow('熔断后先断开多少秒再试探', '', open), setRow('单人每分钟最多请求（0 不限）', '', rate), setRow('每日费用上限 ' + cur + '（0 不限）', '', day), setRow('每月费用上限 ' + cur + '（0 不限）', '', month),
            note('当前已用：今日 ' + cur + Number(costs.day || 0).toFixed(2) + '，本月 ' + cur + Number(costs.month || 0).toFixed(2))),
          h('div', '', save),
          panel('实时状态', ...(states.length ? states : [note('还没有模型被调用过。')]), ...users),
          panel('告警记录（最近 50 条）', ...(events.length ? events : [note('暂时没有告警。')]))];
      },

      // ── 套餐与授权：目前全部功能向所有人开放，只作介绍 ──
      async plan() {
        const d = await api('GET', '/api/admin/plan');
        const cards = (d.tiers || []).map(t => panel(t.name, note(t.blurb), note('成员 ' + (t.seats || '不限') + '　独立桌面 ' + (t.desktops || '无')),
          ...(d.features || []).filter(f => f.tier === t.id).map(f => h('div', '', '• ' + f.name + (f.status === 'planned' ? '（规划中）' : ''))), (() => { const b = h('button', 'secondary', '即将开放购买'); b.disabled = true; return b; })()));
        return [panel('现在：全部功能向所有人开放', note('目前处于试用期，下面所有版本的功能都可以直接使用，不需要购买，也不需要授权密钥（当前 ' + (d.members || 0) + ' 位成员）。'), note('正式版本发布后会开放购买：到时候按下面的版本分档，可以在线购买，或用授权密钥解锁完整功能。')), ...cards];
      },

      // ── 模型价格 ──
      async pricing() {
        const d = await api('GET', '/api/admin/pricing');
        const sym = value => { const list = SYMBOLS.some(([v]) => v === value) || !value ? SYMBOLS : [...SYMBOLS, [value, value]]; return selectOf(list, value || '¥', () => {}); };
        const base = sym(d.currency), rates = {};
        const rows = (d.models || []).map(m => ({ m, cur: sym((m.price && m.price.currency) || d.currency), input: num(m.price && m.price.input || '', '输入'), output: num(m.price && m.price.output || '', '输出') }));
        const rateBox = h('div', '');
        const drawRates = () => {
          const used = [...new Set(rows.filter(r => r.input.value || r.output.value).map(r => r.cur.value).filter(c => c && c !== base.value))];
          rateBox.replaceChildren(...(used.length ? [note('有模型的货币和统计货币不同，费用合计时需要折算：'), ...used.map(c => { const i = rates[c] || (rates[c] = num(d.rates && d.rates[c] || '', '汇率')); return setRow('1 ' + c + ' =', '折合 ' + base.value, i); })] : []));
        };
        for (const r of rows) for (const el of [r.cur, r.input, r.output]) { el.addEventListener('change', drawRates); el.addEventListener('input', drawRates); }
        base.addEventListener('change', drawRates);
        const status = h('p', 'muted', '');
        const save = btn('保存价格', async () => {
          const models = {}; for (const r of rows) if (r.input.value || r.output.value) models[r.m.ref] = { input: Number(r.input.value || 0), output: Number(r.output.value || 0), currency: r.cur.value };
          const rt = {}; for (const [c, i] of Object.entries(rates)) if (i.value && i.isConnected) rt[c] = Number(i.value);
          const out = await api('PUT', '/api/admin/pricing', { currency: base.value, models, rates: rt }); status.textContent = '已保存（' + out.count + ' 个模型有价格），新产生的用量会按新价格计费';
        });
        const sync = btn('从服务商读取价格', async () => {
          status.textContent = '正在读取…'; const out = await api('POST', '/api/admin/pricing/sync', {}); let n = 0;
          for (const r of rows) { const p = out.prices && out.prices[r.m.ref]; if (!p) continue; r.input.value = p.input; r.output.value = p.output; r.cur.value = p.currency; n++; }
          drawRates(); status.textContent = '读到 ' + n + ' 个模型的价格（还没保存，请检查后点“保存价格”）。' + (out.report || []).map(x => x.name + '：' + x.detail).join('；');
        }, 'secondary');
        const list = rows.map(r => h('div', 'set-row', h('div', 'txt', h('b', '', r.m.label), h('small', '', r.m.providerName || '')), h('span', 'row-actions', r.cur, r.input, r.output)));
        drawRates();
        return [note('大多数官方 API 不会通过接口公布价格，所以这里不内置价格表（避免过期的数字）：服务商在模型列表里提供价格的会自动读取，其余请按你实际的账单单价填写（每百万 Token），并给每个模型选货币符号。改价只影响之后的调用。'),
          setRow('统计货币（合计用）', '', base), h('div', '', sync), ...(list.length ? list : [note('还没有可用的模型，请先添加 AI 接入。')]), rateBox, h('div', '', save), status];
      },

      // ── 站点设置 ──
      async site() {
        const d = await api('GET', '/api/site');
        const name = text(d.name, '站点名称'), notice = area(d.notice, '登录页公告（可选）'), mode = selectOf([['team', '团队模式'], ['personal', '个人模式']], d.mode === 'personal' ? 'personal' : 'team', () => {});
        const save = btn('保存', async () => { await api('PUT', '/api/admin/site', { name: name.value, notice: notice.value, mode: mode.value }); toast('已保存'); });
        return [panel('站点设置', setRow('站点名称', '', name), notice, setRow('使用模式', '个人模式没有成员管理', mode), h('div', '', save))];
      },

      // ── 引擎（原来的页面内容）──
      async engines() { return [engineBox()]; },
    };

    for (const [id, label] of tabs) { const b = h('button', 'secondary', label); b.type = 'button'; b.dataset.id = id; b.onclick = () => show(id); bar.append(b); }
    return show('members');
  };
})();
