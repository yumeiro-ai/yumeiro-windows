// 聊天里上传的“文件”（不只是照片）：目前支持文本类文件，内容会随消息一起交给模型。
// PDF / Word / Excel 这类二进制格式没有内置解析（项目不带额外依赖），请先另存为 txt / md / csv 再上传。
// 单个文件的大小上限跟图片共用管理员在“图片理解”里设的“单张上限（MB）”（默认 8，最大 20）；下面的 maxBytes 只是没传配置时的默认值。
// maxCharsPerFile / maxCharsTotal 是“交给模型的文字量”上限（超出部分会在提示里说明已省略），要跟模型的上下文长度匹配：可用环境变量 DOC_MAX_CHARS / DOC_MAX_TOTAL_CHARS 调整。
export const DOC_LIMITS = { maxBytes: 8 * 1024 * 1024, maxFiles: 5, maxCharsPerFile: 100000, maxCharsTotal: 200000 };

export const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'log', 'xml', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'properties',
  'html', 'htm', 'css', 'scss', 'less', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte',
  'py', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'go', 'rs', 'rb', 'php', 'lua', 'r', 'sql', 'sh', 'bash', 'bat', 'ps1',
  'tex', 'srt', 'vtt', 'diff', 'patch', 'gradle', 'dockerfile', 'makefile'
]);
export const DOC_EXT_LABEL = 'txt / md / csv / json / 代码等文本文件';

const BACKSLASH = String.fromCharCode(92);
const extOf = name => {
  const base = String(name || '').split('/').pop().split(BACKSLASH).pop().toLowerCase();
  if (base === 'dockerfile' || base === 'makefile') return base;
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1) : '';
};

// 判断是不是可接受的文本文件：扩展名在白名单里，且内容是合法 UTF-8、没有 NUL 字节、不超过大小上限
export function docKind(name, buffer, maxBytes = DOC_LIMITS.maxBytes) {
  const ext = extOf(name);
  if (!TEXT_EXTS.has(ext)) return null;
  if (!buffer || !buffer.length || buffer.length > maxBytes) return null;
  if (buffer.includes(0)) return null;
  try { new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { return null; }
  return { ext, mime: 'text/plain; charset=utf-8' };
}

export function docText(buffer, maxChars = DOC_LIMITS.maxCharsPerFile) {
  let text = new TextDecoder('utf-8').decode(buffer);
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…（文件太长，后面的内容已省略）';
  return text;
}

// 拼进发给模型的消息：每个文件一段，用围栏包起来（文件里自带 ``` 时换成更长的围栏）
export function docsPrompt(message, files, maxTotal = DOC_LIMITS.maxCharsTotal) {
  let left = maxTotal;
  const blocks = [];
  for (const file of files) {
    const text = left > 0 ? (file.text.length > left ? file.text.slice(0, left) + '\n…（后面的内容已省略）' : file.text) : '（总长度超出上限，这个文件的内容已省略）';
    left -= file.text.length;
    let fence = '```'; while (text.includes(fence)) fence += '`';
    blocks.push('【附件：' + file.name + '】\n' + fence + '\n' + text + '\n' + fence);
  }
  return (message ? message + '\n\n' : '') + blocks.join('\n\n');
}
