import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanMcpServers, maskMcpServers, mcpForEngine, MCP_MASK } from '../mcp.mjs';
import { sanitizeMcp, claudeMcp, codexMcp, sanitizeGateway, codexGateway, anthropicBase, piAgentFiles } from '../runner/mcp.mjs';
import { modelEngines } from '../platform-models.mjs';
import { buildInvocation } from '../runner/runner.mjs';

const fetchServer = { name: 'fetch', command: 'uvx', args: ['mcp-server-fetch'], env: { API_TOKEN: 'secret' } };

test('MCP 配置：校验名字、命令、环境变量，拒绝带空格或 shell 符号的命令', () => {
  const [ok] = cleanMcpServers([fetchServer]);
  assert.deepEqual(ok.engines, ['claude', 'codex', 'pi']); assert.equal(ok.enabled, true);
  for (const bad of [{ ...fetchServer, name: 'Bad Name' }, { ...fetchServer, command: 'npx -y x' }, { ...fetchServer, command: 'sh;rm' }, { ...fetchServer, env: { 'lower': '1' } }])
    assert.throws(() => cleanMcpServers([bad]));
  assert.throws(() => cleanMcpServers([fetchServer, fetchServer]), /重复/);
  assert.throws(() => cleanMcpServers(Array.from({ length: 11 }, (_, i) => ({ ...fetchServer, name: 'a' + i }))), /10/);
});

test('MCP 配置：页面只看到打码的环境变量，保存时打码值沿用旧值', () => {
  const saved = cleanMcpServers([fetchServer]);
  assert.equal(maskMcpServers(saved)[0].env.API_TOKEN, MCP_MASK);
  const again = cleanMcpServers([{ ...fetchServer, env: { API_TOKEN: MCP_MASK, NEW: 'x' } }], saved);
  assert.equal(again[0].env.API_TOKEN, 'secret'); assert.equal(again[0].env.NEW, 'x');
});

test('MCP 配置：只发给选了的引擎，停用的不发', () => {
  const list = cleanMcpServers([fetchServer, { name: 'db', command: 'npx', args: ['x'], engines: ['codex'] }, { name: 'off', command: 'node', enabled: false }]);
  assert.deepEqual(mcpForEngine(list, 'claude').map(s => s.name), ['fetch']);
  assert.deepEqual(mcpForEngine(list, 'codex').map(s => s.name), ['fetch', 'db']);
  assert.deepEqual(mcpForEngine(list, 'pi').map(s => s.name), ['fetch']);
  assert.deepEqual(mcpForEngine(cleanMcpServers([{ ...fetchServer, engines: ['claude'] }]), 'pi'), []);
});

test('运行器：命令必须在允许列表里，RUNNER_MCP=0 整体禁用', () => {
  assert.equal(sanitizeMcp([fetchServer], {}).length, 1);
  assert.throws(() => sanitizeMcp([{ ...fetchServer, command: 'bash' }], {}), /允许列表/);
  assert.equal(sanitizeMcp([{ ...fetchServer, command: 'bash' }], { RUNNER_MCP_COMMANDS: '*' }).length, 1);
  assert.throws(() => sanitizeMcp([fetchServer], { RUNNER_MCP: '0' }), /禁用/);
  assert.deepEqual(sanitizeMcp([], { RUNNER_MCP: '0' }), []);
  assert.deepEqual(sanitizeMcp(undefined, {}), []);
});

test('运行器：Claude Code / Codex 命令行带上 MCP，工具名是 mcp__服务名', () => {
  const servers = sanitizeMcp([fetchServer], {});
  const c = buildInvocation('claude', { prompt: 'hi', mode: 'readonly', mcp: servers }).args;
  assert.equal(c[c.indexOf('--allowedTools') + 1], 'Read Grep Glob mcp__fetch');
  assert.ok(c.includes('--strict-mcp-config'));
  assert.deepEqual(JSON.parse(c[c.indexOf('--mcp-config') + 1]).mcpServers.fetch, { command: 'uvx', args: ['mcp-server-fetch'], env: { API_TOKEN: 'secret' } });
  const e = buildInvocation('claude', { prompt: 'hi', mode: 'edit', mcp: servers }).args;
  assert.equal(e[e.indexOf('--allowedTools') + 1], 'mcp__fetch'); assert.ok(e.includes('--disallowedTools'));
  const x = buildInvocation('codex', { prompt: 'hi', mode: 'readonly', dir: '/w', mcp: servers }).args;
  assert.ok(x.includes('mcp_servers.fetch.command="uvx"')); assert.ok(x.includes('mcp_servers.fetch.args=["mcp-server-fetch"]')); assert.ok(x.includes('mcp_servers.fetch.env={API_TOKEN="secret"}'));
  assert.equal(x.at(-1), 'hi');
  // 没配 MCP 时命令行跟以前完全一样
  assert.equal(buildInvocation('claude', { prompt: 'hi', mode: 'readonly' }).args.includes('--mcp-config'), false);
  // Pi 的 MCP 走配置目录里的 mcp.json，不在命令行里
  assert.equal(buildInvocation('pi', { prompt: 'hi', mode: 'readonly', mcp: servers }).args.some(a => /mcp/i.test(a)), false);
  assert.deepEqual(JSON.parse(piAgentFiles({ mcp: servers })['mcp.json']).mcpServers.fetch.args, ['mcp-server-fetch']);
  assert.deepEqual(claudeMcp([]).args, []); assert.deepEqual(codexMcp([]), []);
});

test('模型支持的引擎：Cindy 目录里的 claude-code / codex 换成 Yumeiro 引擎名，Pi 人人可用', () => {
  assert.deepEqual(modelEngines({ agents: ['claude-code', 'codex'] }), ['claude', 'codex', 'pi']);
  assert.deepEqual(modelEngines({ agents: ['codex'] }), ['codex', 'pi']);
  assert.deepEqual(modelEngines({}), ['pi']);
});

test('网关模型 + 引擎：Codex 临时服务商、Claude 去掉 /v1、Pi 写 models.json，密钥只走环境变量', () => {
  const gw = sanitizeGateway({ baseUrl: 'https://gw.example.com/v1/', model: 'deepseek-v4-pro' });
  assert.equal(gw.baseUrl, 'https://gw.example.com/v1');
  assert.throws(() => sanitizeGateway({ baseUrl: 'file:///etc', model: 'x' }));
  assert.throws(() => sanitizeGateway({ baseUrl: 'https://a.b', model: 'bad model;' }));
  const x = buildInvocation('codex', { prompt: 'hi', mode: 'readonly', dir: '/w', model: gw.model, gateway: gw, env: {} }).args;
  assert.ok(x.includes('model_provider="yumeiro-gw"')); assert.ok(x.includes('model_providers.yumeiro-gw.base_url="https://gw.example.com/v1"'));
  assert.ok(x.includes('model_providers.yumeiro-gw.env_key="YUMEIRO_GW_API_KEY"')); assert.ok(x.includes('model_providers.yumeiro-gw.wire_api="responses"'));
  assert.ok(!x.join(' ').includes('secret'));
  assert.ok(codexGateway(gw, { RUNNER_CODEX_WIRE_API: 'chat' }).includes('model_providers.yumeiro-gw.wire_api="chat"'));
  assert.equal(anthropicBase('https://gw.example.com/v1/'), 'https://gw.example.com');
  const p = buildInvocation('pi', { prompt: 'hi', mode: 'readonly', model: gw.model, gateway: gw }).args;
  assert.equal(p[p.indexOf('--provider') + 1], 'yumeiro-gw');
  const models = JSON.parse(piAgentFiles({ gateway: gw })['models.json']).providers['yumeiro-gw'];
  assert.equal(models.apiKey, '$YUMEIRO_GW_API_KEY'); assert.equal(models.api, 'openai-completions'); assert.deepEqual(models.models, [{ id: 'deepseek-v4-pro' }]);
  assert.deepEqual(piAgentFiles({}), {});
});
