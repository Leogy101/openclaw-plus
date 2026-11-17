'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {GcbService,PROFILE_OPERATIONS,snapshotRecord}=require('../desktop/src/gcb-service.cjs');
const executable=process.env.OPENCLAW_PLUS_TEST_GCB||path.resolve(__dirname,'../.cache/gcb-runtime/bin/gcb');
const temporary=()=>fs.mkdtempSync(path.join(os.tmpdir(),'openclaw-gcb-test-'));
const snapshot=()=>({snapshot_version:1,checked_at:'2026-11-16T00:00:00Z',agent_id:'fixture-agent',model_ref:'openai/gpt-fixture',
  openclaw_version:'2026.11.1',codex_version:'0.169.0',context_window:32000,reasoning_settings:['medium','high'],selected_reasoning:'medium'});
const binding=()=>({metadataFingerprint:'catalog-fingerprint',connectionGeneration:1,hostVersion:'2026.11.1',configPath:'/fixture-home/.openclaw/openclaw.json',url:'ws://127.0.0.1:18789'});
function fake({authorizeTarget=async()=>binding(),authorizeLocal=async()=>({...binding(),endpoint:'http://127.0.0.1:11434',nativeModel:'qwen3.5:9b'}),onCall}={}) {
  const calls=[],statuses=new Map();let service;
  const execute=(file,args,options,callback)=>{
    calls.push({file,args:[...args],options});
    const action=args[3],id=args[4],model=id?.replace(/^plan-/,'');
    let result={};
    if(args[0]==='doctor')result={python:'3.14.6',network_probes:false,runtime_dependencies:[]};
    else if(args[2]==='init')result={status:'initialized'};
    else if(args[2]==='bio')result=service.targets.find(target=>target.id===args[3])?.mode==='ollama'
      ? {evidence_kind:'transport_fixture',configurations:[true,false].map(think=>({configuration_id:`config-${think}`,native:{think,options:{num_ctx:4096,num_predict:128}}})),model:{id:args[3]}}
      : {evidence_kind:'synthetic_fixture',configurations:[],model:{id:args[3]}};
    else if(args[2]==='route')result={status:'selected',enforcement:'preview_only',candidates:[]};
    else if(action==='research')result={metadata_id:'metadata',model:{id,native_id:id,reasoning:{native_configurations:[{}]}},configuration_ids:args.includes('ollama')?['config-true','config-false']:[`config-${id}`],evidence_kind:'synthetic_fixture'};
    else if(action==='plan') {
      const planId=`plan-${id}`;
      statuses.set(planId,statuses.get(planId)||{plan_id:planId,model_id:id,status:'planned',cells:{pending:3},total_cells:3,attempts:0,elapsed_seconds:0});
      result={plan_id:planId,model_id:id,status:'planned',cells:[{case_id:'fixture'}],configuration_ids:[args.includes('--baseline-configuration')?args[args.indexOf('--baseline-configuration')+1]:`config-${id}`],
        max_requests:Number(args[args.indexOf('--max-requests')+1]),call_timeout_seconds:Number(args[args.indexOf('--call-timeout')+1]),
        total_timeout_seconds:Number(args[args.indexOf('--total-timeout')+1]),max_output_tokens:args.includes('ollama')?128:256};
    } else if(action==='status')result=statuses.get(id);
    else if(action==='cancel'){const previous=statuses.get(id);result={...previous,status:'cancelled'};statuses.set(id,result);}
    else if(['start','resume'].includes(action)){
      const previous=statuses.get(id),attempts=previous.attempts+1;
      result={...previous,status:attempts>=3?'complete':'paused',attempts,cells:{observed:attempts,pending:Math.max(0,3-attempts)},elapsed_seconds:attempts/10,grant_id:'grant-fixture'};
      statuses.set(id,result);
    }
    const override=onCall?.({args,options,result,service});
    const child={kill(){return true;}};
    setTimeout(()=>callback(override?.error||null,override?.stdout??JSON.stringify(result),override?.stderr||''),['start','resume'].includes(action)?30:0);
    return child;
  };
  service=new GcbService({directory:temporary(),home:'/fixture-home',executable:process.execPath,execute,authorizeTarget,authorizeLocal});
  return {service,calls,statuses};
}
async function prepare(service,id='forge') {
  await service.handle('modelsProfileResearch',{targetId:id});
  return service.handle('modelsProfilePlan',{targetId:id,contrast:true});
}
const start=(service,review,host=false)=>service.handle('modelsProfileStart',{reviewToken:review.reviewToken,approveUsage:true,approveHostRuntime:host});

test('unavailable package stays optional and does not initialize databases',async()=>{
  const directory=temporary(),service=new GcbService({directory});
  assert.equal((await service.handle('modelsProfileOverview')).engine.status,'unavailable');
  assert.deepEqual(fs.readdirSync(directory),[]);
  await assert.rejects(service.handle('modelsProfileResearch',{targetId:'forge'}),{code:'UNAVAILABLE'});
  await service.close();
});
test('renderer operations reject paths, commands, forged consent and unexpected fields',async()=>{
  const {service,calls}=fake();await service.ready;
  for(const [operation,input] of [['modelsProfileExecute',{command:'sh'}],['modelsProfileResearch',{targetId:'forge',executable:'/bin/sh'}],
    ['modelsProfileOverview',{path:'/private'}],['modelsProfileStart',{reviewToken:'forged',approveUsage:true,approveHostRuntime:false}]])
    await assert.rejects(service.handle(operation,input));
  assert.equal(calls.filter(call=>['start','resume'].includes(call.args[3])).length,0);
  assert.equal(PROFILE_OPERATIONS.includes('modelsProfileActivateRouting'),false);await service.close();
});
test('research and immutable plan are metadata-only; dismissed plans can be reviewed again',async()=>{
  const {service,calls}=fake(),first=await prepare(service),second=await service.handle('modelsProfilePlan',{targetId:'forge',contrast:false});
  assert.equal(first.plan.plan_id,second.plan.plan_id);assert.notEqual(first.reviewToken,second.reviewToken);
  assert.equal(calls.filter(call=>call.args[3]==='plan').length,1);
  assert.equal(calls.filter(call=>['start','resume'].includes(call.args[3])).length,0);
  await assert.rejects(start(service,first),{code:'STALE'});await service.close();
});
test('explicit bounded consent runs real CLI lane, pause retains cells, fresh resume grant preserves scope',async()=>{
  const {service,calls}=fake(),review=await prepare(service);
  await start(service,review);await service.handle('modelsProfilePause',{targetId:'forge'});await service.runPromise;
  let target=service.overview().targets[0];assert.equal(target.status.status,'paused');assert.equal(target.status.attempts,1);assert.equal(target.canResume,true);
  const again=await service.handle('modelsProfilePlan',{targetId:'forge',contrast:false});assert.equal(again.resumed,true);assert.equal(again.plan.plan_id,review.plan.plan_id);
  await start(service,again);await service.runPromise;target=service.overview().targets[0];assert.equal(target.status.status,'complete');assert.equal(target.status.attempts,3);
  const executions=calls.filter(call=>['start','resume'].includes(call.args[3]));
  assert.ok(executions[0].args.includes('--authorize'));assert.ok(executions[1].args.includes('--authorize'));assert.ok(executions[2].args.includes('--grant'));
  assert.ok(executions.every(call=>call.args.includes('--max-cells')&&call.options.shell===false));
  await assert.rejects(start(service,again),{code:'STALE'});await service.close();
});
test('overview is cached; bios and role routes use GCB and exact target configuration scope',async()=>{
  const {service,calls}=fake();await prepare(service);const count=calls.length;
  for(let index=0;index<5;index++)await service.handle('modelsProfileOverview');assert.equal(calls.length,count);
  const result=await service.handle('modelsProfilePreview',{targetId:'forge'});assert.equal(result.routes.length,5);
  for(const call of calls.filter(call=>call.args[2]==='route')){
    const policy=JSON.parse(call.args[call.args.indexOf('--policy')+1]);assert.deepEqual(policy.allowed_configurations,['config-forge']);assert.equal(policy.allow_remote,false);
    assert.ok(call.args[1].endsWith('offline.sqlite3'));
  }
  await service.close();
});
test('offline reviews survive native disconnection and no grant identity reaches the renderer',async()=>{
  const {service}=fake(),review=await prepare(service);service.invalidateConnection();
  await start(service,review);await service.handle('modelsProfilePause',{targetId:'forge'});await service.runPromise;
  service.targets[0].status.grant_id='private-grant';service.targets[0].grantId='private-grant';
  assert.equal(JSON.stringify(service.overview()).includes('private-grant'),false);
  service._save();assert.equal(fs.readFileSync(service.index,'utf8').includes('private-grant'),false);await service.close();
});
test('registration validates native snapshot without probing or invoking a model',async()=>{
  const {service,calls}=fake();await service.ready;const count=calls.length;
  await service.importSnapshot(snapshot());assert.equal(calls.length,count);assert.equal(service.targets.length,3);
  await service.importSnapshot(snapshot());assert.equal(service.targets.length,3);
  for(const mutate of [x=>x.snapshot_version=2,x=>x.reasoning_settings=['invented'],x=>x.selected_reasoning='low',x=>x.context_window=true,x=>x.model_ref='anthropic/claude',x=>x.apiKey='secret']) {
    const row=snapshot();mutate(row);assert.throws(()=>snapshotRecord(row));
  }
  await service.close();
});
test('native connection, fingerprint and host consent are required before any completion',async()=>{
  let native=binding();const {service,calls}=fake({authorizeTarget:async()=>({...native})});await service.ready;await service.importSnapshot(snapshot());
  const id=service.targets[2].id,review=await prepare(service,id);
  await assert.rejects(start(service,review),{code:'ACCESS'});
  const next=await service.handle('modelsProfilePlan',{targetId:id,contrast:true});native.metadataFingerprint='changed';
  await assert.rejects(start(service,next,true),{code:'STALE'});
  assert.equal(calls.filter(call=>['start','resume'].includes(call.args[3])).length,0);await service.close();
});
test('disconnect during status refresh invalidates consumed review before dispatch',async()=>{
  let interrupt=false;const {service,calls}=fake({onCall:({args,service})=>{if(interrupt&&args[3]==='status')service.invalidateConnection();}});
  await service.ready;await service.importSnapshot(snapshot());const id=service.targets[2].id,review=await prepare(service,id);interrupt=true;
  await assert.rejects(start(service,review,true),{code:'STALE'});
  assert.equal(calls.filter(call=>['start','resume'].includes(call.args[3])).length,0);await service.close();
});
test('native endpoint changes and substituted CLI shim block model dispatch',async()=>{
  let native=binding();const {service,calls}=fake({authorizeTarget:async()=>({...native})});await service.ready;await service.importSnapshot(snapshot());
  const id=service.targets[2].id,review=await prepare(service,id);native.url='ws://127.0.0.1:20000';
  await assert.rejects(start(service,review,true),{code:'STALE'});native=binding();
  const next=await service.handle('modelsProfilePlan',{targetId:id,contrast:true});
  const shim=path.join(service.directory,'native-bin','openclaw');fs.unlinkSync(shim);fs.symlinkSync(process.execPath,shim);
  await start(service,next,true);await service.runPromise;
  assert.ok(service.targets[2].error);assert.equal(calls.filter(call=>['start','resume'].includes(call.args[3])).length,0);await service.close();
});
test('attributed execution is blocked even for an empty inherited flag and subprocess environment has no credentials',async()=>{
  const {service,calls}=fake();await service.ready;await service.importSnapshot(snapshot());const id=service.targets[2].id;
  const previous=process.env.OPENCLAW_SUBAGENT_EXEC;process.env.OPENCLAW_SUBAGENT_EXEC='';
  try{await assert.rejects(service.handle('modelsProfileResearch',{targetId:id}),{code:'ACCESS'});}
  finally{if(previous===undefined)delete process.env.OPENCLAW_SUBAGENT_EXEC;else process.env.OPENCLAW_SUBAGENT_EXEC=previous;}
  const review=await prepare(service,id);await start(service,review,true);await service.handle('modelsProfilePause',{targetId:id});await service.runPromise;
  const invocation=calls.find(call=>call.args[3]==='start');assert.equal(invocation.options.env.OPENCLAW_CONFIG_PATH,binding().configPath);
  assert.equal(invocation.options.env.OPENCLAW_PLUS_GCB_EXPECT_URL,binding().url);
  assert.equal(fs.readlinkSync(path.join(service.directory,'native-bin','openclaw')),service.nativeHelper);
  assert.deepEqual(Object.keys(invocation.options.env).sort(),['HOME','LANG','OPENCLAW_CONFIG_PATH','OPENCLAW_PLUS_GCB_EXPECT_URL','PATH','PYTHONIOENCODING','TMPDIR'].sort());
  await service.close();
});
test('uncertain completion and malformed CLI output preserve evidence and block replay',async()=>{
  let broken=false;const {service,calls,statuses}=fake({onCall:({args})=>broken&&args[3]==='start'?{error:{code:1},stdout:'private credential canary',stderr:'private stderr'}:undefined});
  const review=await prepare(service);broken=true;await start(service,review);await service.runPromise;
  assert.ok(service.targets[0].error);assert.equal(JSON.stringify(service.overview()).includes('canary'),false);
  statuses.set(review.plan.plan_id,{...statuses.get(review.plan.plan_id),status:'partial_unknown',cells:{unknown_completion:1,pending:2}});
  await assert.rejects(service.handle('modelsProfilePlan',{targetId:'forge'}),{code:'UNCERTAIN'});
  assert.equal(calls.filter(call=>call.args[3]==='start').length,1);await service.close();
});
test('unsafe, corrupt or externally changed storage fails closed without replacing original bytes',async()=>{
  for(const mode of ['corrupt','public','symlink']){
    const directory=temporary(),index=path.join(directory,'profiles.json'),original='original-untrusted-bytes';
    if(mode==='symlink'){const elsewhere=path.join(temporary(),'target');fs.writeFileSync(elsewhere,original,{mode:0o600});fs.symlinkSync(elsewhere,index);}
    else fs.writeFileSync(index,original,{mode:mode==='public'?0o644:0o600});
    const service=new GcbService({directory});assert.equal((await service.handle('modelsProfileOverview')).engine.status,'unavailable');
    await assert.rejects(service.connect(process.execPath));assert.equal(fs.readFileSync(index,'utf8'),original);await service.close();
  }
  const {service,calls}=fake();const review=await prepare(service),index=path.join(service.directory,'profiles.json');
  fs.appendFileSync(index,' ');const count=calls.length;await assert.rejects(start(service,review),{code:'CONFLICT'});assert.equal(calls.length,count);await service.close();
});
test('database and snapshot symlinks are refused before CLI execution',async()=>{
  const {service,calls}=fake();await service.ready;const destination=path.join(temporary(),'do-not-touch');fs.writeFileSync(destination,'retained',{mode:0o600});
  fs.symlinkSync(destination,path.join(service.directory,'offline.sqlite3'));const count=calls.length;
  await assert.rejects(service.handle('modelsProfileResearch',{targetId:'forge'}),{code:'STORAGE'});assert.equal(calls.length,count);assert.equal(fs.readFileSync(destination,'utf8'),'retained');await service.close();
});
test('local target registration is a native reference only; local smoke uses exact GCB false baseline and one attempt',async()=>{
  let checks=0;const {service,calls}=fake({authorizeLocal:async()=>{checks++;return {...binding(),endpoint:'http://127.0.0.1:11434',nativeModel:'qwen3.5:9b'};}});
  await service.ready;const before=calls.length;
  const view=await service.handle('modelsProfileLocal',{modelRef:'ollama/qwen3.5:9b'}),target=view.targets.find(row=>row.mode==='ollama');
  assert.ok(target);assert.equal(calls.length,before);assert.equal(target.local,undefined);
  await service.handle('modelsProfileLocal',{modelRef:target.modelRef});assert.equal(service.targets.length,3);
  const review=await prepare(service,target.id);assert.equal(review.plan.max_requests,1);assert.equal(review.plan.call_timeout_seconds,45);assert.equal(review.plan.total_timeout_seconds,60);
  assert.equal(review.plan.max_output_tokens,128);assert.deepEqual(review.plan.configuration_ids,['config-false']);
  const planned=calls.find(call=>call.args[3]==='plan');assert.ok(planned.args.includes('--no-contrast'));
  assert.equal(calls.filter(call=>['start','resume'].includes(call.args[3])).length,0);
  await start(service,review);await service.runPromise;
  const after=service.overview().targets.find(row=>row.id===target.id);assert.equal(after.status.status,'paused');assert.equal(after.status.attempts,1);assert.equal(after.limitReached,true);assert.equal(after.canResume,false);
  const invocations=calls.filter(call=>['start','resume'].includes(call.args[3]));assert.equal(invocations.length,1);
  const args=invocations[0].args;assert.equal(args[args.indexOf('--backend')+1],'ollama');assert.equal(args[args.indexOf('--endpoint')+1],'http://127.0.0.1:11434');
  assert.equal(args[args.indexOf('--native-model')+1],'qwen3.5:9b');assert.equal(args[args.indexOf('--context-tokens')+1],'4096');assert.equal(args[args.indexOf('--output-cap')+1],'128');
  assert.ok(args[1].endsWith('local.sqlite3'));assert.equal(args.includes('--approve-host-runtime'),false);assert.equal(invocations[0].options.env.OPENCLAW_CONFIG_PATH,undefined);
  assert.ok(checks>=6);await assert.rejects(service.handle('modelsProfilePlan',{targetId:target.id}));await service.close();
});
test('local requests cannot supply endpoint, expand reasoning, bypass native permission or reuse changed connection',async()=>{
  let allow=true,native={...binding(),endpoint:'http://127.0.0.1:11434',nativeModel:'qwen3.5:9b'};
  const {service,calls}=fake({authorizeLocal:async()=>{if(!allow)throw Object.assign(new Error('Native permission unavailable'),{code:'UNAVAILABLE'});return {...native};}});
  await service.ready;
  await assert.rejects(service.handle('modelsProfileLocal',{modelRef:'ollama/qwen3.5:9b',endpoint:'https://remote'}),{code:'INVALID'});
  await assert.rejects(service.handle('modelsProfileLocal',{modelRef:'ollama/remote:cloud'}),{code:'INVALID'});
  allow=false;await assert.rejects(service.handle('modelsProfileLocal',{modelRef:'ollama/qwen3.5:9b'}),{code:'UNAVAILABLE'});assert.equal(service.targets.length,2);
  allow=true;await service.handle('modelsProfileLocal',{modelRef:'ollama/qwen3.5:9b'});const id=service.targets[2].id;
  const review=await prepare(service,id);native.endpoint='http://127.0.0.1:22000';await assert.rejects(start(service,review),{code:'STALE'});
  native.endpoint='http://127.0.0.1:11434';const next=await service.handle('modelsProfilePlan',{targetId:id});service.invalidateConnection();await assert.rejects(start(service,next),{code:'STALE'});
  assert.equal(calls.filter(call=>['start','resume'].includes(call.args[3])).length,0);await service.close();
});
test('local smoke fails before a plan if GCB does not research the exact boolean false configuration',async()=>{
  const {service,calls}=fake({onCall:({args,result})=>args[2]==='bio'?{stdout:JSON.stringify({...result,configurations:[{configuration_id:'config-true',native:{think:true,options:{num_ctx:4096,num_predict:128}}}]})}:undefined});
  await service.ready;await service.handle('modelsProfileLocal',{modelRef:'ollama/qwen3.5:9b'});const id=service.targets[2].id;
  await service.handle('modelsProfileResearch',{targetId:id});await assert.rejects(service.handle('modelsProfilePlan',{targetId:id}),{code:'UNAVAILABLE'});
  assert.equal(calls.some(call=>call.args[3]==='plan'),false);await service.close();
});
test('installed GCB runs offline research, pause/resume, persistence, bios and previews unchanged',{skip:!fs.existsSync(executable)},async()=>{
  const directory=temporary(),service=new GcbService({directory,executable});const review=await prepare(service);
  assert.equal(review.plan.evidence_kind,'synthetic_fixture');assert.equal(service.targets[0].status.attempts,0);
  await start(service,review);await service.handle('modelsProfilePause',{targetId:'forge'});await service.runPromise;
  const partial=service.overview().targets[0];assert.equal(partial.status.status,'paused');assert.equal(partial.status.attempts,1);await service.close();
  const restored=new GcbService({directory});await restored.ready;assert.equal(restored.targets[0].status.attempts,1);
  const resumed=await restored.handle('modelsProfilePlan',{targetId:'forge',contrast:false});assert.equal(resumed.resumed,true);assert.equal(resumed.plan.plan_id,review.plan.plan_id);
  await start(restored,resumed);await restored.runPromise;const complete=restored.overview().targets[0];assert.equal(complete.status.status,'complete');
  assert.ok(complete.bio.configurations.length>1);assert.ok(complete.bio.configurations.some(row=>row.weaknesses.length));
  const routes=await restored.handle('modelsProfilePreview',{targetId:'forge'});assert.ok(routes.routes.every(row=>row.preview.enforcement==='preview_only'));
  assert.equal(fs.statSync(path.join(directory,'profiles.json')).mode&0o777,0o600);await restored.close();
});
