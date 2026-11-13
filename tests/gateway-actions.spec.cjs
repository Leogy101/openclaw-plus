'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {InteractionService,validate}=require('../desktop/src/gateway-actions.cjs');
const {ReadError}=require('../desktop/src/gateway-cli.cjs');

function approval(kind='exec',id='approval-fixture') {
  return {id,status:'pending',createdAtMs:Date.now()-1000,expiresAtMs:Date.now()+60000,urlPath:'/approvals/fixture',
    presentation:{kind,...(kind==='exec'?{commandText:'echo fixture',host:'gateway'}:{title:'Fixture request',description:'Fixture action'}),
      agentId:'builder',allowedDecisions:['allow-once','deny']}};
}
function fixture() {
  const state={approval:approval(),config:{valid:true,hash:'fixture-hash',config:{ui:{name:'Before'},models:{apiKey:'__OPENCLAW_REDACTED__'},channels:{allowed:['a','b']}}},
    reads:[],writes:[],writeResult:null,readHook:null,writeHook:null};
  const base={generation:0,assertCurrent(g){if(g!==this.generation)throw new ReadError('STALE','Fixture connection changed');},
    invalidate(){this.generation++;},async read(method,params,ttl){
      state.reads.push({method,params,ttl});if(state.readHook)return state.readHook(method,params);
      if(method==='exec.approval.list')return [{id:state.approval.id,request:{sessionKey:'agent:builder:main',cwd:'/private/not-for-renderer',env:{TOKEN:'fixture-only'}}}];
      if(method==='plugin.approval.list'||method==='openclaw.approval.list')return [];
      if(method==='approval.get')return {approval:structuredClone(state.approval)};
      if(method==='config.get')return structuredClone(state.config);
      throw new Error('Unexpected read '+method);
    },transport:{async write(method,params){
      state.writes.push({method,params:structuredClone(params)});if(state.writeHook)return state.writeHook(method,params);
      if(state.writeResult)return structuredClone(state.writeResult);
      if(method==='approval.resolve')return {applied:true,approval:{...structuredClone(state.approval),status:'allowed',decision:params.decision,reason:'user'}};
      if(method==='config.patch')return {ok:true,hash:'new-hash',changedPaths:['ui.name']};
      throw new Error('Unexpected write '+method);
    }}};
  return {state,base,service:new InteractionService(base)};
}
const edit=(raw,change)=>{const document=JSON.parse(raw);change(document);return JSON.stringify(document);};

test('operation validation rejects malformed writes before any gateway request',async()=>{
  for(const [op,p]of [['constructor',{}],['approvals',{limit:500}],['resolveApproval',{id:'x',kind:'exec',decision:'yes'}],
    ['resolveApproval',{id:'\ud800',kind:'exec',decision:'deny'}],['saveSettings',{baseHash:'x',raw:'x'.repeat(262145)}]]) {
    assert.throws(()=>validate(op,p),{code:'INVALID'});
  }
  const {state,service}=fixture();
  await assert.rejects(service.handle('resolveApproval',{id:'x',kind:'exec',decision:'approve'}),{code:'INVALID'});
  assert.deepEqual(state.reads,[]);assert.deepEqual(state.writes,[]);
});

test('pending UI uses safe unified projections and retains source attribution only',async()=>{
  const {state,service}=fixture();
  const result=await service.handle('approvals',{});
  assert.equal(result.items.length,1);assert.equal(result.items[0].command,'echo fixture');
  assert.equal(result.items[0].sessionKey,'agent:builder:main');
  assert.deepEqual(result.items[0].allowedDecisions,[{id:'allow-once',label:'Allow once'},{id:'deny',label:'Deny'}]);
  assert.doesNotMatch(JSON.stringify(result),/not-for-renderer|fixture-only|TOKEN/);
  assert.equal(result.items[0].host,'gateway');
  assert.deepEqual(result.items[0].reviewDetails,state.approval.presentation);
  assert.ok(state.reads.every(x=>x.ttl===0));assert.deepEqual(state.writes,[]);
});

test('canonical review details retain node, blast radius and external verification choices',async()=>{
  const {state,service}=fixture();
  state.approval.presentation.nodeId='fixture-node';
  state.approval.presentation.scope={kind:'external-post',target:'Fixture destination',visibility:'public'};
  state.approval.presentation.externalResolution={label:'Verify with fixture provider',decisions:['allow-once']};
  const item=(await service.handle('approvals',{})).items[0];
  assert.equal(item.nodeId,'fixture-node');
  assert.deepEqual(item.scope,state.approval.presentation.scope);
  assert.deepEqual(item.externalResolution,state.approval.presentation.externalResolution);
  assert.deepEqual(item.reviewDetails,state.approval.presentation);
});

test('resolution freshly checks reviewed identity and displays the recorded competing decision',async()=>{
  const {state,service}=fixture();const {reviewToken}=(await service.handle('approvals',{})).items[0];
  state.writeResult={applied:false,approval:{...state.approval,status:'denied',decision:'deny',reason:'user'}};
  const result=await service.handle('resolveApproval',{id:state.approval.id,kind:'exec',decision:'allow-once',reviewToken});
  assert.equal(result.applied,false);assert.equal(result.approval.decision,'deny');
  assert.deepEqual(state.writes,[{method:'approval.resolve',params:{id:state.approval.id,kind:'exec',decision:'allow-once'}}]);
  assert.equal(state.reads.filter(x=>x.method==='approval.get').length,2);
});

test('wrong kind, unavailable verdict, changed command and expiry never reach the resolver',async()=>{
  for(const change of ['kind','decision','command','expiry']) {
    const {state,service}=fixture();const {reviewToken}=(await service.handle('approvals',{})).items[0];
    const input={id:state.approval.id,kind:'exec',decision:'allow-once',reviewToken};
    if(change==='kind')input.kind='plugin';
    if(change==='decision')input.decision='allow-always';
    if(change==='command')state.approval.presentation.commandText='echo changed';
    if(change==='expiry')state.approval.expiresAtMs=Date.now()-1;
    await assert.rejects(service.handle('resolveApproval',input));assert.deepEqual(state.writes,[]);
  }
  const {state,service}=fixture();const {reviewToken}=(await service.handle('approvals',{})).items[0];
  state.approval.status='cancelled';state.approval.reason='gateway-restart';
  assert.equal((await service.handle('resolveApproval',{id:state.approval.id,kind:'exec',decision:'deny',reviewToken})).approval.status,'cancelled');
  assert.deepEqual(state.writes,[]);
});

test('connection invalidation while reviewing prevents a later verdict',async()=>{
  const {state,base,service}=fixture();const {reviewToken}=(await service.handle('approvals',{})).items[0];
  let release;state.readHook=()=>new Promise(resolve=>{release=resolve;});
  const pending=service.handle('resolveApproval',{id:state.approval.id,kind:'exec',decision:'allow-once',reviewToken});
  base.invalidate();release({approval:state.approval});
  await assert.rejects(pending,{code:'STALE'});assert.deepEqual(state.writes,[]);
});

test('connection invalidation after an approval write cannot claim no decision was applied',async()=>{
  const {state,base,service}=fixture();const {reviewToken}=(await service.handle('approvals',{})).items[0];
  const input={id:state.approval.id,kind:'exec',decision:'allow-once',reviewToken};
  state.writeHook=()=>{
    base.invalidate();
    return {applied:true,approval:{...state.approval,status:'allowed',decision:'allow-once'}};
  };
  await assert.rejects(service.handle('resolveApproval',input),{code:'UNCERTAIN'});
  assert.equal(state.writes.length,1);
  assert.equal(service.reviewed.has(input.id),false);
  await assert.rejects(service.handle('resolveApproval',input),{code:'STALE'});
  assert.equal(state.writes.length,1,'a stale review cannot repeat the decision');
});

test('unchanged approval polls retain the exact reviewed token',async()=>{
  const {state,service}=fixture();
  const first=(await service.handle('approvals',{})).items[0];
  const second=(await service.handle('approvals',{})).items[0];
  assert.equal(typeof first.reviewToken,'string');assert.ok(first.reviewToken.length>=32);
  assert.equal(second.reviewToken,first.reviewToken);
  const result=await service.handle('resolveApproval',{id:first.id,kind:first.kind,decision:'allow-once',reviewToken:first.reviewToken});
  assert.equal(result.applied,true);
  assert.equal(Object.hasOwn(state.writes[0].params,'reviewToken'),false,'review tokens stay inside this application');
});

test('changed command, scope, identity metadata or source polls invalidate an old modal token',async()=>{
  for(const field of ['command','scope','expiry','created','session']) {
    const {state,service}=fixture();const first=(await service.handle('approvals',{})).items[0];
    if(field==='command')state.approval.presentation.commandText='echo changed command';
    if(field==='scope')state.approval.presentation.scope={kind:'external-post',target:'New target',visibility:'public'};
    if(field==='expiry')state.approval.expiresAtMs+=1000;
    if(field==='created')state.approval.createdAtMs+=1000;
    if(field==='session')state.approval.sourceSessionKey='agent:builder:other';
    const current=(await service.handle('approvals',{})).items[0];
    assert.notEqual(current.reviewToken,first.reviewToken);
    const readCount=state.reads.length;
    await assert.rejects(service.handle('resolveApproval',{id:first.id,kind:first.kind,decision:'allow-once',reviewToken:first.reviewToken}),{code:'STALE'});
    assert.equal(state.reads.length,readCount,'reject the old modal locally before any gateway call');
    assert.deepEqual(state.writes,[]);
  }
});

test('missing and forged review tokens cannot authorize a verdict',async()=>{
  const {state,service}=fixture();const item=(await service.handle('approvals',{})).items[0];
  const input={id:item.id,kind:item.kind,decision:'allow-once'};
  await assert.rejects(service.handle('resolveApproval',input),{code:'INVALID'});
  await assert.rejects(service.handle('resolveApproval',{...input,reviewToken:'not-issued'}),{code:'STALE'});
  assert.deepEqual(state.writes,[]);
});

test('settings sends a minimal revision-checked patch and never resends unchanged secrets',async()=>{
  const {state,base,service}=fixture();const shown=await service.handle('settings',{});
  const result=await service.handle('saveSettings',{baseHash:shown.baseHash,raw:edit(shown.raw,d=>{d.ui.name='After';})});
  assert.equal(result.saved,true);assert.equal(base.generation,1);
  assert.deepEqual(state.writes,[{method:'config.patch',params:{baseHash:'fixture-hash',raw:'{"ui":{"name":"After"}}',response:'summary'}}]);
});

test('settings conflict and unchanged edits cause no mutation',async()=>{
  const {state,service}=fixture();const shown=await service.handle('settings',{});
  assert.equal((await service.handle('saveSettings',{baseHash:shown.baseHash,raw:shown.raw})).saved,false);
  await assert.rejects(service.handle('saveSettings',{baseHash:'wrong',raw:shown.raw}),{code:'CONFLICT'});
  state.config.hash='other-writer';
  await assert.rejects(service.handle('saveSettings',{baseHash:shown.baseHash,raw:edit(shown.raw,d=>{d.ui.name='After';})}),{code:'CONFLICT'});
  assert.deepEqual(state.writes,[]);
});

test('explicit array replacements and containing-object deletion carry exact replacePaths',async()=>{
  for(const change of [d=>{d.channels.allowed=['b'];},d=>{delete d.channels;}]) {
    const {state,service}=fixture();const shown=await service.handle('settings',{});
    await service.handle('saveSettings',{baseHash:shown.baseHash,raw:edit(shown.raw,change)});
    assert.deepEqual(state.writes[0].params.replacePaths,['channels.allowed']);
  }
});

test('credential, SecretRef and redacted marker edits remain local and unlogged',async()=>{
  for(const change of [d=>{d.models.apiKey='fixture-secret';},d=>{delete d.models;},d=>{d.ui.apiKey='fixture-secret';},
    d=>{d.ui.reference={source:'env',provider:'fixture',id:'FIXTURE_KEY'};},
    d=>{d.ui.reference={source:'store',provider:'fixture',id:'fixture-key'};},d=>{d.ui.endpoint='https://user:fixture-password@example.com';}]) {
    const {state,service}=fixture();const shown=await service.handle('settings',{});
    await assert.rejects(service.handle('saveSettings',{baseHash:shown.baseHash,raw:edit(shown.raw,change)}),{code:'PROTECTED'});
    assert.deepEqual(state.writes,[]);assert.equal(state.reads.length,1);
  }
});

test('invalid JSON, prototype keys and oversized documents never reach config.patch',async()=>{
  for(const raw of ['{broken','[]','{"__proto__":{"polluted":true}}','x'.repeat(262145)]) {
    const {state,service}=fixture();const shown=await service.handle('settings',{});
    await assert.rejects(service.handle('saveSettings',{baseHash:shown.baseHash,raw}),{code:'INVALID'});
    assert.deepEqual(state.writes,[]);
  }
  assert.equal({}.polluted,undefined);
});

test('uncertain settings writes require a fresh load and are never retried',async()=>{
  const {state,service}=fixture();const shown=await service.handle('settings',{});
  const input={baseHash:shown.baseHash,raw:edit(shown.raw,d=>{d.ui.name='After';})};
  state.writeHook=()=>{throw new Error('fixture transport lost response');};
  await assert.rejects(service.handle('saveSettings',input),{code:'UNCERTAIN'});
  await assert.rejects(service.handle('saveSettings',input),{code:'CONFLICT'});
  assert.equal(state.writes.length,1);
});

test('connection invalidation after a settings write requires verification without claiming it failed',async()=>{
  const {state,base,service}=fixture();const shown=await service.handle('settings',{});
  const input={baseHash:shown.baseHash,raw:edit(shown.raw,d=>{d.ui.name='After';})};
  state.writeHook=()=>{base.invalidate();return {ok:true,hash:'saved-hash'};};
  await assert.rejects(service.handle('saveSettings',input),{code:'UNCERTAIN'});
  assert.equal(service.settingsBase,null);
  await assert.rejects(service.handle('saveSettings',input),{code:'CONFLICT'});
  assert.equal(state.writes.length,1,'checking the outcome requires a fresh configuration read');
});

test('definitive settings rejections preserve their category and require a fresh review',async()=>{
  for(const code of ['INVALID','DENIED','ACCESS','CONFLICT']) {
    const {state,service}=fixture();const shown=await service.handle('settings',{});
    const input={baseHash:shown.baseHash,raw:edit(shown.raw,d=>{d.ui.name='After';})};
    state.writeHook=()=>{throw new ReadError(code,'Fixture definitive rejection');};
    await assert.rejects(service.handle('saveSettings',input),{code,message:'Fixture definitive rejection'});
    assert.equal(service.settingsBase,null);
    await assert.rejects(service.handle('saveSettings',input),{code:'CONFLICT'});
    assert.equal(state.writes.length,1);
  }
});

test('restart acknowledgement stays explicit and concurrent saves are rejected',async()=>{
  const {state,service}=fixture();const shown=await service.handle('settings',{});
  const input={baseHash:shown.baseHash,raw:edit(shown.raw,d=>{d.ui.name='After';})};
  let release;state.writeHook=()=>new Promise(resolve=>{release=resolve;});
  const saving=service.handle('saveSettings',input);await Promise.resolve();
  await assert.rejects(service.handle('saveSettings',input),{code:'BUSY'});
  release({ok:true,restartPending:true});
  assert.equal((await saving).restart,true);assert.equal(state.writes.length,1);
});
