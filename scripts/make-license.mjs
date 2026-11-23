#!/usr/bin/env node
// 签发授权密钥（只在发行方电脑上运行；私钥不要放进仓库）。
// 用法：node scripts/make-license.mjs --key E:/ym-license-keys/license-private.pem --tier pro --org 某某公司 --seats 50 --days 365
// --days 0 或不写 = 长期有效
import { readFileSync } from 'node:fs';
import { createPrivateKey, sign, randomBytes } from 'node:crypto';
import { LICENSE_PREFIX, TIERS } from '../plans.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a), []));
if (!args.key || !TIERS.some(t => t.id === args.tier)) {
  console.error('用法：--key <私钥.pem> --tier ' + TIERS.map(t => t.id).join('|') + ' [--org 名称] [--seats 数量] [--days 天数]'); process.exit(1);
}
const days = Number(args.days) || 0, now = Date.now();
const payload = { v: 1, id: randomBytes(6).toString('hex'), tier: args.tier, org: args.org || '', seats: Number(args.seats) || 0, iat: now, exp: days > 0 ? now + days * 86400000 : 0 };
const body = LICENSE_PREFIX + '.' + Buffer.from(JSON.stringify(payload)).toString('base64url');
const sig = sign(null, Buffer.from(body), createPrivateKey(readFileSync(args.key, 'utf8'))).toString('base64url');
console.log(body + '.' + sig);
console.error(`已签发：${args.tier}　${payload.org}　${days > 0 ? days + ' 天' : '长期'}　编号 ${payload.id}`);
