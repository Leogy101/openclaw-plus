'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {executeRequest,failurePayload}=require('../desktop/src/composer-rpc.cjs');
const {CliTransport,ReadError,classifyFailure}=require('../desktop/src/gateway-cli.cjs');
const {GatewayService}=require('../desktop/src/gateway-service.cjs');
const {ConversationActions}=require('../desktop/src/gateway-conversation.cjs');
const url='ws://127.0.0.1:19999';
const params={sessionKey:'agent:main:fixture',agentId:'main',sessionId:'physical-fixture',message:'Fixture prompt',idempotencyKey:'fixture-send',expectedLeafEntryId:null,replyToId:'fixture-question'};
const session={sessionId:params.sessionId,agentId:params.agentId};

test('checked helper loads the supported SDK once, checks exact session then sends unchanged params with narrow scopes',async()=>{
 const calls=[];let loads=0;
 const result=await executeRequest('chat.send.checked',url,params,async()=>{loads++;return async(method,options,input,policy)=>{
  calls.push({method,options,input,policy});return method==='sessions.describe'?{session}:{status:'accepted'};
 };});
 assert.equal(loads,1);assert.deepEqual(result,{status:'accepted'});
 assert.deepEqual(calls.map(x=>x.method),['sessions.describe','chat.send']);
 assert.deepEqual(calls[0].input,{key:params.sessionKey,agentId:params.agentId});
 assert.deepEqual(calls[0].policy,{scopes:['operator.read'],sharedStateMode:'read-only',progress:false});
 assert.deepEqual(calls[1].input,params);
 assert.deepEqual(calls[1].policy,{scopes:['operator.read','operator.write'],sharedStateMode:'read-only',progress:false});
 assert.ok(calls.every(x=>x.options.expectUrl===url));
 assert.deepEqual(calls.map(x=>x.options.timeout),['10000','20000']);
});

test('checked helper rejects replaced, foreign, archived and missing sessions before any write',async()=>{
 for(const row of [undefined,{...session,sessionId:'replacement'},{...session,agentId:'foreign'},{...session,archived:true}]){
  const calls=[];
  await assert.rejects(executeRequest('chat.send.checked',url,params,async()=>async method=>{calls.push(method);return {session:row};}),error=>{
   const reply=failurePayload(error);assert.equal(reply.error.preflight,true);
   const classified=classifyFailure(JSON.stringify(reply),false,true,true);
   assert.equal(classified.preflight,true);assert.notEqual(classified.code,'UNCERTAIN');return true;
  });
  assert.deepEqual(calls,['sessions.describe']);
 }
});

test('missing SDK, unavailable reads and malformed checked inputs fail closed with bounded preflight evidence',async()=>{
 const failure=Object.assign(new Error('PRIVATE_DIAGNOSTIC'),{gatewayCode:'FORBIDDEN'});
 for(const load of [async()=>undefined,async()=>{throw failure;},async()=>async()=>{throw failure;}]){
  await assert.rejects(executeRequest('chat.send.checked',url,params,load),error=>{
   const payload=failurePayload(error);assert.equal(payload.error.preflight,true);assert.doesNotMatch(JSON.stringify(payload),/PRIVATE_DIAGNOSTIC/);return true;
  });
 }
 for(const value of [{...params,expectedLeafEntryId:undefined},{...params,scopes:['operator.admin']},{...params,sessionId:''},{...params,idempotencyKey:'bad id'}]){
  let called=false;await assert.rejects(executeRequest('chat.send.checked',url,value,async()=>{called=true;return async()=>({session});}));assert.equal(called,false);
 }
});

test('post-write failures never carry a preflight proof and retain unknown or native conflict outcomes',async()=>{
 for(const failure of [Object.assign(new Error('lost reply'),{preflight:true,code:'TIMEOUT'}),Object.assign(new Error('branch changed'),{gatewayCode:'INVALID_REQUEST',details:{reason:'active-leaf-changed'}})]){
  const calls=[];await assert.rejects(executeRequest('chat.send.checked',url,params,async()=>async method=>{calls.push(method);if(method==='sessions.describe')return {session};throw failure;}),error=>{
   const payload=failurePayload(error);assert.equal(payload.error.preflight,undefined);
   assert.equal(classifyFailure(JSON.stringify(payload),false,true,true).code,failure.code==='TIMEOUT'?'UNCERTAIN':'CONFLICT');return true;
  });assert.deepEqual(calls,['sessions.describe','chat.send']);
 }
});

test('ordinary helper operations retain their native method and never gain an extra read or admin scope',async()=>{
 const calls=[];await executeRequest('chat.send',url,params,async()=>async(method,options,input,policy)=>{calls.push({method,policy});return {status:'accepted'};});
 assert.deepEqual(calls,[{method:'chat.send',policy:{scopes:['operator.read','operator.write'],sharedStateMode:'read-only',progress:false}}]);
});

function checkedFixture({describe=()=>({session}),send=async input=>({runId:input.idempotencyKey,status:'started'})}={}){
 const calls=[];let spawns=0;
 const transport=new CliTransport({home:'/fixture',target:{url,configPath:'/fixture/openclaw.json'},execute(_node,args,options,done){
  spawns++;assert.match(args[0],/composer-rpc\.cjs$/);assert.equal(args[1],'chat.send.checked');assert.equal(args[2],url);
  assert.equal(options.shell,false);assert.equal(options.timeout,38000);
  return {kill(){queueMicrotask(()=>done({killed:true},''));},stdin:{on(){},end(raw){
   executeRequest(args[1],args[2],JSON.parse(raw),async()=>async(method,_options,input)=>{
    calls.push({method,params:structuredClone(input)});return method==='sessions.describe'?describe():send(input);
   }).then(result=>done(null,JSON.stringify(result)),error=>done({code:1},JSON.stringify(failurePayload(error))));
  }}};
 }});
 const base=new GatewayService(transport);return {transport,base,calls,spawns:()=>spawns,actions:new ConversationActions(base)};
}
const input={key:params.sessionKey,agentId:params.agentId,sessionId:params.sessionId,message:params.message,requestId:params.idempotencyKey,expectedLeafEntryId:null,replyToId:params.replyToId};

test('known-leaf send uses one process with real helper guards and deduplicates accepted requests',async()=>{
 const f=checkedFixture();try{
  assert.deepEqual(await f.actions.handle('send',input),{runId:input.requestId,status:'started'});
  await f.actions.handle('send',input);assert.equal(f.spawns(),1);assert.deepEqual(f.calls.map(x=>x.method),['sessions.describe','chat.send']);
  assert.deepEqual(f.calls[1].params,params);
 }finally{f.transport.close();}
});

test('checked preflight failure is definitely unsent but cannot erase an earlier uncertain send',async()=>{
 let failRead=true,writes=0;
 const f=checkedFixture({describe(){if(failRead)throw Object.assign(new Error('fixture unavailable'),{code:'TIMEOUT'});return {session};},send:async value=>{if(++writes===1)throw Object.assign(new Error('lost receipt'),{code:'TIMEOUT'});return {runId:value.idempotencyKey,status:'started'};}});
 try{
  await assert.rejects(f.actions.handle('send',input),error=>error instanceof ReadError&&error.preflight===true&&error.code==='TIMEOUT');
  assert.equal(writes,0);assert.equal(f.actions.submissions.size,0);
  failRead=false;await assert.rejects(f.actions.handle('send',input),{code:'UNCERTAIN'});
  const original=structuredClone(f.calls.find(x=>x.method==='chat.send').params);
  failRead=true;await assert.rejects(f.actions.handle('send',input),error=>error.code==='UNCERTAIN'&&error.preflight!==true);
  assert.equal(writes,1);assert.deepEqual(f.actions.submissions.get(input.requestId).params,original);
  failRead=false;await f.actions.handle('send',input);
  assert.deepEqual(f.calls.filter(x=>x.method==='chat.send').map(x=>x.params),[original,original]);
 }finally{f.transport.close();}
});

test('checked send still rejects a receipt observed after the main connection generation changed',async()=>{
 let release;const waiting=new Promise(resolve=>release=resolve);
 const f=checkedFixture({send:async value=>{await waiting;return {runId:value.idempotencyKey,status:'started'};}});
 try{
  const pending=f.actions.handle('send',input);await new Promise(resolve=>setImmediate(resolve));
  f.base.invalidate();release();await assert.rejects(pending,{code:'UNCERTAIN'});
  assert.equal(f.actions.submissions.get(input.requestId).result,undefined);
 }finally{f.transport.close();}
});

test('checked media locks are released after a proven preflight failure and retained across uncertain retries',async()=>{
 const {AttachmentStore}=require('../desktop/src/attachments.cjs');
 let stage='preflight';
 const f=checkedFixture({describe(){if(stage==='preflight')throw Object.assign(new Error('offline'),{code:'TIMEOUT'});return {session};},send:async value=>{if(stage==='uncertain')throw Object.assign(new Error('lost receipt'),{code:'TIMEOUT'});return {runId:value.idempotencyKey,status:'started'};}});
 const store=new AttachmentStore();
 const context={key:input.key,agentId:input.agentId,sessionId:input.sessionId};
 store.items.set('attachment-fixture',{id:'attachment-fixture',context:JSON.stringify(context),name:'fixture.txt',mimeType:'text/plain',sizeBytes:5,content:Buffer.from('hello').toString('base64')});store.retainedBytes=5;f.actions.attachments=store;
 const request={...input,message:'',attachmentIds:['attachment-fixture']};
 try{
  await assert.rejects(f.actions.handle('send',request),error=>error.preflight===true);
  assert.equal(store.items.get('attachment-fixture').lock,undefined);assert.equal(store.retainedBytes,5);
  stage='uncertain';await assert.rejects(f.actions.handle('send',request),{code:'UNCERTAIN'});
  assert.equal(store.items.get('attachment-fixture').lock,request.requestId);
  assert.throws(()=>store.remove(context,'attachment-fixture'),{code:'BUSY'});
  const first=f.calls.find(x=>x.method==='chat.send').params;
  stage='accepted';await f.actions.handle('send',request);
  assert.deepEqual(f.calls.filter(x=>x.method==='chat.send')[1].params,first);assert.equal(store.retainedBytes,0);
 }finally{f.transport.close();}
});

test('fallback shared identity checks retain ReadError classification across the desktop bridge',async()=>{
 const base={generation:0,assertCurrent(){},read:async()=>({session:{...session,sessionId:'replacement'}}),transport:{}};
 const actions=new ConversationActions(base);
 await assert.rejects(actions.handle('plan',{key:input.key,agentId:input.agentId,sessionId:input.sessionId}),error=>error instanceof ReadError&&error.code==='SESSION_CHANGED');
});
