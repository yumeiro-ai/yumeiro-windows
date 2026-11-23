// 自定义下拉菜单：把页面里所有原生 <select> 换成统一风格的菜单（跟随深浅色主题）。
// 原来的 <select> 还在（只是隐藏），value / change 事件 / 表单读取都照旧，所以其他脚本不用改。
// 不想被替换的 <select> 加上 data-native 属性即可。
(function () {
  if (window.__ymSelect) return; window.__ymSelect = true;
  var current = null;           // 正在展开的那个
  var proto = HTMLSelectElement.prototype;

  // 脚本里直接改 select.value / selectedIndex 时，自定义按钮上的文字也要跟着变
  ['value', 'selectedIndex'].forEach(function (name) {
    var d = Object.getOwnPropertyDescriptor(proto, name); if (!d || !d.set) return;
    Object.defineProperty(proto, name, { configurable: true, enumerable: d.enumerable, get: d.get, set: function (v) { d.set.call(this, v); if (this._ymSync) this._ymSync(); } });
  });

  function close() {
    if (!current) return; var c = current; current = null;
    c.menu.remove(); c.btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', onOutside, true); window.removeEventListener('resize', close);
    window.removeEventListener('scroll', onScroll, true); document.removeEventListener('keydown', onKey, true);
  }
  function onOutside(e) { if (current && !current.menu.contains(e.target) && !current.btn.contains(e.target)) close(); }
  function onScroll(e) { if (current && !current.menu.contains(e.target)) close(); }
  function items() { return current ? Array.prototype.slice.call(current.menu.querySelectorAll('[role=option]:not([aria-disabled=true])')) : []; }
  function focusItem(el) { if (!el) return; items().forEach(function (i) { i.classList.remove('hot'); }); el.classList.add('hot'); el.scrollIntoView({ block: 'nearest' }); }
  function pick(sel, option) {
    if (!option || option.disabled) return;
    var changed = sel.value !== option.value; sel.value = option.value;
    if (changed) { sel.dispatchEvent(new Event('input', { bubbles: true })); sel.dispatchEvent(new Event('change', { bubbles: true })); }
  }
  var typed = '', typedAt = 0;
  function onKey(e) {
    if (!current) return; var list = items(), hot = current.menu.querySelector('.hot'), i = list.indexOf(hot);
    if (e.key === 'Escape') { e.preventDefault(); var b = current.btn; close(); b.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); focusItem(list[Math.min(list.length - 1, i + 1)]); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusItem(list[Math.max(0, i - 1)]); }
    else if (e.key === 'Home') { e.preventDefault(); focusItem(list[0]); }
    else if (e.key === 'End') { e.preventDefault(); focusItem(list[list.length - 1]); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (hot) { var s = current.sel, b2 = current.btn; pick(s, s.options[Number(hot.dataset.index)]); close(); b2.focus(); } }
    else if (e.key === 'Tab') close();
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      var now = Date.now(); typed = (now - typedAt > 700 ? '' : typed) + e.key.toLowerCase(); typedAt = now;
      var hit = list.find(function (el) { return el.textContent.toLowerCase().indexOf(typed) === 0; }); if (hit) focusItem(hit);
    }
  }

  function open(sel, btn) {
    if (current && current.sel === sel) return close(); close();
    var menu = document.createElement('div'); menu.className = 'ymsel-menu'; menu.setAttribute('role', 'listbox');
    var group = null;
    Array.prototype.forEach.call(sel.children, function (child) {
      var opts = child.tagName === 'OPTGROUP' ? Array.prototype.slice.call(child.children) : [child];
      if (child.tagName === 'OPTGROUP') { var g = document.createElement('div'); g.className = 'ymsel-group'; g.textContent = child.label; menu.append(g); }
      opts.forEach(function (o) {
        if (o.tagName !== 'OPTION') return;
        var item = document.createElement('div'); item.className = 'ymsel-item' + (o.selected ? ' sel' : ''); item.setAttribute('role', 'option');
        item.dataset.index = String(o.index); item.setAttribute('aria-selected', o.selected ? 'true' : 'false');
        if (o.disabled || child.disabled) item.setAttribute('aria-disabled', 'true');
        var text = document.createElement('span'); text.textContent = o.text || ' '; item.append(text);
        if (o.selected) { var tick = document.createElement('i'); tick.textContent = '✓'; item.append(tick); }
        item.addEventListener('mousemove', function () { focusItem(item); });
        item.addEventListener('click', function (e) { e.preventDefault(); if (item.getAttribute('aria-disabled') === 'true') return; var b = btn; pick(sel, o); close(); b.focus(); });
        menu.append(item);
      });
    });
    document.body.append(menu);
    var r = btn.getBoundingClientRect(), vh = window.innerHeight, below = vh - r.bottom - 8, above = r.top - 8;
    var maxH = Math.max(120, Math.min(300, below >= 180 || below >= above ? below : above));
    menu.style.maxHeight = maxH + 'px'; menu.style.minWidth = r.width + 'px'; menu.style.maxWidth = Math.min(window.innerWidth - 16, Math.max(r.width, 420)) + 'px';
    var mh = Math.min(menu.scrollHeight, maxH);
    menu.style.top = (below >= mh || below >= above ? r.bottom + 4 : r.top - mh - 4) + 'px';
    menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
    btn.setAttribute('aria-expanded', 'true'); current = { sel: sel, btn: btn, menu: menu };
    document.addEventListener('mousedown', onOutside, true); window.addEventListener('resize', close);
    window.addEventListener('scroll', onScroll, true); document.addEventListener('keydown', onKey, true);
    var cur = menu.querySelector('.sel') || menu.querySelector('[role=option]'); focusItem(cur);
  }

  function enhance(sel) {
    if (sel._ym || sel.multiple || sel.size > 1 || sel.hasAttribute('data-native')) return;
    sel._ym = true;
    var cs = getComputedStyle(sel);
    var wrap = document.createElement('span'); wrap.className = 'ymsel';
    // 宽度：原来的 select 是“撑满一行”的就撑满；否则跟着内容走（不能照抄当时的像素宽度——选项还没加载时它只有几十像素，文字会被挤没）
    var parent = sel.parentElement, fill = cs.display === 'block' && parent && sel.offsetWidth >= parent.clientWidth * 0.9 && sel.offsetWidth > 120;
    if (fill) { wrap.style.display = 'block'; wrap.style.width = '100%'; }
    ['flex', 'margin', 'alignSelf', 'gridColumn', 'maxWidth', 'minWidth'].forEach(function (k) { var v = cs[k]; if (v && v !== 'none' && v !== 'auto' && v !== '0px' && v !== 'normal') wrap.style[k] = v; });
    var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'ymsel-btn'; btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false');
    var text = document.createElement('span'); text.className = 'ymsel-text'; var caret = document.createElement('span'); caret.className = 'ymsel-caret'; caret.setAttribute('aria-hidden', 'true'); caret.textContent = '▾';
    btn.append(text, caret); wrap.append(btn);
    var label = sel.getAttribute('aria-label') || (sel.labels && sel.labels[0] && sel.labels[0].textContent.trim().slice(0, 40)) || sel.title; if (label) btn.setAttribute('aria-label', label);
    sel.after(wrap); sel.classList.add('ymsel-native'); sel.setAttribute('aria-hidden', 'true'); sel.tabIndex = -1;
    wrap._sel = sel;
    var sync = function () { var o = sel.options[sel.selectedIndex]; text.textContent = o ? (o.getAttribute('data-short') || o.text) : ''; text.classList.toggle('ph', !o || !o.value); btn.disabled = sel.disabled; wrap.classList.toggle('off', sel.disabled); };
    sel._ymSync = sync; sync();
    btn.addEventListener('click', function () { open(sel, btn); });
    btn.addEventListener('keydown', function (e) { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(sel, btn); } });
    new MutationObserver(sync).observe(sel, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'selected', 'label'] });
    sel.addEventListener('change', sync);
  }

  function scan(root) {
    if (root.nodeType !== 1 && root.nodeType !== 9) return;
    if (root.tagName === 'SELECT') enhance(root);
    var list = root.querySelectorAll ? root.querySelectorAll('select') : []; for (var i = 0; i < list.length; i++) enhance(list[i]);
  }
  function sweep() { document.querySelectorAll('.ymsel').forEach(function (w) { if (!w._sel || !w._sel.isConnected) { if (current && current.sel === w._sel) close(); w.remove(); } }); }
  function start() {
    scan(document);
    new MutationObserver(function (list) { var removed = false; list.forEach(function (m) { m.addedNodes.forEach(scan); if (m.removedNodes.length) removed = true; }); if (removed) sweep(); }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
