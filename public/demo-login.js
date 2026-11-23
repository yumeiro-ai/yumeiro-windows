// 演示站：在登录页上显示公开的演示账号（管理员 + 成员），点一下自动填入。普通部署里 /api/demo-info 返回 404，什么都不显示。
(() => {
  const form = document.getElementById('loginForm');
  if (!form) return;
  fetch('/api/demo-info', { credentials: 'same-origin', cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(info => {
    if (!info || !info.demo || !Array.isArray(info.accounts) || form.querySelector('.demo-accounts')) return;
    const box = document.createElement('div');
    box.className = 'demo-accounts';
    box.style.cssText = 'margin-top:16px;padding:12px 14px;border:1px dashed var(--accent,#e95164);border-radius:12px;background:var(--accent-soft,#fff0f2);color:var(--ink,inherit);font-size:12px;line-height:1.7';
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:650;margin-bottom:6px';
    title.textContent = '演示账号（公开，点击自动填入）';
    box.append(title);
    for (const account of info.accounts) {
      const row = document.createElement('button');
      row.type = 'button';
      row.style.cssText = 'display:block;width:100%;text-align:left;padding:7px 9px;margin-top:5px;border:1px solid var(--line,#e7e8ec);border-radius:8px;background:transparent;color:inherit;cursor:pointer;overflow-wrap:anywhere';
      const name = document.createElement('strong');
      name.textContent = account.label + '　';
      const detail = document.createElement('span');
      detail.textContent = account.email + ' / ' + account.password;
      row.append(name, detail);
      row.addEventListener('click', () => {
        const email = document.getElementById('email'), password = document.getElementById('password');
        if (email) email.value = account.email;
        if (password) password.value = account.password;
        for (const input of [email, password]) input && input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      box.append(row);
    }
    const note = document.createElement('div');
    note.style.cssText = 'margin-top:8px;color:var(--muted,#8b8f99);font-size:11px';
    note.textContent = '这是体验站，数据会不定期重置，请不要填写真实的密钥或隐私内容。';
    box.append(note);
    const anchor = form.querySelector('.security-note');
    form.insertBefore(box, anchor || null);
  }).catch(() => {});
})();
