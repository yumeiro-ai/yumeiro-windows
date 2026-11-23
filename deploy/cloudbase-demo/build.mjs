// 演示用：把 Yumeiro 服务打包成 CloudBase HTTP 云函数（不修改任何原文件）。
// 用法：node deploy/cloudbase-demo/build.mjs   → 产物在 .cloudbase-demo/yumeiro/
// 演示站是公开体验站：DEMO_MODE=1 时登录页显示演示账号（管理员 + 成员，密码见 demo.mjs 里的默认值），
// 管理员可以在网页里从 GitHub 更新（装到 /tmp，实例回收后回到本次打包的版本）。
import {cpSync,mkdirSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {execSync} from 'node:child_process';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
const demoKey=randomBytes(32).toString('base64'); // 每次构建随机生成，只写入产物，不进仓库
const root=path.resolve(import.meta.dirname,'../..');
const out=path.join(root,'.cloudbase-demo','yumeiro');
rmSync(out,{recursive:true,force:true});mkdirSync(out,{recursive:true});
const dockerfile=readFileSync(path.join(root,'Dockerfile'),'utf8');
const mjs=dockerfile.match(/COPY --chown=node:node (server\.mjs[^\n]*?) \.\//)[1].split(/\s+/);
for(const f of mjs)cpSync(path.join(root,f),path.join(out,f));
for(const d of ['scripts','setup','public'])cpSync(path.join(root,d),path.join(out,d),{recursive:true,filter:s=>!/[\/]public[\/]downloads/.test(s)});
for(const f of ['package.json','package-lock.json'])cpSync(path.join(root,f),path.join(out,f));
execSync('npm ci --omit=dev --no-audit --no-fund',{cwd:out,stdio:'inherit'});
// 云函数只有 /tmp 可写；演示数据放 /tmp，实例回收后会重置。
// 循环启动：网页更新把新版本装到 /tmp/yumeiro-app 后服务会退出，这里用新代码重新拉起；新版本起不来（10 秒内退出）就删掉它，回到打包的版本。
writeFileSync(path.join(out,'scf_bootstrap'),`#!/bin/bash
BASE="$(cd "$(dirname "$0")" && pwd)"
export PORT=9000 HOST=0.0.0.0 DATA_DIR=/tmp/yumeiro-data TRUST_PROXY=1 COOKIE_SECURE=1
export ADMIN_EMAIL=admin@demo.local ADMIN_PASSWORD=Yumeiro-Demo-Admin-2026 DEMO_MEMBER_EMAIL=member@demo.local DEMO_MEMBER_PASSWORD=Yumeiro-Demo-Member-2026
export DEMO_MODE=1 DEMO_APP_DIR=/tmp/yumeiro-app DEMO_MODULES_DIR="$BASE/node_modules"
export STORE_ENCRYPTION_KEY="\${STORE_ENCRYPTION_KEY:-${demoKey}}"
mkdir -p "$DATA_DIR"
while true; do
  if [ -f /tmp/yumeiro-app/server.mjs ]; then cd /tmp/yumeiro-app; UPDATED=1; else cd "$BASE"; UPDATED=0; fi
  START=$(date +%s)
  node server.mjs
  if [ "$UPDATED" = 1 ] && [ $(( $(date +%s) - START )) -lt 10 ]; then rm -rf /tmp/yumeiro-app; fi
  sleep 1
done
`,{mode:0o755});
console.log('完成：',out,'（演示账号：admin@demo.local / member@demo.local，密码见 demo.mjs）');
