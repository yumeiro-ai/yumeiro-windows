// 登录入口：只有一个登录页（“/”），管理员和成员用同一个入口；登录后按账号的身份进入对应的界面。
// 旧的 “/admin” 地址会被服务器跳转到 “/”。安全策略（失败锁定、管理员 IP 白名单）由服务器按账号角色执行，不依赖入口。
(() => {
  const $ = s => document.querySelector(s);
  const form = $('#loginForm');
  if (!form) return;

  const el = (tag, props = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) { if (k === 'class') node.className = v; else if (k === 'on') for (const [e, fn] of Object.entries(v)) node.addEventListener(e, fn); else if (v !== undefined && v !== null) node[k] = v; }
    node.append(...kids.flat().filter(x => x !== null && x !== undefined && x !== false));
    return node;
  };

  const style = el('style', {});
  style.textContent = `
    .login-shell{position:relative;overflow:hidden;background:radial-gradient(60% 50% at 15% 10%,#ffe3e8 0,transparent 70%),radial-gradient(55% 45% at 90% 85%,#e4e8ff 0,transparent 70%),#f7f7fa}
    html[data-theme=dark] .login-shell{background:radial-gradient(60% 50% at 15% 10%,#3a1d27 0,transparent 70%),radial-gradient(55% 45% at 90% 85%,#1d2340 0,transparent 70%),#0f1117}
    .login-card{position:relative;z-index:1;width:min(440px,100%);padding:38px 36px;border-radius:24px;box-shadow:0 24px 70px #2b2f4a1c}
    .portal-team{display:inline-block;margin-bottom:14px;padding:3px 11px;border-radius:99px;background:var(--accent-soft);color:var(--accent);font-size:11px;font-weight:650}
    .portal-pw{position:relative}.portal-pw input{padding-right:48px;width:100%}
    .portal-eye{position:absolute;right:6px;top:50%;transform:translateY(-50%);height:32px;padding:0 10px;border:0;background:none;color:var(--muted);font-size:12px}
    .portal-caps{min-height:16px;margin-top:6px;font-size:11px;color:#b87a00}
    .portal-notice{margin:0 0 18px;padding:10px 12px;border-radius:10px;font-size:12px;line-height:1.6;background:#eef3ff;color:#34508a;border:1px solid #d9e4ff}
    html[data-theme=dark] .portal-notice{background:#14213a;color:#9bb7ee;border-color:#22345a}
    .portal-foot{margin-top:18px;font-size:11px;line-height:1.6;color:#989ba4}
    .portal-hint{margin-top:14px;font-size:12px;color:var(--muted)}
    @media(max-width:480px){.login-card{padding:26px 22px}}
  `;
  document.head.append(style);

  // ---- 文案与结构 ----
  const brand = $('.login-brand'), title = $('.login-card h1'), sub = $('.login-card .sub');
  const emailLabel = $('label[for=email]'), passwordInput = $('#password'), button = $('#loginButton');
  const note = $('.security-note');
  passwordInput.removeAttribute('minlength'); // 成员密码至少 12 位，管理员至少 16 位，长度由服务器校验，不在浏览器里卡
  passwordInput.placeholder = '你的密码';
  $('#email').placeholder = 'name@company.com';
  emailLabel.textContent = '邮箱';
  button.textContent = '登录';

  // 标题只在登录页显示“登录”；登录进入工作空间后恢复成站点名
  let siteName = '';
  const appRoot = $('#app');
  const loggedIn = () => Boolean(appRoot) && !appRoot.hidden;
  const workTitle = () => (siteName || 'Yumeiro') + ' · 私有工作空间';
  const setLoginTitle = text => { if (!loggedIn()) document.title = text; };
  if (appRoot) new MutationObserver(() => { if (loggedIn()) document.title = workTitle(); }).observe(appRoot, { attributes: true, attributeFilter: ['hidden'] });

  title.textContent = '欢迎回来';
  sub.textContent = '登录后继续使用团队的 AI 工作空间';
  brand.after(el('span', { class: 'portal-team', id: 'portalTeam', textContent: '团队空间' }));
  if (note) { note.className = 'portal-foot'; note.textContent = '在网页里，你的对话只有你本人能看到。账号由团队管理员创建，暂不支持自助注册；管理员和成员使用同一个登录入口。'; }

  const noticeBox = el('div', { class: 'portal-notice', hidden: true });
  form.insertBefore(noticeBox, $('.field'));

  // 密码显示/隐藏 + 大写锁定提示
  const wrap = el('div', { class: 'portal-pw' });
  passwordInput.replaceWith(wrap); wrap.append(passwordInput);
  const eye = el('button', { type: 'button', class: 'portal-eye', textContent: '显示', on: { click: () => { const show = passwordInput.type === 'password'; passwordInput.type = show ? 'text' : 'password'; eye.textContent = show ? '隐藏' : '显示'; } } });
  const caps = el('div', { class: 'portal-caps' });
  wrap.append(eye); wrap.after(caps);
  passwordInput.addEventListener('keyup', e => { caps.textContent = e.getModifierState && e.getModifierState('CapsLock') ? '大写锁定已开启' : ''; });
  passwordInput.addEventListener('blur', () => { caps.textContent = ''; });
  $('#loginError').after(el('div', { class: 'portal-hint', textContent: '忘记密码？请联系管理员重置' }));

  // ---- 站点名称与公告（管理员在“站点设置”里配置；未登录也能读取）----
  fetch('/api/site', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : null).then(site => {
    if (!site) return;
    const name = site.name || 'Yumeiro';
    siteName = site.name || '';
    if (loggedIn()) document.title = workTitle();
    setLoginTitle(name + ' · 登录');
    const mark = $('.brand-name'); if (mark) mark.textContent = name;
    const team = $('#portalTeam'); if (team) team.textContent = site.name ? '团队空间' : '私有工作空间';
    sub.textContent = '登录后继续使用' + (site.name ? name + '的' : '团队的') + ' AI 工作空间';
    if (site.notice) { noticeBox.textContent = site.notice; noticeBox.hidden = false; }
  }).catch(() => {});
})();
