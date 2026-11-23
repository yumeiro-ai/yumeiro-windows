// 语音识别（ASR）：把浏览器录下的一小段音频转成文字。
//
// 结构（为以后换服务 / 加服务预留）：
//   1. 引擎注册表 ENGINES —— 每种“接口协议”一个条目：{ label, hint, run(ctx) → 文字 }。新增一种协议（讯飞、腾讯云、火山、自建 WebSocket 网关…）
//      只需要在文件末尾 registerAsrEngine('名字', {...})，管理页的“接口类型”下拉框和配置校验会自动认得它，不用改别处。
//   2. 预设 PRESETS —— 管理页“预设”下拉框里的常见服务（地址、模型名、接口类型、申请密钥的链接）。加一行就多一个预设。
//   3. 语言 / 方言表 LANGS —— 成员在麦克风旁选择的语言；code 是发给服务的语言代码，hint 写进提示词。
//   4. 额外参数 extraParams —— 管理员可以填一个 JSON 对象，原样并入请求（比如某家服务的专属开关），不用改代码。
//   5. 服务来源 —— 复用“AI 接入”里的服务商（provider = 服务商 id / 'builtin'），或在语音识别页单独填地址和密钥（provider = 'custom'）。
import { chatEndpoint, normalizeBaseUrl, maskKey } from './providers.mjs';

// 语言 / 方言选项。code = 发给服务的语言代码（没有就不发，让模型自己判断）；hint = 方言提示，写进提示词 / 上下文。
// 方言能不能识别取决于所选模型：这里只是把“说话人讲的是什么”告诉模型，并不保证每个模型都认得。
export const LANGS = [
  { id: 'auto', label: '自动识别', group: '通用' },
  { id: 'zh', label: '普通话', group: '通用', code: 'zh' },
  { id: 'en', label: '英语', group: '通用', code: 'en' },
  { id: 'yue', label: '粤语', group: '方言', code: 'yue', hint: '粤语' },
  { id: 'sichuan', label: '四川话', group: '方言', hint: '四川话' },
  { id: 'minnan', label: '闽南语', group: '方言', hint: '闽南语' },
  { id: 'wu', label: '吴语（上海话 / 苏州话）', group: '方言', hint: '吴语（上海话、苏州话等）' },
  { id: 'hakka', label: '客家话', group: '方言', hint: '客家话' },
  { id: 'northeast', label: '东北话', group: '方言', hint: '东北话' },
  { id: 'henan', label: '河南话', group: '方言', hint: '河南话' },
  { id: 'shaanxi', label: '陕西话', group: '方言', hint: '陕西话' },
  { id: 'shanxi', label: '山西话', group: '方言', hint: '山西话' },
  { id: 'shandong', label: '山东话', group: '方言', hint: '山东话' },
  { id: 'tianjin', label: '天津话', group: '方言', hint: '天津话' },
  { id: 'hubei', label: '湖北话', group: '方言', hint: '湖北话' },
  { id: 'hunan', label: '湖南话', group: '方言', hint: '湖南话' },
  { id: 'jiangxi', label: '江西话', group: '方言', hint: '江西话' },
  { id: 'yunnan', label: '云南话', group: '方言', hint: '云南话' },
  { id: 'guizhou', label: '贵州话', group: '方言', hint: '贵州话' },
  { id: 'chaoshan', label: '潮汕话', group: '方言', hint: '潮汕话' },
  { id: 'guangxi', label: '广西白话 / 桂柳话', group: '方言', hint: '广西白话' },
  { id: 'gan', label: '赣语（南昌话）', group: '方言', hint: '赣语' },
  { id: 'xiang', label: '湘语（长沙话）', group: '方言', hint: '湘语' },
  { id: 'jin', label: '晋语（太原话）', group: '方言', hint: '晋语' },
  { id: 'wenzhou', label: '温州话', group: '方言', hint: '温州话' },
  { id: 'hokkien', label: '台湾话（台语）', group: '方言', hint: '台湾话' },
  { id: 'ja', label: '日语', group: '其他语言', code: 'ja' },
  { id: 'ko', label: '韩语', group: '其他语言', code: 'ko' },
  { id: 'fr', label: '法语', group: '其他语言', code: 'fr' },
  { id: 'de', label: '德语', group: '其他语言', code: 'de' },
  { id: 'es', label: '西班牙语', group: '其他语言', code: 'es' },
  { id: 'pt', label: '葡萄牙语', group: '其他语言', code: 'pt' },
  { id: 'ru', label: '俄语', group: '其他语言', code: 'ru' },
  { id: 'it', label: '意大利语', group: '其他语言', code: 'it' },
  { id: 'ar', label: '阿拉伯语', group: '其他语言', code: 'ar' },
  { id: 'th', label: '泰语', group: '其他语言', code: 'th' },
  { id: 'vi', label: '越南语', group: '其他语言', code: 'vi' },
  { id: 'id', label: '印度尼西亚语', group: '其他语言', code: 'id' },
  { id: 'ms', label: '马来语', group: '其他语言', code: 'ms' },
  { id: 'tr', label: '土耳其语', group: '其他语言', code: 'tr' },
  { id: 'hi', label: '印地语', group: '其他语言', code: 'hi' },
  { id: 'nl', label: '荷兰语', group: '其他语言', code: 'nl' },
  { id: 'pl', label: '波兰语', group: '其他语言', code: 'pl' },
  { id: 'uk', label: '乌克兰语', group: '其他语言', code: 'uk' },
  { id: 'fa', label: '波斯语', group: '其他语言', code: 'fa' },
  { id: 'he', label: '希伯来语', group: '其他语言', code: 'he' },
  { id: 'sv', label: '瑞典语', group: '其他语言', code: 'sv' },
  { id: 'el', label: '希腊语', group: '其他语言', code: 'el' },
  { id: 'mn', label: '蒙古语', group: '其他语言', code: 'mn' },
  { id: 'bo', label: '藏语', group: '其他语言', code: 'bo' }
];
export const langById = id => LANGS.find(item => item.id === id) || LANGS[0];
export const AUDIO_TYPES = new Set(['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/aac', 'audio/x-m4a', 'video/webm']);
export const MAX_AUDIO_BYTES = 6 * 1024 * 1024;

// 预设：free 表示厂商价格页上标注“免费”（核对于 2026-05，随时可能变化，以官方为准）。
export const PRESETS = [
  { id: 'siliconflow-sensevoice', name: '硅基流动 · SenseVoiceSmall（免费，推荐）', free: true, kind: 'transcriptions', baseUrl: 'https://api.siliconflow.cn/v1', model: 'FunAudioLLM/SenseVoiceSmall', keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    note: '价格页标注免费，需要注册账号并创建 API 密钥（密钥免费）。支持普通话、粤语、英语、日语、韩语；其他方言只能尽力识别。' },
  { id: 'dashscope-qwen-asr', name: '阿里云百炼 · qwen3-asr-flash（按量计费）', kind: 'chat-audio', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3-asr-flash', keyUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key',
    note: '厂商宣称支持多种中文方言，效果请用真实录音验证；是否有免费额度以阿里云当前政策为准。北京地域以外的账号（如新加坡）地址不同，可手工修改。' },
  { id: 'openai-whisper', name: 'OpenAI · whisper-1（按量计费）', kind: 'transcriptions', baseUrl: 'https://api.openai.com/v1', model: 'whisper-1', keyUrl: 'https://platform.openai.com/api-keys', note: '国内服务器通常需要能访问 OpenAI。粤语较好，其他方言一般。' },
  { id: 'groq-whisper', name: 'Groq · whisper-large-v3-turbo', kind: 'transcriptions', baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo', keyUrl: 'https://console.groq.com/keys', free: true, note: '官网标注有免费层（有频率限制），多语种覆盖最广（约 99 种语言，外语首选）；方言只有粤语等少数。国内服务器通常需要能访问 Groq，请先在“测试连接”验证。' },
  { id: 'azure-speech', name: '微软 Azure 语音（有免费层）', free: true, kind: 'azure-speech', native: true, model: 'default', keyUrl: 'https://portal.azure.com/#create/Microsoft.CognitiveServicesSpeechServices',
    note: '密钥填语音资源的密钥，额外参数填 {"region":"eastasia"}。100 多种语言，粤语 / 台语可用。需要海外信用卡开通，以官方免费政策为准。' },
  { id: 'google-speech', name: 'Google Cloud 语音转文字（每月有免费分钟）', free: true, kind: 'google-speech', native: true, model: '', keyUrl: 'https://console.cloud.google.com/apis/credentials',
    note: '密钥填 API Key（先启用 Speech-to-Text API）。外语最全，国内服务器可能连不上，需要海外信用卡。' },
  { id: 'tencent-asr', name: '腾讯云 一句话识别（新用户有免费额度）', free: true, kind: 'tencent-asr', native: true, model: 'auto', keyUrl: 'https://console.cloud.tencent.com/cam/capi',
    note: '密钥填 SecretId:SecretKey。需先在“语音识别”产品里开通并领取免费资源包。中文方言引擎 16k_zh_dialect 覆盖多种方言。' },
  { id: 'baidu-asr', name: '百度智能云 短语音识别（个人认证有免费额度）', free: true, kind: 'baidu-asr', native: true, model: 'auto', keyUrl: 'https://console.bce.baidu.com/ai/#/ai/speech/app/list',
    note: '密钥填 API_Key:Secret_Key。创建应用后领取免费额度；支持普通话、粤语、四川话、英语。' },
  { id: 'cloudflare-whisper', name: 'Cloudflare Workers AI · Whisper（每天有免费额度）', free: true, kind: 'cloudflare-whisper', native: true, model: '@cf/openai/whisper-large-v3-turbo', keyUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    note: '密钥填 账号ID:API令牌。多语种，适合外语；国内服务器访问需自测。' },
  { id: 'speaches-local', name: '自建 · speaches（faster-whisper，完全免费）', free: true, kind: 'transcriptions', baseUrl: 'http://asr:8000/v1', model: 'Systran/faster-whisper-small', keyUrl: '',
    note: '用项目里的 docker-compose.asr.yml 起一个本地服务，多语种免费、数据不出服务器；2 核 4G 建议 small 或 base 模型（CPU 较慢）。镜像与模型名随上游更新，首次需下载模型，详见 README。未经本项目实机验证。' },
  { id: 'self-hosted', name: '自建服务（OpenAI 兼容，如 SenseVoice / FunASR / whisper.cpp 服务）', kind: 'transcriptions', baseUrl: 'http://asr:8000/v1', model: 'sensevoice', keyUrl: '',
    note: '服务需要提供 POST {地址}/audio/transcriptions（multipart：file、model、language、prompt）并返回 {"text": "..."}。内网地址允许 http://，密钥可留空。数据不出内网、完全免费，但要自己有一台能跑模型的机器。' }
];

// ---------- 引擎注册表 ----------
export const ENGINES = new Map();
export function registerAsrEngine(kind, engine) {
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(kind) || typeof engine?.run !== 'function') throw new Error('无效的语音识别引擎：' + kind);
  ENGINES.set(kind, { label: kind, hint: '', ...engine });
}
export const asrKinds = () => [...ENGINES].map(([id, engine]) => ({ id, label: engine.label, hint: engine.hint }));

// ---------- 配置 ----------
// 管理员提交的配置 → 存库的配置（校验、截断）。provider：服务商 id / 'builtin'（环境变量里的内置服务）/ 'custom'（本页单独填地址和密钥）。
export function normalizeAsrConfig(input = {}, existing = {}, validProvider = () => true) {
  const fail = message => Object.assign(new Error(message), { status: 400 });
  const pick = (key, fallback) => (input[key] === undefined ? existing[key] ?? fallback : input[key]);
  const enabled = typeof input.enabled === 'boolean' ? input.enabled : Boolean(existing.enabled);
  const provider = String(pick('provider', '')).trim();
  const kind = String(pick('kind', 'transcriptions')).trim();
  const model = String(pick('model', '')).trim().slice(0, 200);
  const defaultLang = String(pick('defaultLang', 'auto')).trim();
  const hotwords = String(pick('hotwords', '')).trim().slice(0, 500);
  const maxSeconds = Math.round(Number(pick('maxSeconds', 60)));
  if (!ENGINES.has(kind)) throw fail('接口类型无效');
  if (!LANGS.some(item => item.id === defaultLang)) throw fail('默认语言无效');
  if (!Number.isFinite(maxSeconds) || maxSeconds < 5 || maxSeconds > 120) throw fail('单次录音上限需在 5–120 秒之间');
  if (provider && provider !== 'custom' && !validProvider(provider)) throw fail('所选服务商不存在');
  // 额外参数：JSON 对象（字符串或对象都行），最多 2000 字
  let extraParams = pick('extraParams', {});
  if (typeof extraParams === 'string') {
    const text = extraParams.trim();
    if (text.length > 2000) throw fail('额外参数太长');
    try { extraParams = text ? JSON.parse(text) : {}; } catch { throw fail('额外参数不是合法的 JSON'); }
  }
  if (!extraParams || typeof extraParams !== 'object' || Array.isArray(extraParams)) throw fail('额外参数必须是 JSON 对象');
  // 自定义来源：地址 + 密钥只在 custom 时保留（密钥留空 = 沿用旧的）
  let baseUrl = '', apiKey = '';
  if (provider === 'custom') {
    const rawUrl = String(pick('baseUrl', '')).trim();
    if (rawUrl) { try { baseUrl = normalizeBaseUrl(rawUrl); } catch (error) { throw fail(error.message); } }
    const typedKey = input.apiKey === undefined ? '' : String(input.apiKey).trim();
    apiKey = typedKey || existing.apiKey || '';
    if (apiKey.length > 500) throw fail('密钥太长');
    if (enabled && !baseUrl && !ENGINES.get(kind)?.native) throw fail('请填写接口地址');
    if (enabled && ENGINES.get(kind)?.native && !apiKey) throw fail('请填写密钥');
  }
  if (enabled && (!provider || !model)) throw fail('开启前请先选好服务来源并填写模型名');
  return { enabled, provider, kind, model, defaultLang, hotwords, maxSeconds, extraParams, baseUrl, apiKey };
}
// 给管理页看的配置：不含密钥，只告诉有没有 / 掩码
export const publicAsrConfig = config => {
  const { apiKey, extraParams, ...rest } = config || {};
  return { ...rest, hasKey: Boolean(apiKey), keyMask: apiKey ? maskKey(apiKey) : '', extraParams: extraParams && Object.keys(extraParams).length ? JSON.stringify(extraParams, null, 2) : '' };
};

// 0.6 秒静音 WAV（16kHz、单声道、16 位），用于「测试连接」。
export function silenceWav(seconds = 0.6, rate = 16000) {
  const samples = Math.round(seconds * rate), data = samples * 2, buf = Buffer.alloc(44 + data);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + data, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(data, 40);
  return buf;
}

const extOf = mime => ({ 'audio/webm': 'webm', 'video/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/mpeg': 'mp3', 'audio/aac': 'aac' }[mime] || 'wav');
// 给模型的提示：说话人讲什么方言 + 管理员配置的热词。没有内容时返回空串。
export function buildContext(lang, hotwords) {
  const parts = [];
  if (lang.hint) parts.push(`说话人讲的是${lang.hint}，请准确转写成对应的简体中文书面文字。`);
  else if (lang.id === 'zh') parts.push('请转写为简体中文。');
  if (hotwords) parts.push('可能出现的专有名词：' + hotwords.replace(/\s+/g, ' '));
  return parts.join('');
}
// SenseVoice 等模型会带 <|HAPPY|> 之类的情感 / 事件标记，去掉
const cleanText = value => String(value ?? '').replace(/<\|[^|>]*\|>/g, '').trim();

export function upstreamError(status, text) {
  let detail = '';
  try { const data = JSON.parse(text); const e = data?.error; detail = typeof e === 'string' ? e : e?.message || data?.message || ''; } catch { /* 不是 JSON */ }
  const reason = { 401: '密钥无效或没有权限', 403: '没有权限', 404: '接口地址或模型名不对', 413: '音频太大', 429: '请求太频繁或额度不足' }[status] || '服务暂不可用';
  const error = new Error(`语音识别服务返回 HTTP ${status}（${reason}）${detail ? '：' + String(detail).replace(/\s+/g, ' ').slice(0, 120) : ''}`);
  error.status = status === 429 ? 429 : 502; // 上游的 401 不当成“用户登录失效”
  error.upstream = status;
  return error;
}
// 统一的网络错误包装：引擎里 await 出来的异常经它变成带 status 的友好错误
export async function guarded(request) {
  try { return await request(); }
  catch (error) {
    if (error.status) throw error;
    throw Object.assign(new Error(error.name === 'TimeoutError' ? '语音识别服务响应超时' : '无法连接语音识别服务：' + (error.cause?.code || error.message)), { status: 502 });
  }
}

// 调用语音识别服务，返回识别出的文字。audio 是 Buffer，mime 是它的类型。
export async function transcribe({ baseUrl, apiKey = '', kind, model, langId = 'auto', audio, mime = 'audio/wav', hotwords = '', extraParams = {}, timeoutMs = 60000, fetchImpl = fetch }) {
  const engine = ENGINES.get(kind);
  if (!engine) throw Object.assign(new Error('接口类型无效'), { status: 400 });
  const lang = langById(langId);
  const text = await guarded(() => engine.run({
    baseUrl, apiKey, model, lang, context: buildContext(lang, hotwords), audio, mime, extra: extraParams && typeof extraParams === 'object' ? extraParams : {},
    auth: apiKey ? { Authorization: 'Bearer ' + apiKey } : {}, signal: () => AbortSignal.timeout(timeoutMs), fetchImpl
  }));
  return cleanText(text);
}

// ---------- 内置引擎 ----------
// 1) OpenAI 兼容的 /audio/transcriptions（Whisper、gpt-4o-transcribe、Groq、硅基流动 SenseVoice、自建 FunASR / whisper 服务）
registerAsrEngine('transcriptions', {
  label: '音频转写接口（/audio/transcriptions：Whisper、SenseVoice、自建服务）',
  hint: 'multipart 上传 file、model，可带 language、prompt；返回 {"text": "..."}',
  async run({ baseUrl, model, lang, context, audio, mime, extra, auth, signal, fetchImpl }) {
    const url = baseUrl.replace(/\/chat\/completions$/, '').replace(/\/audio\/transcriptions$/, '') + '/audio/transcriptions';
    const attempt = async (withLang, withPrompt) => {
      const form = new FormData();
      form.append('file', new Blob([audio], { type: mime }), 'speech.' + extOf(mime));
      form.append('model', model); form.append('response_format', 'json');
      for (const [key, value] of Object.entries(extra)) if (!['file', 'model'].includes(key) && value !== null && typeof value !== 'object') form.append(key, String(value));
      if (withLang && lang.code) form.append('language', lang.code);
      if (withPrompt && context) form.append('prompt', context);
      const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: signal(), headers: { ...auth, Accept: 'application/json' }, body: form });
      const raw = await response.text();
      if (!response.ok) throw upstreamError(response.status, raw);
      try { return String(JSON.parse(raw).text || ''); } catch { return raw; }
    };
    // 有的服务不认语言代码或 prompt（HTTP 400/422）：先去掉语言代码，再去掉提示词，各重试一次
    const steps = [[true, true]];
    if (lang.code) steps.push([false, true]);
    if (context) steps.push([false, false]);
    let last;
    for (const [withLang, withPrompt] of steps) {
      try { return await attempt(withLang, withPrompt); }
      catch (error) { last = error; if (error.upstream !== 400 && error.upstream !== 422) throw error; }
    }
    throw last;
  }
});

// 2) OpenAI 兼容的对话接口 + input_audio（阿里云百炼 qwen3-asr-flash 等）
registerAsrEngine('chat-audio', {
  label: '对话接口 + 音频输入（阿里云百炼 qwen3-asr-flash 等）',
  hint: 'POST {地址}/chat/completions，content 里放 input_audio（data URL），asr_options 带语言；文字取 choices[0].message.content',
  async run({ baseUrl, model, lang, context, audio, mime, extra, auth, signal, fetchImpl }) {
    const body = {
      ...extra, model, stream: false,
      messages: [
        ...(context ? [{ role: 'system', content: context }] : []),
        { role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:${mime};base64,${audio.toString('base64')}` } }] }
      ],
      asr_options: { enable_itn: true, ...(extra.asr_options && typeof extra.asr_options === 'object' ? extra.asr_options : {}), ...(lang.code ? { language: lang.code } : {}) }
    };
    const response = await fetchImpl(chatEndpoint(baseUrl), { method: 'POST', redirect: 'error', signal: signal(), headers: { ...auth, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
    const raw = await response.text();
    if (!response.ok) throw upstreamError(response.status, raw);
    let data; try { data = JSON.parse(raw); } catch { throw Object.assign(new Error('语音识别服务返回的内容无法解析'), { status: 502 }); }
    const content = data?.choices?.[0]?.message?.content;
    return typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part?.text || '').join('') : data?.output?.text || '';
  }
});
