// Yumeiro Windows 客户端（Electron 外壳）：加载你自己服务器上的网页；单实例、系统菜单、托盘；
// 另外有一个透明置顶的“桌宠”小窗口（梦色），可拖动，只在她身上时才拦截鼠标，其余区域点穿到下面的程序。
const { app, BrowserWindow, Menu, Tray, nativeImage, screen, shell, session, ipcMain, powerMonitor, dialog, net } = require('electron');
// 桶宠窗口是不可聚焦的透明置顶窗：Chromium 的“窗口遮挡检测”会把它当成被遮住而降到后台（动画卡顿、定时器变慢、document.hidden 为真），关掉它
(app.commandLine || { appendSwitch() {} }).appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
const fs = require('fs');
const path = require('path');

const configFile = path.join(app.getPath('userData'), 'config.json');
const readConfig = () => { try { return JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { return {}; } };
const writeConfig = value => { fs.mkdirSync(path.dirname(configFile), { recursive: true }); fs.writeFileSync(configFile, JSON.stringify(value, null, 2)); };
const patchConfig = patch => writeConfig({ ...readConfig(), ...patch });
const normalize = input => { try { const u = new URL(/^https?:\/\//i.test(input) ? input : 'https://' + input); return (u.protocol === 'https:' || u.protocol === 'http:') ? u.origin : null; } catch { return null; } };
const iconPath = path.join(__dirname, 'build', 'icon.png');

let win = null, pet = null, tray = null, quitting = false;
let lastLoadError = null, lastCert = null;
const hexFingerprint = cert => { const b64 = String(cert.fingerprint || '').replace(/^sha256\//, ''); try { return Buffer.from(b64, 'base64').toString('hex').toUpperCase().replace(/(..)(?=.)/g, '$1:'); } catch { return b64; } };
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  try {
    const origin = new URL(url).origin, mine = normalize(process.env.YUMEIRO_URL || '') || normalize(readConfig().server || '');
    if (mine && origin === mine) {
      const trusted = (readConfig().trustedCerts || {})[origin];
      if (readConfig().ignoreCertErrors === true || (trusted && trusted === certificate.fingerprint)) { event.preventDefault(); callback(true); return; }   // “忽略证书错误”开关只对你保存的这个服务器生效
      lastCert = { origin, fingerprint: certificate.fingerprint, hex: hexFingerprint(certificate), subject: certificate.subjectName, issuer: certificate.issuerName, expiry: certificate.validExpiry ? new Date(certificate.validExpiry * 1000).toLocaleDateString('zh-CN') : '', error };
    }
  } catch { /* 忽略 */ }
  callback(false);
});
// 探测一个地址是不是 Yumeiro（/api/health）。只发一个 GET；自签名证书也算“连得上”，所以这里不校验证书
const httpMod = require('http'), httpsMod = require('https');
function probeHealth(origin, timeout = 5000) {
  return new Promise(resolve => {
    try {
      const u = new URL(origin + '/api/health'), mod = u.protocol === 'https:' ? httpsMod : httpMod;
      const req = mod.get(u, { rejectUnauthorized: false, timeout }, res => {
        let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { if (body.length < 4096) body += chunk; });
        res.on('end', () => { let ok = false; try { ok = JSON.parse(body).ok === true; } catch { /* 不是 JSON */ } resolve({ reachable: true, ok }); });
      });
      req.on('timeout', () => { req.destroy(); resolve({ reachable: false }); });
      req.on('error', () => resolve({ reachable: false }));
    } catch { resolve({ reachable: false }); }
  });
}
const serverOrigin = () => normalize(process.env.YUMEIRO_URL || '') || normalize(readConfig().server || '');
const petEnabled = () => readConfig().petEnabled !== false;

function open() {
  const server = serverOrigin();
  win = new BrowserWindow({ width: 1280, height: 860, minWidth: 420, minHeight: 600, backgroundColor: '#12131a', title: 'Yumeiro', icon: iconPath, autoHideMenuBar: false, frame: false, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  firstScreen();
  // 只允许在你的服务器内导航；其它链接交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => { const mine = serverOrigin(); if (mine && !url.startsWith(mine) && !url.startsWith('file:')) { event.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); } });
  // 桌宠开着时，点关闭只是收起到托盘；真正退出用托盘菜单或“Yumeiro → 退出”
  win.on('close', event => { if (!quitting && (petEnabled() || remote.enabled()) && tray) { event.preventDefault(); win.hide(); } });
  win.on('closed', () => { win = null; });
  win.on('maximize', () => { try { win.webContents.send('win:state', true); } catch { /* 窗口正在关闭 */ } });
  win.on('unmaximize', () => { try { win.webContents.send('win:state', false); } catch { /* 窗口正在关闭 */ } });
  win.webContents.on('did-finish-load', pushPrefs);
  // 网页里点“退出登录”或会话过期后，不要显示网页的登录表单，回到客户端自己的登录界面（邀请注册页等公开页面不受影响）
  win.webContents.on('did-finish-load', async () => {
    try {
      const s = serverOrigin(), cur = win && !win.isDestroyed() ? win.webContents.getURL() : '';
      if (!s || !cur.startsWith(s) || !['/', '/settings', '/admin/settings', '/workspaces', '/market', '/remote'].includes(new URL(cur).pathname)) return;
      const r = await request('GET', s + '/api/auth/session', undefined, 6000);
      if (r.status === 200 && r.data && r.data.authenticated === false && win && !win.isDestroyed() && win.webContents.getURL().startsWith(s)) win.loadFile(path.join(__dirname, 'login.html'));
    } catch { /* 检查失败就保持当前页面 */ }
  });
  // 主页面加载失败（证书不被信任、端口没开、写成了 https 但服务器只有 http……）时，原来会一直停在空白页。现在换成说明页：错误原因、怎么处理、重试 / 信任证书 / 改用 http / 更换地址
  win.webContents.on('did-fail-load', (event, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || String(url).startsWith('file:') || !win || win.isDestroyed()) return;   // -3 = 被新的跳转取消
    let cert = null;
    try { if (lastCert && lastCert.origin === new URL(url).origin) cert = lastCert; } catch { /* 忽略 */ }
    lastLoadError = { url, code, desc, cert };
    win.loadFile(path.join(__dirname, 'error.html'));
  });
  win.webContents.on('render-process-gone', (event, details) => { if (details.reason !== 'clean-exit' && win && !win.isDestroyed()) setTimeout(() => { if (win && !win.isDestroyed()) firstScreen(); }, 800); });
}
function showMain() { if (!win) open(); else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } }

// ---- 桌宠窗口 ----
function showPet() {
  if (pet && !pet.isDestroyed()) { pet.show(); return; }
  const area = screen.getPrimaryDisplay().workArea;   // 窗口铺满整个工作区（透明、点穿）：桌宠的位置、走动、拖动都在页面里完成，不再被一个小窗口框住
  pet = new BrowserWindow({ width: area.width, height: area.height, x: area.x, y: area.y, transparent: true, frame: false, resizable: false, maximizable: false, minimizable: false, fullscreenable: false, hasShadow: false, skipTaskbar: true, focusable: false, alwaysOnTop: true, show: false, webPreferences: { preload: path.join(__dirname, 'pet-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  pet.setAlwaysOnTop(true, 'screen-saver');
  pet.setIgnoreMouseEvents(true, { forward: true });
  pet.loadFile(path.join(__dirname, 'pet.html'));
  pet.once('ready-to-show', () => pet && pet.showInactive());
  pet.webContents.once('did-finish-load', () => { sendPet('mute', readConfig().petMute ? '1' : ''); sendPet('wander', readConfig().petWander === false ? '' : '1'); sendPet('roam', readConfig().petRoam === 'bottom' ? 'bottom' : 'screen'); if (readConfig().petSize) sendPet('size', String(readConfig().petSize)); pushPrefs(); });
  pet.on('closed', () => { pet = null; });
}
function hidePet() { if (pet && !pet.isDestroyed()) pet.close(); pet = null; }
function setPet(on) { patchConfig({ petEnabled: on }); if (on) showPet(); else hidePet(); buildMenus(); }
const sendPet = (type, text) => { if (pet && !pet.isDestroyed()) pet.webContents.send('pet:event', { type, text }); };
// 桌宠窗口看不到你在其它程序里的操作，由这里用系统空闲时间告诉她：空闲 5 分钟以上就打盹，回来就醒（其余时间一直自己走动）
let petIdle = '0';
setInterval(() => {
  if (!pet || pet.isDestroyed()) return;
  try { const idle = powerMonitor.getSystemIdleTime() >= 300 ? '1' : '0'; if (idle !== petIdle) { petIdle = idle; sendPet('idle', idle); } } catch { /* 还没 ready 或系统不支持 */ }
}, 10000);
// 情绪记忆：桌宠窗口新记的事件交给主窗口（有登录态）合并写回服务器
ipcMain.on('pet:memory', (event, json) => { if (win && !win.isDestroyed()) win.webContents.send('pet:memory', String(json || '').slice(0, 20000)); });
// “识别表情图片 / AI 台词”两个开关：同步给桌宠窗口（显示）和主窗口（真正调用模型的是它，桌宠窗口没有登录态）
function pushPrefs() {
  const prefs = { aiLines: readConfig().petAiLines === true, stickerVision: readConfig().petSticker !== false, proactive: readConfig().petProactive !== false };
  sendPet('prefs', JSON.stringify(prefs));
  if (win && !win.isDestroyed()) win.webContents.send('pet:prefs', prefs);
}
// 桌宠想要一句 AI 台词：转给主窗口去调用模型，结果再以 say 事件回到桌宠
ipcMain.on('pet:ai-line', (event, kind, hint) => { if (readConfig().petAiLines === true && win && !win.isDestroyed()) win.webContents.send('pet:line-request', { kind: String(kind || '').slice(0, 20), hint: String(hint || '').slice(0, 80) }); });

ipcMain.on('pet:ignore', (event, ignore) => { if (pet && !pet.isDestroyed()) pet.setIgnoreMouseEvents(Boolean(ignore), { forward: true }); });
let exiting = false, exitDone = false;
// 退出动画：桌宠在页面里原地挥手告别约 1.1 秒，再朝最近的屏幕边缘走出去并淡出；这里只负责等它演完（约 2.8 秒）
function petFarewell() {
  return new Promise(resolve => {
    try { sendPet('bye', ''); setTimeout(resolve, 2900); } catch { resolve(); }
  });
}
// 桌宠想主动找你聊聊：打开主窗口，把开场白填进对话输入框
ipcMain.on('pet:starter', (event, text) => {
  showMain();
  const send = () => { if (win && !win.isDestroyed()) win.webContents.send('pet:starter', String(text || '').slice(0, 200)); };
  if (win && win.webContents.isLoading()) win.webContents.once('did-finish-load', () => setTimeout(send, 800)); else send();
});
ipcMain.on('pet:open', showMain);
ipcMain.on('pet:forward', (event, type, text) => { if (['done', 'think', 'say', 'error', 'praise', 'scold', 'comfort', 'sense', 'slow', 'model', 'usage', 'card', 'memory', 'todos', 'focus', 'todo-done', 'todo-due', 'streak'].includes(type)) sendPet(type, text); });
// 桌宠的番茄钟（独立计时，不依赖主界面）：专注 25 分钟 → 休息 5 分钟，并在专注结束时给一条休息建议
const REST_TIPS = ['站起来走一走，活动一下肩颈。', '喝杯水，顺便看看窗外的远处 20 秒。', '做几次深呼吸：吸 4 秒、停 4 秒、呼 6 秒。', '转转手腕和脚踝，伸个懒腰。', '闭上眼睛休息一分钟，让眼睛放松一下。', '起身接杯水，不要一直盯着屏幕。'];
const restTip = () => REST_TIPS[Math.floor(Math.random() * REST_TIPS.length)];
const focus = { phase: 'idle', endAt: 0, timer: null, done: 0 };
function focusClear() { clearTimeout(focus.timer); focus.timer = null; }
function focusStart() { focusClear(); focus.phase = 'work'; focus.endAt = Date.now() + 25 * 60000; sendPet('say', '开始专注 25 分钟，我陪着你～'); focus.timer = setTimeout(focusWorkEnd, 25 * 60000); }
function focusWorkEnd() { focus.done++; focus.phase = 'rest'; focus.endAt = Date.now() + 5 * 60000; sendPet('happy'); sendPet('say', '专注完成！🍅 今天第 ' + focus.done + ' 个。休息建议：' + restTip()); focus.timer = setTimeout(() => { focus.phase = 'idle'; focus.endAt = 0; sendPet('say', '休息结束啦，要继续吗？'); }, 5 * 60000); }
function focusStop() { focusClear(); const was = focus.phase; focus.phase = 'idle'; focus.endAt = 0; sendPet('say', was === 'work' ? '先停一下也没关系～' : '休息结束啦，要继续吗？'); }
const focusLeft = () => { const t = Math.max(0, Math.ceil((focus.endAt - Date.now()) / 1000)); return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'); };
ipcMain.on('pet:menu', () => {
  Menu.buildFromTemplate([
    { label: '打开 Yumeiro Open', click: showMain },
    { label: '打个招呼 Say hi', click: () => { sendPet('happy'); sendPet('say', '我在这儿陪你～ I\'m here!'); } },
    { label: '哄哄她 Cheer her up', click: () => sendPet('comfort') },
    { label: focus.phase === 'work' ? '🍅 专注中 ' + focusLeft() + '（点一下停止）' : focus.phase === 'rest' ? '☕ 休息中 ' + focusLeft() + '（点一下结束休息）' : '🍅 开始专注 25 分钟', click: () => (focus.phase === 'idle' ? focusStart() : focusStop()) },
    { label: '💡 给我一条休息建议', click: () => sendPet('say', restTip()) },
    { label: '忘掉聊过的事 Forget', click: () => sendPet('forget') },
    { label: '用量、心情与模型角色 Status', click: () => sendPet('card') },
    { label: '识别表情图片（用看图模型，耗额度）Sticker vision', type: 'checkbox', checked: readConfig().petSticker !== false, click: item => { patchConfig({ petSticker: item.checked }); pushPrefs(); sendPet('say', item.checked ? '你发表情包我会看的～' : '不再看你发的表情图啦'); } },
    { label: '主动找我说话 Talk to me first', type: 'checkbox', checked: readConfig().petProactive !== false, click: item => { patchConfig({ petProactive: item.checked }); pushPrefs(); sendPet('say', item.checked ? '那我有事就来找你啦～' : '好～我不会主动打扰你'); } },
    { label: 'AI 台词与情绪理解（消耗模型额度）AI lines', type: 'checkbox', checked: readConfig().petAiLines === true, click: item => { patchConfig({ petAiLines: item.checked }); pushPrefs(); sendPet('say', item.checked ? '以后由模型帮我想台词 AI lines on' : 'AI 台词关闭啦'); } },
    { type: 'separator' },
    { label: '漫游范围 Roam', submenu: [
      { label: '整个屏幕 Whole screen', type: 'radio', checked: readConfig().petRoam !== 'bottom', click: () => { patchConfig({ petRoam: 'screen' }); sendPet('roam', 'screen'); } },
      { label: '只在当前高度左右走 Stay on this row', type: 'radio', checked: readConfig().petRoam === 'bottom', click: () => { patchConfig({ petRoam: 'bottom' }); sendPet('roam', 'bottom'); } }
    ] },
    { label: '大小 Size', submenu: [['小 Small', 110], ['中 Medium', 150], ['大 Large', 200], ['特大 Extra large', 260]].map(([label, px]) => ({ label, type: 'radio', checked: (readConfig().petSize || 150) === px, click: () => { patchConfig({ petSize: px }); sendPet('size', String(px)); } })) },
    { label: '自己走动 Wander', type: 'checkbox', checked: readConfig().petWander !== false, click: item => { patchConfig({ petWander: item.checked }); sendPet('wander', item.checked ? '1' : ''); } },
    { label: readConfig().petMute ? '开启台词 Unmute' : '安静模式 Mute', click: () => { const mute = !readConfig().petMute; patchConfig({ petMute: mute }); sendPet('mute', mute ? '1' : ''); } },
    { label: '先躲起来 Hide pet', click: () => setPet(false) },
    { type: 'separator' },
    { label: '退出 Quit', click: () => { quitting = true; app.quit(); } }
  ]).popup();
});

// ---- 菜单与托盘 ----
function buildMenus() {
  const go = p => () => { showMain(); if (win && !win.isDestroyed() && win.webContents.getURL().endsWith('app.html')) win.webContents.send('app:go', p); };
  const petItem = { label: petEnabled() ? '隐藏桌宠 Hide pet' : '显示桌宠 Show pet', click: () => setPet(!petEnabled()) };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Yumeiro', submenu: [{ label: '聊天 Chat', click: go('/') }, { label: '工作区 Workspaces', click: go('/workspaces') }, { label: '远程控制 Remote', click: go('/remote') }, { type: 'separator' }, petItem, { label: '更换服务器地址… Change server', click: () => { showMain(); win && win.loadFile(path.join(__dirname, 'login.html')); } }, { label: '退出登录 / 切换账号 Sign out', click: () => { signOut(); } }, { label: '忽略证书错误（自签名证书，不安全）Ignore certificate errors', type: 'checkbox', checked: readConfig().ignoreCertErrors === true, click: item => { setIgnoreCert(item.checked); } }, { type: 'separator' }, { label: '退出 Quit', click: () => { quitting = true; app.quit(); } }] },
    { label: '视图 View', submenu: [{ role: 'reload', label: '刷新 Reload' }, { role: 'forceReload', label: '强制刷新 Force reload' }, { role: 'togglefullscreen', label: '全屏 Fullscreen' }, { role: 'zoomIn', label: '放大 Zoom in' }, { role: 'zoomOut', label: '缩小 Zoom out' }, { role: 'resetZoom', label: '恢复缩放 Reset zoom' }] },
    { label: '编辑 Edit', submenu: [{ role: 'undo', label: '撤销 Undo' }, { role: 'redo', label: '重做 Redo' }, { type: 'separator' }, { role: 'cut', label: '剪切 Cut' }, { role: 'copy', label: '复制 Copy' }, { role: 'paste', label: '粘贴 Paste' }, { role: 'selectAll', label: '全选 Select all' }] }
  ]));
  if (tray) tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 Yumeiro Open', click: showMain }, petItem,
    { label: '远程被控（手机可看 / 操控这台电脑）', type: 'checkbox', checked: remote.enabled(), click: item => remote.setEnabled(item.checked) },
    { label: '开机自启 Start with Windows', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: item => app.setLoginItemSettings({ openAtLogin: item.checked }) },
    { type: 'separator' }, { label: '退出 Quit', click: () => { quitting = true; app.quit(); } }
  ]));
}
function makeTray() {
  try { tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 })); tray.setToolTip('Yumeiro'); tray.on('click', showMain); } catch { tray = null; }
}

// ── 登录：客户端自己的登录界面（服务器地址 + 账号 + 密码），登录走服务器的 /api/auth/login，Cookie 保存在客户端自己的会话里，进入主界面后就是已登录状态 ──
let loginTarget = null;   // 正在登录的服务器 { host, ignore }：还没保存时，证书检查也要认它
function installCertVerify() {
  // 网页和主进程的 net 请求共用：只对“已保存 / 正在登录”的那台服务器，在开了“忽略证书错误”或指纹已信任时放行，其它一律按默认校验
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    try {
      if (request.verificationResult !== 'OK') {
        const mine = serverOrigin(), cfg = readConfig(), targets = [];
        if (mine) targets.push({ host: new URL(mine).hostname, ignore: cfg.ignoreCertErrors === true, pin: (cfg.trustedCerts || {})[mine] });
        if (loginTarget) targets.push({ host: loginTarget.host, ignore: loginTarget.ignore, pin: null });
        const hit = targets.find(item => item.host === request.hostname);
        if (hit && mine && hit.host === new URL(mine).hostname) lastCert = { origin: mine, fingerprint: request.certificate.fingerprint, hex: hexFingerprint(request.certificate), subject: request.certificate.subjectName, issuer: request.certificate.issuerName, expiry: request.certificate.validExpiry ? new Date(request.certificate.validExpiry * 1000).toLocaleDateString('zh-CN') : '', error: request.verificationResult };
        if (hit && (hit.ignore || (hit.pin && hit.pin === request.certificate.fingerprint))) { callback(0); return; }
      }
    } catch { /* 落到默认校验 */ }
    callback(-3);
  });
}
async function resolveOrigin(value) {      // 没写协议时 https 和 http 都试一下，选能连上的（都连得上时优先 https）
  const raw = String(value || '').trim();
  let server = normalize(raw);
  if (!server) return { error: '地址格式不对，例如 192.168.1.8:8787 或 https://example.com' };
  let note = '';
  if (!/^https?:\/\//i.test(raw)) {
    const host = server.replace(/^https:\/\//, '');
    const [s, p] = await Promise.all([probeHealth('https://' + host), probeHealth('http://' + host)]);
    if (s.ok || (s.reachable && !p.ok)) server = 'https://' + host;
    else if (p.ok || (p.reachable && !s.reachable)) { server = 'http://' + host; note = '该服务器没有开 HTTPS，已自动使用 http://（登录信息不加密，公网请配 HTTPS）'; }
  }
  return { server, note };
}
function request(method, url, body, timeout = 12000) {
  return new Promise(resolve => {
    const req = net.request({ method, url, session: session.defaultSession, useSessionCookies: true, redirect: 'error' });
    let done = false, timer = null;
    const finish = value => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
    timer = setTimeout(() => { try { req.abort(); } catch { /* 已结束 */ } finish({ status: 0, error: '连接超时' }); }, timeout);
    if (body && body.headers) for (const [key, value] of Object.entries(body.headers)) req.setHeader(key, value);
    if (body && body.onReq) body.onReq(req);
    req.on('response', res => {
      let text = ''; res.on('data', chunk => { text += chunk; });
      res.on('end', () => { let data = null; try { data = JSON.parse(text); } catch { /* 不是 JSON */ } finish({ status: res.statusCode, data }); });
    });
    req.on('error', error => finish({ status: 0, error: String((error && error.message) || error) }));
    if (body && body.json !== undefined) { req.setHeader('Content-Type', 'application/json'); req.write(JSON.stringify(body.json)); }
    if (body && body.raw) { req.setHeader('Content-Type', 'application/octet-stream'); req.write(body.raw); }
    req.end();
  });
}
// 启动时的第一屏：没配过服务器 → 登录界面；已经登录过（会话还有效）→ 直接进入；会话过期 → 登录界面（已填好地址和账号）；连不上 → 照常加载，由“连不上”说明页解释原因
async function firstScreen() {
  const server = serverOrigin();
  if (!server) { if (win && !win.isDestroyed()) win.loadFile(path.join(__dirname, 'login.html')); return; }
  const r = await request('GET', server + '/api/auth/session');
  if (!win || win.isDestroyed()) return;
  if (r.status === 0 || r.status >= 500) {          // 连不上 / 服务器出错：显示原因和处理办法
    lastLoadError = { url: server, code: r.status, desc: r.status ? 'HTTP_' + r.status : String(r.error || 'ERR_FAILED').replace(/^net::/, ''), cert: lastCert && lastCert.origin === server ? lastCert : null };
    win.loadFile(path.join(__dirname, 'error.html')); return;
  }
  if (r.status === 200 && r.data && r.data.authenticated === false) win.loadFile(path.join(__dirname, 'login.html'));
  else win.loadFile(path.join(__dirname, 'app.html'));   // 已登录：进入客户端自己的主界面
}
async function signOut() {
  try {
    const s = serverOrigin();
    if (s) { const cur = await request('GET', s + '/api/auth/session'); if (cur.data && cur.data.csrfToken) await request('POST', s + '/api/auth/logout', { headers: { 'X-CSRF-Token': cur.data.csrfToken }, json: {} }, 6000); }
  } catch { /* 服务器不可达也允许本地退出 */ }
  await session.defaultSession.clearStorageData({ storages: ['cookies'] });
  showMain(); if (win && !win.isDestroyed()) win.loadFile(path.join(__dirname, 'login.html'));
}
ipcMain.handle('yumeiro:login-defaults', () => { const cfg = readConfig(); return { server: cfg.server || '', email: cfg.email || '', ignoreCert: cfg.ignoreCertErrors === true }; });
ipcMain.handle('yumeiro:login', async (event, form) => {
  const f = form || {}, email = String(f.email || '').trim(), password = String(f.password || '');
  if (!email || !password) return { ok: false, error: '请填写账号和密码' };
  let host = '';
  try { host = new URL(normalize(String(f.server || '')) || 'x://').hostname; } catch { /* 下面会报地址错误 */ }
  loginTarget = host ? { host, ignore: Boolean(f.ignoreCert) } : null;
  try {
    const resolved = await resolveOrigin(f.server);
    if (resolved.error) return { ok: false, error: resolved.error };
    const origin = resolved.server;
    const r = await request('POST', origin + '/api/auth/login', { json: { email, password } });
    if (r.status === 200 && r.data && r.data.authenticated) {
      patchConfig({ server: origin, email, ignoreCertErrors: Boolean(f.ignoreCert) }); lastLoadError = null;
      if (win && !win.isDestroyed()) win.loadFile(path.join(__dirname, 'app.html'));
      return { ok: true, note: resolved.note };
    }
    if (r.status === 0) {
      const certProblem = /CERT|SSL|TLS/i.test(r.error || '');
      return { ok: false, needIgnore: certProblem, error: certProblem ? '服务器的证书不被信任（自签名证书常见）。确认是自己的服务器后，勾选下面的“忽略证书错误”再登录。' : '连不上服务器（' + (r.error || '未知错误') + '）。检查地址、端口，以及云服务器安全组 / 防火墙是否放行。' };
    }
    return { ok: false, error: (r.data && r.data.error) || '登录失败（HTTP ' + r.status + '）' };
  } finally { setTimeout(() => { loginTarget = null; }, 15000); }   // 登录成功后页面会马上加载，给它一点时间再清除临时放行目标
});
// 扫码登录：电脑（客户端）显示二维码，已登录的手机确认后，这里领取登录凭据；手机授权（忘记密码）同理，凭 6 位验证码
let pendingOrigin = '';
async function authTarget(form) {
  const f = form || {};
  let host = ''; try { host = new URL(normalize(String(f.server || '')) || 'x://').hostname; } catch { /* 下面报地址错误 */ }
  loginTarget = host ? { host, ignore: Boolean(f.ignoreCert) } : null;
  const resolved = await resolveOrigin(f.server);
  if (resolved.error) return { error: resolved.error };
  pendingOrigin = resolved.server; return { origin: resolved.server, ignoreCert: Boolean(f.ignoreCert) };
}
const enterApp = (origin, ignoreCert, email) => { patchConfig({ server: origin, ...(email ? { email } : {}), ignoreCertErrors: Boolean(ignoreCert) }); lastLoadError = null; if (win && !win.isDestroyed()) win.loadFile(path.join(__dirname, 'app.html')); };
ipcMain.handle('yumeiro:qr-start', async (event, form) => {
  const t = await authTarget(form); if (t.error) return { ok: false, error: t.error };
  const r = await request('POST', t.origin + '/api/auth/recover/qr/start', { json: { origin: t.origin } });
  if (r.status !== 201 || !r.data) return { ok: false, error: (r.data && r.data.error) || (r.status === 0 ? '连不上服务器：' + (r.error || '') : '生成二维码失败（HTTP ' + r.status + '）') };
  return { ok: true, origin: t.origin, ignoreCert: t.ignoreCert, id: r.data.id, secret: r.data.secret, url: r.data.url, svg: r.data.svg, expiresAt: r.data.expiresAt };
});
ipcMain.handle('yumeiro:qr-poll', async (event, ticket) => {
  const t = ticket || {}, origin = pendingOrigin; if (!origin || !t.id) return { status: 'unknown' };
  const st = await request('GET', origin + '/api/auth/recover/qr/status?id=' + encodeURIComponent(t.id), undefined, 8000);
  const status = st.data && st.data.status;
  if (status !== 'approved') return { status: status || 'pending' };
  const done = await request('POST', origin + '/api/auth/recover/qr/finish', { json: { id: t.id, secret: t.secret } });
  if (done.status === 200 && done.data && done.data.authenticated) { enterApp(origin, t.ignoreCert, done.data.email); return { status: 'done' }; }
  return { status: 'error', error: (done.data && done.data.error) || '登录失败（HTTP ' + done.status + '）' };
});
ipcMain.handle('yumeiro:phone-start', async (event, form) => {
  const t = await authTarget(form); if (t.error) return { ok: false, error: t.error };
  const email = String((form || {}).email || '').trim(); if (!email) return { ok: false, error: '请先填写账号（邮箱）' };
  const r = await request('POST', t.origin + '/api/auth/recover/phone/start', { json: { email } });
  if (r.status !== 201 || !r.data) return { ok: false, error: (r.data && r.data.error) || '发起失败（HTTP ' + r.status + '）' };
  return { ok: true, origin: t.origin, ignoreCert: t.ignoreCert, email, id: r.data.id, code: r.data.code, expiresAt: r.data.expiresAt };
});
ipcMain.handle('yumeiro:phone-poll', async (event, ticket) => {
  const t = ticket || {}, origin = pendingOrigin; if (!origin || !t.id) return { status: 'unknown' };
  const st = await request('GET', origin + '/api/auth/recover/phone/status?id=' + encodeURIComponent(t.id), undefined, 8000);
  const status = st.data && st.data.status;
  if (status !== 'approved') return { status: status || 'pending' };
  const done = await request('POST', origin + '/api/auth/recover/phone/finish', { json: { id: t.id } });
  if (done.status === 200 && done.data && done.data.authenticated) { enterApp(origin, t.ignoreCert, t.email); return { status: 'done' }; }
  return { status: 'error', error: (done.data && done.data.error) || '登录失败（HTTP ' + done.status + '）' };
});
ipcMain.handle('yumeiro:sign-out', () => signOut());

// 设置页里的桌宠 / 开机自启开关（和桌宠右键菜单、托盘菜单用同一份配置）
const petState = () => { const c = readConfig(); return { enabled: c.petEnabled !== false, wander: c.petWander !== false, mute: Boolean(c.petMute), proactive: c.petProactive !== false, roam: c.petRoam === 'bottom' ? 'bottom' : 'screen', size: Number(c.petSize) || 150, aiLines: c.petAiLines === true, sticker: c.petSticker !== false, autostart: app.getLoginItemSettings().openAtLogin }; };
ipcMain.handle('app:pet-get', () => petState());
ipcMain.handle('app:pet-set', (event, patch) => {
  const p = patch || {};
  if (typeof p.enabled === 'boolean') setPet(p.enabled);
  if (typeof p.wander === 'boolean') { patchConfig({ petWander: p.wander }); sendPet('wander', p.wander ? '1' : ''); }
  if (typeof p.mute === 'boolean') { patchConfig({ petMute: p.mute }); sendPet('mute', p.mute ? '1' : ''); }
  if (typeof p.proactive === 'boolean') { patchConfig({ petProactive: p.proactive }); pushPrefs(); }
  if (typeof p.aiLines === 'boolean') { patchConfig({ petAiLines: p.aiLines }); pushPrefs(); }
  if (typeof p.sticker === 'boolean') { patchConfig({ petSticker: p.sticker }); pushPrefs(); }
  if (p.roam === 'screen' || p.roam === 'bottom') { patchConfig({ petRoam: p.roam }); sendPet('roam', p.roam); }
  if (Number.isFinite(Number(p.size)) && Number(p.size) >= 80 && Number(p.size) <= 320) { patchConfig({ petSize: Math.round(Number(p.size)) }); sendPet('size', String(Math.round(Number(p.size)))); }
  if (typeof p.autostart === 'boolean') app.setLoginItemSettings({ openAtLogin: p.autostart });
  buildMenus();
  return petState();
});
ipcMain.handle('app:version', () => app.getVersion());

// ── 客户端自己的主界面（app.html）用的接口 ──
// 页面是本地文件，不能直接带 Cookie 访问服务器，所以接口请求都交给主进程：用同一个会话（登录状态）发出，写请求自动带 CSRF 令牌。
let csrfCache = '';
async function csrfToken(force) {
  if (csrfCache && !force) return csrfCache;
  const s = serverOrigin(); if (!s) return '';
  const r = await request('GET', s + '/api/auth/session', undefined, 8000);
  csrfCache = (r.data && r.data.csrfToken) || ''; return csrfCache;
}
async function apiCall(method, apiPath, json) {
  const s = serverOrigin(); method = String(method || 'GET').toUpperCase();
  if (!s) return { status: 0, error: '还没有配置服务器' };
  if (!String(apiPath).startsWith('/api/') || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return { status: 0, error: '不支持的请求' };
  const send = async force => request(method, s + apiPath, method === 'GET' ? undefined : { headers: { 'X-CSRF-Token': await csrfToken(force) }, json: json === undefined ? {} : json }, 30000);
  let r = await send(false);
  if (r.status === 403 && method !== 'GET') r = await send(true);
  if (r.status === 401) csrfCache = '';
  return r;
}
ipcMain.handle('app:api', (event, method, apiPath, json) => apiCall(method, apiPath, json));

// ── 远程被控端：让这台电脑可以被自己的手机 / 网页远程查看和操控（开关、自动配对、取消配对都在设置里）
const remote = require('./remote-agent')({ readConfig, patchConfig, serverOrigin, api: apiCall, onChange: () => buildMenus() });
ipcMain.handle('remote:get', () => remote.state());
ipcMain.handle('remote:set', async (event, patch) => {
  const p = patch || {};
  if (typeof p.control === 'boolean') await remote.setControl(p.control);
  if (typeof p.enabled === 'boolean') await remote.setEnabled(p.enabled);
  return remote.state();
});
ipcMain.handle('remote:unpair', () => remote.unpair());
// 壁纸只存在这台电脑上（和服务器、账号无关）：选一张本机图片，缩小后存进用户数据目录
const wallFile = () => path.join(app.getPath('userData'), 'wallpaper.jpg');
ipcMain.handle('wall:pick', async event => {
  const owner = BrowserWindow.fromWebContents(event.sender) || undefined;
  const r = await dialog.showOpenDialog(owner, { title: '选择壁纸图片', properties: ['openFile'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }] });
  if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
  try {
    const file = r.filePaths[0];
    if (!/\.(png|jpe?g|webp|gif|bmp)$/i.test(file)) return { ok: false, error: '只支持 png / jpg / webp / gif / bmp 图片' };
    const st = fs.statSync(file); if (!st.isFile() || st.size > 40 * 1024 * 1024) return { ok: false, error: '图片太大（上限 40 MB）' };
    let img = nativeImage.createFromBuffer(fs.readFileSync(file));
    if (img.isEmpty()) return { ok: false, error: '这个文件不是可以打开的图片' };
    const { width } = img.getSize(); if (width > 2560) img = img.resize({ width: 2560, quality: 'good' });
    fs.writeFileSync(wallFile(), img.toJPEG(88)); return { ok: true };
  } catch (e) { return { ok: false, error: '读取图片失败：' + String(e && e.message || e).slice(0, 120) }; }
});
ipcMain.handle('wall:get', () => { try { return 'data:image/jpeg;base64,' + fs.readFileSync(wallFile()).toString('base64'); } catch { return ''; } });
ipcMain.handle('wall:clear', () => { try { fs.unlinkSync(wallFile()); } catch { /* 本来就没有 */ } return true; });
ipcMain.handle('app:file', (event, apiPath) => new Promise(resolve => {      // 壁纸等需要登录的图片：取回来变成 data: 地址给页面用
  const s = serverOrigin(); if (!s || !String(apiPath).startsWith('/api/')) { resolve(''); return; }
  const req = net.request({ method: 'GET', url: s + apiPath, session: session.defaultSession, useSessionCookies: true, redirect: 'error' });
  const chunks = []; let size = 0, done = false; const finish = v => { if (!done) { done = true; resolve(v); } };
  const timer = setTimeout(() => { try { req.abort(); } catch { /* 已结束 */ } finish(''); }, 30000);
  req.on('response', res => {
    const type = String(res.headers['content-type'] || ''); if (res.statusCode !== 200 || !type.startsWith('image/')) { finish(''); return; }
    res.on('data', chunk => { size += chunk.length; if (size > 25 * 1024 * 1024) { try { req.abort(); } catch { /* 太大 */ } finish(''); } else chunks.push(chunk); });
    res.on('end', () => { clearTimeout(timer); finish('data:' + type.split(';')[0] + ';base64,' + Buffer.concat(chunks).toString('base64')); });
  });
  req.on('error', () => { clearTimeout(timer); finish(''); }); req.end();
}));
ipcMain.handle('app:text', (event, apiPath) => new Promise(resolve => {      // 查看附件：取回服务器保存的文件文字（提取出来的纯文本），只允许 /api/attachments/<id>
  const s = serverOrigin();
  if (!s || !/^[/]api[/]attachments[/][0-9a-f-]+$/i.test(String(apiPath))) { resolve({ status: 0, error: '不支持的请求' }); return; }
  const req = net.request({ method: 'GET', url: s + apiPath, session: session.defaultSession, useSessionCookies: true, redirect: 'error' });
  const chunks = []; let size = 0, done = false; const finish = v => { if (!done) { done = true; resolve(v); } };
  const timer = setTimeout(() => { try { req.abort(); } catch { /* 已结束 */ } finish({ status: 0, error: '读取超时' }); }, 30000);
  req.on('response', res => {
    const type = String(res.headers['content-type'] || '');
    if (res.statusCode !== 200) { clearTimeout(timer); finish({ status: res.statusCode, error: 'HTTP ' + res.statusCode }); return; }
    if (!type.startsWith('text/plain')) { clearTimeout(timer); finish({ status: 0, error: '这不是文本附件' }); return; }
    res.on('data', chunk => { size += chunk.length; if (size > 12 * 1024 * 1024) { try { req.abort(); } catch { /* 太大 */ } finish({ status: 0, error: '文件太大' }); } else chunks.push(chunk); });
    res.on('end', () => { clearTimeout(timer); finish({ status: 200, text: Buffer.concat(chunks).toString('utf8') }); });
  });
  req.on('error', error => { clearTimeout(timer); finish({ status: 0, error: String((error && error.message) || error) }); }); req.end();
}));
const streams = new Map();
const uploads = new Map();                 // 正在上传的附件：id → { req, timer, aborted }
ipcMain.on('app:upload-abort', (event, id) => { const u = uploads.get(Number(id)); if (u) { u.aborted = true; try { u.req.abort(); } catch { /* 已结束 */ } } });
ipcMain.handle('app:upload', async (event, name, bytes, uploadId) => {          // 聊天附件（图片 / 文件）：页面把文件内容交给主进程，由主进程带上登录状态和 CSRF 上传到服务器；上传进度定时推给页面，页面可以随时取消
  const s = serverOrigin(); if (!s) return { status: 0, error: '还没有配置服务器' };
  let raw; try { raw = Buffer.from(bytes); } catch { return { status: 0, error: '文件内容无效' }; }
  if (!raw.length) return { status: 0, error: '文件是空的' };
  if (raw.length > 25 * 1024 * 1024) return { status: 0, error: '文件太大（客户端上限 25 MB）' };
  const url = s + '/api/attachments?name=' + encodeURIComponent(String(name || '').replace(/[\u0000-\u001f]/g, '').slice(0, 80));
  const id = Number(uploadId) || 0, sender = event.sender;
  const hook = req => {
    if (!id) return;
    const old = uploads.get(id); if (old && old.timer) clearInterval(old.timer);
    const entry = { req, aborted: Boolean(old && old.aborted), timer: null };
    entry.timer = setInterval(() => { try { const p = req.getUploadProgress(); if (p && p.total > 0 && !sender.isDestroyed()) sender.send('app:upload-progress', id, p.current, p.total); } catch { /* 请求已结束 */ } }, 120);
    uploads.set(id, entry);
    if (entry.aborted) { try { req.abort(); } catch { /* 已结束 */ } }
  };
  const send = async force => request('PUT', url, { headers: { 'X-CSRF-Token': await csrfToken(force) }, raw, onReq: hook }, 180000);
  let r = await send(false);
  if (r.status === 403) r = await send(true);
  if (r.status === 401) csrfCache = '';
  const done = uploads.get(id); if (done) { clearInterval(done.timer); uploads.delete(id); if (done.aborted) return { status: 0, aborted: true, error: '已取消' }; }
  return r;
});
ipcMain.on('app:stream', async (event, id, apiPath, json) => {          // 聊天流式回复（SSE）：把服务器的事件原样转给页面
  const sender = event.sender, s = serverOrigin(), reply = (ev, data) => { if (!sender.isDestroyed()) sender.send('app:stream-event', id, ev, data); };
  const allowed = apiPath === '/api/chat/stream' || /^\/api\/workspaces\/[a-z0-9-]+\/runs$/.test(String(apiPath));
  if (!s || !allowed) { reply('http-error', { status: 0, error: '不支持的请求' }); return; }
  const req = net.request({ method: 'POST', url: s + apiPath, session: session.defaultSession, useSessionCookies: true, redirect: 'error' });
  streams.set(id, req);
  req.setHeader('Content-Type', 'application/json'); req.setHeader('X-CSRF-Token', await csrfToken(false));
  const { StringDecoder } = require('string_decoder'); const decoder = new StringDecoder('utf8'); let buffer = '', ended = false;
  const end = () => { if (!ended) { ended = true; streams.delete(id); reply('end', {}); } };
  req.on('response', res => {
    if (res.statusCode !== 200) {
      let text = ''; res.on('data', chunk => { text += chunk; });
      res.on('end', () => { let data = {}; try { data = JSON.parse(text); } catch { /* 不是 JSON */ } if (res.statusCode === 403) csrfCache = ''; reply('http-error', { status: res.statusCode, error: data.error || '' }); end(); }); return;
    }
    res.on('data', chunk => {
      buffer += decoder.write(chunk); let at;
      while ((at = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, at); buffer = buffer.slice(at + 2); let ev = 'message', data = '';
        for (const line of block.split('\n')) { if (line.startsWith('event:')) ev = line.slice(6).trim(); else if (line.startsWith('data:')) data += line.slice(5).trim(); }
        let parsed = {}; try { parsed = JSON.parse(data || '{}'); } catch { /* 忽略坏块 */ }
        reply(ev, parsed);
      }
    });
    res.on('end', end); res.on('aborted', end);
  });
  req.on('error', error => { reply('http-error', { status: 0, error: '连不上服务器：' + String((error && error.message) || error) }); end(); });
  req.on('abort', end);
  req.write(JSON.stringify(json || {})); req.end();
});
ipcMain.on('app:stream-abort', (event, id) => { const req = streams.get(id); if (req) { try { req.abort(); } catch { /* 已结束 */ } } });
ipcMain.on('app:open-external', (event, url) => { if (/^https?:/i.test(String(url))) shell.openExternal(String(url)); });
// 功能页全部由 app.html 的本地原生路由渲染；不再创建 WebContentsView。服务器页面不会进入桌面客户端。

ipcMain.handle('yumeiro:save-server', async (event, value) => {
  const resolved = await resolveOrigin(value);
  if (resolved.error) return { ok: false, error: resolved.error };
  patchConfig({ server: resolved.server }); lastLoadError = null; if (win) firstScreen(); return { ok: true, server: resolved.server, note: resolved.note };
});
// 自绘标题栏的窗口控制（无边框窗口没有系统按钮和菜单栏，菜单从标题栏的 ☰ 按钮弹出）
ipcMain.on('win:ctl', (event, action) => {
  const w = BrowserWindow.fromWebContents(event.sender); if (!w || w.isDestroyed()) return;
  if (action === 'min') w.minimize();
  else if (action === 'max') { if (w.isMaximized()) w.unmaximize(); else w.maximize(); }
  else if (action === 'close') w.close();
  else if (action === 'menu') { const m = Menu.getApplicationMenu(); if (m) m.popup({ window: w, x: 8, y: 40 }); }
});
ipcMain.handle('win:is-max', event => { const w = BrowserWindow.fromWebContents(event.sender); return Boolean(w && !w.isDestroyed() && w.isMaximized()); });
ipcMain.handle('yumeiro:get-server', () => readConfig().server || '');
ipcMain.handle('yumeiro:last-error', () => lastLoadError ? { url: lastLoadError.url, code: lastLoadError.code, desc: lastLoadError.desc, cert: lastLoadError.cert ? { subject: lastLoadError.cert.subject, issuer: lastLoadError.cert.issuer, expiry: lastLoadError.cert.expiry, hex: lastLoadError.cert.hex, error: lastLoadError.cert.error } : null } : null);
ipcMain.handle('yumeiro:retry', () => { if (win && !win.isDestroyed()) firstScreen(); });
ipcMain.handle('yumeiro:change-server', () => { if (win) win.loadFile(path.join(__dirname, 'login.html')); });
ipcMain.handle('yumeiro:use-scheme', (event, scheme) => {
  const s = serverOrigin(); if (!s || !win) return;
  const next = s.replace(/^https?:/, scheme === 'http' ? 'http:' : 'https:'); patchConfig({ server: next }); firstScreen();
});
// “忽略证书错误”：给用自签名证书的自建服务器。只对已保存的服务器地址生效（见上面的 certificate-error），开启前先确认；开启后就发现不了中间人攻击
async function setIgnoreCert(on) {
  if (on) {
    const { response } = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, { type: 'warning', buttons: ['取消', '我知道风险，忽略'], defaultId: 0, cancelId: 0, title: '忽略证书错误', message: '要忽略这个服务器的证书错误吗？', detail: '连接仍然加密，但客户端不再验证对方是不是真正的服务器，遇到中间人攻击也发现不了。只在你确认这是自己的服务器、网络可信时使用；设置只对当前保存的服务器地址生效。更安全的办法是给服务器配正式证书，或只信任这一张证书。' });
    if (response !== 1) { buildMenus(); return false; }
  }
  patchConfig({ ignoreCertErrors: Boolean(on) }); buildMenus();
  const s = serverOrigin(); if (s && win && !win.isDestroyed() && !win.webContents.getURL().startsWith('file:')) win.loadURL(s);
  return true;
}
ipcMain.handle('yumeiro:set-ignore-cert', async (event, on) => { const ok = await setIgnoreCert(Boolean(on)); if (ok && on && win && !win.isDestroyed() && win.webContents.getURL().includes('error.html')) { lastLoadError = null; firstScreen(); } return ok; });
ipcMain.handle('yumeiro:get-ignore-cert', () => readConfig().ignoreCertErrors === true);
ipcMain.handle('yumeiro:trust-cert', () => {
  const s = serverOrigin();
  if (!s || !win || !lastLoadError || !lastLoadError.cert || lastLoadError.cert.origin !== s) return;
  patchConfig({ trustedCerts: { ...(readConfig().trustedCerts || {}), [s]: lastLoadError.cert.fingerprint } });
  lastLoadError = null; firstScreen();
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showMain);
  app.on('before-quit', event => {
    quitting = true; remote.stop();
    // 退出前先让桌宠向你道别、走出屏幕（约 2.8 秒），再真正退出；环境变量 YUMEIRO_NO_EXIT_ANIM=1 可跳过
    if (exitDone || exiting || !pet || pet.isDestroyed() || !pet.isVisible() || process.env.YUMEIRO_NO_EXIT_ANIM) return;
    event.preventDefault(); exiting = true;
    petFarewell().finally(() => { exitDone = true; app.quit(); });
  });
  app.whenReady().then(() => {
    installCertVerify();
    const fitPet = () => { if (pet && !pet.isDestroyed()) pet.setBounds(screen.getPrimaryDisplay().workArea); };
    for (const name of ['display-metrics-changed', 'display-added', 'display-removed']) screen.on(name, fitPet);
    // 侧边栏的内嵌浏览器：有些网站用 X-Frame-Options / frame-ancestors 禁止被嵌入。这里只对“主窗口里、非本站”的子框架去掉这两项，其它请求一律不动
    session.defaultSession.webRequest.onHeadersReceived({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      const headers = details.responseHeaders || {};
      try {
        const mine = serverOrigin();
        if (details.resourceType === 'subFrame' && win && !win.isDestroyed() && details.webContents && details.webContents.id === win.webContents.id && (!mine || new URL(details.url).origin !== mine)) {
          for (const name of Object.keys(headers)) {
            const lower = name.toLowerCase();
            if (lower === 'x-frame-options') delete headers[name];
            else if (lower === 'content-security-policy' || lower === 'content-security-policy-report-only') headers[name] = headers[name].map(value => value.replace(/(^|;)\s*frame-ancestors[^;]*/gi, '$1'));
          }
        }
      } catch { /* 出任何差错都原样放行 */ }
      callback({ responseHeaders: headers });
    });
    // 麦克风（语音输入 / 通话）、剪贴板、全屏可用；其它权限一律拒绝
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => callback(['media', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen'].includes(permission)));
    makeTray(); buildMenus(); open();
    if (petEnabled()) showPet();
    if (remote.enabled()) setTimeout(() => remote.start(), 1500);   // 上次开着被控端，这次随客户端自动恢复
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) open(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !(tray && (petEnabled() || remote.enabled()))) app.quit(); });
}
