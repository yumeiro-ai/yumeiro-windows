import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRunner, resolveInWorkspace, baseChildEnv, filterEngineEnv } from '../runner/runner.mjs';
import { runSelfCheck, CHILD_ENV_ALLOWED, CHILD_ENV_BASE } from '../runner/selfcheck.mjs';

const mock = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mock-agent.mjs');
const TOKEN = 'runner-token-1234567890';
const versions = { claude: 'claude 1.0', codex: 'codex 1.0', pi: 'pi 1.0' };
const find = (result, id) => result.checks.find(c => c.id === id);

// 一份“什么都没问题”的环境；每个用例只改其中一项
async function baseline(overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'selfcheck-'));
  const deps = { platform: 'linux', getuid: () => 10001, homedir: () => '/home/agent', access: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
    readdir: async () => ['runner_token'], exists: async () => true,
    readFile: async file => file.endsWith('status') ? 'CapEff:\t0000000000000000\nNoNewPrivs:\t1\n' : 'overlay / overlay ro,relatime 0 0\n', ...(overrides.deps || {}) };
  const run = () => runSelfCheck({ root, env: { PATH: '/usr/bin', RUNNER_TOKEN: TOKEN, ...(overrides.env || {}) }, versions, tools: { npx: true, uvx: true }, resolveInWorkspace, baseChildEnv, filterEngineEnv, deps, ...(overrides.ctx || {}) });
  return { root, run, cleanup: () => rm(root, { recursive: true, force: true }).catch(() => {}) };
}

test('一切正常时，自检全部通过', async () => {
  const t = await baseline(); const r = await t.run(); await t.cleanup();
  assert.equal(r.ok, true); assert.equal(r.summary.fail, 0);
  for (const id of ['engine.claude.installed', 'engine.codex.installed', 'engine.pi.installed', 'engine.claude.home', 'engine.workspace', 'iso.user', 'iso.env', 'iso.childEnv', 'iso.paths', 'iso.workspace', 'iso.privileges', 'iso.rootfs']) assert.equal(find(r, id)?.status, 'ok', id);
});

test('引擎没装好会报失败，并给出怎么办', async () => {
  const t = await baseline({ ctx: { versions: { claude: 'claude 1.0', codex: null, pi: 'pi 1.0' } } }); const r = await t.run(); await t.cleanup();
  assert.equal(r.ok, false); const c = find(r, 'engine.codex.installed');
  assert.equal(c.status, 'fail'); assert.match(c.fix, /重新构建运行器镜像/);
});

test('以 root 运行会报失败；没有用户编号的系统会跳过', async () => {
  let t = await baseline({ deps: { getuid: () => 0, platform: 'linux' } }); let r = await t.run(); await t.cleanup();
  assert.equal(find(r, 'iso.user').status, 'fail');
  t = await baseline({ deps: { getuid: undefined, platform: 'freebsd' } }); r = await t.run(); await t.cleanup();
  assert.equal(find(r, 'iso.user').status, 'skip'); assert.equal(find(r, 'iso.privileges').status, 'skip');
});

test('Windows：以管理员 / SYSTEM 运行会报失败，普通账号通过，读不到组信息就跳过；并说明隔离方式', async () => {
  const groups = level => `GROUP INFORMATION\r\nMandatory Label\\${level}  Label  S-1-16-${{ high: 12288, medium: 8192, system: 16384 }[level.toLowerCase().split(' ')[0]] || 8192}  Mandatory group`;
  const run = async winGroups => { const t = await baseline({ deps: { platform: 'win32', getuid: undefined, winGroups: async () => winGroups } }); const r = await t.run(); await t.cleanup(); return r; };
  assert.equal(find(await run(groups('High Mandatory Level')), 'iso.user').status, 'fail');
  assert.equal(find(await run(groups('System Mandatory Level')), 'iso.user').status, 'fail');
  assert.equal(find(await run(groups('Medium Mandatory Level')), 'iso.user').status, 'ok');
  const unknown = await run(null);
  assert.equal(find(unknown, 'iso.user').status, 'skip'); assert.equal(find(unknown, 'iso.win').status, 'info'); assert.equal(find(unknown, 'iso.privileges'), undefined);
});

test('RUNNER_FORBIDDEN_PATHS 里列出的位置（Windows 版的数据 / 密钥目录）一旦读得到就报失败', async () => {
  const readable = new Set();
  const access = async p => { if (!readable.has(p)) throw new Error('denied'); };
  const env = { RUNNER_FORBIDDEN_PATHS: 'C:\\ProgramData\\Yumeiro\\secrets; C:\\ProgramData\\Yumeiro\\data' };
  let t = await baseline({ env, deps: { access, platform: 'win32', winGroups: async () => null } }); let r = await t.run(); await t.cleanup();
  assert.equal(find(r, 'iso.paths').status, 'ok'); assert.match(find(r, 'iso.paths').detail, /已检查 3 个位置/);
  readable.add('C:\\ProgramData\\Yumeiro\\secrets');
  t = await baseline({ env, deps: { access, platform: 'win32', winGroups: async () => null } }); r = await t.run(); await t.cleanup();
  assert.equal(find(r, 'iso.paths').status, 'fail'); assert.match(find(r, 'iso.paths').detail, /secrets/);
});

test('运行器进程里带着主服务密钥类变量会警告，只列名字、不泄露值', async () => {
  const t = await baseline({ env: { STORE_ENCRYPTION_KEY: 'super-secret-value-123', ADMIN_PASSWORD: 'another-secret-456', SANDBOX_TOKEN: 'x'.repeat(20) } }); const r = await t.run(); await t.cleanup();
  const c = find(r, 'iso.env'); assert.equal(c.status, 'warn');
  assert.match(c.detail, /STORE_ENCRYPTION_KEY/); assert.match(c.detail, /ADMIN_PASSWORD/); assert.doesNotMatch(c.detail, /SANDBOX_TOKEN/); // 运行器自己的令牌不算
  assert.ok(!JSON.stringify(r).includes('super-secret-value-123') && !JSON.stringify(r).includes('another-secret-456'));
});

test('传给引擎的环境变量：基础环境最小，额外变量只放行模型相关的', async () => {
  const env = baseChildEnv({ PATH: '/usr/bin', STORE_ENCRYPTION_KEY: 'x', ADMIN_PASSWORD: 'x', NODE_OPTIONS: '--x', RUNNER_TOKEN: 'x' }, '/w', 'claude', 'linux');
  assert.deepEqual(Object.keys(env).sort(), [...CHILD_ENV_BASE].sort()); assert.equal(env.HOME, path.join('/w', '.home', 'claude'));
  const winEnv = baseChildEnv({ PATH: 'C:\\n', SystemRoot: 'C:\\Windows', STORE_ENCRYPTION_KEY: 'x', ADMIN_PASSWORD: 'x', NODE_OPTIONS: '--x', RUNNER_TOKEN: 'x' }, 'C:\\w', 'claude', 'win32');
  assert.ok(Object.keys(winEnv).every(k => CHILD_ENV_ALLOWED.includes(k)), 'Windows 的基础环境只能出现允许的变量'); assert.equal(winEnv.SystemRoot, 'C:\\Windows');
  assert.ok(!('STORE_ENCRYPTION_KEY' in winEnv) && !('ADMIN_PASSWORD' in winEnv) && !('NODE_OPTIONS' in winEnv) && !('RUNNER_TOKEN' in winEnv));
  assert.ok(winEnv.USERPROFILE.startsWith('C:\\w') && winEnv.TEMP.startsWith('C:\\w'), '用户目录和临时目录都在引擎自己的目录里');
  assert.deepEqual(filterEngineEnv({ PATH: '/evil', NODE_OPTIONS: '--x', LD_PRELOAD: 'x', ADMIN_PASSWORD: 'x', ANTHROPIC_API_KEY: 'sk', OPENAI_BASE_URL: 'https://a.example', BIG_API_KEY: 'x'.repeat(5000) }), { ANTHROPIC_API_KEY: 'sk', OPENAI_BASE_URL: 'https://a.example' });
  // 如果有人把过滤函数改松了，自检必须报失败
  const t = await baseline({ ctx: { filterEngineEnv: extra => ({ ...extra }) } }); const r = await t.run(); await t.cleanup();
  assert.equal(find(r, 'iso.childEnv').status, 'fail');
  const t2 = await baseline({ ctx: { baseChildEnv: (e, root, engine) => ({ ...e, HOME: root + engine }) } }); const r2 = await t2.run(); await t2.cleanup();
  assert.equal(find(r2, 'iso.childEnv').status, 'fail');
});

test('能访问 Docker 控制口、读到别的密钥文件、读到主服务数据，都会报失败', async () => {
  const readable = new Set();
  const access = async p => { if (!readable.has(p)) throw new Error('denied'); };
  let t = await baseline({ deps: { access } }); readable.add('/var/run/docker.sock'); let r = await t.run(); await t.cleanup();
  assert.equal(find(r, 'iso.paths').status, 'fail'); assert.match(find(r, 'iso.paths').title, /Docker/);
  readable.clear(); readable.add('/var/lib/yumeiro'); t = await baseline({ deps: { access } }); r = await t.run(); await t.cleanup();
  assert.equal(find(r, 'iso.paths').status, 'fail'); assert.match(find(r, 'iso.paths').detail, /\/var\/lib\/yumeiro/);
  readable.clear(); t = await baseline({ deps: { access, readdir: async () => ['runner_token', 'store_encryption_key', 'admin_password'] } }); r = await t.run(); await t.cleanup();
  assert.equal(find(r, 'iso.paths').status, 'fail'); assert.match(find(r, 'iso.paths').detail, /store_encryption_key/); assert.match(find(r, 'iso.paths').detail, /admin_password/);
  assert.doesNotMatch(find(r, 'iso.paths').detail, /runner_token/); // 运行器自己的令牌本来就该能读
});

test('工作区：真实的路径解析会拒绝各种逃逸写法；被改松了会报失败', async () => {
  let t = await baseline(); let r = await t.run(); await t.cleanup();
  assert.equal(find(r, 'iso.workspace').status, 'ok');
  t = await baseline({ ctx: { resolveInWorkspace: async (root, id, rel) => ({ real: root, target: path.join(root, rel) }) } }); r = await t.run(); await t.cleanup();
  assert.equal(find(r, 'iso.workspace').status, 'fail'); assert.match(find(r, 'iso.workspace').detail, /上级目录/);
  // 自检不留垃圾：跑完工作区根目录里不应该剩下 selfcheck-* 目录
  t = await baseline(); await t.run(); const left = (await readdir(t.root)).filter(n => n.startsWith('selfcheck-')); await t.cleanup();
  assert.deepEqual(left, []);
});

test('系统权限：接近特权的会失败，有少量会警告，没有禁止提权会警告', async () => {
  const status = (cap, nnp) => async file => file.endsWith('status') ? `CapEff:\t${cap}\nNoNewPrivs:\t${nnp}\n` : 'overlay / overlay rw 0 0\n';
  let t = await baseline({ deps: { readFile: status('000001ffffffffff', 1) } }); let r = await t.run(); await t.cleanup();
  assert.equal(find(r, 'iso.privileges').status, 'fail'); assert.equal(find(r, 'iso.rootfs').status, 'info');
  t = await baseline({ deps: { readFile: status('00000000000004c0', 1) } }); r = await t.run(); await t.cleanup();
  assert.equal(find(r, 'iso.privileges').status, 'warn');
  t = await baseline({ deps: { readFile: status('0000000000000000', 0) } }); r = await t.run(); await t.cleanup();
  assert.equal(find(r, 'iso.privileges').status, 'warn'); assert.match(find(r, 'iso.privileges').detail, /没有禁止提权/);
});

test('代码沙箱：配置了但连不上会警告；没配置只是提示', async () => {
  let t = await baseline({ env: { SANDBOX_URL: 'http://sandbox:8790' }, ctx: { sandboxHealth: async () => ({ ok: true, languages: { python: { installed: true }, go: { installed: false } } }) } }); let r = await t.run(); await t.cleanup();
  assert.equal(find(r, 'iso.sandbox').status, 'ok'); assert.match(find(r, 'iso.sandbox').detail, /python/); assert.doesNotMatch(find(r, 'iso.sandbox').detail, /go/);
  t = await baseline({ env: { SANDBOX_URL: 'http://sandbox:8790' }, ctx: { sandboxHealth: async () => { throw new Error('ECONNREFUSED'); } } }); r = await t.run(); await t.cleanup();
  assert.equal(find(r, 'iso.sandbox').status, 'warn');
  t = await baseline(); r = await t.run(); await t.cleanup();
  assert.equal(find(r, 'iso.sandbox').status, 'info');
});

test('运行器 /selfcheck：需要令牌；结果里没有任何密钥；检查项齐全', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'runner-sc-'));
  const env = { ...process.env, STORE_ENCRYPTION_KEY: 'leak-me-not-98765', CLAUDE_CMD: `${process.execPath} ${mock} --engine=claude`, CODEX_CMD: `${process.execPath} ${mock} --engine=codex`, PI_CMD: `${process.execPath} ${mock} --engine=pi` };
  const server = createRunner({ token: TOKEN, root, env });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    assert.equal((await fetch(base + '/selfcheck')).status, 401);
    assert.equal((await fetch(base + '/selfcheck', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    const response = await fetch(base + '/selfcheck', { headers: { Authorization: 'Bearer ' + TOKEN } });
    assert.equal(response.status, 200);
    const text = await response.text(), r = JSON.parse(text);
    assert.ok(!text.includes('leak-me-not-98765') && !text.includes(TOKEN), '结果里不能出现任何密钥或令牌');
    assert.equal(find(r, 'engine.claude.installed').status, 'ok'); assert.equal(find(r, 'engine.pi.installed').status, 'ok');
    assert.equal(find(r, 'iso.childEnv').status, 'ok'); assert.equal(find(r, 'iso.workspace').status, 'ok');
    assert.equal(find(r, 'iso.env').status, 'warn'); // 这个测试进程故意带了 STORE_ENCRYPTION_KEY
    assert.ok(r.summary && r.at);
  } finally { server.close(); server.closeAllConnections?.(); await rm(root, { recursive: true, force: true }).catch(() => {}); }
});
