// AI 服务商接入：模板、地址校验、模型引用解析。所有服务商都按 OpenAI Chat Completions 协议调用。
import { isIP } from 'node:net';

// 预设地址便于一键填入；服务商可能调整，请以其官方文档为准（地址可在表单里修改）。
export const templates = [
  { id: 'openai', name: 'OpenAI（ChatGPT API）', baseUrl: 'https://api.openai.com/v1', keyHint: 'sk-…' },
  { id: 'anthropic', name: 'Anthropic（Claude，OpenAI 兼容端点）', baseUrl: 'https://api.anthropic.com/v1/', keyHint: 'sk-ant-…', note: '使用 Anthropic 提供的 OpenAI SDK 兼容端点，部分高级功能不可用。' },
  { id: 'gemini', name: 'Google Gemini（OpenAI 兼容端点）', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', keyHint: 'AIza…' },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', keyHint: 'sk-…' },
  { id: 'moonshot', name: 'Moonshot（Kimi）', baseUrl: 'https://api.moonshot.cn/v1', keyHint: 'sk-…', note: '国际站使用 https://api.moonshot.ai/v1' },
  { id: 'qwen', name: '阿里云百炼（通义千问）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', keyHint: 'sk-…' },
  { id: 'zhipu', name: '智谱 AI（GLM）', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', keyHint: '' },
  { id: 'volcengine', name: '火山引擎方舟（豆包）', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', keyHint: '', note: '模型名通常填你创建的推理接入点 ID（ep-…）。' },
  { id: 'qianfan', name: '百度千帆', baseUrl: 'https://qianfan.baidubce.com/v2', keyHint: '' },
  { id: 'hunyuan', name: '腾讯混元', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1', keyHint: 'sk-…' },
  { id: 'siliconflow', name: '硅基流动 SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', keyHint: 'sk-…' },
  { id: 'openrouter', name: 'OpenRouter（聚合）', baseUrl: 'https://openrouter.ai/api/v1', keyHint: 'sk-or-…' },
  { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', keyHint: 'gsk_…' },
  { id: 'mistral', name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', keyHint: '' },
  { id: 'xai', name: 'xAI（Grok）', baseUrl: 'https://api.x.ai/v1', keyHint: 'xai-…' },
  { id: 'ollama', name: 'Ollama（本机/内网）', baseUrl: 'http://host.docker.internal:11434/v1', keyHint: '可留空', keyOptional: true, note: '容器访问宿主机用 host.docker.internal；内网地址允许 http。' },
  { id: 'custom', name: '自定义（任何 OpenAI 兼容服务，含 vLLM / LM Studio / 华为云 ModelArts 等）', baseUrl: '', keyHint: '', keyOptional: true }
];

function ipv4(host) {
  const parts = host.split('.').map(Number);
  return parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : null;
}
// 允许用 http 的主机：本机、内网、容器内部名。链路本地（169.254.x.x，云元数据地址）永远拒绝。
export function isPrivateHost(host) {
  host = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || host === 'host.docker.internal') return true;
  const v4 = ipv4(host);
  if (v4) {
    if (v4[0] === 169 && v4[1] === 254) return false;
    return v4[0] === 10 || v4[0] === 127 || (v4[0] === 172 && v4[1] >= 16 && v4[1] <= 31) || (v4[0] === 192 && v4[1] === 168);
  }
  if (isIP(host)) return false;
  return !host.includes('.') || host.endsWith('.internal') || host.endsWith('.local') || host.endsWith('.lan');
}

export function normalizeBaseUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new Error('接口地址格式不正确'); }
  if (url.username || url.password) throw new Error('接口地址不能包含账号密码');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isPrivateHost(url.hostname))) {
    throw new Error('接口地址必须使用 https://（仅本机/内网地址允许 http://）');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const v4 = ipv4(host);
  if (v4 && v4[0] === 169 && v4[1] === 254) throw new Error('不允许使用链路本地地址');
  url.hash = ''; url.search = '';
  return url.toString().replace(/\/+$/, '');
}
// 由显示名生成的可读 API 编号（别名）：“Cindy · GPT-5 · codex” → cindy-gpt-5-codex。
// 别名只在 /v1/models 里替换那串哈希，方便本地客户端按名称识别；原编号永远仍然可用。冲突或无法生成时跳过。
export function modelAliases(models, labels) {
  const byAlias = new Map(), byModel = new Map(), used = new Set(models);
  for (const model of models) {
    const label = labels?.[model]; if (!label) continue;
    const base = String(label).toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    if (!base) continue;
    let alias = base;
    for (let i = 2; used.has(alias); i++) alias = base + '-' + i;
    used.add(alias); byAlias.set(alias, model); byModel.set(model, alias);
  }
  return { byAlias, byModel };
}
// 模型显示名：{ 模型编号: 名称 }，只保留当前模型列表里存在的编号，最多 200 个
export function cleanLabels(input, models) {
  const out = {}; if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const id of models) { const value = input[id]; if (typeof value === 'string' && value.trim()) out[id] = value.trim().slice(0, 120); }
  return out;
}
export const chatEndpoint = baseUrl => baseUrl.endsWith('/chat/completions') ? baseUrl : baseUrl + '/chat/completions';
export const modelsEndpoint = baseUrl => baseUrl.replace(/\/chat\/completions$/, '') + '/models';

export function slugify(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}
export const validSlug = slug => /^[a-z0-9][a-z0-9-]{0,31}$/.test(slug) && slug !== 'default' && slug !== 'agent' && !slug.startsWith('cindy-');

export function maskKey(key) {
  if (!key) return '';
  return key.length <= 8 ? '••••' : key.slice(0, 3) + '••••' + key.slice(-4);
}

export function cleanModels(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(/[\n,]/);
  return [...new Set(list.map(item => String(item).trim()).filter(Boolean))].filter(item => item.length <= 200).slice(0, 200);
}

// 拉取服务商的模型列表（OpenAI 兼容 GET /models），或在给定 model 时发一次 1 token 的对话做连通性测试。
export async function probeProvider({ baseUrl, apiKey, model }, fetchImpl = fetch) {
  const headers = { Accept: 'application/json', ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}) };
  const signal = AbortSignal.timeout(15000);
  try {
    if (model) {
      const response = await fetchImpl(chatEndpoint(baseUrl), { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }), signal, redirect: 'error' });
      return response.ok ? { ok: true, detail: '对话接口可用' } : { ok: false, detail: 'HTTP ' + response.status + '（请检查密钥、模型名与地址）' };
    }
    const response = await fetchImpl(modelsEndpoint(baseUrl), { headers, signal, redirect: 'error' });
    if (!response.ok) return { ok: false, detail: 'HTTP ' + response.status + '（请检查密钥与地址；部分服务不提供模型列表，可手工填写模型名后再测试）' };
    const data = await response.json().catch(() => ({}));
    const items = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
    const models = items.map(item => item?.id || item?.name).filter(Boolean).map(String).sort();
    // 有些服务（例如 Cindy 桌面端桥接）的模型编号是一长串哈希，名称在 name / label 字段里，一并返回供界面显示
    const labels = {};
    for (const item of items) { const id = item?.id ? String(item.id) : ''; const label = String(item?.label || item?.name || '').trim(); if (id && label && label !== id) labels[id] = label.slice(0, 120); }
    // 少数服务（如 OpenRouter）会在模型列表里直接给价格：pricing.prompt / completion 是“每 Token 的美元价”。读到就换算成每百万 Token。
    const prices = {};
    for (const item of items) {
      const id = item?.id ? String(item.id) : '', p = item?.pricing; if (!id || !p) continue;
      const input = Number(p.prompt), output = Number(p.completion);
      if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0 || (!input && !output)) continue;
      prices[id] = { input: Number((input * 1e6).toFixed(6)), output: Number((output * 1e6).toFixed(6)), currency: '$' };
    }
    return { ok: true, detail: `连接成功，发现 ${models.length} 个模型`, models: models.slice(0, 500), labels, prices };
  } catch (error) {
    return { ok: false, detail: error.name === 'TimeoutError' ? '连接超时' : '无法连接：' + (error.cause?.code || error.message) };
  }
}
