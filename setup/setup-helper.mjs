#!/usr/bin/env node
import http from 'node:http';
import { readFile,rm,writeFile,mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { verifySignedUpdateZip, extractUpdateZip, sha256OfFile, sameHash, compareVersions } from '../updatepkg.mjs';
const socket=process.env.SETUP_HELPER_SOCKET||'/run/yumeiro/setup-helper.sock';
const tokenFile=process.env.SETUP_HELPER_TOKEN_FILE||'/etc/yumeiro/secrets/setup_helper_token';
const appDir=process.env.YUMEIRO_APP_DIR||'/cindy/Yumeiro',dataDir=process.env.DATA_DIR||'/var/lib/yumeiro';
const configDir=process.env.YUMEIRO_CONFIG_DIR||'/etc/yumeiro',envFile=process.env.YUMEIRO_ENV_FILE||path.join(configDir,'yumeiro.env'),secretDir=process.env.YUMEIRO_SECRET_DIR||path.join(configDir,'secrets');
const stagingDir=process.env.YUMEIRO_CLIENT_STAGING||'/var/lib/yumeiro-client-staging';
const allowed=new Set(['install_node','install_build_tools','install_runner','install_engine','install_clients','install_cindy_desktop','configure_installation','test_postgres','service_health','apply_update','update_status']);
const updateDir=process.env.YUMEIRO_UPLOAD_DIR||path.join(dataDir,'updates'),workRoot=process.env.YUMEIRO_UPDATE_WORK||'/var/lib/yumeiro-update',statusFile=path.join(workRoot,'status.json');
const bad=message=>Object.assign(new Error(message),{expose:true});
const pidAlive=pid=>{try{process.kill(pid,0);return true}catch(error){return error.code==='EPERM'}};
const readStatus=async()=>{
  let s;try{s=JSON.parse(await readFile(statusFile,'utf8'))}catch{return {state:'idle'}}
  // “运行中”但升级进程已经不在了（例如助手/服务器在更新中途被重启，进程被一起杀掉）：不能永远卡在“正在更新”，改成“已中断”
  if(s.state==='running'){
    const age=Date.now()-(Number(s.startedAt)||0);
    const dead=s.pid?!pidAlive(s.pid):age>10*60*1000;
    if(dead||age>60*60*1000){
      let tail='';try{tail=(await readFile(path.join(workRoot,'update.log'),'utf8')).slice(-2000)}catch{}
      s={...s,state:'failed',interrupted:true,finishedAt:Date.now(),log:'更新进程在中途停止了（可能是服务器或更新助手在更新过程中被重启）。服务可能处于停止状态：请在服务器上执行 systemctl start yumeiro，再重新更新。\n\n'+tail};
      await writeStatus(s).catch(()=>{});
    }
  }
  return s;
};
const writeStatus=async value=>{await mkdir(workRoot,{recursive:true,mode:0o700});await writeFile(statusFile,JSON.stringify(value),{mode:0o600})};

const registryMap={default:'',cn:'https://registry.npmmirror.com'},enginePackages={claude:'@anthropic-ai/claude-code',codex:'@openai/codex',pi:'@mariozechner/pi-coding-agent'};
let token='';try{token=(await readFile(tokenFile,'utf8')).trim()}catch{}if(!token){console.error('setup helper token missing');process.exit(1)}if(process.getuid?.()!==0){console.error('setup helper requires root');process.exit(1)}
const run=(file,args,env={})=>new Promise((resolve,reject)=>{const child=spawn(file,args,{cwd:appDir,env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/var/cache/yumeiro-setup',npm_config_cache:'/var/cache/yumeiro-setup/npm',...env},stdio:['ignore','pipe','pipe']});let done=false,out='';const keep=c=>{out=(out+c).slice(-3000)};child.stdout.on('data',keep);child.stderr.on('data',keep);const finish=(error,code)=>{if(done)return;done=true;if(error)return reject(error);if(code===0)return resolve();console.error('operation failed: '+file+' '+args.join(' ')+' exit='+code+'\n'+out);reject(new Error('operation failed'))};child.on('error',finish);child.on('close',code=>finish(null,code))});
async function action(body){
  const {action,options={}}=body;if(!allowed.has(action)||typeof body.jobId!=='string'||body.jobId.length<10)throw new Error('invalid operation');
  if(Object.keys(options).some(k=>!['registry','engine','config','update'].includes(k))||!['default','cn'].includes(options.registry||'default'))throw new Error('invalid options');
  if(action==='install_engine'&&!enginePackages[options.engine])throw new Error('invalid engine');
  if(action==='test_postgres'){const c=options.config||{};if(!/^postgres(?:ql)?:\/\//i.test(String(c.pgUrl||'')))throw new Error('invalid postgres configuration');const {default:pg}=await import('pg');const pool=new pg.Pool({connectionString:c.pgUrl,connectionTimeoutMillis:8000,max:1});try{await pool.query('SELECT 1')}finally{await pool.end().catch(()=>{})}return {message:'PostgreSQL 连接测试通过'}}
  if(action==='configure_installation'){const c=options.config;if(!c||!Number.isInteger(c.port)||c.port<1024||c.port>65535||!['proxy','http','https'].includes(c.transport)||!['json','postgres'].includes(c.storage))throw new Error('invalid configuration');if(c.storage==='postgres'&&!/^postgres(?:ql)?:\/\//i.test(String(c.pgUrl||'')))throw new Error('invalid postgres configuration');await mkdir(secretDir,{recursive:true,mode:0o750});if(c.modelKey)await writeFile(path.join(secretDir,'model_api_key'),c.modelKey,{mode:0o640});const lines=['# setup wizard generated configuration','PORT='+c.port,'HOST='+(c.transport==='proxy'?'127.0.0.1':'0.0.0.0'),'COOKIE_SECURE='+(c.transport==='http'?'false':'true'),'TRUST_PROXY='+(c.transport==='proxy'?'true':'false'),'STORAGE='+c.storage];if(c.domain)lines.push('DOMAIN='+c.domain);if(c.storage==='postgres')lines.push('DATABASE_URL='+c.pgUrl);if(c.modelUrl)lines.push('MODEL_BASE_URL='+c.modelUrl);if(c.modelName)lines.push('MODEL_NAME='+c.modelName);if(c.modelKey)lines.push('MODEL_API_KEY_FILE='+path.join(secretDir,'model_api_key'));const managed=new Set(['PORT','HOST','COOKIE_SECURE','TRUST_PROXY','STORAGE','DOMAIN','DATABASE_URL','MODEL_BASE_URL','MODEL_NAME','MODEL_API_KEY_FILE']);let old='';try{old=await readFile(envFile,'utf8')}catch{}const kept=old.split('\n').filter(l=>{const m=/^\s*([A-Z0-9_]+)=/.exec(l);return l!==lines[0]&&!(m&&managed.has(m[1]))});while(kept.length&&!kept[kept.length-1].trim())kept.pop();await writeFile(envFile,kept.concat(lines).join('\n')+'\n',{mode:0o640});return {message:'初始化配置已保存'}}
  if(action==='install_cindy_desktop'){const c=options.config||{};if(!['global','cn'].includes(c.desktopRegion)||c.desktopVersion!=='latest')throw new Error('invalid desktop selection');if(!existsSync('/usr/bin/docker')&&!existsSync('/usr/local/bin/docker'))throw new Error('当前环境没有 Docker，无法安装 Cindy 桌面容器');await run('/usr/bin/bash',[path.join(appDir,'scripts/desktop-setup.sh'),c.desktopRegion,c.desktopVersion]);return {message:'Cindy 桌面容器已启动'}}
  if(action==='update_status'){const st=await readStatus();if(st.state==='running'){try{st.log=(await readFile(path.join(workRoot,'update.log'),'utf8')).slice(-1500)}catch{}}return {message:'ok',details:st}}
  if(action==='apply_update'){
    // 管理员在网页上传的发布包：重新计算校验值、确认是 Yumeiro 的发布包、版本更新，再用和命令行 update 完全相同的脚本升级（先备份，起不来自动回滚）
    const u=options.update||{};
    if(!/^incoming-[0-9a-f-]{36}\.zip$/.test(String(u.file||''))||!/^[0-9a-f]{64}$/.test(String(u.sha256||'')))throw bad('更新请求无效');
    if((await readStatus()).state==='running')throw bad('已有更新在进行');
    const zip=path.join(updateDir,u.file);
    if(!sameHash(await sha256OfFile(zip),u.sha256))throw bad('文件在上传后被改动过，已拒绝');
    let info;try{info=await verifySignedUpdateZip(zip)}catch(error){throw bad(error.message)} // 签名由助手自己再验一次，不信任网页进程
    let current='0.0.0';try{current=JSON.parse(await readFile(path.join(appDir,'package.json'),'utf8')).version}catch{}
    if(compareVersions(info.version,current)<=0&&u.allowDowngrade!==true)throw bad('新版本不高于当前版本；如确需降级，请勾选“允许降级”');
    const work=path.join(workRoot,'job-'+Date.now());await mkdir(work,{recursive:true,mode:0o700});
    const out=await extractUpdateZip(zip,work,info.root);await rm(zip,{force:true});
    const logFile=path.join(workRoot,'update.log');
    await writeStatus({state:'running',from:current,version:info.version,startedAt:Date.now()});
    const {openSync}=await import('node:fs'),fd=openSync(logFile,'w',0o600);
    const child=spawn('/usr/bin/bash',[path.join(out.dir,'deploy/yumeiro-native.sh'),'update'],{cwd:out.dir,env:{PATH:'/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',HOME:'/root',LANG:'C.UTF-8'},stdio:['ignore',fd,fd],detached:true});
    await writeStatus({state:'running',from:current,version:info.version,startedAt:Date.now(),pid:child.pid});
    child.on('close',async code=>{
      let tail='';try{tail=(await readFile(logFile,'utf8')).slice(-3000)}catch{}
      await writeStatus({state:code===0?'ok':'failed',from:current,version:info.version,exitCode:code,finishedAt:Date.now(),log:tail}).catch(()=>{});
      await rm(work,{recursive:true,force:true}).catch(()=>{});
      if(code===0)spawn('/usr/bin/systemctl',['restart','--no-block','yumeiro-setup-helper.service'],{stdio:'ignore',detached:true}).unref(); // 让助手自己也换成新版本代码
    });
    return {message:'更新已开始',details:{version:info.version,from:current}};
  }
  if(action==='service_health'){await run('/usr/bin/systemctl',['is-active','--quiet','yumeiro.service']);return {message:'服务运行正常'}}
  if(action==='install_node'){if(Number(process.versions.node.split('.')[0])<22)throw new Error('Node.js 22+ required');return {message:'Node.js 已就绪',details:{version:process.versions.node}}}
  if(action==='install_build_tools'){if(existsSync('/usr/bin/apt-get'))await run('/usr/bin/apt-get',['-y','install','build-essential']);else if(existsSync('/usr/bin/dnf'))await run('/usr/bin/dnf',['-y','groupinstall','Development Tools']);else if(existsSync('/usr/bin/yum'))await run('/usr/bin/yum',['-y','groupinstall','Development Tools']);else throw new Error('unsupported package manager');return {message:'编译工具已安装'}}
  if(action==='install_engine'){const args=['install','-g','--prefix','/opt/yumeiro-engines'];if(options.registry==='cn')args.push('--registry',registryMap.cn);args.push(enginePackages[options.engine]+'@latest');await run(existsSync('/usr/local/bin/npm')?'/usr/local/bin/npm':'/usr/bin/npm',args);await run('/usr/bin/chmod',['-R','a+rX','/opt/yumeiro-engines']);return {message:options.engine+' 已安装'}}
  if(action==='install_runner'){await run('/usr/bin/systemctl',['daemon-reload']);await run('/usr/bin/systemctl',['enable','--now','yumeiro-runner.service']);return {message:'runner 已启动'}}
  if(action==='install_clients'){if(!existsSync(stagingDir))return {message:'没有检测到客户端安装包，已跳过'};await run('/usr/local/bin/node',[path.join(appDir,'scripts/install-clients.mjs'),stagingDir,'--prune'],{DATA_DIR:dataDir});return {message:'客户端安装包已发布'}}
  throw new Error('unsupported');
}
const server=http.createServer(async(req,res)=>{if(req.method!=='POST'||req.url!=='/')return res.writeHead(404).end();if(String(req.headers.authorization||'')!=='Bearer '+token)return res.writeHead(403).end();let text='';for await(const chunk of req){text+=chunk;if(text.length>32768)return res.writeHead(413).end()}let body;try{body=JSON.parse(text)}catch{return res.writeHead(400).end()}try{const result=await action(body);res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({ok:true,...result}))}catch(error){res.writeHead(500,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({ok:false,expose:Boolean(error?.expose),error:error?.expose?error.message:'operation failed'}))}});
await rm(socket,{force:true}).catch(()=>{});server.listen(socket,()=>console.log('setup helper listening on '+socket));
