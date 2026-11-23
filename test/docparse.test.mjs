import test from 'node:test';
import assert from 'node:assert/strict';
import { createZip } from '../ziputil.mjs';
import { zip, docxFixture, xlsxFixture, pptxFixture, odtFixture, epubFixture, pdfFixture } from './doc-fixtures.mjs';
import { parseDocument, extOf, PARSE_EXTS } from '../docparse.mjs';

test('Word（docx）：正文、制表 / 换行、表格；域代码和被删除的修订不进正文', async () => {
  const { text, format } = await parseDocument('报告.docx', docxFixture());
  assert.equal(format, 'docx');
  assert.match(text, /第一段：你好 & 世界/);
  assert.match(text, /带\t制表\n换行/);
  assert.ok(!text.includes('PAGE') && !text.includes('被删除的字'));
  assert.match(text, /姓名\t年龄\n小明\t18/);
});

test('Excel（xlsx）：按工作表输出，共享字符串 / 内联字符串 / 布尔 / 数字，空列补位，空表跳过', async () => {
  const { text } = await parseDocument('销售.xlsx', xlsxFixture());
  assert.match(text, /^## 工作表：销售\n产品\t数量\t\t备注\n苹果 & 梨\t42\tTRUE$/);
  assert.ok(!text.includes('空表') && !text.includes('ignored'));
});

test('PowerPoint（pptx）：按页码数字排序（10 在 2 后面），带备注', async () => {
  const { text } = await parseDocument('讲稿.pptx', pptxFixture());
  assert.ok(text.indexOf('封面') < text.indexOf('标题二') && text.indexOf('标题二') < text.indexOf('第十页'));
  assert.match(text, /## 幻灯片 2\n标题二\n要点\n（备注）讲稿备注/);
});

test('OpenDocument 与 EPUB：段落 / 表格 / 按阅读顺序，去掉 script 和 style', async () => {
  const odt = (await parseDocument('a.odt', odtFixture())).text;
  assert.match(odt, /标题\n正文\t一 二/); assert.match(odt, /甲\t乙/);
  const epub = (await parseDocument('书.epub', epubFixture())).text;
  assert.ok(epub.indexOf('先读这里') < epub.indexOf('后面的内容'), '按 spine 顺序而不是文件名顺序');
  assert.ok(!epub.includes('alert') && !epub.includes('color:red'));
});

test('RTF：段落、中文（十六进制 / unicode 转义）、忽略字体表', async () => {
  const rtf = '{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}\\f0 Hello\\par \\u20013?\\u25991? and \\\'c4\\\'e3\\\'ba\\\'c3\\tab end}';
  const { text } = await parseDocument('a.rtf', Buffer.from(rtf, 'latin1'));
  assert.ok(text.startsWith('Hello\n中文 and 你好\tend'), JSON.stringify(text));
  assert.ok(!text.includes('Arial'));
});

test('PDF：提取文字；扫描件 / 损坏 / 伪装的 PDF 给出明确提示', async () => {
  const { text } = await parseDocument('a.pdf', pdfFixture(['Hello PDF world', 'Second line']));
  assert.equal(text, 'Hello PDF world\nSecond line');
  await assert.rejects(() => parseDocument('a.pdf', pdfFixture([''])), /没有可提取的文字/);
  await assert.rejects(() => parseDocument('a.pdf', Buffer.from('not a pdf at all')), /不是有效的 PDF/);
  await assert.rejects(() => parseDocument('a.pdf', Buffer.from('%PDF-1.4 broken')), /无法解析/);
});

test('文本文件：UTF-8 优先，中文 GBK 的 csv 也能读，二进制 / 乱码拒绝', async () => {
  assert.equal((await parseDocument('a.csv', Buffer.from('\uFEFF列1,列2\n1,2', 'utf8'))).text, '列1,列2\n1,2');
  const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x2c, 0xca, 0xc0, 0xbd, 0xe7]); // “你好,世界” 的 GBK 编码
  assert.equal((await parseDocument('a.csv', gbk)).text, '你好,世界');
  await assert.rejects(() => parseDocument('a.txt', Buffer.from([0x61, 0x00, 0x62])), /二进制/);
  await assert.rejects(() => parseDocument('a.txt', Buffer.from([0xff, 0xfe, 0xfd, 0xfc])), /编码/);
});

test('不支持 / 超限 / 损坏：旧版 Office 提示另存为新格式，其它扩展名返回 null，zip 炸弹和加密包不崩', async () => {
  assert.equal(await parseDocument('a.exe', Buffer.from('MZ')), null);
  assert.equal(await parseDocument('noext', Buffer.from('x')), null);
  await assert.rejects(() => parseDocument('old.doc', Buffer.from('x')), /另存为 \.docx/);
  await assert.rejects(() => parseDocument('old.xls', Buffer.from('x')), /另存为 \.xlsx/);
  await assert.rejects(() => parseDocument('a.docx', Buffer.from('这不是 zip 文件，只是普通文字')), /无法打开这个文件/);
  await assert.rejects(() => parseDocument('a.docx', zip({ 'word/styles.xml': '<x/>' })), /没有找到正文/);
  await assert.rejects(() => parseDocument('a.xlsx', zip({ 'xl/other.xml': '<x/>' })), /没有找到工作簿/);
  await assert.rejects(() => parseDocument('a.txt', Buffer.alloc(0)), /空的/);
  await assert.rejects(() => parseDocument('a.txt', Buffer.alloc(2048, 97), { maxBytes: 1024 }), /文件太大/);
  const bomb = createZip([{ name: 'word/document.xml', data: Buffer.alloc(60 * 1048576, 97) }]); // 压缩后很小，解压后超过单个文件 40MB 上限
  await assert.rejects(() => parseDocument('bomb.docx', bomb, { maxBytes: 20 * 1048576 }), /没有找到正文/);
});

test('扩展名工具与支持列表', () => {
  assert.equal(extOf('C:\\Users\\a\\报告.最终版.DOCX'), 'docx'); assert.equal(extOf('Dockerfile'), 'dockerfile');
  for (const ext of ['pdf', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'epub', 'rtf']) assert.ok(PARSE_EXTS.has(ext), ext);
});
