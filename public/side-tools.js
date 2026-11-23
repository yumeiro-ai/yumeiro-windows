// 侧边栏的小工具（纯函数，浏览器里挂在 window.YumeiroTools，Node 里 module.exports，测试用）：
//  calc(expr)      计算器——不用 eval，自己解析：+ - * / ^ % ( )、pi / e、sqrt abs sin cos tan ln log exp round floor ceil min max pow
//  convert(text)   单位换算，如 "5km to mi"、"100 f 转 c"、"3 斤 换成 kg"、"2gb to mb"
//  toUrl(input)    地址栏输入 → 可打开的 https 地址（像网址就补全，否则当成搜索词）；只允许 http(s)，javascript: / file: / data: 一律拒绝
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.YumeiroTools = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // ---------- 计算器 ----------
  const FUNCS = {
    sqrt: Math.sqrt, abs: Math.abs, sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
    ln: Math.log, log: Math.log10, exp: Math.exp, round: Math.round, floor: Math.floor, ceil: Math.ceil, min: Math.min, max: Math.max, pow: Math.pow
  };
  const CONSTS = { pi: Math.PI, e: Math.E };
  function calc(input) {
    const src = String(input || '').replace(/×/g, '*').replace(/÷/g, '/').replace(/（/g, '(').replace(/）/g, ')').replace(/，/g, ',').replace(/π/g, 'pi').replace(/\s+/g, '').toLowerCase();
    if (!src) return { ok: false, error: '请输入算式' };
    if (src.length > 200) return { ok: false, error: '算式太长' };
    let i = 0, depth = 0;
    const fail = message => { throw new Error(message); };
    const peek = () => src[i];
    function number() {
      const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/.exec(src.slice(i));
      if (!m) fail('看不懂：' + (src.slice(i, i + 6) || '结尾'));
      i += m[0].length; return Number(m[0]);
    }
    function primary() {
      if (++depth > 50) fail('括号太深');
      let value;
      const c = peek();
      if (c === '(') { i++; value = expr(); if (peek() !== ')') fail('缺少右括号'); i++; }
      else if (c !== undefined && /[a-z]/.test(c)) {
        const m = /^[a-z]+/.exec(src.slice(i))[0]; i += m.length;
        if (m in CONSTS && peek() !== '(') value = CONSTS[m];
        else if (m in FUNCS) {
          if (peek() !== '(') fail(m + ' 后面需要括号');
          i++; const args = [expr()]; while (peek() === ',') { i++; args.push(expr()); }
          if (peek() !== ')') fail('缺少右括号'); i++; value = FUNCS[m](...args);
        } else fail('不认识 ' + m);
      } else value = number();
      depth--; return value;
    }
    function postfix() { let v = primary(); while (peek() === '%') { i++; v /= 100; } return v; }
    function unary() { if (peek() === '-') { i++; return -unary(); } if (peek() === '+') { i++; return unary(); } return power(); }   // -2^2 = -(2^2)
    function power() { const base = postfix(); if (peek() === '^') { i++; return Math.pow(base, unary()); } return base; }
    function term() {
      let v = unary();
      for (;;) {
        if (peek() === '*') { i++; v *= unary(); }
        else if (peek() === '/') { i++; const d = unary(); if (d === 0) fail('除数不能为 0'); v /= d; }
        else return v;
      }
    }
    function expr() { let v = term(); for (;;) { if (peek() === '+') { i++; v += term(); } else if (peek() === '-') { i++; v -= term(); } else return v; } }
    try {
      const value = expr();
      if (i < src.length) fail('看不懂：' + src.slice(i, i + 6));
      if (!Number.isFinite(value)) fail('结果无效');
      return { ok: true, value, text: fmt(value) };
    } catch (error) { return { ok: false, error: error.message }; }
  }
  const fmt = v => { if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v); const s = Number(v.toPrecision(12)); return Math.abs(s) >= 1e15 || (Math.abs(s) < 1e-6 && s !== 0) ? s.toExponential(6).replace(/\.?0+e/, 'e') : String(s); };

  // ---------- 单位换算 ----------
  // 每一类以一个基准单位为 1；名字都用小写比较
  const UNITS = {
    length: { m: 1, 米: 1, mm: 0.001, 毫米: 0.001, cm: 0.01, 厘米: 0.01, km: 1000, 公里: 1000, 千米: 1000, in: 0.0254, 英寸: 0.0254, ft: 0.3048, 英尺: 0.3048, yd: 0.9144, 码: 0.9144, mi: 1609.344, 英里: 1609.344, 里: 500, 尺: 1 / 3 },
    mass: { kg: 1, 千克: 1, 公斤: 1, g: 0.001, 克: 0.001, mg: 1e-6, 毫克: 1e-6, t: 1000, 吨: 1000, lb: 0.45359237, 磅: 0.45359237, oz: 0.028349523125, 盎司: 0.028349523125, 斤: 0.5, 两: 0.05 },
    data: { b: 1, byte: 1, 字节: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4, pb: 1024 ** 5 },
    time: { s: 1, 秒: 1, ms: 0.001, 毫秒: 0.001, min: 60, 分钟: 60, 分: 60, h: 3600, 小时: 3600, d: 86400, 天: 86400, w: 604800, 周: 604800 },
    volume: { l: 1, 升: 1, ml: 0.001, 毫升: 0.001, gal: 3.785411784, 加仑: 3.785411784 },
    speed: { 'm/s': 1, 'km/h': 1 / 3.6, kmh: 1 / 3.6, 公里每小时: 1 / 3.6, mph: 0.44704, kn: 0.514444, knot: 0.514444, 节: 0.514444 }
  };
  const TEMP = { c: 'c', '℃': 'c', 摄氏: 'c', 摄氏度: 'c', f: 'f', '℉': 'f', 华氏: 'f', 华氏度: 'f', k: 'k', 开尔文: 'k' };
  const toC = (v, u) => (u === 'c' ? v : u === 'f' ? (v - 32) * 5 / 9 : v - 273.15);
  const fromC = (v, u) => (u === 'c' ? v : u === 'f' ? v * 9 / 5 + 32 : v + 273.15);
  function convert(input) {
    const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*([^\d\s][^\s]*?)(?:\s+(?:to|in)\s+|\s*(?:->|=>|→|=|转为|转换为|转|换成|换算成|兑)\s*)([^\d\s].*?)\s*$/i.exec(String(input || '').replace(/\s+/g, ' '));
    if (!m) return { ok: false, error: '格式如：5km to mi、100 f 转 c、3斤 换成 kg' };
    const value = Number(m[1]), a = m[2].toLowerCase(), b = m[3].toLowerCase();
    if (a in TEMP && b in TEMP) { const out = fromC(toC(value, TEMP[a]), TEMP[b]); return { ok: true, value: out, text: fmt(value) + ' ' + m[2] + ' = ' + fmt(Number(out.toFixed(6))) + ' ' + m[3] }; }
    for (const [kind, table] of Object.entries(UNITS)) {
      if (a in table && b in table) { const out = value * table[a] / table[b]; return { ok: true, kind, value: out, text: fmt(value) + ' ' + m[2] + ' = ' + fmt(out) + ' ' + m[3] }; }
    }
    const known = x => x in TEMP || Object.values(UNITS).some(t => x in t);
    return { ok: false, error: known(a) && known(b) ? '这两个单位不是同一类，换算不了' : '不认识的单位：' + (known(a) ? m[3] : m[2]) };
  }

  // ---------- 地址栏 ----------
  function toUrl(input, searchBase = 'https://www.bing.com/search?q=') {
    const text = String(input || '').trim();
    if (!text) return null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[a-z0-9.-]+:\d+(\/|$)/i.test(text)) {                // 有协议头：只放行 http(s)
      try { const u = new URL(text); return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null; } catch { return null; }
    }
    if (!/\s/.test(text) && /^(localhost|[a-z0-9-]+(\.[a-z0-9-]+)+|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#].*)?$/i.test(text)) {
      try { return new URL('https://' + text).href; } catch { return null; }
    }
    return searchBase + encodeURIComponent(text);
  }
  // ---------- 待办 / 便签：同步合并与整理 ----------
  // 数据形状：{ notes:[{id,title,body,pin,at,u}], todos:[{id,t,done,pri,due,remind,group,tags,sub,o,at,u}], snippets:[{id,t,u}], del:{id:删除时间}, u }
  // 合并规则（多台设备各改各的）：同一 id 取 u（最后修改时间）更大的；删除记在 del 里，删除时间 ≥ 条目的 u 就认为已删；del 记录保留 60 天。服务器上有一份同样的实现。
  const COLS = ['notes', 'todos', 'snippets', 'sessions', 'habits', 'checks'];
  function mergeSide(a, b, now = Date.now()) {
    a = a || {}; b = b || {};
    const del = {};
    for (const src of [a.del, b.del]) for (const [id, ts] of Object.entries(src || {})) if (ts > (del[id] || 0)) del[id] = ts;
    const out = { del: {}, u: Math.max(a.u || 0, b.u || 0) };
    for (const col of COLS) {
      const map = new Map();
      for (const item of [...(a[col] || []), ...(b[col] || [])]) { if (!item || !item.id) continue; const cur = map.get(item.id); if (!cur || (item.u || 0) > (cur.u || 0)) map.set(item.id, item); }
      out[col] = [...map.values()].filter(item => !(del[item.id] >= (item.u || 0)));
      out[col].sort(col === 'todos' || col === 'habits' ? (x, y) => (x.o || 0) - (y.o || 0) || (y.at || 0) - (x.at || 0) : (x, y) => (y.u || 0) - (x.u || 0));
    }
    const alive = new Set(out.habits.map(h => h.id));
    out.checks = out.checks.filter(c => alive.has(c.h));                      // 习惯被删了，它的打卡记录也跟着清掉
    for (const [id, ts] of Object.entries(del)) if (now - ts <= 60 * 864e5) out.del[id] = ts;      // 先用全部删除记录过滤，再把超过 60 天的记录从结果里丢掉
    return out;
  }
  // 待办输入里的 #标签："交报告 #工作 #紧急" → { t:"交报告", tags:["工作","紧急"] }（最多 5 个，每个 ≤ 20 字）
  function parseTodoText(input) {
    const tags = [];
    const t = String(input || '').replace(/(^|\s)#([^\s#]{1,20})/g, (m, sp, tag) => { if (tags.length < 5 && !tags.includes(tag)) tags.push(tag); return sp; }).replace(/\s+/g, ' ').trim();
    return { t: t || String(input || '').trim(), tags };
  }
  const overdue = (todo, today) => Boolean(!todo.done && todo.due && todo.due < today);
  // 日历：某个月的 6×7 格（默认周一开头，weekStart=0 则周日开头），上下月的日子用 inMonth=false 补齐。month0 从 0 开始，日期都用本地时区的 YYYY-MM-DD
  const ymd = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  function monthGrid(year, month0, weekStart = 1) {
    const first = new Date(year, month0, 1), offset = (first.getDay() - weekStart + 7) % 7, cells = [];
    for (let i = 0; i < 42; i++) { const d = new Date(year, month0, 1 - offset + i); cells.push({ date: ymd(d), day: d.getDate(), inMonth: d.getMonth() === month0 }); }
    return cells;
  }
  // 按日期汇总：当天到期的待办（未完成 / 已完成 / 是否已逢期）和当天完成的番茄（个数 / 分钟）
  function dayStats(todos, sessions, today) {
    const byDay = {};
    const at = day => (byDay[day] ||= { open: 0, done: 0, late: false, pom: 0, min: 0 });
    for (const t of todos || []) if (t.due) { const s = at(t.due); if (t.done) s.done++; else { s.open++; if (t.due < today) s.late = true; } }
    for (const s of sessions || []) if (s.day) { const d = at(s.day); d.pom++; d.min += s.min || 0; }
    return byDay;
  }
  // 筛选：status = all | open | done | today | overdue；group 空 = 不限；q 同时搜标题、标签、分组、子任务
  function filterTodos(list, { status = 'all', group = '', q = '' } = {}, today) {
    const needle = String(q || '').trim().toLowerCase();
    return list.filter(t => {
      if (status === 'open' && t.done) return false;
      if (status === 'done' && !t.done) return false;
      if (status === 'today' && (t.done || t.due !== today)) return false;
      if (status === 'overdue' && !overdue(t, today)) return false;
      if (group && (t.group || '') !== group) return false;
      if (needle && ![t.t, t.group, ...(t.tags || []), ...(t.sub || []).map(s => s.t)].some(x => String(x || '').toLowerCase().includes(needle))) return false;
      return true;
    });
  }
  // 排序：manual = 拖动顺序（o）；pri = 优先级高的在前；due = 截止日期近的在前（没有截止日期的排后）。已完成的永远排在最后
  function sortTodos(list, mode = 'manual') {
    const byO = (x, y) => (x.o || 0) - (y.o || 0), byPri = (x, y) => (y.pri || 0) - (x.pri || 0), byDue = (x, y) => (x.due || '9999') < (y.due || '9999') ? -1 : (x.due || '9999') > (y.due || '9999') ? 1 : 0;
    const cmp = mode === 'pri' ? (x, y) => byPri(x, y) || byDue(x, y) || byO(x, y) : mode === 'due' ? (x, y) => byDue(x, y) || byPri(x, y) || byO(x, y) : byO;
    return [...list].sort((x, y) => (x.done ? 1 : 0) - (y.done ? 1 : 0) || cmp(x, y));
  }
  // ---------- 习惯打卡 / 统计：纯函数（图表和连续天数都由它们算）----------
  // 习惯：{ id, name, icon, pom（每天完成这么多个番茄就自动算打卡，0 = 不关联）, days（长度 7，下标 = Date.getDay()，周日 = 0，false = 那天不打卡）, remind, o, u }
  // 打卡记录：{ id, h（习惯 id）, day, v（1 = 已打卡，0 = 取消）, u }——每天每个习惯一条，各自按 u 合并，所以两台设备分别打卡不会互相覆盖
  const parseDay = day => { const [y, m, d] = String(day).split('-').map(Number); return new Date(y, m - 1, d); };
  const scheduled = (mask, day) => !mask || mask[parseDay(day).getDay()] !== false;
  function lastDays(n, today) { const base = parseDay(today), out = []; for (let i = n - 1; i >= 0; i--) out.push(ymd(new Date(base.getFullYear(), base.getMonth(), base.getDate() - i))); return out; }
  function sessionsByDay(sessions, days) {
    const map = Object.fromEntries(days.map(day => [day, { day, pom: 0, min: 0 }]));
    for (const s of sessions || []) if (map[s.day]) { map[s.day].pom++; map[s.day].min += s.min || 0; }
    return days.map(day => map[day]);
  }
  function doneByDay(todos, days) {
    const map = Object.fromEntries(days.map(day => [day, 0]));
    for (const t of todos || []) if (t.done && t.da) { const day = ymd(new Date(t.da)); if (day in map) map[day]++; }
    return days.map(day => map[day]);
  }
  const habitDoneSet = (checks, habitId) => new Set((checks || []).filter(c => c.h === habitId && c.v === 1).map(c => c.day));
  function habitStreak(doneSet, mask, today) {
    const base = parseDay(today); let current = 0;
    for (let i = 0; i < 800; i++) {
      const day = ymd(new Date(base.getFullYear(), base.getMonth(), base.getDate() - i));
      if (!scheduled(mask, day)) continue;
      if (doneSet.has(day)) current++; else if (i === 0) continue; else break;      // 今天还没打卡不算断
    }
    let best = 0, run = 0;
    if (doneSet.size) {
      const first = parseDay([...doneSet].sort()[0]);
      for (const t = new Date(first); ymd(t) <= today; t.setDate(t.getDate() + 1)) { const day = ymd(t); if (!scheduled(mask, day)) continue; if (doneSet.has(day)) { run++; if (run > best) best = run; } else run = 0; }
    }
    return { current, best: Math.max(best, current) };
  }
  function habitRate(doneSet, mask, days) { let due = 0, done = 0; for (const day of days) if (scheduled(mask, day)) { due++; if (doneSet.has(day)) done++; } return { done, due, rate: due ? done / due : 0 }; }
  // 某天所有“当天该打卡”的习惯里完成了多少（热力图用）；sets = { 习惯 id: Set }
  function dayRatio(habits, sets, day) { let due = 0, done = 0; for (const h of habits) if (scheduled(h.days, day)) { due++; if (sets[h.id] && sets[h.id].has(day)) done++; } return { due, done, ratio: due ? done / due : 0 }; }
  // 最近几天每件待办花了多少分钟的番茄（前 6 名）
  function topTasks(sessions, todos, days) {
    const set = new Set(days), agg = new Map();
    for (const s of sessions || []) if (set.has(s.day)) { const row = agg.get(s.todo || '') || { id: s.todo || '', min: 0, pom: 0 }; row.min += s.min || 0; row.pom++; agg.set(s.todo || '', row); }
    return [...agg.values()].sort((a, b) => b.min - a.min).slice(0, 6).map(row => ({ ...row, title: row.id ? ((todos || []).find(t => t.id === row.id) || {}).t || '（已删除的待办）' : '未指定任务' }));
  }
  // 搜索高亮：把 text 按 q（忽略大小写）切成 [{ t, hit }]，前端用文本节点 + <mark> 拼出来（不用 innerHTML，所以不会有 XSS）。最多标 500 处，避免巨大文件拖垮页面
  function splitMatches(text, q, limit = 500) {
    const s = String(text ?? ''), needle = String(q ?? '').trim();
    if (!needle) return [{ t: s, hit: false }];
    const lowerS = s.toLowerCase(), lowerN = needle.toLowerCase();
    const same = lowerS.length === s.length && lowerN.length === needle.length;           // 个别字符转小写会变长，那就退回区分大小写，保证下标对得上
    const hay = same ? lowerS : s, key = same ? lowerN : needle, parts = [];
    let at = 0, count = 0;
    while (count < limit) {
      const found = hay.indexOf(key, at);
      if (found < 0) break;
      if (found > at) parts.push({ t: s.slice(at, found), hit: false });
      parts.push({ t: s.slice(found, found + key.length), hit: true }); at = found + key.length; count++;
    }
    if (at < s.length) parts.push({ t: s.slice(at), hit: false });
    return parts.length ? parts : [{ t: s, hit: false }];
  }
  return { calc, convert, toUrl, mergeSide, splitMatches, parseTodoText, filterTodos, sortTodos, overdue, monthGrid, dayStats, ymd, lastDays, sessionsByDay, doneByDay, habitDoneSet, habitStreak, habitRate, dayRatio, topTasks, scheduled };
});
