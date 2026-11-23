import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(path.join(root, file), 'utf8');

test('pwa.js：在桌面客户端里不显示“安装客户端”提醒 / 下载按钮 / Service Worker', () => {
  const src = read('public/pwa.js');
  assert.match(src, /const IN_APP = Boolean\(window\.yumeiroApp\)/); assert.match(src, /in-desktop-app/);
  assert.match(src, /!IN_APP && 'serviceWorker' in navigator/);
  assert.match(src, /!IN_APP && !document\.getElementById\('clientGuideButton'\)/);
  // 不再有盖住聊天框的底部提醒条，也不再有和 ⬇ 重复的 📲 安装按钮（安装入口收在 ⬇ 的引导里）
  assert.doesNotMatch(src, /showReminder|clientReminder|installButton/);
});

test('pwa.js：el() 必须真正绑定 on:{click}，否则“安装 / 下载”和 × 都点不动', () => {
  const src = read('public/pwa.js');
  const el = src.slice(src.indexOf('const el ='), src.indexOf('const IN_APP'));
  assert.match(el, /key === 'on'/, 'el() 要识别 on 属性');
  assert.match(el, /addEventListener\(name, handler\)/, 'on 里的处理函数要用 addEventListener 绑定');
  assert.doesNotMatch(el, /Object\.assign\(document\.createElement/, '不能再把 on 当普通属性赋值给节点');
  // 所有页面脚本里的 el() 都得认识 on（这一类 bug 只会在 pwa.js 这种漏写的地方出现）
  for (const file of ['draw', 'guide', 'history', 'memory', 'portal', 'recover', 'remote', 'side', 'speak', 'team', 'vision']) {
    assert.match(read(`public/${file}.js`), /(k|key) === 'on'/, `${file}.js 的 el() 要认识 on`);
  }
});

test('桌宠：姿势预先叠放（不再每帧换 src）、网页走动用合成器动画、桌面端不被“页面隐藏”挡住', () => {
  const pet = read('public/pet.js');
  assert.match(pet, /pet-stage/); assert.match(pet, /frameEls\[name\]/);
  assert.doesNotMatch(pet, /img\.src = FRAMES\[name\]/, '切换姿势不能再改 src');
  assert.match(pet, /root\.style\.translate = /, '网页走动用 translate 动画');
  assert.doesNotMatch(pet, /root\.style\.transition = 'left '/, '不再用 left 过渡（每帧布局 + 重绘）');
  assert.match(pet, /function settleWalk/); assert.match(pet, /function commitWalk/);
  assert.match(pet, /\(!host && document\.hidden\)/, '桌面端的桌宠窗口不能因为 document.hidden 不走动');
  assert.match(pet, /type === 'idle'/, '桌面端的“系统空闲”事件');
  assert.match(pet, /if \(!host && Date\.now\(\) - lastActive > 5 \* 60000\) sleep\(\)/, '桌面端不再按“桌宠窗口里没动静”打盹');
  assert.match(pet, /requestAnimationFrame\(applyTilt\)/, '跟随鼠标要节流到每帧一次');
  assert.doesNotMatch(pet, /我陆着你|挨低落|陈陈聊一聊/, '错别字');
});

test('Windows 客户端：桌宠窗口不被后台节流、按系统空闲时间打盹', () => {
  const main = read('clients/windows/main.js');
  assert.match(main, /backgroundThrottling: false/);
  assert.match(main, /CalculateNativeWinOcclusion/);
  assert.match(main, /powerMonitor\.getSystemIdleTime\(\)/);
  assert.match(main, /sendPet\('idle', idle\)/);
  assert.equal(read('public/pet.js'), read('clients/windows/pet/pet.js'), 'clients/windows/pet 要和 public 同步（node scripts/sync-clients.mjs）');
});

test('非 Docker 安装脚本：umask、权限、Node 自动安装、预检、HTTPS 子命令', () => {
  const sh = read('deploy/yumeiro-native.sh');
  assert.match(sh, /^umask 022/m, 'root 的 umask 过严会让 /opt/yumeiro 变成 700（status=200/CHDIR）');
  assert.match(sh, /chmod 755 "\$APP_DIR"; chmod -R go\+rX "\$APP_DIR"/);
  for (const flag of ['--install-node', '--node-mirror', '--tls-port', '--install-nginx', '--cert', '--key', '-y|--yes']) assert.ok(sh.includes(flag), flag);
  for (const fn of ['install_node()', 'check_node()', 'preflight()', 'setup_https()', 'nginx_conf_dir()', 'public_ip()']) assert.ok(sh.includes(fn), fn);
  assert.match(sh, /^https\)/m); assert.match(sh, /\/www\/server\/panel\/vhost\/nginx/, '宝塔面板的 nginx 目录');
  assert.match(sh, /proxy_set_header X-Forwarded-For \\\$remote_addr/, '覆盖而不是追加 X-Forwarded-For，防止伪造来源 IP');
  const check = spawnSync('bash', ['-n', path.join(root, 'deploy/yumeiro-native.sh')], { encoding: 'utf8' });
  if (check.error) return;                                     // 这台机器没有 bash：跳过语法检查
  assert.equal(check.status, 0, check.stderr);
});

test('Windows 客户端：原生 IDE 工作区、编译器与模型分离、侧栏收起后主区铺满', () => {
  const main = read('clients/windows/main.js'), pre = read('clients/windows/preload.js'), html = read('clients/windows/app.html'), js = read('clients/windows/app.js'), css = read('clients/windows/app.css'), pkg = read('clients/windows/package.json');
  for (const id of ['convs', 'messages', 'prompt', 'send', 'modelSelect', 'nativePage', 'navNew', 'targetKind']) assert.ok(html.includes('id="' + id + '"'), id);
  assert.match(html, /Content-Security-Policy/); assert.doesNotMatch(html, /http:\/\/|https:\/\//, '本地页面不引用任何外部地址');
  assert.match(js, /data-view/); assert.match(js, /function renderNative/); assert.match(js, /chatTarget\.kind/); assert.match(js, /workspaceEngine/); assert.match(js, /workspaceModel/); assert.match(js, /GET', '\/api\/engines/); assert.match(js, /GET', '\/api\/agents/);
  assert.match(js, /workspace-ide/); assert.match(js, /workspaceTree/); assert.match(js, /workspaceEditor/); assert.match(js, /workspaceEngine/); assert.match(js, /workspaceModel/); assert.match(js, /workspaceRunState/); assert.match(js, /kind: 'engine'/);
  assert.match(js, /\/api\/workspaces\//); assert.match(js, /window\.yumeiroModel/);
  assert.match(main, /apiPath === '\/api\/chat\/stream'/); assert.match(main, /const allowed =/, '工作区运行流经过主进程代理'); assert.doesNotMatch(main, /new WebContentsView/, '功能页不再用网页视图');
  assert.doesNotMatch(pre, /app:web|webBounds|webHide/, 'preload 不再暴露网页嵌入接口');
  for (const name of ['api', 'file', 'stream', 'streamAbort', 'onStream', 'openExternal']) assert.ok(pre.includes(name + ':'), name);
  assert.match(js, /window\.fetch = async/, '桌宠脚本的 /api/ 请求要走代理'); assert.match(js, /\/api\/chat\/stream/);
  assert.doesNotMatch(js, /innerHTML = (?!md\()[^;]*\bm\.content/, '消息内容不能直接写进 innerHTML');
  assert.match(css, /native-page/); assert.match(css, /target-row/);
  for (const f of ['app.html', 'app.css', 'app.js']) assert.ok(pkg.includes('"' + f + '"'), '打包清单要包含 ' + f);
  assert.ok(read('clients/windows/pet/pet-sense.js').length > 100, '主界面里的桌宠需要 pet-sense.js');
});

test('Windows 客户端：参照 Cindy 的桂面布局（侧栏分组、玻璃面板、标题栏按钮、原生设置 / 智能体 / 市场）', () => {
  const html = read('clients/windows/app.html'), css = read('clients/windows/app-cindy.css'), js = read('clients/windows/app.js'), pre = read('clients/windows/preload.js'), main = read('clients/windows/main.js'), pkg = read('clients/windows/package.json');
  for (const id of ['navNew', 'navSearch', 'navMore', 'buddy', 'convHead', 'btnSettings', 'btnPlus', 'slLeft', 'slRight', 'popMenu']) assert.ok(html.includes('id="' + id + '"'), id);
  assert.match(html, /app-cindy\.css/); assert.ok(pkg.includes('"app-cindy.css"'), '打包清单要包含 app-cindy.css');
  for (const s of ['backdrop-filter:blur(28px)', '.set-nav', '.settings-mode', '.composer-wrap', 'HarmonyOS Sans SC']) assert.ok(css.includes(s), s);
  for (const s of ['function renderSettings', 'function renderAgents', 'function renderMarket', 'async function agentDialog', 'function goHist', 'function popMenu', '/api/market/install', '/api/agents', 'agent_id: chatTarget.ref']) assert.ok(js.includes(s), s);
  assert.doesNotMatch(js, /智能体编辑器将在下一步开放/, '不再有占位提示');
  for (const s of ["setTitle:", "onChrome:", "petGet:", "petSet:", "fireChrome('side')", "fireChrome('more')"]) assert.ok(pre.includes(s), s);
  assert.match(main, /app:pet-get/); assert.match(main, /app:pet-set/); assert.match(main, /app:version/);
  // 回归：设置页隐藏后不能还盖在聊天区上（display:grid 会压过 [hidden]）
  assert.match(css, /\.native-page\.set\[hidden\]\s*\{\s*display:\s*none/);
  // 回归：模型“xxx · pi/codex/claude-code”要拆成模型 + 运行引擎，正则里的 \s 不能丢
  const re = /const ENGINE_RE = (\/.+\/i);/.exec(js);
  assert.ok(re, 'ENGINE_RE');
  const engineRe = eval(re[1]);
  assert.equal('Cindy AI · DeepSeek V4 Pro · pi'.replace(engineRe, ''), 'Cindy AI · DeepSeek V4 Pro');
  assert.equal(engineRe.exec('Cindy AI · GPT-6.1 Terra · claude-code')[1], 'claude-code');
});

test('Windows 客户端：自绘标题栏 + 玻璃质感皮肤（无边框窗口）', () => {
  const main = read('clients/windows/main.js'), pre = read('clients/windows/preload.js');
  assert.match(main, /autoHideMenuBar: false, frame: false/); assert.match(main, /ipcMain\.on\('win:ctl'/); assert.match(main, /'win:is-max'/);
  assert.match(main, /win:state/); assert.match(main, /Menu\.getApplicationMenu\(\)/, '无边框窗口没有菜单栏，要从标题栏弹出');
  for (const s of ['ymTitlebar', '-webkit-app-region:drag', 'ym-chrome', "'yumeiro.theme'", 'height:calc(100dvh - 40px)', 'body.has-wallpaper']) assert.ok(pre.includes(s), s);
  for (const a of ['min', 'max', 'close', 'menu']) assert.ok(pre.includes("'win:ctl', '" + a + "'"), a);
});

test('Windows 客户端：自己的登录界面（地址 + 账号 + 密码）、会话保留、退出登录', () => {
  const main = read('clients/windows/main.js'), pre = read('clients/windows/preload.js'), login = read('clients/windows/login.html'), pkg = read('clients/windows/package.json');
  for (const id of ['server', 'email', 'password', 'ign']) assert.ok(login.includes('id="' + id + '"'), id);
  for (const ch of ['login', 'login-defaults', 'sign-out']) assert.ok(main.includes("'yumeiro:" + ch + "'"), ch);
  assert.match(main, /async function firstScreen/); assert.match(main, /async function signOut/); assert.match(main, /setCertificateVerifyProc/);
  assert.match(main, /\/api\/auth\/login/); assert.match(main, /\/api\/auth\/logout/); assert.match(main, /clearStorageData\(\{ storages: \['cookies'\] \}\)/);
  assert.match(main, /'\/invite'|includes\(new URL\(cur\)\.pathname\)/, '只对登录后的页面检查会话，邀请页等公开页不拦');
  for (const name of ['login', 'loginDefaults', 'signOut']) assert.ok(pre.includes(name + ':'), name);
  assert.match(pkg, /"login\.html"/); assert.doesNotMatch(main, /setup\.html/);
});

test('Windows 客户端：加载失败显示说明页（不再空白）、自签名证书按指纹固定、无协议地址自动探测', () => {
  const main = read('clients/windows/main.js'), pre = read('clients/windows/preload.js'), err = read('clients/windows/error.html'), pkg = read('clients/windows/package.json');
  assert.match(main, /did-fail-load/); assert.match(main, /error\.html/); assert.match(main, /code === -3/);
  assert.match(main, /app\.on\('certificate-error'/); assert.match(main, /trusted === certificate\.fingerprint/, '只信任保存过的那一张证书');
  assert.match(main, /origin === mine/, '只对用户保存的服务器放行');
  assert.match(main, /probeHealth\('https:\/\/' \+ host\)/); assert.match(main, /probeHealth\('http:\/\/' \+ host\)/);
  assert.match(main, /const mine = serverOrigin\(\); if \(mine && !url\.startsWith\(mine\)/, 'will-navigate \u8981\u7528\u5f53\u524d\u4fdd\u5b58\u7684\u5730\u5740');
  for (const name of ['lastError', 'retry', 'changeServer', 'useScheme', 'trustCert', 'setIgnoreCert', 'getIgnoreCert']) assert.ok(pre.includes(name + ':'), name);
  assert.match(main, /ignoreCertErrors === true/); assert.match(main, /dialog\.showMessageBox/, '开启“忽略证书错误”前要确认');
  assert.match(main, /type: 'checkbox', checked: readConfig\(\)\.ignoreCertErrors === true/, '菜单里的开关');
  assert.match(err, /id="ignoreCert"/); assert.match(read('clients/windows/login.html'), /id="ign"/);
  for (const ch of ['last-error', 'retry', 'change-server', 'use-scheme', 'trust-cert']) assert.ok(main.includes("'yumeiro:" + ch + "'"), ch);
  assert.match(err, /ERR_SSL_PROTOCOL_ERROR/); assert.match(err, /ERR_UNSAFE_PORT/); assert.match(pkg, /"error\.html"/, '打包清单要包含 error.html');
});

test('桌面端桌宠：窗口铺满主显示器工作区，位置 / 走动 / 拖动都在页面里（不再被小窗口框住）', () => {
  const main = read('clients/windows/main.js'), pre = read('clients/windows/pet-preload.js'), pet = read('public/pet.js');
  assert.match(main, /width: area.width, height: area.height, x: area.x, y: area.y/, '桌宠窗口 = 主显示器工作区');
  assert.doesNotMatch(main, /pet:walk|pet:drag|pet:expand|walkAnim|petGrow/, '不再用主进程挪窗口');
  assert.match(main, /display-metrics-changed/, '分辨率 / 显示器变化后要重新铺满');
  assert.match(main, /petRoam/); assert.match(main, /petSize/);
  assert.doesNotMatch(pre, /pet:walk|pet:drag|pet:expand/);
  assert.doesNotMatch(pet, /host\.(drag|walk|expand)\(/);
  assert.match(pet, /prefs.roam !== 'bottom'/, '桌面端默认整屏漫游');
  assert.match(pet, /function fitBubble/, '气泡贴边 / 贴顶要自动挪位');
  assert.match(pet, /type === 'roam'/); assert.match(pet, /type === 'size'/);
  assert.equal(pet, read('clients/windows/pet/pet.js'));
});

test('登录会话达到上限时自动踢掉最旧的，而不是拒绝登录把用户锁在外面', () => {
  const server = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.ok(!server.includes('请先退出其他会话'));
  assert.match(server, /alive\.slice\(0,Math\.max\(0,alive\.length-limit\+1\)\)/);
});

test('登录进入工作空间后，标签页标题不再停留在“管理员登录”', () => {
  const portal = readFileSync(new URL('../public/portal.js', import.meta.url), 'utf8');
  assert.match(portal, /new MutationObserver\(\(\) => \{ if \(loggedIn\(\)\) document\.title = workTitle\(\); \}\)/);
  assert.ok(!/^\s*document\.title = '管理员登录/m.test(portal), '登录页标题要经过 setLoginTitle');
});

test('深色设置页是半透明玻璃，外层不再是一整块不透明黑板', () => {
  const css = readFileSync(new URL('../public/theme.css', import.meta.url), 'utf8');
  assert.match(css, /html\[data-theme=dark\] body\.settings-page \.team-page \.team-modal\{background:none/);
  assert.match(css, /body\.settings-page \.team-main\{background:rgba\(16,18,27,\.62\)/);
  assert.match(css, /backdrop-filter:blur\(22px\)/);
});

test('聊天框按钮脚本同一时间只允许一个 boot 在跑，手机慢网速下不会重复插入 🖼 等按钮', () => {
  for (const name of ['vision', 'draw', 'guide', 'history', 'memory', 'speak']) {
    const js = readFileSync(new URL('../public/' + name + '.js', import.meta.url), 'utf8');
    assert.match(js, /let booting = null;\s*function boot\(\) \{ return booting \|\| \(booting = bootOnce\(\)\.finally/, name);
    assert.match(js, /async function bootOnce\(\)/, name);
  }
});

test('语音按钮 / 语言下拉跟随主题，提示文字单独成行、手机上也看得到', () => {
  const js = readFileSync(new URL('../public/voice.js', import.meta.url), 'utf8');
  assert.ok(!/background:white/.test(js), '不能写死白底（深色模式下很刺眼）');
  assert.match(js, /\.voice-lang\{[^}]*border:1px solid var\(--line/);
  assert.match(js, /\.voice-btn\{[^}]*background:transparent/);
  assert.match(js, /\.voice-status\{order:-1;flex:1 0 100%/);
  assert.match(js, /\.voice-status:empty\{display:none\}/);
  assert.ok(!/@media\(max-width:640px\)\{\.voice-status\{display:none\}/.test(js), '手机上也要显示麦克风报错');
  assert.match(js, /setTimeout\(\(\) => \{ status\.textContent = ''; status\.classList\.remove\('err'\); \}, 10000\)/);
});

test('Windows 客户端：支持上传附件（回形针 / 粘贴 / 拖放），经主进程带登录状态上传，发送时随消息带上', () => {
  const html = read('clients/windows/app.html'), js = read('clients/windows/app.js'), main = read('clients/windows/main.js'), pre = read('clients/windows/preload.js'), css = read('clients/windows/app-cindy.css');
  for (const id of ['btnAttach', 'attStrip', 'attPicker', 'composer']) assert.ok(html.includes('id="' + id + '"'), id);
  assert.ok(html.includes('m21.44 11.05-9.19 9.19'), '回形针图标');
  for (const s of ['function addAttachments', 'app.upload(', "'/api/vision/config'", 'attachments: sentAtts', 'function attsBox', 'msgAtts', "'DELETE', '/api/attachments/'", "text.includes('Files')".slice(0, 0) + "includes('Files')"]) assert.ok(js.includes(s), s);
  assert.ok(main.includes("ipcMain.handle('app:upload'") && main.includes("'/api/attachments?name='") && main.includes("'X-CSRF-Token': await csrfToken(force)"));
  assert.ok(main.includes("body.raw") && main.includes('25 * 1024 * 1024'));
  assert.ok(pre.includes("upload: (name, bytes, id) => ipcRenderer.invoke('app:upload'") && pre.includes('uploadAbort') && pre.includes('onUploadProgress'));
  for (const s of ['.att-strip', '.att-chip', '.msg-atts']) assert.ok(css.includes(s), s);
});

test('Windows 客户端：消息里的文件标签点开在客户端内查看提取出的文字，图片点击放大', () => {
  const js = read('clients/windows/app.js'), main = read('clients/windows/main.js'), pre = read('clients/windows/preload.js'), css = read('clients/windows/app-cindy.css');
  for (const s of ['async function viewDoc', 'function lightbox', 'function overlayView', "app.text('/api/attachments/'", 'tag.onclick = () => viewDoc(item)', "{ doc: true, id: e.id, name: e.name }"]) assert.ok(js.includes(s), s);
  assert.ok(main.includes("ipcMain.handle('app:text'") && main.includes("text/plain") && main.includes('/^[/]api[/]attachments[/][0-9a-f-]+$/i'), '只允许读 /api/attachments/<id>，且必须是纯文本');
  assert.ok(pre.includes("text: path => ipcRenderer.invoke('app:text'"));
  for (const s of ['.att-modal', '.att-box', '.att-pre', '.att-big']) assert.ok(css.includes(s), s);
});

test('附件上传有进度条和取消按钮（网页版 XHR 进度；Windows 客户端由主进程推进度，可中途取消）', () => {
  const web = read('public/vision.js'), js = read('clients/windows/app.js'), main = read('clients/windows/main.js'), css = read('clients/windows/app-cindy.css');
  // 网页版：XMLHttpRequest 才能拿到上传进度并中途取消
  for (const s of ['new XMLHttpRequest()', 'xhr.upload.onprogress', 'xhr.upload.onload', 'xhr.onabort', 'entry.xhr.abort()', 'function showProgress', '解析中…', 'vis-prog', "'取消上传'"]) assert.ok(web.includes(s), s);
  assert.ok(!web.includes("originalFetch('/api/attachments?name="), '上传不能再用 fetch（没有进度）');
  // 客户端
  for (const s of ['app.onUploadProgress(', 'function showAttProgress', 'app.uploadAbort(entry.uid)', 'entry.cancelled', "'取消上传'", 'att-prog', '解析中…']) assert.ok(js.includes(s), s);
  assert.ok(main.includes('getUploadProgress()') && main.includes("'app:upload-progress'") && main.includes("ipcMain.on('app:upload-abort'") && main.includes('aborted: true'));
  assert.ok(main.includes('body.onReq'));
  for (const s of ['.att-prog', '.att-pct']) assert.ok(css.includes(s), s);
});

test('翻译：服务器有 /api/translate；网页点名称弹窗带“翻译成中文”，预览不再是黑底', () => {
  const server = read('server.mjs'), team = read('public/team.js');
  assert.match(server, /pathname==='\/api\/translate'/);
  assert.match(server, /TRANSLATE_PROMPT/);
  assert.match(team, /翻译成中文/);
  assert.match(team, /\/api\/translate/);
  assert.doesNotMatch(team, /\.mk-preview\{[^}]*#16181f/);
  assert.match(team, /class: 'mk-name'/);
});

test('安卓原生版：模型/智能体/壁纸用弹窗选，技能与市场点名称弹出说明并可翻译', () => {
  const dialogs = read('clients/android-native/app/src/main/java/org/yumeiro/app/ui/Dialogs.kt');
  const settings = read('clients/android-native/app/src/main/java/org/yumeiro/app/ui/SettingsScreen.kt');
  const manage = read('clients/android-native/app/src/main/java/org/yumeiro/app/ui/ManageScreens.kt');
  assert.match(dialogs, /fun PickerDialog/);
  assert.match(dialogs, /翻译成中文/);
  assert.match(settings, /PickerDialog\("默认对话模型"/);
  assert.match(manage, /InfoDialog\(vm, sk\.title/);
});

test('Windows 客户端：收起侧栏后主区域占满整行（侧栏 display:none 时不能还留一个 0 宽的列）', () => {
  for (const file of ['clients/windows/app.css', 'clients/windows/app-cindy.css']) {
    const css = read(file);
    assert.match(css, /\.shell\.collapsed\{grid-template-columns:minmax\(0,1fr\)\}/);
    assert.doesNotMatch(css, /\.shell\.collapsed\{grid-template-columns:0 /);
  }
});

test('壁纸：Windows 客户端和安卓版按 0–80 百分数处理遮罩，并支持预设渐变；壁纸选择只存本机，不读写服务器的壁纸偏好', () => {
  const win = read('clients/windows/app.js');
  assert.match(win, /WALL_PRESETS/);
  assert.match(win, /range\.max = '80'/);
  assert.doesNotMatch(win, /range\.max = '0\.85'/);
  const vm = read('clients/android-native/app/src/main/java/org/yumeiro/app/AppViewModel.kt');
  assert.match(vm, /\/api\/wallpapers\/file\//);
  assert.doesNotMatch(vm, /\/seed\/wallpapers/);
  // 壁纸只属于这台设备：三个客户端都不再读写服务器账号里的壁纸偏好，也不跟随服务器默认壁纸
  assert.doesNotMatch(vm, /\/api\/wallpapers\/pref/);
  assert.doesNotMatch(win, /\/api\/wallpapers\/pref/);
  assert.doesNotMatch(win, /defaultWallpaper/);
  assert.doesNotMatch(vm, /(optString|getString)\("defaultWallpaper"\)/);
  assert.match(win, /yumeiro\.wall/);
  const apple = read('clients/apple/Sources/Shared/AppModel.swift');
  assert.doesNotMatch(apple, /wallpapers\/pref/);
  assert.doesNotMatch(apple, /str\("defaultWallpaper"\)/);
});

test('页面弹窗：前端脚本不再使用浏览器自带的 alert / confirm / prompt，统一走 dialog.js', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const dir = new URL('../public/', import.meta.url);
  const offenders = [];
  for (const name of await readdir(dir)) {
    if (!/\.(js|html)$/.test(name) || name === 'dialog.js' || name === 'sw.js') continue;
    const text = await readFile(new URL(name, dir), 'utf8');
    if (/(^|[^.\w$])(alert|confirm|prompt)\(/m.test(text.replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, "''"))) offenders.push(name);
  }
  assert.deepEqual(offenders, [], '这些文件还在用浏览器自带弹窗：' + offenders.join('、'));
  const dialog = await readFile(new URL('dialog.js', dir), 'utf8');
  for (const fn of ['ymConfirm', 'ymPrompt', 'ymAlert']) assert.match(dialog, new RegExp('window\.' + fn));
  assert.match(await readFile(new URL('index.html', dir), 'utf8'), /<script src="\/dialog\.js"><\/script>/);
});
