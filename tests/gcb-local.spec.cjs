'use strict';
// Installed public GCB + a request-recording fake Ollama server. No real models.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {GcbService}=require('../desktop/src/gcb-service.cjs');
const executable=process.env.OPENCLAW_PLUS_TEST_GCB||path.resolve(__dirname,'../.cache/gcb-runtime/bin/gcb');
const enabled=fs.existsSync(executable);
async function fixture({hold=false}={}) {
  const requests=[],state={digest:'a'.repeat(64),thinking:{values:[false,true],default:true}};let entered;
  const dispatched=new Promise(resolve=>{entered=resolve;});
  const server=http.createServer(async(request,response)=>{
    let bytes='';for await(const chunk of request)bytes+=chunk;const body=bytes?JSON.parse(bytes):undefined;
    requests.push({method:request.method,path:request.url,body,headers:request.headers});
    let result;
    if(request.method==='GET'&&request.url==='/api/version')result={version:'0.40.15'};
    else if(request.method==='GET'&&request.url==='/api/tags')result={models:[{name:'qwen3.5:9b',digest:state.digest,size:6000000000,details:{format:'gguf',quantization_level:'Q4_K_M'}}]};
    else if(request.method==='POST'&&request.url==='/api/show')result={capabilities:['completion','tools','thinking'],thinking:state.thinking,
      details:{format:'gguf',quantization_level:'Q4_K_M'},model_info:{'general.architecture':'qwen35','qwen35.context_length':262144},
      parameters:'temperature 0.6',system:'PRIVATE_SYSTEM_NOT_FOR_PROFILE',template:'PRIVATE_TEMPLATE_NOT_FOR_PROFILE'};
    else if(request.method==='POST'&&request.url==='/api/chat') {
      entered();if(hold)return;
      result={model:'qwen3.5:9b',done:true,done_reason:'stop',message:{role:'assistant',content:'{"missing_guard":"empty_items"}'},
        prompt_eval_count:114,eval_count:8,total_duration:5000000,load_duration:1000000,prompt_eval_duration:2000000,eval_duration:2000000};
    } else {response.writeHead(404);response.end('{}');return;}
    response.setHeader('Content-Type','application/json');response.end(JSON.stringify(result));
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const endpoint=`http://127.0.0.1:${server.address().port}`,directory=fs.mkdtempSync(path.join(os.tmpdir(),'gcb-local-engine-'));
  const service=new GcbService({directory,executable,authorizeLocal:async()=>({metadataFingerprint:'fixture-catalog',connectionGeneration:1,
    configPath:'/fixture/openclaw.json',url:'ws://127.0.0.1:18789',endpoint,nativeModel:'qwen3.5:9b'})});
  await service.ready;
  const close=async()=>{await service.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));};
  return {service,requests,state,dispatched,close};
}
async function prepare(service) {
  await service.handle('modelsProfileLocal',{modelRef:'ollama/qwen3.5:9b'});const id=service.targets.find(target=>target.mode==='ollama').id;
  await service.handle('modelsProfileResearch',{targetId:id});return service.handle('modelsProfilePlan',{targetId:id,contrast:true});
}
const start=(service,review)=>service.handle('modelsProfileStart',{reviewToken:review.reviewToken,approveUsage:true,approveHostRuntime:false});

test('installed GCB local smoke sends one exact false/4096/128 mock request and returns a partial bio',{skip:!enabled},async()=>{
  const f=await fixture();
  try {
    const review=await prepare(f.service);assert.equal(f.requests.some(row=>row.path==='/api/chat'),false);
    assert.equal(review.plan.max_requests,1);assert.equal(review.plan.max_output_tokens,128);assert.equal(review.plan.call_timeout_seconds,45);assert.equal(review.plan.total_timeout_seconds,60);
    assert.equal(review.plan.cells.length,8);assert.equal(review.plan.cells[0].case_id,'coding.guard');
    const baseline=review.target.bio.configurations.find(row=>row.configuration_id===review.plan.configuration_ids[0]);assert.deepEqual(baseline.native,{think:false,options:{num_ctx:4096,num_predict:128}});
    await start(f.service,review);await f.service.runPromise;
    const target=f.service.overview().targets.find(row=>row.id===review.target.id),chats=f.requests.filter(row=>row.path==='/api/chat');
    assert.equal(chats.length,1);assert.equal(chats[0].body.model,'qwen3.5:9b');assert.equal(chats[0].body.think,false);assert.equal(chats[0].body.stream,false);
    assert.deepEqual(chats[0].body.options,{num_ctx:4096,num_predict:128});assert.equal(chats[0].body.tools,undefined);
    assert.equal(target.status.status,'paused');assert.equal(target.status.attempts,1);assert.equal(target.status.cells.observed,1);assert.equal(target.status.cells.pending,7);
    assert.equal(target.limitReached,true);assert.equal(target.canResume,false);assert.equal(target.bio.evidence_kind,'local_model');
    const config=target.bio.configurations.find(row=>row.native.think===false);assert.equal(config.categories.coding.correct,1);assert.equal(config.usage.output_tokens,8);
    assert.equal(config.usage.billed_cost_usd,null);assert.equal(config.native_confirmations[0],'request_only_not_echoed');
    assert.equal(JSON.stringify(target).includes('PRIVATE_SYSTEM'),false);assert.equal(JSON.stringify(target).includes('PRIVATE_TEMPLATE'),false);
    assert.ok(f.requests.every(row=>row.headers.authorization===undefined));
    await assert.rejects(f.service.handle('modelsProfilePlan',{targetId:target.id}));assert.equal(chats.length,1);
  } finally {await f.close();}
});
test('real GCB metadata drift is rejected before the fake chat endpoint and does not fall back',{skip:!enabled},async()=>{
  const f=await fixture();try{
    const review=await prepare(f.service);f.state.digest='b'.repeat(64);await start(f.service,review);await f.service.runPromise;
    const target=f.service.overview().targets.find(row=>row.id===review.target.id);
    assert.equal(f.requests.filter(row=>row.path==='/api/chat').length,0);assert.equal(target.status.attempts,1);assert.equal(target.status.cells.technical_error,1);
    assert.equal(target.limitReached,true);
  }finally{await f.close();}
});
test('real GCB cancellation retains unknown completion and blocks replay of a held fake request',{skip:!enabled},async()=>{
  const f=await fixture({hold:true});try{
    const review=await prepare(f.service);await start(f.service,review);
    await Promise.race([f.dispatched,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Fake request was not dispatched')),10000);timer.unref();})]);
    await f.service.handle('modelsProfileCancel',{targetId:review.target.id});await f.service.runPromise;
    const target=f.service.overview().targets.find(row=>row.id===review.target.id);
    assert.equal(target.status.status,'partial_unknown');assert.equal(target.status.cells.unknown_completion,1);assert.equal(target.canResume,false);
    await assert.rejects(f.service.handle('modelsProfilePlan',{targetId:target.id}),{code:'UNCERTAIN'});
    assert.equal(f.requests.filter(row=>row.path==='/api/chat').length,1);
  }finally{await f.close();}
});
