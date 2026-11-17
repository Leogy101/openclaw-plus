#!/opt/homebrew/bin/node
'use strict';
// Endpoint-pinned transport for GCB's existing GatewayTransport. No model logic,
// credentials, retries, fallback routing or configuration writes live here.
const path = require('node:path');
const { execFile } = require('node:child_process');
const NODE = '/opt/homebrew/bin/node';
const CLI = '/opt/homebrew/lib/node_modules/openclaw/openclaw.mjs';
function command(argv, env) {
  const [gateway,call,method,jsonFlag,paramsFlag,params,timeoutFlag,timeout,...extra]=argv;
  const url=env.OPENCLAW_PLUS_GCB_EXPECT_URL;
  if(gateway!=='gateway'||call!=='call'||!['gcb.profile.complete','gcb.profile.cancel'].includes(method)||
    jsonFlag!=='--json'||paramsFlag!=='--params'||timeoutFlag!=='--timeout'||extra.length||
    typeof params!=='string'||Buffer.byteLength(params)>65536||!/^\d{1,5}$/.test(timeout||'')||Number(timeout)<1||Number(timeout)>60000||
    !/^ws:\/\/127\.0\.0\.1:\d{1,5}$/.test(url||'')||!path.isAbsolute(env.OPENCLAW_CONFIG_PATH||'')||!path.isAbsolute(env.HOME||'')||
    env.OPENCLAW_SHELL!==undefined||env.OPENCLAW_SUBAGENT_EXEC!==undefined)throw new Error('Invalid native profiling transport');
  const port=Number(new URL(url).port);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid native endpoint');
  const body=JSON.parse(params);
  if(!body||typeof body!=='object'||Array.isArray(body))throw new Error('Invalid native parameters');
  return {args:[CLI,...argv,'--expect-url',url],timeout:Number(timeout)+2000,
    env:{HOME:env.HOME,OPENCLAW_CONFIG_PATH:env.OPENCLAW_CONFIG_PATH,PATH:'/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      LANG:'en_US.UTF-8',NO_COLOR:'1',TERM:'dumb'}};
}
function run(argv, env, execute=execFile) {
  const request=command(argv,env);
  let child;
  const promise=new Promise((resolve,reject)=>{
    child=execute(NODE,request.args,{env:request.env,shell:false,encoding:'utf8',maxBuffer:131072,timeout:request.timeout},(error,stdout)=>{
      if(error)return reject(new Error('Native profiling transport unavailable'));
      try {const value=JSON.parse(stdout);if(!value||typeof value!=='object')throw new Error();resolve(value);}
      catch {reject(new Error('Native profiling transport unavailable'));}
    });
  });
  return {promise,cancel:()=>child?.kill('SIGTERM')};
}
if(require.main===module) {
  try {
    const task=run(process.argv.slice(2),process.env);
    process.once('SIGTERM',task.cancel);process.once('SIGINT',task.cancel);
    task.promise.then(result=>process.stdout.write(JSON.stringify(result)+'\n'),()=>{process.stderr.write('{"error":"native_profile_transport_unavailable"}\n');process.exitCode=1;});
  } catch {process.stderr.write('{"error":"native_profile_transport_rejected"}\n');process.exitCode=1;}
}
module.exports={command,run};
