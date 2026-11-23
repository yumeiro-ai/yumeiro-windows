// 登录页的“管理员忘记密码”：用恢复密钥，或用已登录的手机确认，来登录并改密码。
(() => {
  const el = (tag, props = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) { if (k === 'on') for (const [e, f] of Object.entries(v)) node.addEventListener(e, f); else if (k === 'style') node.style.cssText = v; else if (k in node) node[k] = v; else node.setAttribute(k, v); }
    node.append(...kids.flat().filter(x => x != null && x !== false));
    return node;
  };
  const style = el('style', {}, `
    #ymRecover{position:fixed;inset:0;z-index:90;background:#000a;display:flex;align-items:center;justify-content:center;padding:16px;overflow:auto}
    #ymRecover .box{width:min(460px,100%);background:#171a23;color:#e8e9ee;border:1px solid #2c2f3d;border-radius:18px;padding:20px;box-shadow:0 20px 60px #000a;font:14px/1.65 system-ui,"PingFang SC","Microsoft YaHei",sans-serif}
    #ymRecover h2{margin:0 0 4px;font-size:18px}#ymRecover .sub{color:#9a9eab;font-size:12.5px;margin-bottom:12px}
    #ymRecover .tabs{display:flex;gap:6px;margin:10px 0}#ymRecover .tabs button{flex:1;padding:8px;border-radius:10px;border:1px solid #2c2f3d;background:none;color:inherit;cursor:pointer;font:inherit}#ymRecover .tabs button.on{border-color:#e95164;color:#ff8a9a}
    #ymRecover label{display:block;margin:10px 0 4px;font-weight:600;font-size:13px}
    #ymRecover input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:10px;border:1px solid #2c2f3d;background:#0f1117;color:inherit;font:inherit}
    #ymRecover .go{width:100%;margin-top:14px;padding:11px;border:0;border-radius:10px;background:#e95164;color:#fff;font:inherit;cursor:pointer}#ymRecover .go:disabled{opacity:.5}
    #ymRecover .ghost{background:none;border:1px solid #2c2f3d;color:inherit;border-radius:10px;padding:8px 12px;cursor:pointer;font:inherit}
    #ymRecover .err{color:#ff8a8a;min-height:1.3em;margin-top:8px;font-size:13px}#ymRecover .ok{color:#6fd6a6;margin-top:8px}
    #ymRecover .code{font:700 38px/1.2 ui-monospace,Consolas,monospace;letter-spacing:6px;text-align:center;color:#ff8a9a;margin:10px 0}
    #ymRecover .keybox{font:600 15px/1.7 ui-monospace,Consolas,monospace;background:#0f1117;border:1px dashed #e95164;border-radius:10px;padding:12px;word-break:break-all;margin:8px 0;user-select:all}
    #ymRecover ol{padding-left:20px;margin:8px 0;color:#c5c8d4}`);
  document.head.append(style);
  const api = async (path, options = {}) => {
    const response = await fetch(path, { ...options, headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) }, credentials: 'same-origin' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '请求失败：' + response.status);
    return data;
  };
  const copy = async text => { try { await navigator.clipboard.writeText(text); return true; } catch { return false; } };
  let layer = null, timer = 0;
  function close() { clearInterval(timer); layer?.remove(); layer = null; }
  function open() {
    close();
    const body = el('div'), tabPhone = el('button', { type: 'button', class: 'on', textContent: '📱 手机授权' }), tabAdmin = el('button', { type: 'button', textContent: '🧑‍💼 管理员重置' }), tabKey = el('button', { type: 'button', textContent: '🔑 恢复密钥（管理员）' });
    const show = which => { tabPhone.classList.toggle('on', which === 'phone'); tabAdmin.classList.toggle('on', which === 'admin'); tabKey.classList.toggle('on', which === 'key'); clearInterval(timer); body.replaceChildren(which === 'key' ? keyPane() : which === 'admin' ? adminPane() : phonePane()); };
    tabKey.addEventListener('click', () => show('key')); tabPhone.addEventListener('click', () => show('phone')); tabAdmin.addEventListener('click', () => show('admin'));
    layer = el('div', { id: 'ymRecover', role: 'dialog', 'aria-label': '忘记密码', on: { click: e => { if (e.target === layer) close(); } } },
      el('div', { class: 'box' }, el('h2', { textContent: '忘记密码' }), el('div', { class: 'sub', textContent: '两种办法：用已经登录的手机授权，或请管理员帮你重置。' }), el('div', { class: 'tabs' }, tabPhone, tabAdmin, tabKey), body,
        el('div', { style: 'margin-top:12px;text-align:right' }, el('button', { type: 'button', class: 'ghost', textContent: '关闭', on: { click: close } }))));
    document.body.append(layer); show('phone');
  }
  function passwordFields() {
    const p1 = el('input', { type: 'password', autocomplete: 'new-password', placeholder: '至少 16 个字符 / at least 16 characters' }), p2 = el('input', { type: 'password', autocomplete: 'new-password', placeholder: '再输入一次 / repeat' });
    return { p1, p2, nodes: [el('label', { textContent: '新密码 New password' }), p1, el('label', { textContent: '确认新密码 Confirm' }), p2], read() { if (p1.value !== p2.value) throw new Error('两次输入的密码不一致'); return p1.value; } };
  }
  function adminPane() {
    return el('div', {}, el('div', { class: 'sub', textContent: '成员忘记密码，可以请管理员在“管理设置 → 团队成员”里点“重置密码”，设置一个新密码发给你。重置后你的旧登录会全部退出，登录后建议马上到“修改密码”里改成自己的。' }),
      el('ol', {}, el('li', { textContent: '联系你的管理员，告诉他你的登录邮箱。' }), el('li', { textContent: '管理员重置后把新密码告诉你（请当面或用安全的渠道）。' }), el('li', { textContent: '用新密码登录，再改成只有你自己知道的密码。' })));
  }
  function keyPane() {
    const email = el('input', { type: 'email', autocomplete: 'username', placeholder: 'admin@example.com' }), key = el('input', { type: 'text', autocomplete: 'off', placeholder: 'YMR-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX', spellcheck: false });
    const pw = passwordFields(), err = el('div', { class: 'err' }), out = el('div');
    const go = el('button', { type: 'button', class: 'go', textContent: '重置密码并登录 Reset & sign in', on: { click: async () => {
      err.textContent = ''; go.disabled = true;
      try {
        const r = await api('/api/auth/recover/key', { method: 'POST', body: JSON.stringify({ email: email.value, key: key.value, newPassword: pw.read() }) });
        out.replaceChildren(el('div', { class: 'ok', textContent: '✅ 密码已重置，已登录。旧的恢复密钥已作废，请保存下面这把新的（只显示这一次）：' }), el('div', { class: 'keybox', textContent: r.newRecoveryKey }),
          el('div', { style: 'display:flex;gap:8px' }, el('button', { type: 'button', class: 'ghost', textContent: '复制 Copy', on: { click: async e => { e.target.textContent = (await copy(r.newRecoveryKey)) ? '已复制 Copied' : '请手动复制'; } } }), el('button', { type: 'button', class: 'go', style: 'margin:0', textContent: '我已保存，进入 Continue', on: { click: () => { location.href = '/admin/settings?tab=security'; } } })));
        go.hidden = true;
      } catch (e) { err.textContent = e.message; go.disabled = false; }
    } } });
    return el('div', {}, el('div', { class: 'sub', textContent: '输入你在“管理设置 → 账号安全”里保存的恢复密钥，设置新密码。' }), el('label', { textContent: '管理员邮箱 Email' }), email, el('label', { textContent: '恢复密钥 Recovery key' }), key, ...pw.nodes, go, err, out);
  }
  function phonePane() {
    const email = el('input', { type: 'email', autocomplete: 'username', placeholder: 'name@example.com' }), err = el('div', { class: 'err' }), area = el('div');
    const start = el('button', { type: 'button', class: 'go', textContent: '发起手机确认 Start', on: { click: async () => {
      err.textContent = ''; start.disabled = true;
      try { const r = await api('/api/auth/recover/phone/start', { method: 'POST', body: JSON.stringify({ email: email.value }) }); waitApproval(r); start.hidden = true; }
      catch (e) { err.textContent = e.message; start.disabled = false; }
    } } });
    function waitApproval(r) {
      const left = el('div', { class: 'sub', style: 'text-align:center' }), status = el('div', { class: 'sub', style: 'text-align:center', textContent: '等待手机批准… Waiting for approval…' });
      area.replaceChildren(el('div', { class: 'code', textContent: r.code.slice(0, 3) + ' ' + r.code.slice(3) }), left, status,
        el('ol', {}, el('li', { textContent: '在已登录你这个账号的手机（网页 / 安卓客户端）上打开：设置 → 账号安全。' }), el('li', { textContent: '输入上面的 6 位验证码，点“批准 Approve”。' }), el('li', { textContent: '这台电脑会自动继续。' })));
      const end = r.expiresAt;
      timer = setInterval(async () => {
        const s = Math.max(0, Math.round((end - Date.now()) / 1000)); left.textContent = s ? '有效期还剩 ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') : '已过期';
        try {
          const st = await api('/api/auth/recover/phone/status?id=' + encodeURIComponent(r.id));
          if (st.status === 'approved') { clearInterval(timer); approved(r.id); }
          else if (st.status === 'denied') { clearInterval(timer); status.textContent = '手机上拒绝了这次请求。'; status.style.color = '#ff8a8a'; start.hidden = false; start.disabled = false; }
          else if (st.status === 'expired' || st.status === 'unknown') { clearInterval(timer); status.textContent = '请求已过期，请重新发起。'; status.style.color = '#ff8a8a'; start.hidden = false; start.disabled = false; }
        } catch { /* 网络抖动，下一轮再试 */ }
      }, 2000);
    }
    function approved(id) {
      const pw = passwordFields(), e2 = el('div', { class: 'err' });
      const finish = async withPassword => {
        e2.textContent = '';
        try { await api('/api/auth/recover/phone/finish', { method: 'POST', body: JSON.stringify({ id, ...(withPassword ? { newPassword: pw.read() } : {}) }) }); location.href = '/'; }
        catch (e) { e2.textContent = e.message; }
      };
      area.replaceChildren(el('div', { class: 'ok', textContent: '✅ 手机已批准 Approved' }), el('button', { type: 'button', class: 'go', textContent: '直接登录 Sign in', on: { click: () => finish(false) } }),
        el('div', { class: 'sub', style: 'margin-top:14px', textContent: '或者顺便改密码 Or set a new password:' }), ...pw.nodes, el('button', { type: 'button', class: 'go', textContent: '改密码并登录 Change & sign in', on: { click: () => finish(true) } }), e2);
    }
    return el('div', {}, el('div', { class: 'sub', textContent: '如果你的手机还保持着登录，可以用它确认“是我本人”，不需要记住密码。管理员和成员都可以用。' }), el('label', { textContent: '登录邮箱' }), email, start, err, area);
  }
  // ---- 扫码登录（电脑端）：显示二维码，等待已登录的手机确认 ----
  function openQr() {
    close();
    const area = el('div', { style: 'text-align:center' }), err = el('div', { class: 'err' }), status = el('div', { class: 'sub', style: 'text-align:center' });
    layer = el('div', { id: 'ymRecover', role: 'dialog', 'aria-label': '扫码登录', on: { click: e => { if (e.target === layer) close(); } } },
      el('div', { class: 'box' }, el('h2', { textContent: '扫码登录' }), el('div', { class: 'sub', textContent: '用已经登录的手机扫描下面的二维码（或用手机浏览器打开链接），在手机上点“确认”，这台电脑就会自动登录。' }), area, status, err,
        el('div', { style: 'margin-top:12px;text-align:right' }, el('button', { type: 'button', class: 'ghost', textContent: '关闭', on: { click: close } }))));
    document.body.append(layer);
    const begin = async () => {
      clearInterval(timer); err.textContent = ''; status.textContent = '正在生成二维码…'; area.replaceChildren();
      let r;
      try { r = await api('/api/auth/recover/qr/start', { method: 'POST', body: JSON.stringify({ origin: location.origin }) }); } catch (e) { err.textContent = e.message; status.textContent = ''; return; }
      const holder = el('div', { style: 'display:inline-block;background:#fff;padding:10px;border-radius:12px;width:min(240px,100%)' });
      holder.innerHTML = r.svg; const svg = holder.querySelector('svg'); if (svg) { svg.setAttribute('width', '100%'); svg.setAttribute('height', '100%'); svg.style.display = 'block'; }
      const linkBox = el('input', { value: r.url, readOnly: true, style: 'margin-top:10px;font-size:12px;text-align:center', on: { focus: e => e.target.select() } });
      area.replaceChildren(holder, linkBox);
      const end = r.expiresAt;
      timer = setInterval(async () => {
        const s = Math.max(0, Math.round((end - Date.now()) / 1000));
        try {
          const st = await api('/api/auth/recover/qr/status?id=' + encodeURIComponent(r.id));
          if (st.status === 'approved') { clearInterval(timer); status.textContent = '手机已确认，正在登录…'; try { await api('/api/auth/recover/qr/finish', { method: 'POST', body: JSON.stringify({ id: r.id, secret: r.secret }) }); location.href = '/'; } catch (e) { err.textContent = e.message; } }
          else if (st.status === 'denied') { clearInterval(timer); status.textContent = '手机上拒绝了这次登录。'; area.replaceChildren(el('button', { type: 'button', class: 'go', textContent: '重新生成二维码', on: { click: begin } })); }
          else if (st.status === 'expired' || st.status === 'unknown' || s === 0) { clearInterval(timer); status.textContent = '二维码已过期。'; area.replaceChildren(el('button', { type: 'button', class: 'go', textContent: '重新生成二维码', on: { click: begin } })); }
          else status.textContent = '等待手机确认…（还剩 ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') + '）';
        } catch { /* 网络抖动，下一轮再试 */ }
      }, 2000);
    };
    begin();
  }
  // ---- 扫码登录（手机端）：手机打开 /?qr=xxx，已登录时弹出确认；没登录先登录，登录后再确认 ----
  async function handleQrApprove() {
    const code = new URLSearchParams(location.search).get('qr'); if (!code) return;
    history.replaceState(null, '', location.pathname);
    let csrf = '';
    for (let i = 0; i < 600; i++) {   // 最多等 10 分钟：用户可能要先登录
      try { const s = await api('/api/auth/session'); if (s.authenticated) { csrf = s.csrfToken || ''; break; } } catch { /* 继续等 */ }
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!csrf) return;
    let info; try { info = await api('/api/security/qr-info?code=' + encodeURIComponent(code)); } catch (e) { (window.ymAlert || alert)(e.message); return; }
    const ua = info.ua || '未知浏览器', when = new Date(info.createdAt).toLocaleTimeString();
    const ok = await window.ymConfirm('有一台电脑（网络地址 ' + (info.ip || '未知') + '，' + ua.slice(0, 60) + '，发起于 ' + when + '）想用你的账号登录。\n\n只有这是你自己刚刚在电脑上点的“扫码登录”，才点确认。如果是别人发给你的二维码，请点拒绝。', { title: '确认扫码登录？', okText: '确认登录', cancelText: '拒绝', danger: true });
    try { await api('/api/security/qr-approve', { method: 'POST', headers: { 'X-CSRF-Token': csrf }, body: JSON.stringify({ code, approve: Boolean(ok) }) }); window.ymAlert?.(ok ? '已确认，电脑会自动登录。' : '已拒绝。'); } catch (e) { window.ymAlert?.(e.message); }
  }
  function mount() {
    const card = document.querySelector('.login-card');
    if (!card || card.querySelector('#ymRecoverLink')) return;
    const anchor = [...card.querySelectorAll('*')].reverse().find(node => node.children.length === 0 && /忘记密码/.test(node.textContent));
    // 登录按钮下面：“或者”分隔线 + 两个并排的图标按钮（扫码登录 / 忘记密码），线条图标，和主题色一致
    const icon = path => { const span = document.createElement('span'); span.className = 'ym-ai'; span.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>'; return span; };
    const QR_ICON = '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 14h3v3m4 0v4h-4m-3-2v2"/>';
    const KEY_ICON = '<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 8.2-8.2m-3 3 3 3m-6-0 2 2"/>';
    const link = el('button', { id: 'ymRecoverLink', type: 'button', class: 'ym-alt', on: { click: open } }, icon(KEY_ICON), el('span', { textContent: '忘记密码' }));
    const qr = el('button', { id: 'ymQrLink', type: 'button', class: 'ym-alt', on: { click: openQr } }, icon(QR_ICON), el('span', { textContent: '扫码登录' }));
    const wrap = el('div', { class: 'ym-alts' }, el('div', { class: 'ym-or' }, el('span', { textContent: '或者' })), el('div', { class: 'ym-alt-row' }, qr, link));
    // 放在登录按钮和错误提示的紧下面（原来落到了卡片最底部、版权说明的后面）
    const after = card.querySelector('#loginError') || card.querySelector('#loginButton');
    if (after) after.after(wrap); else if (anchor && anchor.parentElement) anchor.parentElement.after(wrap); else card.append(wrap);
  }
  // 登录卡片是首页静态结构，脚本加载时已经存在；不监听整个 document，避免与其他模块的 DOM 观察器互相触发导致页面卡死。
  mount();
  handleQrApprove();
})();
