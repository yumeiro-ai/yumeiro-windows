import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { normalizeImageConfig, cleanImageRequest, buildImageRequest, parseImageResponse, sniffImage, safeResultUrl, defaultImageConfig } from '../images.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

// ---------- 纯函数 ----------
test('绘画配置：规范化、必填校验、密钥沿用', () => {
  const ok = normalizeImageConfig({ enabled: true, provider: 'custom', baseUrl: 'https://api.example.com/v1/', apiKey: 'sk-abc', model: 'gpt-image-1', sizes: '1024x1024, 512x512', defaultSize: '512x512', dailyLimit: 5 });
  assert.equal(ok.baseUrl, 'https://api.example.com/v1'); assert.deepEqual(ok.sizes, ['1024x1024', '512x512']); assert.equal(ok.defaultSize, '512x512');
  assert.equal(normalizeImageConfig({ model: 'x2' }, ok).apiKey, 'sk-abc', '密钥留空沿用旧的');
  assert.throws(() => normalizeImageConfig({ enabled: true, provider: 'custom', baseUrl: 'https://a.b/v1' }), /模型/);
  assert.throws(() => normalizeImageConfig({ enabled: true, provider: 'custom', model: 'm' }), /接口地址/);
  assert.throws(() => normalizeImageConfig({ enabled: true, model: 'm' }), /服务商/);
  assert.throws(() => normalizeImageConfig({ provider: 'custom', baseUrl: 'http://example.com/v1' }), /https/);
  assert.throws(() => normalizeImageConfig({ sizes: 'abc' }), /尺寸/);
  assert.throws(() => normalizeImageConfig({ defaultSize: '777x777' }), /默认尺寸/);
  assert.throws(() => normalizeImageConfig({ maxPerRequest: 9 }), /1–4/);
  assert.throws(() => normalizeImageConfig({ extraParams: '{坏的' }), /JSON/);
  assert.throws(() => normalizeImageConfig({ dialect: 'nope' }), /方言/);
});

test('绘画请求：校验、两种方言的请求体', () => {
  const config = { ...defaultImageConfig(), model: 'm', extraParams: { quality: 'hd', model: 'hacked' } };
  assert.throws(() => cleanImageRequest(config, { prompt: '  ' }), /输入要画的内容/);
  assert.throws(() => cleanImageRequest(config, { prompt: 'a'.repeat(2001) }), /2000/);
  assert.throws(() => cleanImageRequest(config, { prompt: 'x', size: '9x9' }), /不支持这个尺寸/);
  assert.throws(() => cleanImageRequest(config, { prompt: 'x', n: 3 }), /最多 2/);
  const params = cleanImageRequest(config, { prompt: ' 猫 ', n: 2, negative: '模糊' });
  assert.deepEqual(params, { prompt: '猫', size: '1024x1024', n: 2, negative: '模糊' });
  const openai = buildImageRequest({ ...config, responseFormat: 'b64_json' }, params);
  assert.equal(openai.model, 'm', '额外参数不能覆盖模型'); assert.equal(openai.n, 2); assert.equal(openai.size, '1024x1024'); assert.equal(openai.response_format, 'b64_json'); assert.equal(openai.quality, 'hd'); assert.match(openai.prompt, /避免出现：模糊/);
  const sf = buildImageRequest({ ...config, dialect: 'siliconflow' }, params);
  assert.equal(sf.image_size, '1024x1024'); assert.equal(sf.batch_size, 2); assert.equal(sf.negative_prompt, '模糊'); assert.equal(sf.size, undefined);
  assert.equal(buildImageRequest(config, params).response_format, undefined, '不指定返回格式时不发送');
});

test('绘画响应解析、图片头校验、结果地址安全', () => {
  assert.deepEqual(parseImageResponse({ data: [{ b64_json: 'QUJD', revised_prompt: 'r' }, { url: 'https://x/y.png' }] }), [{ b64: 'QUJD', revised: 'r' }, { url: 'https://x/y.png', revised: undefined }]);
  assert.deepEqual(parseImageResponse({ images: [{ url: 'https://x/z.png' }] }).map(i => i.url), ['https://x/z.png']);
  assert.deepEqual(parseImageResponse({ data: [{ b64_json: 'data:image/png;base64,QUJD' }] })[0].b64, 'QUJD');
  assert.deepEqual(parseImageResponse({ error: 1 }), []);
  assert.equal(sniffImage(PNG).mime, 'image/png');
  assert.equal(sniffImage(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)])).ext, 'jpg');
  assert.equal(sniffImage(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])).mime, 'image/webp');
  assert.equal(sniffImage(Buffer.from('<html><script>alert(1)</script></html>')), null, 'HTML 不是图片');
  assert.equal(safeResultUrl('https://cdn.example.com/a.png').hostname, 'cdn.example.com');
  assert.throws(() => safeResultUrl('http://cdn.example.com/a.png'), /https/);
  assert.throws(() => safeResultUrl('https://169.254.169.254/latest'), /链路本地/);
  assert.throws(() => safeResultUrl('https://10.0.0.5/a.png'), /内网/);
  assert.throws(() => safeResultUrl('https://localhost/a.png'), /内网/);
  assert.throws(() => safeResultUrl('file:///etc/passwd'), /不支持/);
  assert.throws(() => safeResultUrl('https://u:p@cdn.example.com/a.png'), /不安全/);
  assert.equal(safeResultUrl('http://127.0.0.1:9000/a.png', 'http://127.0.0.1:9000/v1').port, '9000', '和服务商同主机（自建网关）允许');
});

// ---------- 接口集成 ----------
const ADMIN = { email: 'owner@example.com', password: 'a-very-long-test-password' };
let dir, mock, mockPort, app, base, owner, lastRequest, lastA1111, lastComfy, historyCalls = 0, openaiCalls = [];
test.before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ym-img-'));
  const keyFile = path.join(dir, 'k'), adminFile = path.join(dir, 'a');
  await writeFile(keyFile, randomBytes(32).toString('base64')); await writeFile(adminFile, ADMIN.password);
  mock = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => raw += c);
    req.on('end', () => {
      const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (req.url === '/files/a.png' || req.url.startsWith('/view?')) { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(PNG); }
      if (req.url === '/sdapi/v1/txt2img') { lastA1111 = { ...JSON.parse(raw), auth: req.headers.authorization }; return json(200, { images: Array.from({ length: lastA1111.batch_size || 1 }, () => PNG.toString('base64')), info: '{}' }); }
      if (req.url === '/prompt') { lastComfy = JSON.parse(raw); historyCalls = 0; return json(200, { prompt_id: 'p1', number: 1 }); }
      if (req.url === '/history/p1') { historyCalls++; return json(200, historyCalls < 3 ? {} : { p1: { outputs: { 9: { images: Array.from({ length: lastComfy.prompt[5].inputs.batch_size }, (_, i) => ({ filename: 'a' + i + '.png', subfolder: '', type: 'output' })) } }, status: { completed: true, status_str: 'success' } } }); }
      if (req.url === '/v1/chat/completions') return json(200, { choices: [{ message: { content: '扩写后的详细描述：夜晚的樱花树' } }], usage: { total_tokens: 5 } });
      if (req.url === '/v1/images/generations') {
        const body = JSON.parse(raw); lastRequest = { ...body, auth: req.headers.authorization };
        const p = String(body.prompt); openaiCalls.push({ n: body.n, size: body.size });
        if (p.includes('ONLY1') && body.n > 1) return json(400, { error: { message: 'n must be 1' } });
        const count = body.n || body.batch_size || 1;
        if (p.includes('ERR')) return json(500, { error: { message: 'boom 上游错误' } });
        if (p.includes('EVIL')) return json(200, { data: [{ url: 'https://169.254.169.254/latest/meta-data' }] });
        if (p.includes('NOTIMG')) return json(200, { data: [{ b64_json: Buffer.from('<html>nope</html> not an image').toString('base64') }] });
        if (p.includes('SFURL')) return json(200, { images: Array.from({ length: count }, () => ({ url: `http://127.0.0.1:${mockPort}/files/a.png` })) });
        if (p.includes('URL')) return json(200, { data: [{ url: `http://127.0.0.1:${mockPort}/files/a.png` }] });
        return json(200, { data: Array.from({ length: count }, () => ({ b64_json: PNG.toString('base64'), revised_prompt: '改写：' + p.slice(0, 10) })) });
      }
      json(404, { error: 'no' });
    });
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r)); mockPort = mock.address().port;
  const port = 20000 + Math.floor(Math.random() * 20000);
  base = 'http://127.0.0.1:' + port;
  app = spawn(process.execPath, ['server.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, COOKIE_SECURE: 'false', TRUST_PROXY: 'false', STORE_ENCRYPTION_KEY_FILE: keyFile, ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD_FILE: adminFile, MODEL_BASE_URL: `http://127.0.0.1:${mockPort}/v1`, MODEL_NAME: 'chat-model', MODEL_API_KEY: 'k', ENV_CHECK_INTERVAL_MS: '0', COMFY_POLL_MS: '30' } });
  await new Promise((resolve, reject) => { app.on('exit', code => reject(new Error('exit ' + code))); app.stdout.on('data', c => { if (String(c).includes('listening')) resolve(); }); });
  owner = await login(ADMIN);
});
test.after(async () => { app?.removeAllListeners('exit'); app?.kill(); mock?.close(); await new Promise(r => setTimeout(r, 300)); await rm(dir, { recursive: true, force: true }).catch(() => {}); });
async function login(account) {
  const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(account) });
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: (await response.json()).csrfToken };
}
async function call(auth, p, method = 'GET', body) {
  const response = await fetch(base + p, { method, headers: { Origin: base, Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, data: await response.json().catch(() => ({})), headers: response.headers };
}
const rawGet = (auth, p) => fetch(base + p, { headers: { Cookie: auth.cookie } });
const settings = (patch = {}) => ({ enabled: true, dialect: 'openai', workflow: '', provider: 'custom', baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: 'img-key', model: 'gpt-image-1', sizes: '1024x1024 1024x1792', defaultSize: '1024x1024', dailyLimit: 0, maxPerRequest: 2, ...patch });

test('绘画：未开启时拒绝；管理员配置有校验、密钥不回显、成员不能改', async () => {
  const member = (await call(owner, '/api/admin/members', 'POST', { email: 'm@example.com', password: 'member-password-12345' }), await login({ email: 'm@example.com', password: 'member-password-12345' }));
  assert.equal((await call(owner, '/api/images/config')).data.enabled, false);
  assert.equal((await call(owner, '/api/images', 'POST', { prompt: '猫' })).status, 503);
  assert.equal((await call(member, '/api/admin/images', 'PUT', settings())).status, 403);
  assert.equal((await call(member, '/api/admin/images')).status, 403);
  assert.equal((await call(owner, '/api/admin/images', 'PUT', { enabled: true, provider: 'custom', baseUrl: 'https://x.example.com/v1' })).status, 400, '缺模型');
  const saved = await call(owner, '/api/admin/images', 'PUT', settings());
  assert.equal(saved.status, 200); assert.equal(saved.data.config.hasKey, true); assert.doesNotMatch(JSON.stringify(saved.data), /img-key/);
  assert.doesNotMatch(JSON.stringify((await call(owner, '/api/admin/images')).data), /img-key/);
  const t = await call(owner, '/api/admin/images/test', 'POST', {});
  assert.equal(t.data.ok, true); assert.equal(t.data.mime, 'image/png'); assert.equal(lastRequest.auth, 'Bearer img-key');
  assert.equal((await call(owner, '/api/admin/images/test', 'POST', { model: 'x', baseUrl: 'http://127.0.0.1:1/v1' })).data.ok, false, '连不上时给出失败而不是抛错');
  assert.equal((await call(owner, '/api/images/config')).data.enabled, true);
});

test('绘画：生成、取图（带安全头）、列表、校验、隔离、删除', async () => {
  const member = await login({ email: 'm@example.com', password: 'member-password-12345' });
  assert.equal((await call(owner, '/api/images', 'POST', { prompt: '' })).status, 400);
  assert.equal((await call(owner, '/api/images', 'POST', { prompt: '猫', size: '333x333' })).status, 400);
  assert.equal((await call(owner, '/api/images', 'POST', { prompt: '猫', n: 3 })).status, 400);

  const r = await call(owner, '/api/images', 'POST', { prompt: '夜晚樱花树下的少女', size: '1024x1792', n: 2 });
  assert.equal(r.status, 201); assert.equal(r.data.images.length, 2); assert.equal(r.data.usedToday, 2);
  assert.equal(lastRequest.n, 2); assert.equal(lastRequest.size, '1024x1792'); assert.equal(lastRequest.model, 'gpt-image-1');
  const file = await rawGet(owner, r.data.images[0].url);
  assert.equal(file.status, 200); assert.equal(file.headers.get('content-type'), 'image/png'); assert.equal(file.headers.get('x-content-type-options'), 'nosniff'); assert.match(file.headers.get('content-security-policy'), /sandbox/);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG);
  assert.equal((await call(owner, '/api/images')).data.images.length, 2);

  // 别人拿不到
  assert.equal((await rawGet(member, r.data.images[0].url)).status, 404);
  assert.equal((await call(member, `/api/images/${r.data.images[0].id}`, 'DELETE')).status, 404);
  assert.equal((await call(member, '/api/images')).data.images.length, 0);
  assert.equal((await rawGet({ cookie: 'x=1' }, r.data.images[0].url)).status, 401, '未登录不能取图');

  // 删除：记录和文件都没了
  const id = r.data.images[1].id, userDir = path.join(dir, 'images');
  assert.equal((await call(owner, `/api/images/${id}`, 'DELETE')).status, 200);
  assert.equal((await rawGet(owner, `/api/images/${id}/file`)).status, 404);
  const files = (await Promise.all((await readdir(userDir)).map(d => readdir(path.join(userDir, d))))).flat();
  assert.equal(files.length, 1, '磁盘上只剩一张');
  const audit = (await call(owner, '/api/audit?limit=100')).data.entries;
  assert.ok(audit.some(e => e.action === 'image.generate' && e.ok) && audit.some(e => e.action === 'image.delete'));
});

test('绘画：上游 URL 返回、硅基流动方言、异常结果被拒（含 SSRF）', async () => {
  let r = await call(owner, '/api/images', 'POST', { prompt: 'URL 方式返回' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal((await call(owner, '/api/images', 'POST', { prompt: 'ERR 失败' })).data.error.includes('boom'), true);
  assert.equal((await call(owner, '/api/images', 'POST', { prompt: 'ERR 失败' })).status, 502);
  const evil = await call(owner, '/api/images', 'POST', { prompt: 'EVIL 内网' });
  assert.equal(evil.status, 502); assert.match(evil.data.error, /链路本地/);
  const fake = await call(owner, '/api/images', 'POST', { prompt: 'NOTIMG' });
  assert.equal(fake.status, 502); assert.match(fake.data.error, /不是图片/);

  await call(owner, '/api/admin/images', 'PUT', settings({ dialect: 'siliconflow', model: 'Kwai-Kolors/Kolors' }));
  r = await call(owner, '/api/images', 'POST', { prompt: 'SFURL 方言', n: 2, size: '1024x1024' });
  assert.equal(r.status, 201); assert.equal(r.data.images.length, 2);
  assert.equal(lastRequest.image_size, '1024x1024'); assert.equal(lastRequest.batch_size, 2); assert.equal(lastRequest.size, undefined);
  await call(owner, '/api/admin/images', 'PUT', settings());
  const failed = (await call(owner, '/api/audit?action=image.generate&ok=false')).data.entries;
  assert.ok(failed.length >= 3, '失败也写入审计');
});

test('绘画：每日张数限额、OpenAI 兼容接口、提示词优化', async () => {
  const member = await login({ email: 'm@example.com', password: 'member-password-12345' });
  await call(owner, '/api/admin/images', 'PUT', settings({ dailyLimit: 3 }));
  assert.equal((await call(member, '/api/images', 'POST', { prompt: '一', n: 2 })).status, 201);
  assert.equal((await call(member, '/api/images', 'POST', { prompt: '二', n: 2 })).status, 429, '再画 2 张会超出 3 张');
  assert.equal((await call(member, '/api/images', 'POST', { prompt: '三', n: 1 })).status, 201);
  const over = await call(member, '/api/images', 'POST', { prompt: '四', n: 1 });
  assert.equal(over.status, 429); assert.match(over.data.error, /已用完/);
  assert.equal((await call(member, '/api/images/config')).data.usedToday, 3);
  await call(owner, '/api/admin/images', 'PUT', settings({ dailyLimit: 0 }));

  const token = (await call(owner, '/api/tokens', 'POST', { name: 'img' })).data.token;
  const api = await fetch(base + '/v1/images/generations', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: '接口调用', n: 2, size: '1024x1024', model: 'ignored' }) });
  const data = await api.json();
  assert.equal(api.status, 200); assert.equal(data.data.length, 2); assert.deepEqual(Buffer.from(data.data[0].b64_json, 'base64'), PNG); assert.ok(data.created);
  assert.equal((await fetch(base + '/v1/images/generations', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: '' }) })).status, 400);
  assert.equal((await fetch(base + '/v1/images/generations', { method: 'POST', headers: { Authorization: 'Bearer cak_wrongwrongwrongwrongwrong', 'Content-Type': 'application/json' }, body: '{}' })).status, 401);

  const enhanced = await call(owner, '/api/images/enhance', 'POST', { prompt: '樱花' });
  assert.equal(enhanced.status, 200); assert.match(enhanced.data.prompt, /扩写后的详细描述/);
  assert.equal((await call(owner, '/api/images/enhance', 'POST', { prompt: '  ' })).status, 400);

  // 关闭后不能再画
  await call(owner, '/api/admin/images', 'PUT', { enabled: false });
  assert.equal((await call(owner, '/api/images', 'POST', { prompt: '关闭后' })).status, 503);
  assert.equal((await fetch(base + '/v1/images/generations', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'x' }) })).status, 503);
});

test('绘画：自定义尺寸（范围、倍数、总像素）', async () => {
  const base = { ...defaultImageConfig(), allowCustomSize: true, minSide: 256, maxSide: 1536, sizeStep: 64, maxPixels: 1536 * 1024 };
  assert.equal(cleanImageRequest(base, { prompt: 'x', size: '1344x768' }).size, '1344x768');
  assert.throws(() => cleanImageRequest(base, { prompt: 'x', size: '1344x770' }), /64 的倍数/);
  assert.throws(() => cleanImageRequest(base, { prompt: 'x', size: '128x512' }), /256–1536/);
  assert.throws(() => cleanImageRequest(base, { prompt: 'x', size: '1536x1536' }), /总像素/);
  assert.throws(() => cleanImageRequest({ ...base, allowCustomSize: false }, { prompt: 'x', size: '1344x768' }), /不支持这个尺寸/);
  assert.throws(() => cleanImageRequest(base, { prompt: 'x', size: '宽x高' }), /不支持这个尺寸/);
  assert.throws(() => normalizeImageConfig({ minSide: 900, maxSide: 800 }), /边长范围/);
  assert.throws(() => normalizeImageConfig({ sizeStep: 0 }), /步长/);
  assert.throws(() => normalizeImageConfig({ workflow: '[1]' }), /API 格式/);
  assert.throws(() => normalizeImageConfig({ workflow: '{坏' }), /API 格式/);
  assert.throws(() => normalizeImageConfig({ batchMode: 'x' }), /多张生成方式/);
});

test('绘画：多张——模型只支持 1 张时自动拆成多次，也可固定拆分；自定义尺寸端到端', async () => {
  await call(owner, '/api/admin/images', 'PUT', settings({ maxPerRequest: 4, allowCustomSize: true, sizeStep: 64, minSide: 256, maxSide: 1536 }));
  openaiCalls = [];
  let r = await call(owner, '/api/images', 'POST', { prompt: 'ONLY1 四张', n: 3, size: '768x1344' });
  assert.equal(r.status, 201, JSON.stringify(r.data)); assert.equal(r.data.images.length, 3, '上游拒绝 n>1 后自动拆成 3 次单张');
  assert.deepEqual(openaiCalls.map(c => c.n), [3, 1, 1, 1], '先试一次多张，再拆分');
  assert.equal(openaiCalls[0].size, '768x1344');
  assert.equal((await call(owner, '/api/images', 'POST', { prompt: '尺寸不合法', size: '770x1344' })).status, 400);

  await call(owner, '/api/admin/images', 'PUT', { batchMode: 'split' });
  openaiCalls = [];
  r = await call(owner, '/api/images', 'POST', { prompt: '固定拆分', n: 4 });
  assert.equal(r.status, 201); assert.equal(r.data.images.length, 4); assert.deepEqual(openaiCalls.map(c => c.n), [1, 1, 1, 1]);
  await call(owner, '/api/admin/images', 'PUT', { batchMode: 'native' });
});

test('绘画：本机 Stable Diffusion WebUI（/sdapi/v1/txt2img）——批量、尺寸、检查点、Basic 鉴权', async () => {
  const saved = await call(owner, '/api/admin/images', 'PUT', settings({ baseUrl: `http://127.0.0.1:${mockPort}`, dialect: 'a1111', model: 'v1-5-pruned.safetensors', apiKey: 'user:pass', maxPerRequest: 4, sizes: '512x512 768x512', defaultSize: '512x512' }));
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const r = await call(owner, '/api/images', 'POST', { prompt: '一只猫', size: '768x512', n: 3, negative: '模糊' });
  assert.equal(r.status, 201, JSON.stringify(r.data)); assert.equal(r.data.images.length, 3);
  assert.equal(lastA1111.width, 768); assert.equal(lastA1111.height, 512); assert.equal(lastA1111.batch_size, 3); assert.equal(lastA1111.negative_prompt, '模糊');
  assert.equal(lastA1111.override_settings.sd_model_checkpoint, 'v1-5-pruned.safetensors');
  assert.equal(lastA1111.auth, 'Basic ' + Buffer.from('user:pass').toString('base64'));
  assert.equal((await call(owner, '/api/admin/images', 'PUT', { model: '' })).status, 200, 'SD WebUI 可以不填模型，用当前加载的');
});

test('绘画：本机 ComfyUI——默认工作流、占位符替换、轮询、取图；自定义工作流', async () => {
  assert.equal((await call(owner, '/api/admin/images', 'PUT', settings({ baseUrl: `http://127.0.0.1:${mockPort}`, dialect: 'comfyui', model: '' }))).status, 400, 'ComfyUI 必须填检查点名称');
  await call(owner, '/api/admin/images', 'PUT', settings({ baseUrl: `http://127.0.0.1:${mockPort}`, dialect: 'comfyui', model: 'sd_xl_base_1.0.safetensors', apiKey: '', maxPerRequest: 4, sizes: '1024x1024', defaultSize: '1024x1024', workflow: '' }));
  let r = await call(owner, '/api/images', 'POST', { prompt: '夜樱\n"引号"', size: '1024x1024', n: 2, negative: '低质量' });
  assert.equal(r.status, 201, JSON.stringify(r.data)); assert.equal(r.data.images.length, 2);
  const wf = lastComfy.prompt;
  assert.equal(wf[4].inputs.ckpt_name, 'sd_xl_base_1.0.safetensors'); assert.equal(wf[5].inputs.width, 1024); assert.equal(wf[5].inputs.height, 1024); assert.equal(wf[5].inputs.batch_size, 2);
  assert.equal(typeof wf[3].inputs.seed, 'number'); assert.equal(wf[6].inputs.text, '夜樱\n"引号"', '提示词原样进入工作流，不会破坏 JSON'); assert.equal(wf[7].inputs.text, '低质量');
  assert.ok(historyCalls >= 3, '轮询到任务完成才取图');
  const custom = JSON.stringify({ 5: { class_type: 'EmptyLatentImage', inputs: { width: '{{width}}', height: '{{height}}', batch_size: '{{batch}}' } }, 6: { class_type: 'CLIPTextEncode', inputs: { text: '杰作, {{prompt}}, 模型{{model}}' } }, 9: { class_type: 'SaveImage', inputs: { images: ['6', 0] } } });
  await call(owner, '/api/admin/images', 'PUT', { workflow: custom });
  r = await call(owner, '/api/images', 'POST', { prompt: '星空', n: 1 });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(lastComfy.prompt[6].inputs.text, '杰作, 星空, 模型sd_xl_base_1.0.safetensors');
  await call(owner, '/api/admin/images', 'PUT', { workflow: '', dialect: 'openai' });
});
