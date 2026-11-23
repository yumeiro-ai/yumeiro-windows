// 语音识别：各大平台的原生接口引擎（不是 OpenAI 兼容协议的那些）。
// 每个引擎都只访问固定的官方域名（地域参数经过格式校验），不接受管理员填任意地址，避免被当成内网探测工具。
// 密钥统一填在“语音识别 → 自定义”的密钥框里；需要两段的平台用英文冒号连接：
//   腾讯云  SecretId:SecretKey　　百度  API_Key:Secret_Key　　Cloudflare  账号ID:API令牌
// 额外参数（JSON，可选）：{"region":"eastasia","language":"zh-CN"} 等，见各引擎的 hint。
// 浏览器录音已在前端转成 16kHz 单声道 WAV，这里的原生引擎都按 WAV 处理。
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { registerAsrEngine, upstreamError } from './asr.mjs';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const isWav = mime => /^audio\/(x-)?wave?$/.test(mime) || mime === 'audio/wav';
const needWav = mime => { if (!isWav(mime)) throw fail('这个语音识别平台只接受 WAV 录音（网页端会自动转换）'); };
const splitKey = (apiKey, names) => {
  const parts = String(apiKey || '').split(':');
  if (parts.length < 2 || parts.some(part => !part.trim())) throw fail('密钥格式应为 ' + names.join(':') + '（用英文冒号连接）');
  return [parts[0].trim(), parts.slice(1).join(':').trim()];
};
const readJson = async (response, what) => {
  const raw = await response.text();
  if (!response.ok) throw upstreamError(response.status, raw);
  try { return JSON.parse(raw); } catch { throw fail(what + '返回的内容无法解析', 502); }
};
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const hmac = (key, value, encoding) => crypto.createHmac('sha256', key).update(value).digest(encoding);

// 语言 id → 各平台语言代码。没有登记的方言按普通话处理（方言提示词对这些平台无效，请改选支持方言的引擎）。
const LOCALE = {
  zh: 'zh-CN', yue: 'zh-HK', en: 'en-US', ja: 'ja-JP', ko: 'ko-KR', fr: 'fr-FR', de: 'de-DE', es: 'es-ES', pt: 'pt-BR', ru: 'ru-RU', it: 'it-IT',
  ar: 'ar-SA', th: 'th-TH', vi: 'vi-VN', id: 'id-ID', ms: 'ms-MY', tr: 'tr-TR', hi: 'hi-IN', nl: 'nl-NL', pl: 'pl-PL', uk: 'uk-UA', fa: 'fa-IR',
  he: 'he-IL', sv: 'sv-SE', el: 'el-GR', hokkien: 'zh-TW'
};
const localeOf = (lang, extra, fallback = 'zh-CN') => String(extra.language || LOCALE[lang.id] || fallback);

// 1) 微软 Azure 语音（短音频 REST）。有免费层（F0），以官方为准。
registerAsrEngine('azure-speech', {
  label: '微软 Azure 语音（短音频 REST）',
  hint: '密钥填 Azure 语音资源的密钥；额外参数 {"region":"eastasia"} 填资源所在区域（默认 eastasia）；模型名随便填。支持粤语(zh-HK)、台湾话(zh-TW)与 100 多种语言，不支持其他中文方言。',
  native: true,
  async run({ apiKey, lang, audio, mime, extra, signal, fetchImpl }) {
    needWav(mime);
    if (!apiKey) throw fail('请填写 Azure 语音资源的密钥');
    const region = String(extra.region || 'eastasia').toLowerCase();
    if (!/^[a-z0-9]{3,30}$/.test(region)) throw fail('区域格式不对，例如 eastasia、westeurope');
    const url = `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?format=simple&language=${encodeURIComponent(localeOf(lang, extra))}`;
    const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: signal(), headers: { 'Ocp-Apim-Subscription-Key': apiKey, 'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000', Accept: 'application/json' }, body: audio });
    const data = await readJson(response, 'Azure 语音');
    if (data.RecognitionStatus && !['Success', 'NoMatch', 'InitialSilenceTimeout'].includes(data.RecognitionStatus)) throw fail('Azure 语音识别失败：' + data.RecognitionStatus, 502);
    return data.DisplayText || '';
  }
});

// 2) Google Cloud Speech-to-Text v1（API 密钥）。每月有免费分钟数，以官方为准。
registerAsrEngine('google-speech', {
  label: 'Google Cloud Speech-to-Text',
  hint: '密钥填 Google Cloud 的 API Key（需先启用 Speech-to-Text API）；模型名可留空或填 latest_long 等；额外参数 {"language":"yue-Hant-HK"} 可覆盖语言。国内服务器可能连不上。',
  native: true,
  async run({ apiKey, model, lang, audio, mime, extra, signal, fetchImpl }) {
    needWav(mime);
    if (!apiKey) throw fail('请填写 Google Cloud 的 API Key');
    const locale = { zh: 'cmn-Hans-CN', yue: 'yue-Hant-HK' }[lang.id] || LOCALE[lang.id] || 'cmn-Hans-CN';
    const config = { encoding: 'LINEAR16', sampleRateHertz: 16000, languageCode: String(extra.language || locale), enableAutomaticPunctuation: true };
    if (model && /^[a-z_]{3,30}$/.test(model)) config.model = model;
    const response = await fetchImpl('https://speech.googleapis.com/v1/speech:recognize', { method: 'POST', redirect: 'error', signal: signal(), headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ config, audio: { content: audio.toString('base64') } }) });
    const data = await readJson(response, 'Google 语音');
    return (data.results || []).map(item => item.alternatives?.[0]?.transcript || '').join('');
  }
});

// 3) 腾讯云 一句话识别（TC3-HMAC-SHA256 签名）。新用户通常有免费资源包，以官方为准。
const TENCENT_ENGINE = { zh: '16k_zh', yue: '16k_yue', en: '16k_en', ja: '16k_ja', ko: '16k_ko', vi: '16k_vi', ms: '16k_ms', id: '16k_id', th: '16k_th', pt: '16k_pt', tr: '16k_tr', ar: '16k_ar', es: '16k_es', hi: '16k_hi', fr: '16k_fr', de: '16k_de' };
registerAsrEngine('tencent-asr', {
  label: '腾讯云 一句话识别',
  hint: '密钥填 SecretId:SecretKey（英文冒号连接，在腾讯云“访问管理 → API 密钥”创建）；模型名填引擎类型，如 16k_zh_dialect（中文方言）、16k_zh、16k_yue、16k_en；填 auto 则按所选语言自动挑选（方言默认走 16k_zh_dialect）。音频限 60 秒。',
  native: true,
  async run({ apiKey, model, lang, audio, mime, extra, signal, fetchImpl }) {
    needWav(mime);
    const [secretId, secretKey] = splitKey(apiKey, ['SecretId', 'SecretKey']);
    const engineType = model && model !== 'auto' ? model : lang.hint && lang.id !== 'yue' ? '16k_zh_dialect' : TENCENT_ENGINE[lang.id] || '16k_zh';
    if (!/^[0-9a-z_\-]{3,40}$/i.test(engineType)) throw fail('引擎类型格式不对');
    const payload = JSON.stringify({ EngSerViceType: engineType, SourceType: 1, VoiceFormat: 'wav', Data: audio.toString('base64'), DataLen: audio.length, ...(extra.hotword_id ? { HotwordId: String(extra.hotword_id) } : {}) });
    const host = 'asr.tencentcloudapi.com', timestamp = Math.floor(Date.now() / 1000), date = new Date(timestamp * 1000).toISOString().slice(0, 10);
    const canonical = `POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:sentencerecognition\n\ncontent-type;host;x-tc-action\n${sha256(payload)}`;
    const scope = `${date}/asr/tc3_request`;
    const toSign = `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256(canonical)}`;
    const signingKey = hmac(hmac(hmac('TC3' + secretKey, date), 'asr'), 'tc3_request');
    const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${scope}, SignedHeaders=content-type;host;x-tc-action, Signature=${hmac(signingKey, toSign, 'hex')}`;
    const response = await fetchImpl(`https://${host}/`, {
      method: 'POST', redirect: 'error', signal: signal(), body: payload,
      headers: { Authorization: authorization, 'Content-Type': 'application/json; charset=utf-8', Host: host, 'X-TC-Action': 'SentenceRecognition', 'X-TC-Version': '2019-06-14', 'X-TC-Timestamp': String(timestamp), 'X-TC-Region': String(extra.region || 'ap-guangzhou').replace(/[^a-z0-9-]/gi, '') }
    });
    const data = await readJson(response, '腾讯云');
    if (data.Response?.Error) throw fail('腾讯云返回：' + String(data.Response.Error.Message || data.Response.Error.Code).slice(0, 120), 502);
    return data.Response?.Result || '';
  }
});

// 4) 百度智能云 短语音识别标准版。个人认证后通常有免费额度，以官方为准。
const BAIDU_DEV = { zh: 1537, en: 1737, yue: 1637, sichuan: 1837 };
const baiduTokens = new Map();
registerAsrEngine('baidu-asr', {
  label: '百度智能云 短语音识别',
  hint: '密钥填 API_Key:Secret_Key（英文冒号连接，在百度智能云“语音技术”应用里获取）；模型名填 dev_pid（1537 普通话、1737 英语、1637 粤语、1837 四川话），填 auto 则按所选语言挑选。音频限 60 秒。',
  native: true,
  async run({ apiKey, model, lang, audio, mime, signal, fetchImpl }) {
    needWav(mime);
    const [clientId, clientSecret] = splitKey(apiKey, ['API_Key', 'Secret_Key']);
    const cached = baiduTokens.get(clientId);
    let token = cached && cached.expires > Date.now() ? cached.token : '';
    if (!token) {
      const response = await fetchImpl('https://aip.baidubce.com/oauth/2.0/token?' + new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }), { method: 'POST', redirect: 'error', signal: signal(), headers: { Accept: 'application/json' } });
      const data = await readJson(response, '百度');
      if (!data.access_token) throw fail('百度鉴权失败：' + String(data.error_description || data.error || '').slice(0, 100), 502);
      token = data.access_token; baiduTokens.set(clientId, { token, expires: Date.now() + Math.max(60, Number(data.expires_in) || 2592000) * 900 });
    }
    const devPid = Number(model && model !== 'auto' ? model : BAIDU_DEV[lang.id] || 1537);
    if (!Number.isInteger(devPid)) throw fail('模型名应填数字 dev_pid，或 auto');
    const response = await fetchImpl('https://vop.baidu.com/server_api', { method: 'POST', redirect: 'error', signal: signal(), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format: 'wav', rate: 16000, channel: 1, cuid: 'cindy-workspace', token, dev_pid: devPid, speech: audio.toString('base64'), len: audio.length }) });
    const data = await readJson(response, '百度');
    if (data.err_no === 3301) return '';
    if (data.err_no && data.err_no !== 0) {
      if ([110, 111, 3302].includes(data.err_no)) baiduTokens.delete(clientId);
      throw fail(`百度返回错误 ${data.err_no}：${String(data.err_msg || '').slice(0, 100)}`, 502);
    }
    return (data.result || []).join('');
  }
});

// 5) Cloudflare Workers AI 的 Whisper。每天有免费额度，以官方为准。
registerAsrEngine('cloudflare-whisper', {
  label: 'Cloudflare Workers AI（Whisper）',
  hint: '密钥填 账号ID:API令牌（令牌需有 Workers AI 权限）；模型名如 @cf/openai/whisper-large-v3-turbo。多语种，每天有免费额度。',
  native: true,
  async run({ apiKey, model, lang, audio, mime, signal, fetchImpl }) {
    needWav(mime);
    const [accountId, token] = splitKey(apiKey, ['账号ID', 'API令牌']);
    if (!/^[0-9a-f]{32}$/i.test(accountId)) throw fail('账号 ID 应为 32 位字母数字');
    const name = model || '@cf/openai/whisper-large-v3-turbo';
    if (!/^@cf\/[a-z0-9_.\-]+\/[a-z0-9_.\-]+$/i.test(name)) throw fail('模型名格式不对');
    const body = { audio: audio.toString('base64') };
    if (lang.code) body.language = lang.code;
    const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${name}`, { method: 'POST', redirect: 'error', signal: signal(), headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await readJson(response, 'Cloudflare');
    if (data.success === false) throw fail('Cloudflare 返回：' + String(data.errors?.[0]?.message || '').slice(0, 120), 502);
    return data.result?.text || '';
  }
});

// 预留：用环境变量 ASR_ENGINE_FILES（逗号分隔的 .mjs 路径，须在容器内可读）加载你自己的引擎。
// 文件里 import { registerAsrEngine } from '/app/asr.mjs' 然后注册即可（讯飞等 WebSocket 类的平台可以这样接入）。
export async function loadAsrExtras(env = process.env) {
  for (const file of String(env.ASR_ENGINE_FILES || '').split(',').map(item => item.trim()).filter(Boolean)) {
    try { await import(pathToFileURL(file).href); console.log('已加载语音识别引擎文件', file); }
    catch (error) { console.error('语音识别引擎文件加载失败', file, error.message); }
  }
}
