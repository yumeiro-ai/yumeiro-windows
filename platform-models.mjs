// Cindy 官方托管模型（model-access）：用已绑定的 Cindy 账号令牌换取网关凭据、读取模型目录、探测网关路径。
// 流程取自官方开源客户端与协议仓库（makecindy/cindy、makecindy/cindy-protocol 的 model-access-protocol）：
//   GET  {modelAccessApiBaseUrl}/api/model-access/credentials   Bearer <访问令牌>  →  { endpoint, apiKey }
//   GET  {modelAccessApiBaseUrl}/api/model-access/models        Bearer <访问令牌>  →  { schemaVersion, models:[{id,mode,agents,modalities,…}] }
// 推理请求发往 endpoint，用 apiKey 鉴权。令牌区域（cn/global）必须和 model-access 区域一致，不能混用。

export function modelAccessBase(region, env = process.env) {
  const value = region === 'cn' ? env.CINDY_MODEL_ACCESS_URL_CN || 'https://model-access.cindy.com.cn' : env.CINDY_MODEL_ACCESS_URL_GLOBAL || 'https://model-access.cindy.app';
  return value.replace(/\/+$/, '');
}

export class CindyModelError extends Error {
  constructor(message, { status = 502, code = '', step = '' } = {}) { super(message); this.status = status; this.code = code; this.step = step; }
}

async function getJson(url, headers, step, fetchImpl) {
  let response;
  try { response = await fetchImpl(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(20000), redirect: 'error' }); }
  catch (error) { throw new CindyModelError('无法连接 ' + new URL(url).host + '：' + (error.cause?.code || error.message), { step }); }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const info = data && typeof data.error === 'object' && data.error ? data.error : data || {};
    throw new CindyModelError(`${step} 失败：HTTP ${response.status}${info.code ? ' ' + info.code : ''}${info.message ? '（' + String(info.message).slice(0, 120) + '）' : ''}`, { status: response.status, code: String(info.code || ''), step });
  }
  return data;
}

// 非聊天的模型（图像/视频/语音等）不进入对话模型列表
const NON_CHAT_MODES = /^(image|video|audio|embedding|rerank|tts|stt|moderation)/i;
export function parseCatalog(json) {
  const list = Array.isArray(json?.models) ? json.models : [];
  const seen = new Set(), models = [];
  for (const item of list) {
    const id = typeof item?.id === 'string' ? item.id.trim() : '';
    if (!id || seen.has(id) || id.length > 200) continue;
    if (item.mode && NON_CHAT_MODES.test(String(item.mode))) continue;
    if (item.modalities?.output && !item.modalities.output.includes('text')) continue;
    seen.add(id);
    models.push({ id, name: typeof item.name === 'string' ? item.name : id, agents: Array.isArray(item.agents) ? item.agents : [], currency: item.currency || null });
  }
  return models;
}

export async function fetchGatewayCredentials(accessToken, region, { env = process.env, fetchImpl = fetch } = {}) {
  const data = await getJson(modelAccessBase(region, env) + '/api/model-access/credentials', { Authorization: 'Bearer ' + accessToken }, '获取网关凭据', fetchImpl);
  if (!data || typeof data.apiKey !== 'string' || !data.apiKey.trim() || typeof data.endpoint !== 'string') throw new CindyModelError('获取网关凭据：返回内容不完整', { step: '获取网关凭据' });
  let url; try { url = new URL(data.endpoint); } catch { throw new CindyModelError('获取网关凭据：endpoint 不是有效地址', { step: '获取网关凭据' }); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new CindyModelError('获取网关凭据：endpoint 协议不支持', { step: '获取网关凭据' });
  return { endpoint: data.endpoint.replace(/\/+$/, ''), apiKey: data.apiKey.trim() };
}

export async function fetchModelCatalog(accessToken, region, { env = process.env, fetchImpl = fetch } = {}) {
  const data = await getJson(modelAccessBase(region, env) + '/api/model-access/models', { Authorization: 'Bearer ' + accessToken }, '读取模型目录', fetchImpl);
  return parseCatalog(data);
}

// 找到网关里真正提供 OpenAI Chat Completions 的前缀：先试 {endpoint}，再试 {endpoint}/v1。用无费用的 GET /models 探测，不消耗额度。
export async function detectChatBase(endpoint, apiKey, fetchImpl = fetch) {
  const tried = [];
  const candidates = [endpoint, endpoint.endsWith('/v1') ? null : endpoint + '/v1'].filter(Boolean);
  for (const base of candidates) {
    try {
      const response = await fetchImpl(base + '/models', { headers: { Authorization: 'Bearer ' + apiKey, Accept: 'application/json' }, signal: AbortSignal.timeout(15000), redirect: 'error' });
      const data = await response.json().catch(() => null);
      tried.push(`${base}/models → HTTP ${response.status}`);
      if (response.ok && (Array.isArray(data?.data) || Array.isArray(data?.models))) return { base, tried };
      if (response.status === 401 || response.status === 403) return { base: null, tried, rejected: true };
    } catch (error) { tried.push(`${base}/models → ${error.cause?.code || error.message}`); }
  }
  return { base: candidates[0], tried, guessed: true };
}

// 发一次 1 token 的对话，确认密钥、模型名和路径都对（会消耗极少量额度）。
export async function pingChat(base, apiKey, model, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(base + '/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }), signal: AbortSignal.timeout(30000), redirect: 'error' });
    const data = await response.json().catch(() => null);
    if (response.ok) return { ok: true, detail: '对话接口可用' };
    const info = data && typeof data.error === 'object' && data.error ? data.error : data || {};
    return { ok: false, status: response.status, detail: `HTTP ${response.status}${info.message ? '：' + String(info.message).slice(0, 160) : ''}` };
  } catch (error) { return { ok: false, detail: '无法连接：' + (error.cause?.code || error.message) }; }
}

export const accessTokenExpiry = token => { try { const p = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')); return Number.isFinite(p.exp) ? p.exp * 1000 : null; } catch { return null; } };

// Cindy 目录里 agents 写的是 claude-code / codex；Yumeiro 的引擎名是 claude / codex / pi。
// Pi 通过 OpenAI 兼容接口接入任何网关模型，所以所有 Cindy 模型都可以用 Pi。
const AGENT_TO_ENGINE = { 'claude-code': 'claude', claude: 'claude', codex: 'codex', pi: 'pi' };
export function modelEngines(model) {
  const set = new Set((Array.isArray(model?.agents) ? model.agents : []).map(name => AGENT_TO_ENGINE[name]).filter(Boolean));
  set.add('pi');
  return ['claude', 'codex', 'pi'].filter(engine => set.has(engine));
}
