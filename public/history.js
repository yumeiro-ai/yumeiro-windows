// 历史记录树：把对话历史画成一棵会生长的樱花树（动漫风格的夜空、月亮、飘落的花瓣）。
// 树干 = 时间（下旧上新），每个分支 = 一段对话，分支越长对话越长，叶子 = 消息，灯笼 = 长期记忆。
// 悬停看摘要，点击跳到那段对话。纯 Canvas 绘制，没有外部依赖。
(() => {
  let csrf = '', overlay = null, raf = 0;
  const api = async path => {
    const response = await fetch(path, { headers: { Accept: 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }, credentials: 'same-origin' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '请求失败：' + response.status);
    return data;
  };
  const el = (tag, props = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) { if (k === 'on') for (const [e, f] of Object.entries(v)) node.addEventListener(e, f); else if (k === 'style') node.style.cssText = v; else if (k in node) node[k] = v; else node.setAttribute(k, v); }
    node.append(...kids.flat().filter(x => x != null && x !== false));
    return node;
  };
  const hash = text => { let h = 2166136261; for (const ch of String(text)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
  const PALETTE = [[340, 80, 78], [200, 75, 72], [280, 60, 76], [160, 55, 68], [30, 85, 74], [255, 65, 78], [320, 70, 74], [185, 70, 66]];
  const hsl = ([h, s, l], a = 1) => `hsla(${h},${s}%,${l}%,${a})`;
  const ease = t => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
  const reduced = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // 稳定的伪随机：同一段对话每次画出来的样子一样
  const rng = seed => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

  function layout(data, W, H) {
    const list = data.conversations, n = list.length;
    const cx = W / 2, bottom = H - 70, top = 110;
    const nodes = [];
    list.forEach((c, i) => {
      const r = rng(hash(c.id)), f = n > 1 ? i / (n - 1) : 0.5;
      const y = bottom - 40 - f * (bottom - top - 40);
      const side = i % 2 ? 1 : -1;
      const reach = Math.min(W * 0.42, 70 + Math.sqrt(c.count + 1) * (n > 60 ? 16 : 30)) * (0.85 + r() * 0.3);
      const trunkX = cx + Math.sin(f * 5) * 14;
      const tipX = trunkX + side * reach, tipY = y - 30 - r() * 50;
      const ctrlX = trunkX + side * reach * 0.5, ctrlY = y + 6 - r() * 20;
      const leaves = Math.min(14, Math.ceil(c.count / 2)), color = PALETTE[hash(c.model || c.agent || 'default') % PALETTE.length];
      nodes.push({ c, i, f, trunkX, y, tipX, tipY, ctrlX, ctrlY, leaves, color, r: 6 + Math.min(9, Math.log2(c.count + 1) * 2), delay: (i / Math.max(1, n)) * 0.55, seed: hash(c.id) });
    });
    return { nodes, cx, bottom, top };
  }
  const bez = (a, b, c, t) => ({ x: (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * b.x + t * t * c.x, y: (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * b.y + t * t * c.y });

  function open(data) {
    close();
    const canvas = el('canvas', { style: 'position:absolute;inset:0;width:100%;height:100%;display:block;cursor:default' });
    const tip = el('div', { style: 'position:absolute;pointer-events:none;max-width:260px;padding:8px 10px;border-radius:10px;background:rgba(20,16,40,.88);color:#fff;font-size:12px;line-height:1.5;box-shadow:0 6px 24px #0008;display:none' });
    const head = el('div', { style: 'position:absolute;left:0;right:0;top:0;display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:calc(12px + env(safe-area-inset-top,0px)) 14px 12px 18px;color:#fff;text-shadow:0 1px 6px #0009;pointer-events:none' },
      el('div', { style: 'flex:1;min-width:0' }, el('div', { style: 'font-size:18px;font-weight:600;letter-spacing:2px', textContent: '记忆之树' }),
        el('div', { style: 'font-size:12px;opacity:.85;line-height:1.5;margin-top:2px', textContent: `${data.conversations.length} 段对话 · ${data.memories} 条长期记忆 · ${data.workspaces} 个工作区　颜色 = 使用的模型/智能体，分支越长对话越长` })),
      el('button', { type: 'button', textContent: '关闭 ✕', style: 'pointer-events:auto;flex:none;white-space:nowrap;border:1px solid #fff6;background:#0004;color:#fff;border-radius:18px;padding:8px 14px;min-height:38px;cursor:pointer', on: { click: close } }));
    overlay = el('div', { role: 'dialog', 'aria-label': '历史记录树', style: 'position:fixed;inset:0;z-index:50;background:#120d2b' }, canvas, head, tip);
    overlay.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
    overlay.tabIndex = -1;
    document.body.append(overlay); overlay.focus();
    if (!data.conversations.length) { overlay.append(el('div', { style: 'position:absolute;left:0;right:0;top:34%;padding:0 28px;text-align:center;font-size:15px;line-height:1.7;color:#fff;text-shadow:0 1px 6px #000a;pointer-events:none', textContent: '还没有对话——聊几句，这棵树就会开始生长。' })); }

    const ctx = canvas.getContext('2d');
    let W = 0, H = 0, L = null, started = performance.now(), hover = null;
    const petals = Array.from({ length: 38 }, (_, i) => ({ x: Math.random(), y: Math.random(), s: 3 + Math.random() * 5, v: 0.02 + Math.random() * 0.04, d: Math.random() * 6, a: Math.random() * 6 }));
    const stars = Array.from({ length: 90 }, () => ({ x: Math.random(), y: Math.random() * 0.6, r: Math.random() * 1.3 + 0.3, t: Math.random() * 6 }));
    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      W = overlay.clientWidth; H = overlay.clientHeight;
      canvas.width = W * dpr; canvas.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      L = layout(data, W, H);
    };
    resize(); window.addEventListener('resize', resize); overlay._resize = resize;

    const still = reduced();
    const frame = now => {
      const el_ = (now - started) / 1000, grow = still ? 1 : ease(el_ / 4.2), sway = still ? 0 : Math.sin(el_ * 0.8);
      // 夜空
      const sky = ctx.createLinearGradient(0, 0, 0, H); sky.addColorStop(0, '#120d2b'); sky.addColorStop(0.55, '#3a2260'); sky.addColorStop(1, '#c0587f');
      ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
      for (const s of stars) { ctx.globalAlpha = 0.4 + 0.6 * Math.abs(Math.sin(el_ * 0.9 + s.t)); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(s.x * W, s.y * H, s.r, 0, 6.3); ctx.fill(); }
      ctx.globalAlpha = 1;
      // 月亮
      const mx = W * 0.82, my = H * 0.17, mg = ctx.createRadialGradient(mx, my, 6, mx, my, 90); mg.addColorStop(0, '#fff8d8ff'); mg.addColorStop(0.25, '#fff2b8aa'); mg.addColorStop(1, '#fff2b800');
      ctx.fillStyle = mg; ctx.beginPath(); ctx.arc(mx, my, 90, 0, 6.3); ctx.fill(); ctx.fillStyle = '#fffbe6'; ctx.beginPath(); ctx.arc(mx, my, 26, 0, 6.3); ctx.fill();
      // 远山与地面
      ctx.fillStyle = '#2a1a4d'; ctx.beginPath(); ctx.moveTo(0, H); for (let x = 0; x <= W; x += 20) ctx.lineTo(x, H - 90 - 38 * Math.sin(x / 140) - 20 * Math.sin(x / 57)); ctx.lineTo(W, H); ctx.fill();
      ctx.fillStyle = '#1b1136'; ctx.fillRect(0, H - 56, W, 56);

      const { nodes, cx, bottom, top } = L;
      // 树干（随生长进度向上延伸，向两侧略粗）
      const topNow = bottom - (bottom - top) * grow;
      const trunk = ctx.createLinearGradient(cx - 20, 0, cx + 20, 0); trunk.addColorStop(0, '#3b2430'); trunk.addColorStop(0.5, '#6b4150'); trunk.addColorStop(1, '#2e1c27');
      ctx.fillStyle = trunk; ctx.beginPath(); ctx.moveTo(cx - 20, bottom + 14);
      for (let y = bottom; y >= topNow; y -= 6) { const f = (bottom - y) / (bottom - top); ctx.lineTo(cx + Math.sin(f * 5) * 14 - (15 - f * 11), y); }
      for (let y = topNow; y <= bottom; y += 6) { const f = (bottom - y) / (bottom - top); ctx.lineTo(cx + Math.sin(f * 5) * 14 + (15 - f * 11), y); }
      ctx.lineTo(cx + 20, bottom + 14); ctx.fill();

      // 月份标签
      ctx.font = '11px sans-serif'; ctx.textBaseline = 'middle'; let lastMonth = '';
      for (const n of nodes) {
        const m = new Date(n.c.createdAt).toISOString().slice(0, 7);
        if (m !== lastMonth && grow > n.delay) { lastMonth = m; ctx.fillStyle = '#ffffffaa'; ctx.textAlign = 'right'; ctx.fillText(m, n.trunkX - 26, n.y); ctx.fillRect(n.trunkX - 22, n.y, 8, 1); }
      }
      // 分支、叶子、对话节点
      hover = hover && nodes.find(n => n.c.id === hover.c.id) || null;
      for (const n of nodes) {
        const p = ease((grow - n.delay) / (1 - n.delay) * 1.15);
        if (p <= 0) continue;
        const a = { x: n.trunkX, y: n.y }, k = sway * 6 * (n.i % 2 ? 1 : -1) * p;
        const b = { x: n.ctrlX, y: n.ctrlY + k * 0.5 }, c = { x: n.tipX + k, y: n.tipY + k * 0.4 };
        const bw = 4 + Math.min(4, Math.log2(n.c.count + 1));
        ctx.lineCap = 'round'; ctx.strokeStyle = '#5a3646'; ctx.lineWidth = bw;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); const steps = 20; for (let s = 1; s <= steps * p; s++) { const q = bez(a, b, c, s / steps); ctx.lineTo(q.x, q.y); } ctx.stroke();
        const rand = rng(n.seed);
        for (let l = 0; l < n.leaves; l++) { // 叶子/花瓣沿分支分布
          const t = (l + 1) / (n.leaves + 1); if (t > p) continue;
          const q = bez(a, b, c, t), ang = rand() * 6.3 + el_ * 0.2 * (l % 2 ? 1 : -1) * (still ? 0 : 1), size = 5 + rand() * 4;
          ctx.save(); ctx.translate(q.x, q.y + (rand() - 0.5) * 12); ctx.rotate(ang); ctx.fillStyle = hsl(n.color, 0.9); ctx.beginPath(); ctx.ellipse(size * 0.8, 0, size, size * 0.55, 0, 0, 6.3); ctx.fill(); ctx.restore();
        }
        if (p > 0.92) { // 对话节点：发光的花
          const pulse = still ? 0 : Math.sin(el_ * 2 + n.i) * 1.5, rr = n.r + pulse + (hover === n ? 4 : 0), tip_ = c;
          n.px = tip_.x; n.py = tip_.y;
          const g = ctx.createRadialGradient(tip_.x, tip_.y, 1, tip_.x, tip_.y, rr * 3); g.addColorStop(0, hsl(n.color, 0.75)); g.addColorStop(1, hsl(n.color, 0));
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(tip_.x, tip_.y, rr * 3, 0, 6.3); ctx.fill();
          for (let pe = 0; pe < 5; pe++) { const ang = pe * 1.2566 + 0.3; ctx.fillStyle = hsl(n.color, 0.95); ctx.beginPath(); ctx.ellipse(tip_.x + Math.cos(ang) * rr * 0.7, tip_.y + Math.sin(ang) * rr * 0.7, rr * 0.7, rr * 0.45, ang, 0, 6.3); ctx.fill(); }
          ctx.fillStyle = '#fff4b0'; ctx.beginPath(); ctx.arc(tip_.x, tip_.y, rr * 0.3, 0, 6.3); ctx.fill();
          if (n.c.hasSummary) { ctx.strokeStyle = '#ffffffcc'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(tip_.x, tip_.y, rr * 1.35, 0, 6.3); ctx.stroke(); }
        }
      }
      // 记忆灯笼：挂在树干两侧低处
      const lanterns = Math.min(12, data.memories);
      for (let i = 0; i < lanterns; i++) {
        const side = i % 2 ? 1 : -1, x = cx + side * (46 + (i >> 1) * 20), y = bottom - 6 + Math.sin(el_ * 1.4 + i) * (still ? 0 : 3) - (i >> 1) * 3;
        const g = ctx.createRadialGradient(x, y, 1, x, y, 22); g.addColorStop(0, '#ffd27acc'); g.addColorStop(1, '#ffd27a00'); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 22, 0, 6.3); ctx.fill();
        ctx.fillStyle = '#ff9c5b'; ctx.beginPath(); ctx.ellipse(x, y, 6, 8, 0, 0, 6.3); ctx.fill(); ctx.fillStyle = '#ffe9a8'; ctx.fillRect(x - 3, y - 2, 6, 4);
      }
      // 飘落的花瓣
      if (!still) for (const pt of petals) {
        pt.y += pt.v * 0.016; pt.x += Math.sin(el_ + pt.d) * 0.0004 + 0.00012; if (pt.y > 1.05) { pt.y = -0.05; pt.x = Math.random(); } if (pt.x > 1.05) pt.x = -0.05;
        ctx.save(); ctx.translate(pt.x * W, pt.y * H); ctx.rotate(el_ * 0.7 + pt.a); ctx.fillStyle = '#ffd1e6cc'; ctx.beginPath(); ctx.ellipse(0, 0, pt.s, pt.s * 0.55, 0, 0, 6.3); ctx.fill(); ctx.restore();
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    const pick = e => {
      const rect = canvas.getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top;
      let best = null, bestD = 22 * 22;
      for (const n of L.nodes) if (n.px !== undefined) { const d = (n.px - x) ** 2 + (n.py - y) ** 2; if (d < bestD) { bestD = d; best = n; } }
      return { best, x, y };
    };
    canvas.addEventListener('mousemove', e => {
      const { best, x, y } = pick(e); hover = best; canvas.style.cursor = best ? 'pointer' : 'default';
      if (!best) { tip.style.display = 'none'; return; }
      tip.replaceChildren(el('strong', { textContent: best.c.title }), el('div', { textContent: `${best.c.count} 条消息 · ${new Date(best.c.createdAt).toLocaleDateString()}${best.c.agent ? ' · ' + best.c.agent : ''}${best.c.model ? ' · ' + best.c.model : ''}` }), best.c.preview ? el('div', { style: 'opacity:.8', textContent: '“' + best.c.preview + '”' }) : null, el('div', { style: 'opacity:.6', textContent: '点击打开这段对话' }));
      tip.style.display = 'block'; tip.style.left = Math.min(W - 280, x + 14) + 'px'; tip.style.top = Math.min(H - 110, y + 14) + 'px';
    });
    canvas.addEventListener('click', e => { const { best } = pick(e); if (best) { close(); if (window.yumeiroSelectChat) window.yumeiroSelectChat(best.c.id); } });
  }
  function close() {
    cancelAnimationFrame(raf);
    if (overlay) { window.removeEventListener('resize', overlay._resize); overlay.remove(); overlay = null; }
  }

  // 同一时间只允许一个 boot 在等接口，避免定时器重复进入、把按钮插入多次
  let booting = null;
  function boot() { return booting || (booting = bootOnce().finally(() => { booting = null; })); }
  async function bootOnce() {
    try { const session = await api('/api/auth/session'); if (!session.authenticated) return false; csrf = session.csrfToken || ''; } catch { return false; }
    const anchor = document.getElementById('memoryButton') || document.getElementById('settings');
    if (!anchor) return false;
    if (document.getElementById('historyButton')) return true;
    anchor.before(el('button', { class: 'icon-button', id: 'historyButton', type: 'button', title: '历史记录树', 'aria-label': '历史记录树', textContent: '🌸', on: { click: async () => { try { open(await api('/api/history/tree')); } catch (e) { ymAlert(e.message); } } } }));
    return true;
  }
  let tries = 0;
  const timer = setInterval(async () => { if (await boot() || ++tries > 200) clearInterval(timer); }, 1500);
  setTimeout(() => boot().then(ok => { if (ok) clearInterval(timer); }), 600);
})();
