// 团队与 API 面板：个人 API 令牌、智能体、成员管理（主账号）。
(() => {
  const $ = s => document.querySelector(s);
  const app = $('#app'), anchor = $('#settings');
  if (!app || !anchor) return;
  let me = null, csrf = '', tab = 'usage', usageMonth = '', agentsCache = [], models = [], loaded = false;

  const el = (tag, props = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v;
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
      else if (v !== undefined && v !== null) node[k] = v;
    }
    node.append(...kids.flat().filter(x => x !== null && x !== undefined && x !== false));
    return node;
  };
  async function api(path, options = {}) {
    const headers = { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) };
    const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
    let data = {}; try { data = await response.json(); } catch { /* 无正文 */ }
    if (!response.ok) throw new Error(data.error || '请求失败：' + response.status);
    return data;
  }
  const fmt = t => t ? new Date(t).toLocaleString() : '—';

  // Cindy 桌面端给出的名称形如“来源 · 模型名 · 引擎”（例如 “Cindy（国外版） · XD Gateway · GPT-6.1 Terra · pi”）。
  // 拆开后：同一个模型只在列表里出现一次，引擎放到第二个下拉里选；普通服务商（没有引擎后缀）保持一个下拉。
  const ENGINE_ORDER = ['claude-code', 'claude', 'codex', 'pi'];
  function parseModel(m) {
    const parts = String(m.label || '').split(' · ').map(x => x.trim()).filter(Boolean);
    if (parts.length >= 3 && /^[a-z][a-z-]{1,20}$/.test(parts[parts.length - 1])) return { source: parts.slice(0, -2).join(' · '), name: parts[parts.length - 2], engine: parts[parts.length - 1] };
    return { source: m.provider === 'default' ? '内置' : m.providerName, name: m.label || m.model, engine: '' };
  }
  function createModelPicker({ defaultText = '默认模型', onChange = () => {} } = {}) {
    const modelSel = el('select', { title: '模型' }), engineSel = el('select', { title: '运行这个模型的引擎', hidden: true });
    let entries = new Map(), lastEngine = '';
    const engineOf = (entry, ref) => (entry.items.find(i => i.ref === ref) || {}).engine || '';
    const current = () => { const entry = entries.get(modelSel.value); if (!entry) return ''; return (entry.items.find(i => i.ref === engineSel.value) || entry.items[0]).ref; };
    const fillEngines = (entry, preferEngine, exactRef) => {
      engineSel.replaceChildren(...entry.items.map(i => el('option', { value: i.ref, textContent: i.engine || '默认' })));
      engineSel.hidden = !entry.items.some(i => i.engine);
      engineSel.disabled = entry.items.length < 2;
      engineSel.value = (exactRef && entry.items.some(i => i.ref === exactRef) ? exactRef : (entry.items.find(i => i.engine && i.engine === preferEngine) || entry.items[0]).ref);
    };
    modelSel.addEventListener('change', () => { const entry = entries.get(modelSel.value); if (entry) fillEngines(entry, lastEngine); else engineSel.hidden = true; onChange(current()); });
    engineSel.addEventListener('change', () => { const entry = entries.get(modelSel.value); if (entry) lastEngine = engineOf(entry, engineSel.value) || lastEngine; onChange(current()); });
    const picker = {
      nodes: [modelSel, engineSel],
      get ref() { return current(); },
      set(ref) {
        for (const [key, entry] of entries) if (entry.items.some(i => i.ref === ref)) { modelSel.value = key; lastEngine = engineOf(entry, ref) || lastEngine; fillEngines(entry, lastEngine, ref); return; }
        modelSel.value = ''; engineSel.hidden = true;
      },
      rebuild(catalog, keepRef) {
        entries = new Map();
        for (const m of catalog) {
          const p = parseModel(m), key = p.source + '\u0001' + p.name;
          if (!entries.has(key)) entries.set(key, { source: p.source, name: p.name, items: [] });
          entries.get(key).items.push({ engine: p.engine, ref: m.ref });
        }
        for (const entry of entries.values()) entry.items.sort((a, b) => (ENGINE_ORDER.indexOf(a.engine) + 1 || 99) - (ENGINE_ORDER.indexOf(b.engine) + 1 || 99));
        const bySource = new Map();
        for (const [key, entry] of [...entries].sort((a, b) => a[1].name.localeCompare(b[1].name, 'zh'))) { if (!bySource.has(entry.source)) bySource.set(entry.source, []); bySource.get(entry.source).push([key, entry]); }
        modelSel.replaceChildren(el('option', { value: '', textContent: defaultText }));
        for (const [source, list] of bySource) { const group = el('optgroup', { label: source }); for (const [key, entry] of list) group.append(el('option', { value: key, textContent: entry.name })); modelSel.append(group); }
        picker.set(keepRef);
      }
    };
    return picker;
  }

  // 设置页面：/settings 是个人设置，/admin/settings 是管理设置；其它地址只放入口按钮。
  const cleanPath = location.pathname.replace(/\/+$/, '');
  const pageMode = cleanPath === '/settings' ? 'member' : cleanPath === '/admin/settings' ? 'admin' : cleanPath === '/market' ? 'market' : cleanPath === '/workspaces' ? 'workspaces' : null;
  const MEMBER_TABS = [['usage', '用量'], ['dashboard', '仪表盘'], ['market', '市场'], ['tokens', 'API 令牌'], ['agents', '智能体'], ['workspaces', '工作区'], ['skills', '技能工坊'], ['bots', '机器人'], ['wallpapers', '壁纸'], ['mail', 'AI 邮箱'], ['cindy', 'Cindy 账号'], ['security', '账号安全'], ['audit', '操作记录']];
  const ADMIN_TABS = [['members', '团队成员'], ['invites', '邀请成员'], ['userskills', '用户技能'], ['providers', 'AI 接入'], ['engines', '智能体引擎'], ['safety', '安全与熔断'], ['plan', '套餐与授权'], ['mcp', 'MCP 服务'], ['voice', '语音识别'], ['tts', '语音朗读'], ['vision', '图片理解'], ['imagegen', '绘画模型'], ['security', '账号安全'], ['site', '站点设置'], ['service', '服务更新'], ['review', '市场审核'], ['desktop', '桌面端'], ['dashboard', '团队仪表盘'], ['audit', '审计与统计'], ['env', '环境检测'], ['doctor', '服务器体检'], ['usage', '团队用量']];
  const PERSONAL_HIDDEN = ['members', 'invites', 'userskills', 'review']; // 个人使用模式下隐藏的团队功能
  const tabsFor = list => (me && me.mode === 'personal') ? list.filter(t => !PERSONAL_HIDDEN.includes(t[0])) : list;
  const MEMBER_GROUPS = [['概览', ['usage', 'dashboard', 'audit']], ['开发与集成', ['tokens', 'agents', 'skills', 'bots']], ['个性化', ['wallpapers']], ['账号', ['cindy', 'security']]];
  const ADMIN_GROUPS = [['成员', ['members', 'invites', 'userskills']], ['模型与引擎', ['providers', 'engines', 'safety', 'plan', 'mcp', 'voice', 'tts', 'vision', 'imagegen', 'desktop']], ['站点', ['security', 'site', 'service', 'review']], ['统计', ['dashboard', 'usage', 'audit', 'env', 'doctor']]];
  const TAB_META = {
    market: ['◇', '技能与机器人市场', '挑选现成的技能和机器人模板，一键安装成你自己的；也可以把自己做的投稿给大家用。'],
    review: ['✔', '市场审核', '审核成员投稿的技能和机器人模板，决定是否上架；可以随时下架。'],
    usage: ['▥', '用量与额度', '查看本月调用次数、Token 和剩余额度；额度用到提醒线时页面顶部会提示。'],
    tokens: ['⚿', 'API 令牌', '在脚本或本地客户端里调用本站的 OpenAI 兼容接口。'],
    agents: ['◉', '智能体', '智能体 = 系统提示词 + 模型 + 技能，可在聊天顶部或 API 里选用。'],
    skills: ['✦', '技能工坊', '可复用的“能力说明”，支持上传 SKILL.md / zip，绑定到智能体后自动生效。'],
    bots: ['⌁', '机器人', '给每个机器人一个 Webhook 地址，把智能体接到你自己的聊天平台或脚本。'],
    workspaces: ['▤', '工作区', '一个项目的文件目录 + 多智能体协作（Claude Code / Codex / Pi 接力、圆桌或主管调度）。选好“谁可以访问”，同事就能一起用。'],
    wallpapers: ['◐', '壁纸', '给聊天界面换个背景，只对你自己生效。'],
    cindy: ['◈', 'Cindy 账号', '绑定 Cindy 官方账号，使用 Cindy 托管的模型、查询余额与订阅。'],
    members: ['☺', '团队成员', '添加成员、设置每日 / 每月额度，停用或重置密码。'],
    userskills: ['❖', '用户技能', '查看每位成员安装和创建的技能（来源、内容、被几个智能体使用），可以移除不合适的技能。每个人的技能互相隔离，只有管理员能在这里看到全部。'],
    invites: ['✉', '邀请成员', '生成邀请链接发给同事，对方自己设置邮箱和密码即可加入。'],
    providers: ['⚙', 'AI 接入', '接入 ChatGPT、DeepSeek、通义等模型服务商，决定哪些模型对成员开放。'],
    tts: ['♫', '语音朗读', '接入语音合成模型，让回复可以朗读、支持语音通话（说话 → 回答 → 朗读），也提供 OpenAI 兼容的语音接口。'],
    vision: ['◫', '图片理解', '让成员上传图片给模型分析；聊天模型不能看图时，用本机或自建的视觉模型 / OCR 服务先识别。'],
    imagegen: ['✎', '绘画模型', '接入文生图模型（OpenAI 兼容 /images/generations），成员在聊天页点 🎨 即可用文字生成图片。'],
    voice: ['♪', '语音识别', '让成员在聊天框里点麦克风说话，自动转成文字；可指定普通话、粤语、四川话等方言。复用“AI 接入”里的服务商。'],
    mcp: ['⛓', 'MCP 服务', '给 Claude Code / Codex / Pi 接入 MCP 工具（网页抓取、数据库、搜索等）。命令在运行器容器里执行，只有管理员能配置。'],
    mail: ['✉', 'AI 邮箱', '绑定你自己的公司邮箱，让 AI 帮你读信、起草回复。AI 只写草稿，发出去必须你本人点“确认发送”。'],
    plan: ['★', '套餐与授权', '目前全部功能向所有人开放；这里介绍各版本的分档，正式版开放购买后可在线购买或用授权密钥解锁。'],
    safety: ['⛨', '安全与熔断', '敏感内容拦截、机密工作区、模型熔断和费用上限；命中时拦截并告警。只记录谁、什么时候、命中什么规则，不记录内容。'],
    engines: ['⌘', '智能体引擎', '配置 Claude Code / Codex / Pi 的密钥、默认模型和允许成员选择的模型。'],
    desktop: ['▭', '桌面端', '在浏览器里打开服务器上的 Cindy 桌面端，用来登录官方账号并向团队提供 Cindy 模型。'],
    dashboard: ['▦', '仪表盘', '把模型调用、Token、文件操作、删除记录做成图表：趋势、占比、排行和时段分布，可导出 CSV / PNG / SVG / JSON，支持深色主题。'],
    audit: ['☰', '操作记录', '按账号查看模型调用、文件操作、删除记录和登录情况，方便排查问题。'],
    env: ['◎', '环境检测', '实时检测服务器到 Claude / ChatGPT / Gemini / DeepSeek 的网络、出口 IP 与地区，评估被限制或封号的风险，并在风险发生前拒绝请求。'],
    doctor: ['✚', '服务器体检', '一键检查服务器：磁盘、内存、权限、HTTPS 与反向代理、模型接入、运行器、DNS、时间同步，以及到 Claude / ChatGPT / Gemini / DeepSeek 的可达性，并给出处理建议。只读，不改任何配置。'],
    security: ['⛨', '账号安全', '设置恢复密钥；忘记密码时用恢复密钥，或用已登录的手机确认，就能登录并改密码。'],
    site: ['⌂', '站点设置', '站点名称、登录页公告、个人/团队模式、默认模型和登录安全策略。'],
    service: ['↻', '服务更新', '查看当前服务版本、更新提醒和安全的升级方法。'],
  };
  const tabLabel = id => (pageMode === 'admin' && id === 'usage') ? '团队用量' : (pageMode === 'admin' && id === 'audit') ? '审计与统计' : (pageMode === 'admin' && id === 'dashboard') ? '团队仪表盘' : ((MEMBER_TABS.concat(ADMIN_TABS).find(t => t[0] === id) || [])[1] || id);
  if (pageMode) document.body.classList.add('settings-page', 'settings-' + pageMode);
  const style = el('style', {});
  style.textContent = `.team-modal{width:min(760px,100%);max-height:92vh;overflow:auto}.team-tabs{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0;border-bottom:1px solid var(--line)}.team-tabs button{border:0;background:none;padding:8px 12px;color:var(--muted);border-bottom:2px solid transparent}.team-tabs button.on{color:var(--ink);border-color:var(--accent)}.team-row{display:flex;gap:10px;align-items:center;justify-content:space-between;border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:8px 0}.team-row small{display:block;color:var(--muted)}.team-row .grow{min-width:0;flex:1;overflow-wrap:anywhere}.team-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:10px 0}.team-form input,.team-form textarea,.team-form select,#agentSelect{border:1px solid var(--line);border-radius:8px;padding:8px;background:transparent;color:var(--ink);min-width:0}.team-form textarea{grid-column:1/-1;min-height:70px}.team-form .wide{grid-column:1/-1}.team-modal textarea{width:100%;min-height:90px;box-sizing:border-box;border:1px solid var(--line);border-radius:8px;padding:8px;background:transparent;color:var(--ink)}.team-row5{display:grid;grid-template-columns:96px minmax(0,1.3fr) minmax(0,1.6fr) 104px auto;gap:8px;align-items:center;margin:6px 0}.team-row5 input,.team-row5 select{border:1px solid var(--line);border-radius:8px;padding:8px;background:transparent;color:var(--ink);min-width:0}@media(max-width:600px){.team-row5{grid-template-columns:1fr}}.team-note{font-size:12px;color:var(--muted);line-height:1.6}.team-secret{background:var(--accent-soft);border:1px solid var(--accent);border-radius:10px;padding:10px;margin:8px 0;overflow-wrap:anywhere;font-family:ui-monospace,Consolas,monospace;font-size:12px}.team-err{color:#c0392b;min-height:18px;font-size:12px}#agentSelect{height:32px;max-width:160px}@media(max-width:600px){.team-form{grid-template-columns:1fr}}`
    + `body.settings-page{height:auto;min-height:100%;background:#f7f7f9}body.settings-page .app{display:none}body.settings-page .modal-backdrop.team-page{position:relative;z-index:1;display:block;background:none;padding:0;min-height:100vh}.team-page .team-modal{width:min(980px,calc(100% - 24px));max-height:none;margin:20px auto 48px;border-radius:16px;box-shadow:0 10px 40px #1f222b1a;background:#fffffff2;padding:20px 22px 28px}.team-pagehead{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:6px}.team-pagehead h2{margin:0;font-size:22px;letter-spacing:-.02em}.team-pagehead a{color:#4a4f5c;text-decoration:none;font-size:13px;font-weight:550}.team-pagehead a:hover{color:var(--accent)}.team-pagehead .sp{flex:1}.team-page .team-tabs{margin-top:14px}`;
  document.head.append(style);
  const pageStyle = el('style', {});
  pageStyle.textContent = "body.settings-page{background:#f4f5f8}\n.team-page .team-modal{width:min(1120px,calc(100% - 32px));margin:22px auto 56px;border-radius:0;box-shadow:none;background:none;padding:0}\n.team-pagehead{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin:0 0 16px;padding:10px 18px;background:rgba(255,255,255,.82);-webkit-backdrop-filter:blur(14px) saturate(1.4);backdrop-filter:blur(14px) saturate(1.4);border:1px solid rgba(255,255,255,.7);border-radius:16px;box-shadow:0 3px 14px rgba(20,24,40,.08)}.team-pagehead h2{margin:0;font-size:22px;letter-spacing:-.02em}.team-pagehead a{color:var(--muted);text-decoration:none;font-size:13px}.team-pagehead a:hover{color:var(--accent)}.team-pagehead .sp{flex:1}\n.team-layout{display:grid;grid-template-columns:216px minmax(0,1fr);gap:18px;align-items:start}\n.team-nav{position:sticky;top:16px;background:#fff;border:1px solid var(--line);border-radius:16px;padding:8px 8px 10px}\n.team-nav h4{margin:12px 10px 4px;font-size:11px;font-weight:650;letter-spacing:.06em;color:#9a9da6}.team-nav h4:first-child{margin-top:6px}\n.team-nav button{display:flex;width:100%;align-items:center;gap:10px;border:0;background:none;padding:9px 10px;border-radius:10px;color:var(--ink);text-align:left;font-size:13.5px}\n.team-nav button:hover{background:#f4f5f7}.team-nav button.on{background:var(--accent-soft);color:var(--accent);font-weight:650}.team-nav .ic{width:18px;text-align:center;color:#8c909b}.team-nav button.on .ic{color:var(--accent)}\n.team-main{background:#fff;border:1px solid var(--line);border-radius:16px;padding:22px 26px 30px;min-height:440px;min-width:0}\n.team-title{margin:0;font-size:20px;letter-spacing:-.01em}.team-desc{margin:5px 0 20px;color:var(--muted);font-size:13px;line-height:1.6}\n.team-main h3{margin:28px 0 12px;padding-top:20px;border-top:1px solid var(--line);font-size:14px}.team-main h3:first-child{margin-top:0;padding-top:0;border-top:0}\n.team-main .team-note{margin:8px 0}.team-main .team-row{border-radius:12px;padding:12px 14px;margin:8px 0;transition:border-color .15s,box-shadow .15s}.team-main .team-row:hover{border-color:#d7dae1;box-shadow:0 2px 10px #1f222b0a}\n.team-main .team-row small{margin-top:2px;line-height:1.55}\n.team-main .team-form input,.team-main .team-form select{height:40px;padding:0 12px;border-radius:10px}.team-main .team-form textarea,.team-main textarea{border-radius:10px;padding:10px 12px;line-height:1.55}\n.team-main .team-form input:focus,.team-main .team-form select:focus,.team-main textarea:focus{outline:none;border-color:#df9ca4;box-shadow:0 0 0 3px #e951641c}\n.team-main .secondary{height:36px;padding:0 14px;border-radius:9px;font-size:13px;border:1px solid var(--line);background:#fff;color:var(--ink)}.team-main .secondary:hover{border-color:#cfd2da;background:#fafafb}.team-main .secondary:disabled{opacity:.55;cursor:not-allowed}\n.team-main .secondary.wide{height:40px;font-weight:600}.team-main .team-form>.secondary.wide:nth-last-child(2),.team-main .team-form>.secondary.wide:last-child{}\n.team-main code{background:#f3f4f7;border-radius:6px;padding:1px 6px;font-size:12px}.team-code{margin:12px 0;padding:12px 14px;border-radius:10px;background:#16181f;color:#d9dbe3;font:12px/1.65 ui-monospace,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}\n.team-empty{margin:10px 0;padding:22px;border:1px dashed var(--line);border-radius:12px;text-align:center;color:var(--muted);font-size:13px}\n.team-secret{border-radius:12px}.team-err:empty{display:none}.team-err{margin:8px 0}\n@media(max-width:860px){.team-layout{grid-template-columns:minmax(0,1fr)}.team-nav{position:static;display:flex;gap:4px;overflow-x:auto;padding:6px;scrollbar-width:none}.team-nav::-webkit-scrollbar{display:none}.team-nav h4{display:none}.team-nav button{width:auto;flex:none;white-space:nowrap;padding:8px 12px}.team-nav .ic{display:none}.team-main{padding:18px 16px 24px}}";
  document.head.append(pageStyle);
  const glassStyle = el('style', {});
  glassStyle.textContent = ".team-main input[type=checkbox],.team-main input[type=radio]{width:16px;height:16px;padding:0;flex:none;accent-color:#e95164}.team-main input[type=file],.team-main input[type=range]{height:auto;padding:0;border:0;background:none}.team-main label{display:inline-flex;align-items:center;gap:7px;min-height:32px}.team-main .team-form>label{display:flex}\n.team-nav,.team-main{-webkit-backdrop-filter:blur(16px) saturate(1.35);backdrop-filter:blur(16px) saturate(1.35);border-color:rgba(255,255,255,.65)}\n.team-nav{background:rgba(255,255,255,.62);box-shadow:0 3px 14px rgba(20,24,40,.08)}\n.team-main{background:rgba(255,255,255,.72);box-shadow:0 3px 14px rgba(20,24,40,.08)}\n.team-main .team-row{background:rgba(255,255,255,.66)}.team-main .team-row:hover{background:rgba(255,255,255,.86)}\n.team-main .secondary{background:rgba(255,255,255,.75)}.team-main .secondary:hover{background:#fff}\n.team-main .team-form input,.team-main .team-form select,.team-main .team-form textarea,.team-main textarea{background:rgba(255,255,255,.8)}\n.team-nav button:hover{background:rgba(255,255,255,.7)}.team-nav button.on{background:rgba(255,240,242,.92)}\n@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){.team-nav{background:rgba(255,255,255,.94)}.team-main{background:rgba(255,255,255,.96)}}\n.team-row .grow,.team-row small{overflow-wrap:anywhere;word-break:break-word}.team-row .grow{min-width:0}\n.team-row>button,.team-row>a{flex:none;white-space:nowrap}\n@media(max-width:640px){\n.team-main .team-row{flex-direction:column;align-items:stretch;gap:10px}\n.team-main .team-row>.grow{flex:none;width:100%}\n.team-main .team-row>button,.team-main .team-row>a{align-self:flex-start}\n.team-main .team-row>div:not(.grow){display:flex;flex-wrap:wrap;gap:6px;width:100%}\n.team-main .team-row .secondary,.team-main .team-row a.secondary{flex:0 0 auto;width:auto}\n.team-pagehead{padding:10px 14px;gap:8px 12px}.team-pagehead h2{font-size:19px}.team-pagehead .sp{display:none}.team-pagehead a:last-child{margin-left:auto}\n.team-main{padding:16px 14px 22px;border-radius:14px}.team-title{font-size:18px}\n.team-form{grid-template-columns:minmax(0,1fr)}.team-form .wide,.team-form textarea{grid-column:auto}\n.team-main .secondary.wide,.team-main .team-form>.secondary{width:100%}\n.team-code{font-size:11.5px}\n}";
  document.head.append(glassStyle);
  const marketStyle = el('style', {});
  marketStyle.textContent = ".settings-market .team-modal,.settings-workspaces .team-modal{width:min(1240px,calc(100% - 32px))}.team-switch{display:flex;gap:6px;flex-wrap:wrap}.team-switch a{padding:6px 14px;border-radius:99px;font-size:13px;background:rgba(0,0,0,.05)}.team-switch a.on{background:var(--accent-soft);color:var(--accent)!important;font-weight:650}.mk-badge.external{background:#fff4e0;color:#9a5b00}.mk-filter{height:40px;margin:0 0 14px 10px;padding:0 12px;border:1px solid var(--line);border-radius:10px;background:rgba(255,255,255,.8);color:var(--ink)}.mk-tools{display:flex;gap:0;flex-wrap:wrap;align-items:flex-start}.mk-tools .mk-search{flex:1 1 220px;width:auto}\n.mk-seg{display:inline-flex;gap:4px;padding:4px;border-radius:12px;background:rgba(0,0,0,.05);margin:0 0 14px;max-width:100%;overflow-x:auto}\n.mk-seg button{border:0;background:none;padding:7px 14px;border-radius:9px;font-size:13px;color:var(--ink);white-space:nowrap}.mk-seg button.on{background:#fff;color:var(--accent);font-weight:650;box-shadow:0 1px 6px rgba(20,24,40,.12)}\n.mk-search{width:100%;height:40px;margin:0 0 14px;padding:0 14px;border:1px solid var(--line);border-radius:10px;background:rgba(255,255,255,.8);color:var(--ink)}.mk-search:focus{outline:none;border-color:#df9ca4;box-shadow:0 0 0 3px #e951641c}\n.mk-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px}\n.mk-card{display:flex;flex-direction:column;gap:8px;padding:14px;border:1px solid var(--line);border-radius:14px;background:rgba(255,255,255,.7);min-width:0}.mk-card:hover{border-color:#d7dae1;box-shadow:0 4px 16px rgba(20,24,40,.08)}\n.mk-top{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.mk-top strong{font-size:14px;overflow-wrap:anywhere}\n.mk-badge{flex:none;padding:2px 8px;border-radius:99px;font-size:11px;background:#eef0f4;color:#5a5f6c}.mk-badge.official{background:var(--accent-soft);color:var(--accent)}\n.mk-desc{margin:0;font-size:12.5px;line-height:1.6;color:#4a4f5c;flex:1}.mk-tags{display:flex;flex-wrap:wrap;gap:5px}.mk-tags span{padding:1px 8px;border-radius:99px;background:rgba(0,0,0,.05);font-size:11px;color:#5a5f6c}\n.mk-meta{font-size:11px;color:var(--muted)}.mk-actions{display:flex;gap:8px;margin-top:2px}.mk-actions .mk-install{margin-left:auto}\n.mk-preview{margin:4px 0 0;padding:10px 12px;border-radius:10px;background:rgba(127,127,140,.1);color:inherit;font:13.5px/1.75 inherit;white-space:pre-wrap;overflow-wrap:anywhere;max-height:260px;overflow:auto}\n.team-secret{white-space:pre-wrap}.bal-card{margin-top:8px;padding:10px 12px;border-radius:12px;background:rgba(0,0,0,.04);font-size:12px}.bal-main{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}.bal-main b{font-size:22px;line-height:1.2}.bal-bar{height:6px;border-radius:99px;background:rgba(0,0,0,.08);overflow:hidden;margin:3px 0 7px}.bal-bar i{display:block;height:100%;border-radius:99px;background:var(--accent,#e95164)}.bal-row{display:flex;justify-content:space-between;gap:8px;color:var(--muted)}.bal-low b{color:#c0392b}.acct-bal{margin:2px 10px 6px;padding:6px 10px;border-radius:10px;background:rgba(0,0,0,.05);font-size:12px;line-height:1.6}.acct-bal b{font-size:15px}.mk-dlg-back{position:fixed;inset:0;z-index:70;background:#10121a8c;display:grid;place-items:center;padding:18px}.mk-dlg{width:min(860px,100%);max-height:88vh;display:flex;flex-direction:column;background:var(--ym-card,#fff);color:var(--ink,#252832);border:1px solid var(--line,#e7e8ec);border-radius:16px;box-shadow:0 24px 60px #0000004d;overflow:hidden}.mk-dlg-head{display:flex;align-items:flex-start;gap:12px;padding:16px 18px 10px}.mk-dlg-head h3{margin:0;font-size:16px}.mk-dlg-head small{display:block;color:var(--muted);margin-top:2px}.mk-dlg-body{padding:0 18px 16px;overflow:auto;flex:1}.mk-dlg-body .mk-preview{max-height:none;margin:0}.mk-name{cursor:pointer;font-weight:650;color:var(--accent,#e95164)}.mk-name:hover{text-decoration:underline}.mk-sec{margin:0 0 10px;font-size:14px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere}.mk-trans{font-size:12px;color:#6b7080;margin:0 0 8px}.mk-dlg-foot{display:flex;justify-content:flex-end;gap:8px;padding:10px 18px 14px;border-top:1px solid var(--line,#e7e8ec)}.mk-banner{padding:10px 12px;border-radius:10px;background:#eaf6ef;color:#1f6b45;border:1px solid #c9e8d6}\n@media(max-width:640px){.mk-grid{grid-template-columns:minmax(0,1fr)}}";
  document.head.append(marketStyle);

  const button = el('button', { class: 'icon-button', id: 'teamButton', type: 'button', title: '团队与 API', ariaLabel: '团队与 API', textContent: '⌘', on: { click: () => { if (pageMode) open(); else location.href = '/settings'; } } });
  const agentSelect = el('select', { id: 'agentSelect', title: '新对话使用的智能体', on: { change: () => { window.yumeiroAgentId = agentSelect.value; } } });
  const modelPick = createModelPicker({ onChange: ref => {
    window.yumeiroModel = ref;
    // 通知桌宠：切换模型 = 让她和新的“模型角色”打招呼（见 pet.js）
    try { window.dispatchEvent(new CustomEvent('yumeiro:model-change', { detail: { ref, name: modelSelect.selectedOptions[0]?.textContent || '', engine: engineSelect.hidden ? '' : (engineSelect.selectedOptions[0]?.textContent || '') } })); } catch { /* 不影响选模型 */ }
  } });
  const [modelSelect, engineSelect] = modelPick.nodes;
  modelSelect.id = 'modelSelect'; modelSelect.title = '新对话使用的模型'; engineSelect.id = 'engineSelect';
  const picks = $('#composerPicks');
  if (picks) picks.append(modelSelect, engineSelect, agentSelect); else anchor.before(agentSelect, modelSelect, engineSelect);
  anchor.before(button);
  const adminButton = el('button', { class: 'icon-button', id: 'adminSettingsButton', type: 'button', title: '管理设置', ariaLabel: '管理设置', hidden: true, textContent: '⚙', on: { click: () => { location.href = '/admin/settings'; } } });
  anchor.before(adminButton);
  const selectStyle = el('style', {});
  selectStyle.textContent = '';
  document.head.append(selectStyle);
  async function loadModels() {
    try {
      const data = await api('/api/models'), keep = window.yumeiroModel || '';
      modelPick.rebuild(data.models, keep);
      window.yumeiroModel = modelPick.ref; window.yumeiroCatalog = data.models;
    } catch { /* 未登录时忽略 */ }
  }

  // ---- 侧边栏：可收成窄条 + 入口列表 + 搜索对话 ----
  const sidebar = $('.sidebar'), appRoot = $('#app');
  if (sidebar && appRoot && !pageMode) {
    const sideStyle = el('style', {});
    sideStyle.textContent = "@media(min-width:761px){.menu{display:block}\n.app{transition:grid-template-columns .22s ease}.app.side-collapsed{grid-template-columns:68px minmax(0,1fr)}\n.app.side-collapsed .sidebar{padding:16px 10px 12px;align-items:center;overflow:visible}\n.app.side-collapsed .brand{padding:3px 0 14px;justify-content:center;width:100%}.app.side-collapsed .brand-name,.app.side-collapsed .tag,.app.side-collapsed .side-collapse{display:none}\n.app.side-collapsed .brand-mark{cursor:pointer}\n.app.side-collapsed .new{width:44px;height:44px;padding:0;justify-content:center;font-size:0;gap:0}.app.side-collapsed .new .plus{font-size:20px}\n.app.side-collapsed .label,.app.side-collapsed .chat-list,.app.side-collapsed .side-search{display:none!important}\n.app.side-collapsed .side-nav{width:100%;align-items:center}.app.side-collapsed .side-item{width:44px;height:44px;padding:0;justify-content:center}.app.side-collapsed .side-item .sl{display:none}\n.app.side-collapsed .profile{margin:8px 0 0;padding:8px;justify-content:center;width:auto}.app.side-collapsed .profile-info,.app.side-collapsed .acct-caret{display:none}\n.app.side-collapsed .acct-pop{left:calc(100% + 10px);right:auto;bottom:0;width:236px}\n}\n.side-nav{display:flex;flex-direction:column;gap:2px;margin:10px 0 2px}\n.side-item{display:flex;align-items:center;gap:12px;border:0;background:none;color:#d4d5db;padding:9px 12px;border-radius:10px;font-size:14px;text-align:left}\n.side-item:hover{background:rgba(255,255,255,.09);color:#fff}.side-item .si{display:grid;place-items:center;width:20px;height:20px;flex:none;opacity:.9}\n.side-search{margin:6px 2px 2px;height:36px;padding:0 12px;border-radius:10px;border:1px solid #3c3e49;background:rgba(255,255,255,.07);color:#fff;font-size:13px}.side-search:focus{outline:none;border-color:#e95164}.side-search::placeholder{color:#9599a5}\n.sidebar .brand .tag{display:none}.side-collapse{margin-left:auto;border:0;background:none;color:#9599a5;font-size:16px;line-height:1;padding:4px 6px;border-radius:8px}.side-collapse:hover{background:rgba(255,255,255,.1);color:#fff}\nbody.has-wallpaper .sidebar{background:rgba(16,18,26,.42);-webkit-backdrop-filter:blur(20px) saturate(1.3);backdrop-filter:blur(20px) saturate(1.3);border-right:1px solid rgba(255,255,255,.12)}\nbody.has-wallpaper .sidebar .new{background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.18)}body.has-wallpaper .sidebar .new:hover{background:rgba(255,255,255,.2)}\nbody.has-wallpaper .sidebar .chat:hover,body.has-wallpaper .sidebar .chat.active{background:rgba(255,255,255,.16)}\nbody.has-wallpaper .sidebar .label,body.has-wallpaper .sidebar .empty-list{color:rgba(255,255,255,.62)}body.has-wallpaper .sidebar .tag{border-color:rgba(255,255,255,.28)}\nbody.has-wallpaper .side-item{color:#f2f3f6}body.has-wallpaper .profile:hover,body.has-wallpaper .profile[aria-expanded=true]{background:rgba(255,255,255,.14)}\nbody.has-wallpaper .side-search{border-color:rgba(255,255,255,.22);background:rgba(255,255,255,.1)}";
    document.head.append(sideStyle);
    const icon = path => '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
    const ICONS = {
      search: icon('<circle cx="11" cy="11" r="6"/><path d="M20 20l-4-4"/>'),
      market: icon('<path d="M5 8h14l-1 12H6L5 8z"/><path d="M9 8V6a3 3 0 016 0v2"/>'),
      agents: icon('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z"/>'),
      workspaces: icon('<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>'),
      settings: icon('<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>')
    };
    const KEY = 'yumeiro.sidebar';
    const setCollapsed = on => { appRoot.classList.toggle('side-collapsed', on); try { localStorage.setItem(KEY, on ? 'collapsed' : 'open'); } catch { /* 隐私模式 */ } };
    let saved = ''; try { saved = localStorage.getItem(KEY) || ''; } catch { /* 隐私模式 */ }
    appRoot.classList.toggle('side-collapsed', saved === 'collapsed');
    const isDesktop = () => window.matchMedia('(min-width: 761px)').matches;

    // 品牌行：« 收起；收起后点 C 图标展开；顶栏的菜单按钮在桌面宽度下也用来收起/展开
    const brand = sidebar.querySelector('.brand');
    brand?.append(el('button', { type: 'button', class: 'side-collapse', title: '收起侧边栏', ariaLabel: '收起侧边栏', textContent: '«', on: { click: () => setCollapsed(true) } }));
    brand?.querySelector('.brand-mark')?.addEventListener('click', () => { if (appRoot.classList.contains('side-collapsed') && isDesktop()) setCollapsed(false); });
    $('#menu')?.addEventListener('click', e => { if (isDesktop()) { e.stopImmediatePropagation(); setCollapsed(!appRoot.classList.contains('side-collapsed')); } }, true);

    // 搜索对话
    const search = el('input', { type: 'search', class: 'side-search', placeholder: '搜索对话…', hidden: true });
    const chatList = $('#chatList');
    const applyFilter = () => { const q = search.value.trim().toLowerCase(); chatList?.querySelectorAll('.chat').forEach(row => { row.hidden = Boolean(q) && !(row.querySelector('.chat-title')?.textContent || '').toLowerCase().includes(q); }); };
    search.addEventListener('input', applyFilter);
    if (chatList) new MutationObserver(applyFilter).observe(chatList, { childList: true });
    search.addEventListener('keydown', e => { if (e.key === 'Escape') { search.value = ''; applyFilter(); search.hidden = true; } });

    // 点击导航项会高亮（“搜索对话”展开期间一直高亮，其它项高亮一小会儿，因为它们会打开别的页面 / 面板）
    const item = (key, label, run) => {
      const btn = el('button', { type: 'button', class: 'side-item', 'data-key': key, title: label, on: { click: () => {
        btn.classList.add('active'); run();
        if (key === 'search') btn.classList.toggle('active', typeof search !== 'undefined' && !search.hidden);
        else setTimeout(() => btn.classList.remove('active'), 900);
      } } }, el('span', { class: 'si', innerHTML: ICONS[key] }), el('span', { class: 'sl', textContent: label }));
      btn.dataset.key = key;   // 用 dataset 写成真正的 data-key 属性（el() 的属性写法不一定会生成它）
      return btn;
    };
    const go = tab => () => { openSettingsPanel(tab || 'usage', tab === 'agents' ? 'agents' : 'settings'); };
    const nav = el('nav', { class: 'side-nav', ariaLabel: '快捷入口' },
      item('search', '搜索对话', () => { if (appRoot.classList.contains('side-collapsed') && isDesktop()) setCollapsed(false); search.hidden = !search.hidden || false; if (!search.hidden) search.focus(); else { search.value = ''; applyFilter(); } }),
      item('market', '市场', () => openMarketPanel()), item('agents', '智能体', () => openSettingsPanel('agents', 'agents')), item('settings', '设置', () => openSettingsPanel('usage', 'settings')));
    const newChat = sidebar.querySelector('.new');
    newChat?.after(nav); nav.after(search);
  }

  // ---- 左下角账号卡片：顶栏零散的按钮（设置、管理、改密码、退出）收进来 ----
  const profile = $('.profile');
  if (profile && !pageMode) {
    const acctStyle = el('style', {});
    acctStyle.textContent = [
      'body.acct-menu #teamButton,body.acct-menu #adminSettingsButton,body.acct-menu #adminPanelButton,body.acct-menu #settings,body.acct-menu #logout{display:none!important}',
      '.profile{position:relative;cursor:pointer;border-radius:12px;border-top-color:transparent;padding:10px 8px 8px;margin:8px -4px 0;transition:background .15s}.profile:hover,.profile[aria-expanded=true]{background:#232630}',
      '.profile:focus-visible{outline:2px solid #e95164;outline-offset:2px}.acct-caret{margin-left:auto;color:#9599a5;font-size:13px;transition:transform .15s}.profile[aria-expanded=true] .acct-caret{transform:rotate(180deg)}',
      '.acct-pop{position:absolute;left:0;right:0;bottom:calc(100% + 8px);z-index:30;background:#232630;color:#f2f3f6;border:1px solid #3c3e49;border-radius:14px;padding:6px;box-shadow:0 18px 50px #0007;cursor:default}',
      '.acct-head{padding:10px 10px 8px}.acct-name{font-size:13px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.acct-sub{font-size:11px;color:#9599a5;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.acct-item{width:100%;display:flex;align-items:center;gap:10px;border:0;background:none;color:inherit;text-align:left;padding:9px 10px;border-radius:9px;font-size:13px}.acct-item:hover,.acct-item:focus-visible{background:#2f3340;outline:none}',
      '.acct-item.danger{color:#ff8a98}.acct-ic{width:18px;text-align:center;color:#b7bac5}.acct-item.danger .acct-ic{color:inherit}.acct-sep{height:1px;background:#343846;margin:5px 4px}'
    ].join('');
    document.head.append(acctStyle);
    document.body.classList.add('acct-menu');
    const pop = el('div', { class: 'acct-pop', hidden: true, role: 'menu' });
    profile.setAttribute('role', 'button'); profile.setAttribute('aria-haspopup', 'menu'); profile.setAttribute('aria-expanded', 'false'); profile.tabIndex = 0; profile.title = '账号菜单';
    profile.append(el('span', { class: 'acct-caret', textContent: '⌃' }), pop);
    const close = () => { pop.hidden = true; profile.setAttribute('aria-expanded', 'false'); };
    const trigger = id => document.getElementById(id)?.click();
    const item = (icon, text, run, danger) => el('button', { type: 'button', class: 'acct-item' + (danger ? ' danger' : ''), role: 'menuitem', on: { click: e => { e.stopPropagation(); close(); run(); } } }, el('span', { class: 'acct-ic', textContent: icon }), el('span', { textContent: text }));
    const openMenu = async () => {
      try { await refreshSession(); } catch { /* 下面按未登录处理 */ }
      if (!me) return;
      const balBox = el('div', { class: 'acct-bal', hidden: true });
      pop.replaceChildren(
        el('div', { class: 'acct-head' }, el('div', { class: 'acct-name', textContent: me.displayName || me.email }), el('div', { class: 'acct-sub', textContent: (me.role === 'admin' ? '主账号 · ' : '成员 · ') + me.email })),
        balBox,
        me.role === 'admin' && item('⚙', '管理设置', () => { location.href = '/admin/settings'; }),
        me.role === 'admin' && item('▤', '管理面板', () => trigger('adminPanelButton')),
        el('div', { class: 'acct-sep' }),
        item('✎', '修改密码', () => trigger('settings')),
        item('↪', '退出登录', () => trigger('logout'), true));
      pop.hidden = false; profile.setAttribute('aria-expanded', 'true');
      pop.querySelector('.acct-item')?.focus({ preventScroll: true });
      // 菜单里顺手显示已绑定 Cindy 账号的可用额度（最多 3 个，1 分钟内复用缓存）
      api('/api/cindy/accounts').then(async ({ accounts }) => {
        const list = accounts.filter(a => !a.needsRebind).slice(0, 3); if (!list.length) return;
        balBox.hidden = false; balBox.textContent = 'Cindy 余额：查询中…';
        const rows = await Promise.all(list.map(async a => { try { const { available } = billingSummary(await fetchBilling(a.id)); return (a.displayName || a.email || 'Cindy') + '　' + (available == null ? '—' : fmtNum(available)); } catch { return (a.displayName || a.email || 'Cindy') + '　查询失败'; } }));
        balBox.replaceChildren(el('div', { textContent: 'Cindy 可用额度' }), ...rows.map(t => el('div', { textContent: t })));
      }).catch(() => { balBox.hidden = true; });
    };
    profile.addEventListener('click', () => { if (pop.hidden) openMenu(); else close(); });
    profile.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === profile) { e.preventDefault(); profile.click(); } });
    document.addEventListener('click', e => { if (!pop.hidden && !profile.contains(e.target)) close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !pop.hidden) { close(); profile.focus(); } });
  }

  const backdrop = el('div', { class: 'modal-backdrop' + (pageMode ? ' team-page' : ''), hidden: true });
  const box = el('div', { class: 'modal team-modal', role: 'dialog', ariaLabel: '团队与 API' });
  backdrop.append(box); document.body.append(backdrop);
  backdrop.addEventListener('click', e => { if (e.target === backdrop && !pageMode) backdrop.hidden = true; });

  async function refreshSession() {
    const data = await api('/api/auth/session');
    me = data.authenticated ? data : null; csrf = data.csrfToken || '';
    adminButton.hidden = !(me && me.role === 'admin');
  }
  async function loadAgents() {
    try {
      const data = await api('/api/agents');
      agentsCache = data.agents; models = data.models;
      const keep = window.yumeiroAgentId || '';
      agentSelect.replaceChildren(el('option', { value: '', textContent: '默认 Yumeiro' }), ...agentsCache.map(a => el('option', { value: a.id, textContent: a.name + (a.shared ? '（共享）' : '') })));
      agentSelect.value = agentsCache.some(a => a.id === keep) ? keep : '';
      window.yumeiroAgentId = agentSelect.value;
    } catch { /* 未登录时忽略 */ }
  }
  // 额度提醒条：用量达到提醒线（默认 80%）时显示；每个提醒在本次浏览器会话里可关闭一次，升到“已用尽”会再次出现。
  const banner = el('div', { class: 'quota-banner', hidden: true, role: 'status' });
  const topbar = $('.topbar');
  if (topbar) topbar.after(banner);
  const bannerStyle = el('style', {});
  bannerStyle.textContent = '.quota-banner{display:flex;gap:10px;align-items:center;justify-content:space-between;padding:8px 16px;font-size:13px;border-bottom:1px solid var(--line);background:#fff7e6;color:#8a5a00}.quota-banner.exceeded{background:#fdecea;color:#a12a1f}.quota-banner button{border:0;background:none;color:inherit;text-decoration:underline;padding:2px 4px}.quota-banner .acts{display:flex;gap:8px;flex:none}';
  document.head.append(bannerStyle);
  const updateBanner = el('div', { class: 'service-update-banner', hidden: true, role: 'status' });
  if (topbar) topbar.after(updateBanner); else document.body.prepend(updateBanner);
  const updateStyle = el('style', {});
  updateStyle.textContent = '.service-update-banner{display:flex;gap:10px;align-items:center;justify-content:space-between;padding:9px 16px;font-size:13px;border-bottom:1px solid #e3b7bd;background:#fff0f2;color:#9d2637}.service-update-banner .acts{display:flex;gap:8px;align-items:center;flex:none}.service-update-banner a,.service-update-banner button{border:0;background:none;color:inherit;text-decoration:underline;padding:2px 4px;cursor:pointer}.service-update-banner button{font:inherit}';
  document.head.append(updateStyle);
  async function refreshServiceUpdateAlert() {
    if (!me || me.role !== 'admin') { updateBanner.hidden = true; return; }
    try {
      const info = await api('/api/admin/service-update');
      if (!info.updateAvailable || !info.latestVersion || sessionStorage.getItem('service-update-dismiss:' + info.latestVersion)) { updateBanner.hidden = true; return; }
      updateBanner.replaceChildren(
        el('span', { textContent: `发现 Yumeiro 新版本 ${info.latestVersion}（当前 ${info.currentVersion}），建议先备份再更新。` }),
        el('span', { class: 'acts' },
          info.releaseUrl ? el('a', { href: info.releaseUrl, target: '_blank', rel: 'noopener noreferrer', textContent: '查看发布页' }) : null,
          info.asset ? el('button', { type: 'button', textContent: '一键更新', style: 'font-weight:650', on: { click: () => installLatestUpdate(info) } }) : null,
          el('button', { type: 'button', textContent: '去更新 →', style: 'font-weight:650', on: { click: () => { location.href = '/admin/settings?tab=service'; } } }),
          el('button', { type: 'button', textContent: '知道了', on: { click: () => { sessionStorage.setItem('service-update-dismiss:' + info.latestVersion, '1'); updateBanner.hidden = true; } } })));
      updateBanner.hidden = false;
    } catch { updateBanner.hidden = true; }
  }
  const month = () => new Date().toISOString().slice(0, 7);
  async function refreshAlerts() {
    try {
      const data = await api('/api/usage/me');
      const fresh = (data.alerts || []).filter(a => !sessionStorage.getItem(`quota-dismiss:${a.key}:${a.level}:${month()}`));
      if (!fresh.length) { banner.hidden = true; return; }
      const exceeded = fresh.some(a => a.level === 'exceeded');
      banner.className = 'quota-banner' + (exceeded ? ' exceeded' : '');
      banner.replaceChildren(
        el('span', { textContent: (exceeded ? '额度已用尽：' : '额度提醒：') + fresh.map(a => `${a.label}已用 ${a.percent}%（${a.used.toLocaleString()} / ${a.limit.toLocaleString()}）`).join('；') + (exceeded ? '，新的请求会被拒绝，请联系主账号。' : '，接近主账号设置的上限。') }),
        el('span', { class: 'acts' },
          el('button', { type: 'button', textContent: '查看用量', on: { click: () => { if (pageMode) { tab = 'usage'; open(); } else openSettingsPanel('usage', 'settings'); } } }),
          el('button', { type: 'button', textContent: '知道了', on: { click: () => { for (const a of fresh) sessionStorage.setItem(`quota-dismiss:${a.key}:${a.level}:${month()}`, '1'); banner.hidden = true; } } })));
      banner.hidden = false;
    } catch { /* 未登录或服务暂不可用时不打扰 */ }
  }
  // 每次对话请求结束后刷新（流式响应读完才会 resolve clone().text()）。
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const response = await nativeFetch(input, init);
    const url = typeof input === 'string' ? input : input?.url || '';
    if (/\/api\/chat(\/stream)?$/.test(url.split('?')[0])) response.clone().text().then(refreshAlerts, () => {});
    return response;
  };
  const bootDone = () => document.documentElement.classList.remove('settings-boot');
  // 只有设置页要靠这个兜底；首页由登录检查自己决定显示登录还是对话，不能到点就把登录页露出来（会先闪登录页再跳回对话）
  if (pageMode) setTimeout(bootDone, 5000);
  let ticking = false;
  const tick = async () => { if (ticking) return; ticking = true; try { await tickOnce(); } finally { ticking = false; } };
  const tickOnce = async () => {
    // 设置页不等首页脚本的“app 是否显示”，直接问服务器有没有登录，避免先闪一下登录页
    if (pageMode && loaded) return;
    if (pageMode) { try { await refreshSession(); } catch { /* 下面按未登录处理 */ } if (!me) { bootDone(); return; } }
    else if (app.hidden) { loaded = false; banner.hidden = true; try { wallLayer.hidden = true; } catch { /* 首次执行时壁纸层还没创建 */ } document.body.classList.remove('has-wallpaper'); return; }
    if (loaded) return;
    loaded = true;
    if (!pageMode) { const wall = loadWallpaper(); await refreshSession(); await wall; window.dispatchEvent(new Event('ym:home-ready')); await loadAgents(); await loadModels(); await refreshAlerts(); await refreshServiceUpdateAlert(); }
    else { loadWallpaper(); }
    // 第三方登录回到本站后（?panel=cindy）直接打开“Cindy 账号”面板；带 cindy_select/cindy_error 时留给绑定表单处理后再清理地址
    const params = new URLSearchParams(location.search);
    if (!pageMode) {
      // 个人设置 / 智能体 / 市场都在首页里打开（旧的 /settings、/market 地址会跳回这里），不再在两个页面之间来回跳
      if (params.get('panel') === 'cindy' && me) openSettingsPanel('cindy', 'settings');      // 保留地址里的参数：绑定表单要读它们
      else if (params.get('panel') === 'settings' && me) { const t = params.get('tab') || 'usage'; if (!params.has('cindy_select') && !params.has('cindy_error')) history.replaceState(null, '', location.pathname); openSettingsPanel(t, t === 'agents' ? 'agents' : 'settings'); }
      else if (params.get('panel') === 'market' && me) { history.replaceState(null, '', location.pathname); openMarketPanel(); }
      return;
    }
    if (pageMode === 'workspaces') { location.replace('/'); return; }
    if (pageMode === 'market') { location.replace('/?panel=market'); return; }
    if (me && pageMode === 'admin' && me.role !== 'admin') { location.replace('/?panel=settings'); return; }
    const want = params.get('tab') || (params.get('panel') === 'cindy' ? 'cindy' : '');
    // 市场、工作区已经是独立页面：旧的 /settings?tab=market 之类的链接自动跳过去
    if (pageMode === 'member') { location.replace(want === 'market' ? '/?panel=market' : want === 'workspaces' ? '/' : '/?panel=settings' + (params.toString() ? '&' + params.toString().replace(/^panel=[^&]*&?/, '') : '')); return; }
    const list = tabsFor(pageMode === 'admin' ? ADMIN_TABS : MEMBER_TABS);
    tab = (pageMode === 'market' || pageMode === 'workspaces') ? pageMode : list.some(([id]) => id === want) ? want : list[0][0];
    if (params.has('panel') && !params.has('cindy_select') && !params.has('cindy_error')) history.replaceState(null, '', location.pathname + '?tab=' + tab);
    // 设置页：先把页面画出来；智能体/模型列表在后台并行加载，只有用到它们的标签才等一下
    const pre = Promise.all([loadAgents(), loadModels(), refreshAlerts(), refreshServiceUpdateAlert()]).catch(() => {});
    if (['agents', 'workspaces', 'bots', 'providers', 'engines'].includes(tab)) await pre;
    if (me) await open();
    bootDone();
  };
  // 首页：登录检查一通过就立刻开始加载壁纸和账号信息，不用等下一个 1 秒的轮询
  window.addEventListener('ym:app-shown', () => { if (!pageMode) tick(); });
  tick(); setInterval(tick, pageMode ? 400 : 1000);
  setInterval(() => { if (me?.role === 'admin') refreshServiceUpdateAlert(); }, 10 * 60 * 1000);

  // “智能体”“设置”直接在首页上层打开（不再跳到 /settings 页面）；打开期间对应的导航项保持高亮
  function setNavCurrent(key) { document.querySelectorAll('.side-item[data-key=agents],.side-item[data-key=settings]').forEach(b => b.classList.toggle('current', b.dataset.key === key)); }
  async function openModalTab(target) {
    if (typeof closeMarketPanel === 'function') closeMarketPanel();
    tab = target; setNavCurrent(target === 'agents' ? 'agents' : 'settings'); await open();
    if (backdrop.hidden) setNavCurrent('');
  }
  new MutationObserver(() => { if (backdrop.hidden) setNavCurrent(''); }).observe(backdrop, { attributes: true, attributeFilter: ['hidden'] });
  async function open() {
    await refreshSession();
    if (!me) return;
    backdrop.hidden = false; await render();
  }
  async function render() {
    // 在首页面板里时（homeSettings 不为空）按“个人设置”的分组导航布局渲染；市场、工作区已经在首页里，不重复出现；管理设置不放进首页
    const inHome = Boolean(homeSettings), mode = inHome ? 'member' : pageMode, host = inHome ? homeSettings : box;
    const tabs = tabsFor(inHome ? MEMBER_TABS.filter(t => t[0] !== 'market' && t[0] !== 'workspaces') : pageMode === 'admin' ? ADMIN_TABS : pageMode ? MEMBER_TABS : [...MEMBER_TABS, ...(me.role === 'admin' ? ADMIN_TABS.filter(t => t[0] !== 'usage' && t[0] !== 'security' && t[0] !== 'audit' && t[0] !== 'dashboard') : [])]);
    if ((pageMode || inHome) && !tabs.some(([id]) => id === tab)) tab = tabs[0][0];
    const body = flatBox();
    const switchTab = id => { tab = id; if (pageMode && !inHome) history.replaceState(null, '', location.pathname + '?tab=' + id); render(); };
    if (pageMode === 'market' || pageMode === 'workspaces') {
      const meta = TAB_META[pageMode];
      box.replaceChildren(
        el('div', { class: 'team-pagehead' }, el('a', { href: '/', textContent: '← 返回对话' }), el('h2', { textContent: meta[1] }), el('span', { class: 'sp' }),
          null),
        el('main', { class: 'team-main' }, el('p', { class: 'team-desc', textContent: meta[2] }), body));
    } else if (mode) {
      const groups = (mode === 'admin' ? ADMIN_GROUPS : MEMBER_GROUPS).map(([title, ids]) => [title, ids.filter(id => tabs.some(([tid]) => tid === id))]).filter(([, ids]) => ids.length);
      const meta = TAB_META[tab] || ['', tabLabel(tab), ''];
      const nav = el('nav', { class: 'team-nav', ariaLabel: '设置导航' }, groups.flatMap(([title, ids]) => [el('h4', { textContent: title }),
        ...ids.map(id => el('button', { type: 'button', class: id === tab ? 'on' : '', 'aria-current': id === tab ? 'page' : undefined, on: { click: () => switchTab(id) } }, el('span', { class: 'ic', textContent: (TAB_META[id] || [''])[0] }), el('span', { textContent: tabLabel(id) })))]));
      host.replaceChildren(...[
        inHome ? null : el('div', { class: 'team-pagehead' }, el('a', { href: '/', textContent: '← 返回对话' }), el('h2', { textContent: pageMode === 'admin' ? '管理设置' : '我的设置' }), el('span', { class: 'sp' }),
          pageMode === 'admin' ? el('a', { href: '/?panel=settings', textContent: '我的设置 →' }) : (me.role === 'admin' ? el('a', { href: '/admin/settings', textContent: '管理设置 →' }) : null)),
        el('div', { class: 'team-layout' }, nav, el('main', { class: 'team-main' }, el('h2', { class: 'team-title', textContent: meta[1] }), el('p', { class: 'team-desc', textContent: meta[2] }), body))].filter(Boolean));
      nav.querySelector('.on')?.scrollIntoView({ inline: 'center', block: 'nearest' });
    } else box.replaceChildren(
      pageMode
        ? el('div', { class: 'team-pagehead' }, el('a', { href: '/', textContent: '← 返回对话' }), el('h2', { textContent: pageMode === 'admin' ? '管理设置' : '我的设置' }), el('span', { class: 'sp' }),
            pageMode === 'admin' ? el('a', { href: '/?panel=settings', textContent: '我的设置 →' }) : (me.role === 'admin' ? el('a', { href: '/admin/settings', textContent: '管理设置 →' }) : null))
        : el('div', { class: 'modal-head' }, el('h2', { textContent: '团队与 API' }), el('button', { type: 'button', class: 'secondary', textContent: '关闭', on: { click: () => { backdrop.hidden = true; } } })),
      el('div', { class: 'team-tabs' }, tabs.map(([id, label]) => el('button', { type: 'button', class: id === tab ? 'on' : '', textContent: label, on: { click: () => { tab = id; if (pageMode) history.replaceState(null, '', location.pathname + '?tab=' + id); render(); } } }))),
      body);
    try { await ({ site: renderSite, service: renderService, invites: renderInvites, userskills: renderUserSkills, market: renderMarket, review: renderReview, desktop: renderDesktop, skills: renderSkills, bots: renderBots, wallpapers: renderWallpapers, workspaces: renderWorkspaces, engines: renderEngines, safety: renderSafety, plan: renderPlan, mail: renderMail, mcp: renderMcp, cindy: renderCindy, usage: renderUsage, dashboard: renderDashboard, audit: renderAudit, env: renderEnv, doctor: renderDoctor, tokens: renderTokens, agents: renderAgents, providers: renderProviders, voice: renderVoice, imagegen: renderImageGen, tts: renderTts, vision: renderVision, security: renderSecurity, members: renderMembers })[tab](body); }
    catch (e) { body.append(el('div', { class: 'team-err', textContent: e.message })); }
  }
  const modelLabelOf = ref => { const m = (window.yumeiroCatalog || []).find(x => x.ref === ref); return m ? modelName(m) : ref; };
  const modelName = m => (m.provider === 'default' ? '' : m.providerName + ' · ') + (m.label || m.model);
  const num = n => Number(n || 0).toLocaleString();
  const lim = n => n ? num(n) : '不限';
  const money = v => (Math.round((v || 0) * 10000) / 10000).toLocaleString();
  const pct = (used, limit) => limit ? Math.min(100, Math.round(used / limit * 100)) : 0;
  const meter = (label, used, limit) => el('div', { class: 'team-row' },
    el('div', { class: 'grow' }, label, el('small', { textContent: `已用 ${num(used)} / ${lim(limit)}${limit ? '（' + pct(used, limit) + '%）' : ''}` }),
      limit ? el('div', { style: 'height:6px;border-radius:3px;background:var(--line);margin-top:6px;overflow:hidden' }, el('div', { style: `height:100%;width:${pct(used, limit)}%;background:${pct(used, limit) >= 90 ? '#c0392b' : 'var(--accent)'}` })) : null));
  const breakdown = row => Object.entries(row.models || {}).map(([m, v]) => m + ' ×' + v.calls).join('、')
    + (row.sources && Object.keys(row.sources).length ? '　来源 ' + Object.entries(row.sources).map(([k, v]) => (k === 'api' ? 'API' : k === 'workspace' ? '工作区' : k === 'bot' ? '机器人' : '网页') + ' ' + v).join(' / ') : '');

  async function renderUsage(body) {
    if (pageMode === 'admin') { await renderTeamUsage(body); return; }
    const mine = await api('/api/usage/me'), u = mine.usage;
    body.append(
      el('p', { class: 'team-note', textContent: `${mine.month} 月（服务器本地时间）。Token 为模型服务商返回的用量；未返回用量的调用只计次数（本月 ${u.unreportedCalls} 次）。额度达到后新请求会被拒绝，Token 额度可能被最后一次调用略微超出。` }),
      mine.blocked && el('div', { class: 'team-err', textContent: '当前已被限制：' + mine.blocked }),
      meter('今日调用', u.todayCalls, u.dailyLimit), meter('本月调用', u.calls, u.monthlyCallLimit), meter('本小时 Token', u.hourTokens, u.hourlyTokenLimit), meter('本月 Token', u.totalTokens, u.monthlyTokenLimit),
      u.pet && u.pet.calls ? el('p', { class: 'team-note', textContent: '其中宠物 AI 单独计量：' + num(u.pet.calls) + ' 次 · ' + num(u.pet.totalTokens) + ' tokens' + (u.pet.cost ? ' · 估算费用 ' + money(u.pet.cost) : '') }) : null,
      el('p', { class: 'team-note', textContent: '输入 ' + num(u.inputTokens) + ' · 输出 ' + num(u.outputTokens) + (u.cost ? ' · 估算费用 ' + money(u.cost) : '') + '　' + breakdown(u) }),
      mine.history.length > 1 && el('p', { class: 'team-note', textContent: '近月：' + mine.history.map(h => h.month + ' ' + num(h.calls) + ' 次/' + num(h.totalTokens) + ' tokens').join('；') }));
    if (pageMode || me.role !== 'admin') return;
    await renderTeamUsage(body);
  }
  async function renderTeamUsage(body) {
    const report = await api('/api/admin/usage' + (usageMonth ? '?month=' + usageMonth : '')), cur = report.currency;
    const select = el('select', { on: { change: () => { usageMonth = select.value; render(); } } }, report.months.map(m => el('option', { value: m, textContent: m, selected: m === report.month })));
    const exportLink = (by, text) => el('a', { class: 'secondary', href: `/api/admin/usage/export?by=${by}&month=${report.month}`, download: '', style: 'padding:6px 10px;border:1px solid var(--line);border-radius:8px;font-size:13px;text-decoration:none;color:inherit', textContent: text });
    const cell = (v, wide) => el('td', { style: 'padding:4px 6px;border-bottom:1px solid var(--line);word-break:break-all' + (wide ? ';min-width:90px' : ''), textContent: String(v ?? '') });
    const head = cols => el('thead', {}, el('tr', {}, cols.map(t => el('th', { style: 'text-align:left;padding:4px 6px;border-bottom:1px solid var(--line);white-space:nowrap', textContent: t }))));
    const tbl = (cols, rows, empty) => el('div', { style: 'overflow:auto' }, el('table', { style: 'width:100%;border-collapse:collapse;font-size:13px' }, head(cols), el('tbody', {}, rows.length ? rows : [el('tr', {}, el('td', { colSpan: cols.length, style: 'padding:6px', textContent: empty }))])));
    body.append(pageMode ? null : el('h3', { textContent: '全部成员' }),
      el('div', { class: 'team-form' }, select, el('div', { class: 'team-note', textContent: `合计 ${num(report.totals.calls)} 次 · ${num(report.totals.totalTokens)} tokens · 估算费用 ${cur}${money(report.totals.cost)}（费用按“模型价格”里设置的单价，在调用当时计算）` })),
      el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin:6px 0' }, exportLink('member', '导出：成员 × 模型（CSV）'), exportLink('group', '导出：群聊 × 成员 × 模型（CSV）'), exportLink('model', '导出：各模型 / 服务商（CSV）')),
      report.rows.map(r => el('div', { class: 'team-row' }, el('div', { class: 'grow' }, `${r.displayName}${r.disabled ? '（已停用）' : ''}${r.allowedHours ? ' · 时段 ' + r.allowedHours.start + '–' + r.allowedHours.end : ''}`,
        el('small', { textContent: `${r.email}　${num(r.calls)} 次（上限 ${lim(r.monthlyCallLimit)}）　${num(r.totalTokens)} tokens（上限 ${lim(r.monthlyTokenLimit)}）　本小时 ${num(r.hourTokens)}/${lim(r.hourlyTokenLimit)}　费用 ${cur}${money(r.cost)}　今日 ${r.todayCalls}/${lim(r.dailyLimit)}` }),
        el('small', { textContent: breakdown(r) })))),
      el('h4', { textContent: '各模型 / API 服务商用量' }),
      tbl(['模型', '服务商', '调用', '输入', '输出', '总 Token', '费用'], report.models.map(x => el('tr', {}, [x.model, x.provider, num(x.calls), num(x.inputTokens), num(x.outputTokens), num(x.totalTokens), cur + money(x.cost)].map(v => cell(v)))), '本月还没有用量'),
      el('h4', { textContent: '各群聊用量' }),
      tbl(['群聊', '创建者', '调用', '总 Token', '费用', '成员明细'], report.groups.map(x => el('tr', {}, [x.title + (x.deleted ? '（已删除）' : ''), x.owner, num(x.calls), num(x.totalTokens), cur + money(x.cost), x.members.map(m => `${m.label} ${num(m.totalTokens)} / ${cur}${money(m.cost)}`).join('；')].map(v => cell(v, true)))), '本月还没有群聊用量'));
    await renderPricing(body);
  }
  // 模型价格：每百万 Token 的输入 / 输出单价；每个模型可以单独选货币符号。
  // 服务商在模型列表里直接给价格的（如 OpenRouter），点“从服务商读取价格”自动填；其余的由你按实际账单填写。留空的模型只统计 Token，不算费用。
  // 模型名只显示名字：去掉内部编号（一长串十六进制）和过长的部分，完整内容放在鼠标悬停提示里
  const shortModel = label => String(label || '').replace(/\b[0-9a-f]{12,}\b/gi, '').replace(/\s{2,}/g, ' ').trim().slice(0, 40);
  async function renderPricing(body) {
    const data = await api('/api/admin/pricing'), err = errBox(), status = el('span', { class: 'team-note' });
    const SYMBOLS = [['¥', '¥ 人民币'], ['$', '$ 美元'], ['€', '€ 欧元'], ['£', '£ 英镑'], ['₩', '₩ 韩元'], ['₽', '₽ 卢布'], ['₹', '₹ 卢比']];
    const symbolSelect = (value, extra) => { const list = SYMBOLS.some(([v]) => v === value) || !value ? SYMBOLS : [...SYMBOLS, [value, value]]; return el('select', {}, ...list.map(([v, t]) => { const o = el('option', { value: v, textContent: t, selected: v === value }); o.setAttribute('data-short', v); return o; })); };
    const base = symbolSelect(data.currency);
    const rows = data.models.map(m => ({ m, auto: false, cur: symbolSelect(m.price?.currency || data.currency), input: el('input', { type: 'number', min: 0, step: 'any', value: m.price?.input || '', placeholder: '输入', style: 'width:90px' }), output: el('input', { type: 'number', min: 0, step: 'any', value: m.price?.output || '', placeholder: '输出', style: 'width:90px' }), tag: el('span', { class: 'team-note' }) }));
    const rateBox = el('div', {}), rateInputs = {};
    const drawRates = () => {
      const used = [...new Set(rows.filter(r => r.input.value || r.output.value).map(r => r.cur.value).filter(c => c && c !== base.value))];
      rateBox.replaceChildren(...(used.length ? [el('p', { class: 'team-note', textContent: '有模型的货币和统计货币不同，费用合计时需要折算：' }), ...used.map(c => { const i = rateInputs[c] || (rateInputs[c] = el('input', { type: 'number', min: 0, step: 'any', value: data.rates?.[c] || '', placeholder: '汇率', style: 'width:110px' })); return el('label', { style: 'display:flex;gap:8px;align-items:center;font-size:13px;margin:4px 0' }, `1 ${c} =`, i, base.value); })] : []));
    };
    for (const r of rows) { r.cur.addEventListener('change', drawRates); r.input.addEventListener('input', drawRates); r.output.addEventListener('input', drawRates); }
    base.addEventListener('change', drawRates);
    const save = async () => {
      try {
        const models = {}; for (const r of rows) if (r.input.value || r.output.value) models[r.m.ref] = { input: Number(r.input.value || 0), output: Number(r.output.value || 0), currency: r.cur.value };
        const rates = {}; for (const [c, i] of Object.entries(rateInputs)) if (i.value && i.isConnected) rates[c] = Number(i.value);
        const out = await api('/api/admin/pricing', { method: 'PUT', body: JSON.stringify({ currency: base.value, models, rates }) });
        err.textContent = ''; status.textContent = '已保存（' + out.count + ' 个模型有价格），新产生的用量会按新价格计费';
      } catch (e) { err.textContent = e.message; }
    };
    const sync = el('button', { type: 'button', class: 'secondary', textContent: '从服务商读取价格', on: { click: async () => {
      err.textContent = ''; status.textContent = '正在读取…';
      try {
        const out = await api('/api/admin/pricing/sync', { method: 'POST', body: '{}' });
        let n = 0; for (const r of rows) { const p = out.prices[r.m.ref]; if (!p) continue; r.input.value = p.input; r.output.value = p.output; r.cur.value = p.currency; r.cur._ymSync && r.cur._ymSync(); r.tag.textContent = '自动读取'; n++; }
        drawRates(); status.textContent = `读到 ${n} 个模型的价格（还没保存，请检查后点“保存价格”）。` + out.report.map(x => `${x.name}：${x.detail}`).join('；');
      } catch (e) { err.textContent = e.message; status.textContent = ''; }
    } } });
    body.append(el('h4', { textContent: '模型价格（每百万 Token）' }),
      el('div', { class: 'team-note', textContent: '大多数官方 API 不会通过接口公布价格，所以这里不内置价格表（避免过期的数字）：服务商在模型列表里提供价格的会自动读取，其余请按你实际的账单单价填写，并给每个模型选货币符号。改价只影响之后的调用，历史费用不变。' }),
      el('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:8px 0' }, el('label', { style: 'font-size:13px;display:flex;gap:8px;align-items:center' }, '统计货币（合计用）', base), sync),
      el('div', { style: 'display:grid;gap:8px;margin:8px 0' }, rows.length ? rows.map(r => el('div', { class: 'price-row' }, el('span', { class: 'price-name', title: r.m.label + '　' + r.m.providerName + '　' + r.m.ref, textContent: shortModel(r.m.label) + (r.m.providerName ? '　' + r.m.providerName : '') }), r.cur, r.input, r.output, r.tag)) : [el('p', { class: 'team-note', textContent: '还没有可用的模型，请先在“AI 接入”里添加。' })]),
      rateBox,
      el('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' }, el('button', { type: 'button', class: 'primary', textContent: '保存价格', on: { click: save } }), status), err);
    drawRates();
  }
  // 原生 append 会把数组转成 "[object HTMLDivElement]"；面板渲染大量使用 map() 生成的数组，这里让 append 自动展开数组并忽略空值。
  function flatBox() {
    const box = el('div', {}), nativeAppend = box.append.bind(box);
    box.append = (...kids) => nativeAppend(...kids.flat(Infinity).filter(x => x !== null && x !== undefined && x !== false));
    return box;
  }
  // 表单整理：连续的复选框并成一行（.check-row），连续的按钮并成一行并拉成等宽（.btn-row）。
  // 各个管理页的表单是分散写的，这里统一在渲染之后整理一次（内容变化时自动重新整理，已整理过的不会重复处理）。
  function tidyForms(root = document) {
    for (const form of root.querySelectorAll('.team-form')) {
      const isCheck = n => n.tagName === 'LABEL' && n.querySelector(':scope > input[type=checkbox]'), isBtn = n => n.tagName === 'BUTTON' && !n.classList.contains('wide');
      const kind = n => isCheck(n) ? 'check' : isBtn(n) ? 'btn' : '';
      const kids = [...form.children]; let run = [], type = '';
      const flush = () => { if (run.length >= 2) { const row = document.createElement('div'); row.className = type === 'check' ? 'check-row' : 'btn-row'; run[0].before(row); row.append(...run); } run = []; type = ''; };
      for (const n of kids) { const k = kind(n); if (k && k === type) run.push(n); else { flush(); if (k) { type = k; run = [n]; } } }
      flush();
    }
  }
  let tidyTimer = 0;
  new MutationObserver(() => { clearTimeout(tidyTimer); tidyTimer = setTimeout(() => tidyForms(), 40); }).observe(document.body, { childList: true, subtree: true });
  const errBox = () => el('div', { class: 'team-err' });

  // Cindy 账号余额：把 /billing 的结果画成卡片（额度数字、分池进度条）；字段缺失时尽量降级成文字
  const fmtNum = v => { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : String(v); };
  const billingSummary = r => {
    const cu = r.creditUsage && r.creditUsage.ok ? (r.creditUsage.data || {}) : null;
    const bal = r.balance && r.balance.ok ? r.balance.data : null;
    let available = cu && cu.available != null ? cu.available : null;
    if (available == null && bal && typeof bal === 'object') { const k = ['available', 'balance', 'remaining', 'amount'].find(key => typeof bal[key] === 'number' || typeof bal[key] === 'string'); if (k) available = bal[k]; }
    return { cu, bal, available };
  };
  const billingCache = new Map(); // accountId -> { at, data }
  async function fetchBilling(id, force) {
    const hit = billingCache.get(id);
    if (!force && hit && Date.now() - hit.at < 60000) return hit.data;
    const data = await api('/api/cindy/accounts/' + id + '/billing');
    billingCache.set(id, { at: Date.now(), data });
    return data;
  }
  function paintBilling(box, r) {
    const { cu, bal, available } = billingSummary(r);
    if (available == null && !cu && !(r.balance && r.balance.ok)) { box.replaceChildren(el('span', { textContent: (r.creditUsage && r.creditUsage.message) || (r.balance && r.balance.message) || '暂时查不到余额' })); return; }
    const low = Number(available) <= 0;
    const kids = [el('div', { class: 'bal-main' }, el('span', { textContent: '可用额度' }), el('b', { textContent: available == null ? '—' : fmtNum(available) }))];
    if (cu) for (const [name, key] of [['订阅额度', 'plan'], ['充值额度', 'purchased'], ['赠送额度', 'promotional']]) {
      const p = cu[key]; if (!p) continue;
      const total = Number(p.total), rem = Number(p.remaining), pct = total > 0 && Number.isFinite(rem) ? Math.max(0, Math.min(100, rem / total * 100)) : null;
      kids.push(el('div', { class: 'bal-row' }, el('span', { textContent: name }), el('span', { textContent: '剩余 ' + fmtNum(p.remaining) + (p.total != null ? ' / ' + fmtNum(p.total) : '') })));
      kids.push(el('div', { class: 'bal-bar' }, pct == null ? null : el('i', { style: 'width:' + pct.toFixed(1) + '%' })));
    }
    if (bal && typeof bal === 'object') {
      const extra = Object.entries(bal).filter(([, v]) => ['string', 'number'].includes(typeof v)).map(([k, v]) => k + ' ' + v).join('，');
      if (extra) kids.push(el('div', { class: 'bal-row' }, el('span', { textContent: '账户余额' }), el('span', { textContent: extra })));
    }
    box.className = 'bal-card' + (low ? ' bal-low' : ''); box.replaceChildren(...kids);
  }
  async function loadBalance(box, id, force) {
    box.className = 'bal-card'; box.textContent = '正在查询余额…';
    try { paintBilling(box, await fetchBilling(id, force)); } catch (e) { box.className = 'bal-card'; box.textContent = e.message; }
  }

  // 绑定 Cindy 账号：先登录本站账号，再在这里验证并绑定；一个本站账号可绑定多个 Cindy 账号
  async function renderCindy(body) {
    const { accounts } = await api('/api/cindy/accounts');
    const sharing = me.role === 'admin' ? await api('/api/cindy/sharing').catch(() => null) : null;
    const regionName = r => r === 'cn' ? '国服' : '国际服';
    const holder = el('div', {}), report = el('pre', { style: 'white-space:pre-wrap;font-size:12px;margin:6px 0' });
    // 余额、额度池、订阅（只读，来自官方 model-access 服务）
    const formatBilling = r => {
      const lines = [], pairs = obj => Object.entries(obj || {}).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v)).map(([k, v]) => k + ' ' + v).join('，');
      const cu = r.creditUsage;
      if (cu.ok) {
        const d = cu.data || {}; lines.push('可用额度：' + d.available);
        for (const [name, key] of [['订阅额度', 'plan'], ['充值额度', 'purchased'], ['赠送额度', 'promotional']]) { const p = d[key]; if (p) lines.push(`  ${name}：剩余 ${p.remaining}${p.total != null ? ' / 总 ' + p.total : ''}${p.used != null ? '（已用 ' + p.used + '）' : ''}`); }
      } else lines.push('额度：' + r.creditUsage.message);
      lines.push(r.balance.ok ? '余额：' + (pairs(r.balance.data) || '（无数据）') : '余额：' + r.balance.message);
      return lines.join('\n');
    };
    const cards = new Map();
    const showBilling = a => loadBalance(cards.get(a.id), a.id, true);
    const subscribeUrl = a => (a.region === 'cn' ? 'https://cindy.com.cn' : 'https://cindy.app') + '/#pricing';
    const act = async (a, kind) => { report.textContent = kind === 'sync' ? '正在同步…' : '正在测试（会向官方网关发一次 1 token 的请求）…'; try { const r = await api(`/api/cindy/accounts/${a.id}/${kind}`, { method: 'POST', body: JSON.stringify({}) }); report.textContent = kind === 'sync' ? (r.ok ? `同步成功：${r.models} 个对话模型` : '同步失败：' + (r.syncError || '未知原因')) : r.steps.map(x => (x.ok ? '✓ ' : '✗ ') + x.name + '：' + x.detail).join('\n'); loadModels(); } catch (e) { report.textContent = e.message; } };
    const sharePanel = () => {
      if (!sharing) return null;
      const box = el('div', { style: 'display:flex;flex-direction:column;align-items:stretch;gap:8px;min-width:0;border:1px solid var(--line,#8884);border-radius:12px;padding:14px;margin:8px 0' });
      const msg = el('div', { class: 'team-err' });
      if (sharing.allowed) {
        box.append(el('strong', { textContent: '团队共享 Cindy 账号：已开启' }), el('p', { class: 'team-note', textContent: sharing.byEnv ? '由服务器环境变量 CINDY_ALLOW_SHARED_ACCOUNTS=1 开启。' : `已由 ${sharing.ack?.email || '主账号'} 于 ${sharing.ack?.at ? fmt(sharing.ack.at) : ''} 确认：已阅读 Cindy 用户协议并自行承担后果。` }));
        if (!sharing.byEnv) box.append(el('button', { type: 'button', class: 'secondary', textContent: '关闭团队共享', on: { click: async () => { try { await api('/api/cindy/sharing/revoke', { method: 'POST', body: JSON.stringify({}) }); render(); loadModels(); } catch (e) { msg.textContent = e.message; } } } }), msg);
        return box;
      }
      const secs = sharing.minSeconds || 120;
      const check = el('input', { type: 'checkbox', disabled: true }), go = el('button', { type: 'button', class: 'primary', textContent: '开启团队共享', disabled: true });
      const status = el('div', { class: 'rd-text', textContent: '第 1 步：点上面任意一个官网链接并阅读用户协议，点击后开始计时。' }), fill = el('i'), bar = el('div', { class: 'rd-bar', hidden: true }, fill);
      let started = false, left = secs, timer = null;
      const sync = () => { check.disabled = !(started && left <= 0); if (check.disabled) check.checked = false; go.disabled = check.disabled || !check.checked; };
      check.addEventListener('change', sync);
      // 官网链接做成并排的“链接卡片”：图标 + 名称 + 域名 + ↗，整块可点；点击后开始计时
      const link = (href, text, sub, icon) => el('a', { href, target: '_blank', rel: 'noopener noreferrer', class: 'link-card', on: { click: () => start() } }, el('span', { class: 'lc-i', textContent: icon }), el('span', { class: 'lc-t' }, el('strong', { textContent: text }), el('small', { textContent: sub })), el('span', { class: 'lc-go', textContent: '↗' }));
      async function start() {
        if (started) return; started = true;
        try { const r = await api('/api/cindy/sharing/start', { method: 'POST', body: JSON.stringify({}) }); left = r.minSeconds ?? secs; } catch (e) { started = false; msg.textContent = e.message; return; }
        const tick = () => { bar.hidden = false; fill.style.width = Math.min(100, Math.round((secs - left) / secs * 100)) + '%'; status.textContent = left > 0 ? `第 2 步：请认真阅读用户协议，还需等待 ${left} 秒后才能勾选确认。` : '第 3 步：已满足阅读时间，请勾选下面的确认，再点“开启团队共享”。'; sync(); if (left <= 0) { clearInterval(timer); return; } left -= 1; };
        tick(); timer = setInterval(tick, 1000);
      }
      go.addEventListener('click', async () => { try { await api('/api/cindy/sharing/accept', { method: 'POST', body: JSON.stringify({ accepted: true }) }); render(); loadModels(); } catch (e) { msg.textContent = e.message; } });
      box.append(
        el('strong', { textContent: '团队共享 Cindy 账号：未开启（默认关闭）' }),
        el('p', { class: 'team-note', textContent: '把一个 Cindy 账号共享给团队成员，等于让多人共用同一个订阅额度。Cindy 官方的用户协议/服务条款是否允许这样做，请你自己确认；如果协议不允许，可能导致账号被限制或封禁，一切后果由你自行承担，与本项目及制作者无关。' }),
        el('p', { class: 'team-note', textContent: `请先点下面的链接打开 Cindy 官网，在页脚找到“用户协议 / 服务条款”并认真阅读。点击后开始计时，满 ${secs} 秒才能确认（服务器记录时间，不可跳过）。` }),
        el('div', { class: 'link-cards' }, link('https://cindy.app', 'Cindy 国际版', 'cindy.app', '🌐'), link('https://cindy.com.cn', 'Cindy 国内版', 'cindy.com.cn', '🇨🇳')),
        el('div', { class: 'rd-timer' }, status, bar),
        el('label', { class: 'rd-check' }, check, el('span', { textContent: '我已阅读 Cindy 用户协议，知道共享账号可能违反协议，愿意自行承担全部后果。' })),
        el('div', { class: 'rd-actions' }, go), msg);
      return box;
    };
    body.append(
      ...[sharePanel()].filter(Boolean),
      el('p', { class: 'team-note', textContent: '绑定后，Cindy 官方账号的授权令牌会加密保存在服务器，仅属于你的本站账号；每个本站账号最多绑定 5 个，同一个 Cindy 账号只能绑定到一个本站账号。绑定不会改变你的本站登录方式。' }),
      accounts.length ? accounts.map(a => el('div', { class: 'team-row' },
        el('div', { class: 'grow' }, a.displayName + (a.orgName ? ' · ' + a.orgName : ''), el('small', { textContent: `${regionName(a.region)}　${a.email || '无邮箱'}　绑定于 ${fmt(a.boundAt)}　授权：${a.needsRebind ? '需要重新绑定' : '正常（访问令牌约 1 小时有效，到期前自动续期）'}　Cindy 模型 ${a.models}${a.shared ? '（已共享给全部成员）' : ''}${a.syncError ? '（同步失败：' + a.syncError + '）' : ''}` }), (() => { const box = el('div', { class: 'bal-card' }); cards.set(a.id, box); return box; })()),
        el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' }, el('button', { type: 'button', class: 'secondary', textContent: '刷新余额', on: { click: () => showBilling(a) } }), el('a', { class: 'secondary', href: subscribeUrl(a), target: '_blank', rel: 'noopener noreferrer', textContent: '订阅（官方）', style: 'display:inline-flex;align-items:center;text-decoration:none;color:inherit' }), me.role === 'admin' && sharing && sharing.allowed ? el('button', { type: 'button', class: 'secondary', textContent: a.shared ? '取消共享' : '共享给成员', on: { click: async () => { if (!a.shared && !await ymConfirm('共享后，所有团队成员都能用这个 Cindy 账号的模型，调用会扣这个账号自己的余额（成员各自的每日/每月额度仍然生效）。\n\n请确认 Cindy 的服务条款允许把账号额度提供给他人使用。继续共享？')) return; try { await api('/api/cindy/accounts/' + a.id, { method: 'PATCH', body: JSON.stringify({ shared: !a.shared }) }); render(); loadModels(); } catch (e) { report.textContent = e.message; } } } }) : null,
          el('button', { type: 'button', class: 'secondary', textContent: '同步模型', on: { click: () => act(a, 'sync') } }), el('button', { type: 'button', class: 'secondary', textContent: '测试', on: { click: () => act(a, 'test') } }), el('button', { type: 'button', class: 'secondary danger', textContent: '解绑', on: { click: async () => { if (!await ymConfirm('解绑后服务器会删除这个账号的授权令牌，继续？', { danger: true, okText: '确定' })) return; await api('/api/cindy/accounts/' + a.id, { method: 'DELETE' }); render(); } } })))) : el('p', { class: 'team-note', textContent: '还没有绑定 Cindy 账号。' }),
      report, holder);
    for (const a of accounts) if (!a.needsRebind) loadBalance(cards.get(a.id), a.id, false); else cards.get(a.id).textContent = '授权失效，请解绑后重新绑定';
    if (window.mountCindyBind) window.mountCindyBind(holder, () => render());
    else holder.append(el('p', { class: 'team-err', textContent: '绑定组件没有加载，请刷新页面' }));
  }

  async function renderTokens(body, secret) {
    const { tokens } = await api('/api/tokens');
    const err = errBox(), name = el('input', { placeholder: '令牌名称，如 本地脚本', maxLength: 60 });
    // 接口记忆：调用方带会话标识（X-Session-Id / session / user）时，按会话记住偏好和背景
    const apiMemBox = el('div', {});
    // 接入其他软件：浏览器/IDE 插件、各类客户端、本机桥接，都用同一个令牌
    const code = text => el('pre', { class: 'team-code', textContent: text });
    const connectBox = el('details', { style: 'margin:12px 0' }, el('summary', { textContent: '接入其他软件（插件 / 电脑客户端 / 本机桥接）', style: 'cursor:pointer;font-weight:600' }),
      el('p', { class: 'team-note', textContent: '凡是能自定义 OpenAI / Anthropic 接口地址的软件（Chatbox、Cherry Studio、Continue、各类浏览器和 IDE 插件、Claude Code 等），都可以直接用上面创建的令牌，用量、额度和审计照常计入你的账号。' }),
      el('h4', { textContent: '聊天（OpenAI 兼容）' }), code(`接口地址 / Base URL：${location.origin}/v1\nAPI Key：你的令牌（ymr_…）\n模型：用 GET ${location.origin}/v1/models 里列出的名字，或 agent:<智能体ID>`),
      el('h4', { textContent: 'Claude Code / Anthropic SDK' }), code(`ANTHROPIC_BASE_URL=${location.origin}\nANTHROPIC_API_KEY=你的令牌`),
      el('h4', { textContent: '绘画（需管理员已接入绘画模型）' }), code(`POST ${location.origin}/v1/images/generations\nAuthorization: Bearer 你的令牌\n{"prompt":"夜晚的樱花树","n":2,"size":"1024x1024"}   →  data[].b64_json`),
      el('h4', { textContent: '会话记忆' }), el('p', { class: 'team-note', textContent: '请求头加 X-Session-Id: <任意标识> 即可按会话记住偏好（聊天和绘画共用这一套会话标识），不加则无状态。' }),
      el('h4', { textContent: '电脑上的本机桥接（把本站和本机客户端统一成一个本地入口）' }), code(`YUMEIRO_TEAM_URL=${location.origin} YUMEIRO_TEAM_TOKEN=你的令牌 node bridge/yumeiro-bridge.mjs --no-local --port=8788\n# （电脑上装了 Cindy 桌面端、想一起接入时去掉 --no-local）之后本机程序都用 http://127.0.0.1:8788/v1\n#   聊天：模型名加 team: 前缀，如 team:agent:<智能体ID>\n#   绘画：POST http://127.0.0.1:8788/v1/images/generations（原样转发到本站）`),
      el('p', { class: 'team-note', textContent: '桥接只监听本机地址、拒绝带 Origin 的网页请求，不会把令牌暴露给网页。需要的话可以设置环境变量 BRIDGE_API_KEY 给本地入口再加一层密码。' }));
    const showApiMemory = async () => {
      const d = await api('/api/api-memory'), bySession = new Map();
      for (const m of d.memories) { if (!bySession.has(m.session)) bySession.set(m.session, []); bySession.get(m.session).push(m); }
      const del = async (path, ask) => { if (ask && !await ymConfirm(ask)) return; await api(path, { method: 'DELETE' }); showApiMemory(); };
      apiMemBox.replaceChildren(el('h3', { textContent: '接口记忆（按会话）' }),
        el('p', { class: 'team-note' }, '调用 ', el('code', { textContent: '/v1/chat/completions' }), ' 或 ', el('code', { textContent: '/v1/messages' }), ' 时带上会话标识（请求头 ', el('code', { textContent: 'X-Session-Id' }), '，或 body 里的 ', el('code', { textContent: 'session' }), ' / OpenAI 的 ', el('code', { textContent: 'user' }), ' / Anthropic 的 ', el('code', { textContent: 'metadata.user_id' }), '），服务器就会按会话记住偏好和背景并在下次带上；不带会话标识则保持无状态。每个会话只用自己的记忆，不会带上你的个人记忆。响应头 ', el('code', { textContent: 'X-Memory-Used' }), ' 表示这次带上了几条。'),
        d.memories.length ? el('button', { type: 'button', class: 'secondary', textContent: '清空全部', on: { click: () => del('/api/api-memory', '清空所有接口会话的记忆？') } }) : el('p', { class: 'team-note', textContent: d.enabled ? '还没有接口记忆。' : '记忆总开关已关闭（聊天页右上角 🧠）。' }),
        ...[...bySession].map(([session, items]) => el('div', { class: 'team-row', style: 'display:block' },
          el('div', { style: 'display:flex;gap:8px;align-items:center' }, el('strong', { class: 'grow', textContent: '会话：' + session }), el('button', { type: 'button', class: 'secondary', textContent: '清空此会话', on: { click: () => del('/api/api-memory?session=' + encodeURIComponent(session), '清空会话“' + session + '”的记忆？') } })),
          ...items.map(m => el('div', { style: 'display:flex;gap:8px;align-items:flex-start;margin-top:6px' }, el('span', { class: 'grow', textContent: (m.pinned ? '★ ' : '') + m.text }), el('button', { type: 'button', class: 'secondary danger', textContent: '删除', on: { click: () => del('/api/api-memory/' + m.id) } }))))));
    };
    showApiMemory().catch(e => { err.textContent = e.message; });
    body.append(
      el('p', { class: 'team-note' }, '令牌用于调用本站的 OpenAI 兼容接口：', el('code', { textContent: location.origin + '/v1' }), '。令牌等同于你的账号权限，只在创建时显示一次。'),
      secret && el('div', { class: 'team-secret', textContent: secret }),
      el('div', { class: 'team-form' }, name, el('button', { type: 'button', class: 'secondary', textContent: '创建令牌', on: { click: async () => {
        try { const r = await api('/api/tokens', { method: 'POST', body: JSON.stringify({ name: name.value }) }); const fresh = flatBox(); body.replaceChildren(fresh); await renderTokens(fresh, r.token); } catch (e) { err.textContent = e.message; }
      } } })), err,
      tokens.length ? tokens.map(t => el('div', { class: 'team-row' }, el('div', { class: 'grow' }, t.name, el('small', { textContent: `${t.prefix}…　创建 ${fmt(t.createdAt)}　最近使用 ${fmt(t.lastUsedAt)}` })), el('button', { type: 'button', class: 'secondary danger', textContent: '删除', on: { click: async () => { if (!await ymConfirm('删除后使用该令牌的程序将立即失效，继续？', { danger: true, okText: '确定' })) return; await api('/api/tokens/' + t.id, { method: 'DELETE' }); render(); } } }))) : el('p', { class: 'team-note', textContent: '还没有令牌。' }),
      apiMemBox,
      connectBox,
      el('h3', { textContent: '调用示例' }),
      el('pre', { class: 'team-code', textContent: `curl ${location.origin}/v1/chat/completions \\\n  -H "Authorization: Bearer <令牌>" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"agent:<智能体ID>","messages":[{"role":"user","content":"你好"}]}'` }));
  }

  async function renderAgents(body) {
    await loadAgents();
    const catalog = (await api('/api/models')).models;
    const agentPick = createModelPicker(); agentPick.rebuild(catalog, '');
    const err = errBox(), f = {
      name: el('input', { placeholder: '名称', maxLength: 60 }), model: el('div', { style: 'display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:8px;min-width:0' }, agentPick.nodes),
      description: el('input', { class: 'wide', placeholder: '简介（可选）', maxLength: 200 }), prompt: el('textarea', { placeholder: '系统提示词：定义这个智能体的身份、风格与边界', maxLength: 8000 }),
      shared: el('input', { type: 'checkbox' })
    };
    const { skills: allSkills } = await api('/api/skills');
    const skillBoxes = allSkills.map(sk => ({ sk, box: el('input', { type: 'checkbox' }) }));
    body.append(
      el('p', { class: 'team-note', textContent: '智能体 = 系统提示词 + 模型。在对话顶栏选择后用于新对话；API 中用 model="agent:<ID>" 调用。' }),
      el('div', { class: 'team-form' }, f.name, f.model, f.description, f.prompt,
        me.role === 'admin' && el('label', { class: 'wide' }, f.shared, ' 共享给全部团队成员'),
        skillBoxes.length ? el('div', { class: 'wide team-note' }, '绑定技能（最多 8 个）：', skillBoxes.map(({ sk, box }) => el('label', { style: 'margin-right:10px;white-space:nowrap' }, box, ' ' + sk.title))) : el('div', { class: 'wide team-note', textContent: '还没有技能，可以先到“技能工坊”创建。' }),
        el('button', { type: 'button', class: 'primary wide', textContent: '创建智能体', on: { click: async () => {
          try { await api('/api/agents', { method: 'POST', body: JSON.stringify({ name: f.name.value, model: agentPick.ref, description: f.description.value, systemPrompt: f.prompt.value, shared: f.shared.checked, skillIds: skillBoxes.filter(x => x.box.checked).map(x => x.sk.id) }) }); render(); } catch (e) { err.textContent = e.message; }
        } } })), err,
      agentsCache.map(a => el('div', { class: 'team-row' }, el('div', { class: 'grow' }, el('span', { class: 'mk-name', title: '点击查看说明', textContent: a.name, on: { click: () => showContent(a.name, '', a.systemPrompt || '（提示词仅创建者和管理员可见）', null, { description: a.description }) } }), (a.shared ? '（共享）' : ''), el('small', { textContent: `ID ${a.id}${a.skillIds && a.skillIds.length ? '　技能 ' + a.skillIds.length + ' 个' : ''}${a.model ? '　模型 ' + (modelLabelOf(a.model)) : ''}${a.description ? '　' + a.description : ''}` })),
        (a.mine || me.role === 'admin') && el('button', { type: 'button', class: 'secondary danger', textContent: '删除', on: { click: async () => { if (!await ymConfirm('删除智能体“' + a.name + '”？', { danger: true, okText: '确定' })) return; await api('/api/agents/' + a.id, { method: 'DELETE' }); render(); } } }))));
  }

  // AI 接入：选模板 → 填密钥 → 拉取/填写模型 → 保存。密钥只在保存时提交，之后只显示掩码。
  async function renderProviders(body, editing) {
    const data = await api('/api/admin/providers');
    const err = errBox(), info = el('div', { class: 'team-note' });
    const f = {
      template: el('select', {}, data.templates.map(t => el('option', { value: t.id, textContent: t.name }))),
      name: el('input', { placeholder: '显示名称', maxLength: 60 }),
      slug: el('input', { placeholder: '标识（可选，如 openai；创建后不可改）', maxLength: 32 }),
      baseUrl: el('input', { class: 'wide', placeholder: '接口地址，如 https://api.openai.com/v1' }),
      apiKey: el('input', { class: 'wide', type: 'password', autocomplete: 'off', placeholder: 'API Key（只提交一次，之后只显示掩码）' }),
      models: el('textarea', { placeholder: '允许使用的模型名，每行一个或用逗号分隔。可点“拉取模型”自动填入。' }),
      members: el('input', { type: 'checkbox', checked: true })
    };
    const applyTemplate = () => {
      const t = data.templates.find(x => x.id === f.template.value);
      if (!t) return;
      if (!editing) { f.baseUrl.value = t.baseUrl; if (!f.name.value || data.templates.some(x => x.name === f.name.value)) f.name.value = t.id === 'custom' ? '' : t.name; }
      f.apiKey.placeholder = editing ? '留空 = 保持原密钥' : (t.keyOptional ? 'API Key（可留空）' : 'API Key 例如 ' + (t.keyHint || ''));
      info.textContent = t.note || '';
    };
    f.template.addEventListener('change', applyTemplate);
    let labels = {};
    if (editing) {
      f.template.value = editing.template; f.name.value = editing.name; f.baseUrl.value = editing.baseUrl;
      f.models.value = editing.models.join('\n'); labels = { ...(editing.modelLabels || {}) }; f.members.checked = editing.membersAllowed; f.slug.value = editing.slug; f.slug.disabled = true; f.template.disabled = true;
    }
    applyTemplate();
    const payload = () => ({ modelLabels: labels, template: f.template.value, name: f.name.value, slug: f.slug.value || undefined, baseUrl: f.baseUrl.value, apiKey: f.apiKey.value, models: f.models.value, membersAllowed: f.members.checked });
    const probe = async (withModel) => {
      err.textContent = ''; info.textContent = '正在连接…';
      const first = f.models.value.split(/[\n,]/).map(x => x.trim()).filter(Boolean)[0];
      if (withModel && !first) { info.textContent = ''; err.textContent = '请先填写至少一个模型名再测试对话接口'; return null; }
      const r = await api('/api/admin/providers/probe', { method: 'POST', body: JSON.stringify({ id: editing?.id, baseUrl: f.baseUrl.value, apiKey: f.apiKey.value, model: withModel ? first : undefined }) });
      info.textContent = (r.ok ? '✓ ' : '✗ ') + r.detail; info.style.color = r.ok ? '' : '#c0392b';
      return r;
    };
    const save = async () => {
      try {
        const r = await api(editing ? '/api/admin/providers/' + editing.id : '/api/admin/providers', { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(payload()) });
        body.replaceChildren(); await renderProviders(body); return r;
      } catch (e) { err.textContent = e.message; }
    };
    const defaultSelect = el('select', { on: { change: async () => { try { await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ defaultModel: defaultSelect.value }) }); loadModels(); } catch (e) { err.textContent = e.message; } } } },
      el('option', { value: '', textContent: '自动（内置第一个，没有则第一个服务商）' }),
      ...(data.builtin ? data.builtin.models.map(m => el('option', { value: m, textContent: '内置 · ' + m })) : []),
      ...data.providers.filter(p => p.enabled).flatMap(p => p.models.map(m => el('option', { value: p.slug + '/' + m, textContent: p.name + ' · ' + m }))));
    defaultSelect.value = data.defaultModel;
    body.append(
      el('p', { class: 'team-note', textContent: '接入 ChatGPT API、DeepSeek、通义千问、Kimi、智谱、豆包等任意 OpenAI 兼容服务。接入后成员可在顶栏选择模型，智能体和 /v1 API 也可使用，引用名为 “标识/模型名”。密钥加密保存在服务器，不会回传到浏览器。' }),
      el('div', { class: 'team-form' }, el('label', { class: 'wide' }, '默认模型　', defaultSelect)),
      data.builtin && el('div', { class: 'team-row' }, el('div', { class: 'grow' }, '内置（服务器环境变量）', el('small', { textContent: `${data.builtin.baseUrl}　模型 ${data.builtin.models.join('、')}` }))),
      data.providers.map(p => el('div', { class: 'team-row' },
        el('div', { class: 'grow' }, `${p.name}${p.enabled ? '' : '（已停用）'}${p.membersAllowed ? '' : '（仅管理员）'}`,
          el('small', { textContent: `标识 ${p.slug}　${p.baseUrl}　密钥 ${p.keyMask || '无'}` }), el('small', { textContent: '模型：' + p.models.join('、') })),
        el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' },
          el('button', { type: 'button', class: 'secondary', textContent: '编辑', on: { click: () => { body.replaceChildren(); renderProviders(body, p); } } }),
          el('button', { type: 'button', class: 'secondary', textContent: p.enabled ? '停用' : '启用', on: { click: async () => { await api('/api/admin/providers/' + p.id, { method: 'PATCH', body: JSON.stringify({ enabled: !p.enabled }) }); render(); } } }),
          el('button', { type: 'button', class: 'secondary danger', textContent: '删除', on: { click: async () => { if (!await ymConfirm('删除服务商“' + p.name + '”？使用它模型的智能体会改用默认模型。', { danger: true, okText: '确定' })) return; await api('/api/admin/providers/' + p.id, { method: 'DELETE' }); render(); } } })))),
      el('h3', { textContent: editing ? '编辑：' + editing.name : '添加服务商' }),
      el('div', { class: 'team-form' }, f.template, f.name, f.slug, f.baseUrl, f.apiKey, f.models,
        el('label', { class: 'wide' }, f.members, ' 团队成员可以使用（取消勾选则只有主账号能用）'),
        el('button', { type: 'button', class: 'secondary', textContent: '拉取模型', on: { click: async () => { const r = await probe(false); if (r?.models?.length) { f.models.value = r.models.join('\n'); labels = r.labels || {}; const named = Object.keys(labels).length; if (named) info.textContent += '（其中 ' + named + ' 个带名称，保存后下拉里显示名称）'; } } } }),
        el('button', { type: 'button', class: 'secondary', textContent: '测试对话接口', on: { click: () => probe(true) } }),
        el('button', { type: 'button', class: 'secondary wide', textContent: editing ? '保存修改' : '添加', on: { click: save } }),
        editing && el('button', { type: 'button', class: 'secondary wide', textContent: '取消编辑', on: { click: () => { body.replaceChildren(); renderProviders(body); } } })),
      info, err);
  }

  // ---------- 工作区：共享目录 + 多智能体协作 ----------
  async function readSse(response, onEvent) {
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        let type = 'message', data = '';
        for (const line of block.split('\n')) { if (line.startsWith('event:')) type = line.slice(6).trim(); else if (line.startsWith('data:')) data += line.slice(5).trim(); }
        if (data) { try { onEvent({ type, ...JSON.parse(data) }); } catch { /* 忽略坏块 */ } }
      }
    }
  }
  const MODE_NAMES = { pipeline: '接力', roundtable: '圆桌讨论', supervisor: '主管调度' };
  const STATUS_NAMES = { running: '运行中', completed: '已完成', stopped: '已停止', failed: '失败', step_limit: '达到步数上限', bad_decision: '主管未给出有效指令' };

  // 工作区列表：和 ChatGPT / Claude 的“项目”、Notion / 网盘的空间一致——搜索 + 新建按钮在顶部，下面是卡片；
  // 新建走弹窗（名称、谁可以访问、成员），点卡片进入；删除放在卡片的次要位置。
  const WS_VIS = { private: ['🔒', '仅自己'], members: ['👥', '指定成员'], team: ['🏢', '全团队'], public: ['🌐', '团队内公开'] };
  const agoText = at => { const m = Math.max(0, Math.round((Date.now() - at) / 60000)); return m < 1 ? '刚刚' : m < 60 ? m + ' 分钟' : m < 1440 ? Math.round(m / 60) + ' 小时' : Math.round(m / 1440) + ' 天'; };
  // 工作区页：每个工作区是一个“文件夹”，下面列出它最近的协作任务（标题 + 摘要 + 多久之前），和 Cindy 的任务列表是同一种排法。
  // ---- 工作区的新建 / 设置 / 打开：都在首页完成（侧栏里点），不再有单独的页面 ----
  async function wsMemberField(init, label) {
    let options = null;
    if (me && me.role === 'admin') { try { options = (await api('/api/workspaces/member-options')).members; } catch { options = null; } }
    const chosen = init.members || (options ? [] : '');
    return options
      ? { name: 'members', label, type: 'checklist', value: Array.isArray(chosen) ? chosen : [], options: options.map(m => ({ value: m.email, label: m.displayName, sub: m.email })), empty: '团队里还没有其他成员，先到“团队成员”里添加', showWhen: { name: 'visibility', equals: 'members' } }
      : { name: 'members', label: label + '（输入邮箱，逗号分隔）', value: Array.isArray(chosen) ? chosen.join(', ') : chosen, placeholder: 'a@example.com, b@example.com', hint: '创建后可以在设置里继续调整', showWhen: { name: 'visibility', equals: 'members' } };
  }
  const wsVisOptions = () => Object.entries(WS_VIS).map(([value, [icon, label]]) => ({ value, label: icon + ' ' + label }));
  const wsPicked = v => v.visibility !== 'members' ? [] : Array.isArray(v.members) ? v.members : String(v.members || '').split(/[,，\s]+/).filter(Boolean);
  async function wsCreateDialog(init = {}, after = () => {}) {
    const v = await ymForm('新建工作区', [
      { name: 'name', label: '名称', value: init.name || '', required: true, placeholder: '如 官网改版' },
      { name: 'visibility', label: '谁可以访问', type: 'select', value: init.visibility || 'private', options: wsVisOptions() },
      await wsMemberField(init, '成员')], { okText: '创建' });
    if (!v) return;
    try { await api('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: v.name, visibility: v.visibility, members: wsPicked(v) }) }); after(); }
    catch (e) { await ymAlert(e.message); wsCreateDialog({ ...v, members: v.members }, after); }
  }
  // 设置：名称、谁可以访问、成员；创建者 / 主账号还能在这里删除工作区
  async function wsSettingsDialog(w, after = () => {}) {
    const canManage = w.canManage ?? (w.mine || (me && me.role === 'admin'));
    if (!canManage) { await ymAlert('创建者：' + (w.owner || '—') + '\n访问范围：' + (WS_VIS[w.visibility] || WS_VIS.private).join(' ') + '\n成员：' + ((w.members || []).join('、') || '无') + '\n\n只有创建者或主账号可以修改设置。', { title: '工作区信息：' + w.name }); return; }
    const v = await ymForm('工作区设置', [
      { name: 'name', label: '名称', value: w.name, required: true },
      { name: 'visibility', label: '谁可以访问', type: 'select', value: w.visibility || (w.members?.length ? 'members' : 'private'), options: wsVisOptions() },
      await wsMemberField({ members: w.members || [] }, '成员'),
      ...(me && me.role === 'admin' ? [{ name: 'label', label: '机密标签（仅主账号可改）', type: 'select', value: w.label === 'confidential' ? 'confidential' : 'normal', options: [{ value: 'normal', label: '普通' }, { value: 'confidential', label: '机密：内容不能发给未被允许的模型' }], hint: '在“安全与熔断”页决定哪些模型可以处理机密工作区' }] : [])], { okText: '保存', extra: { text: '删除工作区' } });
    if (!v) return;
    if (v.__extra) {
      if (!await ymConfirm('删除工作区“' + w.name + '”？目录里的文件和协作记录都会被删除。', { danger: true, okText: '删除' })) return;
      try { await api('/api/workspaces/' + w.id, { method: 'DELETE' }); after(); } catch (e) { ymAlert(e.message); }
      return;
    }
    try { await api('/api/workspaces/' + w.id, { method: 'PATCH', body: JSON.stringify({ name: v.name, visibility: v.visibility, members: wsPicked(v), ...(v.label !== undefined ? { label: v.label } : {}) }) }); after(); }
    catch (e) { await ymAlert(e.message); wsSettingsDialog({ ...w, name: v.name, visibility: v.visibility, members: wsPicked(v) }, after); }
  }
  // 在首页上层打开工作区（文件 / 多智能体协作 / 共享与成员），关闭后回到原来的对话
  let wsOverlay = null;
  const wsCloseOverlay = () => { wsOverlay?.remove(); wsOverlay = null; document.removeEventListener('keydown', wsOverlayKey, true); window.dispatchEvent(new CustomEvent('yumeiro:workspaces-changed')); };
  const wsOverlayKey = e => { if (e.key === 'Escape' && !document.querySelector('.ymd-back')) { e.stopPropagation(); wsCloseOverlay(); } };
  async function wsOpenOverlay(w, runnerOn, startTab) {
    wsCloseOverlay();
    const box = el('div', { class: 'team-main ws-overlay-body' });
    wsOverlay = el('div', { class: 'ws-overlay', role: 'dialog', ariaLabel: '工作区 ' + w.name, on: { click: e => { if (e.target === wsOverlay) wsCloseOverlay(); } } }, el('div', { class: 'ws-overlay-card' }, box));
    document.body.append(wsOverlay); document.addEventListener('keydown', wsOverlayKey, true);
    window.dispatchEvent(new CustomEvent('yumeiro:workspace-open', { detail: { id: w.id } }));
    try { await renderWorkspace(box, w, runnerOn, startTab); } catch (e) { box.replaceChildren(el('div', { class: 'team-err', textContent: e.message }), el('button', { type: 'button', class: 'secondary', textContent: '关闭', on: { click: wsCloseOverlay } })); }
  }
  window.YumeiroWS = {
    create: after => wsCreateDialog({}, after),
    settings: (w, after) => wsSettingsDialog(w, after),
    open: (w, runnerOn, tab) => wsOpenOverlay(w, runnerOn, tab)
  };

  async function renderWorkspaces(body) {
    const data = await api('/api/workspaces'), err = errBox();
    const want = new URLSearchParams(location.search), target = want.get('open') && data.workspaces.find(x => x.id === want.get('open'));
    if (target) { history.replaceState(null, '', location.pathname); renderWorkspace(body, target, data.runner, want.get('tab') || undefined); return; }
    const search = el('input', { type: 'search', class: 'mk-search', placeholder: '搜索工作区或任务', value: '' });
    const list = el('div', { class: 'ws-list' });
    const createWs = init => wsCreateDialog(init, () => render());
    const section = w => {
      const [icon, label] = WS_VIS[w.visibility] || WS_VIS.private, canManage = w.canManage ?? (w.mine || me.role === 'admin');
      const open = tab => { body.replaceChildren(); renderWorkspace(body, w, data.runner, tab); };
      const runs = (w.recent || []);
      const rows = runs.length
        ? runs.map(r => el('button', { type: 'button', class: 'ws-run', on: { click: () => open('tasks') } },
            el('span', { class: 'ws-run-ico', textContent: r.status === 'running' ? '⏳' : r.status === 'completed' ? '✅' : '▫️' }),
            el('span', { class: 'ws-run-main' }, el('strong', { textContent: r.task }), el('small', { textContent: (MODE_NAMES[r.mode] || r.mode) + ' · ' + (STATUS_NAMES[r.status] || r.status) + (r.userEmail ? ' · ' + r.userEmail : '') })),
            el('span', { class: 'ws-run-time', textContent: agoText(r.createdAt) })))
        : [el('div', { class: 'ws-run-empty' }, el('span', { textContent: '还没有协作任务' }), el('button', { type: 'button', class: 'secondary', textContent: '开始第一个任务', on: { click: () => open('tasks') } }))];
      return el('section', { class: 'ws-sec' },
        el('div', { class: 'ws-sec-head' },
          el('span', { class: 'ws-folder', textContent: '📁' }), el('strong', { class: 'ws-name', textContent: w.name, title: w.name, on: { click: () => open() } }),
          el('span', { class: 'ws-badge', textContent: icon + ' ' + label }), el('small', { class: 'ws-sub', textContent: (w.mine ? '我创建的' : '创建者 ' + (w.owner || '—')) + ' · 成员 ' + (w.members.length + 1) + ' 人' }),
          el('span', { class: 'sp' }),
          el('button', { type: 'button', class: 'secondary', textContent: '打开', on: { click: () => open() } }),
          canManage ? el('button', { type: 'button', class: 'secondary danger', textContent: '删除', on: { click: async () => { if (!await ymConfirm('删除工作区“' + w.name + '”？目录里的文件和协作记录都会被删除。', { danger: true, okText: '删除' })) return; try { await api('/api/workspaces/' + w.id, { method: 'DELETE' }); render(); } catch (x) { ymAlert(x.message); } } } }) : null),
        el('div', { class: 'ws-runs' }, ...rows));
    };
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      const shown = data.workspaces.filter(w => !q || w.name.toLowerCase().includes(q) || (w.recent || []).some(r => r.task.toLowerCase().includes(q)))
        .sort((a, b) => ((b.recent?.[0]?.createdAt) || b.createdAt) - ((a.recent?.[0]?.createdAt) || a.createdAt));
      list.replaceChildren(...(shown.length ? shown.map(section) : [el('div', { class: 'team-empty' }, el('div', { textContent: q ? '没有匹配的工作区或任务。' : '还没有工作区。工作区用来放一个项目的文件，并让智能体和同事一起协作。' }), q ? null : el('button', { type: 'button', class: 'primary', textContent: '＋ 新建工作区', on: { click: () => createWs() } }))]));
    };
    search.addEventListener('input', draw);
    body.append(
      !data.runner && el('div', { class: 'team-err', textContent: '管理员还没有安装智能体运行器：仍可用“模型智能体”协作，但没有文件目录，也不能使用 Claude Code / Codex / Pi。' }),
      el('div', { class: 'ws-toolbar' }, search, el('button', { type: 'button', class: 'primary', textContent: '＋ 新建工作区', on: { click: () => createWs() } })), err, list);
    draw();
  }

  // 文件管理：版本历史与还原、过期文件清理（人工确认后才删除，删除前一律先备份）
  function renderFileManager(body, w) {
    const box = el('div', {}), err = errBox(), note = el('div', { class: 'team-note' });
    const size = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n > 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B';
    const base = `/api/workspaces/${w.id}`;
    body.append(el('h4', { textContent: '版本历史与过期清理' }), note, err, box);
    const showHistory = async only => {
      const { files } = await api(base + '/history');
      const viewer = el('pre', { style: 'white-space:pre-wrap;max-height:200px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:8px;font-size:12px', hidden: true });
      const rows = files.length ? files.map(f => el('div', { class: 'team-row' },
        el('div', { class: 'grow' }, f.path, el('small', { textContent: `${f.versions} 个版本　最近 ${fmt(f.latestAt)}　${f.exists ? '' : '（已删除，可还原）'}` })),
        el('button', { type: 'button', class: 'secondary', textContent: '查看版本', 'data-path': f.path, on: { click: async () => {
          const { versions } = await api(`${base}/versions?path=${encodeURIComponent(f.path)}`);
          const list = el('div', {}, versions.map(v => el('div', { class: 'team-row' }, el('span', { class: 'grow', textContent: fmt(v.at) + '　' + size(v.size) }),
            el('button', { type: 'button', class: 'secondary', textContent: '预览', on: { click: async () => { const r = await api(`${base}/versions?path=${encodeURIComponent(f.path)}&id=${encodeURIComponent(v.id)}`); viewer.hidden = false; viewer.textContent = r.type === 'binary' ? '（二进制文件，不显示）' : r.content + (r.truncated ? '\n…（已截断）' : ''); } } }),
            el('button', { type: 'button', class: 'secondary', textContent: '还原到此版本', on: { click: async () => { if (!await ymConfirm(`把 ${f.path} 还原到 ${fmt(v.at)} 的版本？当前内容会先备份。`, { danger: true, okText: '确定' })) return; try { await api(base + '/restore', { method: 'POST', body: JSON.stringify({ path: f.path, id: v.id }) }); err.textContent = ''; note.textContent = '已还原 ' + f.path; showHistory(); } catch (e) { err.textContent = e.message; } } } }))));
          box.replaceChildren(el('button', { type: 'button', class: 'secondary', textContent: '← 返回', on: { click: showHistory } }), el('p', { class: 'team-note', textContent: f.path }), list, viewer);
        } } }))) : [el('p', { class: 'team-note', textContent: '还没有历史版本。保存、删除文件或智能体运行前后都会自动备份。' })];
      box.replaceChildren(el('div', { class: 'team-note', textContent: '每个文件最多保留 30 个版本；删除文件不会删除它的备份。' }), ...rows);
      if (typeof only === 'string') { const target = [...box.querySelectorAll('button[data-path]')].find(b => b.getAttribute('data-path') === only); if (target) target.click(); else { note.textContent = '这个文件还没有历史版本：保存、删除或被智能体修改后才会产生。'; } box.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
    };
    const showExpiry = async () => {
      const d = await api(base + '/expiry');
      const days = el('input', { type: 'number', min: 0, max: 3650, value: d.policy.days || '', placeholder: '过期天数（≥7，空=关闭）', style: 'width:200px' });
      const protect = el('input', { class: 'wide', value: d.policy.protect.join(', '), placeholder: '保护路径前缀，逗号分隔，如 docs, assets/final（这些永不清理）' });
      const auto = el('input', { type: 'checkbox', checked: d.policy.autoDelete });
      const picks = new Map(d.candidates.map(c => [c.path, true]));
      const rows = d.candidates.length ? d.candidates.map(c => el('label', { class: 'team-row', style: 'cursor:pointer' },
        el('input', { type: 'checkbox', checked: true, on: { change: e => picks.set(c.path, e.target.checked) } }),
        el('span', { class: 'grow', textContent: c.path }), el('small', { textContent: `${size(c.size)}　${c.ageDays} 天未修改` }))) : [el('p', { class: 'team-note', textContent: d.policy.days ? '没有过期文件。' : '尚未设置过期天数。' })];
      const approve = el('button', { type: 'button', class: 'secondary', textContent: '确认删除选中的文件', on: { click: async () => {
        const items = d.candidates.filter(c => picks.get(c.path)).map(c => ({ path: c.path, mtime: c.mtime }));
        if (!items.length) { err.textContent = '没有选择文件'; return; }
        if (!await ymConfirm(`确认删除 ${items.length} 个过期文件？\n删除前会先备份，之后可在“版本历史”里还原。`, { danger: true, okText: '确定' })) return;
        try { const r = await api(base + '/expiry/approve', { method: 'POST', body: JSON.stringify({ confirm: true, items }) }); err.textContent = ''; note.textContent = `已删除 ${r.deleted.length} 个，跳过 ${r.skipped.length} 个${r.skipped.length ? '（' + r.skipped.map(s => s.path + '：' + s.reason).join('；') + '）' : ''}`; showExpiry(); } catch (e) { err.textContent = e.message; }
      } } });
      const save = el('button', { type: 'button', class: 'primary', textContent: '保存规则', on: { click: async () => {
        try {
          const body2 = { days: Number(days.value) || 0, protect: protect.value, autoDelete: auto.checked };
          if (auto.checked && !d.policy.autoDelete) { if (!await ymConfirm('开启后，系统每天会自动删除超过 ' + body2.days + ' 天未修改的文件（保护路径除外）。\n每个文件删除前都会先备份，可以还原。\n单次超过 200 个文件会暂停自动删除，改为等你手动确认。\n\n确认开启自动删除？', { danger: true, okText: '确定' })) return; body2.confirm = true; }
          await api(base + '/expiry', { method: 'PUT', body: JSON.stringify(body2) }); err.textContent = ''; note.textContent = '规则已保存'; showExpiry();
        } catch (e) { err.textContent = e.message; }
      } } });
      box.replaceChildren(
        el('div', { class: 'team-note', textContent: `共 ${d.fileCount} 个文件，合计 ${size(d.total)}${d.truncated ? '（文件过多，只统计了前 20000 个）' : ''}。` }),
        d.canManage ? el('div', { class: 'team-form' }, days, protect, el('label', {}, auto, ' 人工确认后启用自动删除'), save) : el('p', { class: 'team-note', textContent: `规则：${d.policy.days ? d.policy.days + ' 天未修改视为过期' : '未启用'}。只有创建者或主账号可以设置和确认删除。` }),
        d.policy.autoDelete ? el('p', { class: 'team-note', textContent: `自动删除已开启（${d.policy.autoEnabledBy || '—'} 于 ${fmt(d.policy.autoEnabledAt)} 确认）。` }) : null,
        el('h4', { textContent: `待清理 ${d.candidates.length} 个` }), ...rows, d.canManage && d.candidates.length ? approve : null,
        d.log.length ? el('details', {}, el('summary', { textContent: '最近的清理与还原记录' }), ...d.log.map(l => el('div', { class: 'team-note', textContent: `${fmt(l.at)}　${l.by}${l.auto ? '（自动）' : ''}　${l.restored ? '还原 ' + l.restored : l.blocked ? l.note : '删除 ' + l.deleted + ' 个' + (l.skipped ? '，跳过 ' + l.skipped : '')}` }))) : null);
    };
    const tabs = el('div', { style: 'display:flex;gap:6px;margin-bottom:6px' },
      el('button', { type: 'button', class: 'secondary', textContent: '过期清理', on: { click: () => showExpiry().catch(e => { err.textContent = e.message; }) } }),
      el('button', { type: 'button', class: 'secondary', textContent: '版本历史', on: { click: () => showHistory().catch(e => { err.textContent = e.message; }) } }));
    note.after(tabs);
    showExpiry().catch(e => { err.textContent = e.message; });
    return { showFile: path => showHistory(path).catch(e => { err.textContent = e.message; }) };
  }

  async function renderWorkspace(body, w, runnerOn, startTab) {
    const [engineData] = await Promise.all([api('/api/engines'), loadAgents()]);
    const engines = engineData.engines, err = errBox();
    const back = el('button', { type: 'button', class: 'secondary', textContent: wsOverlay ? '✕ 关闭' : '← 返回工作区列表', on: { click: () => (wsOverlay ? wsCloseOverlay() : render()) } });
    // 页面分成三个标签：文件与项目 / 多智能体协作 / 共享与成员（和 ChatGPT、Claude 的项目页一样，先看内容，共享设置放在单独一页）
    const VISN = { private: '🔒 仅自己', members: '👥 指定成员', team: '🏢 全团队', public: '🌐 团队内公开' };
    const secFiles = el('div'), secTasks = el('div'), secChats = el('div'), secShare = el('div'), badge = el('span', { class: 'ws-badge', textContent: VISN[w.visibility] || VISN.private });
    const tabDefs = [...(runnerOn ? [['files', '文件与项目', secFiles]] : []), ['chats', '对话与资源', secChats], ['tasks', '多智能体协作', secTasks], ['share', '共享与成员', secShare]];
    const tabBtns = tabDefs.map(([id, label]) => el('button', { type: 'button', class: 'ws-tab', textContent: label, on: { click: () => pickTab(id) } }));
    const pickTab = id => tabDefs.forEach(([tid, , sec], k) => { sec.hidden = tid !== id; tabBtns[k].classList.toggle('on', tid === id); });
    body.append(back, el('div', { class: 'ws-head' }, el('h3', { textContent: w.name, style: 'margin:0' }), badge, el('button', { type: 'button', class: 'secondary', textContent: '📱 发到手机', title: '生成二维码，用手机软件扫一扫打开这个工作区', style: 'margin-left:auto', on: { click: () => window.ymPhoneQr?.(location.origin + '/?open=workspace:' + encodeURIComponent(w.id), w.name) } })), el('div', { class: 'ws-tabs' }, ...tabBtns));

    if (w.canManage ?? (w.mine || me.role === 'admin')) {
      const memberPanel = el('div', {}), search = el('input', { placeholder: '输入用户名或邮箱搜索成员（至少 2 个字符）', class: 'wide' }), results = el('div', {}), memberList = el('div', { class: 'workspace-members' });
      const details = () => Array.isArray(w.memberDetails) ? w.memberDetails : (w.members || []).map(email => ({ id: '', email, displayName: email }));
      const drawMembers = () => {
        const items = details();
        memberList.replaceChildren(...(items.length ? items.map(member => {
          const row = el('div', { class: 'team-row' }, el('div', { class: 'grow' }, member.displayName || member.email, el('small', { textContent: member.email })));
          return row;
        }) : [el('p', { class: 'team-note', textContent: '还没有指定成员。' })]));
      };
      const invite = async () => {
        const q = search.value.trim();
        if (q.length < 2) { err.textContent = '请输入至少 2 个字符'; return; }
        try {
          const data = await api('/api/workspaces/' + w.id + '/members/search?q=' + encodeURIComponent(q));
          const candidateRow = candidate => {
            const row = el('div', { class: 'team-row' }, el('div', { class: 'grow' }, candidate.displayName, el('small', { textContent: candidate.email })));
            row.append(el('button', { type: 'button', class: 'secondary', textContent: '邀请', on: { click: async () => {
              try { const result = await api('/api/workspaces/' + w.id + '/members', { method: 'POST', body: JSON.stringify({ userId: candidate.id }) }); Object.assign(w, result.workspace); drawMembers(); results.replaceChildren(); search.value = ''; info.textContent = result.alreadyMember ? '该成员已经在空间中' : '成员已加入工作区'; } catch (e) { err.textContent = e.message; }
            } } }));
            return row;
          };
          results.replaceChildren(...(data.members.length ? data.members.map(candidateRow) : [el('p', { class: 'team-note', textContent: '没有找到可邀请的成员。' })]));
        } catch (e) { err.textContent = e.message; }
      };
      memberPanel.append(el('h4', { textContent: '成员列表' }), memberList, el('div', { class: 'team-form' }, search, el('button', { type: 'button', class: 'secondary', textContent: '搜索并邀请成员', on: { click: invite } })), results);
      secShare.append(memberPanel); drawMembers();
    }
    if (!(w.canManage ?? (w.mine || me.role === 'admin'))) {
      const members = Array.isArray(w.memberDetails) ? w.memberDetails : (w.members || []).map(email => ({ email, displayName: email }));
      const rows = members.map(member => el('div', { class: 'team-row' }, el('div', { class: 'grow' }, member.displayName || member.email, el('small', { textContent: member.email }))));
      secShare.append(el('h4', { textContent: '成员列表' }), ...(rows.length ? rows : [el('p', { class: 'team-note', textContent: '还没有指定成员。' })]));
    }
    if (w.canManage ?? (w.mine || me.role === 'admin')) {
      const visibility = el('select', {}, [['private', '仅自己'], ['members', '指定成员'], ['team', '全团队'], ['public', '团队内公开']].map(([v, t]) => el('option', { value: v, textContent: t, selected: v === (w.visibility || (w.members.length ? 'members' : 'private')) })));
      secShare.append(el('h4', { textContent: '谁可以访问' }), el('div', { class: 'team-form' }, visibility, el('button', { type: 'button', class: 'primary wide', textContent: '保存共享范围', on: { click: async () => {
        try { const result = await api('/api/workspaces/' + w.id, { method: 'PATCH', body: JSON.stringify({ visibility: visibility.value }) }); Object.assign(w, result.workspace); badge.textContent = VISN[w.visibility] || VISN.private; err.textContent = ''; info.textContent = '共享范围已保存'; } catch (e) { err.textContent = e.message; }
      } } })));
    }
    // ---- 对话与资源：这个工作区里的聊天、直接新建对话、引入已有的智能体 / 技能 / 机器人 ----
    const openChat = id => { if (wsOverlay) wsCloseOverlay(); window.yumeiroReloadChats?.().then(() => window.yumeiroSelectChat?.(id)); };
    const drawChats = async () => {
      let d; try { d = await api('/api/workspaces/' + w.id + '/library'); } catch (e) { secChats.replaceChildren(el('div', { class: 'team-err', textContent: e.message })); return; }
      const canManage = d.canManage, lib = d.library, names = x => x.length ? x.map(i => i.name).join('、') : '还没有引入';
      const chatRows = d.chats.length ? d.chats.map(c => el('div', { class: 'team-row' },
        el('div', { class: 'grow' }, c.title || '新对话', el('small', { textContent: c.count + ' 条消息　' + fmt(c.updatedAt) })),
        el('button', { type: 'button', class: 'secondary', textContent: '打开', on: { click: () => openChat(c.id) } }),
        el('button', { type: 'button', class: 'secondary', textContent: '取消关联', on: { click: async () => { try { await api('/api/conversations/' + c.id, { method: 'PATCH', body: JSON.stringify({ workspace_id: '' }) }); drawChats(); } catch (e) { ymAlert(e.message); } } } }))) : [el('p', { class: 'team-note', textContent: '还没有对话。新建一个，或把已有的聊天关联进来；关联的聊天会随工作区一起导出。' })];
      const newChat = async () => {
        const v = await ymForm('在工作区里新建对话', [
          { name: 'title', label: '对话名称（可不填）', placeholder: '比如：首页配色讨论', hint: '自己起的名字不会再被 AI 自动改掉。' },
          { name: 'agent', label: '使用的智能体', type: 'select', value: '', options: [{ value: '', label: '默认 Yumeiro' }, ...lib.agents.map(a => ({ value: a.id, label: a.name }))], hint: lib.agents.length ? '只列出这个工作区引入的智能体。' : '工作区还没有引入智能体，可以在下面的“引入的资源”里添加。' }
        ], { okText: '新建并打开' });
        if (!v) return;
        try {
          const c = (await api('/api/conversations', { method: 'POST', body: JSON.stringify({ workspace_id: w.id, agent_id: v.agent || '' }) })).conversation;
          if (v.title.trim()) await api('/api/conversations/' + c.id, { method: 'PATCH', body: JSON.stringify({ title: v.title.trim() }) });
          openChat(c.id);
        } catch (e) { ymAlert(e.message); }
      };
      const linkChats = async () => {
        if (!d.candidates.length) { ymAlert('没有可以关联的聊天了。'); return; }
        const v = await ymForm('关联已有的聊天', [{ name: 'ids', label: '选择要加入这个工作区的聊天', type: 'checklist', value: [], options: d.candidates.map(c => ({ value: c.id, label: c.title || '新对话', sub: (c.workspaceId ? '已在别的工作区 · ' : '') + c.count + ' 条消息' })), empty: '没有可选的聊天' }], { okText: '关联' });
        if (!v || !v.ids.length) return;
        try { for (const id of v.ids) await api('/api/conversations/' + id, { method: 'PATCH', body: JSON.stringify({ workspace_id: w.id }) }); drawChats(); } catch (e) { ymAlert(e.message); }
      };
      const pickLib = (kind, title) => async () => {
        const v = await ymForm('引入' + title, [{ name: 'ids', label: '选择要在这个工作区使用的' + title, type: 'checklist', value: lib[kind].map(i => i.id), options: d.available[kind].map(i => ({ value: i.id, label: i.name, sub: i.description || '' })), empty: '还没有可用的' + title + '，先到“' + (kind === 'bots' ? '机器人' : kind === 'skills' ? '技能' : '智能体') + '”里创建或从市场添加' }], { okText: '保存' });
        if (!v) return;
        try { await api('/api/workspaces/' + w.id + '/library', { method: 'PUT', body: JSON.stringify({ [kind]: v.ids }) }); drawChats(); } catch (e) { ymAlert(e.message); }
      };
      const libRow = (kind, label, title) => el('div', { class: 'team-row' }, el('div', { class: 'grow' }, label, el('small', { textContent: names(lib[kind]) })), canManage ? el('button', { type: 'button', class: 'secondary', textContent: '选择', on: { click: pickLib(kind, title) } }) : null);
      secChats.replaceChildren(
        el('h4', { textContent: '这个工作区的对话' }),
        el('div', { class: 'ws-bar' }, el('button', { type: 'button', class: 'primary', textContent: '＋ 新建对话', on: { click: newChat } }), el('button', { type: 'button', class: 'secondary', textContent: '关联已有聊天', on: { click: linkChats } })),
        ...chatRows,
        el('h4', { textContent: '引入的资源' }),
        el('p', { class: 'team-note', textContent: '引入的技能会自动用在这个工作区的对话里；导出给 AI 工具时，技能、智能体和机器人会一起写成其他软件能读的文件。' }),
        libRow('agents', '智能体', '智能体'), libRow('skills', '技能', '技能'), libRow('bots', '机器人', '机器人'));
      window.dispatchEvent(new CustomEvent('yumeiro:chat-linked'));
    };
    drawChats();
    const info = el('div', { class: 'team-note' });
    body.append(info, err, secFiles, secChats, secTasks, secShare); pickTab(startTab && tabDefs.some(t => t[0] === startTab) ? startTab : tabDefs[0][0]);

    // 文件
    if (runnerOn) {
      const list = el('div', {}), viewer = el('pre', { style: 'white-space:pre-wrap;max-height:220px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:8px;font-size:12px', hidden: true });
      const crumb = el('div', { class: 'team-note' });
      let current = '', fileManager = null;
      const projStatus = el('span', { class: 'team-note' });
      const previewFile = async rel => { try { const r = await api(`/api/workspaces/${w.id}/preview-link`, { method: 'POST', body: JSON.stringify(rel ? { path: rel } : {}) }); window.open(r.url, '_blank', 'noopener'); err.textContent = ''; projStatus.textContent = '预览链接 12 小时内有效；页面在安全沙箱里运行，不能访问本站数据，也不能连接外网。'; } catch (e) { err.textContent = e.message; } };
      // 搜索结果 / 文件预览里的命中高亮：用文本节点 + <mark> 拼出来（不用 innerHTML，文件内容里的 HTML 不会被执行）
      const markNode = text => el('mark', { textContent: text, style: 'background:#fde68a;color:#1f1f1f;border-radius:3px;padding:0 1px' });
      const highlighted = (text, q) => { const T = window.YumeiroTools; return (T && T.splitMatches ? T.splitMatches(text, q) : [{ t: text, hit: false }]).map(part => (part.hit ? markNode(part.t) : document.createTextNode(part.t))); };
      const showFile = (r, hl) => {
        if (r.type === 'binary') { viewer.textContent = '（二进制文件，不显示）'; return; }
        viewer.replaceChildren(...(hl ? highlighted(r.content, hl) : [document.createTextNode(r.content)]), document.createTextNode(r.truncated ? '\n…（已截断）' : ''));
        const first = viewer.querySelector('mark'); if (first) first.scrollIntoView({ block: 'center' });
      };
      const open = async (rel, hl = '') => {
        try {
          const r = await api(`/api/workspaces/${w.id}/files?path=${encodeURIComponent(rel)}`);
          if (r.type === 'dir') {
            current = rel; viewer.hidden = true; crumb.textContent = '/' + rel;
            list.replaceChildren(...(rel ? [el('div', { class: 'team-row' }, el('a', { href: '#', textContent: '‥ 上一级', on: { click: e => { e.preventDefault(); open(rel.split('/').slice(0, -1).join('/')); } } }))] : []),
              ...(r.entries.length ? r.entries.map(x => { const full = (rel ? rel + '/' : '') + x.name, isFile = x.type === 'file'; return el('div', { class: 'team-row' }, el('a', { href: '#', class: 'grow', textContent: (x.type === 'dir' ? '📁 ' : '📄 ') + x.name, on: { click: e => { e.preventDefault(); open(full); } } }), el('small', { textContent: x.type === 'dir' ? '' : `${x.size > 1024 ? (x.size / 1024).toFixed(1) + ' KB' : x.size + ' B'}${x.mtime ? '　' + new Date(x.mtime).toLocaleString() : ''}` }), isFile && /\.(html?|md|markdown|svg|png|jpe?g|gif|webp|pdf|txt|json|css|js)$/i.test(x.name) ? el('button', { type: 'button', class: 'secondary', textContent: '预览', title: '在新标签页在线预览（沙箱里运行）', on: { click: () => previewFile(full) } }) : null, isFile ? el('a', { href: `/api/workspaces/${w.id}/download?path=${encodeURIComponent(full)}`, textContent: '下载', title: '下载原始文件（含图片等二进制文件）', class: 'secondary', style: 'text-decoration:none' }) : null, isFile ? el('button', { type: 'button', class: 'secondary', textContent: '历史', title: '查看这个文件的历史版本 / 还原', on: { click: () => fileManager && fileManager.showFile(full) } }) : null, (w.mine || me.role === 'admin') ? el('button', { type: 'button', class: 'secondary danger', textContent: '删除', title: '删除前会先备份，可在历史里还原', on: { click: async () => { if (!await ymConfirm(`删除 ${full}${x.type === 'dir' ? '（整个文件夹）' : ''}？\n删除前会先备份，可在“版本历史”里还原。`, { danger: true, okText: '确定' })) return; try { await api(`/api/workspaces/${w.id}/files?path=${encodeURIComponent(full)}`, { method: 'DELETE' }); err.textContent = ''; open(rel); } catch (e) { err.textContent = e.message; } } } }) : null); }) : [el('p', { class: 'team-note', textContent: '这里还没有文件。' })]));
          } else { viewer.hidden = false; crumb.textContent = '/' + rel; showFile(r, hl); }
        } catch (e) { crumb.textContent = e.message; }
      };
      // 上传：支持任意文件（含图片等二进制），可多选或直接拖到文件列表里；同名文件的旧内容会先自动备份
      const pick = el('input', { type: 'file', multiple: true, hidden: true }), upStatus = el('span', { class: 'team-note' });
      const doUpload = async files => {
        for (const f of files) {
          const target = (current ? current + '/' : '') + f.name;
          upStatus.textContent = '正在上传 ' + f.name + '（' + Math.ceil(f.size / 1024) + ' KB）…';
          try {
            const response = await fetch(`/api/workspaces/${w.id}/upload?path=${encodeURIComponent(target)}`, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': csrf }, body: f });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || '上传失败：' + response.status);
          } catch (e) { err.textContent = f.name + '：' + e.message; upStatus.textContent = ''; return open(current); }
        }
        err.textContent = ''; upStatus.textContent = '上传完成（同名文件的旧内容已自动备份）'; open(current);
      };
      pick.addEventListener('change', () => { if (pick.files.length) doUpload([...pick.files]); pick.value = ''; });
      const uploadBar = el('div', { class: 'ws-bar' }, el('button', { type: 'button', class: 'primary', textContent: '⬆ 上传文件', on: { click: () => pick.click() } }), el('span', { class: 'team-note', textContent: '也可以把文件拖到上面的文件列表里' }), pick, upStatus);
      list.addEventListener('dragover', e => { e.preventDefault(); });
      list.addEventListener('drop', e => { e.preventDefault(); if (e.dataTransfer && e.dataTransfer.files.length) doUpload([...e.dataTransfer.files]); });
      const upPath = el('input', { placeholder: '新文件路径，如 docs/需求.md' }), upText = el('textarea', { placeholder: '文件内容（仅限文本，最大 1 MB；图片等二进制文件请用上面的“上传文件”）' });
      // 文件搜索：搜文件名，勾选“搜内容”则连文件里的文字一起搜（忽略大小写）；命中的部分高亮，点结果打开文件并定位到第一处命中
      const sq = el('input', { type: 'search', placeholder: '搜索文件名 / 内容', 'aria-label': '搜索工作区文件', style: 'flex:1;min-width:140px' });
      const inContent = el('input', { type: 'checkbox', checked: true }), results = el('div', { hidden: true });
      const clearSearch = () => { sq.value = ''; results.hidden = true; list.hidden = false; };
      const renderResults = (r, q) => {
        const head = el('div', { class: 'team-note', textContent: r.results.length ? `找到 ${r.results.length} 个文件（扫描了 ${r.scanned} 个）${r.truncated ? '，结果过多只显示一部分，请换更具体的关键词' : ''}` : `没有找到包含“${q}”的文件名${r.content ? '或内容' : ''}（扫描了 ${r.scanned} 个文件）` });
        results.replaceChildren(head, ...r.results.map(item => el('div', { class: 'team-row', style: 'align-items:flex-start' },
          el('div', { class: 'grow' },
            el('a', { href: '#', title: '打开文件', on: { click: e => { e.preventDefault(); open(item.path, q); } } }, '📄 ', ...highlighted(item.path, q)),
            ...item.lines.map(line => el('div', { style: 'font:12px/1.5 ui-monospace,Consolas,monospace;color:var(--muted);overflow-wrap:anywhere' }, el('span', { textContent: 'L' + line.n + '  ' }), ...highlighted(line.text, q)))),
          el('small', { textContent: item.size > 1024 ? (item.size / 1024).toFixed(1) + ' KB' : item.size + ' B' }))));
      };
      const runSearch = async () => {
        const q = sq.value.trim();
        if (!q) { clearSearch(); return; }
        results.hidden = false; list.hidden = true; results.replaceChildren(el('p', { class: 'team-note', textContent: '搜索中…' }));
        try { renderResults(await api(`/api/workspaces/${w.id}/search?q=${encodeURIComponent(q)}&content=${inContent.checked ? 1 : 0}`), q); err.textContent = ''; } catch (e) { results.replaceChildren(el('p', { class: 'team-note', textContent: e.message })); }
      };
      sq.addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(); else if (e.key === 'Escape') clearSearch(); });
      sq.addEventListener('input', () => { if (!sq.value.trim()) clearSearch(); });
      const searchBar = el('div', { class: 'team-row' }, sq, el('label', { style: 'font-size:12px' }, inContent, '搜内容'), el('button', { type: 'button', class: 'primary', textContent: '搜索', on: { click: runSearch } }));
      secFiles.append(el('h4', { textContent: '文件' }), searchBar, crumb, results, list, viewer, uploadBar,
        el('div', { class: 'team-form' }, upPath, upText, el('button', { type: 'button', class: 'primary', textContent: '保存文件', on: { click: async () => { try { await api(`/api/workspaces/${w.id}/files?path=${encodeURIComponent(upPath.value)}`, { method: 'PUT', body: JSON.stringify({ content: upText.value }) }); upPath.value = ''; upText.value = ''; open(current); } catch (e) { err.textContent = e.message; } } } })));
      // 项目：在线预览 / 整个项目下载 / 本地使用包 / 导入 zip
      const linkStyle = 'padding:6px 10px;border:1px solid var(--line);border-radius:8px;text-decoration:none;font-size:13px;color:inherit';
      const importPick = el('input', { type: 'file', accept: '.zip,application/zip', hidden: true });
      importPick.addEventListener('change', async () => {
        const f = importPick.files[0]; importPick.value = ''; if (!f) return;
        if (!await ymConfirm('把 ' + f.name + ' 导入到这个工作区？\n同名文件会被覆盖（覆盖前旧内容会自动备份，可在“版本历史”里还原）。', { danger: true, okText: '确定' })) return;
        projStatus.textContent = '正在导入…'; err.textContent = '';
        try {
          const response = await fetch(`/api/workspaces/${w.id}/import`, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/zip', 'X-CSRF-Token': csrf }, body: f });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || '导入失败：' + response.status);
          projStatus.textContent = '导入完成：写入 ' + data.written + ' 个文件（覆盖 ' + data.replaced + ' 个）' + (data.ignored ? '，忽略 ' + data.ignored + ' 个' : '') + (data.failed.length ? '，失败 ' + data.failed.length + ' 个：' + data.failed.slice(0, 3).join('、') : '');
          open(current);
        } catch (e) { projStatus.textContent = ''; err.textContent = e.message; }
      });
      const projectBar = el('div', { class: 'ws-bar' },
        el('button', { type: 'button', class: 'primary', textContent: '🌐 在线预览项目', title: '在新标签页打开 index.html（没有则看文件列表里单个文件的“预览”）', on: { click: () => previewFile('') } }),
        el('a', { href: `/api/workspaces/${w.id}/export`, textContent: '📦 下载整个项目 (zip)', title: '把工作区所有文件打包下载', class: 'secondary', style: 'text-decoration:none' }),
        el('a', { href: `/api/workspaces/${w.id}/export?local=1`, textContent: '💻 下载本地使用包', title: '项目文件 + 启动脚本：解压后双击就能在本机使用', class: 'secondary', style: 'text-decoration:none' }),
        el('button', { type: 'button', class: 'secondary', textContent: '🤖 导出给 AI 工具', title: '生成 Claude Code / Cursor / Codex / Copilot / Gemini 能直接读取的版本', on: { click: async () => {
          const v = await ymForm('导出给 AI 工具', [
            { name: 'format', label: '导出形式', type: 'select', value: 'kit', options: [{ value: 'kit', label: '项目压缩包（带 AGENTS.md / CLAUDE.md / Cursor 规则等说明）' }, { value: 'context', label: '单个 Markdown 文件（文件树 + 全部代码，可直接粘贴给 ChatGPT / Claude 网页版）' }], hint: '压缩包适合 Claude Code、Codex、Cursor、Copilot、Gemini CLI 打开；单文件适合粘贴到聊天框。' },
            { name: 'runs', label: '附上对话记录', type: 'select', value: '1', options: [{ value: '1', label: '附上（任务、每一步产出、最终结果）' }, { value: '0', label: '不附' }], hint: '完整对话原文。不管选不选，导出里都会带一份自动整理的「关键记忆」（PROJECT-MEMORY.md）：最近在做什么、做过什么结论、哪些没做完。' }
          ], { okText: '导出' });
          if (!v) return;
          const a = el('a', { href: `/api/workspaces/${w.id}/export?ai=${v.format}&runs=${v.runs}` }); document.body.append(a); a.click(); a.remove();
        } } }),
        el('button', { type: 'button', class: 'secondary', textContent: '⬆ 导入项目 (zip)', on: { click: () => importPick.click() } }),
        (w.mine || me.role === 'admin') ? el('button', { type: 'button', class: 'secondary danger', textContent: '撤销预览链接', title: '让已经发出去的预览链接立刻失效', on: { click: async () => { try { await api(`/api/workspaces/${w.id}/preview-revoke`, { method: 'POST', body: '{}' }); projStatus.textContent = '已撤销：之前生成的预览链接都已失效'; } catch (e) { err.textContent = e.message; } } } }) : null,
        importPick, el('div', { style: 'flex:1 0 100%' }, projStatus));
      const fileHead = [...secFiles.querySelectorAll('h4')].find(h => h.textContent === '文件');
      secFiles.insertBefore(el('h4', { textContent: '项目（在线预览 / 下载 / 本地使用）' }), fileHead); secFiles.insertBefore(projectBar, fileHead);
      open('');
      fileManager = renderFileManager(secFiles, w);
    }

    // 协作
    const task = el('textarea', { class: 'ws-task', rows: 4, maxLength: 20000, placeholder: '要完成的任务。例如：为本项目写一个登录页，并检查安全问题。' });
    const mode = el('select', {}, Object.entries(MODE_NAMES).map(([id, label]) => el('option', { value: id, textContent: label })));
    const rounds = el('input', { type: 'number', min: 1, max: 4, value: 2, title: '圆桌轮数' });
    const rows = el('div', {}), output = el('div', {});
    // 运行方式：一个下拉里按类别列出——“模型对话（智能体）”，以及每个引擎各自适配的模型（Claude Code → Claude 系列，Codex → GPT 系列，Pi → 多服务商）
    const targets = () => {
      const list = [...agentsCache.map(a => ({ type: 'agent', id: a.id, group: '模型对话（智能体，无文件目录）', name: a.name })), { type: 'agent', id: '', group: '模型对话（智能体，无文件目录）', name: '默认模型' }];
      for (const e of engines) {
        const group = e.label + ' · ' + (e.family || '引擎') + ' · 有文件目录';
        const models = e.models && e.models.length ? e.models : [''];
        for (const m of models) list.push({ type: 'engine', id: e.engine, model: m, group, name: m ? m + (m === e.defaultModel ? '（默认）' : '') : '引擎默认模型', maxMode: e.maxMode });
      }
      return list;
    };
    const targetSelect = () => {
      const sel = el('select', { title: '运行方式：模型对话，或某个引擎 + 它适配的模型' }), groups = new Map();
      targets().forEach((t, i) => { if (!groups.has(t.group)) { const g = el('optgroup', { label: t.group }); groups.set(t.group, g); sel.append(g); } groups.get(t.group).append(el('option', { value: i, textContent: t.name })); });
      return sel;
    };
    const addRow = preset => {
      const target = targetSelect();
      const label = el('input', { placeholder: '名称', maxLength: 30, value: preset?.label || '' }), role = el('input', { placeholder: '职责（可选）', maxLength: 200, value: preset?.role || '' });
      const modeSel = el('select', {}, el('option', { value: 'readonly', textContent: '只读' }), el('option', { value: 'edit', textContent: '可改文件' }), el('option', { value: 'exec', textContent: '可改文件 + 运行代码（沙箱）' }));
      if (preset) { const i = targets().findIndex(t => t.type === preset.type && t.id === preset.id && (preset.model === undefined || t.model === preset.model)); if (i >= 0) target.value = i; if (preset.mode) modeSel.value = preset.mode; }
      const row = el('div', { class: 'team-row5' }, label, target, role, modeSel, el('button', { type: 'button', class: 'secondary danger', textContent: '移除', on: { click: () => row.remove() } }));
      row.read = () => { const t = targets()[Number(target.value)]; return t.type === 'engine' ? { kind: 'engine', engine: t.id, model: t.model || undefined, label: label.value, role: role.value, mode: modeSel.value } : { kind: 'agent', agentId: t.id || undefined, label: label.value, role: role.value }; };
      rows.append(row);
    };
    const hasEngine = id => engines.some(e => e.engine === id);
    const preset = () => { rows.replaceChildren(); mode.value = 'pipeline'; addRow({ type: 'agent', id: '', label: '规划', role: '把任务拆成清晰的步骤' }); addRow(hasEngine('claude') ? { type: 'engine', id: 'claude', label: '实现', role: '按步骤完成并写入文件', mode: 'edit' } : { type: 'agent', id: '', label: '实现', role: '按步骤给出完整方案' }); addRow(hasEngine('codex') ? { type: 'engine', id: 'codex', label: '审查', role: '审查实现，指出问题', mode: 'readonly' } : { type: 'agent', id: '', label: '审查', role: '审查并指出问题' }); };
    preset();

    let abort = null;
    const startBtn = el('button', { type: 'button', class: 'primary', textContent: '开始协作' }), stopBtn = el('button', { type: 'button', class: 'secondary danger', textContent: '停止', hidden: true, on: { click: () => abort?.abort() } });
    const history = el('div', {});
    const loadHistory = async () => {
      const { runs } = await api(`/api/workspaces/${w.id}/runs`);
      history.replaceChildren(...(runs.length ? runs.map(r => el('div', { class: 'team-row' }, el('div', { class: 'grow' }, `${MODE_NAMES[r.mode] || r.mode} · ${STATUS_NAMES[r.status] || r.status}`, el('small', { textContent: `${fmt(r.createdAt)}　${r.userEmail || ''}　${r.task}` })),
        el('button', { type: 'button', class: 'secondary', textContent: '查看', on: { click: async () => { const d = (await api(`/api/workspaces/${w.id}/runs/${r.id}`)).run; showRun(d.steps, d.final, d.error); } } }))) : [el('p', { class: 'team-note', textContent: '还没有协作记录。' })]));
    };
    const card = (label, text) => { const pre = el('pre', { style: 'white-space:pre-wrap;margin:6px 0 0;font-size:12px;max-height:240px;overflow:auto', textContent: text || '' }); return { node: el('div', { class: 'team-row', style: 'display:block' }, el('strong', { textContent: label }), pre), pre }; };
    const showRun = (steps, final, error) => { output.replaceChildren(...steps.map(s => card(s.label + (s.round ? `（第 ${s.round} 轮）` : ''), s.text).node), final ? el('div', { class: 'team-secret', style: 'font-family:inherit;white-space:pre-wrap', textContent: '最终结果：\n' + final }) : null, error ? el('div', { class: 'team-err', textContent: error }) : null); };
    startBtn.addEventListener('click', async () => {
      err.textContent = ''; output.replaceChildren(); startBtn.disabled = true; stopBtn.hidden = false;
      abort = new AbortController();
      const cards = {};
      try {
        const response = await fetch(`/api/workspaces/${w.id}/runs`, { method: 'POST', credentials: 'same-origin', signal: abort.signal, headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'X-CSRF-Token': csrf }, body: JSON.stringify({ task: task.value, mode: mode.value, rounds: Number(rounds.value || 2), participants: [...rows.children].map(r => r.read()) }) });
        if (!response.ok) { const d = await response.json().catch(() => ({})); throw new Error(d.error || '请求失败：' + response.status); }
        await readSse(response, e => {
          if (e.type === 'step_start') { cards[e.index] = card(e.label + (e.round ? `（第 ${e.round} 轮）` : ''), ''); output.append(cards[e.index].node); }
          else if (e.type === 'delta' && cards[e.index]) cards[e.index].pre.textContent += e.text;
          else if (e.type === 'step_end' && cards[e.index]) cards[e.index].pre.textContent = e.text;
          else if (e.type === 'done') output.append(el('div', { class: 'team-secret', style: 'font-family:inherit;white-space:pre-wrap', textContent: (STATUS_NAMES[e.status] || e.status) + '。最终结果：\n' + e.final }));
          else if (e.type === 'error') err.textContent = e.error;
        });
      } catch (e) { if (e.name !== 'AbortError') err.textContent = e.message; }
      finally { startBtn.disabled = false; stopBtn.hidden = true; abort = null; loadHistory(); refreshAlerts(); }
    });
    secTasks.append(el('h4', { textContent: '多智能体协作' }),
      el('p', { class: 'team-note', textContent: '接力：按顺序，后一位看到前面所有产出。圆桌：轮流讨论后由最后一位综合。主管调度：第一位是主管，决定让谁做什么，直到给出最终答案。“引擎”需要管理员安装运行器并启用；“可改文件”只允许在工作区目录内读写文件，不开放任意命令。' }),
      task, el('div', { class: 'team-form' }, mode, el('label', {}, '圆桌轮数 ', rounds)), rows,
      el('div', { class: 'ws-bar' }, startBtn, el('button', { type: 'button', class: 'secondary', textContent: '+ 添加参与者', on: { click: () => addRow() } }), el('button', { type: 'button', class: 'secondary', textContent: '填入示例：规划→实现→审查', on: { click: preset } }), stopBtn),
      output, el('h4', { textContent: '历史记录' }), history);
    loadHistory();
  }

  // ---------- 智能体引擎（管理员） ----------
  // ---------- MCP 市场：内置精选目录 + 官方注册表搜索，一键添加到下面的“MCP 服务”列表 ----------
  async function renderMcpMarket(body) {
    const holder = el('div', {}), box = el('div', { class: 'team-row', style: 'display:block' });
    let query = '', withRegistry = false, data = null, openId = '', showUnsupported = false;
    body.append(el('h3', { textContent: 'MCP 市场' }), holder);
    holder.append(box);
    const input = el('input', { placeholder: '搜索：名称、用途…（回车）', style: 'flex:1;min-width:200px' });
    const go = (registry) => { query = input.value.trim(); withRegistry = registry; load(); };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') go(withRegistry); });
    const toolbar = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px' }, input,
      el('button', { type: 'button', class: 'secondary', textContent: '搜索内置目录', on: { click: () => go(false) } }),
      el('button', { type: 'button', class: 'secondary', textContent: '搜索官方注册表', on: { click: () => go(true) } }));
    async function load() {
      box.replaceChildren(toolbar, el('p', { class: 'team-note', textContent: withRegistry ? '正在搜索官方注册表…' : '正在读取…' }));
      try { data = await api('/api/admin/mcp/market?q=' + encodeURIComponent(query) + (withRegistry ? '&registry=1' : '')); } catch (e) { box.replaceChildren(toolbar, el('div', { class: 'team-err', textContent: e.message })); return; }
      draw();
    }
    const badge = (text, warn) => el('span', { style: 'font-size:11px;padding:1px 8px;border-radius:99px;border:1px solid ' + (warn ? '#d9822b' : 'var(--line)') + ';color:' + (warn ? '#d9822b' : 'var(--muted)'), textContent: text });
    function card(item) {
      const added = (data.existing || []).includes(item.name), usable = item.supported && !item.runnerMissing;
      const msg = errBox(), form = el('div', { hidden: openId !== item.id, style: 'margin-top:10px;display:grid;gap:8px' });
      const fields = {};
      const field = (key, label, extra) => { const i = el('input', { placeholder: extra.placeholder || '', type: extra.secret ? 'password' : 'text', autocomplete: 'off', value: extra.default || '' }); fields[key] = i; return el('label', { style: 'display:grid;gap:3px' }, el('small', { textContent: label + (extra.required ? '（必填）' : '（可选）') }), extra.description ? el('small', { style: 'opacity:.75', textContent: extra.description }) : null, i); };
      const nameInput = el('input', { value: item.name, maxlength: 32 });
      form.append(el('label', { style: 'display:grid;gap:3px' }, el('small', { textContent: '名称（字母开头，小写字母、数字、- 和 _）' }), nameInput),
        item.params.map(p => field('param:' + p.name, p.label || p.name, p)), item.env.map(v => field('env:' + v.name, v.label || v.name, { ...v, placeholder: v.secret ? '保存后只显示打码' : '' })),
        item.source === 'registry' ? el('p', { class: 'team-note', textContent: '这是官方注册表里第三方发布的服务，我们没有审核过。添加后默认不启用——先看看它的说明和来源，确认可信再到下面的“MCP 服务”里勾选启用。' }) : null,
        el('div', { style: 'display:flex;gap:8px' },
          el('button', { type: 'button', class: 'primary', textContent: '确认添加', on: { click: async () => {
            msg.textContent = '';
            const values = Object.fromEntries(Object.entries(fields).map(([k, i]) => [k, i.value]));
            try { const r = await api('/api/admin/mcp/market/install', { method: 'POST', body: JSON.stringify({ id: item.id, name: nameInput.value, values }) }); openId = ''; await render(); } catch (e) { msg.textContent = e.message; }
          } } }),
          el('button', { type: 'button', class: 'secondary', textContent: '取消', on: { click: () => { openId = ''; draw(); } } })), msg);
      const badges = [badge(item.source === 'builtin' ? '内置' : '官方注册表'), item.runtime ? badge(item.runtime) : null, item.env.some(v => v.required) ? badge('需要密钥') : null, ...(item.tags || []).filter(x => x !== '官方注册表').slice(0, 3).map(x => badge(x)), !item.supported ? badge('暂不支持', true) : item.runnerMissing ? badge('运行器里没有 ' + item.runtime, true) : null];
      return el('div', { class: 'team-row', style: 'display:block;' + (usable ? '' : 'opacity:.7') },
        el('div', { style: 'display:flex;gap:10px;justify-content:space-between;align-items:flex-start;flex-wrap:wrap' },
          el('div', { style: 'min-width:0;flex:1' }, el('strong', { textContent: item.title }), el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin:4px 0' }, badges), el('small', { textContent: item.description || '（没有说明）' })),
          el('button', { type: 'button', class: 'secondary', disabled: !usable || added, textContent: added ? '已添加' : '添加', on: { click: () => { openId = openId === item.id ? '' : item.id; draw(); } } })),
        usable ? null : el('small', { class: 'team-err', style: 'display:block;margin-top:4px', textContent: item.reason }),
        item.note ? el('small', { style: 'display:block;margin-top:4px;opacity:.8', textContent: '提示：' + item.note }) : null,
        el('div', { style: 'margin-top:6px;font-size:12px;opacity:.8;word-break:break-all' }, el('code', { textContent: item.preview }), item.version ? ' · v' + item.version : '', item.homepage ? el('span', {}, ' · ', el('a', { href: item.homepage, target: '_blank', rel: 'noopener noreferrer', textContent: '主页 / 说明' })) : null),
        form);
    }
    function draw() {
      const tools = data.runner && data.runner.tools, parts = [toolbar];
      if (data.runner && !data.runner.enabled) parts.push(el('p', { class: 'team-err', textContent: '还没有配置智能体运行器：MCP 服务保存后，要等运行器装好才会真正生效（见“智能体引擎”页的说明）。' }));
      else if (tools && tools.uvx === false) parts.push(el('p', { class: 'team-note', textContent: '提示：运行器里没有 uvx（Python 服务的启动器），标了“运行器里没有 uvx”的服务装不了。Docker 版重建运行器即可（会自动安装；国内服务器可在 .env 里设 PIP_INDEX_URL 用镜像）：docker compose build --no-cache runner && docker compose up -d runner。' }));
      parts.push(el('p', { class: 'team-note', textContent: '内置目录（' + data.builtin.length + ' 个）' + (query ? '，关键词：' + query : '') }));
      if (!data.builtin.length) parts.push(el('p', { class: 'team-note', textContent: '内置目录里没有匹配的服务。' }));
      for (const item of data.builtin) parts.push(card(item));
      if (withRegistry) {
        const usable = data.registry.filter(i => i.supported), other = data.registry.filter(i => !i.supported);
        parts.push(el('p', { class: 'team-note', style: 'margin-top:12px', textContent: '官方 MCP 注册表' + (query ? '（' + query + '）' : '') + '：可以添加 ' + usable.length + ' 个' + (other.length ? '，另有 ' + other.length + ' 个暂不支持（远程 / Docker 等）' : '') }));
        if (data.registryError) parts.push(el('div', { class: 'team-err', textContent: data.registryError }));
        for (const item of usable) parts.push(card(item));
        if (other.length) { parts.push(el('button', { type: 'button', class: 'secondary', textContent: showUnsupported ? '收起暂不支持的' : '显示暂不支持的 ' + other.length + ' 个', on: { click: () => { showUnsupported = !showUnsupported; draw(); } } })); if (showUnsupported) for (const item of other) parts.push(card(item)); }
      } else parts.push(el('p', { class: 'team-note', style: 'margin-top:12px', textContent: '想找更多？点“搜索官方注册表”（需要服务器能访问 registry.modelcontextprotocol.io；里面是第三方发布的，质量参差不齐）。' }));
      box.replaceChildren(...parts);
    }
    await load();
  }

  async function renderMcp(body) {
    const NL = String.fromCharCode(10);
    const data = await api('/api/admin/mcp'), err = errBox(), ok = el('p', { class: 'team-note' });
    let servers = (data.servers || []).map(s => ({ ...s }));
    const list = el('div', {});
    await renderMcpMarket(body);
    body.append(el('h3', { textContent: 'MCP 服务（已添加 / 手动添加）' }));
    body.append(
      el('p', { class: 'team-note', textContent: 'MCP（模型上下文协议）让智能体用上外部工具。这里配置的服务会在“运行器”容器里以管理员指定的命令启动，对 Claude Code、Codex 和 Pi 都生效；成员不能自己添加。出于安全，运行器默认只允许这些启动命令：npx、uvx、node、python3、python、bunx、deno（运行器环境变量 RUNNER_MCP_COMMANDS 可改，RUNNER_MCP=0 可整体禁用）。密钥类环境变量保存后只显示打码，留空表示保持不变。' }),
      list, err, ok,
      el('div', { class: 'team-form' },
        el('button', { type: 'button', class: 'secondary', textContent: '添加 MCP 服务', on: { click: () => { servers = collect(); servers.push({ name: '', command: 'npx', args: [], env: {}, engines: ['claude', 'codex', 'pi'], enabled: true }); draw(); } } }),
        el('button', { type: 'button', class: 'secondary', textContent: '填入示例：网页抓取 fetch', on: { click: () => { servers = collect(); servers.push({ name: 'fetch', command: 'uvx', args: ['mcp-server-fetch'], env: {}, engines: ['claude', 'codex', 'pi'], enabled: true }); draw(); } } }),
        el('button', { type: 'button', class: 'primary wide', textContent: '保存', on: { click: async () => {
          err.textContent = '';
          try { const r = await api('/api/admin/mcp', { method: 'PUT', body: JSON.stringify({ servers: collect() }) }); servers = r.servers; draw(); err.textContent = ''; ok.textContent = '已保存 ' + servers.length + ' 个 MCP 服务'; } catch (e) { err.textContent = e.message; }
        } } })));
    const rows = [];
    function collect() {
      return rows.map(r => ({
        name: r.name.value.trim(), command: r.command.value.trim(), enabled: r.enabled.checked,
        args: r.args.value.split(NL).map(s => s.trim()).filter(Boolean),
        engines: [r.claude.checked && 'claude', r.codex.checked && 'codex', r.pi.checked && 'pi'].filter(Boolean),
        env: Object.fromEntries(r.env.value.split(NL).map(s => s.trim()).filter(Boolean).map(line => { const i = line.indexOf('='); return i < 0 ? [line, ''] : [line.slice(0, i).trim(), line.slice(i + 1)]; }))
      }));
    }
    function draw() {
      rows.length = 0; list.replaceChildren();
      if (!servers.length) list.append(el('p', { class: 'team-note', textContent: '还没有配置 MCP 服务。' }));
      servers.forEach((s, index) => {
        const r = {
          name: el('input', { placeholder: '名称（小写字母开头，如 fetch）', value: s.name }), command: el('input', { placeholder: '启动命令，如 npx / uvx / node', value: s.command }),
          args: el('textarea', { placeholder: '参数，每行一个。例如： -y / @modelcontextprotocol/server-filesystem / /workspaces', value: (s.args || []).join(NL) }),
          env: el('textarea', { placeholder: '环境变量，每行 KEY=值。已保存的值显示为打码，不改就别动', value: Object.entries(s.env || {}).map(([k, v]) => k + '=' + v).join(NL) }),
          enabled: el('input', { type: 'checkbox', checked: s.enabled !== false }),
          claude: el('input', { type: 'checkbox', checked: (s.engines || []).includes('claude') }), codex: el('input', { type: 'checkbox', checked: (s.engines || []).includes('codex') }), pi: el('input', { type: 'checkbox', checked: (s.engines || []).includes('pi') })
        };
        rows.push(r);
        list.append(el('div', { class: 'team-row', style: 'display:block' },
          el('div', { class: 'team-form' }, r.name, r.command, r.args, r.env,
            el('label', {}, r.enabled, ' 启用'), el('label', {}, r.claude, ' Claude Code'), el('label', {}, r.codex, ' Codex'), el('label', {}, r.pi, ' Pi'),
            el('button', { type: 'button', class: 'secondary danger', textContent: '删除', on: { click: () => { servers = collect(); servers.splice(index, 1); draw(); } } }))));
      });
    }
    draw();
  }

  async function sandboxCard() {
    const info = await api('/api/sandbox'), err = errBox();
    const enabled = el('input', { type: 'checkbox', checked: info.enabled }), members = el('input', { type: 'checkbox', checked: info.membersAllowed }), timeout = el('input', { type: 'number', min: 1, max: 120, value: info.timeoutSec, style: 'width:80px' });
    return el('div', { class: 'team-card' },
      el('h4', { textContent: '代码沙箱' }),
      el('p', { class: 'team-note', textContent: '让对话里的代码块能点“运行”，也让引擎选择“在沙箱里运行代码”。代码在单独的断网容器里执行，只带当前工作区的文件副本，没有外网、没有任何密钥。需要在安装向导里选择安装沙箱（docker-compose.sandbox.yml）。' }),
      !info.configured ? el('div', { class: 'team-err', textContent: '还没有检测到沙箱容器：运行 ./install.sh --reconfigure 选择安装代码沙箱，或在 COMPOSE_FILE 里加入 docker-compose.sandbox.yml。' }) : null,
      el('div', { class: 'team-form' }, el('label', {}, enabled, ' 启用'), el('label', {}, members, ' 团队成员可用'), el('label', {}, '单次最长（秒）', timeout),
        el('button', { type: 'button', class: 'primary', textContent: '保存', on: { click: async () => { try { await api('/api/admin/sandbox', { method: 'PUT', body: JSON.stringify({ enabled: enabled.checked, membersAllowed: members.checked, timeoutSec: Number(timeout.value) }) }); err.textContent = '已保存'; } catch (x) { err.textContent = x.message; } } } }), err));
  }

  // ---------- 安全与熔断（管理员） ----------
  // 敏感内容拦截（关键词 + 工作区“机密”标签）、熔断与费用上限、实时状态和事件。事件只记录“谁、什么时候、命中什么规则”，不记录内容。
  async function renderSafety(body) {
    const data = await api('/api/admin/security'), err = errBox(), ok = el('div', { class: 'team-note' });
    const KIND = { dlp: '敏感内容', confidential: '机密工作区', breaker: '模型熔断', abuse: '请求过快', cost: '费用上限' };
    const dlp = data.dlp, br = data.breaker;
    const on = el('input', { type: 'checkbox', checked: dlp.enabled }), mode = el('select', {}, el('option', { value: 'block', textContent: '拦截（不发给模型，并告警）' }), el('option', { value: 'warn', textContent: '只警告（放行，但记录并告警）' }));
    mode.value = dlp.mode;
    const builtin = {}, builtinBox = el('div', { style: 'display:flex;gap:14px;flex-wrap:wrap' });
    for (const [id, label] of [['idcard', '身份证号（带校验）'], ['bank', '银行卡号（带校验）'], ['secret', '密钥 / 令牌'], ['phone', '手机号'], ['email', '邮箱地址']]) { builtin[id] = el('input', { type: 'checkbox', checked: Boolean(dlp.builtin[id]) }); builtinBox.append(el('label', { style: 'font-size:13px' }, builtin[id], ' ' + label)); }
    const keywords = el('textarea', { placeholder: '自定义关键词，每行一个，不分大小写。例如：项目极光、合同编号', style: 'min-height:90px' }); keywords.value = (dlp.keywords || []).join('\n');
    const regexes = el('textarea', { placeholder: '自定义正则，每行一条，格式：名称 = 正则。例如：合同号 = HT-[0-9]{6}', style: 'min-height:70px' }); regexes.value = (dlp.regexes || []).map(r => r.name + ' = ' + r.pattern).join('\n');
    const allowBox = el('div', { style: 'display:grid;gap:4px' }), allow = {};
    for (const item of [...data.providers, ...data.engines]) { allow[item.id] = el('input', { type: 'checkbox', checked: (dlp.confidentialAllow || []).includes(item.id) }); allowBox.append(el('label', { style: 'font-size:13px' }, allow[item.id], ' ' + item.name)); }
    const emailOn = el('input', { type: 'checkbox', checked: Boolean(data.emailDomains?.enabled) }), emailList = el('textarea', { placeholder: '公司邮箱域名，每行一个，例如：example.com', style: 'min-height:70px' }); emailList.value = (data.emailDomains?.domains || []).join('\n');
    const num = (value, ph, min = 0) => el('input', { type: 'number', min, value: value ?? '', placeholder: ph, style: 'width:110px' });
    const f = { thr: num(br.failureThreshold, '5', 1), open: num(br.openSeconds, '60', 5), rate: num(br.userRatePerMinute, '30'), day: num(br.dailyCostLimit, '0'), month: num(br.monthlyCostLimit, '0') };
    const breakerOn = el('input', { type: 'checkbox', checked: br.enabled });
    const save = el('button', { type: 'button', class: 'primary', textContent: '保存', on: { click: async () => {
      err.textContent = ''; ok.textContent = '';
      try {
        const rx = regexes.value.split('\n').map(l => l.trim()).filter(Boolean).map(l => { const i = l.indexOf('='); return i > 0 ? { name: l.slice(0, i).trim(), pattern: l.slice(i + 1).trim() } : { name: '自定义规则', pattern: l }; });
        await api('/api/admin/security', { method: 'PUT', body: JSON.stringify({
          dlp: { enabled: on.checked, mode: mode.value, builtin: Object.fromEntries(Object.entries(builtin).map(([k, box]) => [k, box.checked])), keywords: keywords.value.split('\n'), regexes: rx, confidentialAllow: Object.entries(allow).filter(([, box]) => box.checked).map(([k]) => k) },
          emailDomains: { enabled: emailOn.checked, domains: emailList.value },
          breaker: { enabled: breakerOn.checked, failureThreshold: f.thr.value, openSeconds: f.open.value, userRatePerMinute: f.rate.value, dailyCostLimit: f.day.value, monthlyCostLimit: f.month.value } }) });
        ok.textContent = '已保存，立即生效。';
      } catch (e) { err.textContent = e.message; }
    } } });
    const act = async payload => { try { await api('/api/admin/security/breaker', { method: 'POST', body: JSON.stringify(payload) }); body.replaceChildren(); await renderSafety(body); } catch (e) { err.textContent = e.message; } };
    const states = data.states.models.length ? data.states.models.map(s => el('div', { class: 'team-row', style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' },
      el('span', { style: 'font-weight:650;color:' + (s.state === 'open' ? '#d33a4a' : s.state === 'half' ? '#d98a00' : 'var(--ok,#2f9e5b)'), textContent: s.state === 'open' ? (s.manual ? '已手动暂停' : '已熔断') : s.state === 'half' ? '试探中' : '正常' }),
      el('span', { style: 'overflow-wrap:anywhere;flex:1', textContent: s.key + (s.reason ? '　' + s.reason : '') + (s.retryAfterMs ? `　约 ${Math.ceil(s.retryAfterMs / 1000)} 秒后试探` : '') }),
      s.state !== 'closed' ? el('button', { type: 'button', class: 'secondary', textContent: '立即恢复', on: { click: () => act({ action: 'reset', key: s.key }) } }) : el('button', { type: 'button', class: 'secondary', textContent: '手动暂停', on: { click: () => act({ action: 'trip', key: s.key }) } })))
      : [el('p', { class: 'team-note', textContent: '还没有模型被调用过，这里会显示每个模型的熔断状态。' })];
    const users = data.states.users.map(u => el('div', { class: 'team-row', style: 'display:flex;gap:8px;align-items:center' }, el('span', { style: 'flex:1', textContent: `${u.email || u.userId}　请求太快，暂停中（约 ${Math.ceil(u.retryAfterMs / 1000)} 秒）` }), el('button', { type: 'button', class: 'secondary', textContent: '立即恢复', on: { click: () => act({ action: 'reset-user', userId: u.userId }) } })));
    const events = data.events.length ? data.events.slice(0, 50).map(e => el('div', { style: 'padding:6px 0;border-bottom:1px dashed var(--line,#e7e8ec);font-size:13px' },
      el('b', { style: 'color:' + (e.blocked === false ? '#d98a00' : '#d33a4a'), textContent: `[${KIND[e.kind] || e.kind}] ` }), el('span', { textContent: e.summary || '' }),
      el('div', { class: 'team-note', textContent: fmt(e.at) + (e.email ? '　' + e.email : '') + (e.model ? '　' + e.model : '') }))) : [el('p', { class: 'team-note', textContent: '暂时没有告警。' })];
    body.append(
      el('div', { class: 'team-note', textContent: '这里只记录“谁、什么时候、命中了什么规则”，不会记录或显示被检测的内容本身。' }),
      el('div', { class: 'team-card' }, el('h4', { textContent: '注册邮箱限制' }),
        el('p', { class: 'team-note', textContent: '开启后，邀请、新建成员都只接受下面这些域名的邮箱（完整匹配，子域名要单独写）。已有成员不受影响。' }),
        el('label', {}, emailOn, ' 只允许公司邮箱注册'), emailList),
      el('div', { class: 'team-card' }, el('h4', { textContent: '敏感内容拦截' }),
        el('p', { class: 'team-note', textContent: '成员发给模型的内容、以及引擎的指令，会在发出前检查。命中后按下面的方式处理，并记入页面底部的告警。只检查“这一轮新发出的内容”。' }),
        el('label', {}, on, ' 启用'), el('label', { style: 'display:block;margin:6px 0' }, '命中后　', mode), builtinBox, keywords, regexes),
      el('div', { class: 'team-card' }, el('h4', { textContent: '机密工作区' }),
        el('p', { class: 'team-note', textContent: `管理员在“工作区设置”里把工作区标成“机密”后，它的内容默认不能发给任何模型或引擎。只有勾选下面的才允许（比如公司自己部署的模型）。当前机密工作区：${data.labeled.length ? data.labeled.map(w => w.name).join('、') : '无'}。` }), allowBox),
      el('div', { class: 'team-card' }, el('h4', { textContent: '熔断与费用上限' }),
        el('label', {}, breakerOn, ' 启用熔断'),
        el('div', { class: 'team-form' }, el('label', {}, '模型连续失败 ', f.thr, ' 次就熔断'), el('label', {}, '熔断后先断开 ', f.open, ' 秒再试探'), el('label', {}, '单人每分钟最多 ', f.rate, ' 次（0 不限）'),
          el('label', {}, `每日费用上限 ${data.currency} `, f.day, '（0 不限）'), el('label', {}, `每月费用上限 ${data.currency} `, f.month, '（0 不限）')),
        el('p', { class: 'team-note', textContent: `当前已用：今日 ${data.currency}${data.costs.day.toFixed(2)}，本月 ${data.currency}${data.costs.month.toFixed(2)}。费用按“用量与价格”里设置的单价计算。失败指限流（429）、服务端错误（5xx）、密钥被拒（401/403）、超时和连不上。` })),
      el('div', {}, save), ok, err,
      el('h4', { style: 'margin:16px 0 4px', textContent: '实时状态' }), ...states, ...users,
      el('h4', { style: 'margin:16px 0 4px', textContent: '告警记录（最近 50 条）' }), ...events);
  }

  // AI 邮箱：绑定自己的邮箱 → 看收件箱 → 让 AI 起草 → 自己改 → 自己点确认发送
  async function renderMail(body) {
    const d = await api('/api/mail'), err = errBox(), ok = el('div', { class: 'team-note' });
    const reload = async () => { body.replaceChildren(); await renderMail(body); };
    const guard = fn => async (...a) => { err.textContent = ''; ok.textContent = ''; try { await fn(...a); } catch (e) { err.textContent = e.message; } };
    const PRESETS = [['', '手动填写'], ['exmail', '腾讯企业邮箱 / 企业微信邮箱'], ['qq', 'QQ 邮箱'], ['163', '网易 163 邮箱'], ['gmail', 'Gmail / Google Workspace'], ['o365', 'Microsoft 365 / Outlook']];
    const HOSTS = { exmail: ['imap.exmail.qq.com', 'smtp.exmail.qq.com', 993, 465], qq: ['imap.qq.com', 'smtp.qq.com', 993, 465], 163: ['imap.163.com', 'smtp.163.com', 993, 465], gmail: ['imap.gmail.com', 'smtp.gmail.com', 993, 465], o365: ['outlook.office365.com', 'smtp.office365.com', 993, 587] };
    const inp = (ph, value = '', type = 'text') => el('input', { type, placeholder: ph, value, autocomplete: 'off', style: 'width:100%' });
    const parts = [];
    if (d.account) {
      parts.push(el('div', { class: 'team-card' }, el('h4', { textContent: '已绑定：' + d.account.email }),
        el('p', { class: 'team-note', textContent: `收信 ${d.account.imapHost}:${d.account.imapPort}　发信 ${d.account.smtpHost}:${d.account.smtpPort}　今天已发 ${d.sendsToday}/${d.sendLimit} 封。密码保存在服务器加密存储里，页面不会再显示。` }),
        el('button', { type: 'button', class: 'secondary danger', textContent: '解除绑定', on: { click: guard(async () => { if (!await ymConfirm('解除后会删除服务器上保存的邮箱密码和所有草稿，继续？', { danger: true, okText: '解除' })) return; await api('/api/mail/account', { method: 'DELETE' }); await reload(); }) } })));
      // 收件箱
      const list = el('div', {}), detail = el('div', {});
      const instruction = el('textarea', { placeholder: '想让 AI 怎么回？例如：礼貌地答应，约周三下午；或留空让 AI 自己写一个得体的回复', style: 'min-height:70px;width:100%' });
      let openUid = 0;
      const openMessage = guard(async uid => {
        detail.replaceChildren(el('p', { class: 'team-note', textContent: '正在读取…' }));
        const m = (await api('/api/mail/message/' + uid)).message; openUid = uid;
        detail.replaceChildren(el('div', { class: 'team-card' }, el('h4', { style: 'overflow-wrap:anywhere', textContent: m.subject }),
          el('p', { class: 'team-note', textContent: `发件人 ${m.from}　${fmt(m.date)}${m.attachments.length ? '　附件：' + m.attachments.join('、') + '（不会交给 AI）' : ''}` }),
          el('pre', { style: 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:260px;overflow:auto;font:inherit;font-size:13px', textContent: m.text || '（没有正文）' }),
          instruction,
          el('div', { style: 'margin-top:8px' }, el('button', { type: 'button', class: 'primary', textContent: 'AI 起草回复', on: { click: guard(async () => { ok.textContent = 'AI 正在起草…'; await api('/api/mail/draft', { method: 'POST', body: JSON.stringify({ uid: openUid, instruction: instruction.value }) }); await reload(); }) } })),
          el('p', { class: 'team-note', textContent: '邮件内容会发给你选用的 AI 模型；如果管理员开启了敏感内容拦截，含身份证号、银行卡号、密钥的邮件会被拦下。' })));
      });
      const loadInbox = guard(async () => {
        list.replaceChildren(el('p', { class: 'team-note', textContent: '正在读取收件箱…' }));
        const rows = (await api('/api/mail/inbox')).messages;
        list.replaceChildren(...(rows.length ? rows.map(m => el('div', { class: 'team-row', role: 'button', tabindex: '0', style: 'cursor:pointer;padding:8px 0;border-bottom:1px dashed var(--line,#e7e8ec)', on: { click: () => openMessage(m.uid), keydown: e => { if (e.key === 'Enter') openMessage(m.uid); } } },
          el('div', { style: 'font-weight:' + (m.seen ? 400 : 700) + ';overflow-wrap:anywhere', textContent: m.subject }), el('div', { class: 'team-note', textContent: m.from + '　' + fmt(m.date) }))) : [el('p', { class: 'team-note', textContent: '收件箱是空的。' })]));
      });
      parts.push(el('div', { class: 'team-card' }, el('h4', { textContent: '收件箱' }), el('button', { type: 'button', class: 'secondary', textContent: '读取最近 20 封', on: { click: loadInbox } }), list), detail);
      // 写新邮件
      const nTo = inp('收件人（多个用逗号分隔）'), nSubject = inp('主题'), nAsk = el('textarea', { placeholder: '想写什么？例如：给张经理发一封会议改期的通知，改到周五上午 10 点', style: 'min-height:70px;width:100%' });
      parts.push(el('div', { class: 'team-card' }, el('h4', { textContent: '写新邮件' }), nTo, nSubject, nAsk,
        el('div', { style: 'margin-top:8px' }, el('button', { type: 'button', class: 'primary', textContent: 'AI 起草', on: { click: guard(async () => { ok.textContent = 'AI 正在起草…'; const r = await api('/api/mail/draft', { method: 'POST', body: JSON.stringify({ instruction: nAsk.value, subject: nSubject.value }) }); if (nTo.value.trim()) await api('/api/mail/draft/' + r.draft.id, { method: 'PUT', body: JSON.stringify({ to: nTo.value }) }); await reload(); }) } }))));
      // 草稿
      const drafts = d.drafts.map(dr => {
        const sent = dr.status === 'sent';
        const to = inp('收件人', (dr.to || []).join(', ')), cc = inp('抄送（可选）', (dr.cc || []).join(', ')), subject = inp('主题', dr.subject || ''), text = el('textarea', { style: 'min-height:160px;width:100%' }); text.value = dr.body || '';
        for (const x of [to, cc, subject, text]) x.disabled = sent;
        const save = async () => { await api('/api/mail/draft/' + dr.id, { method: 'PUT', body: JSON.stringify({ to: to.value, cc: cc.value, subject: subject.value, body: text.value }) }); };
        return el('div', { class: 'team-card' }, el('h4', { textContent: (sent ? '已发送：' : '草稿：') + (dr.subject || '（无主题）') }),
          dr.source ? el('p', { class: 'team-note', textContent: `回复 ${dr.source.from} 的「${dr.source.subject}」` }) : null, to, cc, subject, text,
          sent ? el('p', { class: 'team-note', textContent: '已于 ' + fmt(dr.sentAt) + ' 发出。' }) : el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:8px' },
            el('button', { type: 'button', class: 'secondary', textContent: '保存修改', on: { click: guard(async () => { await save(); ok.textContent = '已保存。'; }) } }),
            el('button', { type: 'button', class: 'primary', textContent: '确认发送', on: { click: guard(async () => { await save(); if (!await ymConfirm(`确认以 ${d.account.email} 的名义发送给：\n${to.value}${cc.value ? '\n抄送：' + cc.value : ''}\n\n主题：${subject.value}\n\n发出后无法撤回。`, { okText: '确认发送' })) return; await api('/api/mail/draft/' + dr.id + '/send', { method: 'POST', body: JSON.stringify({ confirm: true }) }); await reload(); }) } }),
            el('button', { type: 'button', class: 'secondary danger', textContent: '删除', on: { click: guard(async () => { await api('/api/mail/draft/' + dr.id, { method: 'DELETE' }); await reload(); }) } })));
      });
      parts.push(el('h4', { style: 'margin:16px 0 4px', textContent: '草稿与已发送' }), ...(drafts.length ? drafts : [el('p', { class: 'team-note', textContent: '还没有草稿。' })]));
    } else {
      const preset = el('select', {}, ...PRESETS.map(([v, t]) => el('option', { value: v, textContent: t })));
      const email = inp('你的公司邮箱，例如 name@example.com'), user = inp('登录用户名（一般就是邮箱，可留空）'), pass = inp('密码或授权码', '', 'password');
      const ih = inp('收信服务器（IMAP）'), ip = inp('端口', '993', 'number'), sh = inp('发信服务器（SMTP）'), sp = inp('端口', '465', 'number');
      preset.addEventListener('change', () => { const h = HOSTS[preset.value]; if (h) { ih.value = h[0]; sh.value = h[1]; ip.value = h[2]; sp.value = h[3]; } });
      parts.push(el('div', { class: 'team-card' }, el('h4', { textContent: '绑定邮箱' }),
        el('p', { class: 'team-note', textContent: (d.domains.length ? '只能绑定公司域名的邮箱：' + d.domains.map(x => '@' + x).join('、') + '。' : '') + '建议使用邮箱服务商提供的“授权码 / 应用专用密码”，不要用登录主密码。保存时会先试连一次，成功才保存。' }),
        el('div', { class: 'team-form' }, el('label', {}, '常用服务商', preset), el('label', {}, '邮箱', email), el('label', {}, '用户名', user), el('label', {}, '密码 / 授权码', pass),
          el('label', {}, '收信服务器', ih), el('label', {}, '收信端口', ip), el('label', {}, '发信服务器', sh), el('label', {}, '发信端口', sp)),
        el('button', { type: 'button', class: 'primary', textContent: '测试并保存', on: { click: guard(async () => { ok.textContent = '正在连接邮件服务器…'; await api('/api/mail/account', { method: 'PUT', body: JSON.stringify({ email: email.value, username: user.value, pass: pass.value, imapHost: ih.value, imapPort: ip.value, smtpHost: sh.value, smtpPort: sp.value }) }); await reload(); }) } })));
    }
    if (me.role === 'admin') {
      const priv = el('input', { type: 'checkbox', checked: Boolean(d.allowPrivate) });
      parts.push(el('div', { class: 'team-card' }, el('h4', { textContent: '管理员设置' }),
        el('label', {}, priv, ' 允许连接内网邮件服务器（默认只允许公网地址，防止被用来探测内网）'),
        el('div', { style: 'margin-top:8px' }, el('button', { type: 'button', class: 'secondary', textContent: '保存', on: { click: guard(async () => { await api('/api/admin/mail', { method: 'PUT', body: JSON.stringify({ allowPrivate: priv.checked }) }); ok.textContent = '已保存。'; }) } }))));
    }
    body.append(el('div', { class: 'team-note', textContent: 'AI 只能读你选中的那一封邮件和写草稿；它不能自己发信，也看不到收件箱里的其他邮件。' }), ...parts, ok, err);
  }

  // 套餐与授权：目前所有功能向所有人开放；各版本档位只作介绍，正式版开放购买后再接入购买和授权
  async function renderPlan(body) {
    const d = await api('/api/admin/plan');
    const cards = d.tiers.map(t => el('div', { class: 'team-card plan-card' },
      el('h4', { textContent: t.name }),
      el('p', { class: 'team-note', textContent: t.blurb }),
      el('p', { class: 'team-note', textContent: `成员 ${t.seats || '不限'}　独立桌面 ${t.desktops || '无'}` }),
      el('div', { class: 'plan-feats' }, ...d.features.filter(f => f.tier === t.id).map(f => el('div', { textContent: '• ' + f.name + (f.status === 'planned' ? '（规划中）' : '') }))),
      el('button', { type: 'button', class: 'secondary', disabled: true, textContent: '即将开放购买' })));
    body.append(
      el('div', { class: 'team-card plan-open' }, el('h4', { textContent: '现在：全部功能向所有人开放' }),
        el('p', { class: 'team-note', textContent: `目前处于试用期，下面所有版本的功能都可以直接使用，不需要购买，也不需要授权密钥（当前 ${d.members} 位成员）。` }),
        el('p', { class: 'team-note', textContent: '正式版本发布后会开放购买：到时候按下面的版本分档，可以在线购买，或用授权密钥解锁完整功能。' })),
      el('div', { class: 'plan-grid' }, ...cards));
  }

  // 引擎与隔离自检：不需要密钥、不调用模型。看引擎装没装好，以及运行器有没有守住隔离（不是 root、读不到主服务的密钥和数据、环境变量最小、工作区出不去）
  function selfCheckCard() {
    const out = el('div', {}), err = errBox(), btn = el('button', { type: 'button', class: 'primary', textContent: '运行自检' });
    const ICON = { ok: ['✓', 'var(--ok,#2f9e5b)'], warn: ['!', '#d98a00'], fail: ['✗', '#d33a4a'], info: ['i', 'var(--muted,#777b86)'], skip: ['–', 'var(--muted,#777b86)'] };
    const GROUPS = [['engine', 'A　引擎'], ['isolation', 'B　隔离']];
    const draw = data => {
      if (data.enabled === false) { out.replaceChildren(el('p', { class: 'team-note', textContent: data.message })); return; }
      const s = data.summary || {};
      const head = el('p', { style: 'font-weight:650;margin:10px 0 4px;color:' + (s.fail ? '#d33a4a' : s.warn ? '#d98a00' : 'var(--ok,#2f9e5b)'), textContent: (s.fail ? `有 ${s.fail} 项没通过` : s.warn ? '没有失败，但有需要留意的项' : '全部通过') + `（通过 ${s.ok || 0}，警告 ${s.warn || 0}，失败 ${s.fail || 0}）　${fmt(data.at)}` });
      out.replaceChildren(head, ...GROUPS.flatMap(([key, title]) => {
        const rows = (data.checks || []).filter(c => c.group === key);
        return rows.length ? [el('h5', { style: 'margin:12px 0 4px', textContent: title }), ...rows.map(c => {
          const [mark, color] = ICON[c.status] || ICON.info;
          return el('div', { style: 'display:grid;grid-template-columns:1.6em 1fr;gap:6px;padding:5px 0;border-bottom:1px dashed var(--line,#e7e8ec)' },
            el('span', { style: 'font-weight:700;color:' + color, textContent: mark }),
            el('div', {}, el('div', { style: 'font-weight:600', textContent: c.title }),
              c.detail ? el('div', { class: 'team-note', style: 'overflow-wrap:anywhere', textContent: c.detail }) : null,
              c.fix && (c.status === 'fail' || c.status === 'warn') ? el('div', { style: 'font-size:13px;color:' + color, textContent: '怎么办：' + c.fix }) : null));
        })] : [];
      }));
    };
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = '检查中…'; err.textContent = '';
      try { draw(await api('/api/admin/engines/selfcheck')); } catch (e) { err.textContent = e.message; }
      btn.disabled = false; btn.textContent = '重新检查';
    });
    return el('div', { class: 'team-card' },
      el('h4', { textContent: '引擎与隔离自检' }),
      el('p', { class: 'team-note', textContent: '一键检查：Claude Code、Codex、Pi 有没有装好；运行器有没有守住隔离——不是 root、读不到主服务的数据和密钥、传给引擎的环境变量最小、工作区的目录出不去、没有多余的系统权限。只读检查，不调用模型，不需要密钥。' }),
      btn, err, out);
  }

  async function renderEngines(body) {
    const data = await api('/api/admin/engines'), err = errBox();
    body.append(selfCheckCard(), await sandboxCard().catch(() => el('span')),
      el('p', { class: 'team-note', textContent: 'Claude Code、Codex、Pi 运行在独立的“运行器”容器里（安装向导里选择安装），只能读写各工作区的目录，不开放任意 shell 命令。这里配置每个引擎的模型密钥和谁可以使用。' }),
      !data.runner ? el('div', { class: 'team-err', textContent: '还没有配置运行器：请运行 ./install.sh --reconfigure 并选择安装智能体运行器，或手动设置 RUNNER_URL / RUNNER_TOKEN。' }) : data.runnerError ? el('div', { class: 'team-err', textContent: '运行器不可用：' + data.runnerError }) : null, err);
    for (const e of data.engines) {
      const f = {
        enabled: el('input', { type: 'checkbox', checked: e.enabled }), members: el('input', { type: 'checkbox', checked: e.membersAllowed }),
        maxMode: el('select', {}, el('option', { value: 'readonly', textContent: '只读（只能看文件）' }), el('option', { value: 'edit', textContent: '可读写工作区文件' }), el('option', { value: 'exec', textContent: '可读写 + 在沙箱里运行代码' })),
        apiKey: el('input', { type: 'password', autocomplete: 'off', placeholder: e.hasKey ? '已保存 ' + e.keyMask + '，留空保持不变' : 'API Key' }),
        baseUrl: el('input', { placeholder: e.engine === 'claude' ? 'Anthropic 兼容地址（可选，默认官方）' : e.engine === 'codex' ? 'OpenAI 兼容地址（可选，默认官方）' : '（Pi 不使用）', value: e.baseUrl, disabled: e.engine === 'pi' }),
        model: el('input', { placeholder: '默认模型（可选）', value: e.model }),
        models: el('textarea', { placeholder: '允许成员选择的模型，每行一个（可选）。例如 claude：sonnet、opus；codex：gpt-5 等，以该引擎实际支持的名称为准', value: (e.models || []).join('\n'), class: 'wide' }),
        provider: el('input', { placeholder: e.engine === 'pi' ? 'Pi 的服务商，如 anthropic / openai / google / deepseek' : '（不使用）', value: e.provider, disabled: e.engine !== 'pi' })
      };
      f.maxMode.value = e.maxMode;
      body.append(el('div', { class: 'team-row', style: 'display:block' },
        el('strong', { textContent: e.label }), el('small', { textContent: e.installed ? '已安装 ' + (e.version || '') : '运行器中未安装' }),
        e.hint && el('p', { class: 'team-note', textContent: '适配模型：' + e.hint.family + '。' + e.hint.note }),
        e.hint && e.hint.suggest.length ? el('button', { type: 'button', class: 'secondary', textContent: '填入常用模型：' + e.hint.suggest.join('、') + '（名称以引擎实际支持为准）', on: { click: () => { f.models.value = e.hint.suggest.join('\n'); if (!f.model.value) f.model.value = e.hint.suggest[0]; } } }) : null,
        el('div', { class: 'team-form' }, el('label', {}, f.enabled, ' 启用'), el('label', {}, f.members, ' 团队成员可用'), f.maxMode, f.model, f.models, f.baseUrl, f.provider, f.apiKey,
          el('button', { type: 'button', class: 'primary wide', textContent: '保存 ' + e.label, on: { click: async () => {
            try { await api('/api/admin/engines/' + e.engine, { method: 'PUT', body: JSON.stringify({ enabled: f.enabled.checked, membersAllowed: f.members.checked, maxMode: f.maxMode.value, apiKey: f.apiKey.value, baseUrl: f.baseUrl.value, model: f.model.value, models: f.models.value, provider: f.provider.value }) }); render(); } catch (x) { err.textContent = x.message; }
          } } }))));
    }
  }

  // ---------- 壁纸 ----------
  const PRESETS = [
    ['aurora', '极光', 'linear-gradient(135deg,#1d2b64,#f8cdda)'], ['dusk', '黄昏', 'linear-gradient(135deg,#355c7d,#6c5b7b,#c06c84)'],
    ['mint', '薄荷', 'linear-gradient(135deg,#a8edea,#fed6e3)'], ['ocean', '海湾', 'linear-gradient(135deg,#2193b0,#6dd5ed)'],
    ['sunrise', '日出', 'linear-gradient(135deg,#ff9a9e,#fecfef,#fecfef)'], ['forest', '森林', 'linear-gradient(135deg,#134e5e,#71b280)'],
    ['night', '夜空', 'linear-gradient(135deg,#0f2027,#203a43,#2c5364)'], ['sand', '沙丘', 'linear-gradient(135deg,#f6d365,#fda085)']
  ];
  const wallLayer = el('div', { id: 'wallpaperLayer', hidden: true });
  document.body.prepend(wallLayer);
  const wallStyle = el('style', {});
  wallStyle.textContent = '#wallpaperLayer{position:fixed;inset:0;z-index:0;background-size:cover;background-position:center;pointer-events:none}#wallpaperLayer video{width:100%;height:100%;object-fit:cover}#wallpaperLayer::after{content:"";position:absolute;inset:0;background:var(--wall-dim,rgba(247,247,249,.35))}body.has-wallpaper #app{position:relative;z-index:1}body.has-wallpaper .main,body.has-wallpaper .content{background:transparent}.wall-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:8px;margin:10px 0}.wall-tile{position:relative;height:72px;border-radius:10px;border:2px solid var(--line);background-size:cover;background-position:center;cursor:pointer;display:flex;align-items:flex-end;overflow:hidden;padding:0;color:#fff;font-size:11px;text-shadow:0 1px 3px #0009}.wall-tile.on{border-color:var(--accent)}.wall-tile span{padding:3px 6px;width:100%;box-sizing:border-box;background:linear-gradient(transparent,#0006)}.wall-tile.none{background:var(--line);color:var(--muted);text-shadow:none;align-items:center;justify-content:center}.wall-del{position:absolute;top:3px;right:3px;width:20px;height:20px;border-radius:50%;border:0;background:#0008;color:#fff;font-size:12px;line-height:20px;padding:0;cursor:pointer}';
  document.head.append(wallStyle);
  let wallState = { items: [], choice: '', dim: 35, defaultWallpaper: '' };
  let wallSlideTimer = 0;
  function applyWallpaper(choice, dim) {
    clearInterval(wallSlideTimer); wallSlideTimer = 0;
    wallLayer.replaceChildren(); wallLayer.style.backgroundImage = ''; wallLayer.style.transition = 'opacity .7s ease'; wallLayer.style.opacity = '1';
    const preset = PRESETS.find(p => 'preset:' + p[0] === choice), file = wallState.items.find(i => i.name === choice);
    const slides = choice === 'preset:slideshow' ? wallState.items.filter(i => i.kind === 'image') : [];
    if (slides.length) {
      let index = 0;
      const showSlide = () => {
        wallLayer.style.opacity = '0.35';
        setTimeout(() => {
          const current = slides[index++ % slides.length];
          wallLayer.style.backgroundImage = `url("/api/wallpapers/file/${encodeURIComponent(current.name)}")`;
          wallLayer.style.opacity = '1';
        }, 700);
      };
      wallLayer.style.backgroundImage = `url("/api/wallpapers/file/${encodeURIComponent(slides[0].name)}")`;
      index = slides.length > 1 ? 1 : 0;
      wallSlideTimer = setInterval(showSlide, 12000);
    } else if (preset) wallLayer.style.backgroundImage = preset[2];
    else if (file && file.kind === 'image') wallLayer.style.backgroundImage = `url("/api/wallpapers/file/${encodeURIComponent(file.name)}")`;
    else if (file) wallLayer.append(el('video', { src: `/api/wallpapers/file/${encodeURIComponent(file.name)}`, autoplay: true, muted: true, loop: true, playsInline: true }));
    const on = Boolean(preset || file || slides.length);
    wallLayer.hidden = !on; document.body.classList.toggle('has-wallpaper', on);
    wallLayer.style.setProperty('--wall-dim', `rgba(247,247,249,${Math.max(0, Math.min(80, dim)) / 100})`);
  }
  async function loadWallpaper() {
    try {
      const d = await api('/api/wallpapers');
      wallState = { items: d.items, choice: d.pref.wallpaper === null ? d.defaultWallpaper : d.pref.wallpaper, dim: d.pref.dim, defaultWallpaper: d.defaultWallpaper };
      applyWallpaper(wallState.choice, wallState.dim);
    } catch { /* 未登录时忽略 */ }
  }
  async function renderWallpapers(body) {
    await loadWallpaper();
    const err = errBox(), dim = el('input', { type: 'range', min: 0, max: 80, value: wallState.dim, style: 'width:200px' });
    const save = async choice => { try { wallState.choice = choice; await api('/api/wallpapers/pref', { method: 'PUT', body: JSON.stringify({ wallpaper: choice, dim: Number(dim.value) }) }); applyWallpaper(choice, Number(dim.value)); render(); } catch (e) { err.textContent = e.message; } };
    dim.addEventListener('input', () => applyWallpaper(wallState.choice, Number(dim.value)));
    dim.addEventListener('change', () => save(wallState.choice));
    const tile = (choice, label, style, deletable) => el('button', { type: 'button', class: 'wall-tile' + (wallState.choice === choice ? ' on' : '') + (choice === '' ? ' none' : ''), style, title: label, on: { click: () => save(choice) } },
      el('span', { textContent: label }), deletable ? el('button', { type: 'button', class: 'wall-del', textContent: '×', title: '删除', on: { click: async e => { e.stopPropagation(); if (!await ymConfirm('删除壁纸“' + label + '”？所有成员都会失去它。', { danger: true, okText: '确定' })) return; await api('/api/admin/wallpapers/' + encodeURIComponent(choice), { method: 'DELETE' }); render(); } } }) : null);
    const file = el('input', { type: 'file', accept: '.webp,.png,.jpg,.jpeg,.mp4' });
    // ---- 上传：图片先压缩，XHR 显示进度，可取消 ----
    const bar = el('div', { style: 'height:6px;border-radius:3px;background:var(--line);overflow:hidden;margin-top:6px' }, el('div', { style: 'height:100%;width:0;background:var(--accent);transition:width .15s' }));
    const progress = el('div', { class: 'wide team-note', hidden: true }, el('span'), bar);
    const say = (text, percent) => { progress.hidden = !text; progress.firstChild.textContent = text; bar.firstChild.style.width = (percent || 0) + '%'; bar.hidden = percent == null; };
    let currentXhr = null;
    const cancelBtn = el('button', { type: 'button', class: 'secondary', textContent: '取消上传', hidden: true, on: { click: () => currentXhr?.abort() } });
    const safeName = (original, ext) => {
      const stem = original.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
      return (stem || 'wallpaper') + '-' + Date.now().toString(36) + '.' + ext;   // 中文文件名、重名都不会出问题
    };
    const compressImage = async f => {
      const bitmap = await createImageBitmap(f);
      const scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close?.();
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.85));
      if (!blob || blob.type !== 'image/webp') throw new Error('浏览器不支持转换为 WebP，请直接选择 .webp 文件');
      return blob;
    };
    const sendFile = (blob, name) => new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest(); currentXhr = xhr; const started = Date.now();
      xhr.open('PUT', '/api/admin/wallpapers/' + encodeURIComponent(name)); xhr.timeout = 20 * 60 * 1000;
      xhr.setRequestHeader('X-CSRF-Token', csrf); xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = e => {
        if (!e.lengthComputable) return;
        const percent = Math.round(e.loaded / e.total * 100), speed = e.loaded / Math.max(1, (Date.now() - started) / 1000);
        say('正在上传 ' + percent + '%（' + (e.loaded / 1048576).toFixed(1) + ' / ' + (e.total / 1048576).toFixed(1) + ' MB，约 ' + Math.round(speed / 1024) + ' KB/s）', percent);
      };
      xhr.onload = () => { let data = {}; try { data = JSON.parse(xhr.responseText); } catch { /* 无正文 */ } xhr.status >= 200 && xhr.status < 300 ? resolve(data) : reject(new Error(data.error || '上传失败：HTTP ' + xhr.status)); };
      xhr.onerror = () => reject(new Error('网络中断，上传失败。文件较大时请换小一点的文件，或稍后重试'));
      xhr.ontimeout = () => reject(new Error('上传超时（20 分钟）'));
      xhr.onabort = () => reject(new Error('已取消上传'));
      xhr.send(blob);
    });
    const uploadBtn = el('button', { type: 'button', class: 'secondary', textContent: '上传壁纸（图片自动压缩，视频 ≤ 30 MB）', on: { click: async () => {
      const f = file.files[0]; if (!f) { err.textContent = '请先选择文件'; return; }
      err.textContent = ''; uploadBtn.disabled = true; file.disabled = true; cancelBtn.hidden = false;
      try {
        const ext = (f.name.split('.').pop() || '').toLowerCase();
        let blob = f, name;
        if (ext === 'mp4') {
          if (f.size > 30 * 1024 * 1024) throw new Error('视频不能超过 30 MB（当前 ' + (f.size / 1048576).toFixed(1) + ' MB），请先压缩或截取一小段');
          name = safeName(f.name, 'mp4');
        } else if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
          say('正在压缩图片…', null); blob = await compressImage(f); name = safeName(f.name, 'webp');
          say('压缩完成：' + (f.size / 1024).toFixed(0) + ' KB → ' + (blob.size / 1024).toFixed(0) + ' KB', 0);
        } else throw new Error('只支持 png / jpg / webp 图片和 mp4 视频');
        if (blob.size > 8 * 1024 * 1024 && ext !== 'mp4') throw new Error('压缩后仍超过 8 MB，请换一张小一些的图片');
        await sendFile(blob, name); say('上传完成', 100); setTimeout(render, 500);
      } catch (e) { err.textContent = e.message; say('', null); }
      finally { uploadBtn.disabled = false; file.disabled = false; cancelBtn.hidden = true; currentXhr = null; }
    } } });
    body.append(
      el('p', { class: 'team-note', textContent: '选一张静态壁纸，或选择“静态轮播”每 12 秒轮换一张背景。暗度越高，文字越清晰；轮播仅使用图片壁纸。' }),
      el('label', {}, '背景暗度 ', dim),
      el('div', { class: 'wall-grid' }, tile('', '无壁纸', ''), PRESETS.map(p => tile('preset:' + p[0], p[1], 'background-image:' + p[2])),
        wallState.items.some(i => i.kind === 'image') ? tile('preset:slideshow', '静态轮播', `background-image:url("/api/wallpapers/file/${encodeURIComponent(wallState.items.find(i => i.kind === 'image').name)}")`, false) : null,
        wallState.items.map(i => tile(i.name, i.name.replace(/\.[^.]+$/, '') + (i.kind === 'video' ? ' ▶' : ''), i.kind === 'image' ? `background-image:url("/api/wallpapers/file/${encodeURIComponent(i.name)}")` : 'background:#223', me.role === 'admin'))),
      !wallState.items.length && el('p', { class: 'team-note', textContent: '服务器上还没有图片壁纸。主账号可以在下面上传，或在服务器运行 scripts/fetch-wallpapers.mjs 从 Cindy 官方仓库下载（见 README，注意素材授权）。' }),
      me.role === 'admin' && el('div', { class: 'team-form' }, file,
        uploadBtn, progress, cancelBtn,
        el('p', { class: 'team-note wide', textContent: '图片会先在浏览器里压缩成 WebP（最长边 2560 像素），通常只有几百 KB，上传很快；视频不压缩（≤ 30 MB），服务器带宽小时会比较慢，页面会显示进度，也可以取消。' }),
        el('button', { type: 'button', class: 'secondary wide', textContent: '把当前选择设为全员默认', on: { click: async () => { try { await api('/api/admin/wallpapers-default', { method: 'PUT', body: JSON.stringify({ name: wallState.choice }) }); err.textContent = ''; wallState.defaultWallpaper = wallState.choice; } catch (e) { err.textContent = e.message; } } } })),
      err);
  }

  // ---------- 技能工坊 ----------
  async function renderSkills(body) {
    const { skills } = await api('/api/skills'), err = errBox();
    const f = { title: el('input', { placeholder: '技能名称，如 代码审查规范', maxLength: 60 }), description: el('input', { class: 'wide', placeholder: '一句话说明什么时候用（可选）', maxLength: 300 }), content: el('textarea', { placeholder: '技能内容：写成给智能体看的步骤、规则、模板（Markdown）。最多 20000 字。', style: 'min-height:160px' }), shared: el('input', { type: 'checkbox' }) };
    let editing = null;
    const fill = skill => { editing = skill; f.title.value = skill?.title || ''; f.description.value = skill?.description || ''; f.content.value = skill?.content || ''; f.shared.checked = Boolean(skill?.shared); save.textContent = skill ? '保存修改' : '创建技能'; };
    const save = el('button', { type: 'button', class: 'primary wide', textContent: '创建技能', on: { click: async () => {
      try { await api(editing ? '/api/skills/' + editing.id : '/api/skills', { method: editing ? 'PATCH' : 'POST', body: JSON.stringify({ title: f.title.value, description: f.description.value, content: f.content.value, shared: f.shared.checked }) }); render(); } catch (e) { err.textContent = e.message; }
    } } });
    const importBox = el('textarea', { placeholder: '粘贴一份 SKILL.md（--- name: … description: … --- 加正文）直接导入' });
    const note = el('div', { class: 'team-note' });
    const toBase64 = buf => { let s = ''; const bytes = new Uint8Array(buf); for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
    const report = r => { const lines = []; if (r.created?.length) lines.push('已导入 ' + r.created.length + ' 个技能：' + r.created.map(s => s.title).join('、')); for (const s of r.skipped || []) lines.push('跳过 ' + s.name + '：' + s.reason); if (r.ignoredFiles) lines.push('另有 ' + r.ignoredFiles + ' 个文件不是 SKILL.md，已忽略（不会被保存或执行）'); note.textContent = lines.join('；'); };
    const upload = async files => {
      err.textContent = ''; note.textContent = '正在导入…'; let imported = 0;
      try {
        for (const file of files) {
          if (file.size > 2 * 1024 * 1024) { err.textContent = file.name + ' 超过 2 MB'; continue; }
          if (/\.zip$/i.test(file.name)) { const r = await api('/api/skills/import-zip', { method: 'POST', body: JSON.stringify({ data: toBase64(await file.arrayBuffer()) }) }); imported += r.created.length; report(r); }
          else { const r = await api('/api/skills/import', { method: 'POST', body: JSON.stringify({ markdown: await file.text() }) }); imported++; note.textContent = '已导入：' + r.skill.title; }
        }
        if (imported) setTimeout(render, 1200);
      } catch (e) { err.textContent = e.message; note.textContent = ''; }
    };
    const picker = el('input', { type: 'file', accept: '.md,.markdown,.txt,.zip', multiple: true, on: { change: () => { if (picker.files.length) upload([...picker.files]); picker.value = ''; } } });
    body.append(
      el('p', { class: 'team-note', textContent: '技能是可以复用的“能力说明”（和 Cindy 的 SKILL.md 同一格式）。在“智能体”里给智能体勾选技能后，它的系统提示词会自动带上这些技能。一个智能体最多 8 个，合计注入约 12000 字。' }),
      skills.length ? skills.map(s => el('div', { class: 'team-row' },
        el('div', { class: 'grow' }, el('span', { class: 'mk-name', title: '点击查看说明', textContent: s.title, on: { click: () => showContent(s.title, s.mine ? '' : '创建者 ' + (s.owner || '—'), s.content || '', null, { description: s.description }) } }), (s.shared ? '（共享）' : '') + (s.mine ? '' : '　创建者 ' + (s.owner || '—')) + (s.origin ? '　' + originText(s.origin) : ''), el('small', { textContent: s.description || s.content.slice(0, 80).replace(/\s+/g, ' ') })),
        el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' },
          el('button', { type: 'button', class: 'secondary', textContent: '查看/编辑', on: { click: () => { fill(s); window.scrollTo(0, 0); f.title.focus(); } } }),
          el('a', { class: 'secondary', href: `/api/skills/${s.id}/export`, textContent: '导出', style: 'display:inline-flex;align-items:center;text-decoration:none;color:inherit' }),
          (s.mine || me.role === 'admin') ? el('button', { type: 'button', class: 'secondary', textContent: '发布到市场', on: { click: () => publishToMarket('skill', s.id, s.title) } }) : null,
          (s.mine || me.role === 'admin') ? el('button', { type: 'button', class: 'secondary danger', textContent: '删除', on: { click: async () => { if (!await ymConfirm('删除技能“' + s.title + '”？已绑定它的智能体会自动解除。', { danger: true, okText: '确定' })) return; await api('/api/skills/' + s.id, { method: 'DELETE' }); render(); } } }) : null))) : el('p', { class: 'team-note', textContent: '还没有技能。' }),
      el('h3', { textContent: '创建 / 编辑技能' }),
      el('div', { class: 'team-form' }, f.title, me.role === 'admin' ? el('label', {}, f.shared, ' 共享给全部成员') : el('span'), f.description, f.content, save,
        editing && el('button', { type: 'button', class: 'secondary wide', textContent: '取消编辑', on: { click: () => render() } })),
      el('h3', { textContent: '上传技能文件' }),
      el('p', { class: 'team-note', textContent: '支持 SKILL.md / .md / .txt，也支持包含若干 SKILL.md 的 .zip（≤2 MB）。只读取文字内容，压缩包里的脚本和其它文件不会被保存或执行。上传的技能默认只有你自己可见。' }),
      el('div', { class: 'team-form' }, picker, note),
      el('h3', { textContent: '或粘贴 SKILL.md' }),
      el('div', { class: 'team-form' }, importBox, el('button', { type: 'button', class: 'primary wide', textContent: '导入', on: { click: async () => {
        try { await api('/api/skills/import', { method: 'POST', body: JSON.stringify({ markdown: importBox.value }) }); render(); } catch (e) { err.textContent = e.message; }
      } } })), err);
  }

  // ---- 市场直接在首页主区域里打开（不再是单独的页面）：侧栏和顶栏保持原样，“市场”导航项高亮；点关闭、点别的导航项或对话就回到原来的内容 ----
  let marketPanel = null;
  let homeSettings = null;
  function closeMarketPanel() { marketPanel?.remove(); marketPanel = null; homeSettings = null; document.querySelectorAll('.side-item.current').forEach(b => b.classList.remove('current')); }
  // 个人设置 / 智能体：和市场一样放在首页主区域里（不跳页面、不弹独立窗口）；管理员另有一个“管理设置 →”入口去单独的管理页
  async function openSettingsPanel(startTab, navKey) {
    const main = document.querySelector('.main'), sidebar = document.querySelector('.sidebar');
    if (!main) { location.href = '/settings' + (startTab && startTab !== 'usage' ? '?tab=' + startTab : ''); return; }
    await refreshSession(); if (!me) return;
    closeMarketPanel();
    homeSettings = el('div', { class: 'team-main home-panel-body' }); tab = startTab;
    marketPanel = el('section', { class: 'home-panel', 'aria-label': '设置' },
      el('div', { class: 'home-panel-head' }, el('h2', { textContent: navKey === 'agents' ? '智能体' : '设置' }), el('span', { class: 'sp', style: 'flex:1' }),
        me.role === 'admin' ? el('a', { class: 'secondary', href: '/admin/settings', textContent: '管理设置 →', style: 'text-decoration:none' }) : null,
        el('button', { type: 'button', class: 'secondary', textContent: '✕ 关闭', on: { click: closeMarketPanel } })),
      homeSettings);
    main.append(marketPanel);
    document.querySelector('.side-item[data-key=' + navKey + ']')?.classList.add('current');
    document.querySelector('.app')?.classList.remove('menu-open');
    if (sidebar && !sidebar.dataset.marketWatch) { sidebar.dataset.marketWatch = '1'; sidebar.addEventListener('click', e => { if (marketPanel && e.target.closest('.new,.chat,.chat-title,.sb-ws-row,.sb-run,.side-item:not([data-key=' + (document.querySelector('.side-item.current')?.dataset.key || 'market') + '])')) closeMarketPanel(); }); }
    await render();
  }
  async function openMarketPanel() {
    const main = document.querySelector('.main'), sidebar = document.querySelector('.sidebar');
    if (!main) { location.href = '/market'; return; }
    closeMarketPanel();
    const box = flatBox(); box.classList.add('team-main', 'home-panel-body');   // 用 flatBox：市场页面里大量用数组和空值拼内容，普通 div 会把它们显示成 [object ...] / undefined
    marketPanel = el('section', { class: 'home-panel', 'aria-label': '技能与机器人市场' },
      el('div', { class: 'home-panel-head' }, el('h2', { textContent: '技能与机器人市场' }), el('button', { type: 'button', class: 'secondary', textContent: '✕ 关闭', on: { click: closeMarketPanel } })),
      el('p', { class: 'team-desc', textContent: TAB_META.market[2] }), box);
    main.append(marketPanel);
    document.querySelector('.side-item[data-key=market]')?.classList.add('current');
    document.querySelector('.app')?.classList.remove('menu-open');
    if (sidebar && !sidebar.dataset.marketWatch) { sidebar.dataset.marketWatch = '1'; sidebar.addEventListener('click', e => { if (marketPanel && e.target.closest('.new,.chat,.chat-title,.side-item:not([data-key=market]),.sb-ws-row,.sb-run')) closeMarketPanel(); }); }
    try { await renderMarket(box); } catch (e) { box.replaceChildren(el('div', { class: 'team-err', textContent: e.message })); }
  }
  // ---------- 市场：技能与机器人模板 ----------
  let marketView = 'skills', marketQuery = '', marketSource = '';
  const publishToMarket = async (type, id, title) => {
    const tags = await ymPrompt('把「' + title + '」投稿到市场。可以填 1–5 个标签，用逗号分隔（可留空）：', '');
    if (tags === null) return;
    try { const r = await api('/api/market/publish', { method: 'POST', body: JSON.stringify({ type, id, tags }) }); ymAlert(r.published ? '已上架到市场' : '已提交，等待管理员审核。可以在「市场 → 我的投稿」查看进度。'); } catch (e) { ymAlert(e.message); }
  };
  // 内容查看弹窗：loader 可以是字符串或返回字符串的（异步）函数；Esc、点遮罩、关闭按钮都能关
  const cjkRatio = t => { const m = String(t || '').match(/[\u4e00-\u9fff]/g); const letters = String(t || '').replace(/[\s\d\p{P}]/gu, '').length || 1; return (m ? m.length : 0) / letters; };
  // 把 SKILL.md 这类 Markdown 整理成可读的内容（不执行任何 HTML，全部用 textContent 生成节点）：
  // 开头的 --- name / description --- 变成“名称 / 简介”摘要卡，# 标题、列表、引用、代码块、粗体、行内代码都会排好版。
  function renderMarkdown(text) {
    const root = document.createElement('div'); root.className = 'mk-md';
    let src = String(text || '').replace(/\r\n?/g, '\n');
    const meta = {}, fm = src.match(/^---\n([\s\S]*?)\n---\n?/);
    if (fm) { for (const line of fm[1].split('\n')) { const m = line.match(/^([\w-]+):\s*(.*)$/); if (m) meta[m[1]] = m[2].replace(/^["']|["']$/g, ''); } src = src.slice(fm[0].length); }
    if (meta.name || meta.description) {
      const card = document.createElement('div'); card.className = 'mk-md-sum';
      if (meta.name) { const n = document.createElement('div'); n.className = 'mk-md-name'; n.textContent = meta.name; card.append(n); }
      if (meta.description) { const d = document.createElement('div'); d.className = 'mk-md-desc'; d.textContent = meta.description; card.append(d); }
      root.append(card);
    }
    const inline = (parent, t) => {
      const re = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|\[[^\]]+\]\([^)]+\))/g; let last = 0, m;
      while ((m = re.exec(t))) {
        if (m.index > last) parent.append(document.createTextNode(t.slice(last, m.index)));
        const tok = m[0]; let node;
        if (tok[0] === '`') { node = document.createElement('code'); node.textContent = tok.slice(1, -1); }
        else if (tok.startsWith('**') || tok.startsWith('__')) { node = document.createElement('strong'); node.textContent = tok.slice(2, -2); }
        else if (tok[0] === '*') { node = document.createElement('em'); node.textContent = tok.slice(1, -1); }
        else { const lm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/); node = document.createElement('span'); node.textContent = lm ? lm[1] : tok; }
        parent.append(node); last = m.index + tok.length;
      }
      if (last < t.length) parent.append(document.createTextNode(t.slice(last)));
    };
    const lines = src.split('\n'), LI = /^\s*([-*+]|\d+[.)])\s+/; let i = 0, para = [];
    const flushPara = () => { if (para.length) { const p = document.createElement('p'); inline(p, para.join(' ')); root.append(p); para = []; } };
    while (i < lines.length) {
      const line = lines[i];
      if (/^```/.test(line)) { flushPara(); const code = []; i++; while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]); i++; const pre = document.createElement('pre'); pre.textContent = code.join('\n'); root.append(pre); continue; }
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { flushPara(); const lvl = Math.min(h[1].length, 3), head = document.createElement('h' + (lvl + 3)); head.className = 'mk-md-h' + lvl; inline(head, h[2]); root.append(head); i++; continue; }
      if (LI.test(line)) {
        flushPara(); const ordered = /^\s*\d+[.)]\s+/.test(line), list = document.createElement(ordered ? 'ol' : 'ul');
        while (i < lines.length && LI.test(lines[i]) && /^\s*\d+[.)]\s+/.test(lines[i]) === ordered) { const li = document.createElement('li'); inline(li, lines[i].replace(LI, '')); list.append(li); i++; while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !LI.test(lines[i])) { li.append(document.createTextNode(' ' + lines[i].trim())); i++; } }
        root.append(list); continue;
      }
      if (/^>\s?/.test(line)) { flushPara(); const q = document.createElement('blockquote'), parts = []; while (i < lines.length && /^>\s?/.test(lines[i])) parts.push(lines[i++].replace(/^>\s?/, '')); inline(q, parts.join(' ')); root.append(q); continue; }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
        // Markdown 表格：表头 + 分隔行 + 若干数据行；列对齐按 :--: 设置；窄屏下可横向滑动
        flushPara();
        const cells = l => l.trim().replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
        const headCells = cells(line), aligns = cells(lines[i + 1]).map(c => /^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : '');
        i += 2;
        const wrap = document.createElement('div'), table = document.createElement('table'), thead = document.createElement('thead'), tbody = document.createElement('tbody'), hr = document.createElement('tr');
        wrap.className = 'mk-md-table';
        headCells.forEach((c, k) => { const th = document.createElement('th'); if (aligns[k]) th.style.textAlign = aligns[k]; inline(th, c); hr.append(th); });
        thead.append(hr);
        while (i < lines.length && /^\s*\|/.test(lines[i])) { const tr = document.createElement('tr'); cells(lines[i]).forEach((c, k) => { const td = document.createElement('td'); if (aligns[k]) td.style.textAlign = aligns[k]; inline(td, c); tr.append(td); }); tbody.append(tr); i++; }
        table.append(thead, tbody); wrap.append(table); root.append(wrap); continue;
      }
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flushPara(); root.append(document.createElement('hr')); i++; continue; }
      if (!line.trim()) { flushPara(); i++; continue; }
      para.push(line.trim()); i++;
    }
    flushPara();
    if (!root.children.length) { const p = document.createElement('p'); p.textContent = '（没有内容）'; root.append(p); }
    return root;
  }
  function showContent(title, sub, loader, footer, opts = {}) {
    const desc = el('p', { class: 'mk-sec', textContent: opts.description || '', hidden: !opts.description });
    const pre = el('pre', { class: 'mk-preview', textContent: '正在读取…', hidden: true }), view = el('div', { class: 'mk-md-wrap' }, el('p', { class: 'mk-note', textContent: '正在读取…' }));
    let rawMode = false;
    const paint = t => { pre.textContent = t; view.replaceChildren(renderMarkdown(t)); };
    const rawBtn = el('button', { type: 'button', class: 'secondary', textContent: '查看原文', hidden: true, on: { click: () => { rawMode = !rawMode; pre.hidden = !rawMode; view.hidden = rawMode; rawBtn.textContent = rawMode ? '查看整理后的内容' : '查看原文'; } } });
    const note = el('p', { class: 'mk-trans', hidden: true });
    let original = { desc: opts.description || '', text: '' }, translated = null, showing = 'orig';
    const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    const closeBtn = el('button', { type: 'button', class: 'secondary', textContent: '关闭', on: { click: close } });
    const tr = async text => (await api('/api/translate', { method: 'POST', body: JSON.stringify({ text }) })).text;
    const transBtn = el('button', { type: 'button', class: 'secondary', textContent: '翻译成中文', hidden: true, on: { click: async () => {
      if (showing === 'zh') { desc.textContent = original.desc; paint(original.text); showing = 'orig'; transBtn.textContent = '翻译成中文'; note.hidden = true; return; }
      if (!translated) {
        transBtn.disabled = true; transBtn.textContent = '翻译中…'; note.hidden = true;
        try { const [d, t] = await Promise.all([original.desc && cjkRatio(original.desc) < .3 ? tr(original.desc) : original.desc, cjkRatio(original.text) < .3 ? tr(original.text) : original.text]); translated = { desc: d, text: t }; }
        catch (e) { note.hidden = false; note.textContent = '翻译失败：' + (e.message || e); transBtn.disabled = false; transBtn.textContent = '翻译成中文'; return; }
        transBtn.disabled = false;
      }
      desc.textContent = translated.desc; paint(translated.text); showing = 'zh'; transBtn.textContent = '显示原文'; note.hidden = false; note.textContent = '由 AI 翻译，仅供参考。';
    } } });
    const back = el('div', { class: 'mk-dlg-back', on: { click: e => { if (e.target === back) close(); } } },
      el('div', { class: 'mk-dlg', role: 'dialog', ariaLabel: title },
        el('div', { class: 'mk-dlg-head' }, el('div', { class: 'grow', style: 'flex:1;min-width:0' }, el('h3', { textContent: title }), sub ? el('small', { textContent: sub }) : null)),
        el('div', { class: 'mk-dlg-body' }, desc, note, view, pre),
        el('div', { class: 'mk-dlg-foot' }, rawBtn, transBtn, footer || null, closeBtn)));
    document.body.append(back); document.addEventListener('keydown', onKey, true); closeBtn.focus();
    const done = t => { original.text = t || '（没有内容）'; paint(original.text); rawBtn.hidden = false; transBtn.hidden = !(cjkRatio(original.text) < .3 || (original.desc && cjkRatio(original.desc) < .3)); };
    Promise.resolve().then(() => typeof loader === 'function' ? loader() : loader).then(done, e => { paint(e.message || String(e)); });
    if (original.desc && cjkRatio(original.desc) < .3) transBtn.hidden = false;
  }
  const STATUS_TEXT = { pending: '审核中', published: '已上架', rejected: '未上架' };
  async function renderMarket(body, banner) {
    const data = await api('/api/market'), err = errBox();
    const again = async note => { const f = flatBox(); body.replaceChildren(f); await renderMarket(f, note); };
    const views = [['skills', '技能', data.skills.length], ['bots', '机器人模板', data.bots.length], ['mine', '我的投稿', data.mine.length]];
    const search = el('input', { type: 'search', placeholder: '搜索名称、说明或标签', value: marketQuery, class: 'mk-search' });
    const grid = el('div', { class: 'mk-grid' });
    const externalNames = [...new Set([...data.skills, ...data.bots].filter(item => item.source === 'external').map(item => item.sourceName))];
    const sourceFilter = el('select', { class: 'mk-filter', title: '按来源筛选' }, el('option', { value: '', textContent: '全部来源' }), el('option', { value: '@builtin', textContent: '官方' }), el('option', { value: '@community', textContent: '社区投稿' }), externalNames.map(name => el('option', { value: name, textContent: '第三方 · ' + name })));
    sourceFilter.value = externalNames.includes(marketSource) || ['@builtin', '@community'].includes(marketSource) ? marketSource : '';
    sourceFilter.addEventListener('change', () => draw());
    const card = item => {
      let previewText = item.preview;
      const install = el('button', { type: 'button', class: 'secondary mk-install', textContent: item.installed ? '✓ 已安装' : '安装', disabled: item.installed, on: { click: async () => {
        install.disabled = true; err.textContent = '';
        try {
          const r = await api('/api/market/install', { method: 'POST', body: JSON.stringify({ type: item.type, key: item.key }) });
          if (item.type === 'skill') await again('已安装技能「' + item.title + '」。到「技能工坊」可以查看，在「智能体」里勾选后就会生效。');
          else await again(el('div', { class: 'team-secret' }, '已创建机器人「' + item.title + '」和它的智能体，令牌只显示这一次：' + r.token + '\nWebhook 地址：' + location.origin + '/bot/' + r.bot.id));
        } catch (e) { err.textContent = e.message; install.disabled = false; }
      } } });
      return el('div', { class: 'mk-card' },
        el('div', { class: 'mk-top' }, el('strong', { class: 'mk-name', title: '点击查看说明', textContent: item.title, on: { click: e => e.target.closest('.mk-card').querySelector('.mk-actions button').click() } }), el('span', { class: 'mk-badge ' + (item.source === 'builtin' ? 'official' : item.source === 'external' ? 'external' : 'community'), textContent: item.source === 'builtin' ? '官方' : item.source === 'external' ? '第三方' : item.mine ? '我的投稿' : '社区' })),
        el('p', { class: 'mk-desc', textContent: item.description || '（没有简介）' }),
        el('div', { class: 'mk-tags' }, item.tags.map(t => el('span', { textContent: t })), item.type === 'bot' && item.skillCount ? el('span', { textContent: '含 ' + item.skillCount + ' 个技能' }) : null),
        el('div', { class: 'mk-meta' }, (item.source === 'external' ? '来源：' : '作者：') + item.author + (item.source === 'external' ? '（第三方内容，请先预览再安装）' : ''), item.url ? el('a', { href: item.url, target: '_blank', rel: 'noopener noreferrer', textContent: '在来源页面查看', style: 'margin-left:8px' }) : null),
        el('div', { class: 'mk-actions' }, el('button', { type: 'button', class: 'secondary', textContent: '查看内容', on: { click: () => showContent(item.title, (item.source === 'external' ? '第三方内容 · 来源：' : '作者：') + item.author, async () => {
          // ClawHub 这类目录条目没有正文，点预览时才去读取（服务器会缓存）
          if (item.lazy && !item.loaded) { const r = await api('/api/market/preview?key=' + encodeURIComponent(item.key)); previewText = r.preview || ''; item.loaded = true; }
          return previewText;
        }, item.installed ? null : el('button', { type: 'button', class: 'secondary', textContent: '安装', on: { click: () => { document.querySelector('.mk-dlg-back')?.remove(); install.click(); } } }), { description: item.description }) } }), install));
    };
    let remote = null, remoteTimer = null;
    const clawSource = () => (data.sources || []).find(src => src.searchable && src.name === sourceFilter.value);
    const draw = () => {
      marketQuery = search.value.trim();
      // 列表为空时说明原因：多半是来源筛选还停在某个第三方来源（它们通常只有技能，没有机器人模板）
      const emptyState = () => {
        const tabName = marketView === 'bots' ? '机器人模板' : '技能';
        if (marketSource) {
          const label = sourceFilter.selectedOptions[0]?.textContent || marketSource;
          return el('div', { class: 'team-empty', style: 'grid-column:1/-1;display:grid;gap:10px;justify-items:center;padding:22px 16px' },
            el('div', { textContent: `「${label}」下${marketQuery ? '没有匹配的' : '没有'}${tabName}。` }),
            marketView === 'bots' && marketSource !== '@builtin' && marketSource !== '@community' ? el('div', { class: 'team-note', textContent: '第三方来源通常只提供技能，没有机器人模板。' }) : null,
            el('button', { type: 'button', class: 'secondary', textContent: '显示全部来源', on: { click: () => { sourceFilter.value = ''; draw(); } } }));
        }
        return el('div', { class: 'team-empty', textContent: marketQuery ? '没有匹配的条目。试试换个关键字。' : `这里还没有${tabName}。` });
      };
      marketSource = sourceFilter.value;
      const matchSource = item => !marketSource || (marketSource === '@builtin' ? item.source === 'builtin' : marketSource === '@community' ? item.source === 'community' : item.sourceName === marketSource);
      const matchQuery = item => !marketQuery || (item.title + item.description + item.tags.join(' ')).toLowerCase().includes(marketQuery.toLowerCase());
      let list = (marketView === 'bots' ? data.bots : data.skills).filter(item => matchSource(item) && matchQuery(item));
      let hint = '';
      if (marketView === 'skills' && clawSource()) {
        if (remote) { const seen = new Set(list.map(item => item.key)); list = [...list, ...remote.filter(item => !seen.has(item.key))]; hint = '全站搜索结果（含下方已收录的热门技能）。'; }
        else hint = marketQuery.length >= 2 ? '正在搜索 ClawHub…' : '默认显示该来源收录的热门技能；输入至少 2 个字可以实时搜索全站（支持中文关键字）。';
      }
      grid.replaceChildren(...[hint ? el('div', { class: 'team-note', textContent: hint, style: 'grid-column:1/-1;margin:0' }) : null, ...(list.length ? list.map(card) : [emptyState()])].filter(Boolean));
    };
    const searchRemote = () => {
      clearTimeout(remoteTimer);
      const src = clawSource(), q = search.value.trim();
      if (!src || q.length < 2 || marketView !== 'skills') { if (remote) { remote = null; draw(); } return; }
      remoteTimer = setTimeout(async () => {
        try { remote = (await api('/api/market/search?source=' + src.id + '&q=' + encodeURIComponent(q))).items; err.textContent = ''; }
        catch (e) { remote = null; err.textContent = e.message; }
        draw();
      }, 450);
    };
    sourceFilter.addEventListener('change', () => { remote = null; searchRemote(); });
    search.addEventListener('input', () => { draw(); searchRemote(); });
    const tools = el('div', { class: 'mk-tools' }, search, sourceFilter);
    const mine = el('div', {}, data.mine.length ? data.mine.map(m => el('div', { class: 'team-row' },
      el('div', { class: 'grow' }, m.title + '　' + (m.type === 'bot' ? '机器人模板' : '技能'), el('small', { textContent: STATUS_TEXT[m.status] + (m.note ? '　' + m.note : '') + '　' + fmt(m.createdAt) })),
      el('button', { type: 'button', class: 'secondary', textContent: m.status === 'published' ? '下架并删除' : '撤回', on: { click: async () => { if (!await ymConfirm('确定' + (m.status === 'published' ? '下架并删除' : '撤回') + '「' + m.title + '」？已经安装它的人不受影响。', { danger: true, okText: '确定' })) return; await api('/api/market/items/' + m.id, { method: 'DELETE' }); again(); } } })))
      : [el('div', { class: 'team-empty', textContent: '你还没有投稿。在「技能工坊」或「机器人」里点“发布到市场 / 发布为模板”即可提交；成员投稿需要管理员审核。' })]);
    body.append(
      banner && (typeof banner === 'string' ? el('div', { class: 'team-note mk-banner', textContent: banner }) : banner),
      el('div', { class: 'mk-seg' }, views.map(([id, label, count]) => el('button', { type: 'button', class: id === marketView ? 'on' : '', textContent: label + ' ' + count, on: { click: () => { marketView = id; again(); } } }))),
      marketView === 'mine' ? mine : [tools, grid], err);
    if (marketView !== 'mine') draw();
  }
  const ORIGIN_TEXT = { builtin: '来自市场 · 官方', community: '来自市场 · 社区', external: '来自市场 · 第三方', own: '自己创建' };
  const originText = o => o ? (o.kind === 'external' && o.name ? '来自市场 · 第三方 ' + o.name : (ORIGIN_TEXT[o.kind] || '')) : '';
  let userSkillFilter = '', userSkillOrigin = '';
  async function renderUserSkills(body) {
    const data = await api('/api/admin/skills'), err = errBox();
    const userSel = el('select', { on: { change: () => { userSkillFilter = userSel.value; draw(); } } }, el('option', { value: '', textContent: '全部成员（' + data.users.length + '）' }),
      data.users.map(u => el('option', { value: u.id, textContent: u.displayName + '　' + u.skillCount + ' 个技能（安装 ' + u.installedCount + '）' })));
    const originSel = el('select', { on: { change: () => { userSkillOrigin = originSel.value; draw(); } } }, el('option', { value: '', textContent: '全部来源' }), ['builtin', 'community', 'external', 'own'].map(k => el('option', { value: k, textContent: ORIGIN_TEXT[k].replace('来自市场 · ', '市场 · ') })));
    userSel.value = data.users.some(u => u.id === userSkillFilter) ? userSkillFilter : ''; originSel.value = userSkillOrigin;
    const list = el('div', {});
    const draw = () => {
      const rows = data.skills.filter(sk => (!userSkillFilter || sk.ownerId === userSkillFilter) && (!userSkillOrigin || sk.origin.kind === userSkillOrigin));
      list.replaceChildren(...(rows.length ? rows.map(sk => el('div', { class: 'team-row', style: 'align-items:flex-start' },
        el('div', { class: 'grow' }, sk.title + (sk.shared ? '（共享）' : ''),
          el('small', { textContent: sk.ownerName + '（' + sk.ownerEmail + '）　' + originText(sk.origin) + '　' + sk.length + ' 字　被 ' + sk.usedByAgents + ' 个智能体使用　' + fmt(sk.createdAt) }),
          el('button', { type: 'button', class: 'secondary', textContent: '查看内容', style: 'margin-top:6px', on: { click: () => showContent(sk.title, sk.ownerName + '（' + sk.ownerEmail + '）', sk.preview + (sk.length > 800 ? '\n…（共 ' + sk.length + ' 字）' : '')) } })),
        el('button', { type: 'button', class: 'secondary danger', textContent: '移除', on: { click: async () => {
          if (!await ymConfirm('移除 ' + sk.ownerName + ' 的技能「' + sk.title + '」？它在智能体上的绑定会一并解除，不可恢复。', { danger: true, okText: '确定' })) return;
          try { await api('/api/skills/' + sk.id, { method: 'DELETE' }); render(); } catch (e) { err.textContent = e.message; }
        } } }))) : [el('div', { class: 'team-empty', textContent: '没有符合条件的技能。' })]));
    };
    const tplCount = data.templates.length;
    body.append(
      el('p', { class: 'team-note', textContent: '共 ' + data.skills.length + ' 个技能，其中从市场安装 ' + data.skills.filter(sk => sk.marketKey).length + ' 个；成员安装过的机器人模板 ' + tplCount + ' 个。技能只是给模型看的文字，不会被执行；每个人安装的都是自己的一份，互相看不到。' }),
      el('div', { class: 'team-form' }, userSel, originSel), err, list,
      tplCount ? [el('h3', { textContent: '成员安装的机器人模板' }), data.templates.map(t => el('div', { class: 'team-row' }, el('div', { class: 'grow' }, t.title, el('small', { textContent: t.ownerEmail + '　' + t.marketKey + '　' + fmt(t.createdAt) }))))] : null);
    draw();
  }
  async function renderReview(body) {
    const data = await api('/api/admin/market'), err = errBox();
    const act = async (id, action, note) => { try { await api('/api/admin/market/' + id, { method: 'PATCH', body: JSON.stringify({ action, note }) }); render(); } catch (e) { err.textContent = e.message; } };
    const row = (m, buttons) => el('div', { class: 'team-row', style: 'align-items:flex-start' },
      el('div', { class: 'grow' }, m.title + '　' + (m.type === 'bot' ? '机器人模板' : '技能') + '　作者 ' + m.author,
        el('small', { textContent: (m.description || '（没有简介）') + (m.tags.length ? '　标签 ' + m.tags.join('、') : '') + (m.note ? '　备注 ' + m.note : '') }),
        el('button', { type: 'button', class: 'secondary', textContent: '查看内容', style: 'margin-top:6px', on: { click: () => showContent(m.title, '作者 ' + m.author, m.preview) } })),
      el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' }, buttons));
    const srcData = await api('/api/admin/market/sources'), suggested = (await api('/api/admin/market/suggested')).suggested;
    const srcKind = el('select', {}, el('option', { value: 'github', textContent: 'GitHub 仓库（里面放 SKILL.md）' }), el('option', { value: 'index', textContent: 'JSON 索引地址（https）' }), el('option', { value: 'clawhub', textContent: 'ClawHub（clawhub.ai 公开技能目录）' }), el('option', { value: 'clawhub-mirror', textContent: 'ClawHub 中国镜像（mirror-cn.clawhub.com，中文）' }));
    const srcTarget = el('input', { placeholder: 'GitHub：所有者/仓库名；索引：https://…/index.json' }), srcName = el('input', { placeholder: '显示名称（可选）', maxLength: 40 });
    const srcBranch = el('input', { placeholder: '分支（可选，默认 main/master）' }), srcPath = el('input', { placeholder: '子目录（可选）' });
    srcKind.addEventListener('change', () => { const gh = srcKind.value === 'github'; srcBranch.hidden = !gh; srcPath.hidden = !gh; srcTarget.hidden = srcKind.value.startsWith('clawhub'); });
    const srcCall = async (url, method, payload) => { err.style.color = 'var(--muted)'; err.textContent = '处理中…抓取外部内容可能需要几秒，请稍候'; try { await api(url, { method, body: payload ? JSON.stringify(payload) : undefined }); render(); } catch (e) { err.style.color = ''; err.textContent = e.message; } };
    body.append(
      el('h3', { textContent: '外部来源 ' + srcData.sources.length }),
      el('p', { class: 'team-note', textContent: '把其它地方的技能 / 机器人模板接进来，成员在「市场」里就能挑选。只导入文字内容；外部内容可能带有诱导性指令或有版权要求，请只添加你信任的来源，并自行确认许可。成员安装前会看到“第三方”标记和预览。' }),
      srcData.sources.length ? srcData.sources.map(src => el('div', { class: 'team-row' },
        el('div', { class: 'grow' }, src.name + '　' + (src.kind === 'github' ? 'GitHub' : src.kind === 'clawhub' ? 'ClawHub' : '索引') + (src.enabled ? '' : '　（已停用）'),
          el('small', { textContent: src.target + '　' + (src.loading ? '正在后台抓取，稍后点“刷新”查看…' : src.error ? '抓取失败：' + src.error : src.count == null ? '尚未抓取' : '已收录 ' + src.count + ' 条') + (src.warning ? '　⚠ ' + src.warning : '') + (src.checkedAt ? '　' + fmt(src.checkedAt) : '') })),
        el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' },
          el('button', { type: 'button', class: 'secondary', textContent: '刷新', on: { click: () => srcCall('/api/admin/market/sources/' + src.id + '/refresh', 'POST') } }),
          el('button', { type: 'button', class: 'secondary', textContent: src.enabled ? '停用' : '启用', on: { click: () => srcCall('/api/admin/market/sources/' + src.id, 'PATCH', { enabled: !src.enabled }) } }),
          el('button', { type: 'button', class: 'secondary danger', textContent: '删除', on: { click: async () => { if (await ymConfirm('删除来源“' + src.name + '”？已经安装的内容不受影响。', { danger: true, okText: '确定' })) srcCall('/api/admin/market/sources/' + src.id, 'DELETE'); } } }))))
        : el('div', { class: 'team-empty', textContent: '还没有外部来源。' }),
      suggested.some(item => !item.added) ? [el('h3', { textContent: '推荐来源（一键添加）' }), suggested.filter(item => !item.added).map(item => el('div', { class: 'team-row' },
        el('div', { class: 'grow' }, item.name + (item.repo ? '　' + item.repo : item.variant === 'mirror' ? '　mirror-cn.clawhub.com' : '　clawhub.ai'), el('small', { textContent: item.note + '　许可：' + item.license + '（仅供参考，请自行确认）' })),
        el('button', { type: 'button', class: 'secondary', textContent: '添加', on: { click: () => srcCall('/api/admin/market/sources', 'POST', { option: item.option, kind: item.kind || 'github', variant: item.variant, repo: item.repo, name: item.name }) } })))] : null,
      el('div', { class: 'team-form' }, srcKind, srcName, srcTarget, srcBranch, srcPath,
        el('button', { type: 'button', class: 'secondary wide', textContent: '添加来源并抓取', on: { click: () => srcCall('/api/admin/market/sources', 'POST', { kind: srcKind.value.startsWith('clawhub') ? 'clawhub' : srcKind.value, variant: srcKind.value === 'clawhub-mirror' ? 'mirror' : undefined, name: srcName.value, target: srcTarget.value, branch: srcBranch.value, path: srcPath.value }) } })),
      el('h3', { textContent: '待审核 ' + data.pending.length }),
      data.pending.length ? data.pending.map(m => row(m, [
        el('button', { type: 'button', class: 'secondary', textContent: '通过上架', on: { click: () => act(m.id, 'approve') } }),
        el('button', { type: 'button', class: 'secondary', textContent: '拒绝', on: { click: async () => { const note = await ymPrompt('拒绝原因（会显示给投稿人，可留空）：', ''); if (note !== null) act(m.id, 'reject', note); } } })]))
        : el('div', { class: 'team-empty', textContent: '没有待审核的投稿。' }),
      el('h3', { textContent: '已上架 ' + data.published.length }),
      data.published.map(m => row(m, el('button', { type: 'button', class: 'secondary danger', textContent: '下架', on: { click: async () => { const note = await ymPrompt('下架原因（可留空）：', ''); if (note !== null) act(m.id, 'unpublish', note); } } }))),
      data.rejected.length ? [el('h3', { textContent: '未上架 ' + data.rejected.length }), data.rejected.map(m => row(m, el('button', { type: 'button', class: 'secondary', textContent: '重新上架', on: { click: () => act(m.id, 'approve') } })))] : null,
      err);
  }

  // ---------- 机器人 ----------
  async function renderBots(body, secret) {
    await loadAgents();
    const { bots } = await api('/api/bots'), err = errBox(), name = el('input', { placeholder: '机器人名称，如 客服小助手', maxLength: 40 });
    const agent = el('select', {}, el('option', { value: '', textContent: '默认 Yumeiro（不带提示词）' }), agentsCache.map(a => el('option', { value: a.id, textContent: a.name })));
    const urlOf = b => location.origin + '/bot/' + b.id;
    const memBox = el('div', {});
    const showBotMemories = async b => {
      const d = await api(`/api/bots/${b.id}/memories`), bySession = new Map();
      for (const m of d.memories) { if (!bySession.has(m.session)) bySession.set(m.session, []); bySession.get(m.session).push(m); }
      const del = async (path, ask) => { if (ask && !await ymConfirm(ask)) return; await api(path, { method: 'DELETE' }); showBotMemories(b); };
      memBox.replaceChildren(el('h4', { textContent: `机器人“${b.name}”的记忆` }),
        el('p', { class: 'team-note', textContent: '按会话（session）隔离：每个对话对象只用得到自己的记忆，不会带上你的个人记忆，也不会串到别的会话。对话里说“记住：……”也会保存。' }),
        d.memories.length ? el('button', { type: 'button', class: 'secondary', textContent: '清空全部', on: { click: () => del(`/api/bots/${b.id}/memories`, '清空这个机器人的全部记忆？') } }) : el('p', { class: 'team-note', textContent: d.enabled ? '还没有记忆。多聊几轮后会自动出现。' : '记忆已关闭。' }),
        ...[...bySession].map(([session, items]) => el('div', { class: 'team-row', style: 'display:block' },
          el('div', { style: 'display:flex;gap:8px;align-items:center' }, el('strong', { class: 'grow', textContent: '会话：' + session }), el('button', { type: 'button', class: 'secondary', textContent: '清空此会话', on: { click: () => del(`/api/bots/${b.id}/memories?session=${encodeURIComponent(session)}`, '清空会话“' + session + '”的记忆？') } })),
          ...items.map(m => el('div', { style: 'display:flex;gap:8px;align-items:flex-start;margin-top:6px' }, el('span', { class: 'grow', textContent: (m.pinned ? '★ ' : '') + m.text }), el('button', { type: 'button', class: 'secondary danger', textContent: '删除', on: { click: () => del(`/api/bots/${b.id}/memories/${m.id}`) } }))))));
      memBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };
    body.append(
      el('p', { class: 'team-note', textContent: '机器人 = 一个固定的 Webhook 地址 + 令牌，绑定一个智能体。任何能发 HTTP 请求的程序（企业微信/飞书/钉钉的自动化、脚本、Zapier 类工具）把消息 POST 过来，就能收到智能体的回复；同一个 session 会记住上下文，并按会话记住对话对象的偏好和背景（可在下面开关、查看和删除；不会带上你的个人记忆）。调用计入你的额度。本站目前没有内置 IM 平台的官方连接器。' }),
      secret && el('div', { class: 'team-secret', textContent: secret }),
      el('div', { class: 'team-form' }, name, agent, el('button', { type: 'button', class: 'primary wide', textContent: '创建机器人', on: { click: async () => {
        try { const r = await api('/api/bots', { method: 'POST', body: JSON.stringify({ name: name.value, agentId: agent.value }) }); const fresh = flatBox(); body.replaceChildren(fresh); await renderBots(fresh, `令牌（只显示这一次）：${r.token}\n地址：${urlOf(r.bot)}`); } catch (e) { err.textContent = e.message; }
      } } })), err,
      bots.length ? bots.map(b => el('div', { class: 'team-row' },
        el('div', { class: 'grow' }, b.name + (b.agentName ? ' · ' + b.agentName : ''), el('small', { textContent: `${urlOf(b)}　令牌 ${b.tokenPrefix}…　最近使用 ${fmt(b.lastUsedAt)}` })),
        el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' },
          el('button', { type: 'button', class: 'secondary', textContent: b.memory ? '记忆：开' : '记忆：关', title: '开启后，机器人会按会话记住对话对象的偏好和背景', on: { click: async () => { await api('/api/bots/' + b.id, { method: 'PATCH', body: JSON.stringify({ memory: !b.memory }) }); render(); } } }),
          el('button', { type: 'button', class: 'secondary', textContent: `查看记忆（${b.memoryCount}）`, on: { click: () => showBotMemories(b).catch(e => { err.textContent = e.message; }) } }),
          el('button', { type: 'button', class: 'secondary', textContent: '发布为模板', on: { click: () => publishToMarket('bot', b.id, b.name) } }),
          el('button', { type: 'button', class: 'secondary', textContent: '换令牌', on: { click: async () => { if (!await ymConfirm('换令牌后，旧令牌立即失效。继续？', { danger: true, okText: '确定' })) return; const r = await api(`/api/bots/${b.id}/rotate`, { method: 'POST', body: '{}' }); const fresh = flatBox(); body.replaceChildren(fresh); await renderBots(fresh, `新令牌（只显示这一次）：${r.token}\n地址：${urlOf(r.bot)}`); } } }),
          el('button', { type: 'button', class: 'secondary danger', textContent: '删除', on: { click: async () => { if (!await ymConfirm('删除机器人“' + b.name + '”及它的会话记录？', { danger: true, okText: '确定' })) return; await api('/api/bots/' + b.id, { method: 'DELETE' }); render(); } } })))) : el('p', { class: 'team-note', textContent: '还没有机器人。' }),
      memBox,
      el('p', { class: 'team-note' }, '调用示例：', el('code', { textContent: `curl ${location.origin}/bot/<机器人ID> -H "Authorization: Bearer bot_…" -H "Content-Type: application/json" -d '{"text":"你好","session":"用户A"}'  →  {"reply":"…"}` })));
  }

  // ---------- 站点设置（管理员）：登录页上显示的团队名称和公告 ----------
  // ---- 绘画模型（管理员）：接入文生图服务（OpenAI 兼容 /images/generations）----
  async function renderImageGen(body) {
    const data = await api('/api/admin/images'), cfg = data.config, err = errBox(), info = el('div', { class: 'team-note' });
    const enabled = el('input', { type: 'checkbox', checked: Boolean(cfg.enabled) });
    const provider = el('select', {}, el('option', { value: '', textContent: '选择服务商…' }), el('option', { value: 'custom', textContent: '自定义（在本页直接填地址 / 密钥）' }), data.providers.map(p => el('option', { value: p.id, textContent: p.name })));
    provider.value = cfg.provider === 'custom' || data.providers.some(p => p.id === cfg.provider) ? cfg.provider : '';
    const baseUrl = el('input', { class: 'wide', placeholder: '接口地址，如 https://api.openai.com/v1；本机 SD WebUI 如 http://192.168.1.20:7860；ComfyUI 如 http://192.168.1.20:8188', value: cfg.baseUrl || '', maxLength: 300 });
    const apiKey = el('input', { class: 'wide', type: 'password', autocomplete: 'off', placeholder: cfg.hasKey ? '已保存（' + cfg.keyMask + '），留空表示不修改' : '密钥（本机 SD WebUI 开了 --api-auth 时填 用户名:密码）', maxLength: 500 });
    const customBox = el('div', { class: 'team-form' }, baseUrl, apiKey);
    const syncCustom = () => { customBox.style.display = provider.value === 'custom' ? '' : 'none'; };
    provider.addEventListener('change', syncCustom); syncCustom();
    const model = el('input', { class: 'wide', placeholder: '绘画模型名称，如 gpt-image-1 / dall-e-3 / cogview-4；ComfyUI 填检查点文件名；SD WebUI 可留空', value: cfg.model || '', maxLength: 200 });
    const dialect = el('select', {}, data.dialects.map(d => el('option', { value: d.id, textContent: d.label })));
    dialect.value = cfg.dialect || 'openai';
    const responseFormat = el('select', {}, [['', '不指定返回格式（gpt-image-1 等模型必须选这个）'], ['b64_json', '要求返回 base64（b64_json）'], ['url', '要求返回地址（url）']].map(([v, t]) => el('option', { value: v, textContent: t })));
    responseFormat.value = cfg.responseFormat || '';
    const batchMode = el('select', {}, (data.batchModes || []).map(b => el('option', { value: b.id, textContent: b.label })));
    batchMode.value = cfg.batchMode || 'native';
    const sizes = el('input', { class: 'wide', placeholder: '可选尺寸，空格或逗号分隔，如 1024x1024 1024x1792 1792x1024', value: (cfg.sizes || []).join(' '), maxLength: 200 });
    const defaultSize = el('input', { placeholder: '默认尺寸', value: cfg.defaultSize || '1024x1024', maxLength: 20, style: 'width:140px' });
    const dailyLimit = el('input', { type: 'number', min: 0, max: 10000, value: cfg.dailyLimit, style: 'width:120px' });
    const maxPerRequest = el('input', { type: 'number', min: 1, max: 4, value: cfg.maxPerRequest, style: 'width:100px' });
    const allowCustomSize = el('input', { type: 'checkbox', checked: Boolean(cfg.allowCustomSize) });
    const minSide = el('input', { type: 'number', min: 64, max: 4096, value: cfg.minSide, style: 'width:90px' }), maxSide = el('input', { type: 'number', min: 64, max: 4096, value: cfg.maxSide, style: 'width:90px' });
    const sizeStep = el('input', { type: 'number', min: 1, max: 256, value: cfg.sizeStep, style: 'width:80px' }), maxPixels = el('input', { type: 'number', min: 65536, max: 16777216, value: cfg.maxPixels, style: 'width:130px' });
    const customBoxSize = el('div', { class: 'team-form' }, el('label', {}, '每条边 ', minSide, ' – ', maxSide), el('label', {}, '必须是 ', sizeStep, ' 的倍数'), el('label', {}, '总像素上限 ', maxPixels));
    const syncSize = () => { customBoxSize.style.display = allowCustomSize.checked ? '' : 'none'; };
    allowCustomSize.addEventListener('change', syncSize); syncSize();
    const extraParams = el('textarea', { placeholder: '额外参数（可选，JSON），会合并进请求，如 {"quality":"medium"}；SD WebUI 可放 {"steps":28,"cfg_scale":7}', maxLength: 2000, style: 'min-height:56px' });
    extraParams.value = Object.keys(cfg.extraParams || {}).length ? JSON.stringify(cfg.extraParams) : '';
    const workflow = el('textarea', { placeholder: 'ComfyUI 工作流（API 格式 JSON，留空用内置的基础文生图流程）。可用占位符：{{model}} {{prompt}} {{negative}} {{width}} {{height}} {{batch}} {{seed}}', maxLength: 30000, style: 'min-height:90px;font-family:ui-monospace,monospace;font-size:12px' });
    workflow.value = cfg.workflow || '';
    const syncDialect = () => { workflow.style.display = dialect.value === 'comfyui' ? '' : 'none'; responseFormat.style.display = (dialect.value === 'openai') ? '' : 'none'; };
    dialect.addEventListener('change', syncDialect); syncDialect();
    const PRESETS = [
      ['OpenAI（gpt-image-1）', { baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-1', dialect: 'openai', responseFormat: '', sizes: '1024x1024 1024x1536 1536x1024', defaultSize: '1024x1024', batchMode: 'native' }],
      ['OpenAI（dall-e-3，一次只能 1 张）', { baseUrl: 'https://api.openai.com/v1', model: 'dall-e-3', dialect: 'openai', responseFormat: 'b64_json', sizes: '1024x1024 1024x1792 1792x1024', defaultSize: '1024x1024', batchMode: 'split' }],
      ['智谱 CogView', { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'cogview-4', dialect: 'openai', responseFormat: '', sizes: '1024x1024 768x1344 1344x768', defaultSize: '1024x1024', batchMode: 'split' }],
      ['硅基流动（Kolors）', { baseUrl: 'https://api.siliconflow.cn/v1', model: 'Kwai-Kolors/Kolors', dialect: 'siliconflow', responseFormat: '', sizes: '1024x1024 960x1280 1280x960', defaultSize: '1024x1024', batchMode: 'native' }],
      ['火山方舟（豆包绘画，模型填接入点 ID）', { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'ep-…', dialect: 'openai', responseFormat: '', sizes: '1024x1024 1280x720 720x1280', defaultSize: '1024x1024', batchMode: 'native' }],
      ['本机 Stable Diffusion WebUI / Forge', { baseUrl: 'http://127.0.0.1:7860', model: '', dialect: 'a1111', responseFormat: '', sizes: '512x512 768x512 512x768 1024x1024', defaultSize: '512x512', batchMode: 'native' }],
      ['本机 ComfyUI', { baseUrl: 'http://127.0.0.1:8188', model: 'sd_xl_base_1.0.safetensors', dialect: 'comfyui', responseFormat: '', sizes: '1024x1024 832x1216 1216x832', defaultSize: '1024x1024', batchMode: 'native' }]
    ];
    const preset = el('select', {}, el('option', { value: '', textContent: '一键套用示例…（模型名以服务商文档为准）' }), PRESETS.map(([name], i) => el('option', { value: i, textContent: name })));
    preset.addEventListener('change', () => {
      if (preset.value === '') return; const p = PRESETS[Number(preset.value)][1];
      provider.value = 'custom'; syncCustom(); baseUrl.value = p.baseUrl; model.value = p.model; dialect.value = p.dialect; responseFormat.value = p.responseFormat; sizes.value = p.sizes; defaultSize.value = p.defaultSize; batchMode.value = p.batchMode; syncDialect();
      info.textContent = '已填入示例；请再填写密钥（本机引擎一般不需要），必要时修改地址和模型名，然后先点“测试”。';
    });
    const form = () => ({ enabled: enabled.checked, provider: provider.value, baseUrl: baseUrl.value, ...(apiKey.value ? { apiKey: apiKey.value } : {}), model: model.value, dialect: dialect.value, responseFormat: responseFormat.value, batchMode: batchMode.value, sizes: sizes.value, defaultSize: defaultSize.value, dailyLimit: Number(dailyLimit.value), maxPerRequest: Number(maxPerRequest.value), allowCustomSize: allowCustomSize.checked, minSide: Number(minSide.value), maxSide: Number(maxSide.value), sizeStep: Number(sizeStep.value), maxPixels: Number(maxPixels.value), extraParams: extraParams.value, workflow: workflow.value });
    body.append(
      el('p', { class: 'team-note', textContent: '接入一个文生图模型后，聊天页顶栏会出现 🎨 绘画按钮，成员可以输入描述、选尺寸和张数生成图片；图片保存在服务器上，只有本人能看。也提供 OpenAI 兼容的 POST /v1/images/generations 给程序调用（返回 b64_json）。图片内容由上游服务审核，请遵守服务商的使用条款。' }),
      el('div', { class: 'team-form' }, el('label', {}, enabled, ' 启用绘画'), preset, provider), customBox,
      el('div', { class: 'team-form' }, model, dialect, responseFormat, batchMode, sizes,
        el('label', {}, '默认尺寸 ', defaultSize), el('label', {}, '每人每天张数（0=不限）', dailyLimit), el('label', {}, '单次最多 ', maxPerRequest, ' 张（1–4）'),
        el('label', {}, allowCustomSize, ' 允许成员自己输入宽高（在下面的范围内）'), customBoxSize, extraParams, workflow,
        el('button', { type: 'button', class: 'primary', textContent: '保存', on: { click: async () => { try { await api('/api/admin/images', { method: 'PUT', body: JSON.stringify(form()) }); err.textContent = ''; apiKey.value = ''; info.textContent = '已保存'; } catch (e) { err.textContent = e.message; } } } }),
        el('button', { type: 'button', class: 'secondary', textContent: '测试（会真实生成一张小图，可能产生费用）', on: { click: async () => { info.textContent = '测试中…（最长约 3 分钟）'; err.textContent = ''; try { const r = await api('/api/admin/images/test', { method: 'POST', body: JSON.stringify(form()) }); if (r.ok) info.textContent = '测试成功：' + r.ms + ' ms，' + r.mime + '，' + r.bytes + ' 字节'; else { info.textContent = ''; err.textContent = r.error; } } catch (e) { info.textContent = ''; err.textContent = e.message; } } } })),
      info, err,
      el('div', { class: 'team-note' },
        el('p', { textContent: '多张：单次最多 1–4 张。有些模型一次只允许 1 张（如 dall-e-3、CogView），选“总是拆成多次单张”；选“一次请求出多张”时如果上游返回 HTTP 400，会自动改成多次单张。' }),
        el('p', { textContent: '本机引擎（SD WebUI / ComfyUI）：服务器必须能访问到那台电脑的地址（同一局域网、VPN 或 Tailscale / frp 之类的内网穿透）。SD WebUI 启动加 --api（要给别的机器访问再加 --listen），ComfyUI 加 --listen；强烈建议只在内网使用，并给 SD WebUI 设 --api-auth 用户名:密码，把“用户名:密码”填到上面的密钥里。Docker 部署时，宿主机地址可以用 host.docker.internal。' }),
        el('p', { textContent: '国内“异步任务式”的绘画接口（如通义万相）不是 OpenAI 兼容格式，暂不支持，可通过 OpenAI 兼容的网关或聚合服务接入。用 OpenAI 官方绘画接口时，同样受“环境检测”里的受限地区守卫约束。' })));
  }

  // ---- 语音朗读（管理员）：接入语音合成（OpenAI 兼容 /audio/speech）----
  async function renderTts(body) {
    const data = await api('/api/admin/tts'), cfg = data.config, err = errBox(), info = el('div', { class: 'team-note' });
    const enabled = el('input', { type: 'checkbox', checked: Boolean(cfg.enabled) });
    const provider = el('select', {}, el('option', { value: '', textContent: '选择服务商…' }), el('option', { value: 'custom', textContent: '自定义（在本页直接填地址 / 密钥）' }), data.providers.map(p => el('option', { value: p.id, textContent: p.name })));
    provider.value = cfg.provider === 'custom' || data.providers.some(p => p.id === cfg.provider) ? cfg.provider : '';
    const baseUrl = el('input', { class: 'wide', placeholder: '接口地址，如 https://api.openai.com/v1（会请求 地址/audio/speech）', value: cfg.baseUrl || '', maxLength: 300 });
    const apiKey = el('input', { class: 'wide', type: 'password', autocomplete: 'off', placeholder: cfg.hasKey ? '已保存（' + cfg.keyMask + '），留空表示不修改' : '密钥', maxLength: 500 });
    const customBox = el('div', { class: 'team-form' }, baseUrl, apiKey);
    const syncCustom = () => { customBox.style.display = provider.value === 'custom' ? '' : 'none'; };
    provider.addEventListener('change', syncCustom); syncCustom();
    const model = el('input', { class: 'wide', placeholder: '语音合成模型名称，如 tts-1 / gpt-4o-mini-tts', value: cfg.model || '', maxLength: 200 });
    const voices = el('textarea', { placeholder: '可选音色，逗号或换行分隔，如 alloy, echo, nova（音色名以服务商文档为准）', maxLength: 3000, style: 'min-height:56px' });
    voices.value = (cfg.voices || []).join(', ');
    const defaultVoice = el('input', { placeholder: '默认音色', value: cfg.defaultVoice || '', maxLength: 120, style: 'width:220px' });
    const format = el('select', {}, ['mp3', 'wav', 'opus', 'aac', 'flac'].map(f => el('option', { value: f, textContent: f })));
    format.value = cfg.format || 'mp3';
    const speed = el('input', { type: 'number', min: 0.5, max: 2, step: 0.05, value: cfg.speed, style: 'width:90px' });
    const dailyChars = el('input', { type: 'number', min: 0, max: 10000000, value: cfg.dailyChars, style: 'width:130px' });
    const maxChars = el('input', { type: 'number', min: 50, max: 4096, value: cfg.maxChars, style: 'width:100px' });
    const readCode = el('input', { type: 'checkbox', checked: Boolean(cfg.readCode) });
    const extraParams = el('textarea', { placeholder: '额外参数（可选，JSON），会合并进请求，如 {"instructions":"用温柔的语气朗读"}', maxLength: 2000, style: 'min-height:56px' });
    extraParams.value = Object.keys(cfg.extraParams || {}).length ? JSON.stringify(cfg.extraParams) : '';
    const PRESETS = [
      ['OpenAI（tts-1）', { baseUrl: 'https://api.openai.com/v1', model: 'tts-1', voices: 'alloy, echo, fable, onyx, nova, shimmer', defaultVoice: 'alloy' }],
      ['OpenAI（gpt-4o-mini-tts，可用 instructions 指定语气）', { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini-tts', voices: 'alloy, ash, coral, echo, fable, nova, onyx, sage, shimmer', defaultVoice: 'coral' }],
      ['硅基流动（CosyVoice2，中文效果好）', { baseUrl: 'https://api.siliconflow.cn/v1', model: 'FunAudioLLM/CosyVoice2-0.5B', voices: 'FunAudioLLM/CosyVoice2-0.5B:alex, FunAudioLLM/CosyVoice2-0.5B:anna, FunAudioLLM/CosyVoice2-0.5B:bella, FunAudioLLM/CosyVoice2-0.5B:claire, FunAudioLLM/CosyVoice2-0.5B:diana', defaultVoice: 'FunAudioLLM/CosyVoice2-0.5B:anna' }],
      ['自建 openai-edge-tts（微软 Edge 音色，免费）', { baseUrl: 'http://127.0.0.1:5050/v1', model: 'tts-1', voices: 'zh-CN-XiaoxiaoNeural, zh-CN-YunxiNeural, zh-CN-XiaoyiNeural, en-US-JennyNeural', defaultVoice: 'zh-CN-XiaoxiaoNeural' }]
    ];
    const preset = el('select', {}, el('option', { value: '', textContent: '一键套用示例…（模型和音色名以服务商文档为准）' }), PRESETS.map(([name], i) => el('option', { value: i, textContent: name })));
    preset.addEventListener('change', () => {
      if (preset.value === '') return; const p = PRESETS[Number(preset.value)][1];
      provider.value = 'custom'; syncCustom(); baseUrl.value = p.baseUrl; model.value = p.model; voices.value = p.voices; defaultVoice.value = p.defaultVoice;
      info.textContent = '已填入示例；请再填写密钥（自建服务一般不需要），然后先点“测试”。';
    });
    const form = () => ({ enabled: enabled.checked, provider: provider.value, baseUrl: baseUrl.value, ...(apiKey.value ? { apiKey: apiKey.value } : {}), model: model.value, voices: voices.value, defaultVoice: defaultVoice.value, format: format.value, speed: Number(speed.value), dailyChars: Number(dailyChars.value), maxChars: Number(maxChars.value), readCode: readCode.checked, extraParams: extraParams.value });
    body.append(
      el('p', { class: 'team-note', textContent: '接入语音合成模型后，聊天里每条回复旁会出现“🔊 朗读”按钮，顶栏的 🔊 面板可以选音色、语速、自动朗读，并开启“语音通话”（需要同时开启“语音识别”）。同一段文字重复朗读走服务器缓存，不会重复计费。也提供 OpenAI 兼容的 POST /v1/audio/speech 和 /v1/audio/transcriptions 给程序调用。' }),
      el('div', { class: 'team-form' }, el('label', {}, enabled, ' 启用语音朗读'), preset, provider), customBox,
      el('div', { class: 'team-form' }, model, voices, el('label', {}, '默认音色 ', defaultVoice), el('label', {}, '音频格式 ', format), el('label', {}, '默认语速 ', speed),
        el('label', {}, '每人每天字数（0=不限）', dailyChars), el('label', {}, '单次最多 ', maxChars, ' 字'), el('label', {}, readCode, ' 朗读代码块（默认跳过）'), extraParams,
        el('button', { type: 'button', class: 'primary', textContent: '保存', on: { click: async () => { try { await api('/api/admin/tts', { method: 'PUT', body: JSON.stringify(form()) }); err.textContent = ''; apiKey.value = ''; info.textContent = '已保存'; } catch (e) { err.textContent = e.message; } } } }),
        el('button', { type: 'button', class: 'secondary', textContent: '测试（会真实合成一句话，可能产生费用）', on: { click: async () => { info.textContent = '测试中…'; err.textContent = ''; try { const r = await api('/api/admin/tts/test', { method: 'POST', body: JSON.stringify(form()) }); if (r.ok) info.textContent = '测试成功：' + r.ms + ' ms，' + r.mime + '，' + r.bytes + ' 字节'; else { info.textContent = ''; err.textContent = r.error; } } catch (e) { info.textContent = ''; err.textContent = e.message; } } } })),
      info, err,
      el('p', { class: 'team-note', textContent: '提示：只支持 OpenAI 兼容的 /audio/speech 接口（返回音频）。讯飞、火山、阿里等厂商的原生接口格式不同，可通过 OpenAI 兼容的网关或自建的 openai-edge-tts / Kokoro 之类服务接入。用 OpenAI 官方接口时，同样受“环境检测”里的受限地区守卫约束。语音通话的识别部分走“语音识别”里配置的服务。' }));
  }

  // ---- 图片理解（管理员）：哪些模型能直接看图 + 本地/自建识图服务 ----
  async function renderVision(body) {
    const data = await api('/api/admin/vision'), cfg = data.config, err = errBox(), info = el('div', { class: 'team-note' });
    const enabled = el('input', { type: 'checkbox', checked: Boolean(cfg.enabled) });
    const mode = el('select', {}, el('option', { value: 'auto', textContent: '自动：能看图的聊天模型直接看，其余的走识图服务' }), el('option', { value: 'service', textContent: '一律先走识图服务，再把文字交给聊天模型' }));
    mode.value = cfg.mode;
    const dialect = el('select', {}, data.dialects.map(d => el('option', { value: d.id, textContent: d.label }))); dialect.value = cfg.dialect;
    const baseUrl = el('input', { class: 'wide', placeholder: '服务地址，如 http://127.0.0.1:11434/v1（OCR 接口填完整地址）', value: cfg.baseUrl || '', maxLength: 300 });
    const apiKey = el('input', { class: 'wide', type: 'password', autocomplete: 'off', placeholder: cfg.hasKey ? '已保存（' + cfg.keyMask + '），留空表示不修改；本地服务一般不需要' : '密钥（本地服务一般不需要）', maxLength: 500 });
    const model = el('input', { class: 'wide', placeholder: '视觉模型名称，如 qwen2.5vl:7b / llava（OCR 接口不用填）', value: cfg.model || '', maxLength: 200 });
    const textPath = el('input', { placeholder: 'OCR 返回里文字的位置，如 text 或 data.text', value: cfg.textPath || 'text', maxLength: 100, style: 'width:260px' });
    const prompt = el('textarea', { maxLength: 1000, style: 'min-height:64px', placeholder: '让视觉模型怎么描述图片' }); prompt.value = cfg.prompt || data.defaultPrompt;
    const timeoutSec = el('input', { type: 'number', min: 5, max: 600, value: cfg.timeoutSec, style: 'width:90px' });
    const maxImages = el('input', { type: 'number', min: 1, max: 4, value: cfg.maxImages, style: 'width:70px' });
    const maxMb = el('input', { type: 'number', min: 1, max: 20, value: cfg.maxMb, style: 'width:70px' });
    const visionModels = el('textarea', { maxLength: 3000, style: 'min-height:70px', placeholder: '模型名里含这些关键词就认为能直接看图（逗号分隔）' }); visionModels.value = cfg.visionModels;
    const syncDialect = () => { const ocr = dialect.value === 'http-ocr'; model.style.display = ocr ? 'none' : ''; textPath.parentElement.style.display = ocr ? '' : 'none'; };
    const PRESETS = [
      ['Ollama 视觉模型（本机）', { dialect: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5vl:7b' }],
      ['LM Studio（本机）', { dialect: 'openai', baseUrl: 'http://127.0.0.1:1234/v1', model: '填 LM Studio 里加载的视觉模型名' }],
      ['自建 OCR 接口（POST 上传图片，返回 JSON）', { dialect: 'http-ocr', baseUrl: 'http://127.0.0.1:8000/ocr', model: '' }]
    ];
    const preset = el('select', {}, el('option', { value: '', textContent: '一键套用示例…（地址和模型名以你本机服务为准）' }), PRESETS.map(([name], i) => el('option', { value: i, textContent: name })));
    preset.addEventListener('change', () => { if (preset.value === '') return; const p = PRESETS[Number(preset.value)][1]; dialect.value = p.dialect; baseUrl.value = p.baseUrl; model.value = p.model; syncDialect(); info.textContent = '已填入示例。如果 Yumeiro 跑在 Docker 里，把 127.0.0.1 换成 host.docker.internal 或宿主机的局域网地址。'; });
    dialect.addEventListener('change', syncDialect);
    const form = () => ({ enabled: enabled.checked, mode: mode.value, dialect: dialect.value, baseUrl: baseUrl.value, ...(apiKey.value ? { apiKey: apiKey.value } : {}), model: model.value, textPath: textPath.value, prompt: prompt.value, timeoutSec: Number(timeoutSec.value), maxImages: Number(maxImages.value), maxMb: Number(maxMb.value), visionModels: visionModels.value });
    body.append(
      el('p', { class: 'team-note', textContent: '成员在聊天框点回形针图标（或直接粘贴 / 拖入）就能添加图片或文件。图片会让模型分析；文本类文件（txt、md、csv、json、代码等，大小上限跟图片共用下面的“单个图片 / 文件上限”，默认 8 MB、最大 20 MB；一条消息最多 5 个）的内容会交给模型阅读。交给模型的文字量有单独的上限（每个文件约 10 万字、一条消息约 20 万字，超出部分会在提示里标明已省略），要跟模型的上下文长度匹配；上下文很长的模型可在服务器的 .env 里用 DOC_MAX_CHARS / DOC_MAX_TOTAL_CHARS 调大，然后重启。文件不需要识图服务。支持的文件格式：PDF、Word（docx）、Excel（xlsx）、PowerPoint（pptx）、OpenDocument（odt / ods / odp）、EPUB、RTF，以及 txt、md、csv、json、代码等文本文件（中文 GBK 编码的文本也能读）。服务器会先把文字提取出来再交给模型；扫描件 / 图片型 PDF 没有文字可提取，会提示。旧版 Office（.doc / .xls / .ppt）不支持，请另存为新格式。下面是图片的说明：聊天模型本身能看图（如 GPT-4o、Claude、Gemini、Qwen-VL）时，图片会直接发给它；不能看图时，如果这里接了“识图服务”，会先把图片转成文字描述再交给聊天模型。识图服务可以是本机或局域网里的视觉模型（Ollama 等）或 OCR 接口，图片不会离开你的网络。' }),
      el('div', { class: 'team-form' }, el('label', {}, enabled, ' 启用识图服务'), mode, preset, dialect), el('div', { class: 'team-form' }, baseUrl, apiKey, model, el('label', {}, '文字字段 ', textPath), prompt),
      el('div', { class: 'team-form' }, el('label', {}, '超时（秒）', timeoutSec), el('label', {}, '每条消息最多图片数', maxImages), el('label', {}, '单个图片 / 文件上限（MB）', maxMb), visionModels,
        el('button', { type: 'button', class: 'primary', textContent: '保存', on: { click: async () => { try { await api('/api/admin/vision', { method: 'PUT', body: JSON.stringify(form()) }); err.textContent = ''; apiKey.value = ''; info.textContent = '已保存'; } catch (e) { err.textContent = e.message; } } } }),
        el('button', { type: 'button', class: 'secondary', textContent: '测试（用一张自动生成的小图片请求识图服务）', on: { click: async () => { info.textContent = '测试中…'; err.textContent = ''; try { const r = await api('/api/admin/vision/test', { method: 'POST', body: JSON.stringify(form()) }); if (r.ok) info.textContent = '连接成功：' + r.ms + ' ms' + (r.sample ? '；返回：' + r.sample : '（返回内容为空，OCR 接口对无文字图片返回空是正常的）'); else { info.textContent = ''; err.textContent = r.error; } } catch (e) { info.textContent = ''; err.textContent = e.message; } } } })),
      info, err,
      el('p', { class: 'team-note', textContent: '提示：每人每天识图服务默认最多 300 次（环境变量 VISION_DAILY_LIMIT）；图片保存在服务器的 attachments 目录，删除对话时一并删除。较大的图片会让本地模型变慢，建议先缩小。' }));
    syncDialect();
  }

  // ---- 账号安全（管理员）：恢复密钥 + 手机批准“忘记密码”----
  async function renderSecurity(body) {
    if (!document.getElementById('secStyle')) { const st = document.createElement('style'); st.id = 'secStyle'; st.textContent = '.sec-card{border:1px solid var(--line);border-radius:14px;padding:16px;margin:12px 0;display:grid;gap:10px}.sec-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.sec-head h4{margin:0;font-size:16px}.sec-badge{font-size:12px;padding:2px 9px;border-radius:99px;border:1px solid currentColor}.sec-badge.ok{color:#2f9e6b}.sec-badge.off{color:#d98e04}.sec-card p{margin:0}.sec-card input{width:100%;box-sizing:border-box;height:42px;border:1px solid var(--line);border-radius:10px;padding:0 12px;background:transparent;color:var(--ink);min-width:0}.sec-card input.code{text-align:center;font-size:24px;letter-spacing:6px;height:54px}.sec-actions{display:flex;gap:8px;flex-wrap:wrap}.sec-actions>*{flex:1 1 140px;min-height:42px}.sec-card details{font-size:13px;opacity:.85}.sec-card summary{cursor:pointer;padding:2px 0}.sec-card details p{margin-top:6px;line-height:1.6}.sec-tip{font-size:12px;opacity:.75;border-left:3px solid var(--line);padding:2px 0 2px 10px;margin:14px 0 4px;line-height:1.6}@media(max-width:640px){.sec-card{padding:14px;border-radius:12px}.sec-actions>*{flex:1 1 100%}.sec-card input.code{font-size:22px;letter-spacing:5px}}'; document.head.append(st); }
    const err = errBox(), info = el('div', { class: 'team-note' });
    const params = new URLSearchParams(location.search);
    const state = await api('/api/security/recovery');
    // 恢复密钥
    const statusLine = el('p', { class: 'team-note' }), badge = el('span', { class: 'sec-badge off', textContent: '未设置' });
    const paintStatus = s => { badge.className = 'sec-badge ' + (s.hasKey ? 'ok' : 'off'); badge.textContent = s.hasKey ? '已设置' : '未设置'; statusLine.textContent = s.hasKey ? '已设置（' + new Date(s.createdAt).toLocaleString() + '）。恢复密钥只在生成时显示一次，请离线保存。' : '还没有设置恢复密钥。设置后，忘记密码时可以在登录页用它重置密码并登录。'; };
    paintStatus(state);
    const keyPw = el('input', { type: 'password', autocomplete: 'current-password', placeholder: '输入当前密码以确认' });
    const keyOut = el('div');
    const makeKey = el('button', { type: 'button', class: 'primary', textContent: state.hasKey ? '重新生成恢复密钥（旧的立即作废）' : '生成恢复密钥', on: { click: async () => {
      err.textContent = '';
      try {
        const r = await api('/api/security/recovery-key', { method: 'POST', body: JSON.stringify({ password: keyPw.value }) }); keyPw.value = '';
        paintStatus({ hasKey: true, createdAt: r.createdAt }); makeKey.textContent = '重新生成恢复密钥（旧的立即作废）';
        keyOut.replaceChildren(el('div', { class: 'team-note', style: 'color:#e95164', textContent: '⚠ 请现在就保存这把恢复密钥——关闭页面后再也看不到。建议打印或存进密码管理器，不要和管理员密码放在一起。' }),
          el('pre', { style: 'user-select:all;font-size:15px', textContent: r.key }),
          el('div', { class: 'team-form' }, el('button', { type: 'button', class: 'secondary', textContent: '复制', on: { click: async e => { try { await navigator.clipboard.writeText(r.key); e.target.textContent = '已复制'; } catch { e.target.textContent = '请手动复制'; } } } }),
            el('button', { type: 'button', class: 'secondary', textContent: '下载为文本文件', on: { click: () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['Yumeiro 管理员恢复密钥（请离线保存）\
账号：' + (me.email || '') + '\
恢复密钥：' + r.key + '\
生成时间：' + new Date().toLocaleString() + '\
'], { type: 'text/plain;charset=utf-8' })); a.download = 'yumeiro-recovery-key.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); } } })));
      } catch (e) { err.textContent = e.message; }
    } } });
    const delKey = el('button', { type: 'button', class: 'secondary danger', textContent: '删除恢复密钥', on: { click: async () => {
      if (!await ymConfirm('删除后，忘记密码时将不能用恢复密钥重置。确定吗？', { danger: true, okText: '确定' })) return;
      try { await api('/api/security/recovery-key', { method: 'DELETE', body: JSON.stringify({ password: keyPw.value }) }); keyPw.value = ''; paintStatus({ hasKey: false }); keyOut.replaceChildren(); makeKey.textContent = '生成恢复密钥'; err.textContent = ''; } catch (e) { err.textContent = e.message; }
    } } });
    // 手机批准
    const code = el('input', { class: 'code', inputMode: 'numeric', maxLength: 7, placeholder: '6 位验证码', value: params.get('code') || '' });
    const decide = async (value, approve) => {
      err.textContent = '';
      try { const r = await api('/api/security/phone-approve', { method: 'POST', body: JSON.stringify({ code: value, approve }) }); info.textContent = approve ? '✅ 已批准：发起请求的电脑（' + (r.ip || '未知地址') + '）会自动继续。' : '已拒绝这次请求。'; code.value = ''; refresh(); } catch (e) { err.textContent = e.message; }
    };
    const pendingBox = el('div');
    async function refresh() {
      if (!body.isConnected) return clearInterval(poll);
      try {
        const s = await api('/api/security/recovery');
        pendingBox.replaceChildren(...(s.pending.length ? s.pending.map(p => el('div', { class: 'team-row' }, el('div', { class: 'grow' }, el('b', { textContent: p.code.slice(0, 3) + ' ' + p.code.slice(3) }), el('small', { textContent: '　来自 ' + (p.ip || '未知地址') + ' · ' + new Date(p.createdAt).toLocaleTimeString() + (p.ua ? ' · ' + p.ua.slice(0, 50) : '') })), el('button', { type: 'button', class: 'secondary', textContent: '批准', on: { click: () => decide(p.code, true) } }), el('button', { type: 'button', class: 'secondary', textContent: '拒绝', on: { click: () => decide(p.code, false) } }))) : [el('p', { class: 'team-note', textContent: '现在没有待批准的请求。' })]));
      } catch { /* 下一轮再试 */ }
    }
    const poll = setInterval(refresh, 3000); refresh();
    // 版式：两张卡片（恢复密钥 / 手机确认），输入框占满一行，按钮另起一行；窄屏下按钮纵向铺满
    body.append(
      el('p', { class: 'team-note', textContent: me.role === 'admin' ? '忘记密码时有两种办法登录并改密码：恢复密钥，或用一直登录着的手机确认。' : '忘记密码时，可以用一直登录着的手机授权；也可以请管理员帮你重置密码。' }),
      me.role !== 'admin' ? null : el('div', { class: 'sec-card' },
        el('div', { class: 'sec-head' }, el('h4', { textContent: '🔑 恢复密钥' }), badge),
        statusLine,
        keyPw,
        el('div', { class: 'sec-actions' }, makeKey, state.hasKey ? delKey : null),
        keyOut,
        el('details', {}, el('summary', { textContent: '忘记密码时怎么用' }), el('p', { textContent: '在登录页点“管理员忘记密码？”，输入管理员邮箱和恢复密钥，再设置新密码。用过一次后这把密钥立即作废，系统会给你一把新的。多次输错会被临时锁定。' }))),
      el('div', { class: 'sec-card' },
        el('div', { class: 'sec-head' }, el('h4', { textContent: '📱 手机确认' })),
        el('p', { class: 'team-note', textContent: '电脑上点“忘记密码 → 手机授权”会得到 6 位验证码，在一直保持登录的手机上输入并批准，电脑就能直接登录。电脑登录页的“扫码登录”也是同样：用这台手机扫描并确认即可。建议现在就在手机上登录一次并保持登录。' }),
        code,
        el('div', { class: 'sec-actions' }, el('button', { type: 'button', class: 'primary', textContent: '批准', on: { click: () => decide(code.value, true) } }), el('button', { type: 'button', class: 'secondary', textContent: '拒绝', on: { click: () => decide(code.value, false) } })),
        el('h4', { textContent: '待批准的请求', style: 'margin:6px 0 0;font-size:14px' }), pendingBox, info,
        el('details', {}, el('summary', { textContent: '用的是哪种手机？' }), el('p', { textContent: '浏览器、已安装的 PWA 或安卓客户端都可以，只要保持管理员登录；验证码 5 分钟内有效。' }))),
      err,
      el('div', { class: 'sec-tip', textContent: '批准前请确认这是你本人刚刚发起的（看来源地址和时间）；只能由对应的管理员账号批准；所有操作都会记入审计。新密码至少 ' + state.minPassword + ' 个字符。' }));
  }

  async function renderVoice(body) {
    const data = await api('/api/admin/asr'), cfg = data.config || {}, err = errBox(), info = el('div', { class: 'team-note' });
    const enabled = el('input', { type: 'checkbox', checked: Boolean(cfg.enabled) });
    const provider = el('select', {}, el('option', { value: '', textContent: '选择服务商…' }), el('option', { value: 'custom', textContent: '自定义（在本页直接填地址 / 密钥，腾讯云、百度、Azure 等选这个）' }), data.providers.map(p => el('option', { value: p.id, textContent: p.name + (p.baseUrl ? '　' + p.baseUrl : '') })));
    provider.value = cfg.provider === 'custom' || data.providers.some(p => p.id === cfg.provider) ? cfg.provider : '';
    const kind = el('select', {}, (data.kinds || []).map(k => el('option', { value: k.id, textContent: k.label })));
    kind.value = cfg.kind || 'transcriptions';
    const kindHint = el('div', { class: 'team-note' });
    const showHint = () => { const k = (data.kinds || []).find(item => item.id === kind.value); kindHint.textContent = k && k.hint ? '说明：' + k.hint : ''; };
    kind.addEventListener('change', showHint); showHint();
    const baseUrl = el('input', { class: 'wide', placeholder: '接口地址（OpenAI 兼容类才需要），如 https://api.siliconflow.cn/v1 或 http://asr:8000/v1', value: cfg.baseUrl || '', maxLength: 300 });
    const apiKey = el('input', { class: 'wide', type: 'password', autocomplete: 'off', placeholder: cfg.hasKey ? '已保存（' + cfg.keyMask + '），留空表示不修改' : '密钥（腾讯云 / 百度 / Cloudflare 用 “ID:密钥” 的格式）', maxLength: 500 });
    const extraParams = el('textarea', { placeholder: '额外参数（可选，JSON），如 {"region":"eastasia"}', maxLength: 2000, style: 'min-height:56px' });
    extraParams.value = cfg.extraParams || '';
    const customBox = el('div', { class: 'team-form' }, baseUrl, apiKey, extraParams);
    const syncCustom = () => { customBox.style.display = provider.value === 'custom' ? '' : 'none'; };
    provider.addEventListener('change', syncCustom); syncCustom();
    const presetSel = el('select', {}, el('option', { value: '', textContent: '一键套用预设…' }), (data.presets || []).map(p => el('option', { value: p.id, textContent: p.name })));
    const presetNote = el('div', { class: 'team-note' });
    presetSel.addEventListener('change', () => {
      const p = (data.presets || []).find(item => item.id === presetSel.value);
      if (!p) { presetNote.textContent = ''; return; }
      kind.value = p.kind; model.value = p.model || ''; showHint();
      if (p.native || p.baseUrl) { provider.value = 'custom'; baseUrl.value = p.baseUrl || ''; syncCustom(); }
      presetNote.textContent = p.note + (p.keyUrl ? '　申请密钥：' + p.keyUrl : '') + (p.baseUrl && !p.native ? '　（OpenAI 兼容类也可以在“AI 接入”里添加后选择它，密钥只存一处）' : '');
    });
    const model = el('input', { class: 'wide', placeholder: '模型名，如 whisper-1 / FunAudioLLM/SenseVoiceSmall / qwen3-asr-flash', value: cfg.model || '', maxLength: 200 });
    const defaultLang = el('select', {}, data.languages.map(l => el('option', { value: l.id, textContent: l.label + (l.group === '方言' ? '（方言）' : '') })));
    defaultLang.value = cfg.defaultLang || 'auto';
    const hotwords = el('textarea', { placeholder: '热词（可选）：公司名、产品名、人名、行业术语，用逗号或空格分隔，最多 500 字。会作为提示发给模型，提高专有名词的准确率。', maxLength: 500, style: 'min-height:70px' });
    hotwords.value = cfg.hotwords || '';
    const maxSeconds = el('input', { type: 'number', min: 5, max: 120, value: cfg.maxSeconds || 60, style: 'width:90px' });
    const payload = () => ({ enabled: enabled.checked, provider: provider.value, baseUrl: baseUrl.value.trim(), apiKey: apiKey.value, extraParams: extraParams.value, kind: kind.value, model: model.value.trim(), defaultLang: defaultLang.value, hotwords: hotwords.value, maxSeconds: Number(maxSeconds.value) });
    const save = async () => { err.textContent = ''; info.textContent = ''; try { await api('/api/admin/asr', { method: 'PUT', body: JSON.stringify(payload()) }); info.textContent = '已保存。成员刷新页面后，聊天输入框旁会出现麦克风按钮。'; } catch (e) { err.textContent = e.message; } };
    const test = async () => {
      err.textContent = ''; info.textContent = '正在测试…';
      try { const p = payload(), r = await api('/api/admin/asr/test', { method: 'POST', body: JSON.stringify({ provider: p.provider, kind: p.kind, model: p.model, baseUrl: p.baseUrl, apiKey: p.apiKey, extraParams: p.extraParams }) }); info.textContent = ''; if (r.ok) info.textContent = '✓ ' + r.detail + '（' + r.ms + ' 毫秒）'; else err.textContent = '✗ ' + r.detail; }
      catch (e) { info.textContent = ''; err.textContent = e.message; }
    };
    body.append(
      el('p', { class: 'team-note', textContent: '成员在聊天框点麦克风说话，浏览器把录音转成 16kHz 的 WAV 发给本站，本站再转给你选的语音识别服务，识别出的文字填进输入框。录音不会保存在服务器上。密钥复用“AI 接入”里已加密保存的那一份。麦克风只能在 HTTPS 或 localhost 下使用。' }),
      el('div', { class: 'team-form' },
        el('label', { class: 'wide' }, enabled, ' 开启语音识别（成员可见麦克风按钮）'),
        el('label', { class: 'wide' }, '预设　', presetSel), presetNote,
        el('label', { class: 'wide' }, '服务商　', provider), customBox,
        el('label', { class: 'wide' }, '接口类型　', kind), kindHint,
        model,
        el('label', { class: 'wide' }, '默认语言　', defaultLang),
        hotwords,
        el('label', { class: 'wide' }, '单次录音上限　', maxSeconds, ' 秒'),
        el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' }, el('button', { type: 'button', class: 'primary', textContent: '保存', on: { click: save } }), el('button', { type: 'button', class: 'secondary', textContent: '测试连接', on: { click: test } }))),
      info, err,
      el('h3', { textContent: '方言怎么识别' }),
      el('p', { class: 'team-note', textContent: '成员在麦克风旁的下拉框里选择自己说的话：普通话、粤语、四川话、闽南语、吴语、东北话、河南话等（见列表）。选中的语言会随录音一起发给模型：粤语 / 英语 / 日语 / 韩语会带上语言代码，其他方言写进提示词。能不能听懂方言，最终取决于你选的模型——不同模型差别很大：通用的 Whisper 对粤语还行、对其他方言一般；SenseVoice 主打普通话 / 粤语；阿里云百炼的千问语音识别（qwen3-asr-flash）厂商宣称覆盖多种中文方言——这些都是厂商说法，我没有逐个实测。选“自动识别”时由模型自己判断。建议先用“测试连接”确认服务可用，再让说方言的同事用真实录音试几个模型，挑效果最好的。' }));
  }
  // ---- 可视化仪表盘：审计 + 用量数据的图表，支持导出和深色主题 ----
  const SOURCE_NAMES = { web: '网页聊天', api: '接口调用', bot: '机器人', workspace: '工作区', memory: '记忆整理', 'image-prompt': '绘画提示词优化', image: '绘画', tts: '语音朗读', guide: '使用指引', vision: '图片识别', asr: '语音识别', agent: '智能体' };
  async function renderDashboard(body) {
    const C = window.yumeiroCharts, err = errBox(), root = el('div', { class: 'gs-dash' });
    if (!C) { body.append(el('div', { class: 'team-err', textContent: '图表组件没有加载，请刷新页面（Ctrl+F5）。' })); return; }
    const days = el('select', {}, [7, 30, 90].map(n => el('option', { value: n, textContent: '最近 ' + n + ' 天', selected: n === 30 })));
    const email = el('input', { placeholder: '按账号邮箱筛选（留空=全部）', hidden: !(me && me.role === 'admin' && pageMode === 'admin'), style: 'min-width:200px' });
    const themeBtn = el('button', { type: 'button', class: 'secondary', on: { click: () => { window.yumeiroTheme && window.yumeiroTheme.set(window.yumeiroTheme.next()); } } });
    const stamp = () => new Date().toISOString().slice(0, 10);
    let data = null; const svgs = [];
    const csvOf = (rows, columns, name) => C.download(new Blob([C.toCsv(rows, columns)], { type: 'text/csv;charset=utf-8' }), `yumeiro-${name}-${stamp()}.csv`);
    const card = (title, svg, { wide, csv, png }) => {
      svgs.push([png, svg]);
      return el('div', { class: 'gs-card' + (wide ? ' wide' : '') }, el('h4', {}, el('span', { class: 'grow', textContent: title }),
        csv ? el('button', { type: 'button', class: 'gs-mini', textContent: 'CSV', title: '导出这张图的数据', on: { click: csv } }) : null,
        el('button', { type: 'button', class: 'gs-mini', textContent: 'PNG', title: '导出图片', on: { click: () => C.svgToPng(svg, `yumeiro-${png}-${stamp()}.png`) } }),
        el('button', { type: 'button', class: 'gs-mini', textContent: 'SVG', title: '导出矢量图', on: { click: () => C.svgDownload(svg, `yumeiro-${png}-${stamp()}.svg`) } })), svg);
    };
    const draw = () => {
      if (!data) return;
      svgs.length = 0;
      const cat = data.categories, keys = Object.keys(cat).map(key => ({ key, label: cat[key] })), t = data.totals, n = C.num;
      const kpi = (label, value, bad) => el('div', { class: 'gs-kpi' + (bad ? ' bad' : '') }, el('b', { textContent: n(value) }), el('span', { textContent: label }));
      themeBtn.textContent = '主题：' + ({ auto: '跟随系统', light: '浅色', dark: '深色' })[window.yumeiroTheme ? window.yumeiroTheme.get() : 'auto'];
      const models = data.byModel.map(m => ({ label: m.model, value: m.calls })), tokenModels = data.byModel.filter(m => m.tokens).map(m => ({ label: m.model, value: m.tokens }));
      root.replaceChildren(
        el('div', { class: 'team-note', textContent: `统计区间 ${data.from} – ${data.to}。按天的操作计数保留 90 天；模型/Token 来自最近一批调用明细（最多 1 万条）${data.isAdmin ? '' : '；你只能看到自己的数据'}。` }),
        el('div', { class: 'gs-kpis' }, kpi('操作总数', t.operations), kpi('模型调用', t.calls), kpi('Token 消耗', t.tokens), kpi('文件操作', t.fileOps), kpi('删除与清理', t.deletes), kpi('失败/拒绝', t.failures, t.failures > 0)),
        el('div', { class: 'gs-grid' },
          card('每日操作（按类别）', C.stacked({ rows: data.series, keys }), { wide: true, png: 'daily-ops', csv: () => csvOf(data.series, [{ key: 'day', label: '日期' }, ...keys.map(k => ({ key: k.key, label: k.label })), { key: 'tokens', label: 'Token' }], 'daily') }),
          card('每日 Token 消耗', C.line({ rows: data.series, key: 'tokens', label: 'Token', color: 1, width: 420, height: 170 }), { png: 'daily-tokens' }),
          card('24 小时调用分布', C.hours({ values: data.hours, width: 420 }), { png: 'hours', csv: () => csvOf(data.hours.map((v, i) => ({ hour: i + ':00', calls: v })), [{ key: 'hour', label: '时段' }, { key: 'calls', label: '调用次数' }], 'hours') }),
          card('模型占比（按调用次数）', C.donut({ items: models.slice(0, 6) }), { png: 'models', csv: () => csvOf(data.byModel, [{ key: 'model', label: '模型' }, { key: 'calls', label: '调用' }, { key: 'tokens', label: 'Token' }], 'models') }),
          card('调用来源', C.donut({ items: data.bySource.map(s => ({ label: SOURCE_NAMES[s.source] || s.source, value: s.calls })) }), { png: 'sources' }),
          card('Token 排行（按模型）', C.hbar({ items: tokenModels.slice(0, 8), width: 420 }), { png: 'tokens-by-model' }),
          card('热门操作', C.hbar({ items: data.byAction.slice(0, 10).map(a => ({ label: actionName(a.action), value: a.count })), width: 420, color: 3 }), { png: 'actions', csv: () => csvOf(data.byAction.map(a => ({ ...a, name: actionName(a.action) })), [{ key: 'action', label: '动作代码' }, { key: 'name', label: '动作' }, { key: 'count', label: '次数' }], 'actions') }),
          data.isAdmin ? card('账号活跃度（调用 + 操作）', C.hbar({ items: data.users.slice(0, 10).map(u => ({ label: u.email, value: u.calls + u.total })), width: 420, color: 4 }), { png: 'users', csv: () => csvOf(data.users, [{ key: 'email', label: '账号' }, { key: 'calls', label: '模型调用' }, { key: 'total', label: '其他操作' }, { key: 'tokens', label: 'Token' }], 'users') }) : null)
      );
    };
    const load = async () => {
      try { const params = new URLSearchParams({ days: days.value }); if (email.value.trim()) params.set('email', email.value.trim()); data = await api('/api/dashboard?' + params); err.textContent = ''; draw(); } catch (e) { err.textContent = e.message; }
    };
    const onTheme = () => { if (!body.isConnected) document.removeEventListener('yumeiro-theme', onTheme); else draw(); };
    document.addEventListener('yumeiro-theme', onTheme);
    days.addEventListener('change', load); email.addEventListener('keydown', e => { if (e.key === 'Enter') load(); });
    const exportAll = () => { svgs.forEach(([name, svg], i) => setTimeout(() => C.svgToPng(svg, `yumeiro-${name}-${stamp()}.png`), i * 350)); };
    body.append(el('div', { class: 'gs-bar' }, days, email, el('button', { type: 'button', class: 'secondary', textContent: '刷新', on: { click: load } }), themeBtn,
      el('span', { style: 'flex:1' }),
      el('button', { type: 'button', class: 'secondary', textContent: '导出 JSON', on: { click: () => data && C.download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `yumeiro-dashboard-${stamp()}.json`) } }),
      el('button', { type: 'button', class: 'secondary', textContent: '导出全部图表 PNG', on: { click: exportAll } }),
      el('button', { type: 'button', class: 'secondary', textContent: '打印 / 存为 PDF', on: { click: () => window.print() } })), err, root);
    await load();
  }

  // ---- 审计与统计：成员看自己的，主账号看全部并可导出 CSV ----
  const ACTION_NAMES = { 'file.write': '保存文件', 'file.delete': '删除文件', 'file.restore': '还原版本', 'expiry.delete': '过期清理删除', 'expiry.skip': '过期清理跳过', 'expiry.policy': '修改清理规则', 'workspace.create': '新建工作区', 'workspace.delete': '删除工作区', 'engine.run': '运行引擎', 'guard.block': '防封拒绝', 'env.risk': '环境风险变化', 'settings.guard': '修改防封设置', 'audit.export': '导出审计', login_success: '登录成功', login_failed: '登录失败' };
  const actionName = a => ACTION_NAMES[a] || (a.startsWith('call.') ? '模型调用·' + a.slice(5) : a);
  async function renderAudit(body) {
    const err = errBox(), summaryBox = el('div', {}), listBox = el('div', {});
    const days = el('select', {}, [7, 30, 90].map(n => el('option', { value: n, textContent: '最近 ' + n + ' 天', selected: n === 30 })));
    const category = el('select', {}, el('option', { value: '', textContent: '全部类别' }));
    const email = el('input', { placeholder: '按账号邮箱筛选', hidden: true }), q = el('input', { placeholder: '搜索文件名 / 对象 / 详情' });
    const okSel = el('select', {}, [['', '全部结果'], ['false', '仅失败'], ['true', '仅成功']].map(([v, t]) => el('option', { value: v, textContent: t })));
    const csv = el('a', { class: 'secondary', textContent: '导出 CSV', hidden: true, style: 'padding:6px 10px;border:1px solid var(--line);border-radius:8px;text-decoration:none' });
    const fmtT = t => new Date(t).toLocaleString();
    const load = async () => {
      try {
        const params = new URLSearchParams({ limit: '200' }); if (category.value) params.set('category', category.value); if (email.value.trim()) params.set('email', email.value.trim()); if (q.value.trim()) params.set('q', q.value.trim()); if (okSel.value) params.set('ok', okSel.value);
        const [s, l] = await Promise.all([api('/api/audit/summary?days=' + days.value), api('/api/audit?' + params)]);
        if (!category.options[1]) for (const [id, label] of Object.entries(l.categories)) category.append(el('option', { value: id, textContent: label }));
        email.hidden = !l.isAdmin; csv.hidden = !l.isAdmin; csv.href = '/api/admin/audit.csv?' + params;
        const max = Math.max(1, ...s.series.map(x => x.total));
        const bars = el('div', { style: 'display:flex;align-items:flex-end;gap:2px;height:60px;margin:8px 0' }, s.series.map(x => el('div', { title: x.day + '：' + x.total + ' 次', style: `flex:1;min-width:2px;background:var(--accent);opacity:.75;border-radius:2px 2px 0 0;height:${Math.max(2, Math.round(x.total / max * 60))}px` })));
        const cat = l.categories;
        summaryBox.replaceChildren(el('div', { class: 'team-note', textContent: '每日操作次数（' + days.value + ' 天）' }), bars,
          s.users.length ? el('table', { style: 'width:100%;border-collapse:collapse;font-size:13px' },
            el('tr', {}, ['账号', '总次数', ...Object.values(cat), '本月调用', '本月 Token', '最近活动'].map(h => el('th', { style: 'text-align:left;padding:4px 6px;border-bottom:1px solid var(--line)', textContent: h }))),
            ...s.users.map(u => el('tr', {}, [u.email, u.total, ...Object.keys(cat).map(k => u.byCategory[k] || 0), u.monthCalls ?? 0, u.monthTokens ?? 0, u.lastAt ? fmtT(u.lastAt) : '—'].map(v => el('td', { style: 'padding:4px 6px;border-bottom:1px solid var(--line)', textContent: String(v) }))))) : el('p', { class: 'team-note', textContent: '这段时间还没有记录。' }));
        listBox.replaceChildren(l.entries.length ? el('table', { style: 'width:100%;border-collapse:collapse;font-size:12px' },
          el('tr', {}, ['时间', '账号', '动作', '对象', '详情', '结果'].map(h => el('th', { style: 'text-align:left;padding:4px 6px;border-bottom:1px solid var(--line)', textContent: h }))),
          ...l.entries.map(e => el('tr', { style: e.ok ? '' : 'color:#c0392b' }, [fmtT(e.at), e.email || '系统', actionName(e.action), e.target, e.detail, e.ok ? '成功' : '失败'].map((v, i) => el('td', { style: 'padding:4px 6px;border-bottom:1px solid var(--line);word-break:break-all;' + (i === 4 ? 'max-width:260px' : ''), textContent: String(v ?? '') }))))) : el('p', { class: 'team-note', textContent: '没有符合条件的记录。' }));
        err.textContent = '';
      } catch (e) { err.textContent = e.message; }
    };
    for (const control of [days, category, okSel]) control.addEventListener('change', load);
    for (const control of [email, q]) control.addEventListener('keydown', e => { if (e.key === 'Enter') load(); });
    body.append(el('p', { class: 'team-note', textContent: '这里记录谁在什么时候做了什么：模型调用、保存/删除/还原文件、过期清理、登录与管理操作。明细保留最近一批，每日计数保留 90 天；成员只能看到自己的记录。' }),
      el('div', { class: 'gs-bar' }, days, category, okSel, email, q, el('button', { type: 'button', class: 'secondary', textContent: '查询', on: { click: load } }), csv), err, summaryBox, el('h4', { textContent: '明细' }), listBox);
    await load();
  }

  // ---- 服务器体检：一键检查服务器自身与外部连通性（只读）----
  async function renderDoctor(body) {
    const err = errBox(), out = el('div', {}), status = el('span', { class: 'team-note' });
    const deep = el('input', { type: 'checkbox' });
    const COLORS = { ok: '#2f9e6b', warn: '#d98e04', fail: '#c0392b', info: '#8a8f98' }, LABELS = { ok: '正常', warn: '注意', fail: '处理', info: '信息' };
    const badge = level => el('span', { textContent: LABELS[level] || level, style: `display:inline-block;min-width:34px;text-align:center;padding:1px 8px;border-radius:10px;color:#fff;font-size:12px;background:${COLORS[level] || '#888'}` });
    let last = null, busy = false;
    const draw = () => {
      const r = last, s = r.summary;
      const groups = [...new Set(r.checks.map(c => c.group))];
      out.replaceChildren(
        el('div', { style: 'border:1px solid var(--line);border-radius:10px;padding:10px;margin:8px 0;display:flex;gap:10px;align-items:center;flex-wrap:wrap' },
          badge(s.level), el('strong', { textContent: { ok: '一切正常', warn: '有需要注意的项目', fail: '有需要处理的问题' }[s.level] }),
          el('span', { class: 'team-note', textContent: `正常 ${s.ok} · 注意 ${s.warn} · 处理 ${s.fail} · 信息 ${s.info}` })),
        ...groups.map(group => el('div', { style: 'margin:10px 0' }, el('h4', { textContent: group, style: 'margin:6px 0' }),
          ...r.checks.filter(c => c.group === group).map(c => el('div', { style: 'display:flex;gap:8px;align-items:flex-start;padding:5px 0;border-bottom:1px solid var(--line)' }, badge(c.level),
            el('div', { style: 'flex:1;min-width:0' }, el('div', {}, el('strong', { textContent: c.title }), el('span', { textContent: '　' + c.detail, style: 'word-break:break-all' })),
              c.hint && c.level !== 'ok' ? el('div', { class: 'team-note', textContent: '建议：' + c.hint }) : null))))));
      status.textContent = '检测于 ' + new Date(r.at).toLocaleTimeString();
    };
    const run = async () => {
      if (busy) return; busy = true; status.textContent = '正在检测…（含网络探测，最长约十几秒）';
      try { last = await api('/api/admin/doctor' + (deep.checked ? '?deep=1' : '')); draw(); err.textContent = ''; } catch (e) { err.textContent = e.message; status.textContent = ''; } finally { busy = false; }
    };
    const copy = async () => {
      if (!last) return;
      try { await navigator.clipboard.writeText(last.report); status.textContent = '报告已复制，可以直接发给运维或贴到工单里'; }
      catch { const box = el('textarea', { value: last.report, style: 'width:100%;height:240px;font-family:monospace;font-size:12px' }); out.prepend(box); box.select(); status.textContent = '浏览器不允许自动复制，请手动复制上面的文字'; }
    };
    body.append(el('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:8px 0' }, el('button', { type: 'button', class: 'secondary', textContent: '开始体检', on: { click: run } }),
        el('label', { style: 'font-size:13px' }, deep, ' 深度检测（逐个测试已启用的 AI 服务商地址）'),
        el('button', { type: 'button', class: 'secondary', textContent: '复制报告', on: { click: copy } }), status), err, out);
    await run();
  }

  // ---- 环境检测：网络、出口、地区、风险与防封守卫 ----
  async function renderEnv(body) {
    const err = errBox(), live = el('div', {}), form = el('div', {}), status = el('span', { class: 'team-note' });
    const COLORS = { ok: '#2f9e6b', warn: '#d98e04', danger: '#c0392b' }, LABELS = { ok: '正常', warn: '注意', danger: '高风险' };
    const badge = level => el('span', { textContent: LABELS[level] || level, style: `display:inline-block;align-self:flex-start;width:fit-content;padding:1px 8px;border-radius:10px;color:#fff;font-size:12px;background:${COLORS[level] || '#888'}` });
    let data = null, timer = null, busy = false;
    // 检测频率由使用者选择（保存在本浏览器里）；默认 5 分钟，也可以只手动检测
    const EVERY = [[0, '仅手动'], [60, '1 分钟'], [300, '5 分钟'], [900, '15 分钟'], [1800, '30 分钟'], [3600, '1 小时']];
    const everySec = () => { const v = Number(localStorage.getItem('envCheckEvery')); return EVERY.some(x => x[0] === v) && localStorage.getItem('envCheckEvery') !== null ? v : 300; };
    const everyLabel = () => EVERY.find(x => x[0] === everySec())[1];
    // 系统综合研判：把 Cloudflare、ip-api、CleanIP、连通性探测、用量统计合成一个分数，并列出每一项依据
    const verdictCard = r => {
      const v = r.verdict, c = r.cleanip;
      if (!v) return null;
      const lines = [];
      if (c && c.ok) lines.push(el('div', { style: 'font-size:12px;margin-top:6px' }, 'CleanIP：' + (c.score !== null ? '纯净度 ' + c.score + (c.grade ? '（' + c.grade + '）' : '') : '无纯净度数据') + (c.type ? ' · ' + c.type : '') + (c.flags.length ? ' · 标记：' + c.flags.join('、') : '') + (c.reportUrl ? '　' : ''), c.reportUrl ? el('a', { href: c.reportUrl, target: '_blank', rel: 'noopener noreferrer', textContent: '完整报告' }) : null));
      else if (c && c.error) lines.push(el('div', { style: 'font-size:12px;margin-top:6px;color:' + COLORS.warn, textContent: 'CleanIP 暂不可用：' + c.error + '（本次综合研判只用了本地信号）' }));
      return el('div', { style: 'border:1px solid var(--line);border-radius:10px;padding:10px;margin:8px 0' },
        el('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' }, el('strong', { textContent: '综合研判' }), badge(v.level), el('span', { style: 'font-size:22px;font-weight:700', textContent: v.score }), el('span', { class: 'team-note', textContent: '/ 100 · 等级 ' + v.grade }), el('span', { textContent: v.summary })),
        el('div', { class: 'team-note', textContent: '依据来源：' + v.sources.join('、') + (c && c.ok && c.score !== null ? '' : '（未接入 CleanIP 时只用本地信号）') }),
        ...lines,
        ...v.factors.map(f => el('div', { style: 'font-size:13px', textContent: '• [' + f.source + '] ' + f.text + (f.delta ? '（' + f.delta + '）' : '') })),
        v.factors.length ? null : el('div', { style: 'font-size:13px;color:' + COLORS.ok, textContent: '• 没有发现扣分项' }));
    };
    const draw = () => {
      const r = data.result;
      if (!r) { live.replaceChildren(el('p', { class: 'team-note', textContent: '正在检测网络、出口 IP 和地区…（首次检测最长约 10 秒）' })); status.textContent = ''; setTimeout(() => poll(true), 2500); return; }
      const e = r.egress || {};
      live.replaceChildren(
        el('div', { class: 'team-row' }, el('div', { class: 'grow' }, '服务器出口：' + (e.ip || '未知') + (e.country ? '　地区 ' + e.country : '') + (e.isp ? '　' + e.isp : ''), el('small', { textContent: (e.hosting ? '数据中心/托管 IP　' : '') + (e.proxy ? '被识别为代理/VPN　' : '') + (r.proxy ? '出口代理 ' + r.proxy : '未使用出口代理') + (e.error ? '　（' + e.error + '）' : '') })), badge(r.level)),
        verdictCard(r),
        ...Object.entries(r.vendors).map(([id, v]) => el('div', { style: 'border:1px solid var(--line);border-radius:10px;padding:10px;margin:8px 0' },
          el('div', { style: 'display:flex;gap:8px;align-items:center' }, el('strong', { textContent: v.name }), badge(v.level), v.block ? el('span', { textContent: '已开启拒绝：新请求会被拦下', style: 'color:#c0392b;font-size:12px' }) : null),
          el('div', { style: 'display:flex;flex-wrap:wrap;gap:12px;margin:6px 0;font-size:12px' }, v.probes.map(p => el('span', { style: 'color:' + (p.reachable ? (p.challenged ? COLORS.warn : COLORS.ok) : COLORS.danger), textContent: `${p.label}：${p.reachable ? 'HTTP ' + p.status + ' · ' + p.ms + ' ms' + (p.challenged ? '（被挑战）' : '') : '不通 ' + (p.error || '')}` }))),
          ...v.reasons.map(x => el('div', { style: 'font-size:13px;color:' + COLORS[x.level], textContent: '• ' + x.text })),
          v.advice.length ? el('div', { class: 'team-note', style: 'margin-top:6px' }, el('strong', { textContent: '建议：' }), ...v.advice.map(a => el('div', { textContent: '– ' + a }))) : null,
          v.engine ? el('div', { class: 'team-note', textContent: `最近 1 小时引擎调用 ${data.usage[id].lastHour} 次 · 当前并发 ${data.usage[id].concurrent} · 24 小时内 ${data.usage[id].users24h} 个账号使用` }) : null)));
      status.textContent = '最后检测 ' + new Date(r.at).toLocaleTimeString() + (everySec() ? '（每 ' + everyLabel() + ' 自动检测一次）' : '（已设为手动检测）');
    };
    const poll = async fresh => {
      if (busy || !body.isConnected) return; busy = true;
      try { data = await api('/api/admin/env' + (fresh ? '?fresh=1' : '')); draw(); err.textContent = ''; } catch (e) { err.textContent = e.message; } finally { busy = false; }
    };
    const g = (await api('/api/admin/env')).guard;
    const enabled = el('input', { type: 'checkbox', checked: g.enabled }), restricted = el('input', { class: 'wide', value: g.restricted.join(', '), placeholder: '受限地区代码，如 CN, HK, RU' });
    const hourly = el('input', { type: 'number', min: 1, value: g.hourlyLimit, style: 'width:120px' }), conc = el('input', { type: 'number', min: 1, value: g.maxConcurrent, style: 'width:120px' });
    const proxy = el('input', { class: 'wide', type: 'password', autocomplete: 'off', placeholder: g.hasProxy ? '已配置：' + g.proxyUrl + '（留空不修改）' : '出口代理，如 http://127.0.0.1:7890（可选）' });
    const cleanip = el('input', { class: 'wide', type: 'password', autocomplete: 'off', placeholder: g.hasCleanipKey ? '已配置：' + g.cleanipKey + '（留空不修改）' : 'CleanIP 密钥（cip_ 开头，可选；在 cleanip.io/account 免费创建）' });
    const cleanipOn = el('input', { type: 'checkbox', checked: g.cleanipEnabled });
    const save = async clear => {
      try { await api('/api/admin/env/guard', { method: 'PUT', body: JSON.stringify({ enabled: enabled.checked, restricted: restricted.value, hourlyLimit: Number(hourly.value), maxConcurrent: Number(conc.value), cleanipEnabled: cleanipOn.checked, ...(clear === 'cleanip' ? { clearCleanipKey: true } : cleanip.value ? { cleanipKey: cleanip.value } : {}), ...(clear === true ? { clearProxy: true } : proxy.value ? { proxyUrl: proxy.value } : {}) }) }); proxy.value = ''; cleanip.value = ''; err.textContent = ''; status.textContent = '已保存'; poll(true); } catch (e) { err.textContent = e.message; }
    };
    form.append(el('h4', { textContent: '防封守卫设置' }),
      el('div', { class: 'team-note', textContent: '本站只负责接入各家模型的 API。所在地区不被官方支持时，会直接告知“该地区暂不支持，此处暂不可用”并不再发出请求；调用过密、并发过高时同样会先拒绝。受限地区清单仅供参考，请以各家官方“支持的国家和地区”页面为准。' }),
      el('div', { class: 'team-form' }, el('label', {}, enabled, ' 启用拒绝'), restricted, el('label', {}, '引擎每小时上限 ', hourly), el('label', {}, '引擎并发上限 ', conc), proxy,
        el('div', { class: 'team-note', style: 'margin-top:10px' }, el('strong', { textContent: 'CleanIP 纯净度检测（可选）' }),
          el('div', { textContent: '为什么需要：官方服务对出口 IP 的信誉比较敏感，共享机房 IP、VPN / 代理 IP 可能被要求额外验证或限流。内置检测只能粗略判断“是不是机房 / 代理”；CleanIP 会给出 0–100 的纯净度评分和 IP 类型，让上面的“综合研判”更准。它只用于提示，不影响是否放行请求。' }),
          el('div', { textContent: '怎么用：到 cleanip.io/account 免费注册并创建密钥（cip_ 开头，免费账号每天 20 个不同 IP），填在下面，再勾选启用。不用它完全不影响使用，综合研判只用本地信号。' }),
          el('div', { textContent: '隐私：启用并填了密钥后，会把服务器的出口 IP 发给 cleanip.io；没填密钥或没勾选时不会发任何请求。' }),
          el('div', { style: 'color:' + (g.cleanipEnabled && g.hasCleanipKey ? COLORS.ok : g.cleanipEnabled ? COLORS.warn : 'inherit'), textContent: '当前状态：' + (g.cleanipEnabled ? (g.hasCleanipKey ? '已启用，密钥 ' + g.cleanipKey : '安装时选择了启用，还差填写你自己的 CleanIP 密钥') : '未启用') })),
        el('label', {}, cleanipOn, ' 启用 CleanIP（免费账号每天 20 个不同 IP，同一出口 6 小时内只查一次）'), cleanip,
        el('button', { type: 'button', class: 'primary', textContent: '保存', on: { click: () => save(false) } }), g.hasProxy ? el('button', { type: 'button', class: 'secondary', textContent: '清除出口代理', on: { click: () => save(true) } }) : null, g.hasCleanipKey ? el('button', { type: 'button', class: 'secondary', textContent: '清除 CleanIP 密钥', on: { click: () => save('cleanip') } }) : null));
    const everySelect = el('select', { on: { change: () => { localStorage.setItem('envCheckEvery', everySelect.value); restartTimer(); if (data?.result) draw(); } } }, EVERY.map(([v, t]) => el('option', { value: v, textContent: t, selected: v === everySec() })));
    body.append(el('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' }, el('button', { type: 'button', class: 'secondary', textContent: '立即检测', on: { click: () => poll(true) } }), el('label', { style: 'font-size:13px' }, '自动检测间隔 ', everySelect), status), err, live, form,
      el('div', { class: 'team-note', textContent: '提示：Claude Code / Codex 的“订阅账号登录”与“官方 API Key”不同——多人共用同一个个人订阅账号通常不符合服务条款；团队使用请让每人用自己的账号，或统一使用官方 API Key。' }));
    poll(false);
    const restartTimer = () => { clearInterval(timer); timer = everySec() ? setInterval(() => { if (!body.isConnected) clearInterval(timer); else poll(true); }, everySec() * 1000) : null; };
    restartTimer();
  }

  // ---- 一键更新：服务器自己从 GitHub 下载安装包 → 验官方签名 → 备份、替换、重启；这里用监视框显示每一步 ----
  function openUpdateMonitor(from, to) {
    const STEPS = [['download', '下载安装包'], ['verify', '校验官方签名'], ['install', '备份并替换程序'], ['restart', '重启并检查服务'], ['done', '完成']];
    const icons = {}, rowEls = {};
    const list = el('ul', { style: 'list-style:none;margin:10px 0;padding:0' }, STEPS.map(([k, t]) => {
      icons[k] = el('span', { style: 'width:1.4em;text-align:center;flex:none', textContent: '○' });
      return rowEls[k] = el('li', { style: 'display:flex;gap:8px;align-items:center;padding:3px 0;opacity:.55' }, icons[k], el('span', { textContent: t }));
    }));
    const bar = el('progress', { max: 100, value: 0, hidden: true, style: 'width:100%' }), note = el('div', { class: 'team-note', textContent: '请不要关闭服务器。更新期间页面可能打不开一两分钟，这是正常的。' });
    const logBox = el('pre', { class: 'team-code', hidden: true, style: 'max-height:160px;overflow:auto;font-size:12px;white-space:pre-wrap' });
    const msg = el('div', { style: 'font-weight:650;margin-top:6px' });
    const actions = el('div', { style: 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px' });
    const closeBtn = el('button', { type: 'button', class: 'secondary', textContent: '关闭（更新不会中断）' });
    const back = el('div', { role: 'dialog', 'aria-modal': 'true', style: 'position:fixed;inset:0;z-index:2147483250;background:#10121a88;display:grid;place-items:center;padding:16px' },
      el('div', { style: 'width:min(480px,100%);max-height:88vh;overflow:auto;background:var(--ym-card,#fff);color:var(--ink,#252832);border:1px solid var(--line,#e7e8ec);border-radius:16px;padding:20px;box-shadow:0 20px 60px #0006' },
        el('h3', { style: 'margin:0', textContent: `更新到 ${to}（当前 ${from}）` }), list, bar, msg, note, logBox, actions));
    actions.append(closeBtn); document.body.append(back);
    closeBtn.addEventListener('click', () => back.remove());
    const keys = STEPS.map(([k]) => k);
    const mark = (k, state) => { const ic = state === 'done' ? '✓' : state === 'error' ? '✗' : state === 'active' ? '●' : '○'; icons[k].textContent = ic; rowEls[k].style.opacity = state === 'todo' ? '.55' : '1'; rowEls[k].style.color = state === 'error' ? '#d33a4a' : state === 'done' ? 'var(--ok,#2f9e5b)' : ''; };
    let current = '';
    return {
      step(k) { current = k; const i = keys.indexOf(k); keys.forEach((x, j) => mark(x, j < i ? 'done' : j === i ? 'active' : 'todo')); bar.hidden = k !== 'download'; },
      progress(got, total) { bar.hidden = false; if (total) { bar.value = Math.min(100, got / total * 100); msg.textContent = `已下载 ${(got / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`; } else msg.textContent = `已下载 ${(got / 1048576).toFixed(1)} MB`; },
      text(t) { msg.textContent = t; },
      log(t) { if (t) { logBox.textContent = t; logBox.hidden = false; logBox.scrollTop = logBox.scrollHeight; } },
      done(text) { keys.forEach(k => mark(k, 'done')); bar.hidden = true; msg.textContent = text; note.textContent = ''; closeBtn.textContent = '稍后刷新'; actions.prepend(el('button', { type: 'button', class: 'primary', textContent: '立即刷新页面', on: { click: () => location.reload() } })); },
      fail(text) { if (current) mark(current, 'error'); bar.hidden = true; msg.textContent = text; msg.style.color = '#d33a4a'; note.textContent = ''; closeBtn.textContent = '关闭'; },
    };
  }
  async function installLatestUpdate(info) {
    if (!info?.asset) { ymAlert('发布页里没有找到服务端安装包（Yumeiro-x.y.z.zip），请到发布页手动下载后在“服务更新”页上传。'); return; }
    return installUpdate({ from: info.currentVersion, version: info.latestVersion, variant: 'server', size: info.asset.size, latest: true });
  }
  // opts: { from 当前版本, version 目标版本, variant 'server' | 'with-clients', size 字节, allowDowngrade, latest 不传版本号走“最新版”接口 }
  async function installUpdate(opts) {
    const label = opts.variant === 'with-clients' ? '含客户端安装包的完整包' : '服务端安装包';
    if (!await ymConfirm(`${opts.allowDowngrade ? '将安装旧版本 / 重装' : '发现新版本'} ${opts.version}（当前 ${opts.from}）。\n服务器会从 GitHub 下载${label}（${opts.size ? '约 ' + (opts.size / 1048576).toFixed(0) + ' MB' : '大小未知'}），校验官方签名后更新。\n更新前自动备份，期间服务会重启一两分钟；新版本没起来会自动回滚。\n\n现在开始吗？`, { okText: '下载并安装' })) return;
    const info = { currentVersion: opts.from, latestVersion: opts.version };
    const mon = openUpdateMonitor(info.currentVersion, info.latestVersion), sleep = ms => new Promise(r => setTimeout(r, ms));
    try {
      mon.step('download');
      await api('/api/admin/service-update/download-latest', { method: 'POST', body: JSON.stringify({ confirm: true, variant: opts.variant, allowDowngrade: opts.allowDowngrade === true, ...(opts.latest ? {} : { version: opts.version }) }) });
      let d;
      for (;;) {
        await sleep(700); d = await api('/api/admin/service-update/status'); const dl = d.download || {};
        if (dl.state === 'downloading') mon.progress(dl.received, dl.total);
        else if (dl.state === 'verifying') { mon.step('verify'); mon.text('下载完成，正在校验官方签名…'); }
        else if (dl.state === 'failed') throw new Error('下载没有成功：' + (dl.error || '未知原因'));
        else if (dl.state === 'ready') break;
      }
      if (!d.pending) throw new Error('安装包没有保存成功，请重试');
      mon.step('install'); mon.text('正在备份数据并替换程序…');
      await api('/api/admin/service-update/apply', { method: 'POST', body: JSON.stringify({ confirm: true, sha256: d.pending.sha256, allowDowngrade: opts.allowDowngrade === true }) });
      const t0 = Date.now();
      for (;;) {
        await sleep(3000);
        if (Date.now() - t0 > 15 * 60 * 1000) throw new Error('等了很久还没完成。请到服务器上查看：tail -40 /var/lib/yumeiro-update/update.log');
        let s;
        try { const r = await fetch('/api/admin/service-update/status', { credentials: 'same-origin' }); if (!r.ok) { mon.step('restart'); mon.text('服务正在重启，等它恢复…'); continue; } s = await r.json(); }
        catch { mon.step('restart'); mon.text('服务正在重启，等它恢复…'); continue; }
        const st = s.status || {};
        if (st.state === 'running') { mon.log(st.log || ''); }
        else if (st.state === 'ok' && st.version === info.latestVersion) { mon.done(`更新完成：现在是 ${s.currentVersion}。请刷新页面（Ctrl+F5）。`); return; }
        else if (st.state === 'failed') { mon.log(st.log || ''); throw new Error(st.interrupted ? '更新中途中断了。服务如果打不开，请在服务器上执行 systemctl start yumeiro。' : '更新没有成功，已自动回滚到旧版本。日志如下：'); }
      }
    } catch (e) { mon.fail(e.message); }
  }

  // 选版本安装：主区只列比当前更新的版本；旧版本 / 重装当前版本单独折叠成另一块（需要明确勾选风险）。每个版本标明有没有“服务端包 / 含客户端的包”。
  function versionPicker(info) {
    const wrap = el('div', {}), msg = el('div', { class: 'team-note', textContent: '正在读取可选版本…' });
    wrap.append(msg);
    const mb = a => a.size ? (a.size / 1048576).toFixed(0) + ' MB' : '大小未知';
    // older=true：降级 / 重装，需要勾选风险确认才能点安装
    const panel = (releases, data, older) => {
      const box = el('div', { style: 'display:block' });
      if (!releases.length) { box.append(el('div', { class: 'team-note', textContent: older ? '没有更旧的版本可选。' : `没有比当前（${data.currentVersion}）更新的版本。` })); return box; }
      const ver = el('select', {}, releases.map((r, i) => el('option', { value: r.version, textContent: r.version + (!older && i === 0 ? '（最新）' : '') + (r.current ? '（当前版本，重装）' : '') + `　［服务端${r.server ? '✓' : '✗'} · 含客户端${r.clients ? '✓' : '✗'}］` })));
      const kind = el('select', {}), info2 = el('div', { class: 'team-note' }), notes = el('details', { style: 'margin-top:6px' });
      const ack = el('input', { type: 'checkbox' }), ackLabel = el('label', { style: 'font-size:13px;display:block;margin-top:8px' }, ack, ' 我知道这会换成旧版本（或重装当前版本）。更新前会自动备份；如果新版本改过数据结构，旧版本可能读不了这些数据，起不来会自动回滚。');
      const go = el('button', { type: 'button', class: older ? 'secondary' : 'primary', textContent: older ? '下载并安装这个旧版本' : '下载并安装' });
      const cur = () => releases.find(r => r.version === ver.value);
      const refresh = () => {
        const r = cur(), keep = kind.value;
        kind.replaceChildren(
          el('option', { value: 'server', textContent: r.server ? `仅服务端（${mb(r.server)}，不含客户端安装包）` : '仅服务端（这个版本没有）', disabled: !r.server }),
          el('option', { value: 'with-clients', textContent: r.clients ? `含客户端安装包（${mb(r.clients)}，Windows / 安卓）` : '含客户端安装包（这个版本没有）', disabled: !r.clients }));
        kind.value = keep === 'with-clients' && r.clients ? 'with-clients' : r.server ? 'server' : r.clients ? 'with-clients' : 'server';
        info2.textContent = `这个版本的安装包：服务端 ${r.server ? '✓ ' + mb(r.server) : '✗ 没有'}　含客户端 ${r.clients ? '✓ ' + mb(r.clients) : '✗ 没有'}${r.server || r.clients ? '' : '（请到发布页手动下载后上传）'}`;
        notes.replaceChildren(el('summary', { textContent: '这个版本改了什么' }), (() => { const box = el('div', { class: 'team-notes', style: 'max-height:240px;overflow:auto;padding:4px 2px' }); if (r.notes) box.append(renderMarkdown(r.notes)); else box.textContent = '（发布页没有写说明）'; return box; })());
        go.disabled = !(r.server || r.clients) || (older && !ack.checked);
      };
      ver.addEventListener('change', refresh); kind.addEventListener('change', refresh); ack.addEventListener('change', refresh); refresh();
      go.addEventListener('click', () => {
        const r = cur(), pick = kind.value === 'with-clients' ? r.clients : r.server;
        if (!pick) { ymAlert('这个版本没有所选类型的安装包。'); return; }
        installUpdate({ from: data.currentVersion, version: r.version, variant: kind.value, size: pick.size, allowDowngrade: older });
      });
      box.append(el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center' }, el('label', { style: 'font-size:13px' }, '版本 ', ver), el('label', { style: 'font-size:13px' }, '包类型 ', kind)), info2, ...(older ? [ackLabel] : []), el('div', { style: 'margin-top:8px' }, go), notes);
      return box;
    };
    api('/api/admin/service-update/releases').then(data => {
      const list = data.releases || [];
      if (!list.length) { msg.textContent = 'GitHub 上还没有可选的发布版本。'; return; }
      msg.remove();
      wrap.append(
        el('div', { class: 'team-row', style: 'display:block;margin:8px 0' }, el('b', { textContent: '选择新版本并安装' }), panel(list.filter(r => r.newer), data, false)),
        el('details', { class: 'team-row', style: 'display:block;margin:8px 0' }, el('summary', { style: 'cursor:pointer;font-weight:650', textContent: '安装旧版本 / 重装当前版本（降级，一般不需要）' }), panel(list.filter(r => !r.newer), data, true)));
    }).catch(e => { msg.textContent = e.message + '（也可以在下面手动上传安装包）'; });
    return wrap;
  }

  async function renderService(body, refresh = false) {
    const info = await api('/api/admin/service-update' + (refresh ? '?refresh=1' : '')), err = errBox();
    const checkBtn = el('button', { type: 'button', class: 'secondary', textContent: '检查更新', on: { click: async () => {
      checkBtn.disabled = true; checkBtn.textContent = '检查中…';
      try { body.replaceChildren(); await renderService(body, true); } catch (e) { checkBtn.disabled = false; checkBtn.textContent = '检查更新'; err.textContent = e.message; }
    } } });
    const native = el('pre', { class: 'team-code', textContent: info.nativeCommand });
    const docker = el('pre', { class: 'team-code', textContent: info.dockerCommand });
    const check = info.error
      ? el('div', { class: 'team-err', textContent: info.error })
      : info.updateAvailable
        ? el('div', { class: 'team-err', textContent: `发现新版本 ${info.latestVersion}（当前 ${info.currentVersion}）。可以在下面“选择版本并安装”里一键安装（可选版本和是否含客户端安装包），也可以到发布页下载 Yumeiro-${info.latestVersion}.zip 后在“上传压缩包更新”里上传。` }, el('a', { href: info.releaseUrl, target: '_blank', rel: 'noopener noreferrer', textContent: ' 打开发布页' }))
        : el('div', { class: 'team-note', textContent: `当前已是最新版本（${info.currentVersion}）。上次检查：${fmt(info.checkedAt)}` });
    const oneClick = versionPicker(info);
    body.append(
      el('div', { class: 'team-row', style: 'display:block;border-color:var(--accent)' },
        el('b', { textContent: '当前服务版本：' + info.currentVersion }),
        el('p', { class: 'team-note', textContent: info.setupCompleted ? '首次安装已完成。管理端会自动检查 GitHub Releases，有新版本时在这里提醒。' : '首次安装尚未完成，请先打开 /setup 完成初始化。' })),
      el('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' }, el('h3', { style: 'margin:0', textContent: '服务器服务更新提醒' }), checkBtn), check, oneClick,
      info.latestVersion && el('p', { class: 'team-note', textContent: '最新版本：' + info.latestVersion + (info.publishedAt ? '　发布时间：' + fmt(info.publishedAt) : '') }),
      el('p', { class: 'team-note', textContent: info.message }),
      el('p', { class: 'team-note', textContent: '原生部署（systemd）更新命令：' }), native,
      el('p', { class: 'team-note', textContent: 'Docker 部署更新命令：' }), docker,
      el('p', { class: 'team-note', textContent: '更新会重启服务。没有你的确认不会自动更新。' }), err,
      el('h3', { textContent: '上传压缩包更新（不用在服务器上敲命令）' }), uploadPanel());
  }
  // 上传新版发布包 + 粘贴它的 SHA256 校验值；校验值对得上才会让你点“更新”。需要原生安装并启用“更新助手”。
  function uploadPanel() {
    const box = el('div', {}), msg = el('div', { class: 'team-note' }), err = errBox();
    const file = el('input', { type: 'file', accept: '.zip,application/zip' });
    const bar = el('progress', { max: 100, value: 0, hidden: true, style: 'width:100%' });
    const downgrade = el('input', { type: 'checkbox' }), upBtn = el('button', { type: 'button', class: 'secondary', textContent: '上传并校验' });
    const pendingBox = el('div', {}), logBox = el('pre', { class: 'team-code', hidden: true, style: 'max-height:220px;overflow:auto' });
    const show = text => { msg.textContent = text; };
    const renderPending = (pending, current) => {
      pendingBox.replaceChildren();
      if (!pending) { pendingBox.append(el('button', { type: 'button', class: 'primary', disabled: true, textContent: '更新（先上传并校验压缩包）' })); return; }
      const applyBtn = el('button', { type: 'button', class: 'primary', textContent: pending.newer ? `更新到 ${pending.version}` : `仍然更新到 ${pending.version}（不高于当前版本）`, on: { click: async () => {
        if (!await ymConfirm(`确认从 ${current} 更新到 ${pending.version}？\n更新前会先备份数据，期间服务会重启几十秒；新版本没起来会自动回滚。`)) return;
        applyBtn.disabled = true; err.textContent = '';
        try { await api('/api/admin/service-update/apply', { method: 'POST', body: JSON.stringify({ confirm: true, sha256: pending.sha256, allowDowngrade: downgrade.checked }) }); watch(current, pending.version); }
        catch (e) { err.textContent = e.message; applyBtn.disabled = false; }
      } } });
      pendingBox.append(el('div', { class: 'team-row', style: 'display:block;border-color:var(--accent)' },
        el('div', { textContent: `官方签名已验证：${pending.name}（${(pending.size / 1048576).toFixed(1)} MB）　版本 ${pending.version}${pending.withClients ? '　含客户端安装包' : ''}` }),
        el('div', { class: 'team-note', style: 'word-break:break-all', textContent: 'SHA256：' + pending.sha256 }),
        pending.newer ? null : el('label', { style: 'font-size:13px' }, downgrade, ' 允许降级 / 重装同版本'),
        el('div', { style: 'display:flex;gap:8px;margin-top:6px' }, applyBtn, el('button', { type: 'button', class: 'secondary', textContent: '放弃', on: { click: async () => { await api('/api/admin/service-update/pending', { method: 'DELETE' }).catch(() => {}); load(); } } }))));
    };
    // 更新开始后服务会重启：等页面连得上再读结果（成功 / 失败已回滚）
    const watch = (from, to) => {
      pendingBox.replaceChildren(); show(`正在更新 ${from} → ${to}：先备份，再替换程序并重启，通常需要 1–3 分钟，请不要关闭本页。`); upBtn.disabled = true;
      const t = setInterval(async () => {
        try {
          const r = await fetch('/api/admin/service-update/status', { credentials: 'same-origin' }); if (!r.ok) return; const d = await r.json(), st = d.status || {};
          if (st.state === 'ok') { clearInterval(t); show(`更新完成：现在是 ${d.currentVersion}。请按 Ctrl+F5 刷新页面。`); logBox.hidden = true; }
          else if (st.state === 'failed') { clearInterval(t); show(st.interrupted ? '上次更新中途中断了。日志如下：' : '更新没有成功，已自动回滚到旧版本（服务应已恢复）。日志如下：'); logBox.textContent = st.log || ''; logBox.hidden = false; upBtn.disabled = false; }
        } catch { /* 服务重启中，继续等 */ }
      }, 4000);
    };
    const load = async () => {
      try {
        const d = await api('/api/admin/service-update/status');
        if (!d.available) { upBtn.disabled = true; file.disabled = true; show('这台服务器不能在网页里更新（' + d.reason + '）。Docker 部署：在安装目录运行 ./install.sh enable-updater 启用一次更新器即可；原生安装：旧版本的更新助手不认识这个功能，第一次需要在新版本目录里运行 sudo bash deploy/yumeiro-native.sh update。'); return; }
        if (d.status.state === 'running') return watch(d.status.from, d.status.version);
        upBtn.disabled = false; renderPending(d.pending, d.currentVersion);
        if (d.status.state === 'failed') { show(d.status.interrupted ? '上次更新中途中断了。日志如下：' : '上一次更新失败，已回滚。日志如下：'); logBox.textContent = d.status.log || ''; logBox.hidden = false; }
        else show(d.pending ? '' : `当前版本 ${d.currentVersion}。到发布页下载新版的 Yumeiro-x.y.z.zip，填上它的 SHA256，上传即可。`);
      } catch (e) { err.textContent = e.message; }
    };
    upBtn.addEventListener('click', () => {
      err.textContent = ''; const f = file.files[0];
      if (!f) { err.textContent = '请先选择压缩包'; return; }
      const xhr = new XMLHttpRequest(); xhr.open('PUT', '/api/admin/service-update/upload'); xhr.withCredentials = true;
      xhr.setRequestHeader('X-CSRF-Token', csrf); xhr.setRequestHeader('X-File-Name', encodeURIComponent(f.name)); xhr.setRequestHeader('Content-Type', 'application/zip');
      bar.hidden = false; bar.value = 0; upBtn.disabled = true; show('正在上传…');
      xhr.upload.onprogress = e => { if (e.lengthComputable) bar.value = e.loaded / e.total * 100; };
      xhr.onload = () => { bar.hidden = true; upBtn.disabled = false; let d = {}; try { d = JSON.parse(xhr.responseText); } catch { /* 忽略 */ }
        if (xhr.status === 200) { show('上传完成，官方签名验证通过。'); renderPending(d.pending, d.currentVersion); } else { err.textContent = d.error || ('上传失败（HTTP ' + xhr.status + '）'); err.style.whiteSpace = 'pre-wrap'; show(''); } };
      xhr.onerror = () => { bar.hidden = true; upBtn.disabled = false; err.textContent = '网络中断，上传失败'; };
      xhr.send(f);
    });
    box.append(el('p', { class: 'team-note', textContent: '步骤：到发布页下载官方发布的新版压缩包（Yumeiro-x.y.z.zip）→ 在这里选择并上传。不需要填写任何校验值：服务器会自己用内置的官方公钥验证包里的签名，并逐个核对包内文件，不是官方发布的、或被改动过的包会直接拒绝并删除；验证通过才出现“更新”按钮。更新前会自动备份，新版本没起来会自动回滚。' }),
      file, upBtn, bar, msg, err, pendingBox, logBox);
    load(); return box;
  }

  async function renderSite(body) {
    const site = await api('/api/site'), err = errBox(), info = el('div', { class: 'team-note' });
    const mode = el('select', {}, [['team', '团队使用（成员、邀请、团队用量）'], ['personal', '个人使用（隐藏团队功能，只留聊天、工作区、记忆）']].map(([v, t]) => el('option', { value: v, textContent: t, selected: v === (site.mode || 'team') })));
    const name = el('input', { value: site.name, placeholder: '团队/站点名称，如 星辰设计组（留空显示 Yumeiro）', maxLength: 30 });
    const notice = el('textarea', { placeholder: '登录页公告（可选），如：本周六凌晨 2 点维护。最多 200 字。', maxLength: 200, style: 'min-height:70px' });
    notice.value = site.notice;
    body.append(
      el('p', { class: 'team-note', textContent: '这里设置的名称和公告会显示在登录页上，未登录也能看到，请不要写敏感信息。' }),
      el('div', { class: 'team-form' }, name, notice, el('label', {}, '使用模式　', mode), el('button', { type: 'button', class: 'primary wide', textContent: '保存', on: { click: async () => {
        try { await api('/api/admin/site', { method: 'PUT', body: JSON.stringify({ name: name.value, notice: notice.value, mode: mode.value }) }); err.textContent = ''; info.textContent = '已保存；切换使用模式后刷新页面生效'; } catch (e) { err.textContent = e.message; }
      } } })), info, err,
      el('p', { class: 'team-note', textContent: '登录入口：管理员和成员都用 ' + location.origin + '/ ，身份由账号决定，登录后自动进入对应的界面（旧的 /admin 地址会跳转到这里）。' }));
  }

  // 非 HTTPS（例如 http://IP:端口）下 navigator.clipboard 不可用，退回到选中文本 + execCommand。
  async function copyText(text) {
    try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch { /* 继续降级 */ }
    const area = el('textarea', { value: text, style: 'position:fixed;left:-9999px;top:0' });
    document.body.append(area); area.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch { ok = false; } area.remove();
    return ok;
  }
  const inviteStates = { active: '可用', used: '已用完', expired: '已过期', revoked: '已撤销' };
  async function renderInvites(body) {
    const { invites } = await api('/api/admin/invites');
    const err = errBox();
    const createInvite = async (init = {}) => {
      const v = await ymForm('生成邀请链接', [
        { name: 'note', label: '备注（可选）', value: init.note || '', placeholder: '例如“市场部小王”' },
        { name: 'email', label: '限定邮箱（可选）', type: 'email', value: init.email || '', hint: '留空则对方自己填邮箱' },
        { name: 'days', label: '有效天数', type: 'number', min: 1, max: 90, value: init.days || 7, half: true },
        { name: 'uses', label: '可用次数', type: 'number', min: 1, max: 100, value: init.uses || 1, half: true },
        { name: 'daily', label: '每日调用次数', type: 'number', min: 0, value: init.daily || 0, half: true, hint: '0 = 不限' },
        { name: 'monthlyCalls', label: '每月调用次数', type: 'number', min: 0, value: init.monthlyCalls || 0, half: true, hint: '0 = 不限' },
        { name: 'monthlyTokens', label: '每月 Token', type: 'number', min: 0, value: init.monthlyTokens || 0, half: true, hint: '0 = 不限' },
        { name: 'hourlyTokens', label: '每小时 Token', type: 'number', min: 0, value: init.hourlyTokens || 0, half: true, hint: '0 = 不限' }], { okText: '生成并复制链接' });
      if (!v) return;
      const n = x => Math.max(0, Math.floor(Number(x) || 0));
      try {
        const { invite } = await api('/api/admin/invites', { method: 'POST', body: JSON.stringify({ note: v.note, email: v.email.trim(), expiresInDays: n(v.days) || 7, maxUses: n(v.uses) || 1, dailyLimit: n(v.daily), monthlyCallLimit: n(v.monthlyCalls), monthlyTokenLimit: n(v.monthlyTokens), hourlyTokenLimit: n(v.hourlyTokens) }) });
        const link = location.origin + '/invite/' + invite.token;
        await copyText(link); render(); window.ymQr ? window.ymQr(link, '邀请链接已生成（已复制）', { tip: '让对方用手机相机或微信“扫一扫”扫描，打开后自己设置邮箱和密码就能加入；也可以把下面的链接发给他。' }) : ymAlert('邀请链接已生成并复制：' + link);
      } catch (e) { await ymAlert(e.message); createInvite(v); }
    };
    body.append(
      el('p', { class: 'team-note', textContent: '生成邀请链接发给同事，对方打开后自己设置邮箱和密码即可加入，账号默认是成员。链接可随时在这里复制或删除；删除后立即失效。' }),
      el('div', { style: 'margin:10px 0' }, el('button', { type: 'button', class: 'primary', textContent: '＋ 生成邀请链接', on: { click: () => createInvite() } })), err,
      invites.length ? null : el('p', { class: 'team-note', textContent: '还没有邀请。' }),
      invites.map(i => {
        const link = location.origin + '/invite/' + i.token;
        const hint = el('span', { class: 'team-note' });
        return el('div', { class: 'team-row', style: 'align-items:flex-start;flex-wrap:wrap' },
          el('div', { class: 'grow' }, (i.note || '未备注') + '　' + inviteStates[i.state],
            el('small', { textContent: '已用 ' + i.uses + '/' + i.maxUses + '　到期 ' + fmt(i.expiresAt) + (i.email ? '　限 ' + i.email : '') + '　额度 ' + (i.dailyLimit || '∞') + '/日、' + (i.monthlyCallLimit || '∞') + '/月、' + (i.monthlyTokenLimit || '∞') + ' tokens、' + (i.hourlyTokenLimit || '∞') + ' tokens/小时' }),
            i.state === 'active' ? el('input', { value: link, readOnly: true, style: 'width:100%;margin-top:6px;border:1px solid var(--line);border-radius:8px;padding:6px 8px;background:transparent;color:var(--ink);font-size:12px', on: { focus: e => e.target.select() } }) : null),
          el('div', { style: 'display:flex;gap:6px;align-items:center' }, hint,
            i.state === 'active' ? el('button', { type: 'button', class: 'secondary', textContent: '二维码', title: '显示邀请二维码，让对方用手机扫一扫', on: { click: () => window.ymQr && window.ymQr(link, '邀请：' + (i.note || '未备注'), { tip: '让对方用手机相机或微信“扫一扫”扫描，打开后自己设置邮箱和密码就能加入；也可以把下面的链接发给他。' }) } }) : null,
            i.state === 'active' ? el('button', { type: 'button', class: 'secondary', textContent: '复制链接', on: { click: async () => { hint.textContent = (await copyText(link)) ? '已复制' : '请手动选中链接复制'; } } }) : null,
            el('button', { type: 'button', class: 'secondary', textContent: i.state === 'active' ? '撤销' : '删除', on: { click: async () => { if (i.state === 'active' && !await ymConfirm('撤销后这个链接立即失效，确定吗？', { danger: true, okText: '确定' })) return; try { await api('/api/admin/invites/' + i.id, { method: 'DELETE' }); render(); } catch (e) { ymAlert(e.message); } } } })));
      }));
  }
  // ---------- 桌面端：软件更新引导 ----------
  async function renderDesktopUpdate(body) {
    const FLAVOR = { global: '国际版', cn: '国内版' };
    const box = el('div', { class: 'team-row', style: 'display:block' });
    body.append(el('h3', { textContent: '软件更新' }), box);
    const code = text => el('pre', { style: 'margin:6px 0;padding:8px 10px;border-radius:8px;background:rgba(0,0,0,.18);overflow:auto;font-size:12px', textContent: text });
    const guide = (flavor, reachable) => el('div', {},
      el('details', { open: !reachable }, el('summary', { textContent: '怎么更新（点开看步骤）', style: 'cursor:pointer;font-weight:600;margin:8px 0' }),
        el('ol', { class: 'team-note', style: 'padding-left:20px;line-height:1.9' },
          el('li', { textContent: '一般什么都不用做：桌面端会按上面的间隔自动检查，发现新版就下载、校验、安装并自动重启一次，登录状态保留。' }),
          el('li', { textContent: '想马上更新：点上面的“检查并更新”。下载约 200MB，国内服务器可能要几分钟；下载慢或失败时，在服务器的 .env 里加 CINDY_DOWNLOAD_PREFIX=加速前缀，再重启桌面端容器。' }),
          el('li', { textContent: '更新完成后：点“打开桌面”确认 Cindy 仍是登录状态；如果桥接弹出授权请求，点“允许”。' }),
          el('li', { textContent: '新版本启动失败：会自动退回上一个版本（连续 3 次不到 30 秒就退出时触发），并且不会再重试这个坏版本。' })),
        !reachable && el('div', {}, el('p', { class: 'team-note', textContent: '现在连不上桌面端的更新状态服务：多半是容器还是旧版本。在服务器的项目目录里执行：' }),
          code('docker compose up -d --force-recreate desktop yumeiro'))),
      flavor === 'cn' && el('p', { class: 'team-err', style: 'margin-top:8px' }, '你现在用的是国内版。如果登录的是国际版账号，请点上面“安装并切换到国际版 Cindy”（不用重建镜像，约 200MB）。'),
      el('details', {}, el('summary', { textContent: '更新失败时怎么办', style: 'cursor:pointer;font-weight:600;margin:8px 0' }),
        el('ul', { class: 'team-note', style: 'padding-left:20px;line-height:1.9' },
          el('li', { textContent: '“查询最新版本失败 / 下载失败”：服务器连不上 GitHub。配置 CINDY_DOWNLOAD_PREFIX（下载加速前缀）；查询失败多半是网络被墙，可换一台能访问 GitHub 的网络环境或稍后再试。' }),
          el('li', { textContent: '“需要镜像里没有的系统库”：新版本依赖变了，需要重建镜像：docker compose build --no-cache desktop && docker compose up -d desktop。' }),
          el('li', { textContent: '“SHA-256 校验不通过”：下载被截断或被改动，已丢弃，不会安装；稍后重试。' }),
          el('li', { textContent: '想关掉自动更新：.env 里设 CINDY_AUTO_UPDATE=0 后重启桌面端容器。' }))));
    // 选择 Cindy 版本：区域（国际版 / 国内版）和版本号都能选，直接在桌面端容器里下载安装（不用重建镜像）。
    // 已经装好时，“检查并更新”按当前区域更新；选了具体版本号 = 固定在这个版本（不再自动更新，也能回退到旧版本）。
    const OPTIONS = [
      ['global', '国际版 Cindy', '用国际版（Global）Cindy 账号登录的选这个。'],
      ['cn', '国内版 Cindy', '用国内版（中国大陆）Cindy 账号登录的选这个。']
    ];
    let selFlavor = '', selVersion = 'latest', versions = null, lastInfo = null, timer = 0;
    const cell = (label, value) => el('div', { style: 'min-width:130px' }, el('small', { textContent: label }), el('div', { style: 'font-weight:600', textContent: value || '—' }));
    const run = async (payload, err) => {
      err.textContent = '';
      try { await api('/api/admin/desktop/update', { method: 'POST', body: JSON.stringify(payload || {}) }); setTimeout(draw, 1500); } catch (e) { err.textContent = e.message; }
    };
    const render = info => {
      const st = info.status || {}, flavor = st.flavor || 'global', busy = Boolean(st.checking) || st.result === 'downloading';
      if (!selFlavor) selFlavor = flavor;
      const err = errBox();
      // ---- 第 1 步：选区域和版本 ----
      const list = (versions || []).filter(v => v[selFlavor]);
      const verSel = el('select', { disabled: busy || !info.reachable, style: 'min-width:240px' },
        el('option', { value: 'latest', textContent: '最新版（之后继续自动更新）' }),
        list.map(v => el('option', { value: v.version, textContent: v.version + (v.date ? '（' + v.date + '）' : '') + ' · 固定在这个版本' })));
      verSel.value = [...verSel.options].some(o => o.value === selVersion) ? selVersion : 'latest';
      verSel.addEventListener('change', () => { selVersion = verSel.value; render(lastInfo); });
      const cards = OPTIONS.map(([key, name, desc]) => el('label', { style: 'display:block;cursor:pointer;border:1px solid ' + (selFlavor === key ? 'var(--accent)' : 'var(--line)') + ';border-radius:12px;padding:12px' },
        el('div', { style: 'display:flex;gap:8px;align-items:center;font-weight:700;margin-bottom:4px' },
          el('input', { type: 'radio', name: 'cindyFlavor', checked: selFlavor === key, disabled: busy || !info.reachable, on: { change: () => { selFlavor = key; selVersion = 'latest'; render(lastInfo); } } }),
          name + (key === flavor ? '（当前）' : '')),
        el('small', { textContent: desc })));
      const same = selFlavor === flavor && ((selVersion === 'latest' && !st.pinned) || selVersion === st.pinned);
      const goText = selFlavor !== flavor ? '安装并切换到' + FLAVOR[selFlavor] : selVersion === 'latest' ? '改回最新版（自动更新）' : '安装并固定到 ' + selVersion;
      const go = el('button', { type: 'button', disabled: busy || !info.reachable || same, textContent: goText, on: { click: async () => {
        const note = selFlavor !== flavor ? '会下载约 200MB 的安装包，安装后桌面端会重启，并且需要用' + FLAVOR[selFlavor] + '账号重新登录一次。' : '会下载约 200MB 的安装包，安装后桌面端会重启一次。';
        const pin = selVersion === 'latest' ? '' : '固定在 ' + selVersion + ' 后不再自动更新（要恢复，回来选“最新版”）。';
        if (!await ymConfirm(goText + '：' + note + pin + '继续吗？')) return;
        run({ flavor: selFlavor, version: selVersion }, err);
      } } });
      // ---- 第 2 步：检查更新 ----
      const verdict = !info.reachable ? ['无法读取', '桌面端容器里的更新状态服务没有响应'] : st.result === 'updated' ? ['已更新', st.message] : st.result === 'current' ? ['已是最新', st.message] : st.result === 'failed' ? ['更新失败', st.message] : busy ? ['正在处理', st.message || '请稍等'] : st.latest && st.installed && st.latest !== st.installed ? ['有新版本', '点“检查并更新”'] : ['还没检查过', '启动后约 2 分钟会自动检查一次，也可以点右边按钮立即检查'];
      const update = el('button', { type: 'button', class: 'secondary', disabled: busy || !info.reachable || Boolean(st.pinned), textContent: busy ? '处理中…' : st.pinned ? '已固定版本' : '检查并更新', on: { click: () => run({}, err) } });
      box.replaceChildren(
        el('p', { class: 'team-note', style: 'margin:0 0 8px' }, el('b', { textContent: '第 1 步（可选）：选择 Cindy 版本。' }), ' 已经装好的话可以跳过，直接第 2 步更新。国际版和国内版的账号不互通，要和你登录用的账号一致。'),
        el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin-bottom:8px' }, cards),
        el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap;align-items:center' }, el('span', { textContent: '版本：' }), verSel, go),
        !versions || !versions.length ? el('small', { textContent: '（版本列表读取不到时只能选“最新版”；服务器需要能访问 GitHub）' }) : null,
        el('p', { class: 'team-note', style: 'margin:14px 0 6px' }, el('b', { textContent: '第 2 步：检查更新、看结果。' }), st.pinned ? ' 当前固定在版本 ' + st.pinned + '，不会自动更新。' : ''),
        el('div', { style: 'display:flex;gap:18px;flex-wrap:wrap;align-items:flex-end;justify-content:space-between' },
          el('div', { style: 'display:flex;gap:18px;flex-wrap:wrap' }, cell('区域版本', FLAVOR[flavor] || flavor), cell('当前版本', st.installed), cell('最新版本', st.latest), cell('上次检查', st.checkedAt ? fmt(st.checkedAt) : ''),
            cell('自动更新', info.reachable ? (st.pinned ? '已固定版本' : st.autoUpdate ? '每 ' + st.intervalHours + ' 小时一次' : '已关闭') : '')),
          update),
        el('p', { class: 'team-note', style: 'margin:10px 0 0' }, el('b', { textContent: verdict[0] + '：' }), verdict[1] || ''), err,
        guide(flavor, info.reachable));
      if (busy && body.isConnected) { clearTimeout(timer); timer = setTimeout(draw, 4000); }
    };
    const draw = async () => {
      clearTimeout(timer);
      let info; try { info = await api('/api/admin/desktop/update'); } catch (e) { box.replaceChildren(el('div', { class: 'team-err', textContent: e.message })); return; }
      if (!box.isConnected) return;
      if (info.reachable && versions === null) { versions = []; try { versions = (await api('/api/admin/desktop/versions')).status.versions || []; } catch { /* 读不到就只能选最新版 */ } }
      lastInfo = info; render(info);
    };
    await draw();
  }

  async function renderDesktop(body) {
    const info = await api('/api/admin/desktop');
    body.append(el('p', { class: 'team-note', textContent: '桌面端是在服务器容器里运行的官方 Cindy。首次使用时在这里打开它的桌面，登录你的账号，并在桥接请求授权时点“允许”。之后它在后台常驻，不需要再打开。' }));
    if (!info.enabled) {
      body.append(el('div', { class: 'team-row' }, el('div', { class: 'grow' }, '尚未启用', el('small', { textContent: '在服务器上运行 ./scripts/desktop-setup.sh 后会自动启用；只有管理员能打开这个桌面。' }))));
      return;
    }
    body.append(
      el('div', { class: 'team-row' }, el('div', { class: 'grow' }, '桌面端已启用', el('small', { textContent: '点击后在新窗口打开，会要求输入 VNC 密码（服务器上 secrets/vnc_password 文件的内容）。' })),
        el('a', { href: info.url, target: '_blank', rel: 'noopener', class: 'secondary', style: 'padding:9px 14px;border:1px solid var(--line);border-radius:9px;text-decoration:none;color:var(--ink)', textContent: '打开桌面' })),
      el('p', { class: 'team-note', textContent: '接入步骤：登录后在“AI 接入”添加服务商，接口地址 http://desktop:8788/v1，密钥为服务器上 secrets/desktop_key 的内容，再点“获取模型列表”。' }));
    await renderDesktopUpdate(body);
  }
  async function renderMembers(body) {
    const { members } = await api('/api/admin/members');
    const err = errBox();
    // 添加成员：弹窗里每一项单独填写；服务器返回错误时提示后重新打开，已填的内容保留
    const addMember = async (init = {}) => {
      const v = await ymForm('添加成员', [
        { name: 'email', label: '邮箱', type: 'email', value: init.email || '', required: true, placeholder: 'name@example.com' },
        { name: 'name', label: '显示名称（可选）', value: init.name || '' },
        { name: 'pw', label: '初始密码', type: 'password', value: init.pw || '', required: true, hint: '至少 12 位，成员登录后可以自己修改' },
        { name: 'daily', label: '每日调用次数', type: 'number', min: 0, value: init.daily || 0, half: true, hint: '0 = 不限' },
        { name: 'monthlyCalls', label: '每月调用次数', type: 'number', min: 0, value: init.monthlyCalls || 0, half: true, hint: '0 = 不限' },
        { name: 'monthlyTokens', label: '每月 Token', type: 'number', min: 0, value: init.monthlyTokens || 0, half: true, hint: '0 = 不限' },
        { name: 'hourlyTokens', label: '每小时 Token', type: 'number', min: 0, value: init.hourlyTokens || 0, half: true, hint: '0 = 不限' }], { okText: '添加' });
      if (!v) return;
      const n = x => Math.max(0, Math.floor(Number(x) || 0));
      try { await api('/api/admin/members', { method: 'POST', body: JSON.stringify({ email: v.email.trim(), displayName: v.name, password: v.pw, dailyLimit: n(v.daily), monthlyCallLimit: n(v.monthlyCalls), monthlyTokenLimit: n(v.monthlyTokens), hourlyTokenLimit: n(v.hourlyTokens) }) }); render(); }
      catch (e) { await ymAlert(e.message); addMember(v); }
    };
    const patch = async (m, data) => { try { await api('/api/admin/members/' + m.id, { method: 'PATCH', body: JSON.stringify(data) }); render(); } catch (e) { ymAlert(e.message); } };
    body.append(
      el('p', { class: 'team-note', textContent: '你是主账号。成员使用邮箱和密码登录，只能看到自己的对话；每日调用上限同时约束网页和 API。' }),
      el('div', { style: 'margin:10px 0' }, el('button', { type: 'button', class: 'primary', textContent: '＋ 添加成员', on: { click: () => addMember() } })), err,
      members.map(m => el('div', { class: 'team-row' }, el('div', { class: 'grow' }, `${m.displayName}（${m.role === 'admin' ? '主账号' : '成员'}）${m.disabled ? ' · 已停用' : ''}`, el('small', { textContent: `${m.email}　今日 ${m.todayCalls}/${m.dailyLimit || '∞'}　本月 ${num(m.month.calls)}/${m.monthlyCallLimit || '∞'} 次、${num(m.month.totalTokens)}/${m.monthlyTokenLimit || '∞'} tokens　令牌 ${m.tokens}　使用时段 ${m.allowedHours ? m.allowedHours.start + '–' + m.allowedHours.end : '不限'}　最近登录 ${fmt(m.lastLoginAt)}` })),
        m.role !== 'admin' && el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' },
          el('button', { type: 'button', class: 'secondary', textContent: m.disabled ? '启用' : '停用', on: { click: () => patch(m, { disabled: !m.disabled }) } }),
          el('button', { type: 'button', class: 'secondary', textContent: '额度', on: { click: async () => {
            const v = await ymForm('设置额度：' + (m.displayName || m.email), [
              { name: 'daily', label: '每日调用次数', type: 'number', min: 0, value: m.dailyLimit || 0, hint: '0 = 不限' },
              { name: 'monthlyCalls', label: '每月调用次数', type: 'number', min: 0, value: m.monthlyCallLimit || 0, hint: '0 = 不限' },
              { name: 'monthlyTokens', label: '每月 Token', type: 'number', min: 0, value: m.monthlyTokenLimit || 0, hint: '0 = 不限' },
              { name: 'hourlyTokens', label: '每小时 Token', type: 'number', min: 0, value: m.hourlyTokenLimit || 0, hint: '0 = 不限；按服务器本地整点计算' }], { okText: '保存' });
            if (!v) return;
            const n = x => Math.max(0, Math.floor(Number(x) || 0));
            patch(m, { dailyLimit: n(v.daily), monthlyCallLimit: n(v.monthlyCalls), monthlyTokenLimit: n(v.monthlyTokens), hourlyTokenLimit: n(v.hourlyTokens) });
          } } }),
          el('button', { type: 'button', class: 'secondary', textContent: '使用时段', on: { click: async () => {
            const v = await ymForm('允许使用的时段：' + (m.displayName || m.email), [
              { name: 'start', label: '开始', type: 'time', value: m.allowedHours?.start || '09:00', half: true, required: true },
              { name: 'end', label: '结束', type: 'time', value: m.allowedHours?.end || '18:00', half: true, required: true }],
              { message: '服务器本地时间。结束早于开始表示跨午夜，如 22:00 到 06:00。', okText: '保存', extra: { text: '不限制时段' } });
            if (!v) return;
            if (v.__extra) return patch(m, { allowedHours: null });
            if (v.start === v.end) return ymAlert('开始和结束时间不能相同');
            patch(m, { allowedHours: { start: v.start, end: v.end } });
          } } }),
          el('button', { type: 'button', class: 'secondary', textContent: '重置密码', on: { click: async () => { const v = await ymPrompt('新密码（至少 12 位）', '', { type: 'password', title: '重置密码' }); if (v) patch(m, { password: v }); } } }),
          el('button', { type: 'button', class: 'secondary danger', textContent: '删除', on: { click: async () => { if (!await ymConfirm('删除成员及其全部对话、令牌？不可恢复。', { danger: true, okText: '确定' })) return; try { await api('/api/admin/members/' + m.id, { method: 'DELETE' }); render(); } catch (e) { ymAlert(e.message); } } } })))));
  }
})();
