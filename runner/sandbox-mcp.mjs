// 给智能体用的“沙箱”MCP 服务（stdio，换行分隔的 JSON-RPC）。
// 只提供一个工具 sandbox_run：把代码或命令发到断网的沙箱容器里执行。
// 环境变量：SANDBOX_URL（沙箱地址）、SANDBOX_WORKSPACE（工作区）、SANDBOX_TOKEN（只能在该工作区调 /exec 的短期令牌）。
import readline from 'node:readline';

const url = (process.env.SANDBOX_URL || '').replace(/\/+$/, ''), workspace = process.env.SANDBOX_WORKSPACE || '', token = process.env.SANDBOX_TOKEN || '';
const TOOL = {
  name: 'sandbox_run',
  description: '在隔离沙箱里运行代码或 shell 命令，返回退出码、标准输出和错误输出。沙箱没有外网，工作目录就是当前工作区，工作区里的文件可以读写。可用语言：python / node / bash。单次最长 120 秒。',
  inputSchema: {
    type: 'object',
    properties: {
      language: { type: 'string', enum: ['python', 'node', 'bash'], description: '代码语言；用 command 时可省略' },
      code: { type: 'string', description: '要运行的完整代码' },
      command: { type: 'string', description: '直接运行的 shell 命令（与 code 二选一），如 "ls -la" 或 "python3 app.py"' },
      timeout_sec: { type: 'number', description: '超时秒数，默认 30，最大 120' }
    }
  }
};
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const text = (value, isError = false) => ({ content: [{ type: 'text', text: value }], isError });

async function runTool(args) {
  if (!url || !workspace || !token) return text('沙箱没有配置好（缺少 SANDBOX_URL / 工作区 / 令牌）', true);
  let response;
  try {
    response = await fetch(url + '/exec', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(150000),
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace, language: args.language, code: args.code, command: args.command, timeoutSec: args.timeout_sec })
    });
  } catch (error) { return text('无法连接沙箱：' + error.message, true); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return text('沙箱拒绝了请求：' + (data.error || 'HTTP ' + response.status), true);
  const lines = [`退出码：${data.exitCode ?? '无'}${data.timedOut ? '（超时被终止）' : ''}${data.signal ? '（信号 ' + data.signal + '）' : ''} · 用时 ${data.durationMs} ms`];
  if (data.stdout) lines.push('--- stdout ---\n' + data.stdout);
  if (data.stderr) lines.push('--- stderr ---\n' + data.stderr);
  return text(lines.join('\n'), data.exitCode !== 0);
}

async function handle(message) {
  const { id, method, params } = message;
  if (method === 'initialize') return send({ id, result: { protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'sandbox', version: '1.0.0' } } });
  if (method === 'ping') return send({ id, result: {} });
  if (method === 'tools/list') return send({ id, result: { tools: [TOOL] } });
  if (method === 'tools/call') {
    if (params?.name !== TOOL.name) return send({ id, error: { code: -32602, message: '未知工具' } });
    return send({ id, result: await runTool(params.arguments || {}) });
  }
  if (id !== undefined) send({ id, error: { code: -32601, message: '不支持的方法：' + method } }); // 通知（没有 id）直接忽略
}

readline.createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return;
  let message; try { message = JSON.parse(line); } catch { return; }
  handle(message).catch(error => { if (message.id !== undefined) send({ id: message.id, error: { code: -32603, message: error.message } }); });
});
