#!/usr/bin/env node
// 真实验证 Claude Code / Codex / Pi 能否在运行器里跑通（走和网站完全相同的 /run 接口）。
// 通常在运行器容器内执行：scripts/verify-agents.sh 会把本文件通过标准输入交给容器里的 node。
//
// 每个引擎检查：
//   1. 已安装（health 报告版本）
//   2. 能收到模型回复                （只读模式；回复里要包含随机口令）
//   3. 能在工作区创建文件            （可改文件模式；读回文件内容比对）
//   4. 只读模式不会写文件            （只读模式下要求创建文件，文件不应出现）
// 需要真实的模型密钥，通过环境变量提供：
//   claude  ANTHROPIC_API_KEY  [ANTHROPIC_BASE_URL] [CLAUDE_MODEL]
//   codex   OPENAI_API_KEY     [OPENAI_BASE_URL]    [CODEX_MODEL]
//   pi      PI_PROVIDER(默认 anthropic) PI_API_KEY   [PI_MODEL]
// 用法：node verify.mjs [--engine=claude,codex,pi] [--timeout=240] [--strict]
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split(/=(.*)/s).slice(0, 2)).map(([k, v]) => [k, v ?? true]));
const wanted = String(args.engine || 'claude,codex,pi').split(',').map(s => s.trim()).filter(Boolean);
const timeoutMs = (Number(args.timeout) || 240) * 1000;
const url = (args.url || process.env.RUNNER_URL || 'http://127.0.0.1:8790').replace(/\/+$/, '');
let token = process.env.RUNNER_TOKEN || '';
if (!token) {
  const file = process.env.RUNNER_TOKEN_FILE || '/run/secrets/runner_token';
  try { token = (await readFile(file, 'utf8')).trim(); } catch (error) { fatal(`读不到运行器令牌（${file}：${error.code}）。请确认 secrets/runner_token 存在且可读（chmod 644），或设置 RUNNER_TOKEN。`); }
}
const PI_KEYS = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', google: 'GEMINI_API_KEY', gemini: 'GEMINI_API_KEY', deepseek: 'DEEPSEEK_API_KEY', groq: 'GROQ_API_KEY', openrouter: 'OPENROUTER_API_KEY', xai: 'XAI_API_KEY', mistral: 'MISTRAL_API_KEY' };
const E = process.env;
const configs = {
  claude: { key: E.ANTHROPIC_API_KEY, model: E.CLAUDE_MODEL, env: () => ({ ANTHROPIC_API_KEY: E.ANTHROPIC_API_KEY, ...(E.ANTHROPIC_BASE_URL ? { ANTHROPIC_BASE_URL: E.ANTHROPIC_BASE_URL } : {}) }), need: 'ANTHROPIC_API_KEY' },
  codex: { key: E.OPENAI_API_KEY, model: E.CODEX_MODEL, env: () => ({ OPENAI_API_KEY: E.OPENAI_API_KEY, ...(E.OPENAI_BASE_URL ? { OPENAI_BASE_URL: E.OPENAI_BASE_URL } : {}) }), need: 'OPENAI_API_KEY' },
  pi: { key: E.PI_API_KEY, model: E.PI_MODEL, provider: E.PI_PROVIDER || 'anthropic', env: () => ({ [PI_KEYS[E.PI_PROVIDER || 'anthropic'] || (E.PI_PROVIDER || 'anthropic').toUpperCase().replace(/-/g, '_') + '_API_KEY']: E.PI_API_KEY }), need: 'PI_API_KEY（和 PI_PROVIDER）' }
};

function fatal(message) { console.error('✗ ' + message); process.exit(2); }
const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
const workspace = 'verify-' + randomBytes(4).toString('hex');

async function runEngine(engine, prompt, mode) {
  const config = configs[engine];
  const started = Date.now();
  let response;
  try {
    response = await fetch(url + '/run', { method: 'POST', headers, signal: AbortSignal.timeout(timeoutMs + 15000), body: JSON.stringify({ engine, prompt, mode, workspace, model: config.model || undefined, provider: config.provider || undefined, env: config.env(), timeoutSec: Math.floor(timeoutMs / 1000) }) });
  } catch (error) { return { ok: false, error: '无法连接运行器：' + (error.cause?.code || error.message), ms: Date.now() - started }; }
  if (!response.ok) return { ok: false, error: 'HTTP ' + response.status + ' ' + ((await response.json().catch(() => ({}))).error || ''), ms: Date.now() - started };
  const events = (await response.text()).split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const end = events.at(-1);
  if (!end || end.type !== 'end') return { ok: false, error: '运行器输出被截断（没有结束事件）', ms: Date.now() - started, events };
  return { ok: end.status === 'completed', status: end.status, final: end.final || '', error: end.error, usage: end.usage, events, ms: Date.now() - started };
}
async function readFileFromWorkspace(rel) {
  const response = await fetch(`${url}/files?workspace=${workspace}&path=${encodeURIComponent(rel)}`, { headers });
  if (response.status === 404) return null;
  const data = await response.json().catch(() => ({}));
  return data.type === 'file' ? String(data.content) : null;
}
const hint = text => {
  const t = String(text || '');
  if (/401|403|unauthori[sz]ed|invalid.*(api.?key|x-api-key)|authentication/i.test(t)) return '→ 密钥无效或没有权限：检查密钥，以及自定义地址是否支持该模型。';
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|network/i.test(t)) return '→ 运行器访问不到模型服务：检查服务器出网、DNS、代理，以及 *_BASE_URL 是否可达。';
  if (/model/i.test(t) && /(not found|does not exist|unknown|invalid)/i.test(t)) return '→ 模型名不对：用 CLAUDE_MODEL / CODEX_MODEL / PI_MODEL 指定该服务商支持的模型。';
  if (/429|rate.?limit|quota|insufficient/i.test(t)) return '→ 被限流或额度不足。';
  if (/ENOENT|无法启动/.test(t)) return '→ 命令行没有安装好：重新构建运行器镜像（docker compose build --no-cache runner）。';
  return '';
};

const results = [];
const record = (engine, check, status, detail = '') => { results.push({ engine, check, status, detail }); console.log(`  ${status === 'PASS' ? '✓' : status === 'SKIP' ? '–' : '✗'} ${check}${detail ? '：' + detail : ''}`); };

let health;
try { health = await (await fetch(url + '/health', { headers })).json(); } catch (error) { fatal('无法连接运行器 ' + url + '：' + (error.cause?.code || error.message)); }
if (!health?.engines) fatal('运行器返回了意外的内容（令牌错误？）：' + JSON.stringify(health).slice(0, 200));
console.log(`运行器 ${url}（并发上限 ${health.maxConcurrent}）\n`);

for (const engine of wanted) {
  if (!configs[engine]) { console.log(`未知引擎：${engine}`); process.exitCode = 2; continue; }
  console.log(`【${engine}】`);
  const info = health.engines[engine];
  if (!info?.installed) { record(engine, '已安装', 'FAIL', '运行器里找不到这个命令行（镜像构建失败或被裁剪）'); continue; }
  record(engine, '已安装', 'PASS', info.version);
  const config = configs[engine];
  if (!config.key) { record(engine, '真实调用', 'SKIP', `没有提供 ${config.need}，跳过`); continue; }

  const tag = 'OK-' + randomBytes(3).toString('hex');
  const talk = await runEngine(engine, `请只回复下面这个口令本身，不要加任何其他文字：${tag}`, 'readonly');
  if (talk.ok && talk.final.includes(tag)) record(engine, '能收到模型回复', 'PASS', `${(talk.ms / 1000).toFixed(1)}s，${talk.events.filter(e => e.type === 'text').length} 段流式文本${talk.usage ? '，返回了用量' : ''}`);
  else { record(engine, '能收到模型回复', 'FAIL', (talk.error || `回复里没有口令（实际：${talk.final.slice(0, 120)}）`).slice(0, 400)); const h = hint(talk.error || talk.final); if (h) console.log('    ' + h); continue; }

  const content = 'FILE-' + randomBytes(3).toString('hex');
  const write = await runEngine(engine, `在当前目录创建一个文件 verify.txt，内容恰好是 ${content}（不要有其他内容），创建后只回复 DONE。`, 'edit');
  const written = await readFileFromWorkspace('verify.txt');
  if (written !== null && written.trim() === content) record(engine, '能在工作区创建文件', 'PASS', `${(write.ms / 1000).toFixed(1)}s`);
  else record(engine, '能在工作区创建文件', 'FAIL', write.error ? write.error.slice(0, 300) : written === null ? '没有生成 verify.txt（模型没有调用写文件工具，或写入被沙箱拒绝）' : `文件内容不对：${written.slice(0, 80)}`);

  const ro = await runEngine(engine, `在当前目录创建一个文件 readonly-check.txt，内容是 hello。`, 'readonly');
  const leaked = await readFileFromWorkspace('readonly-check.txt');
  if (leaked === null) record(engine, '只读模式不会写文件', 'PASS', ro.ok ? '模型拒绝或无法写入' : `运行${ro.status || '失败'}，且没有产生文件`);
  else record(engine, '只读模式不会写文件', 'FAIL', '只读模式下文件被创建了！权限限制没有生效，请不要把该引擎开放给成员');
}

await fetch(`${url}/workspace?workspace=${workspace}`, { method: 'DELETE', headers }).catch(() => {});
const failed = results.filter(r => r.status === 'FAIL'), skipped = results.filter(r => r.status === 'SKIP');
console.log(`\n汇总：${results.filter(r => r.status === 'PASS').length} 项通过，${failed.length} 项失败，${skipped.length} 项跳过`);
if (failed.length) { console.log('失败项：' + failed.map(r => `${r.engine}/${r.check}`).join('；')); process.exit(1); }
if (args.strict && skipped.length) process.exit(1);
