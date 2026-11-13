'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateRequest, capabilities, catalogResult, nativeSetupUrl, readNative } = require('../desktop/src/model-rpc.cjs');
const { CliTransport } = require('../desktop/src/gateway-cli.cjs');
const endpoint = 'ws://127.0.0.1:19999';
const config = {gateway:{mode:'local',bind:'loopback',port:19999,auth:{mode:'token'}}};
const hello = {protocol:4,server:{version:'2026.11.1'},features:{methods:['models.list','models.probe','config.patch'],capabilities:['published-model-catalog']}};
function harness({handshake=hello,result={models:[]},disconnect=false,hold=false}={}) {
  const seen = {requests:[],stops:0,starts:0};
  class GatewayClient {
    constructor(options) { seen.options=options; }
    start() { seen.starts++; if(!hold)queueMicrotask(()=>disconnect?seen.options.onClose():seen.options.onHelloOk(handshake)); }
    async request(method, params) {seen.requests.push({method,params});return result;}
    stop() {seen.stops++;seen.options.onClose();}
  }
  return {seen,GatewayClient};
}
test('model reads are endpoint-pinned and cannot invoke arbitrary or mutating operations',()=>{
  for(const op of ['capabilities','catalog'])validateRequest(op,endpoint);
  for(const op of ['discover','authStatus','models.probe','models.authLogin','config.patch','agent','chat.send'])assert.throws(()=>validateRequest(op,endpoint));
  for(const url of ['ws://evil:19999','wss://127.0.0.1:19999','ws://127.0.0.1:0','ws://127.0.0.1:65536','ws://127.0.0.1:19999/','ws://user@127.0.0.1:19999'])assert.throws(()=>validateRequest('catalog',url));
  assert.throws(()=>validateRequest('catalog',endpoint,['extra']));
});
test('capabilities are negotiated without exact-release binding or a post-connect RPC',async()=>{
  const h=harness({handshake:{...hello,server:{version:'2027.1.0-preview'}}});
  const result=await readNative('capabilities',endpoint,{...h,config,resolved:{value:'secret-fixture'}});
  assert.equal(result.available,true);assert.equal(result.version,'2027.1.0-preview');assert.deepEqual(h.seen.requests,[]);
  assert.deepEqual(h.seen.options.scopes,['operator.read']);assert.deepEqual(h.seen.options.caps,['model-selection-policy']);
  assert.equal(h.seen.options.sharedStateMode,'read-only');assert.equal(h.seen.options.deviceIdentity,null);assert.equal(h.seen.stops,1);
  assert.doesNotMatch(JSON.stringify(result),/secret-fixture|models.probe|config.patch/);
});
test('catalog makes one prepared request and strips unsupported/private response fields',async()=>{
  const h=harness({result:{models:[{provider:'fixture',id:'nested/model',name:'Fixture',available:true,manualSelectionAllowed:false,
    input:['text','image','private'],reasoning:true,thinkingLevels:[{id:'high',label:'High',token:'private'}],agentRuntime:{id:'runtime',credential:'private'},apiKey:'private',endpoint:'https://secret',unavailableReason:'raw-secret'}],authProfiles:[{token:'private'}]}});
  const result=await readNative('catalog',endpoint,{...h,config,resolved:{value:'secret-fixture'}});
  assert.deepEqual(h.seen.requests,[{method:'models.list',params:{view:'default',preparedOnly:true,includeDetails:true,includeProviderCapabilities:true}}]);
  assert.deepEqual(result.models[0].thinkingLevels,[{id:'high',label:'High'}]);assert.deepEqual(result.models[0].agentRuntime,{id:'runtime'});
  assert.equal(result.models[0].manualSelectionAllowed,false);assert.doesNotMatch(JSON.stringify(result),/private|secret|endpoint|token|authProfiles/);
});
test('unsupported catalogs, missing capability and malformed replies fail closed before assumptions',async()=>{
  for(const features of [{methods:['models.list'],capabilities:[]},{methods:[],capabilities:['published-model-catalog']}]){
    const h=harness({handshake:{...hello,features}});
    await assert.rejects(readNative('catalog',endpoint,{...h,config,resolved:{value:'fixture'}}),{code:'UNSUPPORTED'});assert.equal(h.seen.requests.length,0);
  }
  assert.throws(()=>capabilities({protocol:4,server:{version:'x'},features:{methods:'models.list'}}));
  assert.throws(()=>catalogResult({data:[]}));
});
test('unqualified target/auth, disconnect and timeout do not retry or fall back to broader privileges',async()=>{
  const h=harness();
  await assert.rejects(readNative('catalog',endpoint,{...h,config:{...config,gateway:{...config.gateway,port:19998}},resolved:{value:'fixture'}}));
  assert.equal(h.seen.starts,0);
  for(const variant of [{disconnect:true},{hold:true}]){
    const h=harness(variant);await assert.rejects(readNative('catalog',endpoint,{...h,config,resolved:{value:'fixture'},deadline:20}));
    assert.equal(h.seen.starts,1);assert.equal(h.seen.stops,1);assert.equal(h.seen.requests.length,0);
  }
});
test('native onboarding path is fixed under the configured local Control UI base',()=>{
  assert.equal(nativeSetupUrl({originalUrl:'http://127.0.0.1:19999/',controlUiBasePath:'/personal/ui/'}),'http://127.0.0.1:19999/personal/ui/settings/model-setup');
  for(const originalUrl of ['https://evil.example/','http://localhost:19999/','http://user:token@127.0.0.1/','http://127.0.0.1/?token=private'])assert.throws(()=>nativeSetupUrl({originalUrl}));
  for(const controlUiBasePath of ['//evil/../','/a?token=x','/../','/a%2f../','/a\\b'])assert.throws(()=>nativeSetupUrl({originalUrl:'http://127.0.0.1:19999/',controlUiBasePath}));
});
test('model transport uses bounded shared read queue and contains no arbitrary params or token override',async()=>{
  let seen;
  const transport=new CliTransport({home:'/fixture',target:{url:endpoint,configPath:'/fixture/config.json'},execute(node,args,options,done){seen={node,args,options};queueMicrotask(()=>done(null,'{"models":[]}'));return {kill(){}};}});
  await transport.modelRead('catalog');assert.match(seen.args[0],/model-rpc\.cjs$/);assert.deepEqual(seen.args.slice(1),['catalog',endpoint]);
  assert.equal(seen.options.shell,false);assert.equal(seen.options.env.OPENCLAW_GATEWAY_TOKEN,undefined);assert.equal(seen.options.env.NODE_OPTIONS,undefined);
  assert.equal(seen.options.maxBuffer,4*1024*1024);await assert.rejects(transport.modelRead('discover'),{code:'DENIED'});transport.close();
  const fixture=new CliTransport({home:'/fixture',target:{url:endpoint},cli:'/fixture/test.cjs'});
  await assert.rejects(fixture.modelRead('catalog'),{code:'UNAVAILABLE'});fixture.close();
});
