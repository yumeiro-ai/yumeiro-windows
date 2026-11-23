// 轻量图表库（纯 SVG，无依赖）：堆叠柱状图、折线面积图、环形图、横向条形图、小时分布；支持浅/深色主题，
// 颜色在绘制时解析成具体色值，所以导出的 PNG/SVG 与屏幕所见一致。
(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = (tag, attrs = {}, ...kids) => {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    for (const kid of kids.flat()) if (kid != null) node.append(kid);
    return node;
  };
  const text = (x, y, content, attrs = {}) => { const node = svg('text', { x, y, ...attrs }); node.textContent = content; return node; };
  const titled = (node, label) => { const t = svg('title'); t.textContent = label; node.append(t); return node; };
  const num = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n * 10) / 10);
  const niceMax = max => { if (max <= 5) return 5; const p = Math.pow(10, Math.floor(Math.log10(max))), f = max / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; };

  // 当前主题的具体色值
  function palette() {
    const style = getComputedStyle(document.documentElement), get = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    return {
      dark, fg: get('--gs-fg', dark ? '#e8e9ee' : '#252832'), muted: get('--gs-muted', dark ? '#9a9eab' : '#777b86'),
      grid: get('--gs-grid', dark ? '#2c2f3b' : '#e7e8ec'), bg: get('--gs-bg', dark ? '#161922' : '#ffffff'),
      series: dark ? ['#ff7b8d', '#5ab0ff', '#f2c14e', '#6ad39a', '#b693ff', '#ff9f5b', '#8b93a7'] : ['#e95164', '#2f7de1', '#d99a0b', '#2f9e6b', '#8a5cf0', '#e8772e', '#8b93a7']
    };
  }
  const frame = (w, h, p) => svg('svg', { viewBox: `0 0 ${w} ${h}`, width: '100%', role: 'img', 'font-family': 'system-ui,-apple-system,Segoe UI,PingFang SC,Microsoft YaHei,sans-serif', 'font-size': 11, style: 'display:block;max-width:100%;height:auto' }, svg('rect', { width: w, height: h, fill: p.bg, rx: 10 }));

  // 堆叠柱状图：rows=[{day,k1,k2..}]，keys=[{key,label}]
  function stacked({ rows, keys, height = 220, width = 720, unit = '次' }) {
    const p = palette(), m = { l: 44, r: 12, t: 30, b: 26 }, w = width, h = height, iw = w - m.l - m.r, ih = h - m.t - m.b;
    const root = frame(w, h, p), totals = rows.map(r => keys.reduce((n, k) => n + (r[k.key] || 0), 0)), max = niceMax(Math.max(1, ...totals));
    for (let i = 0; i <= 4; i++) { const y = m.t + ih - ih * i / 4; root.append(svg('line', { x1: m.l, x2: w - m.r, y1: y, y2: y, stroke: p.grid }), text(m.l - 6, y + 4, num(max * i / 4), { fill: p.muted, 'text-anchor': 'end' })); }
    const bw = iw / rows.length;
    rows.forEach((r, i) => {
      let y = m.t + ih; const g = svg('g');
      keys.forEach((k, ki) => { const v = r[k.key] || 0; if (!v) return; const bh = v / max * ih; y -= bh; g.append(svg('rect', { x: m.l + i * bw + bw * 0.14, y, width: Math.max(1, bw * 0.72), height: bh, fill: p.series[ki % p.series.length], rx: 1.5 })); });
      titled(g, `${r.day}\n` + keys.map(k => `${k.label}：${r[k.key] || 0} ${unit}`).join('\n'));
      g.append(svg('rect', { x: m.l + i * bw, y: m.t, width: bw, height: ih, fill: 'transparent' }));
      root.append(g);
      if (rows.length <= 10 || i % Math.ceil(rows.length / 8) === 0) root.append(text(m.l + i * bw + bw / 2, h - 8, r.day.slice(5), { fill: p.muted, 'text-anchor': 'middle' }));
    });
    keys.forEach((k, ki) => { const x = m.l + ki * 92; root.append(svg('rect', { x, y: 2, width: 9, height: 9, fill: p.series[ki % p.series.length], rx: 2 }), text(x + 13, 10.5, k.label, { fill: p.fg })); });
    return root;
  }

  // 折线 + 面积
  function line({ rows, key, label, height = 200, width = 720, color = 0 }) {
    const p = palette(), m = { l: 44, r: 12, t: 16, b: 26 }, w = width, h = height, iw = w - m.l - m.r, ih = h - m.t - m.b;
    const root = frame(w, h, p), max = niceMax(Math.max(1, ...rows.map(r => r[key] || 0))), step = rows.length > 1 ? iw / (rows.length - 1) : 0;
    for (let i = 0; i <= 4; i++) { const y = m.t + ih - ih * i / 4; root.append(svg('line', { x1: m.l, x2: w - m.r, y1: y, y2: y, stroke: p.grid }), text(m.l - 6, y + 4, num(max * i / 4), { fill: p.muted, 'text-anchor': 'end' })); }
    const pts = rows.map((r, i) => [m.l + i * step, m.t + ih - (r[key] || 0) / max * ih]), c = p.series[color % p.series.length];
    if (pts.length) {
      root.append(svg('path', { d: `M${pts[0][0]},${m.t + ih} ` + pts.map(([x, y]) => `L${x},${y}`).join(' ') + ` L${pts.at(-1)[0]},${m.t + ih}Z`, fill: c, opacity: 0.16 }), svg('polyline', { points: pts.map(q => q.join(',')).join(' '), fill: 'none', stroke: c, 'stroke-width': 2, 'stroke-linejoin': 'round' }));
      pts.forEach(([x, y], i) => { root.append(titled(svg('circle', { cx: x, cy: y, r: rows.length > 45 ? 1.6 : 3, fill: c }), `${rows[i].day}：${rows[i][key] || 0} ${label}`)); if (rows.length <= 10 || i % Math.ceil(rows.length / 8) === 0) root.append(text(x, h - 8, rows[i].day.slice(5), { fill: p.muted, 'text-anchor': 'middle' })); });
    }
    root.append(text(m.l, 11, label, { fill: p.fg }));
    return root;
  }

  // 环形图
  function donut({ items, height = 200, width = 360 }) {
    const p = palette(), root = frame(width, height, p), total = items.reduce((n, i) => n + i.value, 0), cx = 100, cy = height / 2, R = 72, r = 44;
    if (!total) { root.append(text(width / 2, height / 2, '暂无数据', { fill: p.muted, 'text-anchor': 'middle' })); return root; }
    let a0 = -Math.PI / 2;
    items.forEach((it, i) => {
      const frac = it.value / total, a1 = a0 + Math.min(frac, 0.9999) * Math.PI * 2, large = a1 - a0 > Math.PI ? 1 : 0;
      const d = `M${cx + R * Math.cos(a0)},${cy + R * Math.sin(a0)} A${R},${R} 0 ${large} 1 ${cx + R * Math.cos(a1)},${cy + R * Math.sin(a1)} L${cx + r * Math.cos(a1)},${cy + r * Math.sin(a1)} A${r},${r} 0 ${large} 0 ${cx + r * Math.cos(a0)},${cy + r * Math.sin(a0)}Z`;
      root.append(titled(svg('path', { d, fill: p.series[i % p.series.length] }), `${it.label}：${it.value}（${(frac * 100).toFixed(1)}%）`));
      a0 = a1;
      root.append(svg('rect', { x: 200, y: 18 + i * 20, width: 10, height: 10, fill: p.series[i % p.series.length], rx: 2 }), text(216, 27 + i * 20, `${it.label.slice(0, 16)}  ${(frac * 100).toFixed(0)}%`, { fill: p.fg }));
    });
    root.append(text(cx, cy + 4, num(total), { fill: p.fg, 'text-anchor': 'middle', 'font-size': 15, 'font-weight': 600 }));
    return root;
  }

  // 横向条形图
  function hbar({ items, width = 720, row = 26, format = num, color = 1 }) {
    const p = palette(), m = { l: 170, r: 70, t: 8, b: 8 }, h = m.t + m.b + Math.max(1, items.length) * row, root = frame(width, h, p), max = Math.max(1, ...items.map(i => i.value));
    if (!items.length) root.append(text(width / 2, h / 2, '暂无数据', { fill: p.muted, 'text-anchor': 'middle' }));
    items.forEach((it, i) => {
      const y = m.t + i * row, bw = (width - m.l - m.r) * it.value / max;
      root.append(text(m.l - 8, y + row / 2 + 4, it.label.length > 24 ? it.label.slice(0, 23) + '…' : it.label, { fill: p.fg, 'text-anchor': 'end' }),
        titled(svg('rect', { x: m.l, y: y + 4, width: Math.max(2, bw), height: row - 10, fill: p.series[color % p.series.length], rx: 3 }), `${it.label}：${it.value}`), text(m.l + bw + 6, y + row / 2 + 4, format(it.value), { fill: p.muted }));
    });
    return root;
  }

  // 24 小时分布
  function hours({ values, height = 150, width = 720 }) {
    const p = palette(), m = { l: 34, r: 10, t: 12, b: 22 }, iw = width - m.l - m.r, ih = height - m.t - m.b, root = frame(width, height, p), max = niceMax(Math.max(1, ...values)), bw = iw / 24;
    for (let i = 0; i <= 2; i++) { const y = m.t + ih - ih * i / 2; root.append(svg('line', { x1: m.l, x2: width - m.r, y1: y, y2: y, stroke: p.grid }), text(m.l - 5, y + 4, num(max * i / 2), { fill: p.muted, 'text-anchor': 'end' })); }
    values.forEach((v, i) => { const bh = v / max * ih; root.append(titled(svg('rect', { x: m.l + i * bw + 2, y: m.t + ih - bh, width: bw - 4, height: Math.max(v ? 2 : 0, bh), fill: p.series[3], rx: 2 }), `${i}:00–${i}:59：${v} 次调用`)); if (i % 3 === 0) root.append(text(m.l + i * bw + bw / 2, height - 6, String(i), { fill: p.muted, 'text-anchor': 'middle' })); });
    return root;
  }

  // ---- 导出 ----
  const download = (blob, name) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); };
  const csvCell = v => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const toCsv = (rows, columns) => '\ufeff' + [columns.map(c => csvCell(c.label)).join(','), ...rows.map(r => columns.map(c => csvCell(r[c.key])).join(','))].join('\r\n') + '\r\n';
  function svgToPng(node, name, scale = 2) {
    const vb = node.viewBox.baseVal, w = vb.width, h = vb.height, clone = node.cloneNode(true);
    clone.setAttribute('xmlns', NS); clone.setAttribute('width', w); clone.setAttribute('height', h);
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml;charset=utf-8' }));
    const img = new Image();
    img.onload = () => { const canvas = document.createElement('canvas'); canvas.width = w * scale; canvas.height = h * scale; const ctx = canvas.getContext('2d'); ctx.scale(scale, scale); ctx.drawImage(img, 0, 0, w, h); URL.revokeObjectURL(url); canvas.toBlob(b => download(b, name), 'image/png'); };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }
  const svgDownload = (node, name) => { const clone = node.cloneNode(true); clone.setAttribute('xmlns', NS); download(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }), name); };

  window.yumeiroCharts = { stacked, line, donut, hbar, hours, palette, download, toCsv, svgToPng, svgDownload, num };
})();
