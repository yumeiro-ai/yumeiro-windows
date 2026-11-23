// 主题切换：自动（跟随系统）/ 浅色 / 深色。选择保存在浏览器本地，各页面共用。
(() => {
  const KEY = 'yumeiro.theme', MODES = ['auto', 'light', 'dark'], ICON = { auto: '◐', light: '☀', dark: '☾' }, NAME = { auto: '跟随系统', light: '浅色', dark: '深色' };
  const media = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
  const get = () => { try { const v = localStorage.getItem(KEY); return MODES.includes(v) ? v : 'auto'; } catch { return 'auto'; } };
  const resolved = mode => mode === 'auto' ? (media && media.matches ? 'dark' : 'light') : mode;
  function apply(mode = get()) {
    document.documentElement.setAttribute('data-theme', resolved(mode));
    document.dispatchEvent(new CustomEvent('yumeiro-theme', { detail: { mode, theme: resolved(mode) } }));
    const button = document.getElementById('themeButton');
    if (button) { button.textContent = ICON[mode]; button.title = '主题：' + NAME[mode] + '（点击切换）'; button.setAttribute('aria-label', button.title); }
  }
  function set(mode) { try { localStorage.setItem(KEY, mode); } catch { /* 无痕模式 */ } apply(mode); }
  const next = () => MODES[(MODES.indexOf(get()) + 1) % MODES.length];
  if (media) media.addEventListener('change', () => { if (get() === 'auto') apply('auto'); });
  window.yumeiroTheme = { get, set, next, resolved: () => resolved(get()) };
  apply();

  function mount() {
    if (document.getElementById('themeButton')) return true;
    const anchor = document.getElementById('settings');
    if (!anchor) return false;
    const button = document.createElement('button');
    button.id = 'themeButton'; button.type = 'button'; button.className = 'icon-button';
    button.addEventListener('click', () => set(next()));
    anchor.before(button); apply();
    return true;
  }
  let tries = 0;
  const timer = setInterval(() => { if (mount() || ++tries > 100) clearInterval(timer); }, 400);
})();

// 手机版：顶栏上十几个工具按钮（工具箱 / 文档 / 下载 / 宠物 / 调色 / 记忆 / 设置 / 退出…）收进一个“⋯ 工具”面板，顶栏只留菜单、标题和这一个按钮。
// 按钮本身仍留在原处（别的脚本还在用），面板里的格子只是代点；每次打开时按当前有哪些按钮重新生成。
(() => {
  if (document.body?.dataset.page !== 'app' && !document.querySelector('.top-right')) return;
  const mq = matchMedia('(max-width:760px)');
  let panel = null, toggle = null;
  const labelOf = b => { const t = (b.getAttribute('title') || b.getAttribute('aria-label') || b.textContent || '').trim(); return t.replace(/[（(].*$/, '').slice(0, 8) || '工具'; };
  const iconOf = b => { const t = (b.textContent || '').trim(); return t && t.length <= 4 ? t : '⋯'; };
  function close() { panel?.remove(); panel = null; toggle?.setAttribute('aria-expanded', 'false'); }
  function open() {
    close();
    const buttons = [...document.querySelectorAll('.top-right button')].filter(b => b !== toggle && !b.hidden && getComputedStyle(b).display !== 'none');
    panel = document.createElement('div'); panel.id = 'mobileToolsPanel'; panel.setAttribute('role', 'menu');
    const status = document.getElementById('statusText')?.textContent || '';
    if (status) { const s = document.createElement('div'); s.className = 'mt-status'; s.textContent = status; panel.append(s); }
    const grid = document.createElement('div'); grid.className = 'mt-grid';
    for (const b of buttons) {
      const tile = document.createElement('button'); tile.type = 'button'; tile.className = 'mt-tile'; tile.disabled = b.disabled;
      const i = document.createElement('span'); i.className = 'mt-i'; i.textContent = iconOf(b);
      const l = document.createElement('span'); l.className = 'mt-l'; l.textContent = labelOf(b);
      tile.append(i, l); tile.addEventListener('click', () => { close(); b.click(); }); grid.append(tile);
    }
    panel.append(grid); document.body.append(panel); toggle?.setAttribute('aria-expanded', 'true');
    setTimeout(() => addEventListener('pointerdown', function off(e) { if (panel && !panel.contains(e.target) && e.target !== toggle && !toggle?.contains(e.target)) close(); if (!panel || !panel.isConnected) removeEventListener('pointerdown', off, true); }, true), 0);
  }
  function mountTools() {
    const left = document.querySelector('.top-left'); if (!left || !mq.matches) { document.body.classList.remove('m-tools'); close(); return; }
    if (!toggle || !toggle.isConnected) {
      toggle = document.createElement('button'); toggle.id = 'mobileToolsButton'; toggle.type = 'button'; toggle.className = 'icon-button'; toggle.setAttribute('aria-label', '工具'); toggle.setAttribute('aria-haspopup', 'menu'); toggle.textContent = '⋯';
      toggle.addEventListener('click', () => (panel ? close() : open())); left.append(toggle);
    }
    document.body.classList.add('m-tools');
  }
  mq.addEventListener?.('change', mountTools);
  let tries = 0; const t = setInterval(() => { mountTools(); if (toggle?.isConnected || ++tries > 100) clearInterval(t); }, 400);
})();
