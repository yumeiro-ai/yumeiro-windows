import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CindyLocalClient, createBridge, flattenMessages } from '../bridge/yumeiro-bridge.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const readJson = req => new Promise(resolve => { let raw = ''; req.on('data', c => raw += c); req.on('end', () => resolve(JSON.parse(raw || '{}'))); });

test('bridge routes cindy:* to the local agent RPC and team:* to the team server', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bridge-test-'));
  const calls = []; let lastTeam = null;
  let polls = 0, prompt = '';
  const rpc = http.createServer(async (req, res) => {
    const body = await readJson(req);
    calls.push({ method: body.method, auth: req.headers.authorization || '' });
    const reply = result => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ result })); };
    switch (body.method) {
      case 'connect/start': return reply({ id: 'req1', claim: 'c1' });
      case 'connect/poll': return reply(++polls < 2 ? { state: 'waiting' } : { state: 'approved', token: 'local-token' });
      case 'models': return reply({ models: [{ id: 'm1', label: 'Claude 本机', engine: 'claude' }] });
      case 'session/open': assert.equal(body.params.toolPolicy, 'client-only'); return reply({ sessionId: body.params.sessionId });
      case 'send': prompt = body.params.parts[0].text; return reply({});
      case 'events': return reply({ cursor: 3, events: [{ seq: 1, event: { type: 'text', data: '你' } }, { seq: 2, event: { type: 'text', data: '好' } }, { seq: 3, event: { type: 'turn_end', data: { status: 'completed' } } }] });
      default: return reply({});
    }
  });
  const rpcPort = await listen(rpc);
  await writeFile(path.join(dir, 'discovery.json'), JSON.stringify({ protocol: 1, port: rpcPort, instance: 'inst' }));

  const team = http.createServer(async (req, res) => {
    const multipart = String(req.headers['content-type'] || '').startsWith('multipart/form-data');
    const body = multipart ? {} : await readJson(req);
    if (multipart) { for await (const _ of req) { /* 读完 */ } }
    lastTeam = { url: req.url, session: req.headers['x-session-id'], body, contentType: req.headers['content-type'] };
    assert.equal(req.headers.authorization, 'Bearer ymr_team');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(req.url === '/v1/models' ? JSON.stringify({ data: [{ id: 'agent:1', object: 'model' }] }) : JSON.stringify({ echoModel: body.model }));
  });
  const teamPort = await listen(team);

  const client = new CindyLocalClient({ discovery: path.join(dir, 'discovery.json') });
  const bridge = createBridge({ client, teamUrl: `http://127.0.0.1:${teamPort}`, teamToken: 'ymr_team' });
  const port = await listen(bridge);
  const base = `http://127.0.0.1:${port}`;
  const post = (body, headers = {}) => fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

  try {
    const models = await (await fetch(base + '/v1/models')).json();
    assert.deepEqual(models.data.map(m => m.id), ['cindy:m1', 'team:agent:1']);

    const done = await (await post({ model: 'cindy:m1', messages: [{ role: 'user', content: '嗨' }] })).json();
    assert.equal(done.choices[0].message.content, '你好');
    assert.ok(calls.some(c => c.method === 'models' && c.auth === 'Bearer local-token'));
    assert.ok(calls.some(c => c.method === 'session/close'));

    const streamed = await (await post({ model: 'cindy:m1', stream: true, messages: [{ role: 'system', content: 'S' }, { role: 'user', content: '嗨' }] })).text();
    assert.match(streamed, /\[DONE\]/);
    assert.match(prompt, /用户的最新消息/);

    const viaTeam = await (await post({ model: 'team:agent:1', messages: [{ role: 'user', content: 'x' }] })).json();
    assert.equal(viaTeam.echoModel, 'agent:1');

    assert.equal((await post({ model: 'cindy:m1', messages: [{ role: 'user', content: 'x' }] }, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await post({ model: 'unknown', messages: [{ role: 'user', content: 'x' }] })).status, 404);

    // 绘画：本机程序通过桥接转发到团队服务器，会话标识透传
    const drawn = await fetch(base + '/v1/images/generations', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Id': 'app-1' }, body: JSON.stringify({ prompt: '一只猫', n: 2, size: '1024x1024' }) });
    assert.equal(drawn.status, 200); await drawn.json();
    assert.equal(lastTeam.url, '/v1/images/generations'); assert.equal(lastTeam.session, 'app-1'); assert.equal(lastTeam.body.n, 2); assert.equal(lastTeam.body.prompt, '一只猫');
    assert.equal((await fetch(base + '/v1/images/generations', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' })).status, 403, '绘画转发同样只接受本机程序直接调用');

    // 语音：朗读（JSON）和识别（multipart 原样透传，包括 boundary）
    const spoke = await fetch(base + '/v1/audio/speech', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Id': 's9' }, body: JSON.stringify({ input: '你好' }) });
    assert.equal(spoke.status, 200); await spoke.arrayBuffer();
    assert.equal(lastTeam.url, '/v1/audio/speech'); assert.equal(lastTeam.body.input, '你好'); assert.equal(lastTeam.session, 's9');
    const form = new FormData(); form.append('model', 'whisper-1'); form.append('file', new Blob([Buffer.alloc(300, 1)], { type: 'audio/wav' }), 'a.wav');
    const heard = await fetch(base + '/v1/audio/transcriptions', { method: 'POST', body: form });
    assert.equal(heard.status, 200); await heard.arrayBuffer();
    assert.equal(lastTeam.url, '/v1/audio/transcriptions'); assert.match(lastTeam.contentType, /^multipart\/form-data; boundary=/);
  } finally {
    bridge.close(); rpc.close(); team.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('flattenMessages keeps single messages verbatim', () => {
  assert.equal(flattenMessages([{ role: 'user', content: 'hi' }]), 'hi');
});

test('授权令牌可保存到文件：重启后复用，失效则重新授权；容器内可放行指定主机名', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bridge-token-'));
  let valid = 'saved-token', starts = 0;
  const rpc = http.createServer(async (req, res) => {
    const body = await readJson(req);
    const reply = (result, error) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(error ? { error } : { result })); };
    if (body.method === 'connect/start') { starts++; return reply({ id: 'r', claim: 'c' }); }
    if (body.method === 'connect/poll') return reply({ state: 'approved', token: 'fresh-token' });
    if (body.method === 'models') return req.headers.authorization === 'Bearer ' + valid ? reply({ models: [{ id: 'x' }] }) : reply(null, { code: 'unauthorized', message: 'bad token' });
    reply({});
  });
  const rpcPort = await listen(rpc);
  await writeFile(path.join(dir, 'discovery.json'), JSON.stringify({ port: rpcPort, instance: 'i' }));
  const tokenFile = path.join(dir, 'token');
  try {
    await writeFile(tokenFile, 'saved-token');
    const a = new CindyLocalClient({ discovery: path.join(dir, 'discovery.json'), tokenFile });
    assert.equal((await a.models()).length, 1);
    assert.equal(starts, 0, '有效的已保存令牌不需要再次授权');
    valid = 'fresh-token';
    const b = new CindyLocalClient({ discovery: path.join(dir, 'discovery.json'), tokenFile });
    assert.equal((await b.models()).length, 1);
    assert.equal(starts, 1, '令牌失效后重新授权');
    assert.equal((await readFile(tokenFile, 'utf8')).trim(), 'fresh-token');

    const bridge = createBridge({ client: b, apiKey: 'k', allowHosts: ['desktop'] });
    const port = await listen(bridge);
    const viaName = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: '/v1/models', headers: { Host: 'desktop:8788', Authorization: 'Bearer k' } }, r => { r.resume(); resolve(r.statusCode); }).on('error', reject));
    const other = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: '/v1/models', headers: { Host: 'evil.example', Authorization: 'Bearer k' } }, r => { r.resume(); resolve(r.statusCode); }).on('error', reject));
    assert.equal(viaName, 200); assert.equal(other, 403);
    bridge.close();
  } finally { rpc.close(); await rm(dir, { recursive: true, force: true }); }
});
