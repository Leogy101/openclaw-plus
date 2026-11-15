'use strict';
// Fixed public OpenClaw calls. Prompts, media and configuration edits stay out of argv.
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const MAX_BYTES = 18 * 1024 * 1024;
const CHECKED_SEND = 'chat.send.checked'; // Local helper operation, never a native RPC method.
const PREFLIGHT = Symbol('preflight');
const identifier = (value,max=1024) => typeof value==='string'&&value.trim().length>0&&value.length<=max&&!/[\x00-\x1f\x7f]/u.test(value);
function sessionError(code,message){const error=new Error(message);error.code=code;return error;}
function assertSession(row,input,sending=false) {
  if(!row||typeof row!=='object'||Array.isArray(row)||row.sessionId!==input.sessionId||row.agentId!==undefined&&row.agentId!==input.agentId) {
    throw sessionError('SESSION_CHANGED','This session is missing, inaccessible, or replaced. Select it again from the refreshed list.');
  }
  if(sending&&row.archived===true)throw sessionError('UNAVAILABLE','This session is archived. Restore it in OpenClaw before sending.');
  return row;
}
const FIELDS = new Map([
  ['chat.send',['sessionKey','agentId','sessionId','message','idempotencyKey','expectedLeafEntryId','attachments','replyToId']],
  ['sessions.patch',['key','agentId','expectedSessionId','expectedLifecycleRevision','model','thinkingLevel','permissionMode','expectedPermissionMode']],
  ['config.patch',['baseHash','raw','response','replacePaths']],
  ['tts.speak',['text']],
]);
function validateRequest(method, params) {
  const checked=method===CHECKED_SEND;
  if(checked)method='chat.send';
  const fields=FIELDS.get(method);
  if (!fields || !params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => !fields.includes(key))) throw new Error('Invalid private request fields');
  if(checked&&(['sessionKey','agentId','sessionId'].some(key=>!identifier(params[key]))||
      !identifier(params.idempotencyKey,128)||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(params.idempotencyKey)||
      params.expectedLeafEntryId!==null&&!identifier(params.expectedLeafEntryId)||
      typeof params.message!=='string'||Buffer.byteLength(params.message,'utf8')>16384||!params.message.trim()&&!params.attachments?.length))throw sessionError('INVALID','Invalid checked message request');
  if (method==='chat.send' && params.replyToId!==undefined && (typeof params.replyToId!=='string'||!params.replyToId.trim()||params.replyToId.trim()!==params.replyToId||params.replyToId.length>512||/[\x00-\x1f\x7f]/.test(params.replyToId))) throw new Error('Invalid question reply target');
  if (method==='tts.speak' && (typeof params.text!=='string'||!params.text.trim()||params.text.length>4000)) throw new Error('Invalid speech text');
  if (method==='sessions.patch' && (Object.hasOwn(params,'permissionMode')||Object.hasOwn(params,'expectedPermissionMode'))) {
    const modes=[null,'read-only','guarded','workspace','full'];
    if (!Object.hasOwn(params,'permissionMode')||!Object.hasOwn(params,'expectedPermissionMode')||!modes.includes(params.permissionMode)||!modes.includes(params.expectedPermissionMode)||
        Object.keys(params).some(key=>!['key','agentId','expectedSessionId','expectedLifecycleRevision','permissionMode','expectedPermissionMode'].includes(key))||
        ['key','agentId','expectedSessionId',...(Object.hasOwn(params,'expectedLifecycleRevision')?['expectedLifecycleRevision']:[])].some(key=>typeof params[key]!=='string'||!params[key].trim()||params[key].length>1024||/[\x00-\x1f\x7f]/.test(params[key]))) throw new Error('Invalid permission change');
    return params.permissionMode==='full'?['operator.admin']:['operator.write'];
  }
  // Admin authority is limited to the configuration call. Model changes remain session-only.
  return method === 'config.patch' ? ['operator.admin'] : method === 'tts.speak' ? ['operator.write'] : ['operator.read','operator.write'];
}
async function executeRequest(method, expectUrl, params, loadGateway) {
  const checked=method===CHECKED_SEND;
  let callGatewayFromCli,scopes;
  try {
    if(!/^ws:\/\/127\.0\.0\.1:\d{1,5}$/.test(expectUrl||''))throw sessionError('INVALID','Invalid local endpoint');
    scopes=validateRequest(method,params);
    callGatewayFromCli=await loadGateway();
    if(typeof callGatewayFromCli!=='function')throw sessionError('UNAVAILABLE','The supported gateway client is unavailable.');
    if(checked) {
      const result=await callGatewayFromCli('sessions.describe',{expectUrl,json:true,timeout:'10000'},
        {key:params.sessionKey,agentId:params.agentId},{scopes:['operator.read'],sharedStateMode:'read-only',progress:false});
      assertSession(result?.session,{sessionId:params.sessionId,agentId:params.agentId},true);
    }
  } catch(error) {
    if(!checked)throw error;
    // Only this pre-write boundary can mark a rejection as definitely unsent.
    const safe=new Error('Message preflight did not complete.');
    safe.code=error?.gatewayCode??error?.code??'UNAVAILABLE';safe[PREFLIGHT]=true;throw safe;
  }
  return callGatewayFromCli(checked?'chat.send':method,
    {expectUrl,json:true,timeout:method==='tts.speak'?'130000':'20000'},params,
    {scopes,sharedStateMode:'read-only',progress:false});
}
function failurePayload(error) {
  const candidate=error?.gatewayCode??error?.code;
  const code=typeof candidate==='string'&&/^[A-Z_]{1,80}$/.test(candidate)?candidate:'UNAVAILABLE';
  const reason=error?.details?.reason;
  return {ok:false,error:{code,...(error?.[PREFLIGHT]?{preflight:true}:{}),
    ...['active-leaf-changed','session-settings-changed'].includes(reason)?{reason}:{}}};
}
async function main() {
  const [method, expectUrl, ...extra] = process.argv.slice(2);
  if (extra.length || !FIELDS.has(method)&&method!==CHECKED_SEND || !/^ws:\/\/127\.0\.0\.1:\d{1,5}$/.test(expectUrl || '')) throw new Error('Invalid private request');
  let bytes = 0; const chunks = [];
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > (method === 'chat.send'||method===CHECKED_SEND ? MAX_BYTES : 131072)) throw new Error('Private request too large');
    chunks.push(chunk);
  }
  const params = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const result=await executeRequest(method,expectUrl,params,async()=>{
    const installed=createRequire('/opt/homebrew/lib/node_modules/openclaw/package.json');
    return (await import(pathToFileURL(installed.resolve('openclaw/plugin-sdk/gateway-runtime')).href)).callGatewayFromCli;
  });
  process.stdout.write(JSON.stringify(result) + '\n');
}
if (require.main === module) main().catch(error => {
  process.stdout.write(JSON.stringify(failurePayload(error)) + '\n');
  process.exitCode = 1;
});
module.exports = { validateRequest, assertSession, executeRequest, failurePayload };
