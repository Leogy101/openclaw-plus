'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readOffice } = require('../desktop/src/office-observation.cjs');
const { normalizeMessage } = require('../desktop/src/gateway-service.cjs');
const { READ_METHODS } = require('../desktop/src/gateway-cli.cjs');
const native = message => normalizeMessage(message).native;
const now = Date.now(), at = now - 1000;
const coordinator = { key:'agent:main:main', sessionId:'main-1', agentId:'main', kind:'direct', classification:'main', hasActiveRun:false, hasActiveSubagentRun:false, activeRunIds:[], updatedAt:at };
const builder = { key:'agent:builder:subagent:child', sessionId:'child-1', agentId:'builder', parentSessionKey:coordinator.key, parentSessionId:coordinator.sessionId,
  hasActiveRun:true, hasActiveSubagentRun:false, activeRunIds:['build-run'], startedAt:at-100, updatedAt:at };
function message(role, seq, extra={}) {
  return {role,content:'PRIVATE TASK /private/fixture/path',timestamp:at, __openclaw:{id:`message-${seq}`,seq,runId:'reply-run',...(role==='assistant'?{runTerminal:true}:{})},
    ...(role==='assistant'?{stopReason:'stop'}:{provenance:{kind:'external_user'}}),...extra};
}
function fixture({rows=[coordinator,builder],roster={agents:[{id:'main',name:'Coordinator'},{id:'builder',name:'Builder'}],defaultId:'main'},listing={},activeListing='auto',histories={},intercept}={}) {
  const calls=[];
  const gateway={generation:0,assertCurrent(value){if(value!==this.generation)throw Object.assign(new Error('Changed'),{code:'STALE'});},async read(method,params,ttl){
    calls.push({method,params,ttl});assert.ok(READ_METHODS.has(method));
    if(intercept)await intercept(method,params,gateway);
    if(method==='agents.list')return roster;
    if(method==='sessions.list') {
      if(!params.activeOnly)return {sessions:rows,hasMore:false,totalCount:rows.length,...listing};
      if(activeListing!=='auto')return activeListing;
      const active=rows.filter(row=>row.hasActiveRun!==false||row.hasActiveSubagentRun===true||row.activeRunIds?.length||row.status==='queued');
      return {sessions:active,hasMore:false,totalCount:active.length,ts:Date.now()};
    }
    const row=[...rows,...(activeListing?.sessions||[])].find(row=>row.key===params.sessionKey);
    return {sessionId:row.sessionId,sessionKey:row.key,sessionInfo:{key:row.key,sessionId:row.sessionId,agentId:row.agentId,...(row.lifecycleRevision?{lifecycleRevision:row.lifecycleRevision}:{})},messages:[],...histories[params.sessionKey]};
  }};
  return {calls,gateway,read:()=>readOffice(gateway,native)};
}

test('native positive work, complete quiet observations and physical delegation produce metadata only',async()=>{
  const {read,calls}=fixture();const result=await read();
  assert.deepEqual(result.agents,[{id:'main',name:'Coordinator',state:'idle'},{id:'builder',name:'Builder',state:'working'}]);
  assert.deepEqual(result.events.map(({id,...event})=>event),[{kind:'delegation',from:'main',to:'builder',at:at-100}]);
  assert.equal(result.limited,false);
  assert.deepEqual(calls[1].params,{limit:60,offset:0,archived:'all',includeGlobal:false,includeUnknown:false,includeDerivedTitles:false});
  assert.equal(JSON.stringify(result).includes('agent:main:main'),false);
  assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
});

test('missing, contradictory and stale evidence stays unknown; quiet partial observations remain bounded idle',async()=>{
  for(const change of [{hasActiveRun:true,activeRunIds:[]},{hasActiveRun:false,activeRunIds:['run']},{activeRunIds:['run','run']},{activeRunIds:'run'},{hasActiveRun:undefined},{snapshotAt:now-60000}]) {
    const result=await fixture({rows:[{...coordinator,...change}],activeListing:null}).read();
    assert.equal(result.agents[0].state,'unknown');assert.equal(result.limited,true);
  }
  for(const listing of [{hasMore:true},{hasMore:undefined},{totalCount:100}]) {
    const result=await fixture({rows:[coordinator],listing}).read();assert.equal(result.agents[0].state,'idle');assert.equal(result.limited,true);
  }
  assert.equal((await fixture({rows:[{...coordinator,hasActiveSubagentRun:undefined}]}).read()).agents[0].state,'idle');
  for(const change of [{hasActiveSubagentRun:undefined,rowMode:'compact'},{hasActiveSubagentRun:undefined,activeRunIds:undefined},{hasActiveSubagentRun:true}])
    assert.equal((await fixture({rows:[{...coordinator,...change}],activeListing:null}).read()).agents[0].state,'unknown');
  assert.equal((await fixture({rows:[coordinator],activeListing:null}).read()).agents[1].state,'unknown');
  assert.equal((await fixture({rows:[{...coordinator,hasActiveRun:true,activeRunIds:undefined}]}).read()).agents[0].state,'working');
});

test('native timestamps sampled during reads use receipt bounds without renewing cached freshness',async t=>{
  let clock=now+1000;
  t.mock.method(Date,'now',()=>clock);
  const row={...coordinator},listing={},messages=[message('user',1),message('assistant',2)];
  const {read}=fixture({rows:[row],listing,activeListing:null,histories:{[row.key]:{messages}},intercept(method,params){
    if(method==='sessions.list'&&!params.activeOnly){clock+=20;listing.ts=clock;row.snapshotAt=clock;}
    if(method==='chat.history'){clock+=20;messages[0].timestamp=clock-1;messages[1].timestamp=clock;}
  }});
  const result=await read();assert.equal(result.observedAt,now+1020);assert.equal(result.agents[0].state,'idle');
  assert.equal(result.events[0].kind,'report');assert.equal(result.events[0].at,now+1040);
  const cached=await fixture({rows:[{...coordinator,hasActiveRun:true,activeRunIds:['running']}],listing:{ts:now-60000},activeListing:null}).read();
  assert.equal(cached.observedAt,now-60000);assert.equal(cached.agents[0].state,'unknown');assert.equal(cached.limited,true);
  const invalid=await fixture({rows:[coordinator],listing:{ts:clock+60000},activeListing:null}).read();
  assert.equal(invalid.agents[0].state,'unknown');assert.equal(invalid.limited,true);
});

test('retained row identities support history and lineage while fresh active-only evidence determines current state',async()=>{
  const oldCoordinator={...coordinator,snapshotAt:now-190000,updatedAt:now-190000};
  const oldChild={...builder,snapshotAt:now-90000};
  const messages=[message('user',1),message('assistant',2)];
  const quiet=await fixture({rows:[oldCoordinator,oldChild],listing:{ts:now},activeListing:{sessions:[],totalCount:0,hasMore:false,ts:now},histories:{[coordinator.key]:{messages}}}).read();
  assert.ok(quiet.agents.every(agent=>agent.state==='idle'));assert.equal(quiet.limited,true);
  assert.ok(quiet.events.some(event=>event.kind==='delegation'));assert.ok(quiet.events.some(event=>event.kind==='report'));
  const longRun={...builder,snapshotAt:now};
  const {read,calls}=fixture({rows:[oldCoordinator],listing:{ts:now},activeListing:{sessions:[longRun],totalCount:1,hasMore:false,ts:now},histories:{[coordinator.key]:{messages}}});
  const running=await read();assert.equal(running.agents[1].state,'working');
  assert.equal(calls.filter(call=>call.method==='sessions.list').length,2);assert.equal(calls.find(call=>call.params.activeOnly).params.limit,60);
  assert.equal(calls.filter(call=>call.method==='chat.history')[0].params.sessionKey,coordinator.key);
  for(const activeListing of [null,{sessions:[],totalCount:1,hasMore:true,ts:now},{sessions:[],totalCount:0,hasMore:false,ts:now-90000},
    {sessions:[{...longRun,status:'queued'}],totalCount:1,hasMore:false,ts:now},
    {sessions:[oldChild],totalCount:1,hasMore:false,ts:now},
    {sessions:[longRun,{...longRun,sessionId:'other'}],totalCount:2,hasMore:false,ts:now}]) {
    const result=await fixture({rows:[oldCoordinator],listing:{ts:now},activeListing}).read();
    assert.equal(result.agents[1].state,'unknown');assert.equal(result.limited,true);
  }
});

test('delegation requires distinct agents, physical parent identity and a native start timestamp',async()=>{
  for(const change of [{parentSessionId:undefined},{parentSessionId:'old-parent'},{startedAt:undefined},{startedAt:now+60000},{agentId:'main'},{spawnedBy:'other-parent'}]) {
    const result=await fixture({rows:[coordinator,{...builder,...change}]}).read();
    assert.equal(result.events.length,0);assert.equal(result.limited,true);
  }
  const duplicate=await fixture({rows:[coordinator,{...coordinator,sessionId:'old'},builder]}).read();
  assert.equal(duplicate.events.length,0);
});

test('a successful native terminal response to a direct user records a report, never task text',async()=>{
  const messages=[message('user',1),message('assistant',2)];
  const {read}=fixture({rows:[coordinator],histories:{[coordinator.key]:{messages}}});
  const first=await read(),second=await read();
  assert.deepEqual(first.events,second.events); // The renderer baselines/deduplicates these stable receipts.
  assert.equal(first.events.length,1);assert.equal(first.events[0].kind,'report');assert.equal(first.events[0].to,null);
  assert.equal(JSON.stringify(first).includes('PRIVATE TASK'),false);assert.equal(JSON.stringify(first).includes('/private/'),false);
  const unknownDirect={...coordinator,kind:'unknown',classification:undefined};
  assert.equal((await fixture({rows:[unknownDirect],histories:{[coordinator.key]:{messages}}}).read()).events.length,1);
  const fallback={...coordinator,key:'agent:lead:main',agentId:'lead'};
  assert.equal((await fixture({rows:[fallback],roster:{agents:[{id:'lead'}],defaultId:'lead'},histories:{[fallback.key]:{messages}}}).read()).events[0].from,'lead');
});

test('commentary, tool use, imported, failed, internal and unrelated terminal turns are not owner reports',async()=>{
  const terminal=message('assistant',2);
  for(const change of [{channel:'commentary'},{content:[{type:'toolCall',name:'exec',id:'call',arguments:{}}]},{stopReason:'error'},
    {__openclaw:{...terminal.__openclaw,runTerminal:false}},{__openclaw:{...terminal.__openclaw,importedFrom:'fixture'}},
    {provenance:{kind:'inter_session'}},{provenance:{kind:'internal_system'}},{__openclaw:{...terminal.__openclaw,replyToId:'other-user'}},
    {__openclaw:{...terminal.__openclaw,reason:'oversized'}},{__openclaw:{...terminal.__openclaw,runId:undefined}}]) {
    const result=await fixture({rows:[coordinator],histories:{[coordinator.key]:{messages:[message('user',1),{...terminal,...change}]}}}).read();
    assert.equal(result.events.length,0,JSON.stringify(change));
  }
  for(const provenance of [{kind:'inter_session'},{kind:'internal_system'},{kind:'unknown'}]) {
    assert.equal((await fixture({rows:[coordinator],histories:{[coordinator.key]:{messages:[message('user',1,{provenance}),terminal]}}}).read()).events.length,0);
  }
  for(const change of [{classification:'cron'},{isBackground:true},{parentSessionKey:'parent'},{kind:'group'}]) {
    assert.equal((await fixture({rows:[{...coordinator,...change}],histories:{[coordinator.key]:{messages:[message('user',1),terminal]}}}).read()).events.length,0);
  }
  const inter=message('assistant',3,{provenance:{kind:'inter_session'}});
  assert.equal((await fixture({rows:[coordinator],histories:{[coordinator.key]:{messages:[message('user',1),terminal,inter]}}}).read()).events.length,0);
});

test('native handoff receipts bind current distinct agents; key-only receipts require a current source start',async()=>{
  const receipt=message('user',5,{provenance:{kind:'inter_session',sourceSessionKey:builder.key,sourceTool:'subagent_announce',originSessionId:builder.sessionId}});
  const read=(change={},source=builder)=>fixture({rows:[coordinator,source],histories:{[coordinator.key]:{messages:[{...receipt,...change}]}}}).read();
  assert.equal((await read()).events.filter(event=>event.kind==='handoff').length,1);
  const keyOnly={...receipt.provenance};delete keyOnly.originSessionId;
  assert.equal((await read({provenance:keyOnly})).events.filter(event=>event.kind==='handoff').length,1);
  for(const provenance of [{...keyOnly,originSessionId:'old-child'},{...keyOnly,sourceTool:'other-tool'},{...keyOnly,sourceSessionKey:'missing'},{...keyOnly,sourceSessionKey:coordinator.key}]) {
    assert.equal((await read({provenance})).events.filter(event=>event.kind==='handoff').length,0);
  }
  for(const source of [{...builder,startedAt:undefined},{...builder,startedAt:at+1},{...builder,parentSessionId:'old-parent'},
    {...builder,parentSessionKey:'missing',parentSessionId:undefined},{...builder,spawnedBy:'contradictory-parent'}]) {
    assert.equal((await read({provenance:keyOnly},source)).events.filter(event=>event.kind==='handoff').length,0);
  }
  assert.equal((await read({__openclaw:{...receipt.__openclaw,importedFrom:'copy'}})).events.filter(event=>event.kind==='handoff').length,0);
});

test('mismatched history incarnation and duplicate message identities suppress events',async()=>{
  const messages=[message('user',1),message('assistant',2)];
  for(const change of [{sessionId:'old'},{sessionKey:'other'},{windowReset:true},{sessionInfo:{agentId:'builder'}},
    {messages:[...messages,messages[1]]},{messages:[messages[0],...messages]}]) {
    const result=await fixture({rows:[coordinator],histories:{[coordinator.key]:{messages,...change}}}).read();
    assert.equal(result.events.length,0);assert.equal(result.limited,true);
  }
  assert.equal((await fixture({rows:[{...coordinator,lifecycleRevision:'new'}],histories:{[coordinator.key]:{messages,sessionInfo:{lifecycleRevision:'old'}}}}).read()).events.length,0);
});

test('all reads and projections are bounded; the coordinator history is prioritized without prose',async()=>{
  const rows=Array.from({length:80},(_,i)=>({...coordinator,key:`agent:a${i}:main`,agentId:`a${i}`,sessionId:`s${i}`,updatedAt:at+i}));
  rows[59]=coordinator;
  const {read,calls}=fixture({rows,roster:{agents:[...rows.map(row=>({id:row.agentId})),...Array.from({length:30},(_,i)=>({id:`extra${i}`}))]}});
  const result=await read();assert.ok(result.agents.length<=100);assert.ok(result.events.length<=100);assert.equal(result.limited,true);
  const tails=calls.filter(call=>call.method==='chat.history');assert.equal(tails.length,4);assert.equal(tails[0].params.sessionKey,coordinator.key);
  for(const {params} of tails)assert.deepEqual(Object.keys(params).sort(),['agentId','limit','maxBytes','maxChars','sessionKey','toolResultMaxChars'].sort());
  for(const {params} of tails){assert.equal(params.limit,24);assert.equal(params.maxBytes,32768);assert.equal(params.maxChars,1);assert.equal(params.toolResultMaxChars,1);}
});

test('read failures remain limited and connection invalidation is never swallowed',async()=>{
  const unavailable=fixture({intercept(method){if(method==='sessions.list')throw new Error('private failure');}});
  const result=await unavailable.read();assert.equal(result.limited,true);assert.ok(result.agents.every(agent=>agent.state==='unknown'));
  assert.equal(JSON.stringify(result).includes('private failure'),false);
  const stale=fixture({intercept(method,_params,gateway){if(method==='chat.history')gateway.generation++;}});
  await assert.rejects(stale.read(),{code:'STALE'});
});
