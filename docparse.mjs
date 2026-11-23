// 聊天上传文件的文字提取：PDF、Word（docx）、Excel（xlsx）、PowerPoint（pptx）、OpenDocument（odt/ods/odp）、EPUB、RTF，以及各种文本 / 代码文件。
// 除了 PDF 用 unpdf（pdf.js 的精简版）之外都是自己解析的（这些格式本质是 zip + XML），没有别的依赖。
// 旧版 Office 二进制格式（.doc / .xls / .ppt）不解析，会提示另存为新格式。
import { readZip } from './ziputil.mjs';
import { TEXT_EXTS, DOC_LIMITS } from './docs.mjs';

const TAB = String.fromCharCode(9), NL = String.fromCharCode(10), BS = String.fromCharCode(92);
export const STORE_MAX_CHARS = 3000000;            // 提取出来的文字最多保存这么多（再长的只留开头）
const ZIP_LIMITS = { maxFiles: 4000, maxEntryBytes: 40 * 1048576, maxTotalBytes: 150 * 1048576 };

export const OFFICE_EXTS = ['docx', 'xlsx', 'xlsm', 'pptx', 'odt', 'ods', 'odp', 'epub'];
export const PARSE_EXTS = new Set([...OFFICE_EXTS, 'pdf', 'rtf']);
export const LEGACY_EXTS = new Set(['doc', 'xls', 'ppt']);
export const ALL_DOC_EXTS = [...TEXT_EXTS, ...PARSE_EXTS, ...LEGACY_EXTS];

const fail = message => Object.assign(new Error(message), { userFacing: true });
export const extOf = name => {
  const base = String(name || '').split('/').pop().split(BS).pop().toLowerCase();
  if (base === 'dockerfile' || base === 'makefile') return base;
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1) : '';
};

// ---- XML 小工具 ----
const ENTITY = /&(amp|lt|gt|quot|apos|nbsp|#[0-9]+|#x[0-9a-fA-F]+);/g;
const decodeEntities = text => text.replace(ENTITY, (all, name) => {
  if (name === 'amp') return '&'; if (name === 'lt') return '<'; if (name === 'gt') return '>'; if (name === 'quot') return '"'; if (name === 'apos') return "'"; if (name === 'nbsp') return ' ';
  const code = name[1] === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
  try { return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ''; } catch { return ''; }
});
const stripTags = xml => decodeEntities(xml.replace(/<[^>]*>/g, ''));
const replaceAll = (text, from, to) => text.split(from).join(to);
const tidy = text => {
  const lines = text.split(NL).map(line => line.replace(new RegExp('[ ' + TAB + ']+$'), '')), out = []; let blank = 0;
  for (const line of lines) { if (line.trim() === '') { if (++blank <= 1) out.push(''); } else { blank = 0; out.push(line); } }
  return out.join(NL).trim();
};
const zipText = (files, name) => { const entry = files.get(name); return entry ? entry.toString('utf8') : ''; };

// ---- Word ----
export function docxText(files) {
  let xml = zipText(files, 'word/document.xml');
  if (!xml) throw fail('这个 docx 里没有找到正文（word/document.xml）');
  xml = xml.replace(/<w:(instrText|delText)[^>]*>[^<]*<[/]w:(instrText|delText)>/g, '').replace(/<w:tab[ ]*[/]>/g, TAB).replace(/<w:(br|cr)[^>]*[/]>/g, NL);
  // 表格单元格里的段落不换行，整行用制表符分隔、行尾才换行
  xml = xml.replace(/<w:tc[ >][^]*?<[/]w:tc>/g, cell => replaceAll(cell, '</w:p>', ' '));
  xml = replaceAll(replaceAll(replaceAll(xml, '</w:p>', NL), '</w:tc>', TAB), '</w:tr>', NL);
  return tidy(replaceAll(stripTags(xml), ' ' + TAB, TAB));
}

// ---- Excel ----
const columnIndex = ref => { let n = 0; for (const ch of ref) { const c = ch.charCodeAt(0); if (c >= 65 && c <= 90) n = n * 26 + (c - 64); else if (c >= 97 && c <= 122) n = n * 26 + (c - 96); else break; } return Math.max(0, n - 1); };
const attr = (tag, name) => { const m = new RegExp('(?:^|[ ])' + name + '="([^"]*)"').exec(tag); return m ? decodeEntities(m[1]) : ''; };
export function xlsxText(files, { maxRows = 20000, maxCols = 200 } = {}) {
  const workbook = zipText(files, 'xl/workbook.xml');
  if (!workbook) throw fail('这个 xlsx 里没有找到工作簿（xl/workbook.xml）');
  const shared = [];
  for (const m of zipText(files, 'xl/sharedStrings.xml').matchAll(/<si[ >][^]*?<[/]si>/g)) shared.push(stripTags(m[0].replace(/<rPh[^]*?<[/]rPh>/g, '')));
  const rels = new Map();
  for (const m of zipText(files, 'xl/_rels/workbook.xml.rels').matchAll(/<Relationship [^>]*>/g)) rels.set(attr(m[0], 'Id'), attr(m[0], 'Target'));
  const sheets = [];
  for (const m of workbook.matchAll(/<sheet [^>]*>/g)) {
    const target = rels.get(attr(m[0], 'r:id')) || '';
    const file = target.startsWith('/') ? target.slice(1) : 'xl/' + target;
    sheets.push({ name: attr(m[0], 'name') || '工作表', file });
  }
  if (!sheets.length) throw fail('这个 xlsx 里没有工作表');
  const out = [];
  for (const sheet of sheets) {
    const xml = zipText(files, sheet.file);
    if (!xml) continue;
    const rows = [];
    for (const rowMatch of xml.matchAll(/<row[ >][^]*?<[/]row>/g)) {
      if (rows.length >= maxRows) { rows.push(['…（行数太多，后面的已省略）']); break; }
      const cells = [];
      for (const c of rowMatch[0].matchAll(/<c ([^>]*?)(?:[/]>|>([^]*?)<[/]c>)/g)) {
        const head = c[1], body = c[2] || '', col = columnIndex(attr(head, 'r'));
        if (col >= maxCols) continue;
        const type = attr(head, 't'), v = (/<v>([^<]*)<[/]v>/.exec(body) || [])[1];
        let value = '';
        if (type === 's') value = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') value = stripTags(body);
        else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
        else if (v !== undefined) value = decodeEntities(v);
        cells[col] = value.split(NL).join(' ').split(TAB).join(' ');
      }
      let last = cells.length - 1; while (last >= 0 && !cells[last]) last--;
      if (last >= 0) rows.push(Array.from({ length: last + 1 }, (_, i) => cells[i] ?? ''));
    }
    if (rows.length) out.push('## 工作表：' + sheet.name + NL + rows.map(r => r.join(TAB)).join(NL));
  }
  return out.join(NL + NL);
}

// ---- PowerPoint ----
export function pptxText(files) {
  const number = name => parseInt(name.replace(/[^0-9]/g, ''), 10) || 0;
  const slides = [...files.keys()].filter(n => n.startsWith('ppt/slides/slide') && n.endsWith('.xml')).sort((a, b) => number(a) - number(b));
  if (!slides.length) throw fail('这个 pptx 里没有找到幻灯片');
  const out = [];
  slides.forEach((name, index) => {
    const body = tidy(stripTags(replaceAll(zipText(files, name), '</a:p>', NL)));
    const notesName = 'ppt/notesSlides/notesSlide' + number(name) + '.xml';
    const notes = files.has(notesName) ? tidy(stripTags(replaceAll(zipText(files, notesName), '</a:p>', NL))) : '';
    out.push('## 幻灯片 ' + (index + 1) + NL + body + (notes ? NL + '（备注）' + notes : ''));
  });
  return out.join(NL + NL);
}

// ---- OpenDocument（odt / ods / odp）----
export function odfText(files) {
  let xml = zipText(files, 'content.xml');
  if (!xml) throw fail('这个文件里没有找到内容（content.xml）');
  xml = xml.replace(/<text:tab[ ]*[/]>/g, TAB).replace(/<text:line-break[ ]*[/]>/g, NL).replace(/<text:s[^>]*[/]>/g, ' ');
  xml = xml.replace(/<table:table-cell[ >][^]*?<[/]table:table-cell>/g, cell => replaceAll(cell, '</text:p>', ' '));
  for (const tag of ['</text:p>', '</text:h>', '</table:table-row>', '</draw:page>']) xml = replaceAll(xml, tag, NL);
  xml = replaceAll(xml, '</table:table-cell>', TAB);
  return tidy(replaceAll(stripTags(xml), ' ' + TAB, TAB));
}

// ---- EPUB ----
export function epubText(files) {
  const xhtml = name => /[.](x?html?)$/i.test(name) && !name.startsWith('META-INF/');
  let order = [];
  try {
    const container = zipText(files, 'META-INF/container.xml'), opfPath = attr((/<rootfile [^>]*>/.exec(container) || [''])[0], 'full-path');
    const opf = zipText(files, opfPath), dir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
    const manifest = new Map();
    for (const m of opf.matchAll(/<item [^>]*>/g)) manifest.set(attr(m[0], 'id'), attr(m[0], 'href'));
    for (const m of opf.matchAll(/<itemref [^>]*>/g)) { const href = manifest.get(attr(m[0], 'idref')); if (href) order.push(dir + decodeURIComponent(href.split('#')[0])); }
  } catch { order = []; }
  order = order.filter(name => files.has(name) && xhtml(name));
  if (!order.length) order = [...files.keys()].filter(xhtml).sort();
  const out = [];
  for (const name of order) {
    let html = zipText(files, name).replace(/<(script|style)[^]*?<[/](script|style)>/gi, '');
    for (const tag of ['</p>', '</div>', '</h1>', '</h2>', '</h3>', '</h4>', '</h5>', '</h6>', '</li>', '</tr>', '<br>', '<br/>', '<br />']) html = replaceAll(replaceAll(html, tag, NL), tag.toUpperCase(), NL);
    const text = tidy(stripTags(html));
    if (text) out.push(text);
  }
  if (!out.length) throw fail('这个 EPUB 里没有读到文字内容');
  return out.join(NL + NL);
}

// ---- RTF ----
export function rtfText(buffer) {
  const src = buffer.toString('latin1'), skipDest = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'header', 'footer', 'themedata', 'datastore', 'listtable', 'listoverridetable', 'revtbl', 'rsidtbl', 'generator', 'object']);
  const out = []; const stack = []; let skip = 0, uc = 1, i = 0, pendingBytes = [];
  const flushBytes = () => { if (pendingBytes.length) { try { out.push(new TextDecoder('gb18030').decode(Buffer.from(pendingBytes))); } catch { out.push(Buffer.from(pendingBytes).toString('latin1')); } pendingBytes = []; } };
  while (i < src.length) {
    const ch = src[i];
    if (ch === '{') { stack.push({ skip, uc }); i++; continue; }
    if (ch === '}') { flushBytes(); const top = stack.pop(); if (top) { skip = top.skip; uc = top.uc; } i++; continue; }
    if (ch === BS) {
      const next = src[i + 1];
      if (next === BS || next === '{' || next === '}') { if (!skip) { flushBytes(); out.push(next); } i += 2; continue; }
      if (next === "'") { const hex = src.slice(i + 2, i + 4); if (!skip) pendingBytes.push(parseInt(hex, 16) || 63); i += 4; continue; }
      if (next === '*') { skip = skip || 1; i += 2; continue; }
      let j = i + 1; while (j < src.length && /[a-zA-Z]/.test(src[j])) j++;
      const word = src.slice(i + 1, j); let k = j; if (src[k] === '-') k++; while (k < src.length && /[0-9]/.test(src[k])) k++;
      const param = src.slice(j, k); if (src[k] === ' ') k++;
      if (skipDest.has(word)) skip = skip || 1;
      else if (!skip) {
        if (word === 'par' || word === 'line' || word === 'row') { flushBytes(); out.push(NL); }
        else if (word === 'tab' || word === 'cell') { flushBytes(); out.push(TAB); }
        else if (word === 'u') { flushBytes(); let n = parseInt(param, 10); if (n < 0) n += 65536; if (n > 0) out.push(String.fromCharCode(n)); k += uc; }
        else if (word === 'uc') uc = parseInt(param, 10) || 0;
      }
      i = k; continue;
    }
    if (!skip && ch !== NL && ch !== String.fromCharCode(13)) { flushBytes(); out.push(ch); }
    i++;
  }
  flushBytes();
  return tidy(out.join(''));
}

// ---- PDF ----
export async function pdfText(buffer) {
  let lib; try { lib = await import('unpdf'); } catch { throw fail('服务器没有安装 PDF 解析组件（unpdf），请联系管理员执行 npm ci 后重启'); }
  let pdf;
  try { pdf = await lib.getDocumentProxy(new Uint8Array(buffer)); }
  catch (error) { throw fail(/password/i.test(String(error?.message || error?.name)) ? '这个 PDF 有密码保护，无法读取' : '这个 PDF 无法解析（文件可能已损坏）'); }
  if (pdf.numPages > 500) throw fail('这个 PDF 有 ' + pdf.numPages + ' 页，超过 500 页的上限，请拆分后再传');
  const { text } = await lib.extractText(pdf, { mergePages: true });
  const result = tidy(String(text || ''));
  if (!result) throw fail('这个 PDF 里没有可提取的文字（可能是扫描件 / 图片型 PDF，需要先做文字识别）');
  return result;
}

// ---- 文本文件：UTF-8 优先，不是 UTF-8 时按中文常见的 GB18030（GBK）再试一次 ----
export function plainText(buffer) {
  if (buffer.includes(0)) throw fail('这个文件里有二进制内容，不是文本文件');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { try { text = new TextDecoder('gb18030', { fatal: true }).decode(buffer); } catch { throw fail('无法识别这个文件的文字编码（支持 UTF-8 和 GBK）'); } }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return text;
}

// 主入口：返回 { text, format } ；不支持的扩展名返回 null；能识别但解析失败时抛出带 userFacing 的错误（消息可直接给用户看）
export async function parseDocument(name, buffer, { maxBytes = DOC_LIMITS.maxBytes } = {}) {
  const ext = extOf(name);
  const known = TEXT_EXTS.has(ext) || PARSE_EXTS.has(ext) || LEGACY_EXTS.has(ext);
  if (!known) return null;
  if (!buffer || !buffer.length) throw fail('文件是空的');
  if (buffer.length > maxBytes) throw fail('文件太大（上限 ' + Math.floor(maxBytes / 1048576) + ' MB）');
  if (LEGACY_EXTS.has(ext)) throw fail('旧版 Office 格式（.' + ext + '）暂不能解析，请在 Word / Excel / PowerPoint 或 WPS 里另存为 .' + ext + 'x 再上传');
  let text, format;
  if (TEXT_EXTS.has(ext)) { text = plainText(buffer); format = 'text'; }
  else if (ext === 'pdf') {
    if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') throw fail('这不是有效的 PDF 文件');
    text = await pdfText(buffer); format = 'pdf';
  } else if (ext === 'rtf') {
    if (buffer.subarray(0, 5).toString('latin1') !== ('{' + BS + 'rtf')) throw fail('这不是有效的 RTF 文件');
    text = rtfText(buffer); format = 'rtf';
  } else {
    let zip;
    try { zip = readZip(buffer, ZIP_LIMITS); } catch (error) { throw fail('无法打开这个文件（' + (error.message || '格式不对') + '）。请确认是 ' + ext + ' 格式，没有加密或损坏'); }
    const files = new Map(zip.entries.map(entry => [entry.name, entry.data]));
    if (ext === 'docx') text = docxText(files);
    else if (ext === 'xlsx' || ext === 'xlsm') text = xlsxText(files);
    else if (ext === 'pptx') text = pptxText(files);
    else if (ext === 'epub') text = epubText(files);
    else text = odfText(files);
    format = ext;
  }
  if (!String(text).trim()) throw fail('没有从这个文件里读到文字内容');
  if (text.length > STORE_MAX_CHARS) text = text.slice(0, STORE_MAX_CHARS) + NL + '…（内容太长，后面的已省略）';
  return { text, format };
}
