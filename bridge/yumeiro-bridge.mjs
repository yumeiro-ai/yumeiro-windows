#!/usr/bin/env node
// 本地桥接：在本机 127.0.0.1 提供 OpenAI 兼容接口，把请求分发到
//   cindy:<模型ID>  → 本机运行的 Cindy 桌面端「本机 Agent API v1」（Claude Code / Codex / Pi 等原生智能体）
//   team:<模型>     → 你部署的团队服务器 /v1（含 agent:<ID> 智能体），需要 YUMEIRO_TEAM_URL + YUMEIRO_TEAM_TOKEN
// 仅使用 Node 22+ 标准库。令牌通过环境变量传入，不接受命令行密钥。
import http from 'node:http';
import os from 'node:os';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const RPC_TIMEOUT_MS = 30000;
const TURN_TIMEOUT_MS = 10 * 60 * 1000;

function defaultDiscoveryPath() {
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'CindyGlobal', 'local-agent', 'discovery.json');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'CindyGlobal', 'local-agent', 'discovery.json');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'CindyGlobal', 'local-agent', 'discovery.json');
}

// 与 Cindy 桌面端通信的 RPC 客户端：授权需要你在 Cindy 里点击允许。
export class CindyLocalClient {
  constructor({ discovery, clientId = 'org.yumeiro.bridge', clientName = 'Yumeiro Bridge', cwd, tokenFile = '' } = {}) {
    this.tokenFile = tokenFile;
    this.discoveryPath = discovery || defaultDiscoveryPath();
    this.clientId = clientId; this.clientName = clientName; this.cwd = cwd;
    this.nonce = randomBytes(12).toString('base64url'); this.counter = 0;
    this.token = ''; this.endpoint = null; this.connecting = null;
  }
  async rpc(method, params = {}, { auth = true, timeout = RPC_TIMEOUT_MS } = {}) {
    if (!this.endpoint) {
      const found = JSON.parse(await readFile(this.discoveryPath, 'utf8'));
      this.endpoint = { port: found.port, instance: found.instance };
    }
    // 连不上说明桌面端重启过（端口 / 实例号变了），下次重新读 discovery.json，不要一直用旧端口
    const response = await fetch(`http://127.0.0.1:${this.endpoint.port}/rpc`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeout),
      headers: { 'Content-Type': 'application/json', ...(auth && this.token ? { Authorization: 'Bearer ' + this.token } : {}) },
      body: JSON.stringify({ version: 1, instance: this.endpoint.instance, id: `${this.nonce}:${++this.counter}`, method, params })
    }).catch(error => { this.endpoint = null; throw error; });
    const data = await response.json().catch(() => ({}));
    if (data.error) throw Object.assign(new Error(data.error.message || data.error.code), { code: data.error.code });
    return data.result;
  }
  // 申请授权并等待你在 Cindy 里允许（两分钟内）。
  async connect(log = () => {}) {
    if (this.token) return;
    this.connecting ||= (async () => {
      // 之前在桌面端点过“允许”的授权令牌可以保存在文件里（仅限桥接自己的授权，权限 600），重启后不用再点一次。
      if (this.tokenFile) {
        const saved = (await readFile(this.tokenFile, 'utf8').catch(() => '')).trim();
        if (saved) {
          this.token = saved;
          try { await this.rpc('models'); return; } catch { this.token = ''; log('已保存的授权已失效，需要重新在 Cindy 里允许'); }
        }
      }
      const request = await this.rpc('connect/start', { client: { id: this.clientId, name: this.clientName, version: '0.3' } }, { auth: false });
      log('请在 Cindy 桌面端弹出的确认框中允许“' + this.clientName + '”…');
      const deadline = Date.now() + 125000;
      while (Date.now() < deadline) {
        const poll = await this.rpc('connect/poll', { id: request.id, claim: request.claim }, { auth: false });
        if (poll.state === 'approved' && poll.token) { this.token = poll.token; if (this.tokenFile) await writeFile(this.tokenFile, poll.token, { mode: 0o600 }).catch(() => {}); return; }
        if (poll.state === 'denied') throw new Error('Cindy 中拒绝了本机连接');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      throw new Error('等待 Cindy 授权超时');
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  async models() { await this.connect(); return (await this.rpc('models')).models || []; }

  // 运行一轮对话；onText 逐段接收文本。返回 {text, usage, status}。
  async run({ model, prompt, onText = () => {}, signal, native = false }) {
    await this.connect();
    const sessionId = 'b-' + randomUUID();
    const cwd = this.cwd || await mkdtemp(path.join(os.tmpdir(), 'cindy-bridge-'));
    await this.rpc('session/open', { sessionId, cwd, model, toolPolicy: native ? 'native' : 'client-only', tools: [] });
    let text = '', usage = null, status = 'completed', message = '';
    try {
      await this.rpc('send', { sessionId, parts: [{ type: 'text', text: prompt }] });
      let cursor = 0; const deadline = Date.now() + TURN_TIMEOUT_MS;
      const stop = () => this.rpc('interrupt', { sessionId }).catch(() => {});
      signal?.addEventListener('abort', stop);
      try {
        done: while (Date.now() < deadline) {
          if (signal?.aborted) { status = 'interrupted'; break; }
          const batch = await this.rpc('events', { sessionId, cursor }, { timeout: 40000 });
          cursor = batch.cursor ?? cursor;
          for (const { event } of batch.events || []) {
            if (event.type === 'text') { text += event.data; onText(event.data); }
            else if (event.type === 'usage') usage = event.data;
            else if (event.type === 'turn_end') { status = event.data?.status || 'completed'; message = event.data?.message || ''; break done; }
          }
        }
      } finally { signal?.removeEventListener('abort', stop); }
    } finally { await this.rpc('session/close', { sessionId }).catch(() => {}); }
    if (status === 'failed') throw new Error(message || 'Cindy 智能体执行失败');
    return { text, usage, status };
  }
}

// OpenAI messages → 单条文本（Cindy 本机会话是有状态的，这里每次新开会话并带上历史）。
export function flattenMessages(messages) {
  const text = m => typeof m.content === 'string' ? m.content : (m.content || []).map(p => p?.text || '').join('');
  const last = messages.length - 1;
  if (messages.length === 1) return text(messages[0]);
  const label = { system: '系统指令', user: '用户', assistant: '助手' };
  const history = messages.slice(0, last).map(m => `${label[m.role] || m.role}：${text(m)}`).join('\n');
  return `以下是此前的对话记录，请延续它：\n${history}\n\n用户的最新消息：\n${text(messages[last])}`;
}

export function createBridge({ client, teamUrl = '', teamToken = '', apiKey = '', native = false, allowHosts = [], log = () => {} } = {}) {
  const sendJson = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  const err = (res, status, message) => sendJson(res, status, { error: { message, type: 'invalid_request_error' } });
  const teamFetch = (p, init = {}) => fetch(teamUrl.replace(/\/+$/, '') + p, { ...init, headers: { Authorization: 'Bearer ' + teamToken, 'Content-Type': 'application/json', ...(init.headers || {}) } });

  return http.createServer(async (req, res) => {
    try {
      // 防 DNS 重绑定 / 网页跨站调用：只接受本机主机名且不带 Origin。
      const host = String(req.headers.host || '').replace(/:\d+$/, '');
      if (!['127.0.0.1', 'localhost', '[::1]', ...allowHosts].includes(host) || req.headers.origin) return err(res, 403, '拒绝：仅允许本机程序直接调用');
      if (apiKey && req.headers.authorization !== 'Bearer ' + apiKey) return err(res, 401, '本地接口密钥无效');
      const pathname = new URL(req.url, 'http://x').pathname;

      if (req.method === 'GET' && pathname === '/v1/models') {
        const data = [];
        if (client) { try { for (const m of await client.models()) data.push({ id: 'cindy:' + m.id, object: 'model', owned_by: 'cindy-local', name: m.label || m.model, engine: m.engine }); } catch (e) { log('读取 Cindy 本机模型失败：' + e.message); } }
        if (teamUrl && teamToken) { try { const r = await (await teamFetch('/v1/models')).json(); for (const m of r.data || []) data.push({ ...m, id: 'team:' + m.id, owned_by: 'yumeiro-team' }); } catch (e) { log('读取团队服务器模型失败：' + e.message); } }
        return sendJson(res, 200, { object: 'list', data });
      }
      // 直接转发到团队服务器：绘画（/v1/images/generations）、朗读（/v1/audio/speech，返回音频）、语音识别（/v1/audio/transcriptions，multipart 上传）。
      // 本机程序用同一个本地地址就能用；会话标识 X-Session-Id 和请求类型一并透传。
      const PASS = { '/v1/images/generations': { limit: 1024 * 1024, timeout: 300000 }, '/v1/audio/speech': { limit: 1024 * 1024, timeout: 120000 }, '/v1/audio/transcriptions': { limit: 8 * 1024 * 1024, timeout: 120000 } };
      if (req.method === 'POST' && PASS[pathname]) {
        if (!teamUrl || !teamToken) return err(res, 400, '未配置 YUMEIRO_TEAM_URL / YUMEIRO_TEAM_TOKEN');
        const parts = []; let total = 0;
        for await (const c of req) { total += c.length; if (total > PASS[pathname].limit) return err(res, 413, '请求过大'); parts.push(c); }
        const headers = {};
        if (req.headers['x-session-id']) headers['X-Session-Id'] = String(req.headers['x-session-id']);
        if (req.headers['content-type']) headers['Content-Type'] = String(req.headers['content-type']);
        const upstream = await teamFetch(pathname, { method: 'POST', body: Buffer.concat(parts), signal: AbortSignal.timeout(PASS[pathname].timeout), headers });
        res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' });
        return res.end(Buffer.from(await upstream.arrayBuffer()));
      }
      if (req.method !== 'POST' || pathname !== '/v1/chat/completions') return err(res, 404, '未找到');

      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 4 * 1024 * 1024) return err(res, 413, '请求过大'); chunks.push(c); }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return err(res, 400, '请求不是有效 JSON'); }
      const model = String(body.model || ''), messages = Array.isArray(body.messages) ? body.messages : [];
      if (!messages.length) return err(res, 400, 'messages 不能为空');

      if (model.startsWith('team:')) {
        if (!teamUrl || !teamToken) return err(res, 400, '未配置 YUMEIRO_TEAM_URL / YUMEIRO_TEAM_TOKEN');
        const upstream = await teamFetch('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ ...body, model: model.slice(5) }) });
        res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' });
        for await (const c of upstream.body) res.write(c);
        return res.end();
      }
      if (!model.startsWith('cindy:') || !client) return err(res, 404, '模型须以 cindy: 或 team: 开头，见 GET /v1/models');

      const id = 'chatcmpl-' + randomBytes(10).toString('hex'), created = Math.floor(Date.now() / 1000);
      const prompt = flattenMessages(messages), localModel = model.slice(6);
      const abort = new AbortController(); res.on('close', () => { if (!res.writableEnded) abort.abort(); });
      const usageOf = u => u ? { prompt_tokens: u.input, completion_tokens: u.output, total_tokens: (u.input || 0) + (u.output || 0) } : undefined;

      if (!body.stream) {
        const out = await client.run({ model: localModel, prompt, signal: abort.signal, native });
        return sendJson(res, 200, { id, object: 'chat.completion', created, model, choices: [{ index: 0, message: { role: 'assistant', content: out.text }, finish_reason: out.status === 'interrupted' ? 'length' : 'stop' }], usage: usageOf(out.usage) });
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' });
      const chunk = (delta, finish, extra) => res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra }) + '\n\n');
      chunk({ role: 'assistant' }, null);
      try {
        const out = await client.run({ model: localModel, prompt, signal: abort.signal, native, onText: t => chunk({ content: t }, null) });
        chunk({}, 'stop', out.usage ? { usage: usageOf(out.usage) } : undefined); res.write('data: [DONE]\n\n');
      } catch (e) { res.write('data: ' + JSON.stringify({ error: { message: e.message } }) + '\n\n'); }
      return res.end();
    } catch (e) {
      log('桥接错误：' + e.message);
      if (!res.headersSent) err(res, 502, e.message); else res.end();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split(/=(.*)/s).slice(0, 2)).map(([k, v]) => [k, v ?? true]));
  if (args.help) { console.log('用法：node bridge/yumeiro-bridge.mjs [--port=8788] [--discovery=<discovery.json>] [--cwd=<目录>] [--native] [--no-local]\n环境变量：YUMEIRO_TEAM_URL、YUMEIRO_TEAM_TOKEN（可选，团队服务器）、BRIDGE_API_KEY（可选，本地接口密钥）'); process.exit(0); }
  const client = args['no-local'] ? null : new CindyLocalClient({ discovery: args.discovery, cwd: args.cwd, tokenFile: args['token-file'] || '' });
  if (args.native) console.warn('警告：--native 会让 Cindy 智能体以你的系统用户权限读写文件、执行命令。');
  const server = createBridge({ client, native: Boolean(args.native), teamUrl: process.env.YUMEIRO_TEAM_URL || '', teamToken: process.env.YUMEIRO_TEAM_TOKEN || '', apiKey: process.env.BRIDGE_API_KEY || '', allowHosts: String(args['allow-host'] || '').split(',').map(x => x.trim()).filter(Boolean), log: m => console.error(m) });
  const port = Number(args.port || 8788), listen = String(args.listen || '127.0.0.1');
  if (listen !== '127.0.0.1' && listen !== 'localhost' && listen !== '::1' && !(process.env.BRIDGE_API_KEY || '').trim()) { console.error('拒绝启动：监听非本机地址时必须设置 BRIDGE_API_KEY'); process.exitCode = 1; }
  else server.listen(port, listen, () => {
    console.log(`Yumeiro 桥接已启动：http://127.0.0.1:${port}/v1（模型 cindy:* 本机 / team:* 团队服务器）`);
    // 启动后主动申请授权：桌面端会立刻弹出“允许”确认框，不必等第一次请求；失败（桌面端还没启动/没登录）则每 10 秒重试
    if (client) (async () => {
      for (;;) {
        try { await client.connect(m => console.log(m)); console.log('已获得 Cindy 桌面端授权'); return; }
        catch (e) { console.log('等待 Cindy 桌面端授权：' + e.message + '（10 秒后重试）'); await new Promise(r => setTimeout(r, 10000)); }
      }
    })();
  });
}
