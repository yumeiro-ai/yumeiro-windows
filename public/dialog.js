// 页面内弹窗：代替浏览器自带的 alert / confirm / prompt（样式跟随主题、手机上更好点、不会被浏览器拦截）。
//   await ymConfirm('确定删除？', { danger: true, okText: '删除' })      → true / false
//   await ymPrompt('新密码', '', { type: 'password' })                    → 字符串；取消返回 null
//   await ymForm('额度', [{ name: 'daily', label: '每日调用', type: 'number', value: 0 }])  → { daily: '0' } 或 null
  //   ymAlert('保存失败')                                                   → 点“知道了”后 resolve（可以不等待）
(() => {
  if (window.ymConfirm) return;
  const css = document.createElement('style');
  css.textContent = `
  .ymd-back{position:fixed;inset:0;z-index:2147483200;background:#10121a88;display:grid;place-items:center;padding:16px;animation:ymd-in .12s ease-out}
  .ymd-box{width:min(420px,100%);max-height:88vh;overflow:auto;background:var(--ym-card,#fff);color:var(--ink,#252832);border:1px solid var(--line,#e7e8ec);border-radius:16px;padding:20px 20px 16px;box-shadow:0 20px 60px #0006;font:14px/1.6 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  .ymd-title{font-size:16px;font-weight:650;margin:0 0 8px}
  .ymd-msg{white-space:pre-wrap;overflow-wrap:anywhere;color:var(--ink,#252832)}
  .ymd-input{display:block;width:100%;box-sizing:border-box;margin-top:12px;height:42px;padding:0 12px;border:1px solid var(--line,#e7e8ec);border-radius:10px;background:transparent;color:inherit;font:inherit;font-size:16px}
  .ymd-input:focus{outline:3px solid #e951642e;border-color:#df9ca4}
  .ymd-field{display:grid;gap:4px;margin-top:12px}.ymd-field label{font-size:13px;font-weight:650}.ymd-field small{font-size:12px;color:var(--muted,#777b86)}
  .ymd-field .ymd-input{margin-top:0}.ymd-row2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .ymd-checks{display:grid;gap:6px;border:1px solid var(--line,#e7e8ec);border-radius:12px;padding:8px}.ymd-checks>.ymd-input{height:36px;font-size:14px}
  .ymd-check-rows{max-height:210px;overflow:auto;display:grid;gap:2px}.ymd-check-row{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:9px;cursor:pointer}.ymd-check-row:hover{background:var(--accent-soft,#fff0f2)}
  .ymd-check-row input{width:18px;height:18px;flex:none;accent-color:var(--accent,#e95164)}.ymd-check-row span{display:flex;flex-direction:column;min-width:0}.ymd-check-row small{color:var(--muted,#777b86);font-size:12px;overflow:hidden;text-overflow:ellipsis}.ymd-check-empty{padding:10px;color:var(--muted,#777b86);font-size:13px}
  .ymd-field[hidden]{display:none}.ymd-box select option{background:var(--ym-card,#fff);color:var(--ink,#252832)}
  .ymd-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
  .ymd-actions button{min-width:84px;min-height:40px;padding:0 16px;border-radius:10px;border:1px solid var(--line,#e7e8ec);background:transparent;color:inherit;font:inherit;cursor:pointer}
  .ymd-actions button.ok{background:var(--accent,#e95164);border-color:var(--accent,#e95164);color:#fff;font-weight:650}
  .ymd-actions button.danger{background:#d33a4a;border-color:#d33a4a}
  @keyframes ymd-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
  @media(max-width:560px){.ymd-back{align-items:end;padding:10px}.ymd-box{border-radius:16px}.ymd-actions{flex-direction:column-reverse}.ymd-actions button{width:100%}}
  @media(prefers-reduced-motion:reduce){.ymd-back{animation:none}}`;
  document.head.append(css);
  const queue = []; let showing = false;
  function show(opts) { return new Promise(resolve => { queue.push({ opts, resolve }); if (!showing) next(); }); }
  function next() {
    const item = queue.shift(); if (!item) { showing = false; return; }
    showing = true;
    const { opts, resolve } = item, previous = document.activeElement;
    const back = document.createElement('div'); back.className = 'ymd-back';
    const box = document.createElement('div'); box.className = 'ymd-box'; box.setAttribute('role', opts.input ? 'dialog' : 'alertdialog'); box.setAttribute('aria-modal', 'true');
    const title = document.createElement('div'); title.className = 'ymd-title'; title.textContent = opts.title || (opts.input ? '请输入' : opts.cancel ? '请确认' : '提示'); box.setAttribute('aria-label', title.textContent);
    const msg = document.createElement('div'); msg.className = 'ymd-msg'; msg.textContent = String(opts.message ?? '');
    if (!msg.textContent) msg.style.display = 'none';
    box.append(title, msg);
    let input = null; const inputs = {}, wraps = {}, conditional = [];
    if (opts.fields) {
      let row = null;
      for (const f of opts.fields) {
        const wrap = document.createElement('div'); wrap.className = 'ymd-field';
        const label = document.createElement('label'); label.textContent = f.label;
        const el = document.createElement(f.type === 'select' ? 'select' : f.type === 'checklist' ? 'div' : 'input'); el.className = f.type === 'checklist' ? 'ymd-checks' : 'ymd-input';
        if (f.type === 'checklist') {
          // 多选列表：每行一个复选框（名称 + 小字说明），超过 6 项带搜索框；value 是选中项的数组
          const chosen = new Set(f.value || []), rowsEl = document.createElement('div'); rowsEl.className = 'ymd-check-rows';
          const draw = q => { rowsEl.replaceChildren(); const list = (f.options || []).filter(o => !q || (o.label + ' ' + (o.sub || '')).toLowerCase().includes(q.toLowerCase())); if (!list.length) { const e = document.createElement('div'); e.className = 'ymd-check-empty'; e.textContent = f.options?.length ? '没有匹配的成员' : (f.empty || '没有可选的成员'); rowsEl.append(e); }
            for (const o of list) { const lab = document.createElement('label'); lab.className = 'ymd-check-row'; const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = chosen.has(o.value); cb.addEventListener('change', () => { cb.checked ? chosen.add(o.value) : chosen.delete(o.value); }); const t = document.createElement('span'); t.textContent = o.label; if (o.sub) { const sm = document.createElement('small'); sm.textContent = o.sub; t.append(sm); } lab.append(cb, t); rowsEl.append(lab); } };
          if ((f.options || []).length > 6) { const q = document.createElement('input'); q.type = 'search'; q.className = 'ymd-input'; q.placeholder = '搜索成员'; q.style.marginTop = '0'; q.addEventListener('input', () => draw(q.value.trim())); el.append(q); }
          el.append(rowsEl); draw('');
          Object.defineProperty(el, 'value', { get: () => [...chosen] });
        } else if (f.type === 'select') { for (const o of f.options || []) { const opt = document.createElement('option'); opt.value = o.value; opt.textContent = o.label; el.append(opt); } el.value = f.value ?? (f.options?.[0]?.value ?? ''); }
        else { el.type = f.type || 'text'; el.value = f.value ?? ''; el.autocomplete = 'off'; }
        el.setAttribute('aria-label', f.label);
        if (f.min !== undefined) el.min = f.min; if (f.max !== undefined) el.max = f.max; if (f.step !== undefined) el.step = f.step; if (f.placeholder) el.placeholder = f.placeholder; if (f.type === 'number') el.inputMode = 'numeric';
        wrap.append(label, el); if (f.hint) { const h = document.createElement('small'); h.textContent = f.hint; wrap.append(h); }
        inputs[f.name] = el; wraps[f.name] = wrap; if (f.showWhen) conditional.push([f, wrap]);
        if (f.half) { if (!row) { row = document.createElement('div'); row.className = 'ymd-row2'; box.append(row); } row.append(wrap); if (row.children.length === 2) row = null; } else { row = null; box.append(wrap); }
      }
      // 条件显示：showWhen = { name, equals }，比如“成员”只在“谁可以访问 = 指定成员”时出现
      const sync = () => { for (const [f, wrap] of conditional) wrap.hidden = String(inputs[f.showWhen.name]?.value) !== String(f.showWhen.equals); };
      for (const [f] of conditional) inputs[f.showWhen.name]?.addEventListener('change', sync); sync();
      input = Object.values(inputs)[0];
    }
    if (opts.input) { input = document.createElement('input'); input.className = 'ymd-input'; input.type = opts.type || 'text'; input.value = opts.value ?? ''; input.autocomplete = 'off'; if (opts.placeholder) input.placeholder = opts.placeholder; box.append(input); }
    const actions = document.createElement('div'); actions.className = 'ymd-actions';
    const okBtn = document.createElement('button'); okBtn.type = 'button'; okBtn.className = 'ok' + (opts.danger ? ' danger' : ''); okBtn.textContent = opts.okText || (opts.cancel ? '确定' : '知道了');
    let cancelBtn = null;
    let extraBtn = null;
    if (opts.extra) { extraBtn = document.createElement('button'); extraBtn.type = 'button'; extraBtn.textContent = opts.extra.text; extraBtn.style.marginRight = 'auto'; actions.append(extraBtn); }
    if (opts.cancel) { cancelBtn = document.createElement('button'); cancelBtn.type = 'button'; cancelBtn.textContent = opts.cancelText || '取消'; actions.append(cancelBtn); }
    actions.append(okBtn); box.append(actions); back.append(box); document.body.append(back);
    let done = false;
    const finish = value => { if (done) return; done = true; back.remove(); removeEventListener('keydown', onKey, true); try { previous?.focus?.(); } catch { /* 忽略 */ } resolve(value); next(); };
    const collect = () => Object.fromEntries(Object.entries(inputs).filter(([k]) => !wraps[k]?.hidden).map(([k, el]) => [k, el.value]));
    const accept = () => { if (opts.fields) { const bad = (opts.fields.find(f => f.required && !String(inputs[f.name].value).trim())); if (bad) { inputs[bad.name].focus(); return; } return finish(collect()); } finish(opts.input ? input.value : true); }, reject = () => finish(opts.input || opts.fields ? null : false);
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); opts.cancel ? reject() : accept(); }
      else if (e.key === 'Enter' && !e.isComposing && (opts.input || opts.fields || document.activeElement === okBtn || document.activeElement === document.body)) { e.preventDefault(); e.stopPropagation(); accept(); }
      else if (e.key === 'Tab') { const f = [...box.querySelectorAll('input,select,button')]; const i = f.indexOf(document.activeElement); const to = e.shiftKey ? f[(i <= 0 ? f.length : i) - 1] : f[(i + 1) % f.length]; e.preventDefault(); to?.focus(); }
    }
    addEventListener('keydown', onKey, true);
    okBtn.addEventListener('click', accept); cancelBtn?.addEventListener('click', reject); extraBtn?.addEventListener('click', () => finish({ __extra: true }));
    back.addEventListener('pointerdown', e => { if (e.target === back && opts.cancel) reject(); });
    (input || (opts.danger && cancelBtn) || okBtn).focus(); input?.select?.();
  }
  window.ymConfirm = (message, o = {}) => show({ message, cancel: true, ...o });
  window.ymPrompt = (message, value = '', o = {}) => show({ message, input: true, cancel: true, value, ...o });
  // 多字段表单：fields = [{ name, label, type, value, min, hint, half, required }]；返回 { name: 字符串 }，取消返回 null；extra = { text } 的按钮返回 { __extra: true }
  window.ymForm = (title, fields, o = {}) => show({ title, message: o.message || '', fields, cancel: true, ...o });
  window.ymAlert = (message, o = {}) => show({ message, cancel: false, ...o });
  // 二维码弹层：把一个 http(s) 链接变成二维码（由服务器 /api/qr 生成，需要登录）；用于“发到手机”和“邀请成员”
  const qrCss = document.createElement('style');
  qrCss.textContent = `.ymq-back{position:fixed;inset:0;z-index:2147483300;background:#10121a99;display:grid;place-items:center;padding:16px}.ymq-box{width:min(340px,100%);max-height:92vh;overflow:auto;background:var(--ym-card,#fff);color:var(--ink,#252832);border:1px solid var(--line,#e7e8ec);border-radius:16px;padding:18px;display:grid;gap:10px;justify-items:center;box-shadow:0 20px 60px #0006;font:14px/1.6 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}.ymq-title{font-weight:650;font-size:15px;text-align:center;overflow-wrap:anywhere}.ymq-img{width:220px;height:220px;background:#fff;border-radius:12px;padding:8px;box-sizing:content-box}.ymq-tip{font-size:12px;color:var(--muted,#777b86);line-height:1.6;text-align:center}.ymq-url{width:100%;box-sizing:border-box;height:34px;border:1px solid var(--line,#e7e8ec);border-radius:8px;background:transparent;color:inherit;padding:0 8px;font-size:12px}.ymq-row{display:flex;gap:8px}.ymq-row button{min-height:38px;padding:0 18px;border-radius:10px;border:1px solid var(--line,#e7e8ec);background:transparent;color:inherit;cursor:pointer;font:inherit}`;
  document.head.append(qrCss);
  window.ymQr = (link, title, o = {}) => {
    document.querySelector('.ymq-back')?.remove();
    const back = document.createElement('div'); back.className = 'ymq-back';
    const box = document.createElement('div'); box.className = 'ymq-box'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
    const h = document.createElement('div'); h.className = 'ymq-title'; h.textContent = title || '二维码';
    const img = document.createElement('img'); img.className = 'ymq-img'; img.alt = '二维码'; img.src = '/api/qr?text=' + encodeURIComponent(link);
    img.onerror = () => { img.replaceWith(Object.assign(document.createElement('div'), { className: 'ymq-tip', textContent: '二维码生成失败，请直接复制下面的链接。' })); };
    const tip = document.createElement('div'); tip.className = 'ymq-tip'; tip.textContent = o.tip || '用手机扫一扫打开。';
    const url = document.createElement('input'); url.className = 'ymq-url'; url.readOnly = true; url.value = link; url.addEventListener('focus', () => url.select());
    const row = document.createElement('div'); row.className = 'ymq-row';
    const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = '复制链接';
    copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(link); copy.textContent = '已复制'; } catch { url.focus(); url.select(); copy.textContent = '请手动复制'; } });
    const close = document.createElement('button'); close.type = 'button'; close.textContent = '关闭';
    const off = () => { back.remove(); removeEventListener('keydown', key, true); }, key = e => { if (e.key === 'Escape') { e.stopPropagation(); off(); } };
    close.addEventListener('click', off); back.addEventListener('pointerdown', e => { if (e.target === back) off(); }); addEventListener('keydown', key, true);
    row.append(copy, close); box.append(h, img, tip, url, row); back.append(box); document.body.append(back); close.focus();
  };
})();
