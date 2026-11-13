'use strict';
// A private persistent Gateway connection. Audio and credentials never enter argv.
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const MAX_LINE = 96 * 1024, MAX_OUTPUT = 1024 * 1024;
const FIELDS = {
  'sessions.describe':['key','agentId'], 'talk.catalog':['sessionKey'],
  'talk.session.create':['sessionKey','mode','transport','brain'],
  'talk.session.appendAudio':['sessionId','audioBase64'],
  'talk.session.close':['sessionId','discard','disposition'],
  'talk.session.acknowledgeMark':['sessionId','markName'],
  'talk.client.toolCall':['sessionKey','relaySessionId','callId','name','args'],
  'talk.session.steer':['sessionId','sessionKey','text','mode'],
  'talk.session.submitToolResult':['sessionId','callId','result','options'],
  'agent.wait':['runId','timeoutMs'],
};
const object = x => x && typeof x === 'object' && !Array.isArray(x);
const id = x => typeof x === 'string' && x.length > 0 && x.length <= 1024 && !/[\x00-\x1f\x7f]/u.test(x);
const base64 = x => typeof x === 'string' && x.length > 0 && x.length <= 65536 && x.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(x);
function validateRequest(r) {
  if (!object(r) || Object.keys(r).some(k=>!['id','method','params'].includes(k)) || !Number.isSafeInteger(r.id) || r.id < 1 || !FIELDS[r.method] || !object(r.params)) return false;
  const p=r.params;if(Object.keys(p).some(k=>!FIELDS[r.method].includes(k)))return false;
  switch(r.method) {
    case 'sessions.describe':return id(p.key)&&id(p.agentId);
    case 'talk.catalog':return id(p.sessionKey);
    case 'talk.session.create':return id(p.sessionKey)&&p.transport==='gateway-relay'&&
      (p.mode==='transcription'&&p.brain==='none'||p.mode==='realtime'&&p.brain==='agent-consult');
    case 'talk.session.appendAudio':return id(p.sessionId)&&base64(p.audioBase64);
    case 'talk.session.close':return id(p.sessionId)&&(p.discard===undefined||typeof p.discard==='boolean')&&
      (p.disposition===undefined||['abort','detach'].includes(p.disposition))&&!(p.discard!==undefined&&p.disposition!==undefined);
    case 'talk.session.acknowledgeMark':return id(p.sessionId)&&id(p.markName);
    case 'talk.client.toolCall':return id(p.sessionKey)&&id(p.relaySessionId)&&id(p.callId)&&p.name==='openclaw_agent_consult'&&object(p.args)&&JSON.stringify(p.args).length<=16384;
    case 'talk.session.steer':return id(p.sessionId)&&id(p.sessionKey)&&typeof p.text==='string'&&p.text.trim().length>0&&p.text.length<=8192&&
      (p.mode===undefined||['status','steer','cancel','followup'].includes(p.mode));
    case 'talk.session.submitToolResult':return id(p.sessionId)&&id(p.callId)&&object(p.result)&&JSON.stringify(p.result).length<=40000&&
      (p.options===undefined||object(p.options)&&Object.keys(p.options).length===1&&p.options.willContinue===true);
    case 'agent.wait':return id(p.runId)&&p.timeoutMs===120000;
    default:return false;
  }
}
const errorCode = e => /^[A-Z_]{1,80}$/u.test(e?.gatewayCode??e?.code??'')?(e.gatewayCode??e.code):'CONNECTION';
function projectChat(p) {
  if(!object(p)||!id(p.runId)||!['final','error','aborted'].includes(p.state))return null;
  const m=p.message;const text=typeof m?.text==='string'?m.text:Array.isArray(m?.content)?m.content.filter(x=>x?.type==='text'&&typeof x.text==='string').map(x=>x.text).join('\n\n'):'';
  return {runId:p.runId,state:p.state,sessionKey:p.sessionKey,agentId:p.agentId,message:{text:text.slice(0,32768)}};
}
async function run() {
  // Direct SDK clients must not turn an agent-owned shell into operator authority.
  if(process.env.OPENCLAW_SHELL!==undefined||process.env.OPENCLAW_SUBAGENT_EXEC!==undefined)throw new Error('Agent execution context');
  const [expectUrl,...extra]=process.argv.slice(2);
  if(extra.length||!/^ws:\/\/127\.0\.0\.1:\d{1,5}$/u.test(expectUrl||''))throw new Error('Invalid voice target');
  const installed=createRequire('/opt/homebrew/lib/node_modules/openclaw/package.json');
  const sdk=name=>import(pathToFileURL(installed.resolve(`openclaw/plugin-sdk/${name}`)).href);
  const [{GatewayClient},{readConfigFileSnapshot},{resolveConfiguredSecretInputString}]=await Promise.all([sdk('gateway-runtime'),sdk('health'),sdk('secret-input-runtime')]);
  const snapshot=await readConfigFileSnapshot({observe:false,isolateEnv:true,recoverSuspicious:false,pluginValidation:'core-only'});
  const config=snapshot.runtimeConfig??snapshot.config,g=config?.gateway,port=g?.port??18789;
  if(!snapshot.valid||g?.mode!=='local'||g.bind!=='loopback'||g.tls?.enabled||!Number.isInteger(port)||port<1||port>65535||
    expectUrl!==`ws://127.0.0.1:${port}`||!['token','password'].includes(g.auth?.mode))throw new Error('Unsupported voice target');
  const authName=g.auth.mode;
  const auth=await resolveConfiguredSecretInputString({config,env:process.env,value:g.auth[authName],path:`gateway.auth.${authName}`,unresolvedReasonStyle:'generic'});
  if(auth.unresolvedRefReason||!auth.value)throw new Error('Authentication unavailable');
  let stopped=false,ready=false,active=0,client;
  const send=m=>{if(stopped)return;const line=JSON.stringify(m)+'\n';if(Buffer.byteLength(line)>MAX_OUTPUT||process.stdout.writableLength+Buffer.byteLength(line)>MAX_OUTPUT){stop();return;}process.stdout.write(line);};
  function stop(){if(stopped)return;stopped=true;clearTimeout(timer);client?.stop();process.stdin.pause();process.stdout.end(()=>process.exit(0));setTimeout(()=>process.exit(0),500).unref();}
  const timer=setTimeout(()=>{send({kind:'status',status:'disconnected',code:'TIMEOUT'});stop();},15000);
  client=new GatewayClient({url:expectUrl,[authName]:auth.value,deviceIdentity:null,sharedStateMode:'read-only',clientName:'gateway-client',
    clientDisplayName:'OpenClaw+ voice',mode:'backend',role:'operator',scopes:['operator.read','operator.write','operator.talk'],requestTimeoutMs:20000,
    onHelloOk:hello=>{const methods=hello?.features?.methods;if(!Array.isArray(methods)||!['sessions.describe','talk.catalog'].every(m=>methods.includes(m))){send({kind:'status',status:'disconnected',code:'UNSUPPORTED'});stop();return;}
      ready=true;clearTimeout(timer);send({kind:'status',status:'ready',methods:methods.filter(m=>FIELDS[m]),capabilities:(hello.features.capabilities??[]).filter(c=>c==='talk-session-close-disposition')});},
    onEvent:frame=>{if(frame.event==='talk.event')send({kind:'event',event:frame.event,payload:frame.payload});else if(frame.event==='chat'){const p=projectChat(frame.payload);if(p)send({kind:'event',event:'chat',payload:p});}},
    onGap:()=>{send({kind:'status',status:'disconnected',code:'GAP'});stop();},
    onConnectError:e=>{send({kind:'status',status:'disconnected',code:errorCode(e)});stop();},
    onClose:()=>{ready=false;send({kind:'status',status:'disconnected',code:'CONNECTION'});stop();},
    hostDeps:{logDebug:()=>{},logError:()=>{}},
  });
  let input='';process.stdin.setEncoding('utf8');
  process.stdin.on('data',chunk=>{input+=chunk;if(Buffer.byteLength(input)>MAX_LINE){stop();return;}let split;
    while((split=input.indexOf('\n'))>=0){const line=input.slice(0,split);input=input.slice(split+1);let r;try{r=JSON.parse(line);}catch{stop();return;}
      if(!validateRequest(r)||!ready||++active>32){stop();return;}
      Promise.resolve().then(()=>client.request(r.method,r.params,{timeoutMs:r.method==='agent.wait'?125000:r.method==='talk.session.close'?130000:20000}))
        .then(result=>{const data=r.method==='sessions.describe'?{session:result?.session?{key:result.session.key,agentId:result.session.agentId,sessionId:result.session.sessionId,lifecycleRevision:result.session.lifecycleRevision}:null}:result;send({kind:'reply',id:r.id,ok:true,data});},e=>send({kind:'reply',id:r.id,ok:false,error:{code:errorCode(e)}})).finally(()=>active--);
    }
  });
  process.stdin.on('end',stop);process.stdin.on('error',stop);process.on('SIGTERM',stop);process.on('SIGINT',stop);client.start();
}
if(require.main===module)run().catch(()=>{process.stdout.write(JSON.stringify({kind:'status',status:'disconnected',code:'CONFIG'})+'\n');process.exitCode=1;});
module.exports={validateRequest,projectChat,MAX_LINE,MAX_OUTPUT};
