// 绘画面板：文生图。输入描述 → 选尺寸/张数 → 生成；下面是“我的作品”，可下载、重画、删除。需要管理员先在“管理设置 → 绘画模型”里开启。
(() => {
  let csrf = '', panel = null, cfg = null;
  const el = (tag, props = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) { if (k === 'on') for (const [e, f] of Object.entries(v)) node.addEventListener(e, f); else if (k === 'style') node.style.cssText = v; else if (k in node) node[k] = v; else node.setAttribute(k, v); }
    node.append(...kids.flat().filter(x => x != null && x !== false));
    return node;
  };
  async function api(path, options = {}) {
    const headers = { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) };
    const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
    let data = {}; try { data = await response.json(); } catch { /* 无正文 */ }
    if (!response.ok) throw new Error(data.error || '请求失败：' + response.status);
    return data;
  }
  const style = el('style', {}, `
    .ym-draw{width:min(880px,100%)!important;max-height:92vh;overflow:auto}
    .ym-draw textarea{width:100%;min-height:84px;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--ym-card,#fff);color:var(--ink);resize:vertical;box-sizing:border-box}
    .ym-draw .ym-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0}
    .ym-draw select{height:34px;border:1px solid var(--line);border-radius:9px;padding:0 8px;background:var(--ym-card,#fff);color:var(--ink)}
    .ym-draw .ym-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px;margin-top:8px}
    .ym-draw .ym-tile{position:relative;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--ym-card,#fff)}
    .ym-draw .ym-tile img{display:block;width:100%;aspect-ratio:1/1;object-fit:contain;cursor:zoom-in;background:#0003}
    .ym-draw .ym-tile .ym-cap{font-size:11px;color:var(--muted);padding:6px 8px;line-height:1.4;max-height:3.4em;overflow:hidden}
    .ym-draw .ym-tools{display:flex;gap:4px;padding:0 6px 6px;flex-wrap:wrap}
    .ym-draw .ym-tools a,.ym-draw .ym-tools button{font-size:11px;padding:2px 8px;border:1px solid var(--line);border-radius:7px;background:transparent;color:var(--ink);text-decoration:none;cursor:pointer}
    .ym-zoom{position:fixed;inset:0;z-index:70;background:#000c;display:grid;place-items:center;cursor:zoom-out}
    .ym-zoom img{max-width:94vw;max-height:92vh;border-radius:8px;box-shadow:0 10px 50px #000}
    .ym-note{font-size:12px;color:var(--muted)}`);
  document.head.append(style);

  const zoom = src => { const layer = el('div', { class: 'ym-zoom', on: { click: () => layer.remove() } }, el('img', { src })); document.body.append(layer); };
  const tile = (image, refs) => {
    const tools = el('div', { class: 'ym-tools' },
      el('a', { href: image.url, download: 'yumeiro-' + image.id.slice(0, 8) + '.' + (image.mime.split('/')[1] === 'jpeg' ? 'jpg' : image.mime.split('/')[1]), textContent: '下载' }),
      el('button', { type: 'button', textContent: '再画一次', on: { click: () => { refs.prompt.value = image.prompt; refs.prompt.focus(); } } }),
      el('button', { type: 'button', textContent: '删除', on: { click: async () => { if (!await ymConfirm('删除这张图片？', { danger: true, okText: '确定' })) return; try { await api('/api/images/' + image.id, { method: 'DELETE' }); node.remove(); } catch (e) { refs.status.textContent = e.message; } } } }));
    const node = el('div', { class: 'ym-tile' }, el('img', { src: image.url, alt: image.prompt, loading: 'lazy', on: { click: () => zoom(image.url) } }), el('div', { class: 'ym-cap', title: image.prompt, textContent: image.prompt }), tools);
    return node;
  };

  async function open() {
    if (!panel) {
      panel = el('div', { class: 'modal-backdrop', hidden: true, on: { click: e => { if (e.target === panel) panel.hidden = true; } } },
        el('div', { class: 'modal ym-draw' }, el('div', { class: 'modal-head' }, el('h2', { textContent: '绘画' }), el('button', { type: 'button', class: 'secondary', textContent: '关闭', on: { click: () => { panel.hidden = true; } } })), el('div', { 'data-body': '' })));
      document.body.append(panel);
    }
    panel.hidden = false;
    const body = panel.querySelector('[data-body]'); body.replaceChildren(el('p', { class: 'ym-note', textContent: '加载中…' }));
    try { cfg = await api('/api/images/config'); } catch (e) { body.replaceChildren(el('p', { textContent: e.message })); return; }
    if (!cfg.enabled) { body.replaceChildren(el('p', { textContent: '管理员还没有开启绘画功能。' }), el('p', { class: 'ym-note', textContent: '管理员可以在“管理设置 → 绘画模型”里接入文生图模型（OpenAI 兼容的 /images/generations）。' })); return; }
    const prompt = el('textarea', { placeholder: '描述你想画的画面，例如：夜晚的樱花树下，穿和服的少女提着灯笼，二次元插画风格', maxLength: 2000 });
    const size = el('select', {}, [...cfg.sizes.map(s => el('option', { value: s, textContent: s, selected: s === cfg.defaultSize })), cfg.allowCustomSize ? el('option', { value: '__custom', textContent: '自定义…' }) : null]);
    // 自定义宽高（管理员允许时）：范围、倍数和总像素由服务器校验
    const cw = el('input', { type: 'number', min: cfg.minSide, max: cfg.maxSide, step: cfg.sizeStep, value: 1024, title: '宽', style: 'width:84px;height:34px;border:1px solid var(--line);border-radius:9px;padding:0 6px;background:var(--ym-card,#fff);color:var(--ink)' });
    const ch = el('input', { type: 'number', min: cfg.minSide, max: cfg.maxSide, step: cfg.sizeStep, value: 1024, title: '高', style: cw.style.cssText });
    const customWrap = el('span', { hidden: true, class: 'ym-note' }, cw, ' × ', ch, ` 像素（${cfg.minSide}–${cfg.maxSide}，需为 ${cfg.sizeStep} 的倍数）`);
    size.addEventListener('change', () => { customWrap.hidden = size.value !== '__custom'; });
    const chosenSize = () => size.value === '__custom' ? `${Math.round(Number(cw.value))}x${Math.round(Number(ch.value))}` : size.value;
    const count = el('select', {}, Array.from({ length: cfg.maxPerRequest }, (_, i) => el('option', { value: i + 1, textContent: (i + 1) + ' 张' })));
    const status = el('span', { class: 'ym-note' }), results = el('div', { class: 'ym-grid' }), gallery = el('div', { class: 'ym-grid' }), emptyNote = el('p', { class: 'ym-note', textContent: '还没有作品。', hidden: true });
    const refs = { prompt, status };
    const quota = () => cfg.dailyLimit > 0 ? `今天已画 ${cfg.usedToday} / ${cfg.dailyLimit} 张` : `今天已画 ${cfg.usedToday} 张`;
    const info = el('span', { class: 'ym-note', textContent: `模型：${cfg.model}　${quota()}` });
    const generate = el('button', { type: 'button', class: 'primary', textContent: '生成', on: { click: async () => {
      if (!prompt.value.trim()) { status.textContent = '请先写一点想画的内容'; return; }
      generate.disabled = true; enhance.disabled = true; status.textContent = '正在生成…（通常 10–60 秒，请别关闭这个窗口）';
      try {
        const r = await api('/api/images', { method: 'POST', body: JSON.stringify({ prompt: prompt.value, size: chosenSize(), n: Number(count.value) }) });
        cfg.usedToday = r.usedToday; info.textContent = `模型：${cfg.model}　${quota()}`;
        results.prepend(...r.images.map(img => tile(img, refs))); gallery.prepend(...r.images.map(img => tile(img, refs))); emptyNote.hidden = true;
        status.textContent = '完成。图片已保存到“我的作品”。';
      } catch (e) { status.textContent = e.message; } finally { generate.disabled = false; enhance.disabled = false; }
    } } });
    const enhance = el('button', { type: 'button', class: 'secondary', textContent: '✨ 优化描述', title: '让当前对话模型把描述扩写得更适合绘画', on: { click: async () => {
      if (!prompt.value.trim()) { status.textContent = '请先写一点想画的内容'; return; }
      enhance.disabled = true; status.textContent = '正在优化描述…';
      try { const r = await api('/api/images/enhance', { method: 'POST', body: JSON.stringify({ prompt: prompt.value }) }); prompt.value = r.prompt; status.textContent = '已优化，可以再改一改。'; } catch (e) { status.textContent = e.message; } finally { enhance.disabled = false; }
    } } });
    body.replaceChildren(prompt, el('div', { class: 'ym-row' }, size, customWrap, count, enhance, generate, status), info,
      results, el('h3', { textContent: '我的作品' }), emptyNote, gallery);
    try { const { images } = await api('/api/images?limit=60'); gallery.append(...images.map(img => tile(img, refs))); emptyNote.hidden = images.length > 0; } catch (e) { status.textContent = e.message; }
  }

  // 同一时间只允许一个 boot 在等接口，避免定时器重复进入、把按钮插入多次
  let booting = null;
  function boot() { return booting || (booting = bootOnce().finally(() => { booting = null; })); }
  async function bootOnce() {
    try { const session = await api('/api/auth/session'); if (!session.authenticated) return false; csrf = session.csrfToken || ''; } catch { return false; }
    const anchor = document.getElementById('historyButton') || document.getElementById('memoryButton') || document.getElementById('settings');
    if (!anchor) return false;
    if (document.getElementById('drawButton')) return true;
    anchor.before(el('button', { class: 'icon-button', id: 'drawButton', type: 'button', title: '绘画（文生图）', 'aria-label': '绘画', textContent: '🎨', on: { click: open } }));
    return true;
  }
  let tries = 0;
  const timer = setInterval(async () => { if (await boot() || ++tries > 200) clearInterval(timer); }, 1500);
  setTimeout(() => boot().then(ok => { if (ok) clearInterval(timer); }), 900);
})();
