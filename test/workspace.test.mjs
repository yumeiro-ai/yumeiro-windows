import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRunner } from '../runner/runner.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mock = path.join(root, 'test', 'fixtures', 'mock-agent.mjs');
const ADMIN = { email: 'owner@example.com', password: 'a-very-long-test-password' };
const RUNNER_TOKEN = 'runner-token-abcdefghij';
let dir, modelServer, runnerServer, app, base, ownerAuth;

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

test.before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cindy-ws-'));
  const keyFile = path.join(dir, 'k'), adminFile = path.join(dir, 'admin'), tokenFile = path.join(dir, 'rt');
  await writeFile(keyFile, randomBytes(32).toString('base64')); await writeFile(adminFile, ADMIN.password); await writeFile(tokenFile, RUNNER_TOKEN);
  modelServer = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => raw += c);
    req.on('end', () => {
      const body = JSON.parse(raw);
      const reply = body.messages.at(-1).content.includes('你是多智能体团队的主管') ? '我不输出 JSON' : '模型回复：' + body.messages.at(-1).content.slice(0, 20);
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: reply } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 3 } }) + '\n\n');
        return res.end('data: [DONE]\n\n');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
    });
  });
  const modelPort = await listen(modelServer);
  runnerServer = createRunner({ token: RUNNER_TOKEN, root: path.join(dir, 'ws'), env: { ...process.env, CLAUDE_CMD: `${process.execPath} ${mock} --engine=claude`, CODEX_CMD: `${process.execPath} ${mock} --engine=codex`, PI_CMD: `${process.execPath} ${mock} --engine=pi` } });
  const runnerPort = await listen(runnerServer);
  const port = 20000 + Math.floor(Math.random() * 20000);
  base = 'http://127.0.0.1:' + port;
  app = spawn(process.execPath, ['server.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, COOKIE_SECURE: 'false', TRUST_PROXY: 'false', STORE_ENCRYPTION_KEY_FILE: keyFile, ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD_FILE: adminFile, MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, MODEL_NAME: 'test-model', MODEL_API_KEY: 'k', RUNNER_URL: `http://127.0.0.1:${runnerPort}`, RUNNER_TOKEN_FILE: tokenFile } });
  await new Promise((resolve, reject) => { app.on('exit', code => reject(new Error('server exited ' + code))); app.stdout.on('data', c => { if (String(c).includes('listening')) resolve(); }); });
  ownerAuth = await login(ADMIN);
});
test.after(async () => {
  app?.removeAllListeners('exit'); app?.kill(); modelServer?.close(); runnerServer?.close(); runnerServer?.closeAllConnections?.();
  await new Promise(r => setTimeout(r, 300)); await rm(dir, { recursive: true, force: true }).catch(() => {});
});

async function login(account) {
  const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(account) });
  const data = await response.json();
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: data.csrfToken };
}
const call = async (auth, p, method = 'GET', body) => {
  const response = await fetch(base + p, { method, headers: { Origin: base, Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, data: await response.json().catch(() => ({})) };
};
async function sse(auth, p, body) {
  const response = await fetch(base + p, { method: 'POST', headers: { Origin: base, Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) return { status: response.status, data: await response.json() };
  const text = await response.text();
  const events = [...text.matchAll(/event: (\w+)\ndata: (.*)\n/g)].map(m => ({ type: m[1], ...JSON.parse(m[2]) }));
  return { status: 200, events, done: events.find(e => e.type === 'done'), finished: events.find(e => e.type === 'finished') };
}

test('引擎配置：默认全关；管理员配置后成员才能看到；密钥只回传掩码', async () => {
  const admin = await call(ownerAuth, '/api/admin/engines');
  assert.equal(admin.data.runner, true);
  assert.deepEqual(admin.data.engines.map(e => [e.engine, e.installed, e.enabled]), [['claude', true, false], ['codex', true, false], ['pi', true, false]]);
  assert.deepEqual((await call(ownerAuth, '/api/engines')).data.engines, []);

  const put = await call(ownerAuth, '/api/admin/engines/claude', 'PUT', { enabled: true, membersAllowed: true, maxMode: 'edit', apiKey: 'sk-claude-secret', baseUrl: 'https://api.anthropic.com', model: 'sonnet' });
  assert.equal(put.status, 200);
  assert.equal(JSON.stringify(put.data).includes('sk-claude-secret'), false);
  assert.match(put.data.engine.keyMask, /^sk-•+cret$/);
  assert.equal((await call(ownerAuth, '/api/admin/engines/codex', 'PUT', { enabled: true, membersAllowed: false, maxMode: 'readonly', apiKey: 'sk-openai' })).status, 200);
  assert.equal((await call(ownerAuth, '/api/admin/engines/claude', 'PUT', { baseUrl: 'http://example.com' })).status, 400);
  assert.equal((await call(ownerAuth, '/api/admin/engines/claude', 'PUT', {})).data.engine.hasKey, true, '留空保持原密钥');
  assert.deepEqual((await call(ownerAuth, '/api/engines')).data.engines.map(e => e.engine), ['claude', 'codex']);
});

test('工作区：成员可见性、文件读写；成员只能看到被放行的引擎', async () => {
  const member = { email: 'dev@example.com', password: 'dev-password-123456' };
  const created = await call(ownerAuth, '/api/admin/members', 'POST', member);
  const memberAuth = await login(member);
  const outsider = { email: 'out@example.com', password: 'out-password-123456' };
  await call(ownerAuth, '/api/admin/members', 'POST', outsider);
  const outsiderAuth = await login(outsider);

  const ws = (await call(ownerAuth, '/api/workspaces', 'POST', { name: '项目 A' })).data.workspace;
  assert.equal((await call(memberAuth, '/api/workspaces')).data.workspaces.length, 0);
  assert.equal((await call(ownerAuth, '/api/workspaces/' + ws.id, 'PATCH', { members: ['nobody@example.com'] })).status, 400);
  assert.deepEqual((await call(ownerAuth, '/api/workspaces/' + ws.id, 'PATCH', { members: [member.email] })).data.workspace.members, [member.email]);
  assert.equal((await call(memberAuth, '/api/workspaces')).data.workspaces[0].name, '项目 A');
  assert.equal((await call(outsiderAuth, '/api/workspaces/' + ws.id + '/files')).status, 404);
  assert.equal((await call(memberAuth, '/api/workspaces/' + ws.id, 'DELETE')).status, 403);

  assert.equal((await call(memberAuth, `/api/workspaces/${ws.id}/files?path=docs/readme.md`, 'PUT', { content: '# 说明' })).status, 200);
  assert.deepEqual((await call(ownerAuth, `/api/workspaces/${ws.id}/files?path=docs`)).data.entries.map(e => e.name), ['readme.md']);
  assert.equal((await call(ownerAuth, `/api/workspaces/${ws.id}/files?path=docs/readme.md`)).data.content, '# 说明');
  assert.equal((await call(ownerAuth, `/api/workspaces/${ws.id}/files?path=../x`)).status, 400);
  assert.deepEqual((await call(memberAuth, '/api/engines')).data.engines.map(e => e.engine), ['claude']);

  // 成员不能用没放行的 codex，也不能超过 claude 允许的模式
  const denied = await sse(memberAuth, `/api/workspaces/${ws.id}/runs`, { task: 't', mode: 'pipeline', participants: [{ kind: 'engine', engine: 'codex' }] });
  assert.equal(denied.status, 400);
  assert.match(denied.data.error, /引擎不可用/);

  // 保留给后续测试
  globalThis.__ws = { ws, memberAuth, memberId: created.data.member.id, outsiderAuth };
});

test('协作：模型智能体 + Claude Code 接力，事件流、记录、用量与密钥传递', async () => {
  const { ws, memberAuth } = globalThis.__ws;
  const agent = (await call(ownerAuth, '/api/agents', 'POST', { name: '规划师', systemPrompt: '你是规划师', shared: true })).data.agent;
  const result = await sse(memberAuth, `/api/workspaces/${ws.id}/runs`, {
    task: '实现一个登录页', mode: 'pipeline',
    participants: [{ kind: 'agent', agentId: agent.id, label: '规划', role: '拆分步骤' }, { kind: 'engine', engine: 'claude', label: '实现', mode: 'edit' }]
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.events.filter(e => e.type === 'step_start').map(e => e.label), ['规划', '实现']);
  assert.ok(result.events.some(e => e.type === 'delta' && /模型回复/.test(e.text)));
  assert.equal(result.done.status, 'completed');
  const echoed = JSON.parse(result.done.final);
  assert.equal(echoed.key, 'sk-claude-secret', '管理员配置的密钥要传给运行器');
  assert.ok(echoed.args.includes('acceptEdits'));
  assert.ok(echoed.args.includes('sonnet'));
  assert.ok(echoed.cwd.endsWith(ws.id));
  assert.ok(echoed.args.some(a => /模型回复/.test(a)), '后一位应该看到前一位的产出');

  const runs = (await call(memberAuth, `/api/workspaces/${ws.id}/runs`)).data.runs;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'completed');
  const detail = (await call(memberAuth, `/api/workspaces/${ws.id}/runs/${runs[0].id}`)).data.run;
  assert.equal(detail.steps.length, 2);
  assert.equal((await call(globalThis.__ws.outsiderAuth, `/api/workspaces/${ws.id}/runs/${runs[0].id}`)).status, 404);

  const usage = (await call(memberAuth, '/api/usage/me')).data.usage;
  assert.equal(usage.sources.workspace, 2);
  assert.equal(usage.models['engine:claude'].calls, 1);
});

test('协作：圆桌、主管（模型不会输出 JSON → bad_decision）、模式上限、参数校验', async () => {
  const { ws, memberAuth } = globalThis.__ws;
  const round = await sse(ownerAuth, `/api/workspaces/${ws.id}/runs`, { task: '选型', mode: 'roundtable', rounds: 1, participants: [{ kind: 'agent', label: '甲' }, { kind: 'agent', label: '乙' }] });
  assert.equal(round.events.filter(e => e.type === 'step_end').length, 3);

  const supervisor = await sse(ownerAuth, `/api/workspaces/${ws.id}/runs`, { task: 't', mode: 'supervisor', participants: [{ kind: 'agent', label: '主管' }, { kind: 'agent', label: '工人' }] });
  assert.equal(supervisor.done.status, 'bad_decision');

  // codex 上限是 readonly：请求 edit 也只会以只读运行（管理员可用 codex）
  const capped = await sse(ownerAuth, `/api/workspaces/${ws.id}/runs`, { task: 't', mode: 'pipeline', participants: [{ kind: 'engine', engine: 'codex', mode: 'edit' }] });
  assert.equal(JSON.parse(capped.done.final).args[JSON.parse(capped.done.final).args.indexOf('-s') + 1], 'read-only');

  // 引擎可选模型：管理员放行 opus 后，参与者可以指定它；未放行的模型在开始前被拒绝，不指定则用引擎默认模型
  assert.equal((await call(ownerAuth, '/api/admin/engines/claude', 'PUT', { models: 'opus' })).status, 200);
  const chosen = await sse(ownerAuth, `/api/workspaces/${ws.id}/runs`, { task: 't', mode: 'pipeline', participants: [{ kind: 'engine', engine: 'claude', model: 'opus' }] });
  assert.equal(chosen.status, 200);
  const chosenArgs = JSON.parse(chosen.done.final).args;
  assert.equal(chosenArgs[chosenArgs.indexOf('--model') + 1], 'opus');
  assert.equal((await sse(ownerAuth, `/api/workspaces/${ws.id}/runs`, { task: 't', mode: 'pipeline', participants: [{ kind: 'engine', engine: 'claude', model: 'haiku' }] })).status, 400);
  const fallback = await sse(ownerAuth, `/api/workspaces/${ws.id}/runs`, { task: 't', mode: 'pipeline', participants: [{ kind: 'engine', engine: 'claude' }] });
  const fallbackArgs = JSON.parse(fallback.done.final).args;
  assert.equal(fallbackArgs[fallbackArgs.indexOf('--model') + 1], 'sonnet');

  assert.equal((await sse(ownerAuth, `/api/workspaces/${ws.id}/runs`, { task: '', mode: 'pipeline', participants: [{ kind: 'agent' }] })).status, 400);
  assert.equal((await sse(ownerAuth, `/api/workspaces/${ws.id}/runs`, { task: 't', mode: 'roundtable', participants: [{ kind: 'agent', label: 'x' }] })).status, 400);
  assert.equal((await sse(ownerAuth, `/api/workspaces/${ws.id}/runs`, { task: 't', mode: 'pipeline', participants: [{ kind: 'agent', label: 'a', agentId: 'nope' }] })).status, 400);
  assert.equal((await sse(memberAuth, `/api/workspaces/${ws.id}/runs`, { task: 't', mode: 'pipeline', participants: [{ kind: 'engine', engine: 'pi' }] })).status, 400);
});

test('额度也约束工作区协作；删除成员/工作区会清理记录', async () => {
  const { ws, memberAuth, memberId } = globalThis.__ws;
  assert.equal((await call(ownerAuth, '/api/admin/members/' + memberId, 'PATCH', { dailyLimit: 1 })).status, 200);
  const limited = await sse(memberAuth, `/api/workspaces/${ws.id}/runs`, { task: '多步', mode: 'pipeline', participants: [{ kind: 'agent', label: 'a' }, { kind: 'agent', label: 'b' }] });
  // 当天已经用过 2 次，直接被拒绝（429）
  assert.equal(limited.status, 429);
  assert.equal((await call(ownerAuth, '/api/admin/members/' + memberId, 'DELETE')).status, 200);
  assert.equal((await call(ownerAuth, '/api/workspaces/' + ws.id, 'DELETE')).status, 200);
  assert.equal((await call(ownerAuth, '/api/workspaces')).data.workspaces.length, 0);
});
