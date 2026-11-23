import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 从 team.js 里取出 renderMarkdown，放到一个最小的假 DOM 里跑，检查表格、列表、摘要卡的解析
const source = readFileSync(new URL('../public/team.js', import.meta.url), 'utf8');
const start = source.indexOf('function renderMarkdown(text) {'), end = source.indexOf('function showContent(');
assert.ok(start > 0 && end > start);
const make = tag => ({ tag, children: [], className: '', style: {}, textContent: '', append(...n) { this.children.push(...n); }, get length() { return this.children.length; } });
const document = { createElement: make, createTextNode: text => ({ tag: '#text', text }) };
const render = new Function('document', source.slice(start, end).replace(/\r/g, '') + '\nreturn renderMarkdown;')(document);
const walk = (n, out = []) => { out.push(n); for (const c of n.children || []) walk(c, out); return out; };
const textOf = n => n.tag === '#text' ? n.text : (n.textContent || '') + (n.children || []).map(textOf).join('');

test('Markdown 整理：表格变成真正的表格（含对齐和行内格式），而不是一整段文字', () => {
  const md = '| 规范类别 | 规则说明 | 示例 |\n|:---------|:--------:|-----:|\n| 命名约定 | 变量用 **camelCase** | `userName` |\n| 格式化 | 4 空格缩进 | - |\n\n后面的段落';
  const root = render(md), nodes = walk(root);
  const table = nodes.find(n => n.tag === 'table');
  assert.ok(table, '应该生成 table');
  const rows = nodes.filter(n => n.tag === 'tr');
  assert.equal(rows.length, 3, '表头 1 行 + 数据 2 行');
  assert.deepEqual(rows[0].children.map(textOf), ['规范类别', '规则说明', '示例']);
  assert.equal(rows[0].children[1].style.textAlign, 'center'); assert.equal(rows[0].children[2].style.textAlign, 'right');
  assert.ok(nodes.some(n => n.tag === 'strong' && n.textContent === 'camelCase'));
  assert.ok(nodes.some(n => n.tag === 'code' && n.textContent === 'userName'));
  assert.equal(textOf(root).includes('|:--'), false, '分隔行不应该出现在页面上');
  assert.ok(nodes.some(n => n.tag === 'p' && textOf(n) === '后面的段落'), '表格后面的段落照常显示');
});

test('Markdown 整理：摘要卡、标题、列表、代码块', () => {
  const md = '---\nname: 代码审查规范\ndescription: 按固定顺序检查\n---\n# 核心能力\n1. 第一\n2. 第二\n- 要点\n\n```\ngrep -r x\n```';
  const nodes = walk(render(md));
  assert.ok(nodes.some(n => n.className === 'mk-md-name' && n.textContent === '代码审查规范'));
  assert.ok(nodes.some(n => n.className === 'mk-md-desc' && n.textContent === '按固定顺序检查'));
  assert.ok(nodes.some(n => n.tag === 'h4' && n.className === 'mk-md-h1'));
  assert.equal(nodes.filter(n => n.tag === 'ol').length, 1); assert.equal(nodes.filter(n => n.tag === 'ul').length, 1);
  assert.equal(nodes.find(n => n.tag === 'pre').textContent, 'grep -r x');
  assert.ok(!nodes.some(n => n.tag === 'script'), '不生成任何可执行节点');
});
