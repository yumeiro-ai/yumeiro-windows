// MCP 市场：内置精选目录 + 官方 MCP 注册表（registry.modelcontextprotocol.io）搜索。
// 只负责“有哪些服务、怎么启动”，真正保存 / 校验仍然走 mcp.mjs 的 cleanMcpServers（和手动添加完全一样的规则）。
// 目前只支持“本地启动”的服务：npm 包用 npx，Python 包用 uvx。Docker、远程（HTTP）、mcpb 等条目会标成“暂不支持”并说明原因。

export const REGISTRY_BASE = 'https://registry.modelcontextprotocol.io';

// 内置精选目录：都是 MCP 官方 / 社区里最常用的服务；params 里的 {{名字}} 会在添加时替换成管理员填的值
export const BUILTIN = [
  { id: 'filesystem', title: '文件系统', description: '读写指定目录里的文件（列目录、读取、写入、搜索）。适合让智能体处理你放进去的资料。', runtime: 'npx', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '{{dir}}'], params: [{ name: 'dir', label: '允许访问的目录', placeholder: '/workspaces', default: '/workspaces', required: true }], env: [], tags: ['文件', '官方'], homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem' },
  { id: 'fetch', title: '网页抓取（fetch）', description: '抓取网页并转成适合阅读的文字，让智能体能看网页内容。', runtime: 'uvx', command: 'uvx', args: ['mcp-server-fetch'], params: [], env: [], tags: ['网页', '官方'], homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch' },
  { id: 'git', title: 'Git 仓库', description: '查看提交历史、差异、分支，读取指定 Git 仓库的内容。', runtime: 'uvx', command: 'uvx', args: ['mcp-server-git', '--repository', '{{repo}}'], params: [{ name: 'repo', label: '仓库目录', placeholder: '/workspaces/项目名', required: true }], env: [], tags: ['代码', '官方'], homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git' },
  { id: 'memory', title: '知识图谱记忆', description: '用知识图谱保存和回忆事实，让智能体跨对话记住信息。', runtime: 'npx', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], params: [], env: [], tags: ['记忆', '官方'], homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory' },
  { id: 'sequential-thinking', title: '分步思考', description: '把复杂问题拆成步骤、反复修正想法，帮助模型做更长的推理。', runtime: 'npx', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'], params: [], env: [], tags: ['推理', '官方'], homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking' },
  { id: 'time', title: '时间与时区', description: '获取当前时间、在不同时区之间换算。', runtime: 'uvx', command: 'uvx', args: ['mcp-server-time'], params: [], env: [], tags: ['工具', '官方'], homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/time' },
  { id: 'context7', title: 'Context7 文档查询', description: '查询各种编程库 / 框架的最新官方文档和示例，减少模型凭记忆乱写。', runtime: 'npx', command: 'npx', args: ['-y', '@upstash/context7-mcp'], params: [], env: [], tags: ['代码', '文档'], homepage: 'https://github.com/upstash/context7' },
  { id: 'playwright', title: '浏览器自动化（Playwright）', description: '打开网页、点击、填表、截图。', runtime: 'npx', command: 'npx', args: ['-y', '@playwright/mcp@latest', '--headless'], params: [], env: [], tags: ['网页', '自动化'], homepage: 'https://github.com/microsoft/playwright-mcp', note: '需要运行器里装有浏览器；默认的运行器镜像没带，首次使用可能要联网下载浏览器，且需要较多内存。' },
  { id: 'github', title: 'GitHub', description: '读取和管理 GitHub 仓库、议题、拉取请求。', runtime: 'npx', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], params: [], env: [{ name: 'GITHUB_PERSONAL_ACCESS_TOKEN', label: 'GitHub 个人访问令牌', description: '在 GitHub → Settings → Developer settings 里创建，权限按需最小化', required: true, secret: true }], tags: ['代码', '官方'], homepage: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/github', note: '这个包官方已归档不再更新，仍可使用；需要更完整功能可以去 GitHub 官方的 MCP 服务。' },
  { id: 'brave-search', title: 'Brave 搜索', description: '用 Brave 搜索引擎查网页和本地信息。', runtime: 'npx', command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'], params: [], env: [{ name: 'BRAVE_API_KEY', label: 'Brave Search API 密钥', description: '在 brave.com/search/api 申请（有免费额度）', required: true, secret: true }], tags: ['搜索', '官方'], homepage: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/brave-search', note: '这个包官方已归档不再更新，仍可使用。' }
].map(item => ({ ...item, source: 'builtin', supported: true, reason: '', name: item.id }));

const PLACEHOLDER = /[{][{]([a-z][a-z0-9_]*)[}][}]/g;

// 管理员填的值替换进参数；缺必填项时抛错（消息直接给用户看）
export function buildServer(item, values = {}) {
  const missing = [];
  const val = (kind, def) => { const raw = String(values[kind + ':' + def.name] ?? values[def.name] ?? '').trim(); return raw || (def.default ? String(def.default) : ''); };
  const params = new Map((item.params || []).map(def => [def.name, val('param', def)]));
  for (const def of item.params || []) if (def.required && !params.get(def.name)) missing.push(def.label || def.name);
  const env = {};
  for (const def of item.env || []) { const value = val('env', def); if (def.required && !value) missing.push(def.label || def.name); if (value) env[def.name] = value; }
  if (missing.length) throw Object.assign(new Error('请填写：' + missing.join('、')), { status: 400 });
  const args = (item.args || []).map(arg => String(arg).replace(PLACEHOLDER, (all, key) => params.get(key) ?? '')).filter(arg => arg !== '');
  return { command: item.command, args, env };
}

export function slugName(text) {
  const clean = value => value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  const parts = String(text || '').split('/');
  let name = clean(parts.pop());
  if (['mcp', 'server', 'mcp-server', 'mcp-servers'].includes(name) && parts.length) name = clean(parts.join('-') + '-' + name);   // 只写 mcp 太笼统，把发布者带上
  if (!/^[a-z]/.test(name)) name = 'mcp-' + name;
  return name.slice(0, 32).replace(/-+$/g, '') || 'mcp';
}

// ---- 官方注册表 ----
// 把注册表里的一条记录整理成统一格式；不支持的返回 supported:false 和原因
export function fromRegistryEntry(entry) {
  const server = entry?.server;
  if (!server || typeof server.name !== 'string') return null;
  const base = { id: 'registry:' + server.name, source: 'registry', title: server.title || server.name, name: slugName(server.name), description: String(server.description || '').slice(0, 400), homepage: server.repository?.url || server.websiteUrl || '', version: server.version || '', tags: ['官方注册表'], params: [], env: [], args: [], command: '', runtime: '', supported: false, reason: '' };
  const packages = Array.isArray(server.packages) ? server.packages : [];
  const stdio = packages.filter(pkg => (pkg.transport?.type || 'stdio') === 'stdio');
  const pkg = stdio.find(item => item.registryType === 'npm') || stdio.find(item => item.registryType === 'pypi');
  if (!pkg) {
    const types = [...new Set(packages.map(item => item.registryType))];
    base.reason = !packages.length ? '这是远程（HTTP）服务，暂不支持' : types.includes('oci') ? '需要 Docker 运行，暂不支持' : '安装方式（' + (types.join('、') || '未知') + '）暂不支持';
    return base;
  }
  const version = pkg.version && pkg.version !== 'latest' ? pkg.version : '';
  if (pkg.registryType === 'npm') { base.runtime = 'npx'; base.command = 'npx'; base.args = ['-y', version ? pkg.identifier + '@' + version : pkg.identifier]; }
  else { base.runtime = 'uvx'; base.command = 'uvx'; base.args = [version ? pkg.identifier + '==' + version : pkg.identifier]; }
  // 包参数：有固定值 / 默认值的直接带上；必填又没有值的变成要管理员填的参数
  for (const [index, arg] of (pkg.packageArguments || []).entries()) {
    const value = arg.value ?? arg.default ?? '';
    const key = 'a' + index, flag = arg.type === 'named' ? String(arg.name || '') : '';
    if (value !== '' && value !== undefined) { if (flag) base.args.push(flag, String(value)); else base.args.push(String(value)); }
    else if (arg.isRequired) { base.params.push({ name: key, label: String(arg.description || arg.name || '参数').slice(0, 60), placeholder: String(arg.valueHint || ''), required: true }); if (flag) base.args.push(flag, '{{' + key + '}}'); else base.args.push('{{' + key + '}}'); }
  }
  base.env = (pkg.environmentVariables || []).filter(item => item && /^[A-Z_][A-Z0-9_]{0,60}$/.test(String(item.name))).slice(0, 20).map(item => ({ name: item.name, label: item.name, description: String(item.description || '').slice(0, 200), required: Boolean(item.isRequired), secret: Boolean(item.isSecret), ...(item.default ? { default: String(item.default) } : {}) }));
  base.supported = true;
  if (pkg.registryType === 'pypi') base.tags.push('Python');
  return base;
}

// 搜索注册表：取最新版本；只翻有限几页；去重；支持的排前面
export async function searchRegistry(query, { fetchImpl = fetch, base = REGISTRY_BASE, limit = 60, pages = 2 } = {}) {
  const items = new Map(); let cursor = '';
  for (let page = 0; page < pages && items.size < limit; page++) {
    const url = new URL('/v0/servers', base); url.searchParams.set('version', 'latest'); url.searchParams.set('limit', '50');
    if (query) url.searchParams.set('search', query); if (cursor) url.searchParams.set('cursor', cursor);
    const response = await fetchImpl(url, { headers: { Accept: 'application/json', 'User-Agent': 'yumeiro-mcp-market' }, signal: AbortSignal.timeout(15000), redirect: 'error' });
    if (!response.ok) throw new Error('官方注册表返回 HTTP ' + response.status);
    const data = await response.json();
    for (const entry of Array.isArray(data.servers) ? data.servers : []) { const item = fromRegistryEntry(entry); if (item && !items.has(item.id)) items.set(item.id, item); }
    cursor = data.metadata?.nextCursor || ''; if (!cursor) break;
  }
  return [...items.values()].sort((a, b) => Number(b.supported) - Number(a.supported)).slice(0, limit);
}

export const matches = (item, query) => { const q = String(query || '').trim().toLowerCase(); return !q || [item.title, item.description, item.name, ...(item.tags || [])].join(' ').toLowerCase().includes(q); };
// 给页面用的版本：不带 args 里的内部占位以外的东西，足够展示即可
export const publicItem = (item, runnerTools = null) => ({ id: item.id, source: item.source, title: item.title, name: item.name, description: item.description, homepage: item.homepage || '', version: item.version || '', tags: item.tags || [], note: item.note || '', runtime: item.runtime, command: item.command, preview: [item.command, ...(item.args || [])].join(' '), params: item.params || [], env: item.env || [], supported: item.supported, reason: item.supported && runnerTools && runnerTools[item.runtime] === false ? '运行器里没有 ' + item.runtime + '，装不了（见下方说明）' : item.reason, runnerMissing: Boolean(item.supported && runnerTools && runnerTools[item.runtime] === false) });
