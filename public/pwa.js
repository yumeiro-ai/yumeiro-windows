// 原生客户端引导与网页应用安装：只在顶栏放一个 ⬇ 入口（点开后能下载客户端，也能安装网页应用），不再弹出盖住聊天框的提醒条。
(() => {
  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'on') for (const [name, handler] of Object.entries(value)) node.addEventListener(name, handler);
      else if (key === 'style') node.style.cssText = value;
      else if (key.startsWith('aria-') || key === 'role') node.setAttribute(key, value);
      else node[key] = value;
    }
    node.append(...children.filter(Boolean));
    return node;
  };
  // 已经在 Windows 客户端（Electron）里了：不再显示“安装客户端 / 添加到主屏幕”的提醒、下载按钮和网页安装按钮，也不注册 Service Worker——这些都是给浏览器用户看的，留着反而像在用网页
  const IN_APP = Boolean(window.yumeiroApp);
  if (IN_APP) document.documentElement.classList.add('in-desktop-app');

  if (!IN_APP && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }

  const style = el('style', {}, `
    #clientGuide{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:18px;background:#1118;color:#242334;font:14px/1.6 system-ui,"PingFang SC","Microsoft YaHei",sans-serif}
    #clientGuide[hidden]{display:none!important}
    #clientGuide .cg-card{width:min(560px,100%);max-height:min(88vh,760px);overflow:auto;background:#fff;border-radius:20px;padding:22px;box-shadow:0 20px 70px #0005}
    #clientGuide h2{font-size:20px;margin:0 40px 6px 0}#clientGuide h3{font-size:15px;margin:18px 0 4px}#clientGuide p{margin:5px 0;color:#555365}
    #clientGuide .cg-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}#clientGuide .cg-close{border:0;background:#f1f0f5;border-radius:9px;width:34px;height:34px;font-size:20px;cursor:pointer}
    #clientGuide .cg-links{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}#clientGuide a,#clientGuide button.cg-install{display:inline-flex;align-items:center;justify-content:center;border:1px solid #dedce7;border-radius:10px;padding:8px 12px;background:#fff;color:#352d58;text-decoration:none;font:inherit;cursor:pointer}
    #clientGuide a.cg-primary,#clientGuide button.cg-install{background:#7955c7;color:white;border-color:#7955c7}#clientGuide .cg-note{font-size:12px;color:#777;margin-top:14px}
  `);
  document.head.append(style);

  let deferred = null;
  let guide, androidLinks, windowsLinks, sumNote, fillDownloads = () => {};
  function openGuide() {
    if (!guide) buildGuide();
    guide.hidden = false;
    fetch('/api/downloads', { credentials: 'same-origin' }).then(r => r.json()).then(fillDownloads).catch(() => fillDownloads({}));
    guide.querySelector('.cg-close').focus();
  }
  function closeGuide() { if (guide) guide.hidden = true; }
  function buildGuide() {
    const close = el('button', { type: 'button', className: 'cg-close', textContent: '×', 'aria-label': '关闭', on: { click: closeGuide } });
    // 下载按钮由服务器告诉我们有哪些安装包（/api/downloads）：没上传的就不显示按钮，不会点出 404
    const download = (label, file, primary = false) => file ? el('a', { href: '/downloads/' + file.name, className: primary ? 'cg-primary' : '', textContent: label + '（' + (file.size / 1048576).toFixed(1) + ' MB）', title: file.name }) : null;
    androidLinks = el('div', { className: 'cg-links' }); windowsLinks = el('div', { className: 'cg-links' }); sumNote = el('p', { className: 'cg-note' });
    const card = el('section', { className: 'cg-card', role: 'document' },
      el('div', { className: 'cg-head' }, el('div', {}, el('h2', { textContent: '安装 Yumeiro 客户端' }), el('p', { textContent: '选择适合你设备的客户端；也可以把网页安装到主屏幕或桌面，免去每次查找网址。' })), close),
      el('h3', { textContent: 'Android 手机 / 平板' }),
      el('p', { textContent: '下载 APK 后打开文件，按系统提示允许本次安装。首次启动时输入服务器地址；调试签名 APK 适合自托管侧载，不是应用商店版本。' }),
      androidLinks,
      el('h3', { textContent: 'Windows 电脑' }),
      el('p', { textContent: '安装版按向导完成安装；便携版无需安装。当前安装包未签名，Windows SmartScreen 可能提示未知发布者；仅在确认来源可信后运行。' }),
      windowsLinks,
      el('h3', { textContent: '不下载客户端：安装网页应用' }),
      el('p', { textContent: 'Android Chrome：打开右上角菜单，选择“安装应用”或“添加到主屏幕”。iPhone/iPad：Safari 点“分享”→“添加到主屏幕”。桌面 Chrome/Edge：在地址栏点安装图标，或从浏览器菜单选择安装此网站。' }),
      el('div', { className: 'cg-links' }, el('button', { type: 'button', className: 'cg-install', textContent: '现在安装网页应用', hidden: !deferred, on: { click: installPwa } })),
      sumNote);
    fillDownloads = list => {
      const none = text => el('span', { className: 'cg-note', textContent: text });
      androidLinks.replaceChildren(...[download('下载 Android APK', list.android, true)].filter(Boolean));
      windowsLinks.replaceChildren(...[download('下载 Windows 安装版', list.windows, true), download('下载便携版', list.portable)].filter(Boolean));
      if (!androidLinks.children.length) androidLinks.append(none('管理员还没有上传 Android 安装包。'));
      if (!windowsLinks.children.length) windowsLinks.append(none('管理员还没有上传 Windows 安装包。'));
      sumNote.textContent = list.checksums ? '校验值见 ' + location.origin + '/downloads/SHA256.txt（可用 sha256sum / Get-FileHash 核对下载的文件）。' : '';
    };
    guide = el('div', { id: 'clientGuide', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'clientGuideTitle', hidden: true }, card);
    card.querySelector('h2').id = 'clientGuideTitle';
    guide.addEventListener('click', e => { if (e.target === guide) closeGuide(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !guide.hidden) closeGuide(); });
    document.body.append(guide);
  }
  async function installPwa() {
    if (!deferred) return;
    const promptEvent = deferred;
    deferred = null;
    try { await promptEvent.prompt(); await promptEvent.userChoice; } catch { /* 用户取消或浏览器不支持 */ }
    guide?.querySelector('.cg-install')?.setAttribute('hidden', '');
  }
  function place() {
    const anchor = document.getElementById('guideButton') || document.getElementById('speakButton') || document.getElementById('drawButton') || document.getElementById('historyButton') || document.getElementById('memoryButton');
    if (!anchor) return false;
    if (!document.getElementById('remoteLink')) {
      const link = el('a', { id: 'remoteLink', href: '/remote', className: 'icon-button', title: '远程控制我的电脑', textContent: '🖥' });
      link.setAttribute('aria-label', '远程控制'); link.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;text-decoration:none';
      anchor.before(link);
    }
    if (!IN_APP && !document.getElementById('clientGuideButton')) {
      const button = el('button', { id: 'clientGuideButton', type: 'button', className: 'icon-button', title: '下载客户端 / 安装引导', textContent: '⬇' });
      button.setAttribute('aria-label', '下载客户端与安装引导'); button.addEventListener('click', openGuide); anchor.before(button);
    }
    return true;
  }
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); deferred = event; guide?.querySelector('.cg-install')?.removeAttribute('hidden'); });
  window.addEventListener('appinstalled', () => { deferred = null; guide?.querySelector('.cg-install')?.setAttribute('hidden', ''); });
  let tries = 0;
  const timer = setInterval(() => { if (place() && ++tries > 6) clearInterval(timer); if (++tries > 120) clearInterval(timer); }, 1500);
})();
