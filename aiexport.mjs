// 给其他 AI 工具（Claude Code / Codex / Cursor / Copilot / Gemini CLI，以及网页版 ChatGPT / Claude）读的项目导出：
//   aiKit()         —— 放在项目根目录的说明文件：AGENTS.md（通用）、CLAUDE.md、GEMINI.md、.cursor/rules、.github/copilot-instructions.md，加 PROJECT-CONTEXT.md（文件树）
//   contextBundle() —— 单个 Markdown 文本：文件树 + 每个文本文件的内容，可整份粘贴进对话框；超限文件、二进制文件只列出不附内容
//   runsMarkdown()  —— 工作区里的对话记录（任务、每一步产出、最终结果）
const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'json', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'less', 'html', 'htm', 'xml', 'svg', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env', 'sh', 'bat', 'ps1', 'py', 'rb', 'php', 'java', 'kt', 'kts', 'go', 'rs', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'swift', 'm', 'sql', 'lua', 'vue', 'svelte', 'csv', 'tsv', 'gradle', 'properties', 'lock', 'gitignore', 'dockerfile', 'makefile', 'cmake', 'proto', 'graphql', 'r', 'dart', 'scala', 'tex']);
const LANG = { js: 'js', mjs: 'js', cjs: 'js', ts: 'ts', tsx: 'tsx', jsx: 'jsx', py: 'python', rb: 'ruby', php: 'php', java: 'java', kt: 'kotlin', go: 'go', rs: 'rust', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', swift: 'swift', sh: 'sh', bat: 'bat', ps1: 'powershell', json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'toml', html: 'html', css: 'css', scss: 'scss', xml: 'xml', svg: 'xml', md: 'markdown', sql: 'sql', lua: 'lua', vue: 'vue', dart: 'dart' };
const extension = rel => { const m = /\.([A-Za-z0-9]+)$/.exec(String(rel)); return m ? m[1].toLowerCase() : String(rel).split('/').pop().toLowerCase(); };
export const isTextFile = rel => TEXT_EXT.has(extension(rel));
const size = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n > 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B';

export function detectStack(paths) {
  const has = re => paths.some(p => re.test(p));
  const stack = [], run = [];
  if (has(/(^|\/)package\.json$/)) { stack.push('Node.js / JavaScript（package.json）'); run.push('安装依赖：`npm install`；运行脚本见 package.json 的 scripts'); }
  if (has(/(^|\/)(requirements\.txt|pyproject\.toml|setup\.py)$/)) { stack.push('Python'); run.push('安装依赖：`pip install -r requirements.txt`（或按 pyproject.toml）'); }
  if (has(/(^|\/)CMakeLists\.txt$/)) { stack.push('C / C++（CMake）'); run.push('构建：`cmake -S . -B build && cmake --build build`'); }
  if (has(/(^|\/)(pom\.xml|build\.gradle|build\.gradle\.kts)$/)) { stack.push('Java / Kotlin（Maven 或 Gradle）'); run.push('构建：`mvn package` 或 `./gradlew build`'); }
  if (has(/(^|\/)go\.mod$/)) { stack.push('Go'); run.push('构建：`go build ./...`'); }
  if (has(/(^|\/)Cargo\.toml$/)) { stack.push('Rust（Cargo）'); run.push('构建：`cargo build`'); }
  if (has(/\.csproj$|\.sln$/)) { stack.push('.NET / C#'); run.push('构建：`dotnet build`'); }
  if (has(/(^|\/)index\.html$/) && !stack.length) { stack.push('静态网页（HTML / CSS / JS）'); run.push('直接用浏览器打开 index.html，或 `npx serve .`'); }
  const entries = paths.filter(p => /(^|\/)(index\.html|main\.(js|ts|py|go|rs|c|cpp)|app\.(js|ts|py)|server\.(js|mjs|ts)|README(\.md)?)$/i.test(p)).slice(0, 8);
  return { stack, run, entries };
}
const tree = files => files.map(f => '- `' + f.path + '`（' + size(f.size) + '）').join('\n');
const header = (name, files, extra = '') => {
  const d = detectStack(files.map(f => f.path));
  return ['# ' + name, '', '这个项目从 Yumeiro 工作区导出，共 ' + files.length + ' 个文件。' + extra, '',
    '## 技术栈与入口', d.stack.length ? d.stack.map(x => '- ' + x).join('\n') : '- 没有识别出明确的构建配置（按文件内容判断）', d.entries.length ? '\n入口 / 说明文件：' + d.entries.map(x => '`' + x + '`').join('、') : '', '',
    d.run.length ? '## 常用命令\n' + d.run.map(x => '- ' + x).join('\n') + '\n' : ''].join('\n');
};
const RULES = [
  '## 给 AI 助手的工作约定',
  '- 先读 `PROJECT-MEMORY.md`（关键记忆：之前做过什么、定过什么、还剩什么），再读 `PROJECT-CONTEXT.md` 了解文件结构，然后动手；改动前后说明做了什么。',
  '- 做完一件事，把新的结论、决定和待办追加到 `PROJECT-MEMORY.md`，方便下次在别的工具里接着做。',
  '- 只改和任务相关的文件，保持现有的代码风格和命名；不要顺手重构无关代码。',
  '- 不确定的需求先问清楚；不要编造不存在的文件、接口或依赖。',
  '- 如果有 `CONVERSATION-LOG.md`，里面是之前和各个模型的对话记录，可以参考其中的决定。',
  '- 不要提交或输出任何密钥、令牌和个人信息。'
].join('\n');

// files: [{ path, size }]；返回根目录的说明文件 [{ name, data }]
export function aiKit(name, files, { hasRuns = false, memory = '', library = null } = {}) {
  const base = header(name, files) + '\n' + RULES + '\n';
  const put = (n, t) => ({ name: n, data: Buffer.from(t, 'utf8') });
  return [
    put('AGENTS.md', base),
    put('CLAUDE.md', ['# ' + name, '', '@AGENTS.md', ''].join('\n')),
    put('GEMINI.md', ['# ' + name, '', '请先阅读 AGENTS.md 和 PROJECT-CONTEXT.md，按里面的约定工作。', '', base].join('\n')),
    put('.cursor/rules/project.mdc', ['---', 'description: 项目说明与工作约定', 'alwaysApply: true', '---', '', base].join('\n')),
    put('.github/copilot-instructions.md', base),
    ...(memory ? [put('PROJECT-MEMORY.md', memory)] : []),
    ...libraryFiles(library),
    put('PROJECT-CONTEXT.md', ['# 项目上下文：' + name, '', '## 文件树', tree(files), '', hasRuns ? '## 对话记录\n见 `CONVERSATION-LOG.md`。\n' : ''].join('\n'))
  ];
}

// entries: [{ path, data: Buffer }]
export function contextBundle(name, entries, { maxBytes = 1500000, perFile = 120000, runs = '', memory = '' } = {}) {
  const files = entries.map(e => ({ path: e.path, size: e.data.length }));
  const out = [header(name, files, '下面是文件树和每个文本文件的完整内容。'), RULES, '', memory, '', '## 文件树', tree(files), '', '## 文件内容', ''];
  let used = 0; const skipped = [];
  for (const e of entries) {
    const text = isTextFile(e.path) ? e.data.toString('utf8') : null;
    if (text === null || text.includes('\u0000')) { skipped.push(e.path + '（二进制或不支持的类型）'); continue; }
    if (e.data.length > perFile) { skipped.push(e.path + '（' + size(e.data.length) + '，超过单文件上限）'); continue; }
    if (used + e.data.length > maxBytes) { skipped.push(e.path + '（总量超过上限，未附内容）'); continue; }
    used += e.data.length;
    const fence = text.includes('```') ? '````' : '```';
    out.push('### `' + e.path + '`', fence + (LANG[extension(e.path)] || ''), text.replace(/\s+$/, ''), fence, '');
  }
  if (skipped.length) out.push('## 没有附内容的文件', ...skipped.map(x => '- ' + x), '');
  if (runs) out.push(runs);
  return out.join('\n');
}

export function runsMarkdown(runs, chats = [], modeNames = {}, statusNames = {}) {
  if (!runs.length && !chats.length) return '';
  const out = ['# 对话记录', '', '工作区里每次对话的任务、每一步的产出和最终结果（从新到旧）。', ''];
  for (const run of runs.slice(0, 100)) {
    out.push('## ' + String(run.task || '').replace(/\s+/g, ' ').slice(0, 100), '', '- 方式：' + (modeNames[run.mode] || run.mode) + '　状态：' + (statusNames[run.status] || run.status) + '　时间：' + new Date(run.createdAt).toISOString().replace('T', ' ').slice(0, 16));
    for (const s of run.steps || []) out.push('', '### ' + (s.label || s.agent || '步骤') + (s.round ? '（第 ' + s.round + ' 轮）' : ''), '', String(s.text || s.output || '').slice(0, 6000));
    if (run.final) out.push('', '### 最终结果', '', String(run.final).slice(0, 8000));
    if (run.error) out.push('', '> 出错：' + run.error);
    out.push('');
  }
  if (chats.length) {
    out.push('# 关联到这个工作区的聊天', '');
    for (const chat of chats) {
      out.push('## ' + String(chat.title || '新对话').slice(0, 100), '', '- 时间：' + new Date(chat.updatedAt || chat.createdAt).toISOString().replace('T', ' ').slice(0, 16) + (chat.model ? '　模型：' + chat.model : ''), '');
      for (const m of chat.messages || []) out.push('**' + (m.role === 'assistant' ? 'AI' : '我') + '**：' + String(m.content || '').slice(0, 6000), '');
    }
  }
  return out.join('\n');
}

// 关键记忆：不调用模型，直接从工作区的对话记录里提炼——每次对话的任务和结论（取最终结果的开头）、没做完/失败的事。
// 其他工具（Claude Code、Cursor、ChatGPT 网页版……）先读这一份，就能接上之前的进度。
export function memoryMarkdown(name, runs, { files = [], chats = [] } = {}) {
  const clip = (t, n) => { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
  const day = at => new Date(at).toISOString().slice(0, 10);
  const talks = [...chats].sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
  const sorted = [...runs].sort((a, b) => a.createdAt - b.createdAt);
  const out = ['# 关键记忆：' + name, '', '> 从这个工作区的 ' + sorted.length + ' 次任务和 ' + talks.length + ' 段聊天里自动整理，换到别的软件、别的模型时先读这份。里面的内容来自之前的对话，如有出入以文件当前内容为准。', ''];
  const open = sorted.filter(r => r.status && r.status !== 'done' && r.status !== 'completed');
  if (!sorted.length && !talks.length) out.push('这个工作区还没有对话记录。', '');
  if (talks.length) {
    out.push('## 关联的聊天（共 ' + talks.length + ' 段，最近 30 段）', '');
    for (const c of talks.slice(-30)) {
      const ms = c.messages || [], lastUser = [...ms].reverse().find(m => m.role === 'user'), lastAi = [...ms].reverse().find(m => m.role === 'assistant' && !m.error);
      out.push('- ' + day(c.updatedAt || c.createdAt) + '　' + clip(c.title, 60) + (lastUser ? '　问：' + clip(lastUser.content, 100) : '') + (lastAi ? '　答：' + clip(lastAi.content, 200) : ''));
    }
    out.push('');
  }
  if (sorted.length) {
    const last = sorted[sorted.length - 1];
    out.push('## 最近在做', '', '- ' + day(last.createdAt) + '：' + clip(last.task, 160), last.final ? '  - 结论：' + clip(last.final, 400) : '', '');
    if (open.length) out.push('## 没做完 / 出错的事', '', ...open.slice(-10).map(r => '- ' + day(r.createdAt) + '：' + clip(r.task, 120) + (r.error ? '（出错：' + clip(r.error, 100) + '）' : '（状态：' + r.status + '）')), '');
    out.push('## 做过的事和结论（从早到晚）', '');
    for (const r of sorted.slice(-40)) out.push('- ' + day(r.createdAt) + '　' + clip(r.task, 100) + (r.final ? ' ——' + clip(r.final, 240) : ''));
    out.push('');
  }
  out.push('## 项目现状', '', '- 共 ' + files.length + ' 个文件，结构见 `PROJECT-CONTEXT.md`；完整对话见 `CONVERSATION-LOG.md`。', '', '## 你（AI）接着做时请补充', '', '<!-- 在这里追加新的决定、约定和待办 -->', '');
  return out.join(String.fromCharCode(10));
}

// 工作区引入的技能 / 智能体 / 机器人：技能写成 Claude Code 能识别的 .claude/skills/<名>/SKILL.md（Cursor、Codex 也可当普通说明读），
// 智能体和机器人写成 .claude/agents/<名>.md，并在 AGENTS-LIBRARY.md 里统一列出。
const slug = (t, i) => (String(t || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'item') + '-' + (i + 1);
export function libraryFiles(lib) {
  if (!lib || !(lib.skills?.length || lib.agents?.length || lib.bots?.length)) return [];
  const put = (n, t) => ({ name: n, data: Buffer.from(t, 'utf8') }), out = [], index = ['# 这个工作区引入的技能、智能体和机器人', ''];
  const oneLine = t => String(t || '').replace(/\s+/g, ' ').trim();
  if (lib.skills?.length) index.push('## 技能', '');
  (lib.skills || []).forEach((x, i) => { const dir = '.claude/skills/' + slug(x.title, i); out.push(put(dir + '/SKILL.md', ['---', 'name: ' + oneLine(x.title), 'description: ' + oneLine(x.description || x.title), '---', '', x.content || ''].join(String.fromCharCode(10)))); index.push('- **' + x.title + '**' + (x.description ? '：' + oneLine(x.description) : '') + '（' + dir + '/SKILL.md）'); });
  if (lib.agents?.length) index.push('', '## 智能体', '');
  (lib.agents || []).forEach((x, i) => { const f = '.claude/agents/' + slug(x.name, i) + '.md'; out.push(put(f, ['---', 'name: ' + slug(x.name, i), 'description: ' + oneLine(x.description || x.name), '---', '', x.prompt || ''].join(String.fromCharCode(10)))); index.push('- **' + x.name + '**' + (x.description ? '：' + oneLine(x.description) : '') + '（' + f + '）'); });
  if (lib.bots?.length) index.push('', '## 机器人', '');
  (lib.bots || []).forEach((x, i) => { const f = '.claude/agents/bot-' + slug(x.name, i) + '.md'; out.push(put(f, ['---', 'name: bot-' + slug(x.name, i), 'description: ' + oneLine('机器人 ' + x.name), '---', '', x.prompt || '（这个机器人没有绑定提示词）'].join(String.fromCharCode(10)))); index.push('- **' + x.name + '**' + (x.agent ? '（基于智能体 ' + x.agent + '）' : '') + '（' + f + '）'); });
  out.push(put('AGENTS-LIBRARY.md', index.join(String.fromCharCode(10)) + String.fromCharCode(10)));
  return out;
}
