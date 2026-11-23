import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 一键更新靠这个正则从发布页的附件里找服务端安装包；曾经因为反斜杠丢失（变成 Yumeiro-d+.d+...）导致按钮永远不出现
test('一键更新识别安装包文件名的正则正确', () => {
  const src = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  const m = src.match(/const asset=\(Array\.isArray\(release\.assets\).*?\.find\(a=>(\/\^Yumeiro-.*?\$\/)\.test/);
  assert.ok(m, '找不到安装包匹配代码');
  const re = new RegExp(m[1].slice(1, m[1].lastIndexOf('/')));
  assert.ok(re.test('Yumeiro-0.45.18.zip'));
  assert.ok(!re.test('Yumeiro-0.45.18-with-clients.zip'));
  assert.ok(!re.test('Yumeiro-0.45.18-SHA256.txt'));
  assert.ok(!re.test('Yumeiro-dd.d.d.zip'));
});

// 版本列表里区分“服务端包”和“含客户端的包”
test('版本列表的包名规则：服务端包和含客户端的包互不混淆', () => {
  const src = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  const m = src.match(/const re=withClients\?(\/.*?\/):(\/.*?\/);/);
  assert.ok(m, '找不到版本列表的包名规则');
  const mk = s => new RegExp(s.slice(1, s.lastIndexOf('/')));
  const clients = mk(m[1]), server = mk(m[2]);
  assert.ok(server.test('Yumeiro-0.45.20.zip') && !server.test('Yumeiro-0.45.20-with-clients.zip') && !server.test('Yumeiro-0.45.20-SHA256.txt'));
  assert.ok(clients.test('Yumeiro-0.45.20-with-clients.zip') && !clients.test('Yumeiro-0.45.20.zip'));
});
