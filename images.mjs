// 文生图：配置规范化、请求构造、响应解析、结果校验（纯函数，不碰网络和存储）。
// 对接 OpenAI 兼容的 POST {baseUrl}/images/generations：OpenAI（gpt-image / dall-e）、智谱 CogView、火山方舟、xAI、
// 以及多数自建网关；另提供 siliconflow 方言（image_size / batch_size，返回 images[].url）。
import { normalizeBaseUrl, maskKey } from './providers.mjs';

export const DIALECTS = [
  { id: 'openai', label: 'OpenAI 兼容（size / n，返回 data[]）——OpenAI、智谱、火山方舟、xAI 等' },
  { id: 'siliconflow', label: '硅基流动（image_size / batch_size，返回 images[]）' },
  { id: 'a1111', label: '本机 Stable Diffusion WebUI / Forge（/sdapi/v1/txt2img，启动时加 --api）' },
  { id: 'comfyui', label: '本机 ComfyUI（/prompt 工作流，可自定义工作流）' }
];
export const DEFAULT_SIZES = ['1024x1024', '1024x1792', '1792x1024'];
export const BATCH_MODES = [{ id: 'native', label: '一次请求出多张（模型不支持时自动改成多次单张）' }, { id: 'split', label: '总是拆成多次单张请求并发（只支持 1 张的模型选这个）' }];
export const LIMITS = { promptMax: 2000, maxBytes: 20 * 1024 * 1024, perUserKeep: 300, fetchTimeoutMs: 60000, apiTimeoutMs: 180000 };
export const defaultImageConfig = () => ({ enabled: false, provider: '', baseUrl: '', apiKey: '', model: '', dialect: 'openai', responseFormat: '', sizes: DEFAULT_SIZES, defaultSize: DEFAULT_SIZES[0], dailyLimit: 20, maxPerRequest: 2, extraParams: {}, batchMode: 'native', allowCustomSize: false, minSide: 256, maxSide: 2048, sizeStep: 16, maxPixels: 4194304, workflow: '' });

export function normalizeImageConfig(input = {}, existing = {}, validProvider = () => true) {
  const fail = message => Object.assign(new Error(message), { status: 400 });
  const base = { ...defaultImageConfig(), ...existing };
  const pick = (key) => (input[key] === undefined ? base[key] : input[key]);
  const enabled = typeof input.enabled === 'boolean' ? input.enabled : Boolean(base.enabled);
  const provider = String(pick('provider') || '').trim();
  const model = String(pick('model') || '').trim().slice(0, 200);
  const dialect = String(pick('dialect') || 'openai');
  const responseFormat = String(pick('responseFormat') || '');
  if (!DIALECTS.some(item => item.id === dialect)) throw fail('接口方言无效');
  if (!['', 'b64_json', 'url'].includes(responseFormat)) throw fail('返回格式只能是“不指定 / b64_json / url”');
  if (provider && provider !== 'custom' && !validProvider(provider)) throw fail('所选服务商不存在');
  const sizesRaw = Array.isArray(pick('sizes')) ? pick('sizes') : String(pick('sizes') || '').split(/[\s,，]+/);
  const sizes = [...new Set(sizesRaw.map(item => String(item).trim().toLowerCase()).filter(item => /^\d{3,4}x\d{3,4}$/.test(item)))].slice(0, 12);
  if (!sizes.length) throw fail('至少需要一个尺寸，格式如 1024x1024');
  const batchMode = String(pick('batchMode') || 'native');
  if (!BATCH_MODES.some(item => item.id === batchMode)) throw fail('多张生成方式无效');
  const allowCustomSize = typeof input.allowCustomSize === 'boolean' ? input.allowCustomSize : Boolean(base.allowCustomSize);
  const minSide = Math.round(Number(pick('minSide'))), maxSide = Math.round(Number(pick('maxSide'))), sizeStep = Math.round(Number(pick('sizeStep'))), maxPixels = Math.round(Number(pick('maxPixels')));
  if (!(minSide >= 64 && maxSide <= 4096 && minSide <= maxSide)) throw fail('自定义尺寸的边长范围需在 64–4096 之间，且最小值不超过最大值');
  if (!(sizeStep >= 1 && sizeStep <= 256)) throw fail('尺寸步长需在 1–256 之间（多数模型要求是 8 或 16 的倍数）');
  if (!(maxPixels >= 65536 && maxPixels <= 16777216)) throw fail('总像素上限需在 65536–16777216 之间');
  let workflow = String(pick('workflow') || '').trim();
  if (workflow.length > 30000) throw fail('工作流太长（上限 30000 字符）');
  if (workflow) { try { const parsed = JSON.parse(workflow); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('x'); } catch { throw fail('工作流必须是 ComfyUI 导出的 API 格式 JSON 对象'); } }
  const defaultSize = String(pick('defaultSize') || sizes[0]).toLowerCase();
  if (!sizes.includes(defaultSize)) throw fail('默认尺寸必须在可选尺寸里');
  const dailyLimit = Math.round(Number(pick('dailyLimit')));
  const maxPerRequest = Math.round(Number(pick('maxPerRequest')));
  if (!Number.isFinite(dailyLimit) || dailyLimit < 0 || dailyLimit > 10000) throw fail('每人每天张数需在 0–10000 之间（0 = 不限）');
  if (!Number.isFinite(maxPerRequest) || maxPerRequest < 1 || maxPerRequest > 4) throw fail('单次张数需在 1–4 之间');
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
  if (enabled && !model && dialect !== 'a1111') throw fail(dialect === 'comfyui' ? '请填写 ComfyUI 的检查点（模型文件）名称，例如 sd_xl_base_1.0.safetensors' : '请填写绘画模型名称');
  return { enabled, provider, baseUrl, apiKey, model, dialect, responseFormat, sizes, defaultSize, dailyLimit, maxPerRequest, extraParams, batchMode, allowCustomSize, minSide, maxSide, sizeStep, maxPixels, workflow };
}
export const publicImageConfig = config => ({ ...config, apiKey: undefined, hasKey: Boolean(config.apiKey), keyMask: maskKey(config.apiKey) });

export const imagesEndpoint = (baseUrl, dialect = 'openai') => dialect === 'a1111'
  ? (baseUrl.endsWith('/sdapi/v1/txt2img') ? baseUrl : baseUrl.replace(/\/+$/, '') + '/sdapi/v1/txt2img')
  : (baseUrl.endsWith('/images/generations') ? baseUrl : baseUrl.replace(/\/+$/, '') + '/images/generations');
// 鉴权头：本机 SD WebUI / ComfyUI 的密钥写成 “用户名:密码” 时用 Basic（对应 --api-auth），否则用 Bearer
export function imageAuthHeaders(config, apiKey) {
  if (!apiKey) return {};
  if ((config.dialect === 'a1111' || config.dialect === 'comfyui') && apiKey.includes(':')) return { Authorization: 'Basic ' + Buffer.from(apiKey).toString('base64') };
  return { Authorization: 'Bearer ' + apiKey };
}

// 校验用户请求，返回清洗后的参数
export function cleanImageRequest(config, body = {}) {
  const fail = message => Object.assign(new Error(message), { status: 400 });
  const prompt = String(body.prompt ?? '').trim();
  if (!prompt) throw fail('请输入要画的内容');
  if (prompt.length > LIMITS.promptMax) throw fail(`描述不能超过 ${LIMITS.promptMax} 个字符`);
  const size = String(body.size || config.defaultSize || config.sizes[0]).toLowerCase();
  if (!config.sizes.includes(size)) {
    const m = size.match(/^(\d{2,4})x(\d{2,4})$/);
    if (!config.allowCustomSize || !m) throw fail('不支持这个尺寸，可选：' + config.sizes.join('、') + (config.allowCustomSize ? '，或自定义“宽x高”' : ''));
    const w = Number(m[1]), h = Number(m[2]);
    if (w < config.minSide || w > config.maxSide || h < config.minSide || h > config.maxSide) throw fail(`自定义尺寸的每条边需在 ${config.minSide}–${config.maxSide} 之间`);
    if (w % config.sizeStep || h % config.sizeStep) throw fail(`宽和高都需要是 ${config.sizeStep} 的倍数`);
    if (w * h > config.maxPixels) throw fail(`总像素不能超过 ${config.maxPixels}（约 ${Math.floor(Math.sqrt(config.maxPixels))}×${Math.floor(Math.sqrt(config.maxPixels))}）`);
  }
  const n = Math.round(Number(body.n ?? 1));
  if (!Number.isFinite(n) || n < 1) throw fail('张数无效');
  if (n > config.maxPerRequest) throw fail(`单次最多 ${config.maxPerRequest} 张`);
  const negative = String(body.negative ?? '').trim().slice(0, 500);
  return { prompt, size, n, negative };
}

export function buildImageRequest(config, { prompt, size, n, negative }) {
  const extra = config.extraParams || {};
  if (config.dialect === 'a1111') {
    const [width, height] = size.split('x').map(Number);
    return { prompt, negative_prompt: negative || '', width, height, batch_size: n, n_iter: 1, ...(config.model ? { override_settings: { sd_model_checkpoint: config.model } } : {}), ...extra };
  }
  let payload;
  if (config.dialect === 'siliconflow') {
    payload = { model: config.model, prompt, image_size: size, batch_size: n, ...(negative ? { negative_prompt: negative } : {}) };
  } else {
    payload = { model: config.model, prompt: negative ? `${prompt}\n\n避免出现：${negative}` : prompt, n, size, ...(config.responseFormat ? { response_format: config.responseFormat } : {}) };
  }
  return { ...payload, ...extra, model: config.model };
}

// 兼容 data[] / images[] / output.results[]，每项可能是 b64_json 或 url
export function parseImageResponse(data) {
  const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.images) ? data.images : Array.isArray(data?.output?.results) ? data.output.results : [];
  const out = [];
  for (const item of list) {
    if (typeof item === 'string') { out.push(/^https?:\/\//.test(item) ? { url: item } : { b64: item }); continue; }
    const b64 = item?.b64_json ?? item?.b64 ?? item?.image_base64;
    if (typeof b64 === 'string' && b64) out.push({ b64: b64.replace(/^data:[^,]+,/, ''), revised: item.revised_prompt });
    else if (typeof item?.url === 'string' && item.url) out.push({ url: item.url, revised: item.revised_prompt });
  }
  return out;
}

// 只接受真正的图片内容（看文件头，不信任上游声明的类型）
export function sniffImage(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer.toString('latin1', 1, 4) === 'PNG') return { mime: 'image/png', ext: 'png' };
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (buffer.toString('latin1', 0, 3) === 'GIF') return { mime: 'image/gif', ext: 'gif' };
  return null;
}

// 结果图片地址的安全检查：只允许 http(s)；不允许内网/本机/链路本地，除非和服务商地址同主机（自建网关场景）。
export function safeResultUrl(value, baseUrl = '') {
  let url; try { url = new URL(String(value)); } catch { throw Object.assign(new Error('上游返回了无效的图片地址'), { status: 502 }); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw Object.assign(new Error('上游返回了不支持的图片地址'), { status: 502 });
  if (url.username || url.password) throw Object.assign(new Error('上游返回了不安全的图片地址'), { status: 502 });
  let sameHost = false; try { sameHost = new URL(baseUrl).host === url.host; } catch { /* 无 baseUrl */ }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  const privateV4 = m && (m[1] === '10' || m[1] === '127' || m[1] === '0' || (m[1] === '169' && m[2] === '254') || (m[1] === '172' && +m[2] >= 16 && +m[2] <= 31) || (m[1] === '192' && m[2] === '168'));
  const linkLocal = m && m[1] === '169' && m[2] === '254';
  const privateName = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local') || host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd');
  if (linkLocal) throw Object.assign(new Error('不允许下载链路本地地址的图片'), { status: 502 });
  if ((privateV4 || privateName) && !sameHost) throw Object.assign(new Error('不允许从内网地址下载图片'), { status: 502 });
  if (url.protocol === 'http:' && !sameHost) throw Object.assign(new Error('图片地址必须是 https'), { status: 502 });
  return url;
}

// ---------- ComfyUI ----------
// 默认的文生图工作流（API 格式）。占位符：{{model}} 检查点文件名、{{prompt}}、{{negative}}、{{width}}、{{height}}、{{batch}}、{{seed}}。
export const DEFAULT_COMFY_WORKFLOW = {
  3: { class_type: 'KSampler', inputs: { seed: '{{seed}}', steps: 25, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
  4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: '{{model}}' } },
  5: { class_type: 'EmptyLatentImage', inputs: { width: '{{width}}', height: '{{height}}', batch_size: '{{batch}}' } },
  6: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}', clip: ['4', 1] } },
  7: { class_type: 'CLIPTextEncode', inputs: { text: '{{negative}}', clip: ['4', 1] } },
  8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
  9: { class_type: 'SaveImage', inputs: { filename_prefix: 'yumeiro', images: ['8', 0] } }
};
// 把占位符替换成真实值。整串等于 {{width}}/{{height}}/{{batch}}/{{seed}} 的换成数字；其余字符串里的 {{prompt}} 等做文本替换（在解析后的对象上做，所以不会破坏 JSON）。
export function buildComfyWorkflow(templateText, { prompt, negative = '', width, height, n = 1, model = '', seed = Math.floor(Math.random() * 2 ** 32) }) {
  const template = templateText && String(templateText).trim() ? JSON.parse(templateText) : DEFAULT_COMFY_WORKFLOW;
  const numbers = { '{{width}}': width, '{{height}}': height, '{{batch}}': n, '{{seed}}': seed };
  const walk = value => {
    if (typeof value === 'string') {
      if (value in numbers) return numbers[value];
      return value.split('{{prompt}}').join(prompt).split('{{negative}}').join(negative).split('{{model}}').join(model);
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    return value;
  };
  return walk(template);
}
// 从 /history/<id> 的结果里取出输出图片的引用；还没跑完返回 null，出错抛异常
export function comfyImageRefs(history, promptId) {
  const entry = history?.[promptId];
  if (!entry) return null;
  if (entry.status?.status_str === 'error') {
    const message = (entry.status.messages || []).find(m => m[0] === 'execution_error')?.[1]?.exception_message;
    throw Object.assign(new Error('ComfyUI 执行出错' + (message ? '：' + String(message).slice(0, 200) : '')), { status: 502 });
  }
  const refs = [];
  for (const node of Object.values(entry.outputs || {})) for (const image of node.images || []) if (image.type === 'output' || image.type === undefined) refs.push({ filename: String(image.filename), subfolder: String(image.subfolder || ''), type: 'output' });
  return refs.length || entry.status?.completed ? refs : null;
}
