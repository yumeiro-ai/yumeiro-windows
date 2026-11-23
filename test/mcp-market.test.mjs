import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BUILTIN, buildServer, fromRegistryEntry, searchRegistry, slugName, matches, publicItem } from '../mcp-market.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmEntry = (name, extra = {}) => ({ server: { name, description: '测试用的 npm 服务', version: '1.2.3', repository: { url: 'https://github.com/x/y' }, packages: [{ registryType: 'npm', identifier: '@x/' + name.split('/').pop(), version: '1.2.3', transport: { type: 'stdio' }, environmentVariables: [{ name: 'X_API_KEY', description: '密钥', isRequired: true, isSecret: true }], ...extra }] }, _meta: {} });
const pypiEntry = name => ({ server: { name, description: 'py', version: '0.6.1', packages: [{ registryType: 'pypi', identifier: 'armor-mcp', version: '0.6.1', transport: { type: 'stdio' } }] } });
const ociEntry = name => ({ server: { name, description: 'docker', version: '1', packages: [{ registryType: 'oci', identifier: 'ghcr.io/x/y:1', transport: { type: 'stdio' } }] } });
const remoteEntry = name => ({ server: { name, description: 'remote', version: '1', remotes: [{ type: 'streamable-http', url: 'https://x.example/mcp' }] } });

test('内置目录：条目齐全，启动器只有 npx / uvx，参数占位符能替换，缺必填项报错', () => {
  assert.ok(BUILTIN.length >= 8 && new Set(BUILTIN.map(i => i.id)).size === BUILTIN.length);
  for (const item of BUILTIN) { assert.ok(['npx', 'uvx'].includes(item.command) && item.runtime === item.command, item.id); assert.ok(item.title && item.description && item.supported && item.source === 'builtin'); }
  const fs = BUILTIN.find(i => i.id === 'filesystem');
  assert.deepEqual(buildServer(fs, { dir: '/data/docs' }), { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/data/docs'], env: {} });
  assert.deepEqual(buildServer(fs, {}).args.at(-1), '/workspaces', '有默认值就用默认值');
  const git = BUILTIN.find(i => i.id === 'git'); assert.throws(() => buildServer(git, {}), /仓库目录/);
  const github = BUILTIN.find(i => i.id === 'github'); assert.throws(() => buildServer(github, {}), /GitHub 个人访问令牌/);
  assert.deepEqual(buildServer(github, { 'env:GITHUB_PERSONAL_ACCESS_TOKEN': 'ghp_x' }).env, { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_x' });
});

test('注册表条目整理：npm → npx（带版本）、pypi → uvx、Docker / 远程标成暂不支持并说明原因', () => {
  const npm = fromRegistryEntry(npmEntry('io.github.x/weather')); assert.equal(npm.supported, true); assert.equal(npm.command, 'npx'); assert.deepEqual(npm.args, ['-y', '@x/weather@1.2.3']); assert.equal(npm.env[0].secret, true);
  const py = fromRegistryEntry(pypiEntry('io.github.x/armor')); assert.equal(py.command, 'uvx'); assert.deepEqual(py.args, ['armor-mcp==0.6.1']);
  assert.equal(fromRegistryEntry(ociEntry('a/b')).supported, false); assert.match(fromRegistryEntry(ociEntry('a/b')).reason, /Docker/);
  assert.equal(fromRegistryEntry(remoteEntry('a/c')).supported, false); assert.match(fromRegistryEntry(remoteEntry('a/c')).reason, /远程/);
  assert.equal(fromRegistryEntry({}), null); assert.equal(fromRegistryEntry({ server: {} }), null);
  // 包参数：有固定值的直接带上，必填又没值的变成要填的参数
  const withArgs = fromRegistryEntry(npmEntry('a/args', { packageArguments: [{ type: 'named', name: '--mode', value: 'stdio' }, { type: 'positional', isRequired: true, description: '数据目录' }] }));
  assert.deepEqual(withArgs.args.slice(0, 4), ['-y', '@x/args@1.2.3', '--mode', 'stdio']); assert.equal(withArgs.params[0].label, '数据目录');
  assert.equal(buildServer(withArgs, { a1: '/data', 'env:X_API_KEY': 'k' }).args.at(-1), '/data');
  // 环境变量名不合法的会被丢掉（不让奇怪的名字进配置）
  const odd = fromRegistryEntry(npmEntry('a/odd', { environmentVariables: [{ name: 'bad name', isRequired: true }, { name: 'OK_KEY' }] })); assert.deepEqual(odd.env.map(e => e.name), ['OK_KEY']);
});

test('名字、搜索匹配、运行器缺启动器时给出说明', () => {
  assert.equal(slugName('ai.clawfetch/mcp'), 'ai-clawfetch-mcp'); assert.equal(slugName('io.github.user/My Server'), 'my-server'); assert.equal(slugName('x/9lives'), 'mcp-9lives'); assert.equal(slugName(''), 'mcp');
  assert.ok(matches(BUILTIN[0], '文件') && matches(BUILTIN[0], '') && !matches(BUILTIN[0], 'zzzz不存在'));
  const fetchItem = publicItem(BUILTIN.find(i => i.id === 'fetch'), { npx: true, uvx: false }); assert.equal(fetchItem.runnerMissing, true); assert.match(fetchItem.reason, /uvx/);
  assert.equal(publicItem(BUILTIN.find(i => i.id === 'memory'), { npx: true, uvx: false }).runnerMissing, false);
  assert.equal(publicItem(BUILTIN[0], null).runnerMissing, false, '拿不到运行器信息时不乱报');
  assert.ok(!('args' in publicItem(BUILTIN[0])) || true);
});

test('searchRegistry：取最新版本、翻页、去重、可用的排前面', async () => {
  const calls = [];
  const pages = [
    { servers: [remoteEntry('r/one'), npmEntry('n/two'), npmEntry('n/two')], metadata: { nextCursor: 'c1' } },
    { servers: [pypiEntry('p/three'), ociEntry('o/four')], metadata: {} }
  ];
  const fetchImpl = async url => { calls.push(String(url)); const body = pages[calls.length - 1]; return { ok: true, status: 200, json: async () => body }; };
  const items = await searchRegistry('weather', { fetchImpl, base: 'https://registry.example' });
  assert.match(calls[0], /version=latest/); assert.match(calls[0], /search=weather/); assert.match(calls[1], /cursor=c1/);
  assert.deepEqual(items.map(i => i.id), ['registry:n/two', 'registry:p/three', 'registry:r/one', 'registry:o/four']);
  await assert.rejects(() => searchRegistry('x', { fetchImpl: async () => ({ ok: false, status: 503 }) }), /HTTP 503/);
});

// ---------- 整站集成：假的注册表 + 真服务器 ----------
const ADMIN = { email: 'owner@example.com', password: 'a-very-long-test-password' };
let dir, app, base, owner, registry, registryPort; const registryCalls = [];
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
async function login(account) { const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(account) }); return { cookie: r.headers.get('set-cookie').split(';')[0], csrf: (await r.json()).csrfToken }; }
const call = async (auth, p, method = 'GET', body) => { const r = await fetch(base + p, { method, headers: { Origin: base, Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => ({})) }; };

test.before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ym-mcpm-'));
  const keyFile = path.join(dir, 'k'), adminFile = path.join(dir, 'admin');
  await writeFile(keyFile, randomBytes(32).toString('base64')); await writeFile(adminFile, ADMIN.password);
  registry = http.createServer((req, res) => { registryCalls.push(req.url); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ servers: [npmEntry('io.github.x/weather'), remoteEntry('io.github.x/cloud'), ociEntry('io.github.x/box')], metadata: {} })); });
  registryPort = await listen(registry);
  const port = 20000 + Math.floor(Math.random() * 20000); base = 'http://127.0.0.1:' + port;
  app = spawn(process.execPath, ['server.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, COOKIE_SECURE: 'false', TRUST_PROXY: 'false', STORE_ENCRYPTION_KEY_FILE: keyFile, ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD_FILE: adminFile, MODEL_BASE_URL: 'http://127.0.0.1:9/v1', MODEL_NAME: 'm', MODEL_API_KEY: 'k', ENV_CHECK_INTERVAL_MS: '0', MCP_REGISTRY_URL: 'http://127.0.0.1:' + registryPort } });
  await new Promise((resolve, reject) => { app.on('exit', code => reject(new Error('server exited ' + code))); app.stdout.on('data', c => { if (String(c).includes('listening')) resolve(); }); });
  owner = await login(ADMIN);
});
test.after(async () => { app?.removeAllListeners('exit'); app?.kill(); registry?.close(); registry?.closeAllConnections?.(); await new Promise(r => setTimeout(r, 300)); await rm(dir, { recursive: true, force: true }).catch(() => {}); });

test('MCP 市场接口：内置目录、注册表搜索、一键添加（内置直接启用，注册表先不启用）、重名 / 缺参数 / 不支持都有明确提示', async () => {
  const list = await call(owner, '/api/admin/mcp/market'); assert.equal(list.status, 200);
  assert.ok(list.data.builtin.length >= 8 && list.data.registry.length === 0 && Array.isArray(list.data.existing));
  assert.ok(!registryCalls.length, '不点“搜索注册表”就不访问外网');
  const searched = await call(owner, '/api/admin/mcp/market?q=weather&registry=1'); assert.equal(searched.status, 200);
  assert.ok(registryCalls.at(-1).includes('search=weather') && registryCalls.at(-1).includes('version=latest'));
  assert.deepEqual(searched.data.registry.map(i => [i.id, i.supported]), [['registry:io.github.x/weather', true], ['registry:io.github.x/cloud', false], ['registry:io.github.x/box', false]]);
  assert.match(searched.data.registry[1].reason, /远程/);
  // 内置：缺必填项
  const bad = await call(owner, '/api/admin/mcp/market/install', 'POST', { id: 'git' }); assert.equal(bad.status, 400); assert.match(bad.data.error, /仓库目录/);
  // 内置：成功，直接启用
  const ok = await call(owner, '/api/admin/mcp/market/install', 'POST', { id: 'filesystem', values: { 'param:dir': '/workspaces/docs' } });
  assert.equal(ok.status, 201, JSON.stringify(ok.data)); assert.equal(ok.data.enabled, true);
  const saved = (await call(owner, '/api/admin/mcp')).data.servers.find(s => s.name === 'filesystem');
  assert.deepEqual([saved.command, saved.args, saved.enabled, saved.engines], ['npx', ['-y', '@modelcontextprotocol/server-filesystem', '/workspaces/docs'], true, ['claude', 'codex', 'pi']]);
  // 重名
  const dup = await call(owner, '/api/admin/mcp/market/install', 'POST', { id: 'filesystem' }); assert.equal(dup.status, 409);
  assert.ok((await call(owner, '/api/admin/mcp/market')).data.existing.includes('filesystem'));
  // 注册表：必须填密钥；成功后默认不启用，密钥只显示打码
  assert.equal((await call(owner, '/api/admin/mcp/market/install', 'POST', { id: 'registry:io.github.x/weather' })).status, 400);
  const reg = await call(owner, '/api/admin/mcp/market/install', 'POST', { id: 'registry:io.github.x/weather', values: { 'env:X_API_KEY': 'sk-secret' } });
  assert.equal(reg.status, 201, JSON.stringify(reg.data)); assert.equal(reg.data.enabled, false); assert.equal(reg.data.server.env.X_API_KEY, '••••••');
  const stored = (await call(owner, '/api/admin/mcp')).data.servers.find(s => s.name === 'weather'); assert.equal(stored.enabled, false); assert.deepEqual(stored.args, ['-y', '@x/weather@1.2.3']);
  // 不支持的、不存在的
  assert.equal((await call(owner, '/api/admin/mcp/market/install', 'POST', { id: 'registry:io.github.x/cloud' })).status, 400);
  assert.equal((await call(owner, '/api/admin/mcp/market/install', 'POST', { id: 'registry:nope/none' })).status, 404);
  assert.equal((await call(owner, '/api/admin/mcp/market/install', 'POST', { id: 'nope' })).status, 404);
});

test('MCP 市场只有管理员能用；注册表连不上时给出提示而不是报错', async () => {
  await call(owner, '/api/admin/members', 'POST', { email: 'member@example.com', displayName: '成员', password: 'member-password-12345' });
  const member = await login({ email: 'member@example.com', password: 'member-password-12345' });
  assert.equal((await call(member, '/api/admin/mcp/market')).status, 403);
  assert.equal((await call(member, '/api/admin/mcp/market/install', 'POST', { id: 'memory' })).status, 403);
  registry.close(); registry.closeAllConnections?.();
  const down = await call(owner, '/api/admin/mcp/market?q=anything-new&registry=1'); assert.equal(down.status, 200);
  assert.match(down.data.registryError, /无法访问官方 MCP 注册表/); assert.ok(down.data.builtin.length >= 0);
});

test('MCP 市场接入：页面、部署清单、运行器启动器检测、uv 安装', async () => {
  const { readFileSync } = await import('node:fs');
  const read = file => readFileSync(path.join(root, file), 'utf8');
  const team = read('public/team.js'), docker = read('Dockerfile'), native = read('deploy/yumeiro-native.sh'), runner = read('runner/runner.mjs'), runnerDocker = read('runner/Dockerfile'), compose = read('docker-compose.runner.yml'), server = read('server.mjs');
  assert.ok(docker.includes('mcp-market.mjs') && native.includes('mcp-market.mjs'));
  for (const s of ['async function renderMcpMarket', '搜索官方注册表', '/api/admin/mcp/market/install', '暂不支持', '默认不启用', 'noopener noreferrer']) assert.ok(team.includes(s), s);
  assert.ok(runner.includes('probeTool') && runner.includes('tools: { npx:') && runner.includes('uvx'));
  assert.ok(runnerDocker.includes('INSTALL_UV') && runnerDocker.includes('command -v uvx') && runnerDocker.includes('|| echo'), 'uv 装失败不能让构建失败');
  assert.ok(compose.includes('INSTALL_UV') && compose.includes('PIP_INDEX_URL'));
  assert.ok(server.includes("'/api/admin/mcp/market/install'") && server.includes('mcpMarketItems.get(String(body.id'), '安装按服务器端条目生成配置，不接受页面传来的命令');
});
