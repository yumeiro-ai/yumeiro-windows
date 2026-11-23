const { contextBridge, ipcRenderer } = require('electron');
const chromeListeners = [];
const fireChrome = name => { for (const cb of chromeListeners) { try { cb(name); } catch { /* 页面脚本出错不影响标题栏 */ } } };
contextBridge.exposeInMainWorld('yumeiroApp', {
  saveServer: value => ipcRenderer.invoke('yumeiro:save-server', value),
  getServer: () => ipcRenderer.invoke('yumeiro:get-server'),
  login: form => ipcRenderer.invoke('yumeiro:login', form),
  loginDefaults: () => ipcRenderer.invoke('yumeiro:login-defaults'),
  // 扫码登录 / 手机授权（忘记密码）：和网页登录页同一套服务器接口
  qrStart: form => ipcRenderer.invoke('yumeiro:qr-start', form),
  qrPoll: ticket => ipcRenderer.invoke('yumeiro:qr-poll', ticket),
  phoneStart: form => ipcRenderer.invoke('yumeiro:phone-start', form),
  phonePoll: ticket => ipcRenderer.invoke('yumeiro:phone-poll', ticket),
  signOut: () => ipcRenderer.invoke('yumeiro:sign-out'),
  // 客户端自己的主界面（app.html）用：服务器接口走主进程代理；聊天流式回复；嵌在右侧的服务器功能页
  api: (method, path, body) => ipcRenderer.invoke('app:api', String(method || 'GET'), String(path || ''), body),
  file: path => ipcRenderer.invoke('app:file', String(path || '')),
  wallPick: () => ipcRenderer.invoke('wall:pick'),
  wallGet: () => ipcRenderer.invoke('wall:get'),
  wallClear: () => ipcRenderer.invoke('wall:clear'),
  upload: (name, bytes, id) => ipcRenderer.invoke('app:upload', String(name || ''), bytes, Number(id) || 0),
  uploadAbort: id => ipcRenderer.send('app:upload-abort', Number(id) || 0),
  onUploadProgress: callback => ipcRenderer.on('app:upload-progress', (event, id, current, total) => callback(id, current, total)),
  text: path => ipcRenderer.invoke('app:text', String(path || '')),
  stream: (id, path, body) => ipcRenderer.send('app:stream', Number(id) || 0, String(path || ''), body),
  streamAbort: id => ipcRenderer.send('app:stream-abort', Number(id) || 0),
  onStream: callback => { const handler = (event, id, name, data) => callback(id, name, data); ipcRenderer.on('app:stream-event', handler); return () => ipcRenderer.removeListener('app:stream-event', handler); },
  onGo: callback => ipcRenderer.on('app:go', (event, target) => callback(String(target || ''))),
  openExternal: url => ipcRenderer.send('app:open-external', String(url || '')),
  // 自绘标题栏：设置标题（可带“⋯”更多按钮）；标题栏按钮（侧栏 / 后退 / 前进 / 更多）点击后回调
  setTitle: (text, more) => { const t = document.querySelector('#ymTitlebar .ymtitle'), m = document.querySelector('#ymTitlebar .ymmore'); if (t) t.textContent = String(text || ''); if (m) m.hidden = !more; },
  onChrome: callback => { chromeListeners.push(callback); },
  remoteGet: () => ipcRenderer.invoke('remote:get'),
  remoteSet: patch => ipcRenderer.invoke('remote:set', patch),
  remoteUnpair: () => ipcRenderer.invoke('remote:unpair'),
  petGet: () => ipcRenderer.invoke('app:pet-get'),
  petSet: patch => ipcRenderer.invoke('app:pet-set', patch),
  version: () => ipcRenderer.invoke('app:version'),
  lastError: () => ipcRenderer.invoke('yumeiro:last-error'),
  retry: () => ipcRenderer.invoke('yumeiro:retry'),
  changeServer: () => ipcRenderer.invoke('yumeiro:change-server'),
  useScheme: scheme => ipcRenderer.invoke('yumeiro:use-scheme', String(scheme || '')),
  trustCert: () => ipcRenderer.invoke('yumeiro:trust-cert'),
  setIgnoreCert: on => ipcRenderer.invoke('yumeiro:set-ignore-cert', Boolean(on)),
  getIgnoreCert: () => ipcRenderer.invoke('yumeiro:get-ignore-cert'),
  // 网页里的聊天事件转给桌面上的桌宠（done / think / say）
  petEvent: (type, text) => ipcRenderer.send('pet:forward', String(type || ''), String(text || '').slice(0, 20000)),
  // 桌宠右键菜单里的开关（识别表情图片 / AI 台词）和“想要一句 AI 台词”的请求：主窗口有登录态，由它来调用模型
  onPrefs: callback => ipcRenderer.on('pet:prefs', (event, prefs) => callback(prefs || {})),
  onLineRequest: callback => ipcRenderer.on('pet:line-request', (event, request) => callback(request || {})),
  // 桌宠窗口新记下的情绪记忆：主窗口有登录态，由它合并写回服务器
  onMemory: callback => ipcRenderer.on('pet:memory', (event, json) => callback(String(json || ''))),
  // 桌宠主动找你聊天时按下“聊聊”：把开场白填进输入框
  onStarter: callback => ipcRenderer.on('pet:starter', (event, text) => callback(String(text || '')))
});

// ── 桌面端外观：自绘标题栏（无系统边框）+ 玻璃质感皮肤 ──────────────────────────────
// 主窗口是无边框窗口：上面一条自绘标题栏（菜单 ☰、后退 / 前进、标题、最小化 / 最大化 / 关闭），整条可拖动。
// 默认用深色主题（用户自己选过主题就按用户的）；面板在设了壁纸时是半透明的玻璃质感，能透出壁纸。
// 本地的登录页 / 说明页和服务器的页面共用这套，所以放在 preload 里，服务器不用改。
try { if (!localStorage.getItem('yumeiro.theme')) localStorage.setItem('yumeiro.theme', 'dark'); } catch { /* 存储不可用就跟随系统 */ }
const CHROME_CSS = `
html.ym-chrome body{padding-top:40px;box-sizing:border-box}
html.ym-embedded body{padding-top:0}html.ym-embedded .app{height:100dvh}
html.ym-chrome .app{height:calc(100dvh - 40px)}
html.ym-chrome ::-webkit-scrollbar{width:10px;height:10px}html.ym-chrome ::-webkit-scrollbar-track{background:transparent}
html.ym-chrome ::-webkit-scrollbar-thumb{background:#ffffff33;border-radius:8px;border:2px solid transparent;background-clip:padding-box}html.ym-chrome ::-webkit-scrollbar-thumb:hover{background:#ffffff59;background-clip:padding-box;border:2px solid transparent}
#ymTitlebar{position:fixed;top:0;left:0;right:0;height:40px;z-index:2147483000;display:flex;align-items:center;gap:2px;padding-left:8px;-webkit-app-region:drag;user-select:none;-webkit-user-select:none;
  font:13px/1 system-ui,"Microsoft YaHei",sans-serif;color:#e8e9ee;background:linear-gradient(#0a0c12d9,#0a0c1299);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-bottom:1px solid #ffffff14}
html[data-theme=light] #ymTitlebar{color:#262431;background:linear-gradient(#ffffffe6,#ffffffb3);border-bottom-color:#00000014}
#ymTitlebar button{-webkit-app-region:no-drag;display:inline-flex;align-items:center;justify-content:center;border:0;background:transparent;color:inherit;cursor:pointer;opacity:.85;padding:0}
#ymTitlebar button:hover{opacity:1;background:#ffffff1f}html[data-theme=light] #ymTitlebar button:hover{background:#0000001a}
#ymTitlebar .nav{width:32px;height:28px;border-radius:8px}
#ymTitlebar .ymtitle{margin:0 10px;font-weight:600;letter-spacing:.2px;opacity:.9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
#ymTitlebar .ymgrow{flex:1}#ymTitlebar .ymmore[hidden]{display:none}
#ymTitlebar .win{width:46px;height:40px;border-radius:0}#ymTitlebar .win.close:hover{background:#e5384a;color:#fff}
#ymTitlebar svg{width:14px;height:14px;pointer-events:none;stroke:currentColor;fill:none;stroke-width:1.4}
html.ym-chrome[data-theme=dark]{--side:#0d0f16b3}
html.ym-chrome[data-theme=dark] .sidebar{backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px)}
html.ym-chrome[data-theme=dark] body.has-wallpaper .topbar{background:#0b0d1480}
html.ym-chrome[data-theme=dark] body.has-wallpaper .composer,html.ym-chrome[data-theme=dark] body.has-wallpaper .bubble,html.ym-chrome[data-theme=dark] body.has-wallpaper .suggestion,
html.ym-chrome[data-theme=dark] body.has-wallpaper .team-nav,html.ym-chrome[data-theme=dark] body.has-wallpaper .team-main,html.ym-chrome[data-theme=dark] body.has-wallpaper .team-pagehead,
html.ym-chrome[data-theme=dark] body.has-wallpaper .team-row,html.ym-chrome[data-theme=dark] body.has-wallpaper .mk-card{background:#12151dc4;backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-color:#ffffff1a}
html.ym-chrome[data-theme=dark] body.has-wallpaper .message.user .bubble{background:#3b3f55d9}
`;
const ICON = {
  side: '<svg viewBox="0 0 14 14"><rect x="2" y="2.5" width="10" height="9" rx="1.8"/><path d="M5.5 2.5v9"/></svg>',
  more: '<svg viewBox="0 0 14 14"><circle cx="3" cy="7" r=".6"/><circle cx="7" cy="7" r=".6"/><circle cx="11" cy="7" r=".6"/></svg>',
  menu: '<svg viewBox="0 0 14 14"><path d="M2 3.5h10M2 7h10M2 10.5h10"/></svg>',
  back: '<svg viewBox="0 0 14 14"><path d="M8.5 2.5 4 7l4.5 4.5"/></svg>',
  fwd: '<svg viewBox="0 0 14 14"><path d="M5.5 2.5 10 7l-4.5 4.5"/></svg>',
  min: '<svg viewBox="0 0 14 14"><path d="M2 7h10"/></svg>',
  max: '<svg viewBox="0 0 14 14"><rect x="2.5" y="2.5" width="9" height="9" rx="1"/></svg>',
  restore: '<svg viewBox="0 0 14 14"><rect x="2.5" y="4.5" width="7" height="7" rx="1"/><path d="M4.5 4.5v-2h7v7h-2"/></svg>',
  close: '<svg viewBox="0 0 14 14"><path d="M3 3l8 8M11 3l-8 8"/></svg>'
};
const EMBEDDED = Array.isArray(process.argv) && process.argv.includes('--ym-embedded');
function installChrome() {
  if (document.getElementById('ymTitlebar') || !document.body) return;
  document.documentElement.classList.add('ym-chrome', 'in-desktop-app');
  if (EMBEDDED) document.documentElement.classList.add('ym-embedded');
  const style = document.createElement('style'); style.textContent = CHROME_CSS; document.head.append(style);
  if (EMBEDDED) return;
  const bar = document.createElement('div'); bar.id = 'ymTitlebar';
  const btn = (cls, svg, title, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.title = title; b.setAttribute('aria-label', title); b.innerHTML = svg; b.addEventListener('click', fn); return b; };
  const native = location.protocol === 'file:' && /app\.html$/.test(location.pathname);   // 客户端自己的主界面：标题栏带“侧栏 / 后退 / 前进”，标题随页面变化
  const title = document.createElement('span'); title.className = 'ymtitle'; title.textContent = native ? '' : 'Yumeiro 梦色';
  const more = btn('nav ymmore', ICON.more, '更多', () => fireChrome('more')); more.hidden = true;
  const grow = document.createElement('span'); grow.className = 'ymgrow';
  const maxBtn = btn('win', ICON.max, '最大化', () => ipcRenderer.send('win:ctl', 'max'));
  bar.append(
    ...(native ? [btn('nav', ICON.side, '收起 / 展开侧栏', () => fireChrome('side'))] : []),
    btn('nav', ICON.menu, '菜单', () => ipcRenderer.send('win:ctl', 'menu')),
    ...(native ? [btn('nav', ICON.back, '后退', () => fireChrome('back')), btn('nav', ICON.fwd, '前进', () => fireChrome('forward'))] : [btn('nav', ICON.back, '后退', () => history.back()), btn('nav', ICON.fwd, '前进', () => history.forward())]),
    title, ...(native ? [more] : []), grow,
    btn('win', ICON.min, '最小化', () => ipcRenderer.send('win:ctl', 'min')), maxBtn, btn('win close', ICON.close, '关闭', () => ipcRenderer.send('win:ctl', 'close')));
  document.body.prepend(bar);
  const setMax = on => { maxBtn.innerHTML = on ? ICON.restore : ICON.max; maxBtn.title = on ? '还原' : '最大化'; };
  ipcRenderer.invoke('win:is-max').then(setMax).catch(() => {});
  ipcRenderer.on('win:state', (event, on) => setMax(Boolean(on)));
  bar.addEventListener('dblclick', event => { if (event.target === bar || event.target === title || event.target === grow) ipcRenderer.send('win:ctl', 'max'); });
}
window.addEventListener('DOMContentLoaded', installChrome);
