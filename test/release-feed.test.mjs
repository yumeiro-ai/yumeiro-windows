import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReleaseFeed, feedText } from '../updatepkg.mjs';

const base = 'https://github.com/yumeiro-ai/yumeiro';
const xml = `<?xml version="1.0"?><feed><entry><id>x</id><updated>2026-11-21T11:43:50Z</updated>
<link rel="alternate" type="text/html" href="${base}/releases/tag/v0.45.23"/><title>Yumeiro 0.45.23</title>
<content type="html">&lt;ul&gt;
&lt;li&gt;修复 &amp;amp; 新增&lt;/li&gt;
&lt;li&gt;第二条&lt;/li&gt;
&lt;/ul&gt;</content></entry>
<entry><updated>2026-11-21T10:00:00Z</updated><link rel="alternate" href="${base}/releases/tag/v0.45.22"/><content type="html"></content></entry>
<entry><link rel="alternate" href="${base}/releases/tag/nightly"/></entry></feed>`;

test('订阅源解析：版本、时间、说明和按包名拼出的下载地址', () => {
  const list = parseReleaseFeed(xml, base);
  assert.deepEqual(list.map(r => r.version), ['0.45.23', '0.45.22']); // 不是 x.y.z 的标签被忽略
  assert.equal(list[0].publishedAt, '2026-11-21T11:43:50Z');
  assert.match(list[0].notes, /- 修复 & 新增/);
  assert.match(list[0].notes, /- 第二条/);
  assert.equal(list[0].server.url, base + '/releases/download/v0.45.23/Yumeiro-0.45.23.zip');
  assert.equal(list[0].clients.url, base + '/releases/download/v0.45.23/Yumeiro-0.45.23-with-clients.zip');
  assert.equal(list[0].server.size, 0);
  assert.equal(list[0].releaseUrl, base + '/releases/tag/v0.45.23');
});
test('订阅源解析：空内容和乱内容不报错', () => {
  assert.deepEqual(parseReleaseFeed('', base), []);
  assert.deepEqual(parseReleaseFeed('<feed></feed>', base), []);
  assert.equal(feedText(null), '');
});
