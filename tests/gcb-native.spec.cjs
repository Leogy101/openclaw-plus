'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { authorizeProfileTarget, authorizeLocalProfileTarget } = require('../desktop/src/gcb-native.cjs');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const { CliTransport, ReadError } = require('../desktop/src/gateway-cli.cjs');
function fixture() {
  const snapshot = { model_ref:'openai/gpt-fixture',agent_id:'fixture-agent',openclaw_version:'2026.11.1',context_window:32000,reasoning_settings:['medium'],selected_reasoning:'medium' };
  const model = { modelRef:snapshot.model_ref,available:true,manualSelectionAllowed:true,contextWindow:32000,thinkingLevels:[{id:'medium'}],metadataFingerprint:'fingerprint' };
  const view = { connection:{status:'connected'},catalog:{stale:false,models:[model]} };
  const response = {status:'subscription_route_verified',readiness:{state:'ready'},result:{agentId:snapshot.agent_id,model:snapshot.model_ref,hostVersion:snapshot.openclaw_version,metadataOnly:true,authRequirement:'subscription',allowedReasoning:['medium']}};
  const calls=[];
  const owner={generation:0,assertCurrent(value){if(value!==this.generation)throw new ReadError('STALE','Changed');},transport:{version:'2026.11.1',async request(method,params){calls.push({method,params});return response;}}};
  const context={models:{async handle(operation,input){assert.equal(operation,'modelsRefresh');assert.deepEqual(input,{});},overview(){return view;}},gateway:()=>owner};
  return {snapshot,model,view,response,calls,owner,context};
}
test('GCB readiness uses exact native catalog and subscription preflight only',async()=>{
  const f=fixture();const result=await authorizeProfileTarget(f.context,f.snapshot);
  assert.equal(result.metadataFingerprint,'fingerprint');
  assert.deepEqual(f.calls,[{method:'gcb.profile.preflight',params:{expectedHostVersion:'2026.11.1',model:'openai/gpt-fixture'}}]);
});
test('disconnected, denied, changed and invalid catalog metadata cannot reach preflight',async()=>{
  for(const mutate of [f=>f.view.catalog.stale=true,f=>f.view.connection.status='disconnected',f=>f.model.available=false,f=>f.model.manualSelectionAllowed=null,f=>f.model.contextWindow=64000,f=>f.model.thinkingLevels=[],f=>f.owner.transport.version='changed']){
    const f=fixture();mutate(f);await assert.rejects(authorizeProfileTarget(f.context,f.snapshot));assert.equal(f.calls.length,0);
  }
});
test('bridge identity, authorization, readiness and scope cannot be inferred',async()=>{
  for(const mutate of [f=>f.response.status='failed',f=>f.response.readiness.state='temporarily_unavailable',f=>f.response.result.model='openai/gpt-other',f=>f.response.result.agentId='other',f=>f.response.result.authRequirement='api_key',f=>f.response.result.allowedReasoning=[],f=>f.response.result.metadataOnly=false]){
    const f=fixture();mutate(f);await assert.rejects(authorizeProfileTarget(f.context,f.snapshot),{code:'UNAVAILABLE'});assert.equal(f.calls.length,1);
  }
});
test('legacy preflight fallback remains metadata-only and validates exact returned model',async()=>{
  const f=fixture();f.owner.transport.request=async(method,params)=>{f.calls.push({method,params});return params.model?{code:'BRIDGE_INPUT_REJECTED'}:f.response;};
  await authorizeProfileTarget(f.context,f.snapshot);assert.equal(f.calls.length,2);assert.deepEqual(f.calls[1].params,{expectedHostVersion:'2026.11.1'});
  f.response.result.model='openai/gpt-other';await assert.rejects(authorizeProfileTarget(f.context,f.snapshot),{code:'UNAVAILABLE'});
});
test('connection replacement during preflight rejects the reviewed result',async()=>{
  const f=fixture();f.owner.transport.request=async()=>{f.owner.generation++;return f.response;};
  await assert.rejects(authorizeProfileTarget(f.context,f.snapshot),{code:'STALE'});
});
test('only preflight is added to the native read lane; profiling and routing writes remain denied',async()=>{
  let invocation;
  const transport=new CliTransport({home:'/fixture',target:{url:'ws://127.0.0.1:19999',configPath:'/fixture/openclaw.json'},execute(node,args,options,done){invocation={node,args,options};queueMicrotask(()=>done(null,JSON.stringify({status:'subscription_route_verified'})));return {kill(){}};}});
  for(const method of ['gcb.profile.complete','gcb.profile.cancel','gcb.route','plugins.setEnabled'])await assert.rejects(transport.request(method,{}),{code:'DENIED'});
  await transport.request('gcb.profile.preflight',{expectedHostVersion:'2026.11.1',model:'openai/gpt-fixture'});
  assert.equal(invocation.options.shell,false);assert.equal(invocation.args.includes('--expect-url'),true);assert.equal(invocation.options.env.OPENCLAW_GATEWAY_TOKEN,undefined);transport.close();
});
function localFixture() {
  const f=fixture(),directory=fs.mkdtempSync(path.join(os.tmpdir(),'gcb-local-native-')),configPath=path.join(directory,'openclaw.json');
  const config={models:{providers:{ollama:{api:'ollama',baseUrl:'http://127.0.0.1:11434',apiKey:'PRIVATE_CANARY',models:[{id:'qwen3.5:9b'}]}}}};
  const save=()=>fs.writeFileSync(configPath,JSON.stringify(config),{mode:0o600});save();
  Object.assign(f.model,{modelRef:'ollama/qwen3.5:9b',provider:'ollama',id:'qwen3.5:9b',local:true});
  f.owner.transport.target={configPath,url:'ws://127.0.0.1:18789'};
  return {...f,config,configPath,save};
}
test('local profiling pins only existing native Ollama selection and configured loopback endpoint',async()=>{
  const f=localFixture(),result=await authorizeLocalProfileTarget(f.context,f.model.modelRef);
  assert.equal(result.endpoint,'http://127.0.0.1:11434');assert.equal(result.nativeModel,'qwen3.5:9b');assert.equal(result.metadataFingerprint,'fingerprint');
  assert.equal(result.configPath,f.configPath);assert.equal(JSON.stringify(result).includes('PRIVATE_CANARY'),false);assert.equal(f.calls.length,0);
});
test('local metadata checks reject denied, disconnected, remote, ambiguous and unsupported native routes',async()=>{
  for(const mutate of [f=>f.model.available=false,f=>f.model.manualSelectionAllowed=false,f=>f.model.local=false,
    f=>f.view.catalog.stale=true,f=>f.view.connection.status='disconnected',f=>f.model.provider='other',
    f=>f.config.models.providers.ollama.baseUrl='http://localhost:11434',f=>f.config.models.providers.ollama.baseUrl='https://example.test',
    f=>f.config.models.providers.ollama.api='openai-completions',f=>f.config.models.providers.ollama.models=[],
    f=>f.config.models.providers.ollama.models.push({id:'qwen3.5:9b'}),f=>f.config.models.providers.ollama.headers={Authorization:'PRIVATE_CANARY'}]) {
    const f=localFixture();mutate(f);f.save();await assert.rejects(authorizeLocalProfileTarget(f.context,'ollama/qwen3.5:9b'));assert.equal(f.calls.length,0);
  }
});
test('local metadata reader refuses unsafe or replaced configuration files without leaking values',async()=>{
  const f=localFixture();fs.chmodSync(f.configPath,0o644);await assert.rejects(authorizeLocalProfileTarget(f.context,f.model.modelRef),{code:'CONFIG'});
  fs.chmodSync(f.configPath,0o600);const elsewhere=path.join(path.dirname(f.configPath),'copy.json');fs.renameSync(f.configPath,elsewhere);fs.symlinkSync(elsewhere,f.configPath);
  await assert.rejects(authorizeLocalProfileTarget(f.context,f.model.modelRef),{code:'CONFIG'});
});
