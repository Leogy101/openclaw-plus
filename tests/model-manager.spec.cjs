'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { ModelManagerService } = require('../desktop/src/model-manager.cjs');
const { ReadError } = require('../desktop/src/gateway-cli.cjs');
const logic = import('../desktop/shared/model-manager.mjs');
const capabilities = { available: true, version: 'fixture-new-release', protocol: 4, methods: ['models.list'],
  capabilities: ['published-model-catalog','session-scoped-model-catalog'], clientCaps: ['model-selection-policy'] };
const row = { provider: 'example', id: 'author/model-v1', name: 'Fixture model', available: true,
  manualSelectionAllowed: true, thinkingLevels: [{id:'off',label:'Off'},{id:'high',label:'High'}],
  thinkingDefault: 'high', reasoning: true, input: ['text','image'], supportsTools: true,
  contextWindow: 32000, local: false, agentRuntime: { id: 'openclaw' }, apiKeySupported: true };
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
const providerSetup = {status:'available',source:'installed-openclaw-metadata',version:'fixture',limitations:[],
  items:[{id:'example',label:'Example',providerIds:['example'],methods:[{id:'example-key',label:'Example API key'}]},
    {id:'not-configured',label:'Not configured',providerIds:['not-configured'],methods:[]}]};

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'openclaw-model-manager-'));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  const registryPath = path.join(root,'ModelManager','registry.json');
  const calls = []; let now = 1000000, catalog = {models:[structuredClone(row)]}, offline = false;
  const base = { generation: 0, assertCurrent(value) { if(value !== this.generation) throw new ReadError('STALE','Fixture reconnect.'); },
    transport: { async modelRead(operation) {
      calls.push(operation); if(offline) throw new ReadError('CONNECTION','Private raw failure must not escape.');
      if(overrides.read) return overrides.read(operation);
      if(operation==='capabilities') return structuredClone(capabilities);
      if(operation==='catalog') return structuredClone(catalog);
      throw new Error('Unexpected native operation: '+operation);
    } } };
  const options = {gateway:()=>base,registryPath,now:()=>now,providerOptions:overrides.providerOptions || (()=>structuredClone(providerSetup))};
  const service = new ModelManagerService(options);
  return {service,base,calls,registryPath,root,setCatalog:value=>{catalog=value;},offline:value=>{offline=value;},tick:ms=>{now+=ms;},
    restart:()=>new ModelManagerService(options)};
}
async function register(service, params={modelRef:'example/author/model-v1',reasoning:'high'}) {
  const plan=await service.handle('modelsPlanRegistration',params);
  return service.handle('modelsRegister',{reviewToken:plan.reviewToken,registryRevision:plan.registryRevision});
}

test('closed Model Manager operations cannot request discovery, auth, writes or evidence imports',async t=>{
  const f=fixture(t);
  for(const [operation,input] of [['modelsDiscover',{}],['modelsRefresh',{reviewToken:'x'}],['modelsOverview',{agentId:'main'}],
    ['modelsRegister',{reviewToken:'x',registryRevision:0,evidence:{status:'passed'}}],['modelsOnboarding',{url:'https://invalid.test'}]]) {
    await assert.rejects(f.service.handle(operation,input),{code:'INVALID'});
  }
  assert.deepEqual(await f.service.handle('modelsOnboarding',{}),{kind:'open-original-models',nativeChanges:false});
  assert.deepEqual(f.calls,[]);
});

test('overview coalesces passive reads; explicit refresh repeats only prepared catalog reads',async t=>{
  const f=fixture(t);
  const [a,b]=await Promise.all([f.service.handle('modelsOverview',{}),f.service.handle('modelsOverview',{})]);
  assert.equal(a.connection.status,'connected'); assert.equal(b.catalog.models.length,1);
  await f.service.handle('modelsOverview',{});
  assert.deepEqual(f.calls,['capabilities','catalog']);
  const refreshed=await f.service.handle('modelsRefresh',{});
  assert.equal(refreshed.routing,'preview-only'); assert.equal(refreshed.execution,'unavailable');
  assert.deepEqual(f.calls,['capabilities','catalog','capabilities','catalog']);
  assert.equal(refreshed.catalog.providers[0].authStatus,'not-checked');
});

test('setup choices are cached separately from published models and never persisted as model evidence',async t=>{
  let reads=0;
  const f=fixture(t,{providerOptions:()=>{reads++;return structuredClone(providerSetup);}});
  const first=await f.service.handle('modelsOverview',{});
  assert.equal(first.providerSetup.items.length,2); assert.equal(first.catalog.models.length,1);
  assert.equal(first.catalog.providers.length,1); assert.equal(first.registry.items.length,0);
  assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(f.registryPath,'utf8'))).includes('not-configured'),false);
  await f.service.handle('modelsOverview',{}); assert.equal(reads,1);
  f.tick(300001); await f.service.handle('modelsOverview',{}); assert.equal(reads,2);
  await f.service.handle('modelsRefresh',{}); assert.equal(reads,3);
  await assert.rejects(f.service.handle('modelsPlanRegistration',{modelRef:'not-configured/imaginary'}),{code:'INVALID'});
  assert.equal(f.calls.every(op=>op==='capabilities'||op==='catalog'),true);
});

test('local setup choices remain available without gateway telemetry; metadata failures do not hide catalog models',async t=>{
  let broken=false;
  const f=fixture(t,{providerOptions:()=>{if(broken)throw new Error('Private host path');return structuredClone(providerSetup);}});
  f.offline(true);
  const offline=await f.service.handle('modelsOverview',{});
  assert.equal(offline.providerSetup.items.length,2); assert.equal(offline.connection.status,'disconnected');
  assert.equal(offline.actions.canRegister,false);
  f.offline(false); broken=true;
  const connected=await f.service.handle('modelsRefresh',{});
  assert.equal(connected.providerSetup.status,'unavailable'); assert.equal(connected.catalog.models.length,1);
  assert.equal(connected.connection.status,'connected'); assert.equal(JSON.stringify(connected).includes('Private host path'),false);
  broken=false;
  assert.equal((await f.service.handle('modelsRefresh',{})).providerSetup.status,'available');
});

test('normalization preserves exact slash-containing IDs and never projects auth material',async t=>{
  const f=fixture(t); f.setCatalog({models:[{...row,apiKey:'synthetic-secret',baseUrl:'https://private.test',headers:{secret:'hidden'}}],
    providerOutcomes:[{provider:'example',profileId:'private-profile',status:'ready'}],accountSelection:{email:'private@example.test'}});
  const view=await f.service.handle('modelsOverview',{});
  assert.equal(view.catalog.models[0].modelRef,'example/author/model-v1');
  assert.deepEqual(view.catalog.models[0].thinkingLevels,row.thinkingLevels);
  assert.equal(view.catalog.providers[0].availability,'available');
  for(const secret of ['synthetic-secret','private.test','private-profile','private@example.test']) assert.equal(JSON.stringify(view).includes(secret),false);
  assert.equal(JSON.stringify(fs.readFileSync(f.registryPath,'utf8')).includes('synthetic-secret'),false);
});

test('missing capability stops new catalog fields without an exact release gate',async t=>{
  const f=fixture(t,{read:async op=>{assert.equal(op,'capabilities'); return {...capabilities,capabilities:[]};}});
  const view=await f.service.handle('modelsOverview',{});
  assert.equal(view.connection.status,'unsupported'); assert.equal(view.actions.canRegister,false);
  assert.deepEqual(f.calls,['capabilities']);
  await assert.rejects(f.service.handle('modelsPlanRegistration',{modelRef:'example/author/model-v1'}),{code:'UNAVAILABLE'});
});

test('conflicting duplicate references and malformed catalog rows are omitted explicitly',async()=>{
  const {normalizeCatalog}=await logic;
  const view=normalizeCatalog({models:[row,{...row,name:'Conflicting model'},{provider:'example',id:''}]});
  assert.equal(view.models.length,0); assert.equal(view.limitations.length,2);
  const unknown=normalizeCatalog({models:[{provider:'p',id:'id'}]}).models[0];
  assert.equal(unknown.available,null); assert.equal(unknown.manualSelectionAllowed,null); assert.equal(unknown.reasoning,null);
});

test('reviewed local reference persists with private modes and grants no qualification or admission',async t=>{
  const f=fixture(t); const plan=await f.service.handle('modelsPlanRegistration',{modelRef:'example/author/model-v1',reasoning:'high'});
  assert.equal(plan.review.nativeChanges,false); assert.equal(plan.review.reasoning,'high');
  const result=await f.service.handle('modelsRegister',{reviewToken:plan.reviewToken,registryRevision:plan.registryRevision});
  assert.equal(result.registryRevision,1); assert.equal(result.registered.status,'registered');
  assert.equal(result.registered.qualification,'pending'); assert.equal(result.registered.admission,'not-approved');
  assert.equal(result.registered.execution,'unavailable'); assert.equal(result.registered.routing,'preview-only');
  assert.equal(fs.statSync(f.registryPath).mode & 0o777,0o600);
  assert.equal(fs.statSync(path.dirname(f.registryPath)).mode & 0o777,0o700);
  assert.equal(fs.statSync(f.registryPath+'.previous').mode & 0o777,0o600);
  const disk=JSON.parse(fs.readFileSync(f.registryPath,'utf8'));
  assert.deepEqual(Object.keys(disk).sort(),['lastSnapshot','registrations','revision','schemaVersion']);
  assert.equal(JSON.stringify(disk).includes(plan.reviewToken),false);
  assert.equal(f.calls.every(op=>op==='capabilities'||op==='catalog'),true);
});

test('unavailable native model can be registered as a blocked reference without execution permission',async t=>{
  const f=fixture(t); f.setCatalog({models:[{...row,available:false,unavailableReason:'missing-auth',manualSelectionAllowed:false}]});
  const result=await register(f.service);
  assert.equal(result.registered.status,'blocked'); assert.equal(result.registered.admission,'not-approved');
});

test('reasoning is explicit and advertised; omitted reasoning does not invent a default',async t=>{
  const f=fixture(t);
  await assert.rejects(f.service.handle('modelsPlanRegistration',{modelRef:'example/author/model-v1',reasoning:'ultra'}),{code:'INVALID'});
  const result=await register(f.service,{modelRef:'example/author/model-v1'});
  assert.equal(result.registered.reasoning,null);
  await assert.rejects(f.service.handle('modelsPlanRegistration',{modelRef:'example/author/model-v1'}),{code:'CONFLICT'});
});

test('registration requires a current review and exact registry revision',async t=>{
  const f=fixture(t);
  const a=await f.service.handle('modelsPlanRegistration',{modelRef:'example/author/model-v1',reasoning:'high'});
  const b=await f.service.handle('modelsPlanRegistration',{modelRef:'example/author/model-v1',reasoning:'off'});
  await f.service.handle('modelsRegister',{reviewToken:a.reviewToken,registryRevision:a.registryRevision});
  await assert.rejects(f.service.handle('modelsRegister',{reviewToken:b.reviewToken,registryRevision:b.registryRevision}),{code:'CONFLICT'});
  await assert.rejects(f.service.handle('modelsRegister',{reviewToken:a.reviewToken,registryRevision:1}),{code:'STALE'});
  assert.equal(JSON.parse(fs.readFileSync(f.registryPath,'utf8')).registrations.length,1);
});

test('a changed catalog or expired review cannot save stale reviewed facts',async t=>{
  const f=fixture(t);
  const plan=await f.service.handle('modelsPlanRegistration',{modelRef:'example/author/model-v1'});
  f.setCatalog({models:[{...row,available:false}]});
  await assert.rejects(f.service.handle('modelsRegister',{reviewToken:plan.reviewToken,registryRevision:0}),{code:'STALE'});
  assert.equal(JSON.parse(fs.readFileSync(f.registryPath,'utf8')).registrations.length,0);
  const next=await f.service.handle('modelsPlanRegistration',{modelRef:'example/author/model-v1'});
  f.tick(300001);
  await assert.rejects(f.service.handle('modelsRegister',{reviewToken:next.reviewToken,registryRevision:0}),{code:'STALE'});
});

test('a review expiring during the final passive reload cannot commit',async t=>{
  const gate=deferred(); let block=false;
  const f=fixture(t,{read:async op=>op==='capabilities'?capabilities:block?gate.promise:{models:[row]}});
  const plan=await f.service.handle('modelsPlanRegistration',{modelRef:'example/author/model-v1'});
  block=true;
  const pending=f.service.handle('modelsRegister',{reviewToken:plan.reviewToken,registryRevision:0});
  await new Promise(resolve=>setImmediate(resolve)); f.tick(300001); gate.resolve({models:[row]});
  await assert.rejects(pending,{code:'STALE'});
  assert.equal(JSON.parse(fs.readFileSync(f.registryPath,'utf8')).registrations.length,0);
});

test('restart keeps local references and last snapshot unverified when offline; review tokens do not survive',async t=>{
  const f=fixture(t); await register(f.service);
  const plan=await f.service.handle('modelsPlanRegistration',{modelRef:'example/author/model-v1',reasoning:'off'});
  f.offline(true);
  const restarted=f.restart(); const view=await restarted.handle('modelsOverview',{});
  assert.equal(view.connection.status,'disconnected'); assert.equal(view.catalog.stale,true);
  assert.equal(view.registry.items.length,1); assert.equal(view.registry.items[0].status,'stale');
  assert.equal(view.actions.canRegister,false); assert.equal(JSON.stringify(view).includes('Private raw failure'),false);
  await assert.rejects(restarted.handle('modelsRegister',{reviewToken:plan.reviewToken,registryRevision:1}),{code:'STALE'});
});

test('metadata changes make existing references stale without inventing new qualification',async t=>{
  const f=fixture(t); await register(f.service);
  f.setCatalog({models:[{...row,agentRuntime:{id:'different-harness'}}]});
  const view=await f.service.handle('modelsRefresh',{});
  assert.equal(view.registry.items[0].status,'stale'); assert.equal(view.registry.items[0].qualification,'pending');
});

test('disconnect invalidates cache and reviews; late previous reads cannot revive a stale connection',async t=>{
  const gate=deferred(); let block=false;
  const f=fixture(t,{read:async op=>op==='capabilities'?capabilities:block?gate.promise:{models:[row]}});
  const plan=await f.service.handle('modelsPlanRegistration',{modelRef:'example/author/model-v1'});
  block=true; const pending=f.service.handle('modelsRefresh',{});
  await new Promise(resolve=>setImmediate(resolve)); f.service.invalidateConnection();
  gate.resolve({models:[row]}); const view=await pending;
  assert.equal(view.connection.status,'disconnected'); assert.equal(view.catalog.stale,true);
  await assert.rejects(f.service.handle('modelsRegister',{reviewToken:plan.reviewToken,registryRevision:0}),{code:'STALE'});
});

test('older pending completion cannot overwrite a newer reconnected inventory',async t=>{
  const old=deferred(); let reads=0;
  const f=fixture(t,{read:async op=>op==='capabilities'?capabilities:++reads===1?old.promise:{models:[{...row,name:'New connection'}]}});
  const first=f.service.handle('modelsOverview',{}); await new Promise(resolve=>setImmediate(resolve));
  f.service.invalidateConnection();
  const next=await f.service.handle('modelsOverview',{}); assert.equal(next.catalog.models[0].name,'New connection');
  old.resolve({models:[{...row,name:'Old connection'}]}); await first;
  assert.equal((await f.service.handle('modelsOverview',{})).catalog.models[0].name,'New connection');
});

test('gateway generation replacement rejects an outstanding registration',async t=>{
  const f=fixture(t); const plan=await f.service.handle('modelsPlanRegistration',{modelRef:'example/author/model-v1'});
  f.base.generation++;
  await assert.rejects(f.service.handle('modelsRegister',{reviewToken:plan.reviewToken,registryRevision:0}),{code:'STALE'});
  assert.equal(JSON.parse(fs.readFileSync(f.registryPath,'utf8')).registrations.length,0);
});

test('simultaneous registration cannot duplicate an immutable reviewed reference',async t=>{
  let gate=null;
  const f=fixture(t,{read:async op=>op==='capabilities'?capabilities:gate?gate.promise:{models:[row]}});
  const plan=await f.service.handle('modelsPlanRegistration',{modelRef:'example/author/model-v1'});
  gate=deferred();
  const request={reviewToken:plan.reviewToken,registryRevision:0}; const first=f.service.handle('modelsRegister',request);
  await new Promise(resolve=>setImmediate(resolve));
  await assert.rejects(f.service.handle('modelsRegister',request),{code:'BUSY'});
  gate.resolve({models:[row]}); await first;
  assert.equal(JSON.parse(fs.readFileSync(f.registryPath,'utf8')).registrations.length,1);
});

test('corrupt current registry recovers previous snapshot read-only without overwriting either file',async t=>{
  const f=fixture(t); await register(f.service); await f.service.handle('modelsRefresh',{});
  const previous=fs.readFileSync(f.registryPath+'.previous','utf8');
  fs.writeFileSync(f.registryPath,'{broken',{mode:0o600}); f.offline(true);
  const view=await f.restart().handle('modelsOverview',{});
  assert.equal(view.registry.status,'recovered'); assert.equal(view.registry.readOnly,true);
  assert.equal(view.registry.items.length,1); assert.equal(view.catalog.stale,true);
  assert.equal(fs.readFileSync(f.registryPath,'utf8'),'{broken'); assert.equal(fs.readFileSync(f.registryPath+'.previous','utf8'),previous);
});

test('unreadable or forged evidence stores fail closed rather than create approved data',async t=>{
  const f=fixture(t); fs.mkdirSync(path.dirname(f.registryPath),{mode:0o700});
  const forged={schemaVersion:1,revision:0,registrations:[],lastSnapshot:null,evidence:{status:'passed'},admissions:[{approved:true}]};
  fs.writeFileSync(f.registryPath,JSON.stringify(forged),{mode:0o600});
  const view=await f.restart().handle('modelsOverview',{});
  assert.equal(view.registry.readOnly,true); assert.equal(view.registry.status,'unavailable');
  assert.equal(view.actions.canRegister,false); assert.equal(view.routing,'preview-only');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.registryPath,'utf8')),forged);
});

test('missing primary plus corrupt recovery file is not treated as a new empty registry',async t=>{
  const f=fixture(t); fs.mkdirSync(path.dirname(f.registryPath),{mode:0o700});
  fs.writeFileSync(f.registryPath+'.previous','broken',{mode:0o600});
  const view=await f.restart().handle('modelsOverview',{});
  assert.equal(view.registry.readOnly,true); assert.equal(fs.existsSync(f.registryPath),false);
});

test('symlink or oversized registry is rejected without replacing external data',async t=>{
  const f=fixture(t); fs.mkdirSync(path.dirname(f.registryPath),{mode:0o700});
  const external=path.join(f.root,'external.json'); fs.writeFileSync(external,'sentinel',{mode:0o600});
  fs.symlinkSync(external,f.registryPath);
  const view=await f.restart().handle('modelsOverview',{});
  assert.equal(view.registry.readOnly,true); assert.equal(fs.readFileSync(external,'utf8'),'sentinel'); assert.equal(fs.lstatSync(f.registryPath).isSymbolicLink(),true);
  fs.unlinkSync(f.registryPath); fs.writeFileSync(f.registryPath,'x'.repeat(2*1024*1024+1),{mode:0o600});
  assert.equal((await f.restart().handle('modelsOverview',{})).registry.readOnly,true);
});

test('external registry change fails compare-and-swap and is not silently merged or overwritten',async t=>{
  const f=fixture(t); const plan=await f.service.handle('modelsPlanRegistration',{modelRef:'example/author/model-v1'});
  const external=JSON.parse(fs.readFileSync(f.registryPath,'utf8')); external.revision=8;
  const bytes=JSON.stringify(external); fs.writeFileSync(f.registryPath,bytes,{mode:0o600});
  await assert.rejects(f.service.handle('modelsRegister',{reviewToken:plan.reviewToken,registryRevision:0}),{code:'STALE'});
  assert.equal(fs.readFileSync(f.registryPath,'utf8'),bytes);
});

test('portable classification binds provider/model/reasoning/environment/role and keeps execution preview-only',async()=>{
  const {classifyRegistration,qualificationIdentity}=await logic;
  const model={modelRef:'p/model',provider:'p',id:'model',runtimeId:'openclaw',metadataFingerprint:'same',available:true,manualSelectionAllowed:true};
  const registration={modelRef:'p/model',provider:'p',modelId:'model',reasoning:'high',runtimeId:'openclaw',metadataFingerprint:'same'};
  const scope={role:'coding',environmentId:'isolated-1',toolPolicyDigest:'policy-1',suiteRevision:'suite-1'};
  const identity=qualificationIdentity({...registration,...scope});
  const evidence={id:'e-1',identity,status:'passed',complete:true,expiresAt:2000};
  const admission={identity,evidenceId:'e-1',approved:true,expiresAt:2000};
  const params={model,connected:true,now:1000,scope,evidence,admission};
  assert.equal(classifyRegistration(registration,params).status,'approved');
  assert.equal(classifyRegistration(registration,params).execution,'unavailable');
  for(const variant of [{...scope,role:'research'},{...scope,environmentId:'other'}]) assert.equal(classifyRegistration(registration,{...params,scope:variant}).status,'stale');
  assert.equal(classifyRegistration({...registration,reasoning:'low'},params).status,'stale');
  assert.equal(classifyRegistration({...registration,provider:'other'},params).status,'stale');
  assert.equal(classifyRegistration(registration,{...params,now:3000}).status,'stale');
  assert.equal(classifyRegistration(registration,{...params,admission:null}).status,'qualified');
  assert.equal(classifyRegistration(registration,{...params,evidence:{...evidence,status:'failed'}}).status,'failed');
  assert.equal(classifyRegistration(registration,{...params,evidence:{...evidence,complete:false}}).status,'qualification-pending');
  assert.equal(classifyRegistration(registration,{...params,evidence:null,admission:null,scope:null}).status,'registered');
  for(const key of ['environmentId','role','toolPolicyDigest','suiteRevision']) {
    const incomplete={...scope}; delete incomplete[key];
    assert.equal(classifyRegistration(registration,{...params,scope:incomplete}).status,'stale');
  }
  for(const contradiction of [{provider:'other'},{modelId:'other'},{reasoning:'low'},{runtimeId:'other'}]) {
    assert.equal(classifyRegistration(registration,{...params,scope:{...scope,...contradiction}}).status,'stale');
  }
  assert.equal(classifyRegistration({...registration,runtimeId:null},params).status,'stale');
  assert.equal(classifyRegistration(registration,{...params,model:{...model,runtimeId:'other'}}).status,'stale');
});
