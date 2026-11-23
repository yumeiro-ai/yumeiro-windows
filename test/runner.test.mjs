import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, rm, symlink, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRunner, buildInvocation, resolveInWorkspace } from '../runner/runner.mjs';

const mock = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mock-agent.mjs');
const TOKEN = 'runner-token-1234567890';
let root, server, base;

test.before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'runner-'));
  const env = { ...process.env, CLAUDE_CMD: `${process.execPath} ${mock} --engine=claude`, CODEX_CMD: `${process.execPath} ${mock} --engine=codex`, PI_CMD: `${process.execPath} ${mock} --engine=pi`, RUNNER_MIN_TIMEOUT_SEC: '1' };
  server = createRunner({ token: TOKEN, root, env });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(async () => { server.close(); server.closeAllConnections?.(); await rm(root, { recursive: true, force: true }).catch(() => {}); });

const headers = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
async function run(body) {
  const response = await fetch(base + '/run', { method: 'POST', headers, body: JSON.stringify({ workspace: 'ws-1', ...body }) });
  if (!response.ok) return { status: response.status, events: [], body: await response.json() };
  const events = (await response.text()).split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { status: 200, events, end: events.at(-1), text: events.filter(e => e.type === 'text').map(e => e.text).join('') };
}

test('需要令牌；health 报告各引擎是否安装', async () => {
  assert.equal((await fetch(base + '/health')).status, 401);
  assert.equal((await fetch(base + '/health', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  const health = await (await fetch(base + '/health', { headers })).json();
  assert.deepEqual(Object.keys(health.engines).sort(), ['claude', 'codex', 'pi']);
  assert.equal(health.engines.claude.installed, true);
  assert.match(health.engines.pi.version, /mock/);
});

test('claude：流式文本、工具事件、用量；readonly 只给读取类工具，edit 禁用 Bash', async () => {
  const readonly = await run({ engine: 'claude', prompt: '你好', mode: 'readonly', model: 'sonnet', system: '简洁', env: { ANTHROPIC_API_KEY: 'sk-test', NODE_OPTIONS: '--require x', PATH: '/evil' } });
  assert.equal(readonly.text, '你好，我是 claude');
  assert.ok(readonly.events.some(e => e.type === 'tool' && e.name === 'Read'));
  assert.equal(readonly.end.status, 'completed');
  assert.deepEqual(readonly.end.usage, { inputTokens: 11, outputTokens: 7 });
  const echoed = JSON.parse(readonly.end.final);
  assert.ok(echoed.args.includes('--allowedTools') && echoed.args.includes('Read Grep Glob'));
  assert.ok(echoed.args.includes('--output-format') && echoed.args.includes('stream-json'));
  assert.deepEqual(echoed.args.slice(echoed.args.indexOf('--model'), echoed.args.indexOf('--model') + 2), ['--model', 'sonnet']);
  assert.equal(echoed.key, 'sk-test');
  assert.equal(echoed.nodeOptions, null, '非模型相关的环境变量必须被丢弃');
  assert.ok(echoed.cwd.endsWith('ws-1'));
  assert.ok(echoed.home.includes('.home'));

  const edit = JSON.parse((await run({ engine: 'claude', prompt: 'x', mode: 'edit' })).end.final);
  assert.ok(edit.args.includes('acceptEdits') && edit.args.includes('--disallowedTools') && edit.args.includes('Bash'));
});

test('codex：JSON 事件解析；沙箱模式随 mode 变化', async () => {
  const result = await run({ engine: 'codex', prompt: '干活', mode: 'readonly', env: { OPENAI_API_KEY: 'sk-o' } });
  assert.ok(result.events.some(e => e.type === 'tool' && e.name === 'shell'));
  const echoed = JSON.parse(result.end.final);
  assert.equal(echoed.args[echoed.args.indexOf('-s') + 1], 'read-only');
  assert.equal(echoed.key, 'sk-o');
  assert.equal(result.end.usage.inputTokens, 5);
  const edit = JSON.parse((await run({ engine: 'codex', prompt: 'x', mode: 'edit' })).end.final);
  assert.equal(edit.args[edit.args.indexOf('-s') + 1], 'workspace-write');
});

test('pi：文本模式；edit 也不开放 bash', async () => {
  const result = await run({ engine: 'pi', prompt: '你好', mode: 'edit', provider: 'anthropic', model: 'claude-x' });
  const echoed = JSON.parse(result.end.final);
  assert.equal(echoed.args[echoed.args.indexOf('--tools') + 1], 'read,edit,write,grep,find,ls');
  assert.ok(!echoed.args.join(',').includes('bash'));
  assert.ok(echoed.args.includes('--no-session'));
  const readonly = JSON.parse((await run({ engine: 'pi', prompt: 'x', mode: 'readonly' })).end.final);
  assert.equal(readonly.args[readonly.args.indexOf('--tools') + 1], 'read,grep,find,ls');
});

test('失败、超时、参数校验', async () => {
  const failed = await run({ engine: 'claude', prompt: 'FAIL' });
  assert.equal(failed.end.status, 'failed');
  assert.match(failed.end.error, /boom from claude/);
  const started = Date.now();
  const slow = await run({ engine: 'pi', prompt: 'SLEEP', timeoutSec: 1 });
  assert.equal(slow.end.status, 'timeout');
  assert.ok(Date.now() - started < 8000);
  assert.equal((await run({ engine: 'bash', prompt: 'x' })).status, 400);
  assert.equal((await run({ engine: 'pi', prompt: '  ' })).status, 400);
  assert.equal((await run({ engine: 'pi', prompt: 'x', workspace: '../etc' })).status, 400);
});

test('文件接口：写入、列目录、读取、删除，路径越界被拒', async () => {
  const f = (method, query, body) => fetch(base + '/files?' + new URLSearchParams(query), { method, headers: { Authorization: 'Bearer ' + TOKEN }, body });
  assert.equal((await f('PUT', { workspace: 'ws-2', path: 'src/a.txt' }, 'hello')).status, 200);
  const dir = await (await f('GET', { workspace: 'ws-2', path: 'src' })).json();
  assert.deepEqual(dir.entries.map(e => e.name), ['a.txt']);
  assert.equal((await (await f('GET', { workspace: 'ws-2', path: 'src/a.txt' })).json()).content, 'hello');
  assert.equal((await f('GET', { workspace: 'ws-2', path: '../ws-1' })).status, 400);
  assert.equal((await f('PUT', { workspace: 'ws-2', path: '../../x' }, 'x')).status, 400);
  assert.equal((await f('GET', { workspace: 'ws-2', path: '/etc/passwd' })).status, 400);
  assert.equal((await f('GET', { workspace: 'ws-2', path: 'nope.txt' })).status, 404);
  assert.equal((await f('DELETE', { workspace: 'ws-2', path: 'src' })).status, 200);
  assert.equal((await f('GET', { workspace: 'ws-2', path: 'src' })).status, 404);

  // 智能体在 edit 模式下写出的文件能被读到
  await run({ workspace: 'ws-2', engine: 'pi', prompt: 'WRITE:out.txt', mode: 'edit' });
  assert.equal((await (await f('GET', { workspace: 'ws-2', path: 'out.txt' })).json()).content, 'written by pi');
  assert.equal((await f('DELETE', { workspace: 'ws-2' }, undefined).then(r => r.status)), 400);
  assert.equal((await fetch(base + '/workspace?workspace=ws-2', { method: 'DELETE', headers: { Authorization: 'Bearer ' + TOKEN } })).status, 200);
});

test('符号链接不能把读取带出工作区', async t => {
  const outside = await mkdtemp(path.join(tmpdir(), 'outside-'));
  await writeFile(path.join(outside, 'secret.txt'), 'top secret');
  await mkdir(path.join(root, 'ws-3'), { recursive: true });
  try { await symlink(outside, path.join(root, 'ws-3', 'link'), 'junction'); } catch { t.skip('当前系统不允许创建符号链接'); return; }
  await assert.rejects(resolveInWorkspace(root, 'ws-3', 'link/secret.txt'), /越界/);
  await rm(outside, { recursive: true, force: true });
});

test('buildInvocation 不会给任何引擎开放无限制 shell', () => {
  for (const engine of ['claude', 'codex', 'pi']) for (const mode of ['readonly', 'edit']) {
    const { args } = buildInvocation(engine, { prompt: 'p', mode, dir: '/w' });
    assert.ok(!args.includes('danger-full-access') && !args.includes('--dangerously-skip-permissions') && !args.includes('bypassPermissions'), engine + mode);
  }
});

// ---- verify.mjs：用模拟引擎验证“真实验证脚本”本身的判定逻辑 ----
import { spawn } from 'node:child_process';
const verifyScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'runner', 'verify.mjs');
function runVerify(url, env, args = []) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [verifyScript, ...args], { env: { ...process.env, RUNNER_URL: url, RUNNER_TOKEN: TOKEN, ...env } });
    let out = ''; child.stdout.on('data', c => { out += c; }); child.stderr.on('data', c => { out += c; });
    child.on('exit', code => resolve({ code, out }));
  });
}

test('verify.mjs：三个引擎都通过；没提供密钥的引擎被跳过', async () => {
  const all = await runVerify(base, { ANTHROPIC_API_KEY: 'k1', OPENAI_API_KEY: 'k2', PI_API_KEY: 'k3', PI_PROVIDER: 'anthropic' });
  assert.equal(all.code, 0, all.out);
  assert.equal((all.out.match(/✓ 能收到模型回复/g) || []).length, 3);
  assert.equal((all.out.match(/✓ 能在工作区创建文件/g) || []).length, 3);
  assert.equal((all.out.match(/✓ 只读模式不会写文件/g) || []).length, 3);
  assert.match(all.out, /9 项通过|12 项通过/);

  const partial = await runVerify(base, { ANTHROPIC_API_KEY: 'k1' });
  assert.equal(partial.code, 0, partial.out);
  assert.match(partial.out, /没有提供 OPENAI_API_KEY，跳过/);
  assert.equal((await runVerify(base, { ANTHROPIC_API_KEY: 'k1' }, ['--strict'])).code, 1);
});

test('verify.mjs：只读模式却写出了文件 → 失败；令牌错误/连不上 → 明确报错', async () => {
  const leaky = createRunner({ token: TOKEN, root, env: { ...process.env, CLAUDE_CMD: `${process.execPath} ${mock} --engine=claude --leak`, CODEX_CMD: `${process.execPath} ${mock} --engine=codex`, PI_CMD: `${process.execPath} ${mock} --engine=pi` } });
  await new Promise(resolve => leaky.listen(0, '127.0.0.1', resolve));
  const leakyUrl = 'http://127.0.0.1:' + leaky.address().port;
  try {
    const result = await runVerify(leakyUrl, { ANTHROPIC_API_KEY: 'k1' }, ['--engine=claude']);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /✗ 只读模式不会写文件/);
    assert.match(result.out, /权限限制没有生效/);
  } finally { leaky.close(); leaky.closeAllConnections?.(); }

  const badToken = await new Promise(resolve => { const child = spawn(process.execPath, [verifyScript], { env: { ...process.env, RUNNER_URL: base, RUNNER_TOKEN: 'wrong-token-1234567' } }); let out = ''; child.stderr.on('data', c => { out += c; }); child.stdout.on('data', c => { out += c; }); child.on('exit', code => resolve({ code, out })); });
  assert.equal(badToken.code, 2);
  assert.match(badToken.out, /令牌错误/);
  const down = await runVerify('http://127.0.0.1:1', {});
  assert.equal(down.code, 2);
  assert.match(down.out, /无法连接运行器/);
});
