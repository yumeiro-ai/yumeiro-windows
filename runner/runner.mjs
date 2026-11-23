#!/usr/bin/env node
// 智能体运行器：在隔离的容器里运行 Claude Code / Codex / Pi，只暴露一个带令牌的内部 HTTP 接口。
// 零依赖。运行器容器不挂载任何密钥，只能看到每次请求临时传入的模型密钥和对应工作区目录。
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, rm, stat, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createReadStream } from 'node:fs';
import { walkFiles, snapshotFile, snapshotWorkspace, listVersions, history, readVersion, restoreVersion, deleteWithBackup } from './filestore.mjs';
import { runWithFiles, mintExecToken, verifyExecToken, languagesFor, SANDBOX_LIMITS, SYNC_LIMITS } from './sandbox.mjs';
import { sanitizeMcp, claudeMcp, codexMcp, sanitizeGateway, codexGateway, anthropicBase, piAgentFiles, GW_PROVIDER, GW_KEY_ENV } from './mcp.mjs';
import { runSelfCheck } from './selfcheck.mjs';
import { killTree, resolveWinEngine, winChildEnv } from './winproc.mjs';

export const ENGINES = ['claude', 'codex', 'pi'];
const ENV_KEY = /^[A-Z][A-Z0-9_]{1,60}_(API_KEY|BASE_URL|TOKEN)$/; // 只允许传模型相关变量，拒绝 PATH / NODE_OPTIONS / LD_PRELOAD 等
const WORKSPACE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
// 传给引擎进程的环境：基础部分只有这几项；请求里额外带的变量只放行模型相关的（*_API_KEY / *_BASE_URL / *_TOKEN）。
// 运行和“引擎与隔离自检”用的是同一份函数，所以自检验证的就是真实行为。
export const baseChildEnv = (env, root, engine, platform = process.platform) => {
  const home = path.join(root, '.home', engine);
  return { PATH: env.PATH, HOME: home, LANG: 'C.UTF-8', CI: '1', NO_COLOR: '1', TERM: 'dumb', ...(platform === 'win32' ? winChildEnv(env, home) : {}) };
};
export function filterEngineEnv(extra) {
  const out = {};
  for (const [key, value] of Object.entries(extra || {})) if (ENV_KEY.test(key) && typeof value === 'string' && value.length < 4096) out[key] = value;
  return out;
}

const splitCmd = value => String(value).trim().split(/\s+/).filter(Boolean);
export function engineCommand(engine, env = process.env, platform = process.platform) {
  const configured = env[engine.toUpperCase() + '_CMD'];
  if (!configured && platform === 'win32') { const resolved = resolveWinEngine(engine, env); if (resolved) return resolved; } // Windows：不经 shell 直接启动 npm 装的引擎
  return splitCmd(configured || engine);
}

// 构造命令行。mode：readonly 只读；edit 可以读写工作区文件；exec 在 edit 的基础上多一个 sandbox_run 工具（代码在断网的沙箱容器里跑）。
// 任何模式下，引擎自己的 shell / Bash 工具都不开放。
export function buildInvocation(engine, { prompt, mode, model, system, provider, dir, mcp = [], gateway = null, env = process.env }) {
  const edit = mode === 'edit' || mode === 'exec';
  if (engine === 'claude') {
    const cm = claudeMcp(mcp), allowed = edit ? cm.tools : ['Read', 'Grep', 'Glob', ...cm.tools];
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--permission-mode', edit ? 'acceptEdits' : 'default',
      ...(edit ? ['--disallowedTools', 'Bash'] : []), ...(allowed.length ? ['--allowedTools', allowed.join(' ')] : []), ...cm.args,
      ...(model ? ['--model', model] : []), ...(system ? ['--append-system-prompt', system] : [])];
    return { args, parse: parseClaude };
  }
  if (engine === 'codex') {
    const text = system ? `${system}\n\n${prompt}` : prompt;
    const args = ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '-C', dir, '-s', edit ? 'workspace-write' : 'read-only', ...codexMcp(mcp), ...codexGateway(gateway, env), ...(model ? ['-m', model] : []), text];
    return { args, parse: parseCodex };
  }
  if (engine === 'pi') {
    const tools = edit ? 'read,edit,write,grep,find,ls' : 'read,grep,find,ls';
    const args = ['-p', prompt, '--no-session', '--no-context-files', '--tools', tools, ...(gateway ? ['--provider', GW_PROVIDER] : provider ? ['--provider', provider] : []), ...(model ? ['--model', model] : []), ...(system ? ['--append-system-prompt', system] : [])];
    return { args, parse: null }; // 文本模式：stdout 原样当作回复
  }
  throw new Error('未知引擎：' + engine);
}

// ---- 各引擎输出解析：把一行 JSON 转成 {text?, tool?, final?, usage?} ----
function parseClaude(line, state) {
  let event; try { event = JSON.parse(line); } catch { return null; }
  if (event.type === 'stream_event' && event.event?.type === 'content_block_delta' && event.event.delta?.type === 'text_delta') { state.streamed = true; return { text: event.event.delta.text }; }
  if (event.type === 'assistant') {
    const out = { tools: [] };
    for (const part of event.message?.content || []) {
      if (part.type === 'text' && !state.streamed) out.text = (out.text || '') + part.text;
      if (part.type === 'tool_use') out.tools.push({ name: part.name, detail: JSON.stringify(part.input || {}).slice(0, 300) });
    }
    state.streamed = false;
    return out.text || out.tools.length ? out : null;
  }
  if (event.type === 'result') return { final: typeof event.result === 'string' ? event.result : undefined, error: event.is_error ? String(event.result || 'error') : undefined, usage: event.usage ? { inputTokens: event.usage.input_tokens ?? null, outputTokens: event.usage.output_tokens ?? null } : undefined };
  return null;
}
function parseCodex(line, state) {
  let event; try { event = JSON.parse(line); } catch { return null; }
  const item = event.item || event.msg;
  const kind = item?.type;
  if (kind === 'agent_message') { const text = item.text ?? item.message ?? ''; state.last = text; return { text: text + '\n', final: text }; }
  if (kind === 'command_execution' || kind === 'exec_command_begin') return { tools: [{ name: 'shell', detail: String(item.command || '').slice(0, 300) }] };
  if (kind === 'file_change' || kind === 'patch_apply_begin') return { tools: [{ name: 'edit', detail: JSON.stringify(item.changes || item.path || '').slice(0, 300) }] };
  if (event.type === 'turn.completed' && event.usage) return { usage: { inputTokens: event.usage.input_tokens ?? null, outputTokens: event.usage.output_tokens ?? null } };
  if (event.type === 'error' || event.type === 'turn.failed') return { error: String(event.message || event.error?.message || 'error') };
  return null;
}

// ---- 路径安全 ----
export async function resolveInWorkspace(root, id, rel = '', { mustExist = true } = {}) {
  if (!WORKSPACE_ID.test(id)) throw Object.assign(new Error('工作区标识无效'), { status: 400 });
  const base = path.join(root, id);
  await mkdir(base, { recursive: true });
  const real = await realpath(base);
  const clean = String(rel || '').replace(/\\/g, '/');
  if (clean.includes('\0') || path.isAbsolute(clean) || clean.split('/').includes('..')) throw Object.assign(new Error('路径无效'), { status: 400 });
  const target = path.join(real, clean);
  // 目标（或最近的已存在父目录）经符号链接解析后必须仍在工作区内
  let probe = target;
  while (true) {
    try { const resolved = await realpath(probe); if (resolved !== real && !resolved.startsWith(real + path.sep)) throw Object.assign(new Error('路径越界'), { status: 400 }); break; }
    catch (error) { if (error.status) throw error; if (error.code !== 'ENOENT') throw error; if (mustExist && probe === target) throw Object.assign(new Error('文件不存在'), { status: 404 }); probe = path.dirname(probe); }
  }
  return { real, target };
}

function authorized(req, token) {
  const given = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  const wanted = Buffer.from(token);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}
// /exec 额外接受“只能在某个工作区跑代码”的短期令牌（给智能体的 MCP 进程用）；返回令牌绑定的工作区，完整令牌返回 true
function execAuth(req, token) {
  if (authorized(req, token)) return true;
  return verifyExecToken(token, String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''))?.workspace || false;
}
const readBody = (req, limit) => new Promise((resolve, reject) => {
  const chunks = []; let size = 0;
  req.on('data', chunk => { size += chunk.length; if (size > limit) { reject(Object.assign(new Error('请求过大'), { status: 413 })); req.destroy(); } else chunks.push(chunk); });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

export function createRunner({ token, sandboxToken, root, env = process.env, log = () => {} }) {
  if (!token || token.length < 16) throw new Error('RUNNER_TOKEN 至少需要 16 个字符');
  const maxConcurrent = Number(env.RUNNER_MAX_CONCURRENT) || 3, defaultTimeout = Number(env.RUNNER_TIMEOUT_SEC) || 600, maxOutput = 2 * 1024 * 1024;
  let running = 0;
  const maxUpload = (Number(env.RUNNER_MAX_UPLOAD_MB) || 210) * 1048576, maxDownload = (Number(env.RUNNER_MAX_DOWNLOAD_MB) || 210) * 1048576;
  const versions = {};
  const probe = engine => new Promise(resolve => {
    const [cmd, ...pre] = engineCommand(engine, env);
    execFile(cmd, [...pre, '--version'], { timeout: 8000, env: { PATH: env.PATH, HOME: env.HOME } }, (error, stdout, stderr) => resolve(error ? null : (String(stdout || stderr).trim().split('\n')[0].slice(0, 80) || '已安装')));
  });
  const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  // MCP 服务的启动器（npx / uvx）有没有：管理页的 MCP 市场用它提前标出“这个服务在运行器里装不了”
  const toolVersions = {};
  // 沙箱用哪套命令：Windows 默认走 PowerShell；装了 Git for Windows 并想用 bash 的，在运行器环境里设 SANDBOX_SHELL=posix
  const sandboxPlatform = env.SANDBOX_SHELL === 'posix' ? 'linux' : process.platform;
  const probeTool = (cmd, args = ['--version']) => new Promise(resolve => {
    // Windows 上 npx / uvx 是 .cmd 垫片，Node 不能直接启动：npx 改用 npm 自带的 npx-cli.js，其余按原样试（找不到就是没装）
    if (process.platform === 'win32' && cmd === 'npx') { const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js'); return execFile(process.execPath, [cli, '--version'], { timeout: 8000, env: { PATH: env.PATH, SystemRoot: env.SystemRoot, HOME: env.HOME } }, error => resolve(!error)); }
    execFile(cmd, args, { timeout: 8000, env: { PATH: env.PATH, HOME: env.HOME, ...(process.platform === 'win32' ? { SystemRoot: env.SystemRoot } : {}) } }, error => resolve(!error));
  });

  async function handleRun(req, res) {
    let body; try { body = JSON.parse((await readBody(req, 2 * 1024 * 1024)).toString('utf8')); } catch (error) { return json(res, error.status || 400, { error: '请求格式无效' }); }
    const engine = String(body.engine || ''), prompt = String(body.prompt || '');
    if (!ENGINES.includes(engine)) return json(res, 400, { error: '未知引擎' });
    if (!prompt.trim() || prompt.length > 200000) return json(res, 400, { error: 'prompt 为空或过长' });
    const mode = body.mode === 'edit' || body.mode === 'exec' ? body.mode : 'readonly';
    const sandboxUrl = String(env.SANDBOX_URL || '').replace(/\/+$/, '');
    if (mode === 'exec' && !sandboxUrl) return json(res, 400, { error: '运行器没有配置沙箱（SANDBOX_URL），不能使用“可运行代码”模式' });
    if (running >= maxConcurrent) return json(res, 429, { error: '运行器繁忙，请稍后再试' });
    let dir; try { dir = (await resolveInWorkspace(root, String(body.workspace || ''), '', { mustExist: false })).real; } catch (error) { return json(res, error.status || 400, { error: error.message }); }

    const editing = mode !== 'readonly', workspaceId = String(body.workspace);
    // 智能体动手改文件之前先存一版；结束后再存一版。相同内容不会重复存。
    if (editing) await snapshotWorkspace(root, workspaceId, dir).catch(error => log('运行前备份失败：' + error.message));
    const childEnv = baseChildEnv(env, root, engine);
    Object.assign(childEnv, filterEngineEnv(body.env));
    await mkdir(childEnv.HOME, { recursive: true });
    if (childEnv.TEMP) await mkdir(childEnv.TEMP, { recursive: true }); // Windows：引擎的临时目录在它自己的目录里
    let mcpList, gateway; try { mcpList = sanitizeMcp(body.mcp, env); gateway = sanitizeGateway(body.gateway); } catch (error) { return json(res, error.status || 400, { error: error.message }); }
    if (mode === 'exec') { // 沙箱 MCP：只带一个到期很快、只对本工作区有效的令牌，不带运行器令牌
      mcpList = [...mcpList, { name: 'sandbox', command: process.execPath, args: [path.join(path.dirname(fileURLToPath(import.meta.url)), 'sandbox-mcp.mjs')], env: { SANDBOX_URL: String(env.RUNNER_SELF_URL || 'http://127.0.0.1:' + (env.PORT || 8790)).replace(/\/+$/, ''), SANDBOX_WORKSPACE: workspaceId, SANDBOX_TOKEN: mintExecToken(token, workspaceId, Math.ceil(Number(body.timeoutSec || defaultTimeout) + 120)) } }];
    }
    const invocation = buildInvocation(engine, { prompt, mode, model: body.model ? String(body.model).slice(0, 200) : '', system: body.system ? String(body.system).slice(0, 8000) : '', provider: body.provider ? String(body.provider).slice(0, 60) : '', dir, mcp: mcpList, gateway, env });
    // 网关模型：Claude Code 用 Anthropic 环境变量；Codex 的服务商在命令行里；Pi 在单独的配置目录里写 models.json / mcp.json
    let piDir = '';
    if (gateway && engine === 'claude') { childEnv.ANTHROPIC_BASE_URL = anthropicBase(gateway.baseUrl); childEnv.ANTHROPIC_AUTH_TOKEN = childEnv[GW_KEY_ENV] || ''; delete childEnv.ANTHROPIC_API_KEY; }
    if (engine === 'pi') {
      const files = piAgentFiles({ gateway, mcp: mcpList });
      if (Object.keys(files).length) {
        piDir = path.join(childEnv.HOME, '.pi', 'run-' + randomBytes(6).toString('hex'));
        await mkdir(piDir, { recursive: true });
        for (const [name, content] of Object.entries(files)) await writeFile(path.join(piDir, name), content, { mode: 0o600 });
        childEnv.PI_CODING_AGENT_DIR = piDir;
      }
    }
    const [cmd, ...pre] = engineCommand(engine, env);
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    const send = value => { if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(value) + '\n'); };
    send({ type: 'start', engine, mode });

    running++;
    const child = spawn(cmd, [...pre, ...invocation.args], { cwd: dir, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    const state = { streamed: false, last: '' };
    let finalText = '', usage = null, errorText = '', plain = '', total = 0, status = 'completed', ended = false;
    const timeoutMs = Math.min(Math.max(Number(body.timeoutSec) || defaultTimeout, Number(env.RUNNER_MIN_TIMEOUT_SEC) || 10), 3600) * 1000;
    const stop = reason => { if (ended) return; status = reason; killTree(child, 'SIGTERM'); setTimeout(() => killTree(child, 'SIGKILL'), 3000).unref(); };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    res.on('close', () => { if (!res.writableEnded) stop('stopped'); });

    let buffer = '';
    const handleLine = line => {
      if (!line.trim()) return;
      if (!invocation.parse) { plain += line + '\n'; send({ type: 'text', text: line + '\n' }); return; }
      const parsed = invocation.parse(line, state);
      if (!parsed) return;
      if (parsed.text) send({ type: 'text', text: parsed.text });
      for (const tool of parsed.tools || []) send({ type: 'tool', ...tool });
      if (parsed.final !== undefined) finalText = parsed.final;
      if (parsed.usage) usage = parsed.usage;
      if (parsed.error) errorText = parsed.error;
    };
    child.stdout.on('data', chunk => {
      total += chunk.length; if (total > maxOutput) return stop('output_limit');
      buffer += chunk.toString('utf8');
      let index; while ((index = buffer.indexOf('\n')) >= 0) { handleLine(buffer.slice(0, index)); buffer = buffer.slice(index + 1); }
    });
    let stderr = '';
    child.stderr.on('data', chunk => { if (stderr.length < 4000) stderr += chunk.toString('utf8'); });
    await new Promise(resolve => child.on('close', async code => {
      ended = true; clearTimeout(timer); running--; if (buffer) handleLine(buffer);
      if (piDir) await rm(piDir, { recursive: true, force: true }).catch(() => {});
      if (status === 'completed' && (code !== 0 || errorText)) status = 'failed';
      if (editing) await snapshotWorkspace(root, workspaceId, dir).catch(error => log('运行后备份失败：' + error.message));
      send({ type: 'end', status, exitCode: code, final: (finalText || plain || state.last).trim(), error: status === 'failed' ? (errorText || stderr.trim().slice(-800) || '进程异常退出') : undefined, usage });
      res.end(); resolve();
    }));
    child.on('error', error => { send({ type: 'end', status: 'failed', error: '无法启动 ' + engine + '：' + error.message }); res.end(); });
  }

  // ---- 沙箱 ----
  // 两种角色，由 SANDBOX_ONLY 决定：
  //  · 沙箱容器（SANDBOX_ONLY=1）：不挂载任何卷、不能上外网，只提供 POST /sandbox/run —— 收到一份工作区文件副本，跑完把改动送回去；
  //  · 运行器（默认）：POST /exec 把工作区的文件打包发给沙箱（SANDBOX_URL），再把改动写回工作区（写回前后各存一版）。
  const maxExec = Number(env.SANDBOX_MAX_CONCURRENT) || 1; // 同一容器里的并发任务彼此不隔离（同一用户、同一 /tmp），默认一次只跑一个
  const syncLimits = { ...SYNC_LIMITS, maxTotalBytes: (Number(env.SANDBOX_MAX_SYNC_MB) || 20) * 1048576 };
  const sandboxLimits = { ...SANDBOX_LIMITS, ...(Number(env.SANDBOX_MAX_TIMEOUT_SEC) ? { maxTimeoutSec: Number(env.SANDBOX_MAX_TIMEOUT_SEC) } : {}) };
  let execRunning = 0;
  async function handleSandboxRun(req, res) {
    let body; try { body = JSON.parse((await readBody(req, syncLimits.maxTotalBytes * 2 + 1024 * 1024)).toString('utf8')); } catch (error) { return json(res, error.status || 400, { error: '请求格式无效' }); }
    if (execRunning >= maxExec) return json(res, 429, { error: '沙箱繁忙，请稍后再试' });
    execRunning++;
    try {
      return json(res, 200, await runWithFiles({ files: body.files, language: body.language, code: body.code, command: body.command, timeoutSec: body.timeoutSec, maxOutputBytes: Number(env.SANDBOX_MAX_OUTPUT_KB) ? Number(env.SANDBOX_MAX_OUTPUT_KB) * 1024 : undefined, env, limits: sandboxLimits, sync: syncLimits, platform: sandboxPlatform }));
    } catch (error) { return json(res, error.status || 500, { error: error.status ? error.message : '沙箱执行失败' }); }
    finally { execRunning--; }
  }
  async function handleExec(req, res, auth) {
    const sandboxUrl = String(env.SANDBOX_URL || '').replace(/\/+$/, '');
    if (!sandboxUrl) return json(res, 403, { error: '没有配置沙箱（SANDBOX_URL）。请按 docker-compose.sandbox.yml 部署沙箱容器' });
    let body; try { body = JSON.parse((await readBody(req, 512 * 1024)).toString('utf8')); } catch (error) { return json(res, error.status || 400, { error: '请求格式无效' }); }
    const workspaceId = String(body.workspace || '');
    if (auth !== true && auth !== workspaceId) return json(res, 403, { error: '这个令牌不能用于该工作区' });
    if (execRunning >= maxExec) return json(res, 429, { error: '沙箱繁忙，请稍后再试' });
    const ephemeral = body.ephemeral === true && auth === true; // 没有指定工作区：空目录里跑，不读也不写任何工作区文件
    let real = ''; if (!ephemeral) { try { real = (await resolveInWorkspace(root, workspaceId, '', { mustExist: false })).real; } catch (error) { return json(res, error.status || 400, { error: error.message }); } }
    execRunning++;
    try {
      // 1) 打包工作区文件（跳过 node_modules / .git；超过上限就明确拒绝，不静默漏文件）
      const tree = ephemeral ? { files: [], truncated: false } : await walkFiles(real, { max: syncLimits.maxFiles + 1 });
      if (tree.truncated || tree.files.length > syncLimits.maxFiles) return json(res, 413, { error: '工作区文件太多（超过 ' + syncLimits.maxFiles + ' 个），沙箱放不下' });
      const bytes = tree.files.reduce((sum, file) => sum + file.size, 0);
      if (bytes > syncLimits.maxTotalBytes) return json(res, 413, { error: '工作区文件太大（' + (bytes / 1048576).toFixed(1) + ' MB），沙箱最多接收 ' + Math.round(syncLimits.maxTotalBytes / 1048576) + ' MB' });
      const files = [];
      for (const file of tree.files) files.push({ path: file.path, data: (await readFile(path.join(real, ...file.path.split('/')))).toString('base64') });
      // 2) 交给沙箱
      const timeoutSec = Math.min(Math.max(Number(body.timeoutSec) || sandboxLimits.timeoutSec, 1), sandboxLimits.maxTimeoutSec);
      let response;
      try {
        response = await fetch(sandboxUrl + '/sandbox/run', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout((timeoutSec + 30) * 1000), headers: { Authorization: 'Bearer ' + (sandboxToken || token), 'Content-Type': 'application/json' }, body: JSON.stringify({ files, language: body.language, code: body.code, command: body.command, timeoutSec }) });
      } catch { return json(res, 502, { error: '无法连接沙箱' }); }
      const result = await response.json().catch(() => ({}));
      if (!response.ok) return json(res, response.status === 429 ? 429 : response.status === 400 || response.status === 413 ? response.status : 502, { error: result.error || '沙箱返回 HTTP ' + response.status });
      // 3) 把改动写回工作区（先备份；每个路径都过一遍工作区路径检查，防止符号链接/越界）
      const changed = [], removed = [];
      if (!ephemeral && ((result.written || []).length || (result.deleted || []).length)) {
        await snapshotWorkspace(root, workspaceId, real).catch(error => log('沙箱写回前备份失败：' + error.message));
        for (const item of result.written || []) {
          const { target } = await resolveInWorkspace(root, workspaceId, String(item.path || ''), { mustExist: false }).catch(() => ({}));
          if (!target) continue;
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, Buffer.from(String(item.data || ''), 'base64'));
          changed.push(item.path);
        }
        for (const rel of result.deleted || []) {
          const { target } = await resolveInWorkspace(root, workspaceId, String(rel || ''), { mustExist: false }).catch(() => ({}));
          if (!target) continue;
          await rm(target, { force: true }); removed.push(rel);
        }
        await snapshotWorkspace(root, workspaceId, real).catch(error => log('沙箱写回后备份失败：' + error.message));
      }
      const { written, deleted, ...rest } = result;
      return json(res, 200, { ...rest, changed, removed });
    } catch (error) {
      return json(res, error.status || 500, { error: error.status ? error.message : '沙箱执行失败' });
    } finally { execRunning--; }
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const auth = url.pathname === '/exec' && req.method === 'POST' ? execAuth(req, token) : authorized(req, token);
      if (!auth) return json(res, 401, { error: '未授权' });
      const sandboxOnly = env.SANDBOX_ONLY === '1';
      // 沙箱容器只提供 /sandbox/run 和 /health；运行器不提供 /sandbox/run
      if (req.method === 'POST' && url.pathname === '/sandbox/run' && sandboxOnly) return await handleSandboxRun(req, res);
      if (sandboxOnly && !(req.method === 'GET' && url.pathname === '/health')) return json(res, 404, { error: '未找到' });
      if (req.method === 'POST' && url.pathname === '/exec') return await handleExec(req, res, auth);
      if (req.method === 'GET' && url.pathname === '/health') {
        if (sandboxOnly) {
          const languages = {};
          for (const [name, spec] of Object.entries(languagesFor(sandboxPlatform))) languages[name] = { label: spec.label, installed: await (toolVersions['lang:' + name] ??= probeTool(spec.cmd[0], spec.probe)) };
          return json(res, 200, { ok: true, sandbox: true, running: execRunning, maxConcurrent: maxExec, languages });
        }
        const engines = {};
        for (const engine of ENGINES) { versions[engine] ??= await probe(engine); engines[engine] = { installed: Boolean(versions[engine]), version: versions[engine] }; }
        return json(res, 200, { ok: true, running, maxConcurrent, engines, sandboxConfigured: Boolean(env.SANDBOX_URL), tools: { npx: (toolVersions.npx ??= await probeTool('npx')), uvx: (toolVersions.uvx ??= await probeTool('uvx')) } });
      }
      if (req.method === 'GET' && url.pathname === '/selfcheck') {
        // 引擎与隔离自检：只读，不调用模型。在运行器自己的进程里跑，看到的就是引擎真实的运行环境
        for (const engine of ENGINES) versions[engine] ??= await probe(engine);
        const sandboxBase = String(env.SANDBOX_URL || '').replace(/\/+$/, '');
        const sandboxHealth = sandboxBase ? async () => { const r = await fetch(sandboxBase + '/health', { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { Authorization: 'Bearer ' + (sandboxToken || token) } }); return r.ok ? await r.json() : { ok: false }; } : null;
        return json(res, 200, await runSelfCheck({ root, env, versions, tools: { npx: (toolVersions.npx ??= await probeTool('npx')), uvx: (toolVersions.uvx ??= await probeTool('uvx')) }, resolveInWorkspace, baseChildEnv, filterEngineEnv, sandboxHealth }));
      }
      if (req.method === 'POST' && url.pathname === '/run') return await handleRun(req, res);

      const workspace = url.searchParams.get('workspace') || '', rel = url.searchParams.get('path') || '';
      if (url.pathname === '/files' && req.method === 'GET') {
        const { real, target } = await resolveInWorkspace(root, workspace, rel);
        const info = await stat(target);
        if (info.isDirectory()) {
          const entries = [];
          for (const name of (await readdir(target)).sort().slice(0, 500)) { const item = await lstat(path.join(target, name)); entries.push({ name, type: item.isDirectory() ? 'dir' : item.isSymbolicLink() ? 'link' : 'file', size: item.size, mtime: Math.floor(item.mtimeMs) }); }
          return json(res, 200, { type: 'dir', path: path.relative(real, target).split(path.sep).join('/'), entries });
        }
        const data = await readFile(target);
        const slice = data.subarray(0, 262144);
        if (slice.includes(0)) return json(res, 200, { type: 'binary', size: info.size });
        return json(res, 200, { type: 'file', size: info.size, truncated: data.length > slice.length, content: slice.toString('utf8') });
      }
      if (url.pathname === '/files' && req.method === 'PUT') {
        if (!rel) return json(res, 400, { error: '缺少路径' });
        const { real, target } = await resolveInWorkspace(root, workspace, rel, { mustExist: false });
        await snapshotFile(root, workspace, real, path.relative(real, target).split(path.sep).join('/'), { force: true }).catch(() => {});
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, await readBody(req, maxUpload));
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/files' && req.method === 'DELETE') {
        if (!rel) return json(res, 400, { error: '缺少路径' });
        const { real, target } = await resolveInWorkspace(root, workspace, rel);
        // 删除前先备份（文件夹则备份其中所有文件），备份失败就不删
        const info = await lstat(target);
        const relPath = path.relative(real, target).split(path.sep).join('/');
        if (info.isDirectory()) { const { files } = await walkFiles(target); for (const file of files) await snapshotFile(root, workspace, real, relPath + '/' + file.path, { force: true }); }
        else await snapshotFile(root, workspace, real, relPath, { force: true });
        await rm(target, { recursive: true, force: true });
        return json(res, 200, { ok: true });
      }
      // 搜索：文件名匹配 + （可选）文件内容匹配，忽略大小写。跳过 node_modules / .git / .versions；最多扫 5000 个文件、读 20 MB 内容、返回 100 个文件（每个文件最多 3 行匹配），超限会标 truncated
      if (url.pathname === '/search' && req.method === 'GET') {
        const q = (url.searchParams.get('q') || '').trim(), content = url.searchParams.get('content') === '1';
        if (!q || q.length > 100) return json(res, 400, { error: '搜索词需要 1–100 个字符' });
        const { real } = await resolveInWorkspace(root, workspace, '');
        const { files, truncated: walkCut } = await walkFiles(real, { max: 5000 });
        const needle = q.toLowerCase(), results = []; let budget = 20 * 1048576, cut = walkCut;
        for (const file of files) {
          if (results.length >= 100) { cut = true; break; }
          const nameHit = file.path.toLowerCase().includes(needle), lines = [];
          if (content && file.size > 0 && file.size <= 512 * 1024 && budget > 0) {
            budget -= file.size;
            const data = await readFile(path.join(real, ...file.path.split('/'))).catch(() => null);
            if (data && !data.subarray(0, 8192).includes(0)) {
              const text = data.toString('utf8').split(/\r?\n/);
              for (let i = 0; i < text.length && lines.length < 3; i++) if (text[i].toLowerCase().includes(needle)) lines.push({ n: i + 1, text: text[i].slice(0, 200) });
            }
          }
          if (nameHit || lines.length) results.push({ path: file.path, size: file.size, mtime: file.mtime, nameHit, lines });
        }
        return json(res, 200, { q, content, results, truncated: cut, scanned: files.length });
      }
      if (url.pathname === '/raw' && req.method === 'GET') {
        const { target } = await resolveInWorkspace(root, workspace, rel);
        const info = await stat(target);
        if (!info.isFile()) return json(res, 400, { error: '这不是文件' });
        if (info.size > maxDownload) return json(res, 413, { error: '文件太大，无法下载' });
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': info.size });
        const stream = createReadStream(target); stream.on('error', () => res.destroy()); stream.pipe(res);
        return;
      }
      // ---- 文件管理：清单 / 版本历史 / 还原 / 批量删除（先备份）----
      if (url.pathname === '/tree' && req.method === 'GET') {
        const { real } = await resolveInWorkspace(root, workspace, '');
        return json(res, 200, await walkFiles(real));
      }
      if (url.pathname === '/history' && req.method === 'GET') {
        const { real } = await resolveInWorkspace(root, workspace, '');
        return json(res, 200, { files: await history(root, workspace, real) });
      }
      if (url.pathname === '/versions' && req.method === 'GET') {
        await resolveInWorkspace(root, workspace, '');
        if (!rel) return json(res, 400, { error: '缺少路径' });
        const id = url.searchParams.get('id');
        if (id) return json(res, 200, await readVersion(root, workspace, rel, id));
        return json(res, 200, { versions: await listVersions(root, workspace, rel) });
      }
      if (url.pathname === '/restore' && req.method === 'POST') {
        if (!rel) return json(res, 400, { error: '缺少路径' });
        const { real, target } = await resolveInWorkspace(root, workspace, rel, { mustExist: false });
        await restoreVersion(root, workspace, real, target, path.relative(real, target).split(path.sep).join('/'), String(url.searchParams.get('id') || ''));
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/snapshot' && req.method === 'POST') {
        const { real } = await resolveInWorkspace(root, workspace, '');
        return json(res, 200, await snapshotWorkspace(root, workspace, real));
      }
      if (url.pathname === '/delete-batch' && req.method === 'POST') {
        const { real } = await resolveInWorkspace(root, workspace, '');
        let items; try { items = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8')).items; } catch { return json(res, 400, { error: '请求格式无效' }); }
        if (!Array.isArray(items) || items.length > 500) return json(res, 400, { error: '一次最多处理 500 个文件' });
        const checked = [];
        for (const item of items) {
          const { target } = await resolveInWorkspace(root, workspace, String(item.path || ''), { mustExist: false });
          checked.push({ path: path.relative(real, target).split(path.sep).join('/'), mtime: Number.isFinite(item.mtime) ? item.mtime : undefined });
        }
        return json(res, 200, await deleteWithBackup(root, workspace, real, checked));
      }
      if (url.pathname === '/workspace' && req.method === 'DELETE') {
        const { real } = await resolveInWorkspace(root, workspace, '');
        await snapshotWorkspace(root, workspace, real).catch(() => {}); // 删除工作区前留一份，备份保留在 .versions 里
        await rm(real, { recursive: true, force: true });
        return json(res, 200, { ok: true });
      }
      json(res, 404, { error: '未找到' });
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : '运行器内部错误' });
      else res.end();
      if (!error.status) log('运行器错误：' + error.message);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.env.WORKSPACES_DIR || '/workspaces';
  await mkdir(root, { recursive: true });
  const { readFile } = await import('node:fs/promises');
  let token = process.env.SANDBOX_ONLY === '1' ? '' : process.env.RUNNER_TOKEN || '';
  if (process.env.SANDBOX_ONLY !== '1' && process.env.RUNNER_TOKEN_FILE) {
    try { token = (await readFile(process.env.RUNNER_TOKEN_FILE, 'utf8')).trim(); }
    catch (error) { console.error(`无法读取 RUNNER_TOKEN_FILE（${process.env.RUNNER_TOKEN_FILE}）：${error.code || error.message}。请检查 secrets/runner_token 是否存在且对所有用户可读（chmod 644）。`); process.exit(1); }
  }
  let sandboxToken = process.env.SANDBOX_TOKEN || '';
  if (process.env.SANDBOX_TOKEN_FILE) {
    try { sandboxToken = (await readFile(process.env.SANDBOX_TOKEN_FILE, 'utf8')).trim(); }
    catch (error) { console.error(`无法读取 SANDBOX_TOKEN_FILE（${process.env.SANDBOX_TOKEN_FILE}）：${error.code || error.message}`); process.exit(1); }
  }
  // 沙箱容器只认沙箱令牌，不持有运行器令牌（沙箱里跑的是不可信代码，不能让它拿到运行器的完整权限）
  if (process.env.SANDBOX_ONLY === '1') { if (!sandboxToken) { console.error('沙箱容器需要 SANDBOX_TOKEN_FILE'); process.exit(1); } token = sandboxToken; }
  const server = createRunner({ token, sandboxToken, root, log: message => console.error(message) });
  const port = Number(process.env.PORT || 8790);
  server.listen(port, process.env.HOST || '0.0.0.0', () => console.log('Yumeiro runner listening on :' + port));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.close(); setTimeout(() => process.exit(0), 500); });
}
