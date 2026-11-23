import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRunner } from '../runner/runner.mjs';
import { runPmTeam } from '../collab.mjs';
import { mintExecToken, verifyExecToken, normalizeLanguage } from '../runner/sandbox.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN = { email: 'owner@example.com', password: 'a-very-long-test-password' };
const TOKEN = 'runner-token-abcdefghij', SBX_TOKEN = 'sandbox-token-0123456789';
let dir, modelServer, sandboxServer, runnerServer, bareRunner, app, base, runnerBase, bareBase, auth;
const prompts = [];
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

test.before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cindy-sbx-'));
  const keyFile = path.join(dir, 'k'), adminFile = path.join(dir, 'admin'), tokenFile = path.join(dir, 'rt');
  await writeFile(keyFile, randomBytes(32).toString('base64')); await writeFile(adminFile, ADMIN.password); await writeFile(tokenFile, TOKEN);
  modelServer = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => raw += c);
    req.on('end', () => {
      const body = JSON.parse(raw), last = body.messages.at(-1).content, system = body.messages.find(m => m.role === 'system')?.content || '';
      prompts.push({ last, system });
      if (!body.stream) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ choices: [{ message: { content: '喵～来自宠物' } }], usage: { prompt_tokens: 4, completion_tokens: 6 } })); }
      const who = /你的名字是“([^”]+)”/.exec(system)?.[1] || /你的名称：(\S+)/.exec(last)?.[1] || '?';
      if (last.includes('你是团队的产品经理')) {
        const worked = last.includes('【乙】\n');
        const pmReply = worked ? '{"say":"","final":"汇总：' + (/【乙】\n(\S+)/.exec(last)?.[1] || '') + '"}'
          : last.includes('只做一件事') ? '{"say":"这个交给乙","assign":[{"to":"乙","task":"写文案"},{"to":"不存在","task":"x"}]}' : '{"say":"","final":"直接答复：好的"}';
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: pmReply } }] }) + '\n\n');
        return res.end('data: [DONE]\n\n');
      }
      const reply = who === '甲' && !last.includes('@乙') && last.includes('请乙') ? '我觉得 @乙 你来补充' : '来自' + who;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: reply } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 3 } }) + '\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  const modelPort = await listen(modelServer);
  // 沙箱容器：不挂载工作区，只收文件副本；运行器：带 SANDBOX_URL；bareRunner：没配沙箱
  sandboxServer = createRunner({ token: SBX_TOKEN, root: path.join(dir, 'unused'), env: { ...process.env, SANDBOX_SHELL: 'posix', SANDBOX_ONLY: '1', MODEL_SECRET: 'must-not-leak' } });
  const sandboxPort = await listen(sandboxServer);
  runnerServer = createRunner({ token: TOKEN, sandboxToken: SBX_TOKEN, root: path.join(dir, 'ws'), env: { ...process.env, SANDBOX_SHELL: 'posix', SANDBOX_URL: `http://127.0.0.1:${sandboxPort}` } });
  const runnerPort = await listen(runnerServer);
  bareRunner = createRunner({ token: TOKEN, root: path.join(dir, 'ws2'), env: { ...process.env, SANDBOX_SHELL: 'posix' } });
  const barePort = await listen(bareRunner);
  runnerBase = `http://127.0.0.1:${runnerPort}`; bareBase = `http://127.0.0.1:${barePort}`;
  const port = 20000 + Math.floor(Math.random() * 20000);
  base = 'http://127.0.0.1:' + port;
  app = spawn(process.execPath, ['server.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, COOKIE_SECURE: 'false', TRUST_PROXY: 'false', STORE_ENCRYPTION_KEY_FILE: keyFile, ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD_FILE: adminFile, MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, MODEL_NAME: 'test-model', MODEL_API_KEY: 'k', RUNNER_URL: runnerBase, RUNNER_TOKEN_FILE: tokenFile } });
  await new Promise((resolve, reject) => { app.on('exit', code => reject(new Error('server exited ' + code))); app.stdout.on('data', c => { if (String(c).includes('listening')) resolve(); }); });
  const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(ADMIN) });
  const data = await response.json();
  auth = { cookie: response.headers.get('set-cookie').split(';')[0], csrf: data.csrfToken };
});
test.after(async () => {
  app?.removeAllListeners('exit'); app?.kill(); modelServer?.close();
  for (const s of [sandboxServer, runnerServer, bareRunner]) { s?.close(); s?.closeAllConnections?.(); }
  await new Promise(r => setTimeout(r, 300)); await rm(dir, { recursive: true, force: true }).catch(() => {});
});

const call = async (p, method = 'GET', body) => {
  const response = await fetch(base + p, { method, headers: { Origin: base, Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, data: await response.json().catch(() => ({})) };
};
async function sse(p, body) {
  const response = await fetch(base + p, { method: 'POST', headers: { Origin: base, Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) return { status: response.status, data: await response.json() };
  const text = await response.text();
  return { status: 200, events: [...text.matchAll(/event: (\w+)\ndata: (.*)\n/g)].map(m => ({ type: m[1], ...JSON.parse(m[2]) })) };
}
const exec = (b, body, headers = {}) => fetch(b + '/exec', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, data: await r.json() }));

test('短期令牌：只对指定工作区有效，过期、被篡改都不行', () => {
  const token = mintExecToken(TOKEN, 'ws-1', 60, 1_000_000_000_000);
  assert.deepEqual(verifyExecToken(TOKEN, token, 1_000_000_000_000 + 1000), { workspace: 'ws-1' });
  assert.equal(verifyExecToken(TOKEN, token, 1_000_000_000_000 + 61_000), null);
  assert.equal(verifyExecToken(TOKEN, token.replace('ws-1', 'ws-2'), 1_000_000_000_000), null);
  assert.equal(verifyExecToken('other-secret-123456', token, 1_000_000_000_000), null);
  assert.equal(normalizeLanguage('JS'), 'node'); assert.equal(normalizeLanguage('ruby'), null);
});

test('沙箱：代码在沙箱容器里跑，文件改动写回工作区，沙箱看不到密钥', async () => {
  await fetch(runnerBase + '/files?workspace=ws-a&path=in.txt', { method: 'PUT', headers: { Authorization: 'Bearer ' + TOKEN }, body: 'hello' });
  const out = await exec(runnerBase, { workspace: 'ws-a', language: 'node', code: "import fs from 'node:fs';console.log(fs.readFileSync('in.txt','utf8')+'!'+(process.env.MODEL_SECRET||'none'));fs.writeFileSync('out.txt','done');fs.unlinkSync('in.txt')" });
  assert.equal(out.status, 200);
  assert.equal(out.data.exitCode, 0);
  assert.equal(out.data.stdout.trim(), 'hello!none');
  assert.deepEqual(out.data.changed, ['out.txt']); assert.deepEqual(out.data.removed, ['in.txt']);
  assert.equal(await readFile(path.join(dir, 'ws', 'ws-a', 'out.txt'), 'utf8'), 'done');
  const shell = await exec(runnerBase, { workspace: 'ws-a', command: 'echo err 1>&2; exit 3' });
  assert.equal(shell.data.exitCode, 3); assert.match(shell.data.stderr, /err/);
});

test('沙箱：超时被杀、输出被截断、坏请求被拒', async () => {
  const slow = await exec(runnerBase, { workspace: 'ws-a', language: 'node', code: 'setTimeout(()=>{},5000)', timeoutSec: 1 });
  assert.equal(slow.data.timedOut, true); assert.ok(slow.data.durationMs < 5000);
  const big = await exec(runnerBase, { workspace: 'ws-a', language: 'node', code: "console.log('x'.repeat(300000))" });
  assert.equal(big.data.truncated, true); assert.ok(big.data.stdout.length < 100000);
  assert.equal((await exec(runnerBase, { workspace: 'ws-a', language: 'ruby', code: 'puts 1' })).status, 400);
  assert.equal((await exec(runnerBase, { workspace: '../x', language: 'node', code: '1' })).status, 400);
});

test('沙箱：令牌权限与未配置时的拒绝', async () => {
  const scoped = mintExecToken(TOKEN, 'ws-a', 60);
  const headers = { Authorization: 'Bearer ' + scoped };
  assert.equal((await exec(runnerBase, { workspace: 'ws-a', language: 'node', code: 'console.log(1)' }, headers)).data.exitCode, 0);
  assert.equal((await exec(runnerBase, { workspace: 'ws-b', language: 'node', code: 'console.log(1)' }, headers)).status, 403);
  const files = await fetch(runnerBase + '/files?workspace=ws-a', { headers }); assert.equal(files.status, 401, '短期令牌不能访问文件接口');
  assert.equal((await exec(bareBase, { workspace: 'ws-a', language: 'node', code: '1' })).status, 403);
  assert.equal((await fetch(sandboxServer ? `http://127.0.0.1:${sandboxServer.address().port}/files?workspace=x` : '', { headers: { Authorization: 'Bearer ' + SBX_TOKEN } })).status, 404, '沙箱容器不提供文件接口');
  const withRunnerToken = await fetch(`http://127.0.0.1:${sandboxServer.address().port}/health`, { headers: { Authorization: 'Bearer ' + TOKEN } });
  assert.equal(withRunnerToken.status, 401, '沙箱不认运行器令牌；沙箱令牌也进不了运行器');
  assert.equal((await fetch(runnerBase + '/health', { headers: { Authorization: 'Bearer ' + SBX_TOKEN } })).status, 401);
});

test('应用接口：默认关闭，管理员打开后可运行', async () => {
  assert.equal((await call('/api/sandbox/run', 'POST', { language: 'node', code: 'console.log(1)' })).status, 403);
  assert.equal((await call('/api/sandbox')).data.available, false);
  assert.equal((await call('/api/admin/sandbox', 'PUT', { enabled: true, membersAllowed: false, timeoutSec: 10 })).status, 200);
  assert.equal((await call('/api/sandbox')).data.available, true);
  const run = await call('/api/sandbox/run', 'POST', { language: 'js', code: 'console.log(6*7)' });
  assert.equal(run.status, 200); assert.equal(run.data.stdout.trim(), '42');
  assert.equal((await call('/api/sandbox/run', 'POST', {})).status, 400);
});

test('群聊：@ 点名只让被点名的回复；回复里 @ 到别人会接力；整段历史保存', async () => {
  const members = [{ label: '甲', role: '组织者' }, { label: '乙', role: '补充者' }, { label: '丙' }];
  assert.equal((await call('/api/groups', 'POST', { mode: 'chat', members: [{ label: '有 空格' }] })).status, 400);
  assert.equal((await call('/api/groups', 'POST', { mode: 'chat', members: [{ label: '甲' }, { label: '甲' }] })).status, 400);
  const group = (await call('/api/groups', 'POST', { title: '讨论', mode: 'chat', members })).data.group;
  assert.equal(group.members.length, 3);

  const all = await sse(`/api/groups/${group.id}/send`, { message: '大家好' });
  assert.deepEqual(all.events.filter(e => e.type === 'turn_start').map(e => e.label), ['甲', '乙', '丙']);
  assert.equal(all.events.at(-1).type, 'done');

  const only = await sse(`/api/groups/${group.id}/send`, { message: '@丙 你说说' });
  assert.deepEqual(only.events.filter(e => e.type === 'turn_start').map(e => e.label), ['丙']);
  assert.match(prompts.at(-1).last, /【用户】\n大家好/, '后面的发言能看到前面的记录');
  assert.match(prompts.at(-1).last, /【甲】\n来自甲/);

  const relay = await sse(`/api/groups/${group.id}/send`, { message: '@甲 请乙补充' });
  assert.deepEqual(relay.events.filter(e => e.type === 'turn_start').map(e => e.label), ['甲', '乙']);

  const saved = (await call('/api/groups/' + group.id)).data;
  assert.equal(saved.messages.filter(m => m.role === 'user').length, 3);
  assert.deepEqual(saved.messages.filter(m => m.role === 'agent').map(m => m.label), ['甲', '乙', '丙', '丙', '甲', '乙']);
  assert.equal((await call('/api/groups')).data.groups[0].count, 9);
});

test('群聊：圆桌方式在群里跑完整讨论；改设置、删除', async () => {
  const group = (await call('/api/groups', 'POST', { title: '圆桌', mode: 'roundtable', rounds: 1, members: [{ label: '甲' }, { label: '乙' }] })).data.group;
  const run = await sse(`/api/groups/${group.id}/send`, { message: '讨论一下方案' });
  assert.equal(run.events.filter(e => e.type === 'turn_start').length, 3, '1 轮 × 2 人 + 总结');
  assert.equal((await call('/api/groups/' + group.id)).data.messages.filter(m => m.role === 'agent').length, 3);
  assert.equal((await call('/api/groups/' + group.id, 'PATCH', { mode: 'supervisor', members: [{ label: '甲' }] })).status, 400);
  assert.equal((await call('/api/groups/' + group.id, 'PATCH', { title: '新名字' })).data.group.title, '新名字');
  assert.equal((await call('/api/groups/' + group.id, 'DELETE')).status, 200);
  assert.equal((await call('/api/groups/' + group.id)).status, 404);
});

test('产品经理带队：按擅长分配任务，成员交付后由产品经理汇总；简单问题直接答复', async () => {
  const group = (await call('/api/groups', 'POST', { title: '团队', members: [
    { label: '代码手', role: '后端工程师', strengths: '写代码、排错' }, { label: '乙', role: '文案', strengths: '写作、文案' }] })).data.group;
  assert.equal(group.mode, 'pm'); assert.equal(group.pm.label, '产品经理'); assert.equal(group.members[1].strengths, '写作、文案');
  assert.equal((await call('/api/groups', 'POST', { members: [{ label: '产品经理' }] })).status, 400, '成员不能和产品经理重名');

  const simple = await sse(`/api/groups/${group.id}/send`, { message: '你好' });
  assert.deepEqual(simple.events.filter(e => e.type === 'turn_start').map(e => e.label), ['产品经理']);
  assert.match(prompts.at(-1).last, /代码手（身份：后端工程师）｜擅长：写代码、排错/, '名单里带身份和擅长');

  const work = await sse(`/api/groups/${group.id}/send`, { message: '只做一件事：帮我写文案' });
  const order = work.events.filter(e => e.type === 'turn_start').map(e => e.label);
  assert.deepEqual(order, ['产品经理', '乙', '产品经理'], '先说明分工，乙交付，最后汇总（不存在的成员被忽略）');
  const saved = (await call('/api/groups/' + group.id)).data.messages.filter(m => m.role === 'agent');
  assert.match(saved.at(-1).content, /^汇总：来自乙/);
  assert.equal(saved.at(-1).label, '产品经理');
});

test('沙箱：没有指定工作区时在空目录里跑，不读不写工作区', async () => {
  const run = await exec(runnerBase, { workspace: 'sbx-ephemeral', ephemeral: true, language: 'node', code: "import fs from 'node:fs';fs.writeFileSync('leak.txt','x');console.log(fs.readdirSync('.').join(','))" });
  assert.equal(run.data.exitCode, 0); assert.equal(run.data.stdout.trim(), 'leak.txt');
  assert.deepEqual(run.data.changed, []);
  await assert.rejects(readFile(path.join(dir, 'ws', 'sbx-ephemeral', 'leak.txt')));
});

test('群聊：@GPT2 不会同时点到 GPT', async () => {
  const group = (await call('/api/groups', 'POST', { title: '前缀', mode: 'chat', members: [{ label: 'GPT' }, { label: 'GPT2' }] })).data.group;
  const run = await sse(`/api/groups/${group.id}/send`, { message: '@GPT2 你好' });
  assert.deepEqual(run.events.filter(e => e.type === 'turn_start').map(e => e.label), ['GPT2']);
});

test('产品经理带队：一位成员出错不拖垮整轮，其余成员的成果照常汇总', async () => {
  const pm = { label: '产品经理' }, members = [{ label: '甲' }, { label: '乙' }];
  const events = []; let pmCalls = 0;
  const call = async ({ participant, prompt }) => {
    if (participant === pm) { pmCalls++; return { text: pmCalls === 1 ? '{"say":"分工","assign":[{"to":"甲","task":"a"},{"to":"乙","task":"b"}]}' : '{"say":"","final":"汇总：' + (prompt.includes('执行失败') ? '甲失败' : '全成功') + '，' + (prompt.includes('来自乙') ? '乙在' : '乙缺') + '"}' }; }
    if (participant.label === '甲') throw new Error('429 限流');
    return { text: '来自乙' };
  };
  await runPmTeam({ message: 'x', pm, members, call, emit: e => events.push(e) });
  assert.match(events.filter(e => e.type === 'turn_end').at(-1).text, /汇总：甲失败，乙在/);
  assert.ok(events.some(e => e.type === 'turn_end' && e.failed && e.label === '甲'));
});

test('群聊用量：按成员、按模型统计 Token 与费用；主账号可导出报表', async () => {
  const pricing = (await call('/api/admin/pricing')).data;
  assert.ok(pricing.models.length, '至少有一个可定价的模型');
  const ref = pricing.models[0].ref;
  assert.equal((await call('/api/admin/pricing', 'PUT', { currency: '$', models: { [ref]: { input: -1, output: 1 } } })).status, 400, '负数价格被拒绝');
  assert.equal((await call('/api/admin/pricing', 'PUT', { currency: '$', models: { [ref]: { input: 100000, output: 200000 } } })).status, 200);
  const group = (await call('/api/groups', 'POST', { title: '算账群', mode: 'chat', members: [{ label: '甲' }, { label: '乙' }] })).data.group;
  await sse(`/api/groups/${group.id}/send`, { message: '@甲 你好' });
  const usage = (await call(`/api/groups/${group.id}/usage`)).data;
  const total = usage.thisMonth.total;
  assert.equal(total.calls, 1); assert.equal(total.inputTokens, 2); assert.equal(total.outputTokens, 3); assert.equal(total.totalTokens, 5);
  assert.equal(total.cost, 0.8, '(2×10万 + 3×20万) / 100万');
  assert.deepEqual(usage.thisMonth.members.map(m => m.label), ['甲']);
  assert.equal(usage.currency, '$');

  const report = (await call('/api/admin/usage')).data;
  assert.ok(report.totals.cost >= 0.8 && report.groups.some(g => g.title === '算账群' && g.members[0].label === '甲'));
  assert.ok(report.models.some(m => m.model === ref && m.cost >= 0.8));
  const csvOf = async by => { const r = await fetch(base + '/api/admin/usage/export?by=' + by, { headers: { Cookie: auth.cookie } }); const buf = Buffer.from(await r.arrayBuffer()); return { status: r.status, type: r.headers.get('content-type'), text: buf.toString('utf8'), bom: buf.subarray(0, 3).toString('hex') === 'efbbbf' }; };
  const byGroup = await csvOf('group');
  assert.equal(byGroup.status, 200); assert.match(byGroup.type, /text\/csv/); assert.ok(byGroup.text.startsWith('\uFEFF群聊,'));
  assert.match(byGroup.text, /算账群,owner@example\.com,甲,/);
  assert.match((await csvOf('member')).text, /owner@example\.com/);
  assert.match((await csvOf('model')).text, /^\uFEFF模型,服务商,/);
  assert.equal((await csvOf('bogus')).status, 400);

  // 群被删除后，报表里仍保留它的用量
  await call('/api/groups/' + group.id, 'DELETE');
  assert.ok((await call('/api/admin/usage')).data.groups.some(g => g.title === '算账群' && g.deleted));
});

test('成员使用时段：时段外被拒绝，时段内放行；格式不对被拒绝', async () => {
  const email = 'window@example.com', password = 'member-password-123456';
  const created = await call('/api/admin/members', 'POST', { email, password });
  assert.equal(created.status, 201); const id = created.data.member.id;
  const hhmm = ms => { const d = new Date(Date.now() + ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  assert.equal((await call('/api/admin/members/' + id, 'PATCH', { allowedHours: { start: '9:00', end: '18:00' } })).status, 400);
  assert.equal((await call('/api/admin/members/' + id, 'PATCH', { allowedHours: { start: '10:00', end: '10:00' } })).status, 400);
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ email, password }) });
  const member = { Cookie: login.headers.get('set-cookie').split(';')[0] };
  const blocked = async () => (await (await fetch(base + '/api/usage/me', { headers: member })).json()).blocked;
  assert.equal(await blocked(), null, '没设时段时不限制');
  const out = await call('/api/admin/members/' + id, 'PATCH', { allowedHours: { start: hhmm(2 * 3600e3), end: hhmm(3 * 3600e3) } });
  assert.equal(out.status, 200); assert.ok(out.data.member.allowedHours);
  assert.match(await blocked(), /使用时段/);
  await call('/api/admin/members/' + id, 'PATCH', { allowedHours: { start: hhmm(-3600e3), end: hhmm(3600e3) } });
  assert.equal(await blocked(), null, '当前时间在时段内');
  await call('/api/admin/members/' + id, 'PATCH', { allowedHours: null });
  assert.equal((await call('/api/admin/members')).data.members.find(m => m.id === id).allowedHours, null);
});

test('成员每小时 Token 上限：可设置，超出后新请求被拒绝', async () => {
  const email = 'hourly@example.com', password = 'member-password-123456';
  const id = (await call('/api/admin/members', 'POST', { email, password, hourlyTokenLimit: 8 })).data.member.id;
  assert.equal((await call('/api/admin/members/' + id, 'PATCH', { hourlyTokenLimit: -1 })).status, 400);
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ email, password }) });
  const lj = await login.json(), cookie = login.headers.get('set-cookie').split(';')[0];
  const mcall = async (p, method = 'GET', body) => { const r = await fetch(base + p, { method, headers: { Origin: base, Cookie: cookie, 'X-CSRF-Token': lj.csrfToken, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, text: await r.text() }; };
  assert.equal(JSON.parse((await mcall('/api/usage/me')).text).blocked, null);
  const group = JSON.parse((await mcall('/api/groups', 'POST', { mode: 'chat', members: [{ label: '甲' }] })).text).group;
  for (let i = 0; i < 2; i++) await mcall(`/api/groups/${group.id}/send`, 'POST', { message: '@甲 你好' }); // 每次 5 个 Token，第二次后累计 10 ≥ 8
  const me = JSON.parse((await mcall('/api/usage/me')).text);
  assert.match(me.blocked, /本小时 Token/); assert.equal(me.usage.hourlyTokenLimit, 8); assert.ok(me.usage.hourTokens >= 8);
  assert.equal((await mcall(`/api/groups/${group.id}/send`, 'POST', { message: '再来' })).status, 429);
  assert.equal((await call('/api/admin/members/' + id, 'PATCH', { hourlyTokenLimit: 0 })).status, 200);
  assert.equal(JSON.parse((await mcall('/api/usage/me')).text).blocked, null);
});

test('宠物 AI：默认跟随主 AI，可单独选模型；聊天单独计量；联动时带上主对话节选', async () => {
  const info = (await call('/api/pet/ai')).data;
  assert.equal(info.mode, 'main'); assert.equal(info.effective, info.mainModel);
  assert.equal((await call('/api/pet/ai', 'PUT', { mode: 'own', model: 'no/such-model' })).status, 400);
  assert.equal((await call('/api/pet/ai', 'PUT', { mode: 'own', model: info.models[0].ref })).data.mode, 'own');
  assert.equal((await call('/api/pet/chat', 'POST', {})).status, 400);
  const before = (await call('/api/pet/ai')).data.month.calls;
  const plain = await call('/api/pet/chat', 'POST', { message: '你好呀', link: false, context: [{ role: 'user', text: '主对话里的秘密内容' }] });
  assert.equal(plain.status, 200); assert.ok(plain.data.reply); assert.equal(plain.data.linked, false);
  assert.doesNotMatch(prompts.at(-1).system, /主对话里的秘密内容/, '不联动时看不到主对话');
  const linked = await call('/api/pet/chat', 'POST', { message: '刚才聊得怎么样', link: true, history: [{ role: 'user', text: '嗨' }, { role: 'assistant', text: '嗨嗨' }], context: [{ role: 'user', text: '帮我写个排序' }, { role: 'assistant', text: '好的，这是快速排序' }] });
  assert.equal(linked.data.linked, true); assert.match(prompts.at(-1).system, /帮我写个排序/); assert.match(prompts.at(-1).system, /不是用户正在使用的主助手/);
  const after = (await call('/api/pet/ai')).data.month;
  assert.equal(after.calls, before + 2); assert.ok(after.totalTokens >= 10, '宠物 AI 的 Token 单独统计');
  assert.equal((await call('/api/pet/ai', 'PUT', { mode: 'main' })).data.mode, 'main');
});

test('工作区：管理员能拿到成员下拉选项，普通成员不能；列表里每个工作区带最近的协作任务', async () => {
  const email = 'picker@example.com', password = 'member-password-123456';
  const created = await call('/api/admin/members', 'POST', { email, password });
  assert.equal(created.status, 201);
  const options = await call('/api/workspaces/member-options');
  assert.equal(options.status, 200);
  const picked = options.data.members.find(m => m.email === email);
  assert.ok(picked && picked.displayName && picked.id, '成员出现在选项里');
  assert.ok(!options.data.members.some(m => m.email === ADMIN.email), '不包含管理员自己');
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ email, password }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base + '/api/workspaces/member-options', { headers: { Cookie: cookie } })).status, 403, '普通成员看不到全部成员');
  const ws = await call('/api/workspaces', 'POST', { name: '带任务的空间', visibility: 'members', members: [email] });
  assert.equal(ws.status, 201);
  const list = (await call('/api/workspaces')).data.workspaces.find(w => w.name === '带任务的空间');
  assert.ok(Array.isArray(list.recent) && list.recent.length === 0, '新工作区还没有任务，recent 是空数组');
  assert.deepEqual(list.members, [email]);
});

test('扫码登录：电脑生成二维码，已登录的手机确认，电脑领取登录；没有 secret 领不走；拒绝与过期都不能登录', async () => {
  const email = 'qr@example.com', password = 'member-password-123456';
  assert.equal((await call('/api/admin/members', 'POST', { email, password })).status, 201);
  const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: JSON.stringify(body) });
  // 手机：成员已登录
  const login = await post('/api/auth/login', { email, password }); const lj = await login.json(), phone = { Cookie: login.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': lj.csrfToken };
  // 来源不是本站地址 → 拒绝
  assert.equal((await post('/api/auth/recover/qr/start', { origin: 'https://evil.example' })).status, 400);
  const started = await (await post('/api/auth/recover/qr/start', { origin: base })).json();
  assert.match(started.svg, /^<svg/); assert.ok(started.url.startsWith(base + '/?qr=')); assert.ok(started.secret && started.id);
  const code = new URL(started.url).searchParams.get('qr');
  assert.notEqual(code, started.secret, '二维码里的 code 和只留在电脑里的 secret 不同');
  const status = id => fetch(base + '/api/auth/recover/qr/status?id=' + id).then(r => r.json());
  assert.equal((await status(started.id)).status, 'pending');
  assert.equal((await post('/api/auth/recover/qr/finish', { id: started.id, secret: started.secret })).status, 409, '手机还没确认不能领取');
  // 未登录的人不能确认；确认前能看到请求者信息
  assert.equal((await post('/api/security/qr-approve', { code, approve: true })).status, 401);
  const info = await fetch(base + '/api/security/qr-info?code=' + code, { headers: phone }); assert.equal(info.status, 200); assert.ok('ip' in (await info.json()));
  assert.equal((await post('/api/security/qr-approve', { code: 'wrong', approve: true }, phone)).status, 404);
  assert.equal((await post('/api/security/qr-approve', { code, approve: true }, phone)).status, 200);
  assert.equal((await status(started.id)).status, 'approved');
  assert.equal((await post('/api/auth/recover/qr/finish', { id: started.id, secret: 'x'.repeat(32) })).status, 409, 'secret 不对领不走');
  const done = await post('/api/auth/recover/qr/finish', { id: started.id, secret: started.secret });
  assert.equal(done.status, 200); assert.equal((await done.json()).email, email);
  assert.equal((await post('/api/auth/recover/qr/finish', { id: started.id, secret: started.secret })).status, 409, '只能领一次');
  // 拒绝
  const second = await (await post('/api/auth/recover/qr/start', { origin: base })).json();
  assert.equal((await post('/api/security/qr-approve', { code: new URL(second.url).searchParams.get('qr'), approve: false }, phone)).status, 200);
  assert.equal((await status(second.id)).status, 'denied');
  assert.equal((await post('/api/auth/recover/qr/finish', { id: second.id, secret: second.secret })).status, 409);
});

test('忘记密码：成员也能用手机授权（管理员重置密码也有），恢复密钥仍然只给管理员', async () => {
  const email = 'forgot@example.com', password = 'member-password-123456';
  assert.equal((await call('/api/admin/members', 'POST', { email, password })).status, 201);
  const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: JSON.stringify(body) });
  const login = await post('/api/auth/login', { email, password }); const lj = await login.json(), phone = { Cookie: login.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': lj.csrfToken };
  const started = await (await post('/api/auth/recover/phone/start', { email })).json();
  assert.match(started.code, /^\d{6}$/);
  assert.equal((await post('/api/security/phone-approve', { code: started.code, approve: true }, phone)).status, 200, '成员可以批准自己账号的请求');
  const newPassword = 'a-brand-new-password-2026';
  assert.equal((await post('/api/auth/recover/phone/finish', { id: started.id, newPassword })).status, 200);
  assert.equal((await post('/api/auth/login', { email, password })).status, 401, '旧密码失效');
  assert.equal((await post('/api/auth/login', { email, password: newPassword })).status, 200, '新密码可用');
  const again = await post('/api/auth/login', { email, password: newPassword }); const aj = await again.json(), fresh = { Cookie: again.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': aj.csrfToken };
  const key = await fetch(base + '/api/security/recovery-key', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...fresh }, body: JSON.stringify({ password: newPassword }) });
  assert.equal(key.status, 403, '成员不能生成恢复密钥');
});
