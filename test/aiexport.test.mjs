import test from 'node:test';
import assert from 'node:assert/strict';
import { aiKit, contextBundle, runsMarkdown, detectStack } from '../aiexport.mjs';

test('AI 工具说明文件齐全', () => {
  const kit = aiKit('演示', [{ path: 'index.html', size: 10 }, { path: 'package.json', size: 5 }], { hasRuns: true });
  const names = kit.map(k => k.name);
  for (const n of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.cursor/rules/project.mdc', '.github/copilot-instructions.md', 'PROJECT-CONTEXT.md']) assert.ok(names.includes(n), n);
  assert.match(kit[0].data.toString(), /npm install/);
  assert.match(kit.find(k => k.name === 'PROJECT-CONTEXT.md').data.toString(), /CONVERSATION-LOG/);
});
test('单文件上下文含文件树和内容，二进制只列出', () => {
  const t = contextBundle('演示', [{ path: 'a.js', data: Buffer.from('console.log(1)') }, { path: 'x.png', data: Buffer.from([1, 2, 0]) }, { path: 'n.md', data: Buffer.from('```js\nx\n```') }]);
  assert.match(t, /### `a\.js`\n```js\nconsole\.log\(1\)\n```/);
  assert.match(t, /x\.png（二进制/);
  assert.match(t, /````markdown/);
});
test('对话记录与技术栈识别', () => {
  assert.equal(runsMarkdown([]), '');
  const md = runsMarkdown([{ task: '做首页', mode: 'pipeline', status: 'done', createdAt: 0, steps: [{ label: '规划', text: '先画' }], final: 'ok' }], [], { pipeline: '接力' }, { done: '已完成' });
  assert.match(md, /做首页/); assert.match(md, /接力/); assert.match(md, /### 规划/);
  assert.deepEqual(detectStack(['go.mod']).stack, ['Go']);
});
test('关键记忆从对话记录提炼，并写进各工具说明', async () => {
  const { memoryMarkdown } = await import('../aiexport.mjs');
  const runs = [{ task: '做首页', status: 'done', createdAt: 1e12, final: '首页完成，用了蓝色主题' }, { task: '接支付', status: 'failed', createdAt: 1e12 + 9e7, error: '密钥无效' }];
  const m = memoryMarkdown('演示', runs, { files: [{ path: 'a' }] });
  assert.match(m, /首页完成/); assert.match(m, /没做完 \/ 出错/); assert.match(m, /密钥无效/);
  const kit = aiKit('演示', [{ path: 'a', size: 1 }], { memory: m });
  assert.ok(kit.some(k => k.name === 'PROJECT-MEMORY.md'));
  assert.match(kit[0].data.toString(), /PROJECT-MEMORY\.md/);
  assert.match(contextBundle('演示', [{ path: 'a.js', data: Buffer.from('x') }], { memory: m }), /关键记忆：演示/);
});
test('关联的普通聊天进入对话记录和关键记忆', async () => {
  const { memoryMarkdown } = await import('../aiexport.mjs');
  const chats = [{ title: '配色讨论', updatedAt: 1e12, model: 'm1', messages: [{ role: 'user', content: '主色用什么' }, { role: 'assistant', content: '建议蓝色' }] }];
  const log = runsMarkdown([], chats);
  assert.match(log, /关联到这个工作区的聊天/); assert.match(log, /AI\*\*：建议蓝色/);
  const m = memoryMarkdown('演示', [], { chats });
  assert.match(m, /配色讨论/); assert.match(m, /问：主色用什么/); assert.doesNotMatch(m, /还没有对话记录/);
});
