// 语音合成（TTS，“朗读”）：配置规范化、朗读文本清理、请求构造、音频头校验（纯函数，不碰网络和存储）。
// 对接 OpenAI 兼容的 POST {baseUrl}/audio/speech（OpenAI tts-1 / gpt-4o-mini-tts、硅基流动 CosyVoice、各类自建网关等），返回二进制音频。
import { createHash } from 'node:crypto';
import { normalizeBaseUrl, maskKey } from './providers.mjs';

export const DEFAULT_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
export const FORMATS = { mp3: 'audio/mpeg', wav: 'audio/wav', opus: 'audio/ogg', aac: 'audio/aac', flac: 'audio/flac' };
export const LIMITS = { maxCharsCap: 4096, maxBytes: 20 * 1024 * 1024, apiTimeoutMs: 90000, cacheEntries: 40, cacheBytes: 24 * 1024 * 1024 };
export const defaultTtsConfig = () => ({ enabled: false, provider: '', baseUrl: '', apiKey: '', model: '', voices: DEFAULT_VOICES, defaultVoice: DEFAULT_VOICES[0], format: 'mp3', speed: 1, dailyChars: 50000, maxChars: 2000, readCode: false, extraParams: {} });

export function normalizeTtsConfig(input = {}, existing = {}, validProvider = () => true) {
  const fail = message => Object.assign(new Error(message), { status: 400 });
  const base = { ...defaultTtsConfig(), ...existing };
  const pick = key => (input[key] === undefined ? base[key] : input[key]);
  const enabled = typeof input.enabled === 'boolean' ? input.enabled : Boolean(base.enabled);
  const readCode = typeof input.readCode === 'boolean' ? input.readCode : Boolean(base.readCode);
  const provider = String(pick('provider') || '').trim();
  const model = String(pick('model') || '').trim().slice(0, 200);
  const format = String(pick('format') || 'mp3');
  if (!FORMATS[format]) throw fail('音频格式只能是 ' + Object.keys(FORMATS).join(' / '));
  if (provider && provider !== 'custom' && !validProvider(provider)) throw fail('所选服务商不存在');
  const voicesRaw = Array.isArray(pick('voices')) ? pick('voices') : String(pick('voices') || '').split(/[\n,，]+/);
  const voices = [...new Set(voicesRaw.map(item => String(item).trim()).filter(item => item && item.length <= 120))].slice(0, 60);
  if (!voices.length) throw fail('至少需要一个音色');
  const defaultVoice = String(pick('defaultVoice') || voices[0]).trim();
  if (!voices.includes(defaultVoice)) throw fail('默认音色必须在音色列表里');
  const speed = Number(pick('speed')), dailyChars = Math.round(Number(pick('dailyChars'))), maxChars = Math.round(Number(pick('maxChars')));
  if (!(speed >= 0.5 && speed <= 2)) throw fail('默认语速需在 0.5–2 之间');
  if (!Number.isFinite(dailyChars) || dailyChars < 0 || dailyChars > 10000000) throw fail('每人每天字数需在 0–10000000 之间（0 = 不限）');
  if (!(maxChars >= 50 && maxChars <= LIMITS.maxCharsCap)) throw fail(`单次最多字数需在 50–${LIMITS.maxCharsCap} 之间`);
  let extraParams = pick('extraParams');
  if (typeof extraParams === 'string') {
    const text = extraParams.trim();
    if (text.length > 2000) throw fail('额外参数太长');
    try { extraParams = text ? JSON.parse(text) : {}; } catch { throw fail('额外参数不是合法的 JSON'); }
  }
  if (!extraParams || typeof extraParams !== 'object' || Array.isArray(extraParams)) throw fail('额外参数必须是 JSON 对象');
  let baseUrl = '', apiKey = '';
  if (provider === 'custom') {
    const rawUrl = String(pick('baseUrl') || '').trim();
    if (rawUrl) { try { baseUrl = normalizeBaseUrl(rawUrl); } catch (error) { throw fail(error.message); } }
    const typedKey = input.apiKey === undefined ? '' : String(input.apiKey).trim();
    apiKey = typedKey || existing.apiKey || '';
    if (apiKey.length > 500) throw fail('密钥太长');
    if (enabled && !baseUrl) throw fail('请填写接口地址');
  } else if (enabled && !provider) throw fail('请选择服务商，或选“自定义”');
  if (enabled && !model) throw fail('请填写语音合成模型名称');
  return { enabled, provider, baseUrl, apiKey, model, voices, defaultVoice, format, speed, dailyChars, maxChars, readCode, extraParams };
}
export const publicTtsConfig = config => ({ ...config, apiKey: undefined, hasKey: Boolean(config.apiKey), keyMask: maskKey(config.apiKey) });
export const speechEndpoint = baseUrl => baseUrl.endsWith('/audio/speech') ? baseUrl : baseUrl.replace(/\/+$/, '') + '/audio/speech';

// 把聊天回复变成适合“读出来”的文本：代码块、链接地址、Markdown 符号都不念。
export function speakableText(text, { readCode = false } = {}) {
  let t = String(text ?? '');
  t = t.replace(/```[\s\S]*?```/g, readCode ? ' ' : '（这里有一段代码，已省略）');
  t = t.replace(/`([^`]+)`/g, '$1');
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  t = t.replace(/<[^>]+>/g, ' ');
  t = t.replace(/https?:\/\/\S+/g, '（链接）');
  t = t.replace(/^\s{0,3}#{1,6}\s*/gm, '').replace(/^\s*>\s?/gm, '').replace(/^\s*[-*+]\s+/gm, '').replace(/^\s*\d+[.)]\s+/gm, '');
  t = t.replace(/^\s*\|?[-:| ]{3,}\|?\s*$/gm, '').replace(/\|/g, '，');
  t = t.replace(/(\*\*|__|~~)/g, '').replace(/[*_]{1,2}([^*_\n]+)[*_]{1,2}/g, '$1');
  return t.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '。').replace(/。{2,}/g, '。').replace(/^。+|。+$/g, '').trim();
}

// 校验请求。voice 不在列表里时回退到默认音色（OpenAI 客户端常发 alloy 等固定名字）。
export function cleanSpeechRequest(config, body = {}) {
  const fail = message => Object.assign(new Error(message), { status: 400 });
  const raw = body.input ?? body.text ?? '';
  const text = body.clean === false ? String(raw).trim() : speakableText(raw, { readCode: config.readCode });
  if (!text) throw fail('没有可朗读的内容');
  if (text.length > config.maxChars) throw fail(`一次最多朗读 ${config.maxChars} 个字，当前 ${text.length} 个`);
  const voice = config.voices.includes(body.voice) ? body.voice : config.defaultVoice;
  const speedNum = Number(body.speed ?? config.speed);
  const speed = Number.isFinite(speedNum) ? Math.min(2, Math.max(0.5, speedNum)) : config.speed;
  const format = FORMATS[body.response_format] ? body.response_format : config.format;
  return { text, voice, speed, format };
}
export const buildSpeechRequest = (config, { text, voice, speed, format }) => ({ ...(config.extraParams || {}), model: config.model, input: text, voice, speed, response_format: format });
export const speechCacheKey = (config, params) => createHash('sha256').update(JSON.stringify([config.baseUrl || config.provider, config.model, params.voice, params.speed, params.format, params.text])).digest('hex');

// 看文件头确认是真正的音频（不信任上游声明的类型）
export function sniffAudio(buffer) {
  if (!buffer || buffer.length < 12) return null;
  const head = buffer.toString('latin1', 0, 4);
  if (buffer.toString('latin1', 0, 3) === 'ID3') return { mime: 'audio/mpeg' };
  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return { mime: (buffer[1] & 0x06) === 0 ? 'audio/aac' : 'audio/mpeg' };
  if (head === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WAVE') return { mime: 'audio/wav' };
  if (head === 'OggS') return { mime: 'audio/ogg' };
  if (head === 'fLaC') return { mime: 'audio/flac' };
  if (buffer.toString('latin1', 4, 8) === 'ftyp') return { mime: 'audio/mp4' };
  return null;
}

// 极简 multipart/form-data 解析（OpenAI 兼容的 /v1/audio/transcriptions 上传用）
export function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(String(contentType || ''));
  if (!match) throw Object.assign(new Error('缺少 multipart boundary'), { status: 400 });
  const boundary = Buffer.from('--' + (match[1] || match[2])), fields = {}, files = [];
  let pos = buffer.indexOf(boundary);
  while (pos >= 0) {
    const start = pos + boundary.length;
    if (buffer.toString('latin1', start, start + 2) === '--') break;
    const next = buffer.indexOf(boundary, start);
    if (next < 0) break;
    const part = buffer.subarray(start + 2, next - 2); // 去掉前后的 \r\n
    const split = part.indexOf('\r\n\r\n');
    if (split >= 0) {
      const head = part.subarray(0, split).toString('utf8'), body = part.subarray(split + 4);
      const name = /name="([^"]*)"/i.exec(head)?.[1], filename = /filename="([^"]*)"/i.exec(head)?.[1], type = /content-type:\s*([^\r\n;]+)/i.exec(head)?.[1]?.trim().toLowerCase();
      if (name && filename !== undefined) files.push({ name, filename, type: type || '', data: Buffer.from(body) });
      else if (name) fields[name] = body.toString('utf8');
    }
    pos = next;
  }
  return { fields, files };
}
const EXT_TYPES = { mp3: 'audio/mpeg', wav: 'audio/wav', webm: 'audio/webm', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', mpeg: 'audio/mpeg', mpga: 'audio/mpeg', opus: 'audio/ogg' };
export const audioTypeOf = file => (file.type && file.type !== 'application/octet-stream' ? file.type : EXT_TYPES[String(file.filename).split('.').pop().toLowerCase()] || file.type);
