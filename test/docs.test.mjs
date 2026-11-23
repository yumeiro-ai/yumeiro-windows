import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { docKind, docText, docsPrompt, DOC_LIMITS, TEXT_EXTS } from '../docs.mjs';

const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');

test('文件附件：只收白名单扩展名的合法 UTF-8 文本，拒绝二进制 / 超大 / 空文件', () => {
  assert.equal(docKind('notes.TXT', Buffer.from('你好')).ext, 'txt');
  assert.equal(docKind('src/main.py', Buffer.from('print(1)')).ext, 'py');
  assert.equal(docKind('Dockerfile', Buffer.from('FROM node')).ext, 'dockerfile');
  assert.equal(docKind('a.pdf', Buffer.from('%PDF')), null);
  assert.equal(docKind('a.exe', Buffer.from('MZ')), null);
  assert.equal(docKind('noext', Buffer.from('x')), null);
  assert.equal(docKind('a.txt', Buffer.from([0x61, 0x00, 0x62])), null);
  assert.equal(docKind('a.txt', Buffer.from([0xff, 0xfe, 0xfd])), null);
  assert.equal(docKind('a.txt', Buffer.alloc(0)), null);
  assert.equal(docKind('a.txt', Buffer.alloc(DOC_LIMITS.maxBytes + 1, 97)), null);
  assert.ok(TEXT_EXTS.has('md') && TEXT_EXTS.has('csv') && !TEXT_EXTS.has('docx') && !TEXT_EXTS.has('pdf'));
});

test('文件附件：去掉 BOM、过长截断并说明、围栏遇到 ``` 自动加长、总长度有上限', () => {
  assert.equal(docText(Buffer.from('\uFEFFabc')), 'abc');
  const long = docText(Buffer.from('x'.repeat(100)), 10); assert.ok(long.startsWith('x'.repeat(10)) && long.includes('已省略'));
  const prompt = docsPrompt('看看', [{ name: 'a.md', text: '```js\n1\n```' }]);
  assert.ok(prompt.startsWith('看看\n\n【附件：a.md】\n````\n')); assert.ok(prompt.trimEnd().endsWith('````'));
  const capped = docsPrompt('', [{ name: 'a', text: 'a'.repeat(30) }, { name: 'b', text: 'b'.repeat(30) }], 40);
  assert.ok(capped.includes('b'.repeat(10)) && !capped.includes('b'.repeat(11)));
  assert.ok(docsPrompt('', [{ name: 'a', text: 'a'.repeat(50) }, { name: 'late', text: 'z' }], 40).includes('这个文件的内容已省略'));
});

test('聊天框按钮：回形针图标（不再用 🖼），能选图片和文本文件；语言下拉更窄', () => {
  const vision = read('public/vision.js'), voice = read('public/voice.js'), team = read('public/team.js');
  assert.ok(!vision.includes('🖼') && !team.includes('🖼'));
  assert.ok(vision.includes('m21.44 11.05-9.19 9.19'), '回形针 SVG');
  for (const s of ['添加图片或文件', "'.' + ext", 'isImage', 'maxFiles', 'vis-filetag', 'doc: true']) assert.ok(vision.includes(s), s);
  assert.match(voice, /\.voice-lang\{width:88px;max-width:88px/);
  assert.match(voice, /@media\(max-width:640px\)\{\.voice-lang\{width:74px/);
});

test('文件附件已接入部署清单和服务器', () => {
  const server = read('server.mjs'), docker = read('Dockerfile'), native = read('deploy/yumeiro-native.sh');
  assert.ok(docker.includes('docs.mjs') && native.includes('docs.mjs'));
  assert.ok(docker.includes('docparse.mjs') && native.includes('docparse.mjs') && read('package.json').includes('"unpdf"'));
  for (const s of ["from './docs.mjs'", "from './docparse.mjs'", 'parseDocument(rawName,data', 'imageAtts', 'docAtts', 'async function withDocs']) assert.ok(server.includes(s), s);
});

test('手机 / 安卓 App：回形针先选“图片或文件”，文件不限扩展名；附件在页面内查看，不再 window.open 到外部浏览器', () => {
  const vision = read('public/vision.js');
  for (const s of ["pointer:coarse", 'Android|iPhone|iPad|iPod', "pick('image/*')", "pick('')", 'vis-menu', 'function viewText', 'const lightbox', 'vis-modal', 'originalFetch(item.src']) assert.ok(vision.includes(s), s);
  assert.ok(!vision.includes('window.open'), '安卓外壳里 window.open 会跳到没有登录状态的外部浏览器');
  assert.ok(!vision.includes("target: '_blank'"));
  const apk = read('clients/android/capacitor.config.json');
  assert.ok(apk.includes('"allowNavigation"'), '安卓外壳加载服务器网页，附件功能随网页版自动生效');
});
