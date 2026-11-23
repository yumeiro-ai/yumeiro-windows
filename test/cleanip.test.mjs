import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, judge, normalizeGuard, parseCleanIp, detectCleanIp, validCleanipKey, maskCleanipKey, TARGETS } from '../envcheck.mjs';

const KEY = 'cip_abcdefgh12345678';
const probesOk = TARGETS.map(t => ({ id: t.id, vendor: t.vendor, label: t.label, reachable: true, status: 200, ms: 100, challenged: false }));
const rpc = result => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200, headers: { 'Content-Type': 'application/json' } });
const clean = { ip: '1.2.3.4', cleanip_score: 91, grade: 'A', ip_type: 'Residential', risk_flags: [], location: { country_code: 'US' }, network: { asn: 7922, as_name: 'Comcast' }, report_url: 'https://cleanip.io/1.2.3.4' };

test('CleanIP：密钥格式、掩码、守卫设置只保留合法密钥', () => {
  assert.equal(validCleanipKey(KEY), true); assert.equal(validCleanipKey('sk-123'), false); assert.equal(validCleanipKey(''), false);
  assert.equal(maskCleanipKey(KEY), 'cip_••••5678');
  assert.equal(normalizeGuard({ cleanipKey: 'bad' }).cleanipKey, '');
  assert.equal(normalizeGuard({ cleanipKey: KEY }).cleanipKey, KEY);
  assert.equal(normalizeGuard({}).cleanipEnabled, false, '默认不启用：不替用户把出口 IP 发给第三方'); assert.equal(normalizeGuard({ cleanipEnabled: true }).cleanipEnabled, true);
});

test('CleanIP：解析纯净度、类型、标记（容错几种写法）；没有纯净度数据视为未生效', () => {
  const p = parseCleanIp({ ...clean, cleanip_score: 55, grade: 'D', ip_type: 'Hosting', risk_flags: ['VPN detected', { name: 'Blocklisted' }] });
  assert.equal(p.score, 55); assert.equal(p.grade, 'D'); assert.equal(p.vpn, true); assert.equal(p.hosting, true); assert.equal(p.country, 'US'); assert.deepEqual(p.flags, ['VPN detected', 'Blocklisted']);
  const alt = parseCleanIp({ cleanip: { score: '72', grade: 'B' }, flags: { is_proxy: true, is_tor: false }, network: { type: 'ISP' } });
  assert.equal(alt.score, 72); assert.equal(alt.proxy, true); assert.equal(alt.tor, false);
  assert.equal(parseCleanIp({ ip: '8.8.8.8', location: { country_code: 'US' }, network: { asn: 15169 }, note: 'Basic location and network data only' }).keyless, true);
});

test('CleanIP：detectCleanIp 用 Bearer 密钥调用 check_ip；错误都有明确提示，且不会抛出', async () => {
  let seen;
  const ok = await detectCleanIp({ ip: '1.2.3.4', key: KEY, fetchFn: async (url, init) => { seen = { url, init, body: JSON.parse(init.body) }; return rpc({ structuredContent: clean }); } });
  assert.equal(seen.url, 'https://cleanip.io/mcp'); assert.equal(seen.init.headers.Authorization, 'Bearer ' + KEY);
  assert.equal(seen.body.method, 'tools/call'); assert.equal(seen.body.params.name, 'check_ip'); assert.deepEqual(seen.body.params.arguments, { ip: '1.2.3.4' });
  assert.equal(ok.ok, true); assert.equal(ok.score, 91);
  const fromText = await detectCleanIp({ ip: '1.2.3.4', key: KEY, fetchFn: async () => rpc({ content: [{ type: 'text', text: JSON.stringify(clean) }] }) });
  assert.equal(fromText.score, 91);
  const sse = await detectCleanIp({ ip: '1.2.3.4', key: KEY, fetchFn: async () => new Response('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: clean } }) + '\n\n', { status: 200 }) });
  assert.equal(sse.score, 91);
  assert.match((await detectCleanIp({ ip: '1.2.3.4', key: KEY, fetchFn: async () => new Response('{}', { status: 401 }) })).error, /密钥无效/);
  assert.match((await detectCleanIp({ ip: '1.2.3.4', key: KEY, fetchFn: async () => new Response('{}', { status: 429 }) })).error, /额度/);
  assert.match((await detectCleanIp({ ip: '1.2.3.4', key: KEY, fetchFn: async () => { throw new Error('boom'); } })).error, /无法连接 CleanIP/);
  assert.match((await detectCleanIp({ ip: '1.2.3.4', key: KEY, fetchFn: async () => rpc({ structuredContent: { ip: '1.2.3.4', note: 'Basic location and network data only' } }) })).error, /没有返回纯净度/);
  assert.match((await detectCleanIp({ ip: '1.2.3.4', key: 'nope' })).error, /密钥格式/);
  assert.match((await detectCleanIp({ ip: '', key: KEY })).error, /出口 IP/);
});

test('综合研判：多个来源合成分数；CleanIP 与本地各占一半；矛盾和风险信号会扣分并写明来源', () => {
  const guard = normalizeGuard({});
  const base = evaluate({ egress: { country: 'US', ip: '1.2.3.4', hosting: false, proxy: false, isp: 'Comcast' }, probes: probesOk, guard });
  assert.equal(base.verdict.score, 100); assert.equal(base.verdict.level, 'ok'); assert.deepEqual(base.verdict.factors, []);
  assert.ok(!base.verdict.sources.includes('CleanIP'));

  const good = evaluate({ egress: { country: 'US', ip: '1.2.3.4' }, probes: probesOk, guard, cleanip: parseCleanIp(clean) });
  assert.equal(good.verdict.score, 96); assert.equal(good.verdict.level, 'ok'); assert.ok(good.verdict.sources.includes('CleanIP'));
  assert.ok(good.vendors.claude.reasons.some(r => /CleanIP 纯净度 91/.test(r.text)));

  const bad = evaluate({ egress: { country: 'US', ip: '1.2.3.4', hosting: true }, probes: probesOk, guard, cleanip: parseCleanIp({ ...clean, cleanip_score: 30, grade: 'F', ip_type: 'Hosting', risk_flags: ['VPN'], location: { country_code: 'DE' } }) });
  assert.equal(bad.vendors.claude.level, 'danger'); assert.equal(bad.vendors.claude.block, false, 'CleanIP 分低只提示，不单独拦截请求');
  assert.ok(bad.verdict.score < 50 && bad.verdict.level === 'danger');
  assert.ok(bad.verdict.factors.some(f => f.source === '多源对比'), '地区不一致要体现在依据里');
  assert.match(bad.vendors.claude.reasons.map(r => r.text).join('|'), /地区的判断不一致/);

  // 受限地区仍然由硬规则拦截，与 CleanIP 分数无关
  const cn = evaluate({ egress: { country: 'CN', ip: '1.2.3.4' }, probes: probesOk, guard, cleanip: parseCleanIp({ ...clean, location: { country_code: 'CN' } }) });
  assert.equal(cn.vendors.claude.block, true); assert.equal(cn.verdict.level, 'danger');
  // CleanIP 失败时退回本地信号，不影响其余评估
  const failed = evaluate({ egress: { country: 'US', ip: '1.2.3.4' }, probes: probesOk, guard, cleanip: { ok: false, error: 'x' } });
  assert.equal(failed.verdict.score, 100); assert.equal(failed.cleanip.error, 'x');
  assert.equal(judge({ egress: {}, probes: [], guard, cleanip: null }).factors[0].source, 'Cloudflare');
});
