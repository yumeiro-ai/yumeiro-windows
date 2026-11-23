// 把 public/ 里的桌宠代码和素材同步到 Windows 客户端目录（修改了 public/pet.js 或重新生成素材后运行）。
// 运行：node scripts/sync-clients.mjs
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'clients', 'windows', 'pet');
mkdirSync(target, { recursive: true });
copyFileSync(path.join(root, 'public', 'pet.js'), path.join(target, 'pet.js'));
copyFileSync(path.join(root, 'public', 'pet-sense.js'), path.join(target, 'pet-sense.js'));   // 客户端自己的主界面（app.html）里的桌宠要用它理解对话情绪
for (const name of ['idle', 'blink', 'happy', 'sleepy', 'walk1', 'walk2', 'walk3', 'walk4', 'peek', 'sit', 'angry1', 'angry2', 'sad1', 'sad2', 'laugh1', 'laugh2', 'surprised', 'shy']) copyFileSync(path.join(root, 'public', 'pet', name + '.png'), path.join(target, name + '.png'));
// 远程被控端程序：客户端自带一份，设置里一开就能用（不用另外装 Node.js）
mkdirSync(path.join(root, 'clients', 'windows', 'agent'), { recursive: true });
copyFileSync(path.join(root, 'public', 'agent.mjs'), path.join(root, 'clients', 'windows', 'agent', 'agent.mjs'));
console.log('已同步到 clients/windows/pet 和 clients/windows/agent');
