// 模拟 claude / codex / pi 命令行：按第一个参数 "--engine=xxx" 决定输出格式。把收到的参数、工作目录和环境变量回显出来，便于测试。
import { writeFileSync } from 'node:fs';
const engine = process.argv[2].replace('--engine=', '');
const args = process.argv.slice(3);
const echo = JSON.stringify({ args, cwd: process.cwd(), key: process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || null, nodeOptions: process.env.NODE_OPTIONS || null, home: process.env.HOME || null });
const prompt = args.includes('-p') ? args[args.indexOf('-p') + 1] : args.at(-1);
if (args.includes('--version')) { console.log(engine + ' mock 1.0'); process.exit(0); }
if (/SLEEP/.test(prompt)) { await new Promise(() => setInterval(() => {}, 1000)); }
if (/FAIL/.test(prompt)) { console.error('boom from ' + engine); process.exit(3); }
const match = prompt.match(/WRITE:(\S+)/);
if (match) writeFileSync(match[1], 'written by ' + engine);

// 模拟真实引擎的权限：只读模式拒绝写文件，可写模式才会写（对应 runner/verify.mjs 里的提示词）
const writable = args.includes('--leak') || (engine === 'claude' ? args.includes('acceptEdits') : engine === 'codex' ? args.includes('workspace-write') : /write/.test(args[args.indexOf('--tools') + 1] || ''));
const create = prompt.match(/创建一个文件 (\S+)，内容(?:恰好)?是 ([^\s（。]+)/);
if (create && writable) writeFileSync(create[1], create[2]);
const sayOnly = prompt.match(/口令本身，不要加任何其他文字：(\S+)/);
const reply = sayOnly ? sayOnly[1] : echo;

if (engine === 'claude') {
  const out = value => console.log(JSON.stringify(value));
  out({ type: 'system', subtype: 'init' });
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '你好，' } } });
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '我是 claude' } } });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: '你好，我是 claude' }, { type: 'tool_use', name: 'Read', input: { file_path: 'a.txt' } }] } });
  out({ type: 'result', result: reply, is_error: false, usage: { input_tokens: 11, output_tokens: 7 } });
} else if (engine === 'codex') {
  const out = value => console.log(JSON.stringify(value));
  out({ type: 'thread.started' });
  out({ type: 'item.completed', item: { type: 'command_execution', command: 'ls' } });
  out({ type: 'item.completed', item: { type: 'agent_message', text: reply } });
  out({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 2 } });
} else {
  console.log(reply);
}
