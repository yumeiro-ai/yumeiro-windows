// 图片理解：判断模型是否能直接看图、本地/自建“识图服务”的请求与响应处理。纯函数，便于测试。
import { deflateSync } from 'node:zlib';
import { crc32 } from './ziputil.mjs';
export const VISION_LIMITS = { maxImages: 4, maxMbDefault: 8, perUserKeep: 300, promptMax: 1000, timeoutSec: { min: 5, max: 600, def: 120 } };
export const VISION_DIALECTS = [
  { id: 'openai', label: '视觉模型（OpenAI 兼容 /chat/completions，如 Ollama / LM Studio / vLLM / llama.cpp 的视觉模型）' },
  { id: 'http-ocr', label: '识别接口（POST 上传图片，返回 JSON 文字，如自建的 PaddleOCR / 本地 OCR 服务）' }
];
export const DEFAULT_VISION_MODELS = ['gpt-4o', 'gpt-4.1', 'gpt-4-turbo', 'gpt-5', 'o3', 'o4', 'claude-3', 'claude-sonnet-4', 'claude-opus-4', 'claude-haiku-4', 'gemini', 'qwen-vl', 'qwen2-vl', 'qwen2.5-vl', 'qwen3-vl', 'qvq', 'glm-4v', 'glm-4.5v', 'llava', 'minicpm-v', 'pixtral', 'llama3.2-vision', 'llama-3.2-11b-vision', 'internvl', 'vision', '-vl'];
export const DEFAULT_PROMPT = '请详细描述这张图片的内容；如果图里有文字，请逐字转写出来（保持原有的段落和顺序）；如果是图表或界面截图，请说明其中的关键数据和元素。';

export const defaultVisionConfig = () => ({ enabled: false, mode: 'auto', dialect: 'openai', baseUrl: '', apiKey: '', model: '', prompt: DEFAULT_PROMPT, textPath: 'text', timeoutSec: VISION_LIMITS.timeoutSec.def, maxImages: VISION_LIMITS.maxImages, maxMb: VISION_LIMITS.maxMbDefault, visionModels: DEFAULT_VISION_MODELS.join(', ') });

const clamp = (value, min, max, fallback) => { const n = Number(value); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback; };
const maskKey = key => key ? (key.length <= 8 ? '••••' : key.slice(0, 3) + '••••' + key.slice(-4)) : '';
export const parsePatterns = value => [...new Set((Array.isArray(value) ? value : String(value || '').split(/[,，\n]+/)).map(item => String(item).trim().toLowerCase()).filter(Boolean))].slice(0, 80);

export function normalizeVisionConfig(input = {}, existing = {}) {
  const base = { ...defaultVisionConfig(), ...existing };
  const dialect = VISION_DIALECTS.some(item => item.id === input.dialect) ? input.dialect : base.dialect;
  const baseUrl = input.baseUrl !== undefined ? String(input.baseUrl).trim().replace(/\/+$/, '').slice(0, 300) : base.baseUrl;
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) throw Object.assign(new Error('服务地址需要以 http:// 或 https:// 开头'), { status: 400 });
  if (baseUrl && /[\s"'<>]/.test(baseUrl)) throw Object.assign(new Error('服务地址格式不对'), { status: 400 });
  const textPath = input.textPath !== undefined ? String(input.textPath).trim().slice(0, 100) : base.textPath;
  if (textPath && !/^[\w$.\-\[\]]+$/.test(textPath)) throw Object.assign(new Error('文字字段路径只能包含字母、数字和 . [ ] _ -'), { status: 400 });
  const config = {
    enabled: input.enabled !== undefined ? Boolean(input.enabled) : base.enabled,
    mode: input.mode === 'service' || input.mode === 'auto' ? input.mode : base.mode,
    dialect, baseUrl,
    apiKey: input.apiKey !== undefined && input.apiKey !== '' ? String(input.apiKey).trim().slice(0, 500) : base.apiKey,
    model: input.model !== undefined ? String(input.model).trim().slice(0, 200) : base.model,
    prompt: input.prompt !== undefined ? (String(input.prompt).trim().slice(0, VISION_LIMITS.promptMax) || DEFAULT_PROMPT) : base.prompt,
    textPath: textPath || 'text',
    timeoutSec: clamp(input.timeoutSec ?? base.timeoutSec, VISION_LIMITS.timeoutSec.min, VISION_LIMITS.timeoutSec.max, VISION_LIMITS.timeoutSec.def),
    maxImages: clamp(input.maxImages ?? base.maxImages, 1, VISION_LIMITS.maxImages, VISION_LIMITS.maxImages),
    maxMb: clamp(input.maxMb ?? base.maxMb, 1, 20, VISION_LIMITS.maxMbDefault),
    visionModels: input.visionModels !== undefined ? parsePatterns(input.visionModels).join(', ') : base.visionModels
  };
  if (input.clearKey === true) config.apiKey = '';
  if (config.enabled && !config.baseUrl) throw Object.assign(new Error('启用识图服务前请先填写服务地址'), { status: 400 });
  if (config.enabled && config.dialect === 'openai' && !config.model) throw Object.assign(new Error('视觉模型方式需要填写模型名称'), { status: 400 });
  return config;
}
export const publicVisionConfig = config => ({ ...config, apiKey: undefined, hasKey: Boolean(config.apiKey), keyMask: maskKey(config.apiKey) });

// 模型名里带这些关键词就认为能直接看图（管理员可改关键词表）
export function isVisionModel(modelName, patterns) {
  const name = String(modelName || '').toLowerCase(), list = Array.isArray(patterns) ? patterns : parsePatterns(patterns);
  return list.some(pattern => name.includes(pattern));
}
// 这次对话怎么处理图片：direct = 直接发给聊天模型；service = 先用识图服务转成文字；none = 没办法
export function visionRoute(config, modelName) {
  const serviceReady = Boolean(config.enabled && config.baseUrl);
  if (config.mode !== 'service' && isVisionModel(modelName, config.visionModels)) return 'direct';
  return serviceReady ? 'service' : 'none';
}
export const NO_ROUTE_MESSAGE = '当前模型不能直接看图。请换一个支持图片的模型（如 GPT-4o、Claude、Gemini、Qwen-VL），或让管理员在“管理设置 → 图片理解”里接入识图服务（本地视觉模型 / OCR）。';

export const dataUrl = (mime, buffer) => 'data:' + mime + ';base64,' + buffer.toString('base64');
// 发给聊天模型的多模态内容
export const imageParts = (text, images) => [{ type: 'text', text: text || '请看这些图片。' }, ...images.map(image => ({ type: 'image_url', image_url: { url: image.url } }))];

const authHeaders = config => config.apiKey ? { Authorization: 'Bearer ' + config.apiKey } : {};
export const visionEndpoint = baseUrl => { const base = String(baseUrl).replace(/\/+$/, ''); return /\/chat\/completions$/.test(base) ? base : base + '/chat/completions'; };

// 识图服务请求。openai：JSON；http-ocr：multipart（字段名 file）
export function buildVisionRequest(config, { buffer, mime, prompt }) {
  if (config.dialect === 'http-ocr') {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mime }), 'image.' + (mime.split('/')[1] || 'png'));
    return { url: config.baseUrl, init: { method: 'POST', headers: { Accept: 'application/json', ...authHeaders(config) }, body: form } };
  }
  return {
    url: visionEndpoint(config.baseUrl),
    init: { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...authHeaders(config) }, body: JSON.stringify({ model: config.model, stream: false, max_tokens: 2000, messages: [{ role: 'user', content: imageParts(prompt || config.prompt, [{ url: dataUrl(mime, buffer) }]) }] }) }
  };
}
// 按 a.b[0].c 取值
export function pickPath(data, pathText) {
  let current = data;
  for (const part of String(pathText || '').split(/\.|\[(\d+)\]/).filter(x => x !== undefined && x !== '')) { if (current == null) return undefined; current = current[part]; }
  return current;
}
const flatten = value => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(item => flatten(item)).filter(Boolean).join('\n');
  if (value && typeof value === 'object') return flatten(value.text ?? value.content ?? value.transcription ?? value.rec_text ?? value.label ?? '');
  return '';
};
export function parseVisionResponse(config, data) {
  if (config.dialect === 'http-ocr') {
    const tried = [pickPath(data, config.textPath), data?.text, data?.data?.text, data?.result, data?.results, data?.data, data?.lines, data?.words_result];
    for (const candidate of tried) { const text = flatten(candidate).trim(); if (text) return { text, usage: null }; }
    return { text: '', usage: null };
  }
  const message = data?.choices?.[0]?.message?.content;
  const text = (typeof message === 'string' ? message : Array.isArray(message) ? message.map(part => part?.text || '').join('') : '').trim();
  const usage = data?.usage && (data.usage.prompt_tokens != null || data.usage.completion_tokens != null) ? { inputTokens: data.usage.prompt_tokens ?? null, outputTokens: data.usage.completion_tokens ?? null, totalTokens: data.usage.total_tokens ?? ((data.usage.prompt_tokens || 0) + (data.usage.completion_tokens || 0)) } : null;
  return { text, usage };
}
// 把识别结果拼进文字消息
export function describedText(text, descriptions) {
  const blocks = descriptions.map((desc, index) => '[图片 ' + (index + 1) + ' 识别结果]\n' + String(desc || '（没有识别出内容）').slice(0, 6000));
  return (text ? text + '\n\n' : '') + blocks.join('\n\n');
}

// 测试用小图片（64x64 渐变 + 黑色十字），不依赖任何图片库
export function testPng(size = 64) {
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type, 'latin1'), data]), out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body), 8 + data.length); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) { const row = y * (size * 3 + 1); for (let x = 0; x < size; x++) { const cross = Math.abs(x - size / 2) < 3 || Math.abs(y - size / 2) < 3; raw[row + 1 + x * 3] = cross ? 0 : Math.round(255 * x / size); raw[row + 2 + x * 3] = cross ? 0 : Math.round(255 * y / size); raw[row + 3 + x * 3] = cross ? 0 : 200; } }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
