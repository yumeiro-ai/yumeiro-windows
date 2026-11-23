import test from 'node:test';
import assert from 'node:assert/strict';
import { Breaker, RateGuard, normalizeBreakerConfig, isProviderFailure } from '../breaker.mjs';
import { scanText, scanMessages, normalizePolicy, validatePolicyInput, checkRegex, validIdCard, luhn, describeHits } from '../dlp.mjs';

const clock = () => { const c = { t: 1_000_000, now: () => c.t, advance: ms => { c.t += ms; } }; return c; };

// ───────── 熔断器 ─────────
test('熔断：连续失败达到阈值（默认 5 次）就断开，期间直接拒绝', () => {
  const c = clock(), b = new Breaker({}, c.now);
  for (let i = 0; i < 4; i++) { assert.equal(b.allow('m').ok, true); b.failure('m', 'HTTP 429'); }
  assert.equal(b.allow('m').ok, true, '第 5 次之前还没断开'); b.failure('m', 'HTTP 429');
  const r = b.allow('m'); assert.equal(r.ok, false); assert.equal(r.retryAfterMs, 60000); assert.match(r.reason, /429/);
  c.advance(30000); assert.equal(b.allow('m').retryAfterMs, 30000);
});
test('熔断：一次成功会清零连续失败计数', () => {
  const b = new Breaker({ failureThreshold: 3 }, clock().now);
  b.failure('m'); b.failure('m'); b.success('m'); b.failure('m'); b.failure('m');
  assert.equal(b.allow('m').ok, true);
});
test('熔断：冷却结束后试探，成功就恢复；失败就再断开且冷却时间翻倍，有上限', () => {
  const c = clock(), b = new Breaker({ failureThreshold: 1, openSeconds: 10, maxOpenSeconds: 25 }, c.now);
  b.failure('m'); assert.equal(b.allow('m').ok, false);
  c.advance(10000); const probe = b.allow('m'); assert.deepEqual([probe.ok, probe.probe], [true, true]);
  assert.equal(b.allow('m').ok, false, '试探名额只有 1 个，其余请求仍被拒绝');
  b.failure('m', 'again'); const r = b.allow('m'); assert.equal(r.ok, false); assert.equal(r.retryAfterMs, 20000);
  c.advance(20000); assert.equal(b.allow('m').probe, true); b.failure('m');
  assert.equal(b.allow('m').retryAfterMs, 25000, '冷却时间不超过上限');
  c.advance(25000); b.allow('m'); b.success('m'); assert.equal(b.allow('m').ok, true); assert.equal(b.snapshot()[0].state, 'closed');
});
test('熔断：不同的键互不影响；手动熔断要手动恢复；关掉熔断后一律放行', () => {
  const c = clock(), b = new Breaker({ failureThreshold: 1 }, c.now);
  b.failure('a'); assert.equal(b.allow('a').ok, false); assert.equal(b.allow('b').ok, true);
  b.trip('b', '维护'); c.advance(10 * 3600 * 1000); const r = b.allow('b'); assert.equal(r.ok, false); assert.equal(r.manual, true);
  b.reset('b'); assert.equal(b.allow('b').ok, true);
  b.setConfig({ enabled: false }); assert.equal(b.allow('a').ok, true);
});
test('熔断：试探中的请求被取消时，会把名额还回去，不会一直卡在“试探中”', () => {
  const c = clock(), b = new Breaker({ failureThreshold: 1, openSeconds: 10 }, c.now);
  b.failure('m'); c.advance(10000);
  assert.equal(b.allow('m').probe, true); assert.equal(b.allow('m').ok, false);
  b.release('m'); assert.equal(b.allow('m').probe, true, '名额还回去之后可以再试探');
});
test('单人限速：窗口内超过上限只断开这一个人，到点自动恢复', () => {
  const c = clock(), g = new RateGuard({ userRatePerMinute: 3, userOpenSeconds: 20 }, c.now);
  for (let i = 0; i < 3; i++) assert.equal(g.check('u1').ok, true);
  const r = g.check('u1'); assert.equal(r.ok, false); assert.equal(r.tripped, true);
  assert.equal(g.check('u2').ok, true, '别人不受影响'); assert.equal(g.check('u1').ok, false);
  c.advance(21000); assert.equal(g.check('u1').ok, true);
  assert.equal(new RateGuard({ userRatePerMinute: 0 }, c.now).check('u1').ok, true, '0 表示不限');
});
test('配置会被限制在合理范围内；只有对方不健康的状态码才算失败', () => {
  const cfg = normalizeBreakerConfig({ failureThreshold: -4, openSeconds: 99999, userRatePerMinute: 'x', dailyCostLimit: -1 });
  assert.equal(cfg.failureThreshold, 1); assert.equal(cfg.openSeconds, 3600); assert.equal(cfg.userRatePerMinute, 30); assert.equal(cfg.dailyCostLimit, 0);
  for (const s of [429, 500, 502, 503, 401, 403]) assert.equal(isProviderFailure(s), true, String(s));
  for (const s of [200, 400, 404, 422]) assert.equal(isProviderFailure(s), false, String(s));
});

// ───────── 敏感内容检测 ─────────
const policy = (extra = {}) => normalizePolicy({ enabled: true, ...extra });
const ID = '11010519491231002X', CARD = '4111111111111111';

test('身份证号带校验位：真号码命中，随手写的 18 位数字不命中', () => {
  assert.equal(validIdCard(ID), true); assert.equal(validIdCard('110105194912310021'), false);
  assert.deepEqual(scanText(`身份证 ${ID}`, policy()).map(h => h.id), ['idcard']);
  assert.deepEqual(scanText('订单号 110105194912310021', policy()), []);
});
test('银行卡号用 Luhn 校验，带空格或横线也能识别；随机长数字不命中', () => {
  assert.equal(luhn(CARD), true); assert.equal(luhn('1234567890123456'), false);
  assert.equal(scanText(`卡号 ${CARD}`, policy())[0].id, 'bank');
  assert.equal(scanText('卡号 4111 1111 1111 1111 和 4111-1111-1111-1111', policy())[0].count, 2);
  assert.deepEqual(scanText('流水号 1234567890123456', policy()), []);
});
test('密钥和令牌的典型格式会命中；普通文字不会', () => {
  const samples = ['sk-abcdefghijklmnopqrstuvwxyz123456', 'AKIAABCDEFGHIJKLMNOP', 'ghp_' + 'a'.repeat(36), '-----BEGIN RSA PRIVATE KEY-----', 'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0NTY3.SflKxwRJSMeKKF2QT4fw'];
  for (const s of samples) assert.equal(scanText('这是 ' + s + ' 请处理', policy())[0]?.id, 'secret', s);
  assert.deepEqual(scanText('我们讨论一下 token 的设计和 API key 的轮换策略', policy()), []);
});
test('手机号和邮箱默认不检查，打开后才检查', () => {
  assert.deepEqual(scanText('电话 13812345678，邮箱 a@b.com', policy()), []);
  const ids = scanText('电话 13812345678，邮箱 a@b.com', policy({ builtin: { phone: true, email: true } })).map(h => h.id).sort();
  assert.deepEqual(ids, ['email', 'phone']);
});
test('关键词不分大小写，按次数统计；自定义正则能用；写坏或有风险的正则被拒绝', () => {
  const p = policy({ keywords: ['合同编号', 'ProjectX'], regexes: [{ name: '合同号', pattern: 'HT-\\d{6}' }] });
  const hits = scanText('合同编号 HT-123456；projectx 项目；PROJECTX', p);
  assert.equal(hits.find(h => h.id === 'kw:合同编号').count, 1); assert.equal(hits.find(h => h.id === 'kw:ProjectX').count, 2); assert.equal(hits.find(h => h.id === 'rx:合同号').count, 1);
  assert.match(checkRegex('('), /写法不对/); assert.match(checkRegex('(a+)+$'), /很慢/); assert.match(checkRegex('(a|b)*c'), /很慢/); assert.equal(checkRegex('HT-\\d{6}'), '');
  assert.match(validatePolicyInput({ regexes: [{ name: 'x', pattern: '(a+)+' }] }), /很慢/);
  assert.equal(normalizePolicy({ regexes: [{ name: 'bad', pattern: '(a+)+' }, { name: 'ok', pattern: 'abc' }] }).regexes.length, 1);
});
test('结果里绝不带匹配到的原文', () => {
  const p = policy({ keywords: ['机密项目'] });
  const hits = scanText(`身份证 ${ID} 卡号 ${CARD} 密钥 sk-abcdefghijklmnopqrstuvwxyz123456 机密项目`, p), text = JSON.stringify(hits);
  for (const secret of [ID, CARD, 'sk-abcdefghijklmnopqrstuvwxyz123456']) assert.ok(!text.includes(secret), '结果泄露了原文');
  assert.match(describeHits(hits), /身份证号/);
});
test('只检查这一轮新发出的内容：历史里更早的内容不重复检查，所以被拦截的消息不会堵死整段对话', () => {
  const messages = [{ role: 'user', content: '旧消息含 ' + ID }, { role: 'assistant', content: '好的' }, { role: 'user', content: '这是新问题，没有敏感信息' }];
  assert.deepEqual(scanMessages(messages, policy()), []);
  assert.equal(scanMessages([...messages.slice(0, 2), { role: 'user', content: '新的 ' + ID }], policy())[0].id, 'idcard');
  const parts = [{ role: 'user', content: [{ type: 'text', text: '看图 ' + ID }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }];
  assert.equal(scanMessages(parts, policy())[0].id, 'idcard');
});
test('超长文本只扫描前 40 万字符，不会卡住', () => {
  const big = 'a'.repeat(1_000_000) + ID, t0 = Date.now();
  assert.deepEqual(scanText(big, policy()), []); assert.ok(Date.now() - t0 < 2000);
});
