'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {GcbService}=require('../desktop/src/gcb-service.cjs');
const clone=value=>JSON.parse(JSON.stringify(value));
function evidence() {
  return {plan:{model_id:'forge',evidence_kind:'synthetic_fixture'},status:{plan_id:'plan-forge'},
    cells:[{cell_id:'cell-one',configuration_id:'config-forge',case_id:'coding.guard',status:'observed',observation:{correct:true,
      evaluation:{criterion:{missing_guard:'empty_items'},outcome:'exact_match',allowlisted_fixture_output:{missing_guard:'empty_items'},other_output_retained:false}}},
      {cell_id:'cell-two',configuration_id:'config-forge',case_id:'review.risks',status:'observed',observation:{correct:false,
        evaluation:{criterion:{risks:['log_secret','unbounded_retry']},outcome:'structured_mismatch',allowlisted_fixture_output:null,other_output_retained:false}}}],
    attempts:[{id:'attempt-one',plan_id:'plan-forge',cell_id:'cell-one',status:'completed',started_at:'1794900000.1',ended_at:'1794900000.2',summary_json:{
      latency_ms:100,usage:{input_tokens:114,output_tokens:8,reasoning_tokens:null,billed_cost_usd:null},served_model:'qwen3.5:9b',
      output_sha256:'a'.repeat(64),finish_reason:'stop',native_confirmation:'request_only_not_echoed',effective_native_settings_known:false,
      output:'PRIVATE_RAW_RESPONSE',thinking:'PRIVATE_THINKING',credential:'PRIVATE_CREDENTIAL'}}],raw:'PRIVATE_ROOT_FIELD'};
}
async function fixture(result=evidence()) {
  const calls=[],directory=fs.mkdtempSync(path.join(os.tmpdir(),'gcb-evidence-'));
  const service=new GcbService({directory,executable:process.execPath,execute(file,args,options,done){
    calls.push({file,args:[...args],options});const value=args[0]==='doctor'?{python:'3.14.6',runtime_dependencies:[],network_probes:false}:result;
    queueMicrotask(()=>done(null,JSON.stringify(value)));return {kill(){}};
  }});
  await service.ready;
  const target=service.targets[0];target.plan={plan_id:'plan-forge',model_id:'forge',configuration_ids:['config-forge'],cells:evidence().cells.map(({cell_id,case_id,configuration_id})=>({cell_id,case_id,configuration_id}))};
  target.bio={configurations:[{configuration_id:'config-forge',native:{think:false,options:{num_ctx:4096,num_predict:128}}}]};
  return {service,target,calls,directory};
}
test('recorded response uses one scoped evidence read, keeps criterion separate and never persists response data',async()=>{
  const f=await fixture();try{
    const index=path.join(f.directory,'profiles.json'),before=fs.readFileSync(index,'utf8'),count=f.calls.length;
    const result=await f.service.handle('modelsProfileEvidence',{targetId:'forge'});
    assert.equal(f.calls.length,count+1);assert.deepEqual(f.calls.at(-1).args,['--db',path.join(f.directory,'offline.sqlite3'),'evidence','plan-forge']);
    assert.equal(f.calls.at(-1).options.shell,false);assert.equal(f.calls.at(-1).options.env.OPENCLAW_CONFIG_PATH,undefined);
    assert.equal(result.targetId,'forge');assert.equal(result.planId,'plan-forge');assert.equal(result.records.length,2);
    const first=result.records[0],second=result.records[1];assert.deepEqual(first.response,{availability:'retained',value:{missing_guard:'empty_items'}});
    assert.equal(first.score,true);assert.equal(first.outcome,'exact_match');assert.deepEqual(first.requestedNative,{think:false,options:{num_ctx:4096,num_predict:128}});
    assert.deepEqual(second.response,{availability:'not_retained',value:null});assert.deepEqual(second.criterion,{risks:['log_secret','unbounded_retry']});assert.equal(second.score,false);
    assert.equal(first.attempts[0].startedAt,1794900000.1);assert.equal(first.attempts[0].latencyMs,100);assert.equal(first.attempts[0].usage.output_tokens,8);
    assert.equal(first.attempts[0].usage.billed_cost_usd,null);assert.equal(first.attempts[0].effectiveNativeKnown,false);
    assert.equal(JSON.stringify(result).includes('PRIVATE_'),false);assert.equal(JSON.stringify(f.service.overview()).includes('missing_guard'),false);
    assert.equal(fs.readFileSync(index,'utf8'),before);assert.equal(fs.existsSync(path.join(f.directory,'offline.sqlite3')),false);
  }finally{await f.service.close();}
});
test('response details require only exact targetId and an existing plan, never caller paths or plan IDs',async()=>{
  const f=await fixture();try{
    const count=f.calls.length;
    for(const value of [{targetId:'forge',planId:'other'},{targetId:'forge',db:'/private/store'},{targetId:'forge',authorize:true},{targetId:'missing'},{}])
      await assert.rejects(f.service.handle('modelsProfileEvidence',value));
    delete f.target.plan;await assert.rejects(f.service.handle('modelsProfileEvidence',{targetId:'forge'}));assert.equal(f.calls.length,count);
  }finally{await f.service.close();}
});
test('foreign plan, model, cell, configuration, case and attempt records fail closed',async()=>{
  for(const mutate of [value=>value.status.plan_id='other',value=>value.plan.model_id='scribe',value=>value.cells[0].cell_id='other',
    value=>value.cells[0].configuration_id='other',value=>value.cells[0].case_id='other',value=>value.attempts[0].plan_id='other',
    value=>value.attempts[0].cell_id='other',value=>value.cells.pop(),value=>value.cells.push(clone(value.cells[0]))]) {
    const value=evidence();mutate(value);const f=await fixture(value);try{await assert.rejects(f.service.handle('modelsProfileEvidence',{targetId:'forge'}),{code:'GCB'});}finally{await f.service.close();}
  }
});
test('evidence projection caps arrays and retained JSON without silently truncating a response',async()=>{
  for(const mutate of [value=>value.cells=Array(129).fill(value.cells[0]),value=>value.attempts=Array(65).fill(value.attempts[0]),
    value=>value.cells[0].observation.evaluation.allowlisted_fixture_output={long:'x'.repeat(8193)},value=>value.cells[0].observation.evaluation.criterion='x'.repeat(8193)]) {
    const value=evidence();mutate(value);const f=await fixture(value);try{await assert.rejects(f.service.handle('modelsProfileEvidence',{targetId:'forge'}),{code:'GCB'});}finally{await f.service.close();}
  }
});
test('pending and unsupported checks have explicit missing responses and never infer actual output from criterion',async()=>{
  const value=evidence();value.cells[0].status='pending';value.cells[1].status='not_applicable';value.cells[1].observation.correct=null;
  const f=await fixture(value);try{
    const result=await f.service.handle('modelsProfileEvidence',{targetId:'forge'});
    assert.deepEqual(result.records[0].response,{availability:'pending',value:null});assert.deepEqual(result.records[1].response,{availability:'not_applicable',value:null});
    assert.equal(result.records[1].score,null);
  }finally{await f.service.close();}
});
