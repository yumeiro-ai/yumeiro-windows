// 运行器里的 MCP 处理：再校验一遍（不信任调用方），并生成 Claude Code / Codex 的命令行参数。
const NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const COMMAND = /^[A-Za-z0-9._\/@+:~-]{1,200}$/;
const ENV_KEY = /^[A-Z_][A-Z0-9_]{0,60}$/;
const DEFAULT_COMMANDS = 'npx,uvx,node,python3,python,bunx,deno';

const fail = message => Object.assign(new Error(message), { status: 400 });

// 允许的命令：RUNNER_MCP_COMMANDS（逗号分隔，* 表示不限制），默认只允许常见的 MCP 启动器。RUNNER_MCP=0 完全禁用。
export function sanitizeMcp(list, env = process.env) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw fail('mcp 格式不对');
  if (!list.length) return [];
  if (env.RUNNER_MCP === '0') throw fail('这个运行器已禁用 MCP（RUNNER_MCP=0）');
  if (list.length > 10) throw fail('MCP 服务过多');
  const allow = String(env.RUNNER_MCP_COMMANDS || DEFAULT_COMMANDS).split(',').map(value => value.trim()).filter(Boolean);
  const seen = new Set();
  return list.map(item => {
    const name = String(item?.name || ''), command = String(item?.command || '');
    if (!NAME.test(name) || seen.has(name)) throw fail('MCP 服务名不合法：' + name);
    seen.add(name);
    if (!COMMAND.test(command)) throw fail(`MCP「${name}」的命令不合法`);
    if (!allow.includes('*') && !allow.includes(command)) throw fail(`MCP「${name}」的命令 ${command} 不在运行器允许列表里（RUNNER_MCP_COMMANDS=${allow.join(',')}）`);
    const args = (Array.isArray(item.args) ? item.args : []).map(String);
    if (args.length > 30 || args.some(value => value.length > 1000 || value.includes('\0'))) throw fail(`MCP「${name}」的参数不合法`);
    const vars = {};
    for (const [key, value] of Object.entries(item.env && typeof item.env === 'object' ? item.env : {})) {
      if (!ENV_KEY.test(key) || typeof value !== 'string' || value.length > 4000 || value.includes('\0')) throw fail(`MCP「${name}」的环境变量不合法：${key}`);
      vars[key] = value;
    }
    return { name, command, args, env: vars };
  });
}

// Claude Code：--mcp-config 给出服务，--strict-mcp-config 只用这些；工具名是 mcp__服务名。
export function claudeMcp(servers) {
  if (!servers.length) return { args: [], tools: [] };
  const mcpServers = Object.fromEntries(servers.map(server => [server.name, { command: server.command, args: server.args, env: server.env }]));
  return { args: ['--mcp-config', JSON.stringify({ mcpServers }), '--strict-mcp-config'], tools: servers.map(server => 'mcp__' + server.name) };
}

// Codex：用 -c 覆盖配置（值按 TOML 解析；JSON 字符串和数组都是合法的 TOML）。
const toml = value => JSON.stringify(value);
export function codexMcp(servers) {
  const args = [];
  for (const server of servers) {
    const base = 'mcp_servers.' + server.name;
    args.push('-c', `${base}.command=${toml(server.command)}`, '-c', `${base}.args=[${server.args.map(toml).join(',')}]`);
    const pairs = Object.entries(server.env);
    if (pairs.length) args.push('-c', `${base}.env={${pairs.map(([key, value]) => `${key}=${toml(value)}`).join(',')}}`);
  }
  return args;
}

// ---- Pi 的 MCP（<agent-dir>/mcp.json）----
export function piMcpJson(servers) {
  return JSON.stringify({ mcpServers: Object.fromEntries(servers.map(server => [server.name, { command: server.command, args: server.args, env: server.env }])) }, null, 2);
}

// ---- 网关模型（Cindy 托管模型等）：让引擎直接用网关的地址和密钥 ----
export const GW_PROVIDER = 'yumeiro-gw';
export const GW_KEY_ENV = 'YUMEIRO_GW_API_KEY';
export function sanitizeGateway(value) {
  if (value === undefined || value === null) return null;
  let url; try { url = new URL(String(value.baseUrl || '')); } catch { throw fail('gateway.baseUrl 不是有效地址'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw fail('gateway.baseUrl 协议不支持');
  const model = String(value.model || '').trim();
  if (!/^[A-Za-z0-9._:\/-]{1,200}$/.test(model)) throw fail('gateway.model 不合法');
  return { baseUrl: url.toString().replace(/\/+$/, ''), model };
}
// Codex：用 -c 临时定义一个服务商（密钥从环境变量读，不写进命令行）。新版 Codex 只讲 responses 协议，需要时可设 RUNNER_CODEX_WIRE_API=chat。
export function codexGateway(gateway, env = process.env) {
  if (!gateway) return [];
  const base = 'model_providers.' + GW_PROVIDER, wire = env.RUNNER_CODEX_WIRE_API === 'chat' ? 'chat' : 'responses';
  return ['-c', `model_provider=${JSON.stringify(GW_PROVIDER)}`, '-c', `${base}.name="Yumeiro Gateway"`, '-c', `${base}.base_url=${JSON.stringify(gateway.baseUrl)}`,
    '-c', `${base}.env_key=${JSON.stringify(GW_KEY_ENV)}`, '-c', `${base}.wire_api=${JSON.stringify(wire)}`];
}
// Claude Code 走 Anthropic 协议：地址不带结尾的 /v1。
export const anthropicBase = baseUrl => String(baseUrl).replace(/\/+$/, '').replace(/\/v1$/, '');
// Pi：每次运行单独一个配置目录，里面写 models.json（网关）和 mcp.json（MCP）。
export function piAgentFiles({ gateway, mcp }) {
  const files = {};
  if (gateway) files['models.json'] = JSON.stringify({ providers: { [GW_PROVIDER]: { baseUrl: gateway.baseUrl, api: 'openai-completions', apiKey: '$' + GW_KEY_ENV, models: [{ id: gateway.model }] } } }, null, 2);
  if (mcp && mcp.length) files['mcp.json'] = piMcpJson(mcp);
  return files;
}
