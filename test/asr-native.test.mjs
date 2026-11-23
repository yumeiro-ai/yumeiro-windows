import test from 'node:test';
import assert from 'node:assert/strict';
import { transcribe, silenceWav, ENGINES } from '../asr.mjs';
import '../asr-native.mjs';

const wav = silenceWav();
const reply = (data, status = 200) => async (url, init) => { reply.calls.push({ url: String(url), init }); return new Response(JSON.stringify(data), { status }); };
reply.calls = [];
const run = (kind, fetchImpl, extra = {}) => transcribe({ kind, apiKey: 'k:s', model: 'auto', langId: 'yue', audio: wav, mime: 'audio/wav', fetchImpl, ...extra });

test('原生引擎全部登记且标记为 native', () => {
  for (const id of ['azure-speech', 'google-speech', 'tencent-asr', 'baidu-asr', 'cloudflare-whisper']) assert.ok(ENGINES.get(id)?.native, id);
});

test('Azure：区域进域名、粤语映射、拒绝非法区域', async () => {
  reply.calls = [];
  assert.equal(await run('azure-speech', reply({ RecognitionStatus: 'Success', DisplayText: '你好。' }), { apiKey: 'abc', extraParams: { region: 'westeurope' } }), '你好。');
  assert.match(reply.calls[0].url, /^https:\/\/westeurope\.stt\.speech\.microsoft\.com\/.*language=zh-HK/);
  assert.equal(reply.calls[0].init.headers['Ocp-Apim-Subscription-Key'], 'abc');
  await assert.rejects(run('azure-speech', reply({}), { apiKey: 'abc', extraParams: { region: 'evil.com/x' } }), /区域/);
});

test('Google：请求体与结果拼接', async () => {
  reply.calls = [];
  const text = await run('google-speech', reply({ results: [{ alternatives: [{ transcript: '你好' }] }, { alternatives: [{ transcript: '世界' }] }] }), { apiKey: 'gk' });
  assert.equal(text, '你好世界');
  const body = JSON.parse(reply.calls[0].init.body);
  assert.equal(body.config.languageCode, 'yue-Hant-HK'); assert.equal(body.config.sampleRateHertz, 16000);
});

test('腾讯云：TC3 签名头、方言自动选引擎、错误透出', async () => {
  reply.calls = [];
  const text = await run('tencent-asr', reply({ Response: { Result: '侬好' } }), { apiKey: 'AKIDxxx:secret', langId: 'wu' });
  assert.equal(text, '侬好');
  const { init } = reply.calls[0];
  assert.match(init.headers.Authorization, /^TC3-HMAC-SHA256 Credential=AKIDxxx\/\d{4}-\d\d-\d\d\/asr\/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=[0-9a-f]{64}$/);
  assert.equal(JSON.parse(init.body).EngSerViceType, '16k_zh_dialect');
  await assert.rejects(run('tencent-asr', reply({ Response: { Error: { Code: 'AuthFailure', Message: '密钥错误' } } }), { apiKey: 'a:b' }), /密钥错误/);
  await assert.rejects(run('tencent-asr', reply({}), { apiKey: 'nocolon' }), /冒号/);
});

test('百度：先取 token 再识别，token 复用，err_no 报错', async () => {
  const seen = [];
  const f = async url => { seen.push(String(url)); return new Response(JSON.stringify(String(url).includes('oauth') ? { access_token: 'T', expires_in: 3600 } : { err_no: 0, result: ['你好'] })); };
  assert.equal(await run('baidu-asr', f, { apiKey: 'bk1:bs' }), '你好');
  assert.equal(await run('baidu-asr', f, { apiKey: 'bk1:bs' }), '你好');
  assert.equal(seen.filter(u => u.includes('oauth')).length, 1);
  await assert.rejects(run('baidu-asr', async url => new Response(JSON.stringify(String(url).includes('oauth') ? { access_token: 'T2' } : { err_no: 3304, err_msg: 'over limit' })), { apiKey: 'bk2:bs' }), /3304/);
});

test('Cloudflare：账号 ID 校验与语言参数', async () => {
  reply.calls = [];
  const id = 'a'.repeat(32);
  assert.equal(await run('cloudflare-whisper', reply({ success: true, result: { text: 'hello' } }), { apiKey: id + ':tok', langId: 'en', model: '' }), 'hello');
  assert.match(reply.calls[0].url, new RegExp(`/accounts/${id}/ai/run/@cf/openai/whisper-large-v3-turbo$`));
  assert.equal(JSON.parse(reply.calls[0].init.body).language, 'en');
  await assert.rejects(run('cloudflare-whisper', reply({}), { apiKey: 'short:tok' }), /32/);
});

test('非 WAV 录音被拒绝', async () => {
  await assert.rejects(run('azure-speech', reply({}), { apiKey: 'x', mime: 'audio/webm' }), /WAV/);
});

test('配置：原生引擎无需接口地址但必须有密钥；密钥留空沿用旧值；公开视图只给掩码', async () => {
  const { normalizeAsrConfig, publicAsrConfig } = await import('../asr.mjs');
  const ok = () => true;
  assert.throws(() => normalizeAsrConfig({ enabled: true, provider: 'custom', kind: 'tencent-asr', model: 'auto' }, {}, ok), /密钥/);
  const first = normalizeAsrConfig({ enabled: true, provider: 'custom', kind: 'tencent-asr', model: 'auto', apiKey: 'AKID:secretvalue', extraParams: '{"region":"ap-guangzhou"}' }, {}, ok);
  assert.equal(first.baseUrl, '');
  const second = normalizeAsrConfig({ model: '16k_zh_dialect' }, first, ok);
  assert.equal(second.apiKey, 'AKID:secretvalue');
  const view = publicAsrConfig(second);
  assert.equal(view.apiKey, undefined); assert.equal(view.hasKey, true); assert.ok(!JSON.stringify(view).includes('secretvalue'));
  assert.throws(() => normalizeAsrConfig({ enabled: true, provider: 'custom', kind: 'transcriptions', model: 'm', apiKey: 'k' }, {}, ok), /接口地址/);
});
