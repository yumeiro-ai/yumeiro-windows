// MCP 服务配置的校验（服务器端）。运行器里有一份同样严格的校验（runner/mcp.mjs），两边都不信任对方。
export const MCP_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
export const MCP_ENGINES = ['claude', 'codex', 'pi'];     // Pi 通过 <agent-dir>/mcp.json 支持 MCP
const COMMAND = /^[A-Za-z0-9._\/@+:~-]{1,200}$/;     // 只是一个可执行文件名或路径，不含空格和 shell 符号
const ENV_KEY = /^[A-Z_][A-Z0-9_]{0,60}$/;
export const MCP_MASK = '••••••';

const fail = message => Object.assign(new Error(message), { status: 400 });

// 把管理员提交的列表整理成存库格式；env 值为空或等于 MCP_MASK 时沿用旧值（previous 是已保存的列表）。
export function cleanMcpServers(input, previous = []) {
  if (!Array.isArray(input)) throw fail('MCP 服务列表格式不对');
  if (input.length > 10) throw fail('最多配置 10 个 MCP 服务');
  const seen = new Set(), out = [];
  for (const item of input) {
    const name = String(item?.name || '').trim().toLowerCase();
    if (!MCP_NAME.test(name)) throw fail('MCP 服务名只能用小写字母开头，由小写字母、数字、- 和 _ 组成（最长 32 位）：' + (name || '（空）'));
    if (seen.has(name)) throw fail('MCP 服务名重复：' + name);
    seen.add(name);
    const command = String(item?.command || '').trim();
    if (!COMMAND.test(command)) throw fail(`MCP「${name}」的命令只能是一个程序名（例如 npx、uvx、node），不能带空格或特殊符号；参数请写在“参数”里`);
    const args = (Array.isArray(item?.args) ? item.args : []).map(value => String(value)).filter(value => value !== '');
    if (args.length > 30 || args.some(value => value.length > 1000 || value.includes('\0'))) throw fail(`MCP「${name}」的参数过多或过长`);
    const old = previous.find(value => value.name === name)?.env || {}, env = {};
    const pairs = item?.env && typeof item.env === 'object' && !Array.isArray(item.env) ? Object.entries(item.env) : [];
    if (pairs.length > 20) throw fail(`MCP「${name}」的环境变量最多 20 个`);
    for (const [key, raw] of pairs) {
      if (!ENV_KEY.test(key)) throw fail(`MCP「${name}」的环境变量名不合法：${key}`);
      const value = raw === undefined || raw === null || raw === '' || raw === MCP_MASK ? old[key] : String(raw);
      if (value === undefined) continue;
      if (value.length > 4000 || value.includes('\0')) throw fail(`MCP「${name}」的环境变量 ${key} 太长`);
      env[key] = value;
    }
    const engines = (Array.isArray(item?.engines) ? item.engines : MCP_ENGINES).filter(engine => MCP_ENGINES.includes(engine));
    out.push({ name, command, args, env, engines: [...new Set(engines)], enabled: item?.enabled !== false });
  }
  return out;
}

// 给管理员页面看的版本：环境变量的值打码。
export const maskMcpServers = list => (list || []).map(server => ({ ...server, env: Object.fromEntries(Object.keys(server.env || {}).map(key => [key, MCP_MASK])) }));

// 发给运行器的版本：只含对这个引擎启用的服务。
export const mcpForEngine = (list, engine) => (list || []).filter(server => server.enabled !== false && (server.engines || MCP_ENGINES).includes(engine)).map(({ name, command, args, env }) => ({ name, command, args: args || [], env: env || {} }));
