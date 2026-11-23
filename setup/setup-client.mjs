import http from 'node:http';
import { readFile } from 'node:fs/promises';

const socket=process.env.SETUP_HELPER_SOCKET||'/run/yumeiro/setup-helper.sock';
const helperTokenFile=process.env.SETUP_HELPER_TOKEN_FILE||'/etc/yumeiro/secrets/setup_helper_token';

export async function requestSetupHelper({action,engine,registry='default',jobId,config,update}){
  const token=(await readFile(helperTokenFile,'utf8').catch(()=>'' )).trim();
  if(!token)throw new Error('setup helper 未启用');
  if(!['install_node','install_build_tools','install_runner','install_engine','install_clients','install_cindy_desktop','configure_installation','test_postgres','service_health','apply_update','update_status'].includes(action))throw new Error('不支持的安装步骤');
  if(action==='install_engine'&&!['claude','codex','pi'].includes(engine))throw new Error('引擎选项无效');
  if(!['default','cn'].includes(registry))throw new Error('registry 选项无效');
  const body=JSON.stringify({protocol:1,jobId,action,options:{registry,...(engine?{engine}:{}),...(action==='configure_installation'||action==='install_cindy_desktop'?{config}:{}),...(action==='apply_update'?{update}:{})}});
  return await new Promise((resolve,reject)=>{
    const req=http.request({
      socketPath:socket,
      path:'/',
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'Content-Length':Buffer.byteLength(body),
        Authorization:'Bearer '+token
      }
    },res=>{
      let text='';
      res.setEncoding('utf8');
      res.on('data',chunk=>{text+=chunk});
      res.on('end',()=>{
        let data={};try{data=JSON.parse(text)}catch{}
        if(res.statusCode!==200||data.ok!==true)return reject(new Error(data.expose&&data.error?String(data.error).slice(0,200):'helper 安装步骤失败'));
        resolve({message:String(data.message||'已完成').slice(0,100),details:data.details&&typeof data.details==='object'?data.details:{}});
      });
    });
    req.setTimeout(15*60*1000,()=>req.destroy(new Error('helper 操作超时')));
    req.on('error',reject);req.end(body);
  });
}

// Docker 部署：网页更新走“更新器”容器（docker-compose.updater.yml）。线格式和原生的更新助手相同，只是传输是内部网络上的 HTTP + 令牌。
export const updaterConfigured=()=>Boolean(process.env.UPDATER_URL);
export async function requestUpdater({action,jobId,update}){
  const token=(await readFile(process.env.UPDATER_TOKEN_FILE||'/run/secrets/updater_token','utf8').catch(()=>'' )).trim();
  if(!token)throw new Error('更新器未启用（没有令牌）');
  if(!['update_status','apply_update'].includes(action))throw new Error('不支持的操作');
  const response=await fetch(process.env.UPDATER_URL,{method:'POST',redirect:'error',signal:AbortSignal.timeout(action==='apply_update'?60000:8000),headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({protocol:1,jobId,action,options:{...(action==='apply_update'?{update}:{})}})});
  const data=await response.json().catch(()=>({}));
  if(!response.ok||data.ok!==true)throw new Error(data.expose&&data.error?String(data.error).slice(0,200):'更新器没有响应');
  return {message:String(data.message||'已完成').slice(0,100),details:data.details&&typeof data.details==='object'?data.details:{}};
}
