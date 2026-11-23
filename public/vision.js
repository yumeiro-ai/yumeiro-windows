// 聊天输入框的“添加图片或文件”：回形针按钮选择 / 粘贴 / 拖进输入框，发送时随消息带上。
// 图片让模型看图分析；文件（PDF、Word、Excel、PowerPoint、OpenDocument、EPUB、RTF、txt / md / csv / json / 代码等）会先在服务器上提取文字，再把内容交给模型。
// 不改动主程序：通过包装 fetch 给聊天请求加上 attachments，并在消息气泡里显示缩略图 / 文件标签。
(() => {
  const el = (tag, props = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) { if (k === 'on') for (const [e, f] of Object.entries(v)) node.addEventListener(e, f); else if (k === 'style') node.style.cssText = v; else if (k in node) node[k] = v; else node.setAttribute(k, v); }
    node.append(...kids.flat().filter(x => x != null && x !== false));
    return node;
  };
  const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  const TEXT_EXTS = 'txt md markdown csv tsv json jsonl log xml yaml yml toml ini conf cfg properties html htm css scss less js mjs cjs jsx ts tsx vue svelte py java kt swift c h cpp hpp cc cs go rs rb php lua r sql sh bash bat ps1 tex srt vtt diff patch gradle'.split(' ');
  const OFFICE_EXTS = 'pdf docx xlsx xlsm pptx odt ods odp epub rtf doc xls ppt'.split(' ');
  const ACCEPT = IMAGE_TYPES.join(',') + ',' + [...TEXT_EXTS, ...OFFICE_EXTS].map(ext => '.' + ext).join(',');
  const isImage = file => IMAGE_TYPES.includes(file.type);
  const extOf = name => { const i = String(name || '').lastIndexOf('.'); return i > 0 ? String(name).slice(i + 1).toLowerCase() : ''; };
  const CLIP = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';
  let csrf = '', cfg = { maxImages: 4, maxMb: 8, maxFiles: 5, maxDocKb: 8192 }, strip = null, pending = [], liveByText = new Map(), byUserIndex = [];
  const originalFetch = window.fetch.bind(window);
  const style = el('style', {}, `
    .vis-strip{display:flex;gap:8px;flex-wrap:wrap;padding:8px 10px 0}.vis-strip:empty{display:none}
    .vis-chip{position:relative;width:56px;height:56px;border-radius:10px;overflow:hidden;border:1px solid var(--line);background:rgba(127,127,127,.12)}
    .vis-chip img{width:100%;height:100%;object-fit:cover}.vis-chip.up img,.vis-chip.up .vis-ext,.vis-chip.up .vis-fname{opacity:.55}
    .vis-chip.doc{width:auto;max-width:200px;display:flex;align-items:center;gap:8px;padding:0 24px 0 8px}
    .vis-ext{flex:none;min-width:30px;padding:2px 5px;border-radius:6px;background:rgba(127,127,127,.22);font-size:10.5px;font-weight:700;text-align:center;letter-spacing:.3px}
    .vis-fname{min-width:0;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .vis-chip button{position:absolute;top:1px;right:1px;width:18px;height:18px;border-radius:9px;border:0;background:#000a;color:#fff;font-size:11px;line-height:18px;cursor:pointer;padding:0}
    .vis-btn{border:1px solid var(--line);background:transparent;color:var(--muted);border-radius:9px;width:32px;height:32px;cursor:pointer;display:grid;place-items:center;padding:0}.vis-btn:hover{color:var(--ink)}
    .vis-thumbs{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.vis-thumbs img{max-width:180px;max-height:140px;border-radius:8px;border:1px solid var(--line);cursor:zoom-in;object-fit:cover}
    .vis-filetag{display:inline-flex;align-items:center;gap:6px;max-width:240px;padding:4px 8px;border:1px solid var(--line);border-radius:8px;background:none;color:inherit;font:inherit;font-size:12px;cursor:pointer}.vis-filetag:hover{border-color:var(--muted)}
    .vis-modal{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.65);display:grid;place-items:center;padding:14px}
    .vis-big{max-width:100%;max-height:100%;border-radius:10px;object-fit:contain}
    .vis-box{width:min(860px,100%);max-height:90vh;display:flex;flex-direction:column;border-radius:14px;background:Canvas;color:CanvasText;border:1px solid var(--line);overflow:hidden}
    .vis-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 14px;border-bottom:1px solid var(--line)}.vis-head b{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .vis-x{border:1px solid var(--line);background:none;color:inherit;border-radius:8px;padding:4px 12px;font:inherit;cursor:pointer}
    .vis-pre{margin:0;padding:12px 14px;overflow:auto;white-space:pre-wrap;word-break:break-word;font:12.5px/1.6 ui-monospace,Consolas,monospace}
    .vis-menu{position:fixed;z-index:2147482000;display:flex;flex-direction:column;min-width:210px;padding:6px;border-radius:12px;background:Canvas;color:CanvasText;border:1px solid var(--line);box-shadow:0 10px 30px rgba(0,0,0,.35)}
    .vis-menu button{border:0;background:none;color:inherit;font:inherit;text-align:left;padding:11px 12px;border-radius:8px;cursor:pointer}.vis-menu button:hover{background:rgba(127,127,127,.18)}
    @media(pointer:coarse){.vis-btn{width:38px;height:38px}.vis-chip{width:64px;height:64px}.vis-chip button{width:24px;height:24px;border-radius:12px;font-size:14px;line-height:24px}}
    .vis-prog{position:absolute;left:0;right:0;bottom:0;height:4px;background:rgba(127,127,127,.35)}.vis-prog i{display:block;height:100%;width:0;background:var(--accent,#e95164);transition:width .15s linear}
    .vis-pct{position:absolute;left:0;right:0;top:50%;transform:translateY(-50%);text-align:center;font-size:11px;font-weight:700;color:#fff;text-shadow:0 1px 3px #000}.vis-chip.doc .vis-pct{position:static;transform:none;color:inherit;text-shadow:none;font-weight:400;opacity:.8;flex:none}
    .vis-note{font-size:12px;color:var(--muted);padding:2px 12px 0}.vis-drop{outline:2px dashed var(--accent,#e95164);outline-offset:-4px}`);
  document.head.append(style);

  // 用 XMLHttpRequest 上传：fetch 拿不到上传进度，也没法在上传途中取消
  function upload(file, entry) {
    const image = isImage(file);
    if (image && file.size > cfg.maxMb * 1048576) return Promise.reject(new Error('图片太大（上限 ' + cfg.maxMb + ' MB）'));
    if (!image && file.size > cfg.maxDocKb * 1024) return Promise.reject(new Error('文件太大（上限 ' + Math.round(cfg.maxDocKb / 1024 * 10) / 10 + ' MB）'));
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest(); entry.xhr = xhr;
      xhr.open('PUT', '/api/attachments?name=' + encodeURIComponent(file.name || (image ? '图片' : '文件')));
      xhr.setRequestHeader('Content-Type', 'application/octet-stream'); xhr.setRequestHeader('X-CSRF-Token', csrf);
      xhr.upload.onprogress = event => { if (event.lengthComputable) { entry.pct = Math.min(99, Math.round(event.loaded / event.total * 100)); showProgress(entry); } };
      xhr.upload.onload = () => { entry.pct = 100; entry.processing = true; showProgress(entry); };   // 传完了，服务器还要提取文字
      xhr.onload = () => {
        let data = {}; try { data = JSON.parse(xhr.responseText); } catch { /* 无正文 */ }
        if (xhr.status >= 200 && xhr.status < 300 && data.attachment) resolve(data.attachment);
        else reject(new Error(data.error || '上传失败：' + xhr.status));
      };
      xhr.onerror = () => reject(new Error('网络出错，上传没有完成'));
      xhr.ontimeout = () => reject(new Error('上传超时'));
      xhr.onabort = () => reject(Object.assign(new Error('已取消'), { aborted: true }));
      xhr.timeout = 10 * 60 * 1000;
      xhr.send(file);
    });
  }
  function showProgress(entry) {
    if (!entry.bar) return;
    const done = Boolean(entry.id);
    entry.bar.parentElement.hidden = done;
    entry.bar.style.width = (entry.processing ? 100 : entry.pct || 0) + '%';
    entry.pctEl.textContent = done ? '' : entry.processing ? '解析中…' : (entry.pct || 0) + '%';
  }
  const note = text => { let n = document.getElementById('visNote'); if (!n) { n = el('div', { id: 'visNote', class: 'vis-note', role: 'status' }); strip.after(n); } n.textContent = text || ''; n.hidden = !text; };
  function addFiles(files) {
    for (const file of files) {
      const image = isImage(file), same = pending.filter(entry => entry.image === image).length;
      if (image && same >= cfg.maxImages) { note('一条消息最多带 ' + cfg.maxImages + ' 张图片'); continue; }
      if (!image && same >= cfg.maxFiles) { note('一条消息最多带 ' + cfg.maxFiles + ' 个文件'); continue; }
      const entry = { file, image, url: image ? URL.createObjectURL(file) : '', id: '', failed: false, pct: 0, processing: false, xhr: null };
      pending.push(entry); paint();
      upload(file, entry).then(a => { entry.id = a.id; entry.xhr = null; note(''); paint(); }).catch(e => { const i = pending.indexOf(entry); if (i >= 0) pending.splice(i, 1); if (!e.aborted) { entry.failed = true; note(file.name + '：' + e.message); } paint(); });
    }
  }
  function paint() {
    strip.replaceChildren(...pending.map(entry => {
      const remove = el('button', { type: 'button', textContent: '×', title: entry.id ? '移除' : '取消上传', 'aria-label': entry.id ? (entry.image ? '移除图片' : '移除文件') : '取消上传', on: { click: () => { if (!entry.id && entry.xhr) { entry.xhr.abort(); return; } pending.splice(pending.indexOf(entry), 1); if (entry.id) originalFetch('/api/attachments/' + entry.id, { method: 'DELETE', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf } }).catch(() => {}); paint(); } } });
      entry.bar = el('i'); entry.pctEl = el('span', { class: 'vis-pct' });
      const prog = el('div', { class: 'vis-prog' }, entry.bar);
      const chip = entry.image
        ? el('div', { class: 'vis-chip' + (entry.id ? '' : ' up'), title: entry.file.name }, el('img', { src: entry.url, alt: entry.file.name }), entry.pctEl, prog, remove)
        : el('div', { class: 'vis-chip doc' + (entry.id ? '' : ' up'), title: entry.file.name }, el('span', { class: 'vis-ext', textContent: (extOf(entry.file.name) || 'file').slice(0, 5).toUpperCase() }), el('span', { class: 'vis-fname', textContent: entry.file.name }), entry.pctEl, prog, remove);
      showProgress(entry);
      return chip;
    }));
  }
  // 消息气泡里：图片显示缩略图，文件显示成可点开的标签
  // 点开附件：图片在页面内放大，文件在页面内显示提取出的文字。不再用“新窗口打开”的方式 —— 安卓 App（Capacitor 外壳）里会跳到外部浏览器，那边没有登录状态，打不开
  function overlay(...kids) {
    const layer = el('div', { class: 'vis-modal', role: 'dialog', 'aria-modal': 'true' }, ...kids);
    const close = () => { layer.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = event => { if (event.key === 'Escape') close(); };
    layer.addEventListener('click', event => { if (event.target === layer) close(); });
    document.addEventListener('keydown', onKey); document.body.append(layer);
    return close;
  }
  const lightbox = src => { let close; close = overlay(el('img', { class: 'vis-big', src, alt: '', on: { click: () => close() } })); };
  async function viewText(item) {
    const name = item.name || '文件', body = el('pre', { class: 'vis-pre', textContent: '正在读取…' });
    let close; close = overlay(el('div', { class: 'vis-box' }, el('div', { class: 'vis-head' }, el('b', { textContent: name }), el('button', { type: 'button', class: 'vis-x', textContent: '关闭', on: { click: () => close() } })), body));
    try {
      const response = await originalFetch(item.src || '/api/attachments/' + encodeURIComponent(item.id), { credentials: 'same-origin' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      body.textContent = await response.text();
    } catch (error) { body.textContent = '读取失败：' + error.message; }
  }
  const thumbs = list => el('div', { class: 'vis-thumbs' }, list.map(item => item.doc
    ? el('button', { type: 'button', class: 'vis-filetag', title: '点开查看提取出的文字：' + item.name, on: { click: () => viewText(item) } }, el('span', { class: 'vis-ext', textContent: (extOf(item.name) || 'file').slice(0, 5).toUpperCase() }), el('span', { class: 'vis-fname', textContent: item.name }))
    : el('img', { src: item.src || '/api/attachments/' + item.id, alt: item.name || '图片', loading: 'lazy', on: { click: e => lightbox(e.target.src) } })));
  const isChatUrl = url => { const p = url.split('?')[0]; return p.endsWith('/api/chat') || p.endsWith('/api/chat/stream'); };
  const conversationId = url => { const p = url.split('?')[0], key = '/api/conversations/', i = p.lastIndexOf(key); if (i < 0) return ''; const rest = p.slice(i + key.length); return /^[0-9a-f-]+$/i.test(rest) ? rest : ''; };
  // 包装 fetch：聊天请求加附件；读取对话时记下哪些用户消息带图 / 文件
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input?.url || '';
    if (init && init.method === 'POST' && isChatUrl(url) && typeof init.body === 'string') {
      const ready = pending.filter(entry => entry.id);
      if (ready.length) {
        try {
          const body = JSON.parse(init.body); body.attachments = ready.map(entry => entry.id); init = { ...init, body: JSON.stringify(body) };
          liveByText.set(String(body.message || '').trim(), ready.map(entry => entry.image ? { src: entry.url, name: entry.file.name } : { doc: true, id: entry.id, name: entry.file.name }));
          // 通知桌宠：用户发了图（可能是表情包），她会让能看图的模型看一眼（文件不算）
          const images = ready.filter(entry => entry.image);
          if (images.length) window.dispatchEvent(new CustomEvent('yumeiro:images-sent', { detail: { ids: images.map(entry => entry.id), text: String(body.message || ''), files: images.map(entry => ({ type: entry.file.type, bytes: entry.file.size })) } }));
        } catch { /* 原样发送 */ }
        pending = []; paint();
      }
    }
    const response = await originalFetch(input, init);
    if (conversationId(url) && (!init || !init.method || init.method === 'GET') && response.ok) {
      response.clone().json().then(data => { byUserIndex = (data.messages || []).filter(m => m.role === 'user').map(m => [...(m.images || []), ...(m.files || []).map(f => ({ ...f, doc: true }))]); decorate(); }).catch(() => {});
    }
    return response;
  };
  // 给消息气泡补上缩略图 / 文件标签：新发的用本地预览，打开历史对话的用服务器上的
  function decorate() {
    const users = [...document.querySelectorAll('#messages .message.user')];
    users.forEach((node, index) => {
      const bubble = node.querySelector('.bubble'); if (!bubble) return;
      if (!node._vis) {
        if (byUserIndex[index]?.length) node._vis = byUserIndex[index];
        else if (liveByText.has((bubble.textContent || '').trim())) node._vis = liveByText.get((bubble.textContent || '').trim());
      }
      if (node._vis?.length && !bubble.querySelector('.vis-thumbs')) bubble.append(thumbs(node._vis));
    });
  }
  // 手机网络慢时，上一次 boot 还在等接口，定时器又启动了新的一次，每次都会再插入一个按钮——所以同一时间只允许一个 boot 在跑
  let booting = null;
  function boot() { return booting || (booting = bootOnce().finally(() => { booting = null; })); }
  async function bootOnce() {
    const composer = document.getElementById('composer'), send = document.getElementById('send'), prompt = document.getElementById('prompt'), messages = document.getElementById('messages');
    if (!composer || !send || !prompt) return false;
    if (document.getElementById('visBtn')) return true;
    try { const session = await (await originalFetch('/api/auth/session', { credentials: 'same-origin' })).json(); if (!session.authenticated) return false; csrf = session.csrfToken || ''; } catch { return false; }
    try { const c = await (await originalFetch('/api/vision/config', { credentials: 'same-origin' })).json(); cfg = { ...cfg, ...c }; } catch { /* 用默认值 */ }
    if (document.getElementById('visBtn')) return true; // 等接口期间可能已经有别处装好了
    strip = el('div', { class: 'vis-strip', 'aria-label': '待发送的图片和文件' }); composer.prepend(strip);
    const picker = el('input', { type: 'file', accept: ACCEPT, multiple: true, hidden: true });
    picker.addEventListener('change', () => { addFiles([...picker.files]); picker.value = ''; });
    // 手机 / 平板（含安卓 App）：点回形针先选“图片（相册 / 拍照）”还是“文件”。“文件”不限制扩展名——安卓的选文件窗口会把 .md / .py 这类认不出的扩展名直接隐藏，由服务器校验格式
    const touch = (window.matchMedia && matchMedia('(pointer:coarse)').matches) || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const pick = accept => { picker.accept = accept; picker.click(); };
    let menu = null;
    const closeMenu = () => { if (menu) { menu.remove(); menu = null; } };
    const openMenu = () => {
      if (menu) { closeMenu(); return; }
      const rect = button.getBoundingClientRect();
      menu = el('div', { class: 'vis-menu', style: 'left:' + Math.max(8, Math.round(rect.left)) + 'px;bottom:' + Math.round(window.innerHeight - rect.top + 8) + 'px' },
        el('button', { type: 'button', textContent: '图片（相册 / 拍照）', on: { click: () => { closeMenu(); pick('image/*'); } } }),
        el('button', { type: 'button', textContent: '文件（PDF、Word、Excel、文本…）', on: { click: () => { closeMenu(); pick(''); } } }));
      document.body.append(menu);
      setTimeout(() => document.addEventListener('click', function away(event) { if (!menu || !menu.contains(event.target)) { closeMenu(); document.removeEventListener('click', away); } }), 0);
    };
    const button = el('button', { type: 'button', id: 'visBtn', class: 'vis-btn', title: '添加图片或文件（也可以直接粘贴或拖进输入框）', 'aria-label': '添加图片或文件', on: { click: () => { if (touch) openMenu(); else pick(ACCEPT); } } });
    button.innerHTML = CLIP;
    send.parentElement.insertBefore(button, send); composer.append(picker);
    prompt.addEventListener('paste', e => { const files = [...(e.clipboardData?.files || [])]; if (files.length) { e.preventDefault(); addFiles(files); } });
    composer.addEventListener('dragover', e => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); composer.classList.add('vis-drop'); } });
    composer.addEventListener('dragleave', () => composer.classList.remove('vis-drop'));
    composer.addEventListener('drop', e => { composer.classList.remove('vis-drop'); const files = [...(e.dataTransfer?.files || [])]; if (files.length) { e.preventDefault(); addFiles(files); } });
    // 只发附件不写字时，补一句默认提问，避免被“消息不能为空”拦住
    document.addEventListener('submit', e => {
      if (e.target !== composer || !pending.some(x => x.id) || prompt.value.trim()) return;
      prompt.value = pending.filter(x => x.id).every(x => !x.image) ? '请阅读我上传的文件，并总结其中的要点。' : '请看这张图片，描述并分析其中的内容。';
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    }, true);
    if (messages) new MutationObserver(() => { if (!messages.querySelector('.message')) { byUserIndex = []; } decorate(); }).observe(messages, { childList: true, subtree: true });
    return true;
  }
  let tries = 0;
  const timer = setInterval(async () => { if (await boot() || ++tries > 200) clearInterval(timer); }, 1500);
  setTimeout(() => boot().then(ok => { if (ok) clearInterval(timer); }), 1000);
})();
