// 市场来源适配器（Market source adapters）
// ------------------------------------------------------------------------------------------
// 技能 / 机器人市场的“外部来源”都通过适配器接入。要接一个新的来源（例如将来腾讯 SkillHub 开放了接口、
// 或者你自己的内部技能库），只需要新增一个适配器，不用改 server.mjs，也不用改网页界面。
//
// 适配器是一个普通对象：
//
//   {
//     kind: 'my-market',                  // 唯一标识（小写字母、数字、连字符）；保存在 source.kind
//     free: true,                         // 是否免费、无需密钥（界面会标注）
//     presets: [{                         // 管理界面“添加来源”下拉里的选项，一个适配器可以有多个
//       id: 'my-market',                  //   选项编号（全局唯一）
//       label: '我的技能库',                //   下拉里显示的文字
//       fields: [                         //   需要管理员填写的参数；界面按它自动生成表单
//         { name: 'url', label: '地址', placeholder: 'https://…', required: true },
//         { name: 'token', label: '访问令牌（可选）', secret: true }   // secret：不回显，只保存
//       ]
//     }],
//     validate(body, { preset, sources, ctx }) -> { fields, name }   // 校验参数；返回要保存进 source 的字段和默认名称；非法时 throw ctx.fail(400, '原因')
//     describe(source) -> string                                      // 来源列表里显示的目标地址
//     async load(source, ctx) -> items[]                              // 抓取目录（缓存 10 分钟）。可以在返回的数组上挂 failed=失败数量
//     async search?(source, query, ctx) -> items[]                    // 可选：实时搜索（市场里选中该来源后输入关键字时调用）
//     async resolve?(source, rest, ctx) -> entry                      // 可选：目录条目带 lazy:true 时，预览 / 安装才调用，返回含完整正文的条目
//   }
//
// 条目（item / entry）格式：
//   { key: 'ext:<来源编号>:<自定义部分>', type: 'skill' | 'bot', source: 'external', title, description, tags: [],
//     content   (skill 的正文，≤20000 字)   |  prompt + skills:[{ key, title, description, content }]  (bot 模板),
//     lazy?: true  (目录里不带正文，resolve 时再读),  url?: '原页面链接',  owner?: '作者' }
//
// ctx 提供：fetchText / fetchBuffer（带 https、内网拦截、跳转白名单、大小与超时限制，务必用它们访问网络，不要直接 fetch）、
//           fail、marketTags、parseSkillMarkdown、readZipEntries、cleanItem（把 JSON 条目清洗成标准格式）。
//
// 额外适配器：把写好的 .mjs 文件（default export 一个适配器，或适配器数组）路径放进环境变量 MARKET_ADAPTER_FILES（逗号分隔）即可加载。
// ------------------------------------------------------------------------------------------
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';

export function createMarketSources({ fail, marketTags, parseSkillMarkdown, readZipEntries, env = process.env }) {
  const TEST = env.MARKET_TEST_ALLOW_PRIVATE === '1'; // 仅供自动化测试：放开 https / 内网检查
  const trim = value => String(value).replace(/\/+$/, '');
  const GITHUB_API = trim(env.MARKET_GITHUB_API || 'https://api.github.com'), GITHUB_RAW = trim(env.MARKET_GITHUB_RAW || 'https://raw.githubusercontent.com');
  const CLAWHUB_BASE = trim(env.MARKET_CLAWHUB_BASE || 'https://clawhub.ai'), CLAWHUB_MIRROR = trim(env.MARKET_CLAWHUB_MIRROR_BASE || 'https://mirror-cn.clawhub.com');
  const GITHUB_TOKEN = (env.MARKET_GITHUB_TOKEN || '').trim(); // 可选：把 GitHub 匿名的 60 次 / 小时提高到 5000 次 / 小时（只读公开仓库的令牌即可）

  // ---------------- 安全的网络访问 ----------------
  const REDIRECT_HOSTS = new Set(['clawhub.ai', 'mirror-cn.clawhub.com', 'cn.clawhub-mirror.com', 'api.github.com', 'raw.githubusercontent.com', 'codeload.github.com']);
  for (const base of [CLAWHUB_BASE, CLAWHUB_MIRROR, GITHUB_API, GITHUB_RAW]) { try { REDIRECT_HOSTS.add(new URL(base).hostname); } catch { /* 忽略 */ } }
  function badAddress(address) {
    const a = String(address).toLowerCase();
    if (isIP(a) === 4) { const p = a.split('.').map(Number); return p[0] === 10 || p[0] === 127 || p[0] === 0 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127); }
    if (isIP(a) === 6) return a === '::1' || a === '::' || a.startsWith('fc') || a.startsWith('fd') || a.startsWith('fe8') || a.startsWith('fe9') || a.startsWith('fea') || a.startsWith('feb') || a.startsWith('::ffff:');
    return true;
  }
  async function assertSafe(target) {
    if (TEST) return;
    if (target.protocol !== 'https:') throw fail(400, '外部市场只支持 https 地址');
    const addresses = isIP(target.hostname) ? [{ address: target.hostname }] : await dnsLookup(target.hostname, { all: true });
    if (!addresses.length || addresses.some(item => badAddress(item.address))) throw fail(400, '不允许访问内网或本机地址');
  }
  // 每次请求：https + 内网拦截（含 DNS 解析结果）；只跟随跳转到白名单域名，最多 3 跳，每一跳重新检查；
  // 自定义请求头（例如令牌）只发给最初的主机，跳到别的域名时自动去掉。
  async function fetchBuffer(url, maxBytes, { headers = {} } = {}) {
    let target = new URL(url), response; const origin = target.hostname;
    for (let hop = 0; ; hop++) {
      await assertSafe(target);
      const sendHeaders = { Accept: 'application/json, text/plain, */*', 'User-Agent': 'yumeiro-private-workspace', ...(target.hostname === origin ? headers : {}) };
      response = await fetch(target, { redirect: 'manual', headers: sendHeaders, signal: AbortSignal.timeout(15000) });
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        if (hop >= 3) throw fail(502, '跳转次数过多');
        let next; try { next = new URL(response.headers.get('location'), target); } catch { throw fail(502, '跳转地址无效'); }
        if (!REDIRECT_HOSTS.has(next.hostname)) throw fail(502, '来源跳转到了不受信任的域名：' + next.hostname);
        target = next; continue;
      }
      break;
    }
    if (response.status === 429) throw fail(502, '对方限流（429），请 ' + (response.headers.get('retry-after') || '稍后') + ' 秒后再试');
    if (!response.ok) throw fail(502, 'HTTP ' + response.status);
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > maxBytes) throw fail(502, '内容超过大小限制'); chunks.push(chunk); }
    return Buffer.concat(chunks);
  }
  const fetchText = async (url, maxBytes, options) => (await fetchBuffer(url, maxBytes, options)).toString('utf8');

  // 把 JSON 条目清洗成标准格式（索引类来源、你自己的适配器都可以用）
  function cleanItem(item, sourceId, index) {
    const type = item?.type === 'bot' ? 'bot' : item?.type === 'skill' ? 'skill' : null, title = String(item?.title || '').trim().slice(0, 60);
    if (!type || !title) return null;
    const key = 'ext:' + sourceId + ':' + (String(item.key || '').replace(/[^A-Za-z0-9._/-]/g, '').slice(0, 80) || ('i' + index));
    const base = { key, type, source: 'external', title, description: String(item.description || '').trim().slice(0, 200), tags: marketTags(item.tags) };
    if (type === 'skill') { const content = String(item.content || '').trim(); return content && content.length <= 20000 ? { ...base, content } : null; }
    const prompt = String(item.prompt || '').trim().slice(0, 8000); if (!prompt) return null;
    const skills = (Array.isArray(item.skills) ? item.skills : []).slice(0, 8).map((skill, i) => ({ key: key + '#' + i, title: String(skill?.title || '').trim().slice(0, 60), description: String(skill?.description || '').trim().slice(0, 300), content: String(skill?.content || '').trim() })).filter(skill => skill.title && skill.content && skill.content.length <= 20000);
    return { ...base, prompt, skills };
  }
  const ctx = { fetchText, fetchBuffer, fail, marketTags, parseSkillMarkdown, readZipEntries, cleanItem };
  const bearer = token => (token ? { Authorization: 'Bearer ' + token } : {});

  // ---------------- 适配器 1：GitHub 仓库（免费，无需密钥）----------------
  const github = {
    kind: 'github', free: true,
    presets: [{ id: 'github', label: 'GitHub 仓库（里面放 SKILL.md）', fields: [
      { name: 'repo', label: '所有者/仓库名', placeholder: 'anthropics/skills', required: true },
      { name: 'branch', label: '分支（可选，默认 main/master）' }, { name: 'path', label: '子目录（可选）' }] }],
    validate(body) {
      const repo = String(body.repo || body.target || '').trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
      if (!/^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(repo)) throw fail(400, 'GitHub 仓库格式应为 所有者/仓库名，例如 octocat/hello-world');
      const branch = String(body.branch || '').trim(), path = String(body.path || '').trim();
      if (branch && !/^[A-Za-z0-9._/-]{1,80}$/.test(branch)) throw fail(400, '分支名无效');
      if (path && (!/^[A-Za-z0-9._/-]{1,100}$/.test(path) || path.includes('..'))) throw fail(400, '子目录无效');
      return { fields: { repo, branch, path }, name: repo };
    },
    describe: source => source.repo + (source.branch ? '@' + source.branch : '') + (source.path ? ' /' + source.path : ''),
    async load(source) {
      const headers = GITHUB_TOKEN ? { Authorization: 'Bearer ' + GITHUB_TOKEN } : {};
      const branches = source.branch ? [source.branch] : ['main', 'master']; let tree = null, used = '';
      for (const branch of branches) { try { tree = JSON.parse(await fetchText(GITHUB_API + '/repos/' + source.repo + '/git/trees/' + encodeURIComponent(branch) + '?recursive=1', 4 * 1024 * 1024, { headers })); used = branch; break; } catch (error) { if (branch === branches.at(-1)) throw error; } }
      const prefix = source.path ? source.path.replace(/^\/+|\/+$/g, '') + '/' : '';
      const files = (tree.tree || []).filter(entry => entry.type === 'blob' && /(^|\/)skill\.md$/i.test(entry.path) && entry.path.startsWith(prefix) && !/(^|\/)(node_modules|\.git)\//.test(entry.path)).slice(0, 250);
      const items = []; let next = 0, failed = 0;
      const fetchRaw = async entry => { const target = GITHUB_RAW + '/' + source.repo + '/' + encodeURIComponent(used) + '/' + entry.path.split('/').map(encodeURIComponent).join('/'); try { return await fetchText(target, 128 * 1024, { headers }); } catch { return fetchText(target, 128 * 1024, { headers }); } };
      const worker = async () => { while (next < files.length) { const entry = files[next++]; try {
        const parsed = parseSkillMarkdown(await fetchRaw(entry)), dir = entry.path.split('/').slice(-2, -1)[0] || source.repo.split('/')[1];
        const item = cleanItem({ type: 'skill', key: entry.path, title: parsed.title || dir, description: parsed.description, content: parsed.content, tags: [source.repo.split('/')[1]] }, source.id, items.length);
        if (item) items.push(item);
      } catch { failed++; } } };
      await Promise.all([worker(), worker(), worker(), worker()]);
      const sorted = items.sort((a, b) => a.title.localeCompare(b.title, 'zh')); sorted.failed = failed; return sorted;
    }
  };

  // ---------------- 适配器 2：JSON 索引（通用接口：任何服务只要按格式发布 JSON 就能接入；可选令牌）----------------
  const index = {
    kind: 'index', free: true,
    presets: [{ id: 'index', label: 'JSON 索引地址（https，通用接口）', fields: [
      { name: 'url', label: '索引地址', placeholder: 'https://example.com/skills/index.json', required: true },
      { name: 'token', label: '访问令牌（可选，作为 Bearer 发送，不回显）', secret: true }] }],
    validate(body) {
      let url; try { url = new URL(String(body.url || body.target || '').trim()); } catch { throw fail(400, '索引地址格式不正确'); }
      if (!TEST && url.protocol !== 'https:') throw fail(400, '索引地址必须是 https');
      const token = String(body.token || '').trim().slice(0, 300);
      return { fields: { url: url.toString(), ...(token ? { token } : {}) }, name: url.hostname };
    },
    describe: source => source.url,
    async load(source) {
      const data = JSON.parse(await fetchText(source.url, 1024 * 1024, { headers: bearer(source.token) })), list = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
      return list.slice(0, 200).map((item, i) => cleanItem(item, source.id, i)).filter(Boolean);
    }
  };

  // ---------------- 适配器 3：ClawHub（原站 + OpenClaw / 火山引擎共建的中国镜像，免费，无需密钥）----------------
  // 原站接口文档允许第三方目录复用只读接口，要求缓存、遵守 429 / Retry-After、链接回原页面。
  // 镜像站的搜索 / 详情 / 下载接口与原站兼容，但没有列表和文件接口、条目没有作者前缀：目录由几个中文关键字的搜索结果合成，内容从下载的 zip 里读取 SKILL.md。
  const clawSafe = value => /^[A-Za-z0-9._-]{1,80}$/.test(String(value || ''));
  const clawBase = source => (source.variant === 'mirror' ? CLAWHUB_MIRROR : CLAWHUB_BASE);
  const MIRROR_SEEDS = ['代码', '写作', '办公', '数据分析', '搜索', '翻译', '自动化', '文档'];
  function clawItem(source, owner, slug, fields) {
    if (!clawSafe(owner) || !clawSafe(slug)) return null;
    const mirror = source.variant === 'mirror';
    return { key: 'ext:' + source.id + ':' + owner + '/' + slug, type: 'skill', source: 'external', lazy: true, title: String(fields.title || slug).slice(0, 60), description: String(fields.description || '').slice(0, 200), tags: marketTags([...(fields.topics || []).slice(0, 3), mirror ? '中文镜像' : 'ClawHub']), owner: mirror ? '' : owner, url: mirror ? '' : CLAWHUB_BASE + '/' + owner + '/skills/' + slug, downloads: Number(fields.downloads) || 0 };
  }
  const mirrorFields = raw => { const meta = raw.metaContent || {}; return { title: raw.displayName, description: meta.DisplayDescription || raw.summary, topics: Array.isArray(meta.Keywords) ? meta.Keywords.filter(word => !/_/.test(String(word))) : [], downloads: raw.downloads || raw.stats?.downloads }; };
  const clawhub = {
    kind: 'clawhub', free: true,
    presets: [{ id: 'clawhub', label: 'ClawHub（clawhub.ai 公开技能目录）', variant: 'official', fields: [] }, { id: 'clawhub-mirror', label: 'ClawHub 中国镜像（mirror-cn.clawhub.com，中文）', variant: 'mirror', fields: [] }],
    validate(body, { preset, sources }) {
      const variant = preset.variant === 'mirror' ? 'mirror' : 'official';
      if (sources.some(item => item.kind === 'clawhub' && (item.variant || 'official') === variant)) throw fail(409, variant === 'mirror' ? 'ClawHub 中国镜像已经添加过了' : 'ClawHub 已经添加过了');
      return { fields: { variant }, name: variant === 'mirror' ? 'ClawHub 中国镜像' : 'ClawHub' };
    },
    describe: source => clawBase(source),
    async load(source) {
      if (source.variant === 'mirror') {
        const seen = new Map();
        await Promise.all(MIRROR_SEEDS.map(async query => { try { for (const item of await clawhub.search(source, query, ctx, 15)) if (!seen.has(item.key)) seen.set(item.key, item); } catch { /* 单个关键字失败不影响其它 */ } }));
        if (!seen.size) throw fail(502, '镜像站没有返回任何技能');
        return [...seen.values()];
      }
      const items = [], data = JSON.parse(await fetchText(CLAWHUB_BASE + '/api/v1/skills?limit=100&sort=downloads&nonSuspiciousOnly=true', 2 * 1024 * 1024));
      for (const raw of data.items || []) { const item = clawItem(source, raw.ownerHandle, raw.slug, { title: raw.displayName, description: raw.summary, topics: raw.topics, downloads: raw.stats?.downloads }); if (item) items.push(item); }
      return items;
    },
    async search(source, query, _ctx, limit = 40) {
      const data = JSON.parse(await fetchText(clawBase(source) + '/api/v1/search?nonSuspiciousOnly=true&limit=' + limit + '&q=' + encodeURIComponent(query), 2 * 1024 * 1024)), items = [];
      for (const raw of data.results || []) {
        let item;
        if (source.variant === 'mirror') item = clawItem(source, '-', raw.slug, mirrorFields(raw));
        else { const [owner, slug] = String(raw.install?.reference || '').split('/'), skill = raw.native?.skill || {}; item = clawItem(source, raw.ownerHandle || owner, slug || skill.slug, { title: raw.displayName || skill.displayName, description: skill.summary || raw.summary, topics: skill.topics, downloads: raw.downloads }); }
        if (item) items.push(item);
      }
      return items;
    },
    // 预览 / 安装时才读取内容：原站先看审核状态（可疑或恶意的不装）再读 SKILL.md；镜像站从下载的 zip 里读。最终不超过 20000 字。
    async resolve(source, rest) {
      const match = String(rest).match(/^([A-Za-z0-9._-]{1,80})\/([A-Za-z0-9._-]{1,80})$/), mirror = source.variant === 'mirror';
      if (!match || mirror !== (match[1] === '-')) throw fail(404, '市场里没有这个条目（可能已被下架）');
      const [, owner, slug] = match, base = clawBase(source);
      let detail = null;
      try { detail = JSON.parse(await fetchText(base + '/api/v1/skills/' + encodeURIComponent(slug) + (mirror ? '' : '?ownerHandle=' + encodeURIComponent(owner)), 1024 * 1024)); } catch { /* 详情失败时仍以内容读取为准 */ }
      if (detail?.moderation?.isMalwareBlocked || detail?.moderation?.isSuspicious) throw fail(403, 'ClawHub 把这个技能标记为可疑或有风险，已拒绝安装');
      let text;
      if (mirror) {
        const archive = await fetchBuffer(base + '/api/v1/download?slug=' + encodeURIComponent(slug), 512 * 1024);
        text = readZipEntries(archive, name => /(^|\/)skill\.md$/i.test(name) && name.split('/').length <= 2).entries[0]?.text || '';
      } else text = await fetchText(base + '/api/v1/skills/' + encodeURIComponent(slug) + '/file?path=SKILL.md&preview=1&ownerHandle=' + encodeURIComponent(owner), 128 * 1024);
      const parsed = parseSkillMarkdown(text);
      if (!parsed.content) throw fail(400, '这个技能没有可用的内容');
      if (String(parsed.content).length > 20000) throw fail(400, '这个技能的内容超过 20000 字，无法安装');
      return { key: 'ext:' + source.id + ':' + rest, type: 'skill', source: 'external', title: (detail?.skill?.displayName || parsed.title || slug).slice(0, 60), description: parsed.description || detail?.skill?.summary || '', tags: [mirror ? '中文镜像' : 'ClawHub'], content: parsed.content, url: mirror ? '' : CLAWHUB_BASE + '/' + owner + '/skills/' + slug };
    }
  };

  // ---------------- 注册表 ----------------
  const adapters = new Map();
  const presets = new Map();
  function register(adapter) {
    if (!adapter || !/^[a-z0-9-]{1,32}$/.test(String(adapter.kind || ''))) throw new Error('适配器 kind 必须是小写字母、数字和连字符');
    for (const method of ['validate', 'describe', 'load']) if (typeof adapter[method] !== 'function') throw new Error('适配器 ' + adapter.kind + ' 缺少方法 ' + method);
    if (!Array.isArray(adapter.presets) || !adapter.presets.length) throw new Error('适配器 ' + adapter.kind + ' 至少要有一个 preset');
    if (adapters.has(adapter.kind)) throw new Error('适配器已存在：' + adapter.kind);
    for (const preset of adapter.presets) { if (!/^[a-z0-9-]{1,40}$/.test(String(preset.id || '')) || presets.has(preset.id)) throw new Error('适配器 ' + adapter.kind + ' 的 preset 编号无效或重复：' + preset.id); }
    adapters.set(adapter.kind, adapter);
    for (const preset of adapter.presets) presets.set(preset.id, { ...preset, kind: adapter.kind, free: adapter.free !== false, searchable: typeof adapter.search === 'function', fields: preset.fields || [] });
  }
  for (const adapter of [github, index, clawhub]) register(adapter);

  async function loadExtra(files = env.MARKET_ADAPTER_FILES || '') {
    const loaded = [];
    for (const file of String(files).split(',').map(item => item.trim()).filter(Boolean)) {
      const module = await import(pathToFileURL(file).href);
      for (const adapter of [].concat(module.default || module.adapters || [])) { register(adapter); loaded.push(adapter.kind); }
    }
    return loaded;
  }

  // 兼容旧的 { kind, variant } 写法 → preset
  function presetFor(body) {
    if (body.option && presets.has(String(body.option))) return presets.get(String(body.option));
    const kind = String(body.kind || 'github');
    if (kind === 'clawhub') return presets.get(body.variant === 'mirror' ? 'clawhub-mirror' : 'clawhub');
    return [...presets.values()].find(preset => preset.kind === kind) || null;
  }
  const optionOf = source => source.option || (source.kind === 'clawhub' ? (source.variant === 'mirror' ? 'clawhub-mirror' : 'clawhub') : source.kind);
  const parseKey = key => { const match = String(key).match(/^ext:([0-9a-f-]+):(.+)$/i); return match ? { sourceId: match[1], rest: match[2] } : null; };

  // 推荐来源：2026-10-29 核对过能抓取。许可信息来自各站页面，仅供参考，使用前请自行确认。全部免费、无需密钥。
  const suggested = [
    { option: 'clawhub-mirror', kind: 'clawhub', variant: 'mirror', name: 'ClawHub 中国镜像', license: '镜像 ClawHub 公开内容；各技能以其自带许可为准', note: 'OpenClaw 与火山引擎共建的国内镜像（mirror-cn.clawhub.com），中文描述为主、国内访问快；市场里输入关键字实时搜索。镜像站不提供审核标记，请先预览' },
    { option: 'clawhub', kind: 'clawhub', name: 'ClawHub', license: '公开目录，技能多为 MIT-0；各技能以其页面为准', note: 'OpenClaw 的技能注册中心，社区技能数量很大；支持在市场里实时搜索，安装时才读取内容并检查审核状态' },
    { option: 'github', kind: 'github', repo: 'anthropics/skills', name: 'Anthropic 官方技能', license: '各技能不同（部分为 Apache-2.0，文档类技能为受限许可）', note: 'Agent Skills 官方示例，约 20 个' },
    { option: 'github', kind: 'github', repo: 'anthropics/claude-plugins-official', name: 'Anthropic 官方插件市场', license: 'Apache-2.0', note: 'Claude Code 官方插件目录里的技能，约 33 个' },
    { option: 'github', kind: 'github', repo: 'openai/skills', name: 'OpenAI 官方技能（Codex）', license: '仓库未声明统一许可，以各技能为准', note: 'Codex 技能目录，约 44 个' },
    { option: 'github', kind: 'github', repo: 'vercel-labs/agent-skills', name: 'Vercel 技能', license: '仓库未声明统一许可，以各技能为准', note: '前端与部署相关，约 9 个' },
    { option: 'github', kind: 'github', repo: 'huggingface/skills', name: 'Hugging Face 技能', license: 'Apache-2.0', note: '模型 / 数据集 / CLI 相关，约 26 个' },
    { option: 'github', kind: 'github', repo: 'microsoft/skills', name: 'Microsoft 技能', license: 'MIT', note: 'Azure 等，213 个，列表较大（最多收录前 250 个）' },
    { option: 'github', kind: 'github', repo: 'addyosmani/agent-skills', name: '工程实践技能集', license: 'MIT', note: '面向 AI 编程助手的工程规范，约 25 个' },
    { option: 'github', kind: 'github', repo: 'coreyhaines31/marketingskills', name: '营销技能集', license: 'MIT', note: '增长、文案、SEO 等营销技能，约 50 个' }
  ].map(item => ({ free: true, ...item }));

  return { ctx, adapters, presets, register, loadExtra, presetFor, optionOf, parseKey, suggested, adapterFor: kind => adapters.get(kind) || null, fetchText, fetchBuffer, cleanItem };
}
