import { createZip } from '../ziputil.mjs';

// 各种文件格式的最小测试样本（内存里拼出来，不需要真实文件）
export const zip = files => createZip(Object.entries(files).map(([name, data]) => ({ name, data: Buffer.from(data, 'utf8') })));
const NS_W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

export const docxFixture = () => zip({
  '[Content_Types].xml': '<Types/>',
  'word/document.xml': '<?xml version="1.0"?><w:document ' + NS_W + '><w:body>'
    + '<w:p><w:r><w:t>第一段：你好 &amp; 世界</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t xml:space="preserve">带</w:t></w:r><w:r><w:tab/><w:t>制表</w:t></w:r><w:r><w:br/><w:t>换行</w:t></w:r></w:p>'
    + '<w:p><w:r><w:instrText> PAGE </w:instrText></w:r><w:del><w:r><w:delText>被删除的字</w:delText></w:r></w:del></w:p>'
    + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>姓名</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>年龄</w:t></w:r></w:p></w:tc></w:tr>'
    + '<w:tr><w:tc><w:p><w:r><w:t>小明</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>18</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
    + '</w:body></w:document>'
});

export const xlsxFixture = () => zip({
  'xl/workbook.xml': '<workbook><sheets><sheet name="销售" sheetId="1" r:id="rId1"/><sheet name="空表" sheetId="2" r:id="rId2"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="x" Target="worksheets/sheet2.xml"/></Relationships>',
  'xl/sharedStrings.xml': '<sst><si><t>产品</t></si><si><r><t>数</t></r><r><t>量</t></r></si><si><t>苹果 &amp; 梨</t><rPh><t>ignored</t></rPh></si></sst>',
  'xl/worksheets/sheet1.xml': '<worksheet><sheetData>'
    + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="inlineStr"><is><t>备注</t></is></c></row>'
    + '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>42</v></c><c r="C2" t="b"><v>1</v></c></row>'
    + '<row r="3"><c r="A3"/></row>'
    + '</sheetData></worksheet>',
  'xl/worksheets/sheet2.xml': '<worksheet><sheetData/></worksheet>'
});

export const pptxFixture = () => zip({
  'ppt/slides/slide10.xml': '<p:sld><a:p><a:r><a:t>第十页</a:t></a:r></a:p></p:sld>',
  'ppt/slides/slide2.xml': '<p:sld><a:p><a:r><a:t>标题二</a:t></a:r></a:p><a:p><a:r><a:t>要点</a:t></a:r></a:p></p:sld>',
  'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>封面</a:t></a:r></a:p></p:sld>',
  'ppt/notesSlides/notesSlide2.xml': '<p:notes><a:p><a:r><a:t>讲稿备注</a:t></a:r></a:p></p:notes>'
});

export const odtFixture = () => zip({
  'mimetype': 'application/vnd.oasis.opendocument.text',
  'content.xml': '<office:document-content><office:body><office:text><text:h>标题</text:h><text:p>正文<text:tab/>一<text:s/>二</text:p><table:table><table:table-row><table:table-cell><text:p>甲</text:p></table:table-cell><table:table-cell><text:p>乙</text:p></table:table-cell></table:table-row></table:table></office:text></office:body></office:document-content>'
});

export const epubFixture = () => zip({
  'META-INF/container.xml': '<container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="x"/></rootfiles></container>',
  'OEBPS/content.opf': '<package><manifest><item id="a" href="b.xhtml"/><item id="b" href="a.xhtml"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>',
  'OEBPS/a.xhtml': '<html><body><h1>第二章</h1><p>后面的内容</p></body></html>',
  'OEBPS/b.xhtml': '<html><head><style>p{color:red}</style></head><body><h1>第一章</h1><p>先读这里</p><script>alert(1)</script></body></html>'
});

export const pdfFixture = lines => {
  const stream = 'BT /F1 14 Tf 72 720 Td ' + lines.map((line, i) => (i ? '0 -20 Td ' : '') + '(' + line + ') Tj').join(' ') + ' ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', '<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let out = '%PDF-1.4\n'; const offsets = [];
  objects.forEach((object, i) => { offsets.push(out.length); out += (i + 1) + ' 0 obj\n' + object + '\nendobj\n'; });
  const xref = out.length;
  out += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n' + offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') + 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF';
  return Buffer.from(out, 'latin1');
};

