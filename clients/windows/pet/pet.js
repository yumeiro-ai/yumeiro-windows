// 桌宠「梦色」：网页里的悬浮小伙伴（可拖动、会眨眼、会跟着鼠标歪头、点一下会开心、久不操作会打瞌睡），
// 也是 Windows 客户端桌面宠物窗口的同一套代码（那边透明置顶，素材路径和拖动由 Electron 提供）。
(() => {
  const host = window.yumeiroPetHost || null;          // 桌宠窗口里由 pet-preload.js 提供
  const app = window.yumeiroApp || null;               // Windows 客户端主窗口里由 preload.js 提供
  const BASE = window.YUMEIRO_PET_BASE || '/pet/';
  const KEY = 'yumeiro.pet';
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const FRAMES = { idle: BASE + 'idle.png', blink: BASE + 'blink.png', happy: BASE + 'happy.png', sleepy: BASE + 'sleepy.png', walk1: BASE + 'walk1.png', walk2: BASE + 'walk2.png', walk3: BASE + 'walk3.png', walk4: BASE + 'walk4.png', peek: BASE + 'peek.png', sit: BASE + 'sit.png' };
  for (const n of ['angry1', 'angry2', 'sad1', 'sad2', 'laugh1', 'laugh2', 'surprised', 'shy']) FRAMES[n] = BASE + n + '.png';
  // 各帧素材的像素宽度（scripts/build-pet.mjs 生成，见 public/pet/size.json）：按它换算显示宽度，不同姿势里的人物大小才一致
  const SIZES = { idle: 450, blink: 450, happy: 450, sleepy: 450, walk1: 382, walk2: 382, walk3: 382, walk4: 382, peek: 227, sit: 382, angry1: 371, angry2: 371, sad1: 371, sad2: 371, laugh1: 391, laugh2: 391, surprised: 391, shy: 391 };
  const LINES = {
    click: ['我在这儿陪你～ I\'m here!', '要不要喝口水？Stay hydrated!', '摸摸头～ ♪', '今天也辛苦啦 Great work!', '需要帮忙就叫我 Ask me anything', '再坚持一下下 Almost there!', '深呼吸，伸个懒腰 Stretch time!'],
    done: ['回答好啦 ✨ Done!', '搞定～ All set!', '新消息来啦 New reply!'],
    think: ['让我想想… Thinking…', '嗯嗯，处理中 Working on it…'],
    wake: ['欢迎回来 Welcome back!', '你回来啦～ Hi again!'],
    sleep: ['Zzz… 打个盹 Napping…'],
    offline: ['网络断开了 Offline…', '断网了…好慌 No signal…'], online: ['网络恢复啦 Back online!'],
    angry: ['哼！Hmph!', '我生气了！I\'m mad!', '不理你了 Not talking to you', '气鼓鼓… >_<'],
    grumble: ['哼… Hmph…', '还在生气呢 Still mad', '别惹我 Don\'t poke me'],
    poke: ['别戳啦！Stop poking!', '再戳我要生气了！', '很痛的 That hurts!'],
    sad: ['呜呜… Sniff…', '好难过 I\'m sad…', '心情不好 Feeling down'],
    mutter: ['唉… Sigh…', '有点低落 A bit down', '想被安慰 Need a hug'],
    comfort: ['谢谢你安慰我 Thanks for cheering me up', '抱抱我嘛 Hug me~', '好一点了 Feeling better'],
    laugh: ['哈哈哈 Hahaha!', '太好笑了 So funny!', '笑死我了 LOL'],
    shy: ['呜哇…脸红了 So embarrassing', '别、别摸啦 Hehe…', '好痒～ That tickles~'],
    surprised: ['诶？！What?!', '吓我一跳 You scared me!'],
    error: ['出错了…对不起 Sorry, something broke', '我没做好 I messed up…'],
    praise: ['被夸啦～ Thank you!', '嘿嘿，开心 Hehe, happy!'],
    scold: ['呜…你骂我 That hurts…', '好过分 So mean…'],
    empathy: ['抱抱你 Hugs', '我陪着你 I\'m with you', '辛苦了…要不要休息一下？Take a break?', '先深呼吸 Breathe in, breathe out'],
    repeat: ['诶，是我没说清楚吗？Did I miss something?', '抱歉，我再想想 Sorry, let me try again'],
    wait: ['等得有点久了… Taking a while…', '再等等，马上就好 Almost there'],
    thanks: ['听到你这么说我好开心 That made my day']
  };
  const pick = list => list[Math.floor(Math.random() * list.length)];
  // 番茄钟休息时给的小建议
  const REST_TIPS = ['站起来走一走，活动一下肩颈。', '喝杯水，顺便看看窗外的远处 20 秒。', '做几次深呼吸：吸 4 秒、停 4 秒、呼 6 秒。', '转转手腕和脚踝，伸个懒腰。', '闭上眼睛休息一分钟，让眼睛放松一下。', '起身接杯水，不要一直盯着屏幕。'];
  const restTip = () => pick(REST_TIPS);
  const defaults = () => ({ enabled: Boolean(host), size: host ? 150 : 130, walk: true, roam: 'screen' });   // roam：screen = 桌面端在整个屏幕里漫游；bottom = 只沿当前高度左右走
  const load = () => { try { return { ...defaults(), ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return defaults(); } };
  let prefs = load();
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* 存储满了就算了 */ } };
  const inElectronMain = Boolean(app && app.petEvent);

  // ---- 和页面（聊天 / 登录态）打交道的小工具：只在有聊天页面的窗口里用（网页，或 Electron 主窗口）----
  const fmtNum = n => { n = Number(n) || 0; return n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K' : String(n); };
  let pageCsrf = '';
  async function getCsrf() {
    if (pageCsrf) return pageCsrf;
    const s = await (await fetch('/api/auth/session', { credentials: 'same-origin' })).json();
    if (!s.authenticated) throw new Error('未登录');
    return (pageCsrf = s.csrfToken || '');
  }
  // 用量摘要（给“rua 卡片”显示）：/api/usage/me 压成几个数字；Electron 主窗口会把它推给桌面上的桌宠
  async function fetchUsage() {
    const r = await fetch('/api/usage/me', { credentials: 'same-origin' }); if (!r.ok) throw new Error('usage ' + r.status);
    const d = await r.json(), u = d.usage || {};
    return { m: d.month || '', c: u.todayCalls || 0, dl: u.dailyLimit || 0, mc: u.calls || 0, ml: u.monthlyCallLimit || 0, t: u.totalTokens || 0, tl: u.monthlyTokenLimit || 0, a: (d.alerts || []).slice(0, 2).map(x => [String(x.label || '').slice(0, 8), x.percent | 0]), b: d.blocked ? 1 : 0 };
  }
  // 表情图识别：把用户刚发的图交给服务器上能看图的模型（/api/pet/sticker），判断它是不是表情包、表达什么情绪
  // “AI 台词”：让聊天模型按情绪现编一句（消耗模型额度）。网页里由桌宠自己调用；桌面端的桌宠窗口没有登录态，由主窗口代办
  async function aiLineFetch(kind, hint) {
    try {
      const r = await fetch('/api/pet/line', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await getCsrf() }, body: JSON.stringify({ emotion: kind, hint: hint || '' }) });
      return r.ok ? String((await r.json()).line || '') : '';
    } catch { return ''; }                      // 没登录或额度用完：保持内置台词
  }
  // “AI 情绪理解”：把最近几条对话交给模型判断情绪（/api/pet/sense）
  async function aiSenseFetch(messages) {
    try {
      const r = await fetch('/api/pet/sense', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await getCsrf() }, body: JSON.stringify({ messages }) });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  }
  // 表情图识别：把用户刚发的图交给服务器上能看图的模型（/api/pet/sticker），判断它是不是表情包、表达什么情绪
  async function stickerCheck(ids) {
    try {
      const r = await fetch('/api/pet/sticker', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await getCsrf() }, body: JSON.stringify({ ids }) });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  }
  // 切换模型：页面上的模型下拉框会发 yumeiro:model-change；此外启动后会静默同步一次当前模型（不打招呼）
  function watchModel(notify) {
    const read = () => { const sel = document.getElementById('modelSelect'), eng = document.getElementById('engineSelect'); if (!sel) return null; return { n: (sel.selectedOptions[0]?.textContent || '').slice(0, 40), r: String(window.yumeiroModel || '').slice(0, 70), e: eng && !eng.hidden ? (eng.selectedOptions[0]?.textContent || '').slice(0, 12) : '' }; };
    window.addEventListener('yumeiro:model-change', ev => { const d = ev.detail || {}; notify('model', JSON.stringify({ n: String(d.name || '').slice(0, 40), r: String(d.ref || '').slice(0, 70), e: String(d.engine || '').slice(0, 12) })); });
    let tries = 0; const t = setInterval(() => { const m = read(); if (m && (m.r || m.n) && m.n) { clearInterval(t); notify('model', JSON.stringify({ ...m, q: 1 })); } else if (++tries > 40) clearInterval(t); }, 1500);
  }
  // 桌面端：桌宠窗口没有登录态，用量由主窗口定时抓取再推过去
  function pushUsage(notify) {
    let last = 0;
    const go = async () => { if (Date.now() - last < 15000) return; last = Date.now(); try { notify('usage', JSON.stringify(await fetchUsage())); } catch { /* 未登录：等下一次 */ } };
    setTimeout(go, 4000); setInterval(go, 5 * 60 * 1000); window.addEventListener('yumeiro:reply-done', go);
  }
  // 侧边栏（side.js）的事件：待办 / 专注 → 桌宠
  function watchSide(notify) {
    for (const [name, type] of [['yumeiro:todos', 'todos'], ['yumeiro:focus', 'focus'], ['yumeiro:todo-done', 'todo-done'], ['yumeiro:todo-due', 'todo-due']]) window.addEventListener(name, e => notify(type, JSON.stringify(e.detail || {})));
  }
  // 连续使用时长（只算这个页面里的操作，连续 10 分钟没动就重新计）：满 90 分钟提醒一次，之后每隔 60 分钟再提
  function watchStreak(notify) {
    let start = Date.now(), last = start, sent = 0;
    for (const type of ['pointerdown', 'keydown', 'wheel']) addEventListener(type, () => { const n = Date.now(); if (n - last > 10 * 60000) { start = n; sent = 0; } last = n; }, { passive: true, capture: true });
    setInterval(() => { const mins = (Date.now() - start) / 60000; if (Date.now() - last < 5 * 60000 && mins >= (sent ? sent + 60 : 90)) { sent = Math.round(mins); notify('streak', String(sent)); } }, 60000);
  }
  // 把开场白填进对话输入框（桌宠主动找你聊天时你点“聊聊”）
  function fillStarter(text) {
    const p = document.getElementById('prompt'); if (!p) return false;
    if (!text) { p.focus(); return true; }
    p.value = String(text || ''); p.dispatchEvent(new Event('input', { bubbles: true })); p.focus(); try { p.setSelectionRange(p.value.length, p.value.length); } catch { /* 忽略 */ }
    return true;
  }
  // 情绪记忆的云端同步（/api/pet/memory）：合并规则和服务器一致——事件按 时间+类型 去重、只留 30 天内的最近 40 条，“忘掉”（clearedAt）之前的一律丢弃
  function mergeMem(a, b) {
    a = a && typeof a === 'object' ? a : {}; b = b && typeof b === 'object' ? b : {};
    const clearedAt = Math.max(a.clearedAt || 0, b.clearedAt || 0), cutoff = Math.max(clearedAt, Date.now() - 30 * 864e5), seen = new Set(), events = [];
    for (const e of [...(a.events || []), ...(b.events || [])].sort((x, y) => y.t - x.t)) { const key = e.t + '|' + e.k; if (!e.t || e.t <= cutoff || seen.has(key)) continue; seen.add(key); events.push(e); if (events.length >= 40) break; }
    const newer = (b.at || 0) >= (a.at || 0) ? b : a;
    return { affinity: clearedAt > (newer.at || 0) ? 0 : Math.max(-100, Math.min(100, Number(newer.affinity) || 0)), events, at: Math.max(a.at || 0, b.at || 0), clearedAt, lastSeen: Math.max(a.lastSeen || 0, b.lastSeen || 0), greetedAt: Math.max(a.greetedAt || 0, b.greetedAt || 0), affAt: a.affAt || 0 };
  }
  async function memFetch() { try { const r = await fetch('/api/pet/memory', { credentials: 'same-origin' }); return r.ok ? (await r.json()).memory : null; } catch { return null; } }
  async function memPush(mem) { try { await fetch('/api/pet/memory', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await getCsrf() }, body: JSON.stringify({ memory: mem }) }); } catch { /* 未登录：只保存在本机 */ } }
  // Electron 主窗口：不在页面里画桌宠，只把事件转给桌面上的那只
  if (inElectronMain) {
    const send = (type, text) => { try { app.petEvent(type, text || ''); } catch { /* 忽略 */ } };
    // 桌宠右键菜单（原生菜单）里的“识别表情图片 / AI 台词”开关由主进程推过来；真正调用模型的活都在这个有登录态的主窗口里干
    if (app.onPrefs) app.onPrefs(p => { prefs.aiLines = Boolean(p.aiLines); prefs.stickerVision = p.stickerVision !== false; save(); });
    if (app.onLineRequest) app.onLineRequest(async ({ kind, hint }) => { if (!prefs.aiLines) return; const line = await aiLineFetch(String(kind || ''), String(hint || '')); if (line) send('say', line.slice(0, 60)); });
    let aiSenseAt = 0;
    const aiSenseMain = async (lex, messages) => {
      if (!prefs.aiLines || Date.now() - aiSenseAt < 45000 || !messages.length) return;
      aiSenseAt = Date.now(); const d = await aiSenseFetch(messages);
      if (d && Math.abs(d.valence - lex.v) > 0.25) send('sense', JSON.stringify({ v: +(d.valence - lex.v).toFixed(2), a: +Number(d.arousal || 0).toFixed(2), o: d.about, e: d.emotion === 'none' ? '' : d.emotion, ai: 1 }));
    };
    // 情绪记忆：桌宠窗口没有登录态，由主窗口定时从服务器拉下来推给它；它新记的事件再由主窗口合并写回服务器
    const memPull = async () => { const server = await memFetch(); if (server) send('memory', JSON.stringify(server)); };
    setTimeout(memPull, 2500); setInterval(memPull, 10 * 60 * 1000);
    if (app.onMemory) app.onMemory(json => { try { memPush(JSON.parse(json)); } catch { /* 忽略 */ } });
    watchChat(send, aiSenseMain); watchModel(send); pushUsage(send); watchSide(send); watchStreak(send);
    if (app.onStarter) app.onStarter(fillStarter);
    return;
  }

  const style = document.createElement('style');
  style.textContent = `
    #ymPet{position:fixed;z-index:60;user-select:none;-webkit-user-select:none;touch-action:none;cursor:grab;display:flex;flex-direction:column;align-items:center;transition:opacity .25s}
    #ymPet.hidden,body:has(#loginShell:not([hidden])) #ymPet{display:none!important}#ymPet.drag{cursor:grabbing}
    #ymPet .pet-body{position:relative;width:100%;transform-origin:50% 100%;transition:transform .35s cubic-bezier(.3,1.5,.5,1);will-change:transform;filter:drop-shadow(0 5px 7px #0005)}
    #ymPet .pet-stage{position:relative;width:100%;aspect-ratio:450/517;pointer-events:none}
    #ymPet .pet-stage img{position:absolute;left:50%;bottom:0;translate:-50% 0;height:auto;visibility:hidden;pointer-events:none;-webkit-user-drag:none;user-select:none}#ymPet .pet-stage img.on{visibility:visible}
    #ymPet .pet-float{width:100%;animation:ymPetBob 3.6s ease-in-out infinite}
    #ymPet.drag .pet-float,#ymPet.sleepy .pet-float{animation:none}
    #ymPet.sleepy .pet-float{animation:ymPetSleep 5s ease-in-out infinite}
    #ymPet.hop .pet-body{animation:ymPetHop .55s ease-out}
    #ymPet .pet-shadow{width:46%;height:8px;border-radius:50%;background:radial-gradient(#0007,#0000 70%);margin-top:-4px}
    #ymPet .pet-bubble.guest{border-left:4px solid var(--guest,#8b5cf6);text-align:left}
    #ymPet .pet-bubble.act{pointer-events:auto}#ymPet .pet-chips{display:flex;gap:6px;margin-top:6px;justify-content:center;flex-wrap:wrap}
    #ymPet .pet-chips button{border:0;border-radius:99px;padding:2px 10px;background:#7955c7;color:#fff;font:inherit;cursor:pointer}#ymPet .pet-chips button.ghost{background:#0001;color:#4b4760}#ymPet .pet-bubble.guest b{color:var(--guest,#8b5cf6);margin-right:4px}
    #ymPet .pet-tag{display:none;margin-top:3px;max-width:100%;padding:1px 8px;border-radius:99px;font:11px/1.6 system-ui,"PingFang SC","Microsoft YaHei",sans-serif;color:#fff;background:var(--guest,#8b5cf6);box-shadow:0 2px 8px #0005;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none}#ymPet .pet-tag.show{display:block}
    #ymPet .pet-card{position:absolute;bottom:100%;left:50%;transform:translateX(-50%);width:228px;box-sizing:border-box;padding:10px 12px;margin-bottom:4px;border-radius:14px;background:#fffffff5;color:#2b2540;font:12px/1.5 system-ui,"PingFang SC","Microsoft YaHei",sans-serif;box-shadow:0 8px 26px #0006;text-align:left;display:none;z-index:2}#ymPet .pet-card.show{display:block}
    #ymPet .pet-card h4{margin:0 0 4px;font-size:13px}#ymPet .pet-card .pc-sec{margin-top:7px;padding-top:6px;border-top:1px solid #0001}#ymPet .pet-card small{color:#6b6880}
    #ymPet .pet-card .pc-row{display:grid;grid-template-columns:52px 1fr auto;align-items:center;gap:6px;margin:2px 0}
    #ymPet .pet-card .pc-bar{height:6px;border-radius:3px;background:#0001;overflow:hidden}#ymPet .pet-card .pc-bar i{display:block;height:100%;border-radius:3px;background:var(--c,#7955c7)}
    #ymPet .pet-card .pc-warn{margin-top:4px;color:#b45309}#ymPet .pet-card .pc-chip{display:inline-block;padding:0 7px;border-radius:99px;color:#fff;background:var(--guest,#8b5cf6);font-size:11px;margin-right:4px}
    #ymPet .pet-bubble{position:absolute;bottom:100%;left:50%;transform:translate(calc(-50% + var(--bx,0px)),-6px) scale(.9);max-width:230px;min-width:130px;background:#fffffff2;color:#2b2540;border-radius:14px;padding:7px 11px;font:13px/1.45 system-ui,"PingFang SC","Microsoft YaHei",sans-serif;box-shadow:0 6px 20px #0005;opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;text-align:center;white-space:normal}
    #ymPet .pet-bubble::after{content:"";position:absolute;left:calc(50% - var(--bx,0px));bottom:-6px;width:12px;height:12px;background:inherit;transform:translateX(-50%) rotate(45deg);border-radius:2px}
    #ymPet .pet-bubble.show{opacity:1;transform:translate(calc(-50% + var(--bx,0px)),-6px) scale(1)}
    #ymPet .pet-bubble.below{bottom:auto;top:100%;transform:translate(calc(-50% + var(--bx,0px)),6px) scale(.9)}#ymPet .pet-bubble.below.show{transform:translate(calc(-50% + var(--bx,0px)),6px) scale(1)}#ymPet .pet-bubble.below::after{bottom:auto;top:-6px}
    #ymPetMenu{position:fixed;z-index:70;background:#1b1d27;color:#e8e9ee;border:1px solid #2c2f3d;border-radius:12px;padding:6px;box-shadow:0 10px 30px #0008;font:13px system-ui,"PingFang SC","Microsoft YaHei",sans-serif;min-width:150px}
    #ymPetMenu button{display:block;width:100%;text-align:left;background:none;border:0;color:inherit;padding:7px 10px;border-radius:8px;cursor:pointer;font:inherit}#ymPetMenu button:hover{background:#ffffff14}
    #ymPet.walking .pet-float{animation:none}#ymPet.walking .pet-body{animation:ymPetWaddle .5s ease-in-out infinite}#ymPet.drag{transition:none!important}
    #ymPet.edge-left{transform:translateX(-25%)}#ymPet.edge-right{transform:translateX(25%)}
    #ymPet.emo-angry .pet-float,#ymPet.emo-sad .pet-float,#ymPet.emo-laugh .pet-float,#ymPet.emo-shy .pet-float,#ymPet.emo-surprised .pet-float{animation:none}
    #ymPet.emo-angry .pet-body{animation:ymPetShake .14s linear infinite}#ymPet.emo-sad .pet-body{animation:ymPetDroop 2.6s ease-in-out infinite}
    #ymPet.emo-laugh .pet-body{animation:ymPetLaugh .4s ease-in-out infinite}#ymPet.emo-shy .pet-body{animation:ymPetSway 1.6s ease-in-out infinite}#ymPet.emo-surprised .pet-body{animation:ymPetHop .55s ease-out}
    @keyframes ymPetShake{0%,100%{translate:0 0}25%{translate:-2px 0}75%{translate:2px 0}}
    @keyframes ymPetDroop{0%,100%{translate:0 0;scale:1 1}50%{translate:0 3px;scale:1 .985}}
    @keyframes ymPetLaugh{0%,100%{translate:0 0}50%{translate:0 -6px}}
    @keyframes ymPetSway{0%,100%{rotate:-2deg}50%{rotate:2deg}}
    @keyframes ymPetWaddle{0%,100%{translate:0 0}50%{translate:0 -3px}}
    @keyframes ymPetBob{50%{transform:translateY(-5px)}}@keyframes ymPetSleep{50%{transform:translateY(2px) scale(.99)}}
    @keyframes ymPetHop{0%{transform:translateY(0) scale(1,1)}25%{transform:translateY(0) scale(1.06,.92)}55%{transform:translateY(-22px) scale(.97,1.04)}85%{transform:translateY(0) scale(1.04,.95)}100%{transform:translateY(0) scale(1,1)}}
    @media (prefers-reduced-motion:reduce){#ymPet .pet-float{animation:none!important}#ymPet.hop .pet-body,#ymPet[class*=emo-] .pet-body{animation:none!important}}
    @media print{#ymPet{display:none!important}}`;
  document.head.append(style);

  const root = document.createElement('div'); root.id = 'ymPet'; root.setAttribute('role', 'img'); root.setAttribute('aria-label', '桌宠梦色 Desktop pet Yume');
  const bubble = Object.assign(document.createElement('div'), { className: 'pet-bubble', role: 'status' });
  const floatBox = Object.assign(document.createElement('div'), { className: 'pet-float' });
  const body = Object.assign(document.createElement('div'), { className: 'pet-body' });
  const img = Object.assign(document.createElement('div'), { className: 'pet-stage' });   // 舞台（翻面 / 当前姿势标记都放在它身上）
  const frameEls = {}; let curFrame = '';
  for (const [name, src] of Object.entries(FRAMES)) {
    const im = new Image(); im.alt = ''; im.draggable = false; im.decoding = 'async'; im.style.width = (SIZES[name] / 450 * 100) + '%'; im.src = src;
    frameEls[name] = im; img.append(im); if (im.decode) im.decode().catch(() => {});
  }
  body.append(img); floatBox.append(body);
  const card = Object.assign(document.createElement('div'), { className: 'pet-card', role: 'dialog' });
  const tag = Object.assign(document.createElement('div'), { className: 'pet-tag' });
  root.append(bubble, card, floatBox, Object.assign(document.createElement('div'), { className: 'pet-shadow' }), tag);
  document.body.append(root);

  const size = () => prefs.size;
  function place() {
    root.style.width = size() + 'px';
    const w = size(), h = w * 1.15 + 12;
    const x = prefs.x ?? window.innerWidth - w - 24, y = prefs.y ?? window.innerHeight - h - (host ? 8 : 104);
    root.style.left = Math.max(0, Math.min(window.innerWidth - w, x)) + 'px'; root.style.top = Math.max(0, Math.min(window.innerHeight - h, y)) + 'px';
  }
  place(); addEventListener('resize', place);
  root.classList.toggle('hidden', !prefs.enabled && !host);

  // ---- 表情与说话 ----
  let mode = 'idle', frameTimer = 0, bubbleTimer = 0, lastActive = Date.now(), sleeping = false;
  const setFrame = name => { const next = frameEls[name]; if (!next || curFrame === name) return; frameEls[curFrame]?.classList.remove('on'); next.classList.add('on'); curFrame = name; img.setAttribute('data-f', name); };
  // 气泡贴着屏幕左右边缘就横向挪回来；她在屏幕最上面就把气泡放到脚下
  function fitBubble() {
    const rr = root.getBoundingClientRect(), bw = bubble.offsetWidth, cx = rr.left + rr.width / 2, left = cx - bw / 2, right = cx + bw / 2;
    const shift = left < 6 ? 6 - left : right > innerWidth - 6 ? innerWidth - 6 - right : 0;
    bubble.style.setProperty('--bx', Math.round(shift) + 'px'); bubble.classList.toggle('below', rr.top - bubble.offsetHeight - 14 < 4);
  }
  function say(text, ms = 3200) {
    if (!text || prefs.mute) return;
    bubble.classList.remove('guest', 'act'); bubble.textContent = text; fitBubble(); bubble.classList.add('show'); clearTimeout(bubbleTimer); bubbleTimer = setTimeout(() => bubble.classList.remove('show'), ms);
  }
  function happy(ms = 1800) {
    clearEdgePose(); clearEmote(); sleeping = false; root.classList.remove('sleepy'); mode = 'happy'; setFrame('happy'); clearTimeout(frameTimer);
    if (!reduce) { root.classList.remove('hop'); void root.offsetWidth; root.classList.add('hop'); }
    frameTimer = setTimeout(() => { mode = 'idle'; setFrame(idleFrame()); root.classList.remove('hop'); }, ms);
  }
  function sleep() { if (mode === 'happy' || mode === 'emote' || sleeping) return; clearEdgePose(); sleeping = true; mode = 'sleepy'; root.classList.add('sleepy'); setFrame('sleepy'); say(pick(LINES.sleep), 2500); }
  function wake(greet, away = 0) {
    if (!sleeping) return; sleeping = false; root.classList.remove('sleepy'); mode = 'idle'; setFrame(idleFrame());
    if (!greet) return;
    if (away > 20 * 60000) { bump('joy', 18); emote('surprised', 2800, '你回来啦！好久不见 You\'re back!'); } else { say(pick(LINES.wake)); happy(1400); }
  }
  function blinkLoop() {
    setTimeout(() => { if (mode === 'idle' && !sleeping && !posing && !walking && idleFrame() === 'idle') { setFrame('blink'); setTimeout(() => { if (mode === 'idle' && !sleeping && !posing && !walking) setFrame(idleFrame()); }, 140); } blinkLoop(); }, 2600 + Math.random() * 3400);
  }
  blinkLoop();
  const touch = () => { const t = Date.now(), away = t - lastActive; lastActive = t; if (sleeping) wake(true, away); };
  for (const type of ['pointerdown', 'keydown', 'wheel']) addEventListener(type, touch, { passive: true, capture: true });
  setInterval(() => { if (!host && Date.now() - lastActive > 5 * 60000) sleep(); }, 5000);

  // ---- 情绪：喜 / 怒 / 哀 / 乐 ----
  // 三个会随时间回落的数值（0–100）：joy 开心、anger 生气、sad 难过。事件（回答完成 / 出错、被说好话 / 坏话、被一直戳 / 摸头、断网、久别重逢）让它们升降，
  // 在突然的“表情爆发”（emote）里用对应的立绘和台词表现出来；情绪足够强时会“挂”在脸上（待机姿势变成生气 / 难过）。数值存在本机。
  const clamp = v => Math.max(0, Math.min(100, v));
  const mood = { joy: 25, anger: 0, sad: 0, ...(prefs.mood || {}) };
  prefs.memory = mergeMem(prefs.memory, null);                                  // 情绪记忆（下面“情绪记忆”一节）：对她的好感度会抓起“开心基线”
  const baseJoy = () => 25 + Math.max(-100, Math.min(100, prefs.memory.affinity || 0)) * 0.15;
  let moodAt = prefs.moodAt || Date.now();
  // “对话气氛”：把最近几句话的情感平滑成 -1..1 的趋势（其中每句由 public/pet-sense.js 解析，含 emoji / 表情包 / 颜文字）。它在每 30 秒的心跳里持续拉动心情，
  // 所以情绪不只是“单句触发”：一段气氛愁云惨淡的对话会让她慢慢低落，聊得开心则越聊越高兴，气氛每 10 分钟衰减一半。
  let ctxV = Number(prefs.ctxV) || 0, ctxAt = prefs.ctxAt || Date.now(), lastEmoteAt = 0;
  const SENSE = () => window.YumeiroSense;
  function decayCtx() { const t = Date.now(); ctxV = SENSE() ? SENSE().decay(ctxV, (t - ctxAt) / 60000) : 0; ctxAt = t; }
  function decayMood() {   // 每分钟：怒气 -12、难过 -6、开心回到 25
    const min = Math.max(0, (Date.now() - moodAt) / 60000); moodAt = Date.now();
    mood.anger = clamp(mood.anger - 12 * min); mood.sad = clamp(mood.sad - 6 * min);
    mood.joy = mood.joy > baseJoy() ? Math.max(baseJoy(), mood.joy - 5 * min) : Math.min(baseJoy(), mood.joy + 3 * min);
  }
  const saveMood = () => { prefs.memory.lastSeen = Date.now(); prefs.mood = { joy: Math.round(mood.joy), anger: Math.round(mood.anger), sad: Math.round(mood.sad) }; prefs.moodAt = moodAt; prefs.ctxV = +ctxV.toFixed(3); prefs.ctxAt = ctxAt; save(); };
  function bump(kind, amount) {
    decayMood(); mood[kind] = clamp(mood[kind] + amount);
    if (kind === 'anger') mood.joy = clamp(mood.joy - amount / 2);
    if (kind === 'joy') { mood.anger = clamp(mood.anger - amount / 2); mood.sad = clamp(mood.sad - amount / 2); }
    saveMood();
  }
  const dominant = () => (mood.anger >= 55 ? 'angry' : mood.sad >= 55 ? 'sad' : null);
  const idleFrame = () => { const d = dominant(); return d === 'angry' ? 'angry1' : d === 'sad' ? 'sad1' : 'idle'; };
  let lastDom = dominant();
  const EMO = { angry: ['angry1', 'angry2'], sad: ['sad1', 'sad2'], laugh: ['laugh1', 'laugh2'], surprised: ['surprised'], shy: ['shy'], happy: ['happy'] };
  let emoLoop = 0, csrf = '';
  const clearEmote = () => { clearInterval(emoLoop); for (const k of Object.keys(EMO)) root.classList.remove('emo-' + k); };
  function haltWalk() {
    if (!walking) return;
    settleWalk();
    stopWalkAnim();
  }
  // 走到一半被打断：把“正在动画中的位置”固化成 left / top
  function settleWalk() {
    if (walkTarget == null) return;
    const r = root.getBoundingClientRect(); root.style.transition = 'none'; root.style.left = r.left + 'px'; root.style.top = r.top + 'px'; root.style.translate = ''; prefs.x = r.left; prefs.y = r.top; walkTarget = null; void root.offsetWidth; root.style.transition = '';
  }
  // 走完了：落地到目标位置
  function commitWalk() {
    if (walkTarget == null) return;
    const { x, y } = walkTarget; walkTarget = null; root.style.transition = 'none'; root.style.left = x + 'px'; root.style.top = y + 'px'; root.style.translate = ''; prefs.x = x; prefs.y = y; void root.offsetWidth; root.style.transition = ''; save();
  }
  // 表情爆发：两帧轮流显示 + 对应的动作效果 + 台词；ms 后回到待机
  function emote(kind, ms = 3200, text, hint) {
    if (!EMO[kind] || (root.classList.contains('hidden') && !host)) return;
    if (kind === 'happy') { happy(ms); say(text || pick(LINES.done)); return; }
    clearEdgePose(); haltWalk(); clearEmote(); clearTimeout(frameTimer); sleeping = false; root.classList.remove('sleepy', 'hop');
    mode = 'emote'; root.classList.add('emo-' + kind);
    const frames = EMO[kind]; let i = 0; setFrame(frames[0]);
    if (frames.length > 1) emoLoop = setInterval(() => setFrame(frames[++i % frames.length]), kind === 'angry' ? 280 : 450);
    say(text || pick(LINES[kind]), Math.min(ms, 4200));
    if (prefs.aiLines && Math.random() < 0.6) { if (host) { try { host.aiLine(kind, hint || ''); } catch { /* 旧版桌面端没有这个接口 */ } } else aiLine(kind, hint); }
    frameTimer = setTimeout(endEmote, ms);
  }
  function endEmote() { clearEmote(); if (mode === 'emote') { mode = 'idle'; setFrame(idleFrame()); } }
  // 可选：让聊天模型按情绪现编一句（消耗模型额度，默认关闭；桌面端的桌宠窗口没有登录态，不支持）
  async function aiLine(kind, hint) {
    const line = await aiLineFetch(kind, hint);
    if (line && mode === 'emote') say(line, 4200);
  }
  // 外部事件（聊天状态、用户说的话）→ 情绪
  function onEvent(type, text) {
    if (type === 'think' || type === 'done' || type === 'sense') lastChatAt = Date.now();
    if (type === 'sense') { try { applySense(JSON.parse(text)); } catch { /* 不是合法的分析结果：忽略 */ } return; }
    if (type === 'slow') { bump('sad', 4); if (mode === 'idle') say(pick(LINES.wait), 3000); return; }
    if (type === 'model') { try { onModel(JSON.parse(text)); } catch { /* 忽略 */ } return; }
    if (type === 'usage') { try { usageCache = JSON.parse(text); usageAt = Date.now(); } catch { /* 忽略 */ } return; }
    if (type === 'card') { showCard(); return; }
    if (type === 'memory') { try { prefs.memory = mergeMem(prefs.memory, JSON.parse(text)); save(); } catch { /* 忽略 */ } if (!greeted) setTimeout(startGreeting, 300); return; }
    if (type === 'forget') { forget(); return; }
    if (type === 'prefs') { try { const p = JSON.parse(text); prefs.aiLines = Boolean(p.aiLines); prefs.stickerVision = p.stickerVision !== false; prefs.proactive = p.proactive !== false; save(); } catch { /* 忽略 */ } return; }
    if (type === 'bye') { farewell(text); return; }
    if (type === 'todos') { try { todoInfo = JSON.parse(text); } catch { /* 忽略 */ } return; }
    if (type === 'focus') { try { onFocus(JSON.parse(text)); } catch { /* 忽略 */ } return; }
    if (type === 'todo-done') { bump('joy', 8); if (mode !== 'emote') emote('happy', 2400, pick(['又完成一件！👏 Nice!', '做得好～', '划掉一件啦！'])); return; }
    if (type === 'todo-due') { try { const d = JSON.parse(text); ask('due', '⏰ 到点啦：「' + String(d.title || '').slice(0, 24) + '」', [['知道了'], ['打开待办', openSide('todo')]], 'surprised', true); } catch { /* 忽略 */ } return; }
    if (type === 'streak') { const mins = Number(text) || 90; ask('streak', '你已经连续用了 ' + mins + ' 分钟啦，起来动一动、喝口水吧～', [['好的', () => bump('joy', 3)], ['再等等']], 'happy', true); return; }
    if (type === 'done') {
      // 回答完成的开心要看对话气氛：刚被批评、或用户正低落时，她不会马上蹦跳着说“搞定”；表情爆发还没结束时也不打断
      decayCtx();
      if (countReply()) return;                       // 和当前模型角色的默契升级了：不再重复表态
      if (mode === 'emote' || ctxV < -0.2 || mood.anger >= 30 || mood.sad >= 30) { bump('joy', 2); return; }
      bump('joy', 12); if (mood.joy >= 60 && Math.random() < 0.6) emote('laugh', 3000, text || pick(LINES.done)); else { happy(2200); say(text || pick(LINES.done)); }
    }
    else if (type === 'think') say(text || pick(LINES.think), 2400);
    else if (type === 'error') { bump('sad', 28); remember('error', -0.3, ''); emote('sad', 4200, pick(LINES.error), '回答出错了'); }
    else if (type === 'praise') { bump('joy', 22); emote('laugh', 3400, pick(LINES.praise), '用户夸了她'); }
    else if (type === 'scold') { bump('anger', 16); bump('sad', 14); emote(mood.anger > mood.sad ? 'angry' : 'sad', 3800, pick(LINES.scold), '用户骂了她'); }
    else if (type === 'comfort') { bump('joy', 30); remember('comfort', 0.5, ''); emote('shy', 3400, pick(LINES.comfort)); }
  }
  // ---- 模型角色 + rua 卡片（用量 / 心情 / 陷伴）----
  // 切换模型 = 和一位“模型角色”打招呼：角色牌（名字 + 默契等级）、她的介绍表情、角色自己的开场白（带角色色的气泡）。
  // 每次一起完成的回答都会累计和这位角色的默契（Lv.1~5）。rua（在她身上来回滑动）会弹出卡片：心情、用量、当前角色、陷伴统计。
  prefs.stats ||= { since: Date.now(), rua: 0, replies: 0 }; prefs.friends ||= {};
  let curPersona = null, usageCache = null, usageAt = 0, cardTimer = 0, tagTimer = 0;
  const SN = () => window.YumeiroSense;
  const friendOf = p => (prefs.friends[p.key] ||= { n: 0, seen: 0, name: p.name });
  function showTag(p, ms = 6000) {
    if (!p) return; const f = friendOf(p), lv = SN() ? SN().bondLevel(f.n) : 0;
    tag.textContent = '● ' + p.name + (p.engine ? ' · ' + p.engine : '') + (lv ? ' · Lv.' + lv : ''); tag.style.setProperty('--guest', p.color); tag.classList.add('show');
    clearTimeout(tagTimer); if (ms) tagTimer = setTimeout(() => tag.classList.remove('show'), ms);
  }
  function sayGuest(p, text, ms = 4200) {
    if (prefs.mute) return;
    const name = document.createElement('b'); name.textContent = p.name;
    bubble.replaceChildren(name, document.createTextNode(text)); bubble.style.setProperty('--guest', p.color); bubble.classList.add('guest'); fitBubble(); bubble.classList.add('show');
    clearTimeout(bubbleTimer); bubbleTimer = setTimeout(() => bubble.classList.remove('show'), ms);
  }
  function onModel({ n = '', r = '', e = '', q = 0 }) {
    if (!SN()) return;
    const p = SN().persona(r, n), same = curPersona && curPersona.key === p.key;
    curPersona = { ...p, engine: e };
    if (q || same) { if (!q) showTag(curPersona, 4000); return; }            // 启动时的静默同步 / 只换了引擎：不打招呼
    const f = friendOf(p), first = !f.seen, lv = SN().bondLevel(f.n); f.seen = Date.now(); f.name = p.name; save();
    showTag(curPersona, 7000); bump('joy', first ? 6 : 3);
    if (dominant() === 'angry') { say('哼…换成 ' + p.name + ' 了？随便你。 Whatever.', 3200); return; }
    const intro = first ? p.name + '，第一次见面！' + p.intro : lv >= 3 ? p.name + ' 回来啦，我们最有默契了～' : '又是 ' + p.name + '～' + p.title;
    emote(p.emotion, 3200, intro, '用户切换到了模型角色 ' + p.name);
    setTimeout(() => { if (curPersona && curPersona.key === p.key && !sleeping) sayGuest(p, first || lv < 2 ? p.hello : pick([p.hello, '又见面啦 Hi again!']), 4200); }, 2700);
  }
  // 一次回答完成：累计陷伴统计和与当前角色的默契；升级时返回 true（已经表态）
  function countReply() {
    prefs.stats.replies++;
    if (!curPersona || !SN()) { save(); return false; }
    const f = friendOf(curPersona), before = SN().bondLevel(f.n); f.n++; const after = SN().bondLevel(f.n); save();
    if (after <= before) return false;
    happy(2400); say('和 ' + curPersona.name + ' 的默契升到 Lv.' + after + ' 啦！ Bond Lv.' + after + '!', 3800); showTag(curPersona, 5000);
    return true;
  }
  const pct = (a, b) => (b > 0 ? Math.min(100, Math.round(a / b * 100)) : 0);
  const mk = (tagName, cls, text) => { const node = document.createElement(tagName); if (cls) node.className = cls; if (text != null) node.textContent = text; return node; };
  function bar(parent, label, text, percent, color) { const b = mk('div', 'pc-bar'), i = document.createElement('i'); i.style.width = percent + '%'; if (color) i.style.setProperty('--c', color); b.append(i); parent.append(Object.assign(mk('div', 'pc-row'), {})); parent.lastChild.append(mk('span', null, label), b, mk('small', null, text)); }
  const level = p => (p >= 90 ? '#dc2626' : p >= 70 ? '#f59e0b' : '#7955c7');
  async function loadUsage() {
    if (host) return usageCache;                                        // 桌面端的桌宠窗口没有登录态：用量由主窗口定时推送
    if (usageCache && Date.now() - usageAt < 20000) return usageCache;
    try { usageCache = await fetchUsage(); usageAt = Date.now(); } catch { /* 未登录：继续用旧的或空的 */ }
    return usageCache;
  }
  function buildCard(u) {
    decayMood(); const d = dominant();
    card.replaceChildren(mk('h4', null, '梦色 · ' + (d === 'angry' ? '😠 生气' : d === 'sad' ? '😢 难过' : mood.joy >= 60 ? '😄 很开心' : '🙂 平静')));
    bar(card, '开心', String(Math.round(mood.joy)), mood.joy, '#f59e0b'); bar(card, '怒气', String(Math.round(mood.anger)), mood.anger, '#ef4444'); bar(card, '难过', String(Math.round(mood.sad)), mood.sad, '#3b82f6');
    const use = mk('div', 'pc-sec'); use.append(mk('small', null, u ? '用量 · ' + u.m : '用量'));
    if (u) {
      bar(use, '今日调用', u.c + (u.dl ? ' / ' + u.dl : ''), pct(u.c, u.dl), level(pct(u.c, u.dl)));
      bar(use, '本月调用', u.mc + (u.ml ? ' / ' + u.ml : ''), pct(u.mc, u.ml), level(pct(u.mc, u.ml)));
      bar(use, '本月 Token', fmtNum(u.t) + (u.tl ? ' / ' + fmtNum(u.tl) : ''), pct(u.t, u.tl), level(pct(u.t, u.tl)));
      if (!u.dl && !u.ml && !u.tl) use.append(mk('small', null, '主账号没有给你设置额度上限'));
      for (const [label, percent] of u.a || []) use.append(mk('div', 'pc-warn', '⚠ ' + label + ' 已用 ' + percent + '%'));
      if (u.b) use.append(mk('div', 'pc-warn', '⚠ 额度已用完，暂时不能继续对话'));
    } else use.append(mk('div', null, host ? '（等主窗口同步用量…）' : '登录后可以看到用量'));
    const who = mk('div', 'pc-sec');
    if (curPersona) {
      const f = friendOf(curPersona), lv = SN() ? SN().bondLevel(f.n) : 0, chip = mk('span', 'pc-chip', curPersona.name + (curPersona.engine ? ' · ' + curPersona.engine : ''));
      chip.style.setProperty('--guest', curPersona.color);
      who.append(mk('small', null, '当前模型角色'), mk('div'), mk('div'));
      who.children[1].append(chip, mk('span', null, curPersona.title)); who.children[2].append(mk('small', null, '默契 Lv.' + lv + ' · 一起完成 ' + f.n + ' 次回答 · ' + curPersona.model));
    } else who.append(mk('small', null, '当前模型角色'), mk('div', null, '切换一下模型，我们打个招呼～'));
    const days = Math.max(1, Math.ceil((Date.now() - (prefs.stats.since || Date.now())) / 864e5));
    // 她记得的事：好感度 + 最近几条情绪回忆
    decayAffinity(); const aff = Math.round(prefs.memory.affinity || 0), mem = mk('div', 'pc-sec');
    mem.append(mk('small', null, '她记得'));
    bar(mem, '好感度', (aff > 0 ? '+' : '') + aff, (aff + 100) / 2, aff < 0 ? '#ef4444' : '#ec4899');
    const recent = prefs.memory.events.slice(0, 3);
    if (recent.length) for (const e of recent) mem.append(mk('div', null, when(e.t) + ' · ' + (MEM_LABEL[e.k] || e.k) + (e.s ? ' ' + quote(e) : '')));
    else mem.append(mk('small', null, '还没有特别的回忆，多聊聊吧～'));
    card.append(use, who, mem, Object.assign(mk('div', 'pc-sec'), {}));
    card.lastChild.append(mk('small', null, '陪伴 ' + days + ' 天 · 被 rua ' + prefs.stats.rua + ' 次 · 一起答了 ' + prefs.stats.replies + ' 次'));
  }
  async function showCard() {
    clearTimeout(cardTimer); await loadUsage(); buildCard(usageCache);
    bubble.classList.remove('show'); card.classList.add('show');
    card.style.marginLeft = '0px'; card.style.bottom = ''; card.style.top = '';
    {                                                                  // 别超出屏幕；贴着顶部时改到她脚下
      const r = card.getBoundingClientRect(); let shift = 0;
      if (r.left < 6) shift = 6 - r.left; else if (r.right > innerWidth - 6) shift = innerWidth - 6 - r.right;
      card.style.marginLeft = shift + 'px';
      if (r.top < 4) { card.style.bottom = 'auto'; card.style.top = '100%'; }
    }
    if (curPersona) showTag(curPersona, 0);
    cardTimer = setTimeout(hideCard, 9000);
  }
  function hideCard() { clearTimeout(cardTimer); if (!card.classList.contains('show')) return; card.classList.remove('show'); tag.classList.remove('show'); }
  card.addEventListener('pointerenter', () => clearTimeout(cardTimer)); card.addEventListener('pointerleave', () => { clearTimeout(cardTimer); cardTimer = setTimeout(hideCard, 2500); });
  // rua：在她身上来回滑动鼠标。害羞 + 开心（有冷却），并弹出卡片
  function rua() {
    const t = Date.now(); prefs.stats.rua++; save();
    if (t > petCool) { petCool = t + 15000; bump('joy', 16); emote('shy', 3400, pick(LINES.shy), '被摸头'); }
    showCard();
  }

  // ---- 情绪记忆：让她记得之前聊过的事，而不是每次都从零开始 ----
  // 只记“带情绪的事”（被说好话 / 坏话、你低落、被哄、表情包、重问、出错）和一句 ≤ 40 字的摘要，不记完整对话；最多 40 条、保留 30 天。
  // 它们带来三种效果：① 好感度抬高 / 拉低她的“开心基线”；② 隔了一阵再见时主动提起（“昨天你好像不太开心…”）；③ 聊到相似的话题时回忆。
  // 网页 / 桌面端通过 /api/pet/memory 共用同一份（桌面端经主窗口中转）；右键菜单可以一键忘掉。
  const MEM_LABEL = { scold: '被批评', praise: '被夸奖', sad: '你不开心', comfort: '被哄好', error: '出错', repeat: '被重问', sticker: '表情包' };
  const AFFINITY = { praise: 6, comfort: 4, scold: -8, repeat: -2, error: -1 };
  let memTimer = 0, recallAt = 0;
  function memChanged() {
    prefs.memory.at = Date.now(); save(); clearTimeout(memTimer);
    memTimer = setTimeout(() => { if (host) { try { host.memory(JSON.stringify(prefs.memory)); } catch { /* 旧版桌面端 */ } } else memPush(prefs.memory); }, 4000);
  }
  function decayAffinity() { const m = prefs.memory, t = Date.now(), days = Math.max(0, (t - (m.affAt || t)) / 864e5); m.affinity = Math.round((m.affinity || 0) * Math.pow(0.5, days / 7)); m.affAt = t; }   // 好感度每 7 天回落一半
  function remember(kind, v, text) {
    const m = prefs.memory, now = Date.now();
    if (m.events.some(e => e.k === kind && now - e.t < 60000)) return;      // 同一类事 1 分钟内只记一次
    m.events.unshift({ t: now, k: kind, v: Math.round(v * 100) / 100, s: String(text || '').replace(/\s+/g, ' ').trim().slice(0, 40), p: (curPersona?.key || '').replace(/[^a-z0-9:_.-]/gi, '').slice(0, 30) });
    m.events.length = Math.min(m.events.length, 40);
    decayAffinity(); m.affinity = Math.max(-100, Math.min(100, Math.round((m.affinity || 0) + (AFFINITY[kind] || 0) + (kind === 'sticker' ? v * 4 : 0))));
    memChanged();
  }
  const when = t => { const h = (Date.now() - t) / 36e5; return h < 1 ? '刚才' : h < 20 ? Math.round(h) + ' 小时前' : h < 44 ? '昨天' : Math.round(h / 24) + ' 天前'; };
  const quote = e => (e.s ? '「' + e.s + '」' : '');
  // 聊到跟以前记住的事相似的话题（字串相似度）时，提一句；90 秒内只提一次，不缠着不放
  function recall(text) {
    const sense = SN(), t = String(text || '').trim(), now = Date.now();
    if (!sense || t.length < 4 || now - recallAt < 90000 || mode === 'emote') return false;
    const hit = prefs.memory.events.find(e => e.s && e.s !== t && now - e.t > 5 * 60000 && sense.similarity(e.s, t) >= 0.3);
    if (!hit) return false;
    recallAt = now;
    const lines = {
      sad: ['sad', '又说到这个了…' + when(hit.t) + '你提到' + quote(hit) + '的时候好像有点低落，现在好些了吗？'],
      scold: ['sad', '这个话题我记得…' + when(hit.t) + '你对我说' + quote(hit) + '，我还记着呢。'],
      praise: ['shy', '这个我记得！' + when(hit.t) + '你夸过我' + quote(hit) + '，开心了好久～'],
      comfort: ['shy', '嘿嘿，' + when(hit.t) + '你哄过我呢～'],
      sticker: ['surprised', '这让我想起' + when(hit.t) + '你发的那张表情包' + quote(hit)],
      repeat: ['sad', '这个问题…' + when(hit.t) + '你也问过，这次我一定答好！'],
      error: ['sad', '这个上次好像出过错…这次我会小心的。']
    }[hit.k];
    if (lines) emote(lines[0], 4200, lines[1], '想起了之前聊过的事');
    return Boolean(lines);
  }
  // 隔了一阵再见（每 6 小时最多一次）：优先提起最近没解决的事，其次是开心的事，再就是“好久不见”
  function memoryGreeting() {
    const m = prefs.memory, now = Date.now(), away = m.lastSeen ? now - m.lastSeen : 0;
    m.lastSeen = now;
    if (m.greetedAt && now - m.greetedAt < 6 * 3600e3) { memChanged(); return null; }
    decayAffinity();
    const recent = m.events.filter(e => now - e.t < 3 * 864e5), lastSad = recent.find(e => e.k === 'sad'), scold = recent.find(e => e.k === 'scold' && now - e.t < 36 * 3600e3), praise = recent.find(e => e.k === 'praise' && now - e.t < 48 * 3600e3);
    const resolved = lastSad && recent.some(e => e.t > lastSad.t && (e.k === 'praise' || e.k === 'comfort'));
    let g = null;
    if (lastSad && !resolved && now - lastSad.t > 3600e3) g = { emo: 'sad', text: when(lastSad.t) + '你好像不太开心' + (lastSad.s ? '（提到' + quote(lastSad) + '）' : '') + '…今天好一点了吗？' };
    else if (scold && m.affinity < 0) g = { emo: 'sad', text: when(scold.t) + '你说过' + quote(scold) + '…我还有点在意，不过今天重新开始吧。' };
    else if (praise) g = { emo: 'shy', text: '还记得' + when(praise.t) + '你夸我' + quote(praise) + '吗？我开心了好久～' };
    else if (away > 3 * 864e5) g = { emo: 'surprised', text: '好久不见啦，上次见面是 ' + Math.round(away / 864e5) + ' 天前～ I missed you!' };
    else if (m.affinity >= 40) g = { emo: 'shy', text: '最喜欢和你一起了～' };
    if (g) m.greetedAt = now;
    memChanged(); return g;
  }
  function forget() {
    const now = Date.now(); prefs.memory = { affinity: 0, events: [], at: now, clearedAt: now, lastSeen: now, greetedAt: 0, affAt: now };
    save(); memChanged(); say('好，我都忘掉啦，重新认识一下吧～ Forgotten!', 3200);
  }
  let greeted = false;
  function startGreeting() {                                              // 启动后第一次打招呼：有该提的记忆就提，没有就用原来的按时间问候
    if (greeted) return; greeted = true;
    const g = memoryGreeting();
    if (g) { prefs.talk.at = Date.now(); emote(g.emo, 4200, g.text, '以前聊过的事'); return true; }
    return false;
  }

  // ---- 主动找你说话：根据她记得的事和当前情况开口，不总等你先说 ----
  // 节制规则：空闲、你在场、没静音、不在 2–7 点；距上次主动说话至少 25 分钟，一小时最多 3 次；点“晚点/再等等”会安静 1 小时；菜单里可以整个关掉。
  // 话题按优先级选：关心你之前的低落 → 待办 → 额度提醒 → 饭点/熜夜 → 纪念日 → 回忆被夸 → “在忙吗”。每个话题都有自己的冷却时间。
  prefs.talk ||= { at: 0, hour: [], topics: {}, snooze: 0 };
  let todoInfo = { open: 0, first: '' }, lastChatAt = Date.now();
  const bootAt = Date.now();
  function canTalk(now, force) {
    const t = prefs.talk, h = new Date().getHours();
    if (prefs.proactive === false || prefs.mute || now < (t.snooze || 0) || root.classList.contains('hidden')) return false;
    if (mode !== 'idle' || sleeping || walking || posing || drag || card.classList.contains('show') || (!host && document.hidden)) return false;
    if (h >= 2 && h < 7) return false;
    if ((t.hour || []).filter(x => now - x < 3600e3).length >= 3) return false;
    if (now - (t.at || 0) < (force ? 8 : 25) * 60000) return false;
    if (!host && now - lastActive > 15 * 60000) return false;                     // 你不在电脑前：不说
    return true;
  }
  // 带按钮的气泡：有动作的按钮是主要选项；没有动作的（“晚点”“再等等”）是淡色按钮，点了她安静 1 小时
  function showAsk(text, chips, ms = 13000) {
    const row = document.createElement('div'); row.className = 'pet-chips';
    for (const [label, fn] of chips) {
      const b = mk('button', fn ? '' : 'ghost', label); b.type = 'button';
      b.addEventListener('pointerdown', e => e.stopPropagation());
      b.addEventListener('click', e => { e.stopPropagation(); clearTimeout(bubbleTimer); bubble.classList.remove('show', 'act'); endEmote(); if (fn) fn(); else { prefs.talk.snooze = Date.now() + 60 * 60000; save(); } });
      row.append(b);
    }
    bubble.classList.remove('guest'); bubble.replaceChildren(document.createTextNode(text), row); fitBubble(); bubble.classList.add('show', 'act');
    clearTimeout(bubbleTimer); bubbleTimer = setTimeout(() => bubble.classList.remove('show', 'act'), ms);
  }
  function ask(topic, text, chips, emo = 'surprised', force = false) {
    const now = Date.now(), t = prefs.talk;
    if (!canTalk(now, force)) return false;
    t.at = now; t.topics[topic] = now; t.hour = (t.hour || []).filter(x => now - x < 3600e3).concat(now); save();
    emote(emo, 13000, text); showAsk(text, chips);
    return true;
  }
  const starter = text => { lastChatAt = Date.now(); if (host) { try { host.starter(text); } catch { /* 旧版桌面端 */ } } else fillStarter(text); };
  const openSide = tab => () => { if (host) { try { host.starter(''); } catch { /* 旧版桌面端 */ } } else if (window.YumeiroSide) window.YumeiroSide.open(tab); };
  function pickTopic(now) {
    const t = prefs.talk, m = prefs.memory, h = new Date().getHours(), last = id => now - (t.topics[id] || 0), HOUR = 3600e3;
    const recent = m.events.filter(e => now - e.t < 2 * 864e5), lastSad = recent.find(e => e.k === 'sad');
    const solved = lastSad && m.events.some(e => e.t > lastSad.t && (e.k === 'praise' || e.k === 'comfort'));
    if (lastSad && !solved && now - lastSad.t > 3 * HOUR && last('care') > 20 * HOUR) return { id: 'care', emo: 'sad', text: when(lastSad.t) + '你好像有点低落' + (lastSad.s ? '（提到' + quote(lastSad) + '）' : '') + '…现在好些了吗？', chips: [['好多了', () => { remember('comfort', 0.5, ''); bump('joy', 15); emote('happy', 2600, '太好了！ So glad!'); }], ['想聊聊', () => starter('我之前有点不开心，想和你聊聊')], ['晚点']] };
    if (todoInfo.open > 0 && last('todo') > 3 * HOUR && h >= 9 && h < 22) return { id: 'todo', emo: 'surprised', text: '还有 ' + todoInfo.open + ' 件待办没做' + (todoInfo.first ? '，比如「' + todoInfo.first + '」' : '') + '，要不要先做一件？', chips: [['打开待办', openSide('todo')], ['晚点']] };
    const alert = usageCache && (usageCache.a || [])[0];
    if (alert && last('usage') > 20 * HOUR) return { id: 'usage', emo: 'surprised', text: '提醒一下：' + alert[0] + '已用 ' + alert[1] + '%…省着点用哦。', chips: [['看看用量', () => showCard()], ['知道啦']] };
    if (h >= 11 && h < 13 && last('lunch') > 20 * HOUR) return { id: 'lunch', emo: 'happy', text: '中午啦，吃饭了吗？', chips: [['这就去', () => bump('joy', 3)], ['吃什么好？', () => starter('中午吃什么好？给我几个建议')]] };
    if (h >= 17 && h < 19 && last('dinner') > 20 * HOUR) return { id: 'dinner', emo: 'happy', text: '快下班啦，晚饭想吃点什么？', chips: [['帮我想想', () => starter('晚饭吃什么好？给我几个建议')], ['知道啦']] };
    if ((h >= 23 || h < 2) && last('sleep') > 20 * HOUR) return { id: 'sleep', emo: 'sad', text: '已经这么晚了…早点休息吧，明天再继续～ Get some sleep.', chips: [['马上睡', () => bump('joy', 3)], ['再等等']] };
    const days = Math.floor((now - (prefs.stats.since || now)) / 864e5);
    if ([7, 30, 100, 365].includes(days) && last('days' + days) > 300 * 864e5) return { id: 'days' + days, emo: 'shy', text: '今天是我们认识的第 ' + days + ' 天！谢谢你一直陪着我～', chips: [['我也是', () => { bump('joy', 12); remember('comfort', 0.4, ''); }]] };
    const praise = recent.find(e => e.k === 'praise');
    if (praise && (m.affinity || 0) > 10 && last('recall') > 24 * HOUR) return { id: 'recall', emo: 'shy', text: '我还记得' + when(praise.t) + '你夸我' + quote(praise) + '…一想起来就开心～', chips: [['应该的～', () => bump('joy', 6)]] };
    if (now - lastChatAt > 40 * 60000 && last('lonely') > 4 * HOUR && (m.affinity || 0) >= 0) return { id: 'lonely', emo: 'surprised', text: pick(['在忙吗？需要我帮忙就叫我～', '好安静呀…要不要聊两句？', '我在这儿，随时可以聊～']), chips: [['聊两句', () => starter(pick(['来聊一聊吧', '陪我聊聊天']))], ['忙着呢']] };
    return null;
  }
  setInterval(() => {
    const now = Date.now();
    if (now - bootAt < 120000 || Math.random() > 0.5 || !canTalk(now, false)) return;
    const topic = pickTopic(now); if (topic) ask(topic.id, topic.text, topic.chips, topic.emo);
  }, 60000);
  // 专注（番茄钟）的节点
  function onFocus(d) {
    if (d.phase === 'work-start') { bump('joy', 3); say('开始专注 ' + (d.minutes || 25) + ' 分钟，我陪着你～ Focus time!', 3000); }
    else if (d.phase === 'work-end') { bump('joy', 12); emote('happy', 6000, '专注完成！🍅 今天第 ' + (d.done || 1) + ' 个。休息建议：' + restTip()); }
    else if (d.phase === 'rest-end') say('休息结束，要继续吗？加油～', 3200);
  }
  // 退出动画（桌面端）：主进程在退出前发来 bye：先原地告别约 1.1 秒，再朝 dir 方向走出屏幕并淡出
  function farewell(dir) {
    const m = prefs.memory; m.lastSeen = Date.now(); save(); try { if (host) host.memory(JSON.stringify(m)); } catch { /* 忽略 */ }
    const d = dominant(), aff = m.affinity || 0;
    const line = d === 'angry' ? '哼…走就走。 Fine.' : d === 'sad' ? '要走了吗…下次早点来哦。 Come back soon…' : aff >= 40 ? '舍不得你…明天见！ See you tomorrow!' : pick(['拜拜～下次见！ Bye!', '我先下班啦，记得休息～', '再见啦，明天继续陪你！']);
    prefs.talk.snooze = Date.now() + 3600e3; hideCard();
    emote(d === 'sad' ? 'sad' : d === 'angry' ? 'angry' : 'happy', 1100, line);
    setTimeout(() => {
      clearEmote(); mode = 'idle'; const left = dir ? dir === 'left' : root.offsetLeft + root.offsetWidth / 2 < innerWidth / 2;   // 没指定方向就朝最近的屏幕边缘走
      startWalkAnim(1500, left ? -1 : 1);
      root.style.transition = 'translate 1500ms linear, opacity .45s'; root.style.translate = (left ? -(root.offsetLeft + root.offsetWidth + 40) : innerWidth - root.offsetLeft + 40) + 'px 0';
      setTimeout(() => { root.style.opacity = '0'; }, 1050);
    }, 1120);
  }

  // 把一句用户的话（已解析成 情感 v / 激动 a / 对象 o / 建议表情 e / 是否重问 r）化为心情变化和表情
  function applySense({ v = 0, a = 0.3, o = 'none', e = '', r = 0, ai = 0, st = 0, c = '', s = '' }) {
    decayCtx(); v = Math.max(-1, Math.min(1, Number(v) || 0)); a = Math.max(0, Math.min(1, Number(a) || 0));
    if (r) { v = Math.min(v, -0.3); o = 'pet'; e = 'sad'; }          // 几乎原样重问：她没答对
    const cap = st && c ? '看到「' + String(c).slice(0, 16) + '」 ' : '';                 // 表情图：把看到的画面说出来
    const w = o === 'pet' ? 0.5 : 0.35;
    ctxV = Math.max(-1, Math.min(1, ctxV * (1 - w * (ai ? 0.5 : 1)) + v * w * (ai ? 0.5 : 1))); ctxAt = Date.now();
    const mag = Math.abs(v), now = Date.now(), canEmote = (now - lastEmoteAt > 12000 || st) && mode !== 'emote';
    if (!ai) {                                                           // 值得记住的事写进情绪记忆（AI 纠偏那一次不再重复记）
      if (st && mag >= 0.4) remember('sticker', v, c);
      else if (o === 'pet' && v <= -0.4) remember('scold', v, s);
      else if (o === 'pet' && v >= 0.4) remember('praise', v, s);
      else if (o !== 'pet' && v <= -0.4) remember('sad', v, s);
      if (r) remember('repeat', v, s);
    }
    const show = (kind, ms, text, hint) => { if (!canEmote) return; lastEmoteAt = now; emote(kind, ms, cap + (text || pick(LINES[kind])), hint); };
    if (v > 0.12) {
      bump('joy', v * (ai ? 10 : 18));
      if (e === 'shy') show('shy', 3200, pick(LINES.shy), '用户夸她');
      else if (e === 'laugh' || v > 0.55) show('laugh', 3200, o === 'pet' ? pick(LINES.praise) : pick(LINES.laugh), '用户很开心');
      else if (v > 0.3 && canEmote) { lastEmoteAt = now; happy(1800); say(cap + (o === 'pet' ? pick(LINES.thanks) : pick(LINES.done)), 2600); }
    } else if (v < -0.12) {
      if (o === 'pet') {
        bump('anger', mag * 16 * (0.6 + a * 0.8)); bump('sad', mag * 14 * (1.2 - a));   // 激动的批评让她生气，平淡的批评让她委屈
        if (r) show('sad', 3600, pick(LINES.repeat), '用户重复了同一个问题'); else if (mag > 0.4) show(mood.anger > mood.sad ? 'angry' : 'sad', 3800, pick(LINES.scold), '用户在批评她');
      } else {
        bump('sad', mag * 9);                                                            // 用户在说自己的低落：她跟着难过，并安慰他
        if (mag > 0.35) show('sad', 3400, pick(LINES.empathy), '用户看起来很低落，她在安慰');
      }
    } else if (e === 'surprised') show('surprised', 2600);
    if (!ai && !st) recall(s);                                           // 这句话如果跟以前记住的事很像，她会提起来
  }
  // “心跳”：对话气氛持续影响心情（气氛越强拉得越狠）。气氛和心情数值都会自己回落，所以这是一条慢慢变化的曲线
  function driftMood() {
    decayCtx();
    if (ctxV > 0.2) { mood.joy = clamp(mood.joy + 6 * ctxV); mood.anger = clamp(mood.anger - 3 * ctxV); mood.sad = clamp(mood.sad - 3 * ctxV); }
    else if (ctxV < -0.2) mood.sad = clamp(mood.sad + 5 * -ctxV);
  }
  setInterval(() => {
    decayMood(); driftMood(); const d = dominant();
    if (d !== lastDom) {
      if (lastDom && !d && mode === 'idle') say(lastDom === 'angry' ? '好啦，不气了 Okay, I\'m fine' : '好多了，谢谢你 Feeling better', 3200);
      lastDom = d; if (mode === 'idle' && !walking && !posing) setFrame(idleFrame());
    } else if (d && mode === 'idle' && !walking && !posing && !sleeping && Math.random() < 0.12) say(pick(LINES[d === 'angry' ? 'grumble' : 'mutter']), 3000);
    saveMood();
  }, 30000);
  setFrame(idleFrame());

  // ---- 自己走动 ----
  let walking = false, walkEnd = 0, walkFrameTimer = 0, edgeTimer = 0, walkFrame = 0, walkTarget = null;
  const SPEED = 70; // 像素 / 秒
  let posing = false;
  function clearEdgePose() { clearTimeout(edgeTimer); posing = false; root.classList.remove('edge-left', 'edge-right'); img.style.transform = ''; }
  function stopWalkAnim() {
    walking = false; clearTimeout(walkEnd); clearInterval(walkFrameTimer); root.classList.remove('walking');
    if (mode === 'idle' && !posing) setFrame(idleFrame());
  }
  // 走到屏幕边缘后：探头张望（贴边，露出半个身子）或坐在边沿晃腿休息。side: 'left' | 'right' | null
  function showEdgePose(side) {
    clearEdgePose();
    if (!side || mode !== 'idle' || sleeping || drag) { if (mode === 'idle') setFrame(idleFrame()); return; }
    const sit = Math.random() < 0.5;
    posing = true;
    // 探头图里“墙”在右边：右边缘直接用，左边缘需要镜像；坐姿默认朝右，右边缘镜像后朝向屏幕里面
    if (sit) { if (side === 'right') img.style.transform = 'scaleX(-1)'; setFrame('sit'); if (Math.random() < 0.6) say('歇一会儿～ Taking a break', 2600); }
    else { root.classList.add('edge-' + side); if (side === 'left') img.style.transform = 'scaleX(-1)'; setFrame('peek'); }
    edgeTimer = setTimeout(() => { clearEdgePose(); if (mode === 'idle' && !walking) setFrame(idleFrame()); }, sit ? 9000 : 4200);
  }
  const edgeSide = () => { const x = root.offsetLeft, w = root.offsetWidth; return x <= 8 ? 'left' : x >= innerWidth - w - 8 ? 'right' : null; };
  function startWalkAnim(ms, dir) {
    clearEdgePose(); walking = true; root.classList.add('walking'); img.style.transform = dir < 0 ? 'scaleX(-1)' : '';
    clearInterval(walkFrameTimer); walkFrame = 0;
    walkFrameTimer = setInterval(() => { if (mode === 'idle') { setFrame('walk' + ((walkFrame++ % 4) + 1)); } }, 130);
    clearTimeout(walkEnd); walkEnd = setTimeout(() => { stopWalkAnim(); commitWalk(); showEdgePose(edgeSide()); if (Math.random() < 0.35) say(pick(LINES.click), 2400); }, ms + 80);
  }
  function tryWalk(force) {
    if (!force && (prefs.walk === false || dominant() === 'sad' || walking || sleeping || mode !== 'idle' || drag || (!host && document.hidden) || root.classList.contains('hidden'))) return false;
    const w = root.offsetWidth, h = root.offsetHeight, cx = root.offsetLeft, cy = root.offsetTop, maxX = innerWidth - w, maxY = innerHeight - h;
    if (host && prefs.roam !== 'bottom') {                              // 桌面端：在整个屏幕里挑一个点走过去（水平 + 垂直）；每次最多走一段，像在屏幕上溜达
      const tx = Math.max(0, Math.min(maxX, cx + (Math.random() * 2 - 1) * 1100)), ty = Math.round(maxY * (Math.random() < 0.25 ? cy / Math.max(1, maxY) : 0.12 + Math.random() * 0.88));   // 四分之一的时间只左右走，其余时间在屏幕的大部分高度里随机挑一个点
      const dist = Math.hypot(tx - cx, ty - cy); if (dist < 90) return false;
      clearEdgePose(); const ms = dist / (SPEED * 1.4) * 1000; walkTarget = { x: Math.round(tx), y: Math.round(ty) };
      root.style.transition = 'translate ' + ms + 'ms linear'; root.style.translate = (tx - cx) + 'px ' + (ty - cy) + 'px'; startWalkAnim(ms, tx < cx ? -1 : 1); return true;
    }
    // 网页（或桌面端选了“只在底部”）：只朝有足够空间的方向左右走
    const room = { '-1': cx, '1': maxX - cx }, dirs = [-1, 1].filter(d => room[d] >= 60);
    if (!dirs.length) return false;
    const dir = pick(dirs), target = cx + dir * Math.min(room[dir], 130 + Math.random() * 330), real = Math.abs(target - cx);
    if (real < 40) return false;
    clearEdgePose(); const ms = real / SPEED * 1000; walkTarget = { x: target, y: cy }; root.style.transition = 'translate ' + ms + 'ms linear'; root.style.translate = (target - cx) + 'px 0'; startWalkAnim(ms, target < cx ? -1 : 1); return true;
  }
  (function scheduleWalk() { setTimeout(() => { tryWalk(false); scheduleWalk(); }, 5000 + Math.random() * 9000); })();

  // ---- 跟着鼠标歪头 ----
  addEventListener('pointermove', e => {
    const t = Date.now(), away = t - lastActive; lastActive = t; if (sleeping) wake(true, away);
    // 在她身上来回滑动鼠标约两秒算“摸头”：害羞 + 开心（触屏设备没有悬停，跳过；15 秒内只触发一次）
    if (!drag && e.pointerType !== 'touch' && root.contains(e.target)) {
      petMoves = petMoves.filter(x => t - x < 2500); petMoves.push(t);
      if (petMoves.length >= 60) { petMoves = []; rua(); }
    }
    if (reduce || drag || walking) return;
    tiltX = e.clientX; if (!tiltRaf) tiltRaf = requestAnimationFrame(applyTilt);
  }, { passive: true });
  let tiltX = 0, tiltRaf = 0;
  function applyTilt() {
    tiltRaf = 0; if (drag || walking) return;
    const r = root.getBoundingClientRect(), dx = Math.max(-1, Math.min(1, (tiltX - (r.left + r.width / 2)) / Math.max(300, innerWidth / 2)));
    body.style.transform = `rotate(${dx * 5}deg) translateX(${dx * 4}px)`;
  }

  // ---- 拖动 / 点击 / 菜单 ----
  let drag = null, lastTap = 0, pressTimer = 0, pokes = [], petMoves = [], petCool = 0;
  root.addEventListener('pointerdown', e => {
    if (e.button === 2) return;
    root.setPointerCapture(e.pointerId);
    clearEdgePose(); if (!card.contains(e.target)) hideCard();
    if (walking) { settleWalk(); stopWalkAnim(); }
    drag = { sx: e.screenX, sy: e.screenY, px: e.clientX, py: e.clientY, left: root.offsetLeft, top: root.offsetTop, moved: false, lx: e.screenX, ly: e.screenY };
    pressTimer = setTimeout(() => { if (drag && !drag.moved) { drag = null; openMenu(e.clientX, e.clientY); } }, 650);
  });
  root.addEventListener('pointermove', e => {
    if (!drag) return;
    if (!drag.moved && Math.hypot(e.screenX - drag.sx, e.screenY - drag.sy) < 6) return;
    if (!drag.moved) { drag.moved = true; clearTimeout(pressTimer); root.classList.add('drag'); closeMenu(); }
    const w = root.offsetWidth, h = root.offsetHeight;
    prefs.x = Math.max(0, Math.min(innerWidth - w, drag.left + e.clientX - drag.px)); prefs.y = Math.max(0, Math.min(innerHeight - h, drag.top + e.clientY - drag.py));
    root.style.left = prefs.x + 'px'; root.style.top = prefs.y + 'px';
  });
  const end = e => {
    clearTimeout(pressTimer); if (!drag) return;
    const moved = drag.moved; drag = null; root.classList.remove('drag'); save();
    if (moved) return;
    const now = Date.now();
    if (now - lastTap < 380) { lastTap = 0; if (host) host.open(); else document.getElementById('guideButton')?.click(); return; }
    lastTap = now; pokes = pokes.filter(t => now - t < 4000); pokes.push(now);
    if (pokes.length >= 5) { pokes = []; bump('anger', 30); emote('angry', 3600, pick(LINES.poke), '被一直戳'); return; }
    bump('joy', 3);
    if (dominant() === 'angry') { emote('angry', 2200, pick(LINES.grumble)); return; }
    if (dominant() === 'sad') { bump('joy', 8); emote('sad', 2600, pick(LINES.comfort)); return; }
    happy(); say(pick(LINES.click));
  };
  root.addEventListener('pointerup', end); root.addEventListener('pointercancel', end);
  root.addEventListener('contextmenu', e => { e.preventDefault(); if (host) host.menu(); else openMenu(e.clientX, e.clientY); });
  // ---- 宠物 AI：可以单独聊天、单独选模型（默认跟随主 AI），单独计量；“联动”打开时她能看到主对话的最近几条 ----
  const mainContext = () => [...document.querySelectorAll('#messages .message')].slice(-6).map(n => ({ role: n.classList.contains('user') ? 'user' : 'assistant', text: (n.querySelector('.bubble')?.textContent || '').trim().slice(0, 250) })).filter(x => x.text);
  async function petApi(path, options = {}) {
    const r = await fetch(path, { credentials: 'same-origin', ...options, headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), 'X-CSRF-Token': await getCsrf() } });
    const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || '请求失败（' + r.status + '）'); return d;
  }
  let petChatBox = null;
  async function openPetChat() {
    if (petChatBox) { petChatBox.remove(); petChatBox = null; return; }
    const css = (el, text) => { el.style.cssText = text; return el; };
    const box = petChatBox = css(document.createElement('div'), 'position:fixed;right:16px;bottom:16px;z-index:2147483000;width:min(340px,calc(100vw - 32px));max-height:70vh;display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:14px;background:var(--ym-card,#fff);color:var(--ink,#222);border:1px solid var(--line,#ddd);box-shadow:0 8px 30px rgba(0,0,0,.2);font-size:13px');
    const head = css(document.createElement('div'), 'display:flex;align-items:center;gap:6px');
    const title = css(document.createElement('strong'), 'flex:1'); title.textContent = '🦊 宠物 AI';
    const close = document.createElement('button'); close.type = 'button'; close.textContent = '×'; close.onclick = () => { box.remove(); petChatBox = null; };
    head.append(title, close);
    const log = css(document.createElement('div'), 'flex:1;min-height:90px;max-height:36vh;overflow:auto;display:flex;flex-direction:column;gap:6px');
    const line = (who, text) => { const d = css(document.createElement('div'), 'padding:6px 9px;border-radius:10px;white-space:pre-wrap;word-break:break-word;max-width:92%;' + (who === 'me' ? 'align-self:flex-end;background:#7955c7;color:#fff' : 'align-self:flex-start;border:1px solid var(--line,#ddd)')); d.textContent = text; log.append(d); log.scrollTop = log.scrollHeight; return d; };
    const modelSel = css(document.createElement('select'), 'max-width:100%'), status = css(document.createElement('div'), 'font-size:12px;opacity:.75');
    const linkLabel = css(document.createElement('label'), 'display:flex;gap:6px;align-items:center'), link = document.createElement('input'); link.type = 'checkbox'; link.checked = prefs.petLink !== false;
    link.onchange = () => { prefs.petLink = link.checked; save(); };
    linkLabel.append(link, document.createTextNode('联动：让她看到主对话最近几条（仅发送给宠物 AI）'));
    const input = css(document.createElement('input'), 'flex:1;min-width:0;padding:6px'); input.placeholder = '和她说点什么…'; input.maxLength = 500;
    const sendBtn = document.createElement('button'); sendBtn.type = 'button'; sendBtn.textContent = '发送';
    const toMain = css(document.createElement('button'), 'align-self:flex-start'); toMain.type = 'button'; toMain.textContent = '把她的话带到主对话'; toMain.hidden = true;
    const row = css(document.createElement('div'), 'display:flex;gap:6px'); row.append(input, sendBtn);
    box.append(head, log, toMain, row, linkLabel, modelSel, status); document.body.append(box);
    const history = []; let lastReply = '';
    const refreshInfo = async () => {
      try {
        const info = await petApi('/api/pet/ai');
        modelSel.replaceChildren(Object.assign(document.createElement('option'), { value: '', textContent: '使用主 AI 的模型（当前：' + (info.models.find(m => m.ref === info.mainModel)?.label || info.mainModel || '未设置') + '）' }), ...info.models.map(m => Object.assign(document.createElement('option'), { value: m.ref, textContent: '单独使用：' + m.label + ' · ' + m.providerName })));
        modelSel.value = info.mode === 'own' ? info.model : '';
        const m = info.month; status.textContent = '宠物 AI 本月单独计量：' + (m.calls || 0) + ' 次 · ' + fmtNum(m.totalTokens || 0) + ' tokens' + (m.cost ? ' · 约 ' + m.currency + (Math.round(m.cost * 10000) / 10000) : '');
      } catch (e) { status.textContent = e.message; }
    };
    modelSel.onchange = async () => { try { await petApi('/api/pet/ai', { method: 'PUT', body: JSON.stringify(modelSel.value ? { mode: 'own', model: modelSel.value } : { mode: 'main' }) }); await refreshInfo(); } catch (e) { status.textContent = e.message; refreshInfo(); } };
    toMain.onclick = () => { if (lastReply) { fillStarter('宠物说：“' + lastReply + '”\n我想问：'); box.remove(); petChatBox = null; } };
    const send = async () => {
      const text = input.value.trim(); if (!text || sendBtn.disabled) return;
      input.value = ''; sendBtn.disabled = true; line('me', text); const wait = line('pet', '…');
      try {
        const r = await petApi('/api/pet/chat', { method: 'POST', body: JSON.stringify({ message: text, history: history.slice(-8), link: link.checked, context: link.checked ? mainContext() : [] }) });
        wait.textContent = r.reply + (r.linked ? '' : ''); history.push({ role: 'user', text }, { role: 'assistant', text: r.reply }); lastReply = r.reply; toMain.hidden = false; happy(1200); refreshInfo();
      } catch (e) { wait.textContent = e.message; }
      sendBtn.disabled = false; input.focus();
    };
    sendBtn.onclick = send; input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) send(); });
    line('pet', '想聊什么？我是独立的宠物 AI，不会打断主对话～'); await refreshInfo(); input.focus();
  }
  let menu = null;
  function closeMenu() { menu?.remove(); menu = null; }
  function openMenu(x, y) {
    closeMenu(); menu = document.createElement('div'); menu.id = 'ymPetMenu';
    const item = (label, fn) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.addEventListener('click', () => { closeMenu(); fn(); }); menu.append(b); };
    item('💬 打个招呼 Say hi', () => { happy(); say(pick(LINES.click)); });
    if (!host) item('🦊 和宠物 AI 聊天 / 选模型', () => openPetChat());
    const d = dominant();
    item('心情 Mood：' + (d === 'angry' ? '😠 生气' : d === 'sad' ? '😢 难过' : mood.joy >= 60 ? '😄 很开心' : '🙂 平静') + `（开心 ${Math.round(mood.joy)} / 怒气 ${Math.round(mood.anger)} / 难过 ${Math.round(mood.sad)}）`, () => {});
    item('🍬 哄哄她 Cheer her up', () => onEvent('comfort'));
    const fc = window.YumeiroSide && window.YumeiroSide.focus;
    if (fc) {
      const st = fc.status(), left = Math.max(0, Math.ceil((st.endAt - Date.now()) / 1000)), mmss = String(Math.floor(left / 60)).padStart(2, '0') + ':' + String(left % 60).padStart(2, '0');
      item(st.phase === 'work' ? '🍅 专注中 ' + mmss + '（点一下停止）' : st.phase === 'rest' ? '☕ 休息中 ' + mmss + '（点一下结束休息）' : '🍅 开始专注 ' + st.work + ' 分钟', () => {
        if (st.phase === 'idle') { fc.start(); say('开始专注 ' + st.work + ' 分钟，我陪着你～', 3000); } else { fc.stop(); say(st.phase === 'work' ? '先停一下也没关系～' : '休息结束啦，要继续吗？', 2800); }
      });
      item('💡 给我一条休息建议', () => say(restTip(), 6000));
    }
    item('🧹 忘掉聊过的事 Forget', () => forget());
    item(prefs.proactive === false ? '💬 主动找我说话：关' : '💬 主动找我说话：开', () => { prefs.proactive = prefs.proactive === false; save(); say(prefs.proactive === false ? '好～我不会主动打扰你，想我了就戳戳我' : '那我有事就来找你啦～', 2800); });
    item('🧰 侧边栏（浏览 / 待办 / 专注…）', () => openSide()());
    item('📊 用量、心情与模型角色', () => showCard());
    item(prefs.stickerVision === false ? '🖼 识别表情图片：关' : '🖼 识别表情图片：开（用看图模型，耗额度）', () => { prefs.stickerVision = prefs.stickerVision === false; save(); say(prefs.stickerVision === false ? '不再看你发的表情图啦' : '你发表情包我会看的～', 2600); });
    item(prefs.aiLines ? '✨ AI 台词与情绪理解：开（消耗模型额度）' : '✨ AI 台词与情绪理解：关', () => { prefs.aiLines = !prefs.aiLines; save(); say(prefs.aiLines ? '以后由模型帮我想台词 AI lines on' : 'AI 台词关闭啦', 2600); });
    item('🔎 小一点 Smaller', () => { prefs.size = Math.max(80, prefs.size - 20); save(); place(); });
    item('🔍 大一点 Bigger', () => { prefs.size = Math.min(260, prefs.size + 20); save(); place(); });
    item(prefs.walk === false ? '🚶 自己走动 Wander on' : '🧍 站着别动 Stay still', () => { prefs.walk = prefs.walk === false; save(); if (prefs.walk !== false) tryWalk(true); });
    item(prefs.mute ? '🔔 开启台词 Unmute' : '🔕 安静模式 Mute', () => { prefs.mute = !prefs.mute; save(); });
    item('🙈 先躲起来 Hide', () => setEnabled(false));
    document.body.append(menu); menu.style.left = Math.min(x, innerWidth - 170) + 'px'; menu.style.top = Math.min(y, innerHeight - 200) + 'px';
    setTimeout(() => addEventListener('pointerdown', function off(ev) { if (menu && !menu.contains(ev.target)) { closeMenu(); } removeEventListener('pointerdown', off, true); }, true), 0);
  }
  function setEnabled(on) { prefs.enabled = on; save(); root.classList.toggle('hidden', !on); if (on) { place(); happy(); say('我回来啦 I\'m back!'); } syncButton(); }

  // ---- 桌宠窗口：鼠标只在宠物身上时才拦截点击，其余区域点穿到下面的程序 ----
  if (host) {
    let ignoring = true;
    let hoverRaf = 0, hoverE = null;
    addEventListener('mousemove', e => {
      hoverE = e; if (hoverRaf) return;
      hoverRaf = requestAnimationFrame(() => {
        hoverRaf = 0; const ev = hoverE; if (drag || !ev) return;
        const over = [[img, true], [bubble, bubble.classList.contains('show')], [card, card.classList.contains('show')]].some(([el, on]) => { if (!on) return false; const r = el.getBoundingClientRect(); return ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom; });
        if (over === ignoring) { ignoring = !over; host.ignore(ignoring); }
      });
    });
    host.onEvent(({ type, text }) => { if (type === 'roam') { prefs.roam = text === 'bottom' ? 'bottom' : 'screen'; save(); } else if (type === 'size') { prefs.size = Math.max(80, Math.min(320, Number(text) || 150)); save(); place(); } else if (type === 'idle') { if (text === '1') sleep(); else if (sleeping) { lastActive = Date.now(); wake(true, 20 * 60000 + 1); } } else if (type === 'edge') { stopWalkAnim(); showEdgePose(text); } else if (type === 'say') { say(text); } else if (type === 'happy') happy(); else if (type === 'mute') { prefs.mute = Boolean(text); save(); } else if (type === 'wander') { prefs.walk = Boolean(text); } else onEvent(type, text); });
    setTimeout(() => say('桌宠上线 Hello!'), 600);
    setTimeout(startGreeting, 6000);                                   // 主窗口没登录 / 没同步到记忆时，用本机上已有的记忆打招呼
    return;
  }

  // ---- 网页里的聊天事件 ----
  // 可选：开启“AI 台词 / 情绪理解”后，把最近几条对话交给模型判断情绪（比规则更懂上下文、反话和玩笑）；每 45 秒最多一次，计入用量
  let aiSenseAt = 0, lastLex = null;
  async function aiSense(lex, messages) {
    if (!prefs.aiLines || Date.now() - aiSenseAt < 45000 || !messages.length) return;
    aiSenseAt = Date.now(); lastLex = lex;
    const d = await aiSenseFetch(messages);
    // 只在模型和规则版明显不一致时纠偏（避免同一句话算两遍）
    if (d && Math.abs(d.valence - lastLex.v) > 0.25) applySense({ v: d.valence - lastLex.v, a: d.arousal, o: d.about, e: d.emotion === 'none' ? '' : d.emotion, ai: 1 });
  }
  watchChat((type, text) => { if (!prefs.enabled) return; onEvent(type, text); }, aiSense);
  watchModel((type, text) => { if (!prefs.enabled) return; onEvent(type, text); });
  watchSide((type, text) => { if (!prefs.enabled) return; onEvent(type, text); });
  watchStreak((type, text) => { if (!prefs.enabled) return; onEvent(type, text); });
  addEventListener('offline', () => { bump('sad', 18); emote('sad', 3500, pick(LINES.offline)); }); addEventListener('online', () => { bump('joy', 10); emote('surprised', 2600, pick(LINES.online)); });

  // ---- 顶栏按钮 ----
  function syncButton() { const b = document.getElementById('petButton'); if (b) { b.setAttribute('aria-pressed', String(prefs.enabled)); b.title = prefs.enabled ? '桌宠：点击让她先躲起来 Hide pet' : '桌宠：点击叫她出来 Show pet'; b.style.opacity = prefs.enabled ? '1' : '.55'; } }
  function mountButton() {
    if (document.getElementById('petButton')) return true;
    const anchor = document.getElementById('guideButton') || document.getElementById('speakButton') || document.getElementById('drawButton') || document.getElementById('historyButton') || document.getElementById('memoryButton');
    if (!anchor) return false;
    const b = Object.assign(document.createElement('button'), { id: 'petButton', type: 'button', className: 'icon-button', textContent: '🐾' });
    b.setAttribute('aria-label', '桌宠 Pet'); b.addEventListener('click', () => setEnabled(!prefs.enabled)); anchor.before(b); syncButton(); return true;
  }
  let tries = 0; const timer = setInterval(() => { if (mountButton() || ++tries > 120) clearInterval(timer); }, 1500);
  // 启动：先和服务器上的情绪记忆合并（多台设备共用），再决定怎么打招呼——有该提的旧事就提，没有就按时间问候
  (async () => {
    const server = await Promise.race([memFetch(), new Promise(resolve => setTimeout(() => resolve(null), 2500))]);
    if (server) { prefs.memory = mergeMem(prefs.memory, server); save(); }
    if (!prefs.enabled || startGreeting()) return;
    const h = new Date().getHours();
    say(h < 6 ? '夜深了，早点休息 Go to sleep soon' : h < 11 ? '早上好 Good morning!' : h < 14 ? '中午好，记得吃饭 Lunch time!' : h < 19 ? '下午好 Good afternoon!' : '晚上好 Good evening!', 3600);
  })();
  setInterval(async () => { const server = await memFetch(); if (server) { prefs.memory = mergeMem(prefs.memory, server); save(); } }, 10 * 60 * 1000);
  window.YumeiroPet = { say, happy, emote, mood, sense: applySense, card: showCard, model: onModel, setEnabled, walk: () => tryWalk(true), get enabled() { return prefs.enabled; } };

  // 观察聊天发送按钮：开始回复 → “思考中”（用户说了好话 / 坏话则换成对应情绪），结束 → 开心，出错 → 难过
  function watchChat(notify, aiSense) {
    let busy = false, slowTimer = 0, lastUserText = '', lastUserAt = 0;
    // 最近几条消息（给 AI 情绪理解当上下文）
    const recent = () => [...document.querySelectorAll('#messages .message')].slice(-6).map(n => ({ role: n.classList.contains('user') ? 'user' : 'assistant', text: (n.querySelector('.bubble')?.textContent || '').trim().slice(0, 200) }));
    // 用户刚发出一条消息：解析它（emoji / 表情包 / 颜文字都算），结合“紧跟在她的回答之后”“几乎原样重问”这些上下文
    const readUser = () => {
      const sense = window.YumeiroSense, nodes = document.querySelectorAll('#messages .message.user');
      const node = nodes[nodes.length - 1]; if (!sense || !node) return null;
      const text = (node.querySelector('.bubble')?.textContent || '').trim().slice(0, 400); if (!text) return null;
      const prev = node.previousElementSibling, now = Date.now();
      const r = sense.analyze(text, { afterAssistant: Boolean(prev && prev.classList.contains('assistant')) });
      const repeat = lastUserText && now - lastUserAt < 180000 && sense.similarity(lastUserText, text) > 0.6;
      lastUserText = text; lastUserAt = now;
      return { v: +r.v.toFixed(2), a: +r.a.toFixed(2), o: r.about, e: r.emotion, r: repeat ? 1 : 0, s: text.slice(0, 24) };
    };
    const attach = () => {
      const send = document.getElementById('send'); if (!send || send.dataset.petWatch) return !!send;
      send.dataset.petWatch = '1';
      new MutationObserver(() => {
        const now = send.classList.contains('stop');
        if (now && !busy) {
          const s = readUser();
          if (s && (Math.abs(s.v) >= 0.12 || s.r || s.e)) notify('sense', JSON.stringify(s)); if (!s || Math.abs(s.v) < 0.3) notify('think');
          if (s && aiSense) aiSense(s, recent());
          clearTimeout(slowTimer); slowTimer = setTimeout(() => { if (busy) notify('slow'); }, 40000);   // 等了 40 秒还没回：有点着急
        } else if (!now && busy) { clearTimeout(slowTimer); const bad = document.querySelector('#messages .message.assistant:last-child .bubble.error'); notify(bad ? 'error' : 'done'); if (!bad) window.dispatchEvent(new Event('yumeiro:reply-done')); }
        busy = now;
      }).observe(send, { attributes: true, attributeFilter: ['class'] });
      return true;
    };
    let n = 0; const t = setInterval(() => { if (attach() || ++n > 120) clearInterval(t); }, 1500);
    // 用户发了图：有点像表情包的（体积小）交给能看图的模型分析情绪，结果像一句话一样并入心情；照片 / 截图会被模型标成非表情包而忽略
    window.addEventListener('yumeiro:images-sent', async ev => {
      if (prefs.stickerVision === false) return;
      const { ids = [], files = [] } = ev.detail || {}, small = ids.filter((id, i) => !files[i] || files[i].bytes <= 600 * 1024);
      if (!small.length) return;
      const r = await stickerCheck(small);
      if (!r || r.kind !== 'sticker') return;
      notify('sense', JSON.stringify({ v: +r.valence.toFixed(2), a: +r.arousal.toFixed(2), o: r.about, e: r.emotion === 'none' ? '' : r.emotion, st: 1, c: r.caption || '' }));
    });
  }
})();
