// 远程控制网页端（手机 / 平板 / 电脑浏览器）：管理设备、看画面、点触、打字。
(() => {
  const app = document.getElementById('app');
  const el = (tag, props = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) { if (k === 'on') for (const [e, f] of Object.entries(v)) node.addEventListener(e, f); else if (k === 'style') node.style.cssText = v; else if (k in node) node[k] = v; else node.setAttribute(k, v); }
    node.append(...kids.flat().filter(x => x != null && x !== false));
    return node;
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let csrf = '', listTimer = 0, view = null;
  async function api(path, options = {}) {
    const headers = { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) };
    const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || '请求失败：' + response.status), { status: response.status });
    return data;
  }
  const osIcon = os => os === 'win32' ? '🪟' : os === 'darwin' ? '🍎' : '🖥';
  const ago = ms => { if (!ms) return '从未连接'; const s = Math.floor((Date.now() - ms) / 1000); return s < 60 ? '刚刚' : s < 3600 ? Math.floor(s / 60) + ' 分钟前' : s < 86400 ? Math.floor(s / 3600) + ' 小时前' : Math.floor(s / 86400) + ' 天前'; };
  const copy = async text => { try { await navigator.clipboard.writeText(text); return true; } catch { return false; } };

  // ---------- 设备列表 ----------
  async function showList() {
    clearInterval(listTimer); app.replaceChildren();
    const box = el('div', { class: 'wrap' }), list = el('div'), pairBox = el('div'), err = el('div', { class: 'err' });
    box.append(el('div', { class: 'row hero' }, el('img', { src: '/mascot.png', alt: '', 'aria-hidden': 'true' }), el('div', { class: 'grow' }, el('h1', { textContent: '远程控制' }), el('div', { class: 'muted', textContent: '查看并控制你自己的 Windows / Mac 电脑。被控端程序只会主动连接本站，不需要开放端口。' })), el('a', { href: '/', textContent: '← 返回聊天' })), err, list, el('div', { class: 'row' }, el('button', { class: 'primary', type: 'button', textContent: '＋ 添加设备', on: { click: () => showPair(pairBox, refresh) } })), pairBox,
      el('div', { class: 'card muted' }, el('b', { textContent: '安全提示' }), el('ul', { style: 'margin:6px 0 0;padding-left:20px' }, [
        '只有你的账号能看到这些设备；服务器会记录你什么时候查看 / 操作（不记录输入的文字内容）。',
        '被控端默认只查看；只有用 --allow-control 启动、并且这里开着“允许控制”，才能点击和打字。',
        '随时可以在这里关闭“允许控制”、删除设备，或在被控电脑上按 Ctrl+C 退出程序。',
        '锁屏和 Windows 的 UAC 弹窗属于系统保护界面，看不到也点不了。'
      ].map(t => el('li', { textContent: t })))));
    app.append(box);
    async function refresh() {
      try {
        const { devices } = await api('/api/remote/devices'); err.textContent = '';
        list.replaceChildren(...(devices.length ? devices.map(card) : [el('div', { class: 'card muted empty' }, el('img', { src: '/mascot.png', alt: '' }), el('div', { textContent: '还没有设备。点“添加设备”，按提示在被控电脑上运行一条命令即可。梦色会帮你守着它……' }))]));
      } catch (e) { if (e.status === 401) return needLogin(); err.textContent = e.message; }
    }
    function card(d) {
      const toggle = el('button', { type: 'button', class: d.allowControl ? 'on' : '', textContent: d.allowControl ? '允许控制：开' : '仅查看', title: '关闭后只能看画面，不能点击和打字', on: { click: async () => { try { await api('/api/remote/devices/' + d.id, { method: 'PATCH', body: JSON.stringify({ allowControl: !d.allowControl }) }); refresh(); } catch (e) { err.textContent = e.message; } } } });
      return el('div', { class: 'card' }, el('div', { class: 'row' },
        el('div', { class: 'grow' }, el('div', {}, el('span', { class: 'dot' + (d.online ? ' on' : '') }), osIcon(d.os) + ' ', el('b', { textContent: d.name })), el('div', { class: 'muted', textContent: (d.osLabel || '') + (d.hostname ? ' · ' + d.hostname : '') + ' · ' + (d.online ? '在线' : '离线（最后在线 ' + ago(d.lastSeen) + '）') + (d.online && d.allowControl && !d.agentControl ? ' · 被控端是仅查看模式' : '') })),
        el('button', { type: 'button', class: 'primary', textContent: '打开', disabled: !d.online, on: { click: () => showViewer(d) } }), toggle,
        el('button', { type: 'button', textContent: '改名', on: { click: async () => { const name = await ymPrompt('设备名称', d.name); if (!name) return; try { await api('/api/remote/devices/' + d.id, { method: 'PATCH', body: JSON.stringify({ name }) }); refresh(); } catch (e) { err.textContent = e.message; } } } }),
        el('button', { type: 'button', textContent: '删除', on: { click: async () => { if (!await ymConfirm('删除“' + d.name + '”？删除后被控端会自动退出，需要重新配对才能再用。', { danger: true, okText: '确定' })) return; try { await api('/api/remote/devices/' + d.id, { method: 'DELETE' }); refresh(); } catch (e) { err.textContent = e.message; } } } })));
    }
    await refresh(); listTimer = setInterval(refresh, 4000);
  }
  function showPair(box, onDone) {
    const name = el('input', { type: 'text', placeholder: '设备名称，如 家里的台式机（可不填）', maxLength: 40 }), control = el('input', { type: 'checkbox', checked: true }), out = el('div'), err = el('div', { class: 'err' });
    const go = el('button', { class: 'primary', type: 'button', textContent: '生成配对码', on: { click: async () => {
      err.textContent = '';
      try {
        const r = await api('/api/remote/pair', { method: 'POST', body: JSON.stringify({ name: name.value, control: control.checked }) });
        const origin = location.origin, flag = r.control ? ' --allow-control' : ' --view-only';
        const win = `iwr ${origin}/remote/agent.mjs -OutFile agent.mjs\nnode agent.mjs --server ${origin} --code ${r.code}${flag}`, mac = `curl -fsSLO ${origin}/remote/agent.mjs\nnode agent.mjs --server ${origin} --code ${r.code}${flag}`;
        const pre = el('pre', { textContent: win }), tabs = [['Windows（PowerShell）', win], ['macOS（终端）', mac]];
        const left = el('span', { class: 'muted' });
        const end = r.expiresAt, tick = setInterval(() => { const s = Math.max(0, Math.round((end - Date.now()) / 1000)); left.textContent = s ? '有效期还剩 ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') : '已过期，请重新生成'; if (!s) clearInterval(tick); }, 1000);
        out.replaceChildren(el('div', { class: 'code', textContent: r.code }), left,
          el('div', { class: 'tabs row' }, tabs.map(([label, text]) => el('button', { type: 'button', textContent: label, on: { click: () => { pre.textContent = text; } } })), el('button', { type: 'button', textContent: '复制命令', on: { click: async e => { e.target.textContent = (await copy(pre.textContent)) ? '已复制' : '请手动复制'; } } })), pre,
          el('div', { class: 'muted', textContent: '1) 在被控电脑上先安装 Node.js 18 或更高版本（https://nodejs.org）；2) 打开 PowerShell / 终端，运行上面的命令；3) 看到“配对成功”后，这里会自动出现新设备。想让它开机自动运行：node agent.mjs --install-autostart。macOS 需在“隐私与安全性”里允许屏幕录制，要控制还需 brew install cliclick 并允许辅助功能。' }));
      } catch (e) { err.textContent = e.message; }
    } } });
    box.replaceChildren(el('div', { class: 'card' }, el('b', { textContent: '添加设备' }), el('div', { class: 'row', style: 'margin:8px 0' }, name), el('label', { class: 'row muted' }, control, '允许控制（取消勾选则这台设备只能查看）'), el('div', { class: 'row', style: 'margin:8px 0' }, go, el('button', { type: 'button', textContent: '关闭', on: { click: () => { box.replaceChildren(); onDone(); } } })), err, out));
  }
  function needLogin() { clearInterval(listTimer); app.replaceChildren(el('div', { class: 'wrap' }, el('h1', { textContent: '请先登录' }), el('p', { class: 'muted', textContent: '远程控制需要先登录你的 Yumeiro 账号。' }), el('a', { href: '/', textContent: '去登录 →' }))); }

  // ---------- 远程画面 ----------
  async function showViewer(device) {
    clearInterval(listTimer);
    const v = view = { id: device.id, active: true, seq: 0, mode: 'direct', zoom: 1, panX: 0, panY: 0, fw: 0, fh: 0, control: false, once: null, mods: new Set(), cursor: { x: 0.5, y: 0.5 }, pending: [], panMode: false, scrollMode: false, frames: 0, fpsAt: Date.now(), fps: 0 };
    const img = el('img', { id: 'screen', alt: '远程画面', draggable: false }), dot = el('div', { id: 'cursorDot' }), stage = el('div', { id: 'stage' }, img, dot), status = el('span', { class: 'muted', style: 'flex:1;min-width:80px' }, '连接中…');
    const kb = el('textarea', { id: 'kb', autocapitalize: 'off', autocomplete: 'off', spellcheck: false, 'aria-label': '输入文字' });
    const keysBar = el('div', { id: 'keys' });
    const flagBtn = (label, key, hint) => el('button', { type: 'button', textContent: label, title: hint, on: { click: e => { v.once = v.once === key ? null : key; paintFlags(); } }, 'data-flag': key });
    const modBtn = (label, mod) => el('button', { type: 'button', textContent: label, 'data-mod': mod, on: { click: () => { v.mods.has(mod) ? v.mods.delete(mod) : v.mods.add(mod); paintFlags(); } } });
    const keyBtn = (label, key, mods = []) => el('button', { type: 'button', textContent: label, on: { click: () => sendKey(key, mods) } });
    keysBar.append(modBtn('Ctrl', 'ctrl'), modBtn('Alt', 'alt'), modBtn('Shift', 'shift'), modBtn(device.os === 'darwin' ? '⌘' : '⊞ Win', 'meta'),
      keyBtn('Esc', 'escape'), keyBtn('Tab', 'tab'), keyBtn('⌫', 'backspace'), keyBtn('Del', 'delete'), keyBtn('Enter', 'enter'), keyBtn('←', 'left'), keyBtn('↑', 'up'), keyBtn('↓', 'down'), keyBtn('→', 'right'), keyBtn('Home', 'home'), keyBtn('End', 'end'), keyBtn('PgUp', 'pageup'), keyBtn('PgDn', 'pagedown'),
      keyBtn('复制', 'c', [device.os === 'darwin' ? 'meta' : 'ctrl']), keyBtn('粘贴', 'v', [device.os === 'darwin' ? 'meta' : 'ctrl']), keyBtn('全选', 'a', [device.os === 'darwin' ? 'meta' : 'ctrl']), keyBtn('撤销', 'z', [device.os === 'darwin' ? 'meta' : 'ctrl']), keyBtn('Alt+Tab', 'tab', ['alt']), keyBtn(device.os === 'darwin' ? '⌘Space' : '⊞', device.os === 'darwin' ? 'space' : 'meta', device.os === 'darwin' ? ['meta'] : []));
    const quality = el('select', { 'aria-label': '画质', title: '画质：自动会根据网速自动调；清晰优先画面更细但更吃网速；流畅优先更不卡', on: { change: () => { api('/api/remote/devices/' + v.id + '/quality', { method: 'POST', body: JSON.stringify({ mode: quality.value }) }).catch(() => {}); } } }, el('option', { value: 'auto', textContent: '画质：自动' }), el('option', { value: 'high', textContent: '清晰优先' }), el('option', { value: 'smooth', textContent: '流畅优先' }));
    const modeBtn = el('button', { type: 'button', textContent: '👆 直接点击', title: '切换：直接点击 / 触控板', on: { click: () => { v.mode = v.mode === 'direct' ? 'pad' : 'direct'; dot.style.display = v.mode === 'pad' ? 'block' : 'none'; paintFlags(); } } });
    const bar = el('div', { id: 'vbar' }, el('button', { type: 'button', textContent: '← 返回', on: { click: () => leave() } }), el('b', { textContent: osIcon(device.os) + ' ' + device.name, style: 'white-space:nowrap' }), status,
      el('button', { type: 'button', textContent: '断开', on: { click: () => leave() } }));
    const tools = el('div', { id: 'vtools' }, quality, modeBtn, flagBtn('右键', 'right', '下一次点击变成右键'), flagBtn('双击', 'double', '下一次点击变成双击'),
      el('button', { type: 'button', textContent: '⌨ 键盘', title: '弹出键盘打字（支持中文输入法）', on: { click: () => { kb.focus(); } } }), el('button', { type: 'button', textContent: '🎛 按键', title: 'Esc / Tab / 方向键 / 组合键', on: { click: () => keysBar.classList.toggle('show') } }),
      el('button', { type: 'button', textContent: '📋 粘贴文字', title: '把手机剪贴板里的文字输入到电脑（长文本、网址、密码都方便）', on: { click: sendClipboard } }),
      el('button', { type: 'button', textContent: '↕ 滚动', 'data-flag': 'scroll', title: '放大后，两指拖动默认移动画面；打开它则两指拖动改为滚动电脑上的页面', on: { click: () => { v.scrollMode = !v.scrollMode; paintFlags(); } } }),
      el('button', { type: 'button', textContent: '＋', 'aria-label': '放大', on: { click: () => zoom(1.3) } }), el('button', { type: 'button', textContent: '－', 'aria-label': '缩小', on: { click: () => zoom(0.77) } }), el('button', { type: 'button', textContent: '适应', on: { click: () => { v.zoom = 1; v.panX = v.panY = 0; layout(); } } }),
      el('button', { type: 'button', textContent: '✋ 平移', 'data-flag': 'pan', title: '放大后，打开它再用单指拖动画面', on: { click: () => { v.panMode = !v.panMode; paintFlags(); } } }),
      el('button', { type: 'button', textContent: '全屏', on: { click: toggleFullscreen } }));
    const root = el('div', { id: 'viewer' }, bar, stage, keysBar, tools, kb);
    app.replaceChildren(root);
    function paintFlags() {
      modeBtn.textContent = v.mode === 'direct' ? '👆 直接点击' : '🖱 触控板';
      for (const b of tools.querySelectorAll('[data-flag]')) b.classList.toggle('on', b.dataset.flag === 'pan' ? v.panMode : b.dataset.flag === 'scroll' ? v.scrollMode : v.once === b.dataset.flag);
      for (const b of keysBar.querySelectorAll('[data-mod]')) b.classList.toggle('on', v.mods.has(b.dataset.mod));
    }
    function leave() { v.active = false; document.removeEventListener('keydown', onKeyDown, true); document.removeEventListener('visibilitychange', onVisible); try { wakeLock?.release?.(); } catch { /* 忽略 */ } window.removeEventListener('resize', layout); api('/api/remote/devices/' + v.id + '/stop', { method: 'POST', body: '{}' }).catch(() => {}); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); view = null; showList(); }
    // 布局：先按“适应”缩放，再叠加缩放和平移
    function layout() {
      if (!v.fw) return;
      const sw = stage.clientWidth, sh = stage.clientHeight, scale = Math.min(sw / v.fw, sh / v.fh) * v.zoom, w = v.fw * scale, h = v.fh * scale;
      const left = w <= sw ? (sw - w) / 2 : Math.min(0, Math.max(sw - w, v.panX)), top = h <= sh ? (sh - h) / 2 : Math.min(0, Math.max(sh - h, v.panY));
      v.panX = w <= sw ? 0 : left; v.panY = h <= sh ? 0 : top; v.left = left; v.top = top;
      img.style.width = v.fw + 'px'; img.style.height = v.fh + 'px'; img.style.transform = 'translate(' + left + 'px,' + top + 'px) scale(' + scale + ')';
    }
    // 以手指（或鼠标）所在位置为中心缩放，缩放后该点下面的内容保持不动
    function zoomAt(cx, cy, next) {
      next = Math.min(8, Math.max(1, next)); if (!v.fw) return;
      const ratio = next / v.zoom; v.panX = cx - (cx - (v.left || 0)) * ratio; v.panY = cy - (cy - (v.top || 0)) * ratio; v.zoom = next; layout();
    }
    function zoom(f) { const r = stage.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, v.zoom * f); }
    // 全屏（手机上同时尝试锁定横屏）和屏幕常亮
    async function toggleFullscreen() {
      if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); try { screen.orientation?.unlock?.(); } catch { /* 忽略 */ } return; }
      try { await document.documentElement.requestFullscreen?.(); } catch { say('这个浏览器不支持全屏', true); return; }
      try { await screen.orientation?.lock?.('landscape'); } catch { /* 部分浏览器不允许锁定方向，手动旋转手机即可 */ }
    }
    let wakeLock = null;
    const keepAwake = async () => { try { wakeLock = await navigator.wakeLock?.request?.('screen'); } catch { /* 不支持就算了 */ } };
    const onVisible = () => { if (document.visibilityState === 'visible' && v.active) keepAwake(); };
    document.addEventListener('visibilitychange', onVisible); keepAwake();
    // 把手机剪贴板里的文字输入到电脑（分段发送，每段不超过 200 字）
    async function sendClipboard() {
      if (!canControl()) return;
      let text = '';
      try { text = await navigator.clipboard.readText(); } catch { text = await ymPrompt('把要输入到电脑上的文字粘贴到这里：') || ''; }
      text = text.replace(/\r\n?/g, '\n').slice(0, 6000); if (!text) return;
      if (!await ymConfirm('把 ' + text.length + ' 个字输入到电脑上当前的光标位置？')) return;
      const chunks = text.match(/[\s\S]{1,180}/g) || [];
      for (let i = 0; i < chunks.length; i += 20) { v.pending.push(...chunks.slice(i, i + 20).map(t => ({ type: 'text', text: t }))); await flush(); await sleep(120); }
      say('已输入 ' + text.length + ' 个字');
    }
    window.addEventListener('resize', layout);
    // ---- 输入发送（合并鼠标移动，分批发出）----
    let flushing = false;
    const queue = event => { if (event.type === 'move') { const last = v.pending[v.pending.length - 1]; if (last && last.type === 'move') { v.pending[v.pending.length - 1] = event; return schedule(); } } v.pending.push(event); schedule(); };
    function schedule() { if (flushing) return; flushing = true; setTimeout(flush, 35); }
    async function flush() {
      const events = v.pending.splice(0, 40); flushing = false;
      if (!events.length) return;
      try { await api('/api/remote/devices/' + v.id + '/input', { method: 'POST', body: JSON.stringify({ events }) }); }
      catch (e) { if (e.status === 429) { await sleep(300); } else say(e.message, true); }
      if (v.pending.length) schedule();
    }
    const say = (text, bad) => { status.textContent = text; status.style.color = bad ? '#ff7b7b' : ''; };
    const norm = e => { const r = img.getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)), w: r.width, h: r.height }; };
    const canControl = () => { if (!v.control) { say('当前只能查看（设备设置为仅查看，或被控端以仅查看方式启动）', true); return false; } return true; };
    function clickAt(x, y, button = 'left') {
      if (!canControl()) return;
      const b = v.once === 'right' ? 'right' : button, count = v.once === 'double' ? 2 : 1; v.once = null; paintFlags();
      queue({ type: 'click', x, y, button: b, count });
    }
    function sendKey(key, mods = []) { if (!canControl()) return; const all = [...new Set([...mods, ...v.mods])]; v.mods.clear(); paintFlags(); queue({ type: 'key', key, action: 'press', mods: all }); }
    // ---- 触摸 / 鼠标 ----
    const pointers = new Map(); let gesture = null, wheelAcc = 0, wheelAccX = 0;
    const local = e => { const r = stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const ripple = (e, color) => { const p = local(e), node = el('div', { class: 'ripple', style: `left:${p.x}px;top:${p.y}px;border-color:${color}` }); stage.append(node); setTimeout(() => node.remove(), 520); };
    const buzz = ms => { try { navigator.vibrate?.(ms); } catch { /* 设备不支持震动 */ } };
    stage.addEventListener('pointerdown', e => {
      stage.setPointerCapture(e.pointerId); pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: Date.now() });
      if (e.pointerType === 'mouse') {
        const p = norm(e); if (!canControl()) return;
        queue({ type: 'move', x: p.x, y: p.y }); queue({ type: 'down', button: e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left' }); gesture = { type: 'mouse', button: e.button }; return;
      }
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        if (gesture?.type === 'one') { clearTimeout(gesture.long); if (gesture.dragging) queue({ type: 'up', button: 'left' }); }
        gesture = { type: 'two', dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, acc: 0, accX: 0, pinched: false }; return;
      }
      gesture = { type: 'one', moved: false, dragging: false, rightClick: false, long: setTimeout(() => {
        if (!gesture || gesture.type !== 'one' || gesture.moved) return;
        if (v.mode === 'pad' && canControl()) { gesture.dragging = true; buzz(12); queue({ type: 'down', button: 'left' }); }
        else if (v.mode === 'direct') { gesture.rightClick = true; buzz(18); ripple(e, '#ffb454'); }
      }, 450) };
    });
    stage.addEventListener('pointermove', e => {
      const p0 = pointers.get(e.pointerId);
      if (!p0) { if (e.pointerType === 'mouse' && v.control) { const p = norm(e); queue({ type: 'move', x: p.x, y: p.y }); } return; }
      const dx = e.clientX - p0.x, dy = e.clientY - p0.y; p0.x = e.clientX; p0.y = e.clientY;
      if (e.pointerType === 'mouse') { if (v.control) { const p = norm(e); queue({ type: 'move', x: p.x, y: p.y }); } return; }
      if (gesture?.type === 'two' && pointers.size >= 2) {
        const [a, b] = [...pointers.values()], dist = Math.hypot(a.x - b.x, a.y - b.y) || 1, mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, r = stage.getBoundingClientRect();
        if (gesture.pinched || Math.abs(dist - gesture.dist) > 5) {
          gesture.pinched = true; zoomAt(mx - r.left, my - r.top, v.zoom * dist / gesture.dist);
          if (v.zoom > 1) { v.panX += mx - gesture.mx; v.panY += my - gesture.my; layout(); }
        } else if (v.zoom > 1 && !v.scrollMode) { v.panX += mx - gesture.mx; v.panY += my - gesture.my; layout(); }
        else if (canControl()) {
          gesture.acc += my - gesture.my; gesture.accX += mx - gesture.mx;
          const ny = Math.trunc(gesture.acc / 26), nx = Math.trunc(gesture.accX / 26);
          if (ny || nx) { gesture.acc -= ny * 26; gesture.accX -= nx * 26; queue({ type: 'wheel', dy: -ny, dx: -nx }); }
        }
        gesture.dist = dist; gesture.mx = mx; gesture.my = my; return;
      }
      if (gesture?.type !== 'one') return;
      if (!gesture.moved && Math.hypot(e.clientX - p0.sx, e.clientY - p0.sy) < 8) return;
      gesture.moved = true; clearTimeout(gesture.long);
      if (v.panMode) { v.panX += dx; v.panY += dy; layout(); return; }
      if (v.mode === 'pad') {
        if (!canControl()) return;
        const r = img.getBoundingClientRect(); v.cursor.x = Math.min(1, Math.max(0, v.cursor.x + dx * 1.6 / r.width)); v.cursor.y = Math.min(1, Math.max(0, v.cursor.y + dy * 1.6 / r.height));
        queue({ type: 'move', x: v.cursor.x, y: v.cursor.y }); paintCursor(); return;
      }
      if (!canControl()) return;
      const p = norm(e);
      if (!gesture.dragging) { const s = norm({ clientX: p0.sx, clientY: p0.sy }); queue({ type: 'move', x: s.x, y: s.y }); queue({ type: 'down', button: 'left' }); gesture.dragging = true; buzz(8); }
      queue({ type: 'move', x: p.x, y: p.y });
    });
    const finish = e => {
      const p0 = pointers.get(e.pointerId); pointers.delete(e.pointerId);
      if (!p0) return;
      if (e.pointerType === 'mouse') { if (gesture?.type === 'mouse' && v.control) queue({ type: 'up', button: gesture.button === 2 ? 'right' : gesture.button === 1 ? 'middle' : 'left' }); gesture = null; return; }
      if (gesture?.type === 'two') { if (pointers.size < 2) gesture = pointers.size ? { type: 'idle' } : null; return; }
      if (gesture?.type !== 'one') { if (!pointers.size) gesture = null; return; }
      clearTimeout(gesture.long); const g = gesture; gesture = null;
      if (g.dragging) { queue({ type: 'up', button: 'left' }); return; }
      if (g.moved) return;
      ripple(e, g.rightClick ? '#ffb454' : '#e95164');
      if (v.mode === 'pad') clickAt(v.cursor.x, v.cursor.y, g.rightClick ? 'right' : 'left');
      else { const p = norm(e); clickAt(p.x, p.y, g.rightClick ? 'right' : 'left'); }
    };
    stage.addEventListener('pointerup', finish); stage.addEventListener('pointercancel', finish);
    stage.addEventListener('contextmenu', e => e.preventDefault());
    stage.addEventListener('wheel', e => {
      e.preventDefault();
      if (e.ctrlKey) { const r = stage.getBoundingClientRect(); zoomAt(e.clientX - r.left, e.clientY - r.top, v.zoom * (e.deltaY < 0 ? 1.15 : 0.87)); return; } // Ctrl + 滚轮 = 缩放画面（和浏览器习惯一致）
      if (!v.control) return; wheelAcc += e.deltaY; wheelAccX += e.deltaX;
      if (Math.abs(wheelAcc) >= 40 || Math.abs(wheelAccX) >= 40) { const ny = Math.trunc(wheelAcc / 40), nx = Math.trunc(wheelAccX / 40); wheelAcc -= ny * 40; wheelAccX -= nx * 40; queue({ type: 'wheel', dy: ny, dx: nx }); }
    }, { passive: false });
    function paintCursor() { const r = img.getBoundingClientRect(), s = stage.getBoundingClientRect(); dot.style.left = (r.left - s.left + v.cursor.x * r.width) + 'px'; dot.style.top = (r.top - s.top + v.cursor.y * r.height) + 'px'; }
    // ---- 键盘：电脑浏览器直接敲；手机用软键盘（隐藏输入框）----
    const SPECIAL = { Enter: 'enter', Escape: 'escape', Tab: 'tab', Backspace: 'backspace', Delete: 'delete', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown', ' ': 'space', Insert: 'insert' };
    function onKeyDown(e) {
      if (!v.active || e.isComposing || e.key === 'Process') return;
      const target = document.activeElement, inPrompt = target && target !== kb && /input|textarea/i.test(target.tagName);
      if (inPrompt) return;
      const key = SPECIAL[e.key] || (/^F([1-9]|1[0-2])$/.test(e.key) ? e.key.toLowerCase() : e.key.length === 1 ? e.key : null);
      if (!key) return;
      if (target === kb && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) return; // 普通字符走 input 事件
      if (!v.control) return;
      e.preventDefault();
      const mods = [e.ctrlKey && 'ctrl', e.altKey && 'alt', e.shiftKey && key.length > 1 && 'shift', e.metaKey && 'meta'].filter(Boolean);
      queue({ type: 'key', key, action: 'press', mods: [...new Set([...mods, ...v.mods])] }); v.mods.clear(); paintFlags();
    }
    document.addEventListener('keydown', onKeyDown, true);
    kb.addEventListener('input', () => { const text = kb.value; kb.value = ''; if (text && canControl()) { if (v.mods.size && text.length === 1) sendKey(text.toLowerCase()); else queue({ type: 'text', text: text.slice(0, 200) }); } });
    kb.addEventListener('keydown', e => { if (e.key === 'Backspace' && !kb.value && v.control) { e.preventDefault(); queue({ type: 'key', key: 'backspace', action: 'press', mods: [] }); } });
    paintFlags();
    // ---- 画面循环 ----
    let url = '';
    while (v.active) {
      try {
        const r = await fetch(`/api/remote/devices/${v.id}/frame?since=${v.seq}&dl=${v.dl || 0}`, { credentials: 'same-origin', cache: 'no-store' });
        if (!v.active) break;
        if (r.status === 401) { needLogin(); return; }
        if (r.status === 404) { say('设备已被删除', true); await sleep(2000); leave(); return; }
        v.control = r.headers.get('X-Control') === '1';
        if (r.status === 200) {
          const tb = performance.now(), blob = await r.blob(); v.dl = Math.round(performance.now() - tb); v.profile = (r.headers.get('X-Profile') || '').split('|'); if (document.activeElement !== quality && r.headers.get('X-Mode')) quality.value = r.headers.get('X-Mode'); v.seq = Number(r.headers.get('X-Seq')) || v.seq + 1; const fw = Number(r.headers.get('X-Width')), fh = Number(r.headers.get('X-Height'));
          const next = URL.createObjectURL(blob); img.onload = () => { if (url) URL.revokeObjectURL(url); url = next; }; img.src = next;
          if (fw && (fw !== v.fw || fh !== v.fh)) { v.fw = fw; v.fh = fh; layout(); }
          v.frames++; if (Date.now() - v.fpsAt > 2000) { v.fps = v.frames / ((Date.now() - v.fpsAt) / 1000); v.frames = 0; v.fpsAt = Date.now(); }
          say((v.control ? '可控制' : '仅查看') + ' · ' + v.fps.toFixed(1) + ' 帧/秒 · ' + (r.headers.get('X-Screen-Width') || '?') + '×' + (r.headers.get('X-Screen-Height') || '?') + (v.profile && v.profile[0] ? ' · 画质 ' + v.profile[0] + 'px/' + v.profile[1] : ''));
          if (v.mode === 'pad') paintCursor();
        } else if (r.status === 204) {
          if (r.headers.get('X-Online') === '0') { say('设备已离线，等待重新连接…', true); await sleep(2000); } else say((v.control ? '可控制' : '仅查看') + ' · 等待画面变化…');
        } else { say('出错：HTTP ' + r.status, true); await sleep(2000); }
      } catch { say('网络中断，重试中…', true); await sleep(2000); }
    }
  }

  (async () => {
    try { const s = await api('/api/auth/session'); if (!s.authenticated) return needLogin(); csrf = s.csrfToken || ''; } catch { return needLogin(); }
    showList();
  })();
})();
