'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { GatewayService, validate, sessionRow, normalizeMessage } = require('../desktop/src/gateway-service.cjs');
const { READ_METHODS, ReadError, CliTransport } = require('../desktop/src/gateway-cli.cjs');

const selected = {key:'agent:coordinator:main',agentId:'coordinator',sessionId:'coordinator-1'};
function fixture(reply) {
  const calls=[];
  const service=new GatewayService({version:'fixture',close(){},request(method,params){
    calls.push({method,params});
    assert.ok(READ_METHODS.has(method), 'service must use a read method');
    return Promise.resolve().then(()=>reply(method,params));
  }});
  return {service,calls};
}
function deferred() {
  let resolve,reject;
  const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}

test('a send promotes the existing queued metadata read without duplicating polling or bypassing identity checks',async()=>{
  const {ConversationActions}=require('../desktop/src/gateway-conversation.cjs');
  const started=[];
  const transport=new CliTransport({home:'/fixture',target:{url:'ws://127.0.0.1:19999',configPath:'/fixture/openclaw.json'},
    execute(_node,args,_options,done){
      const call={method:args.includes('gateway')?args[3]:args[1],finish:data=>done(null,JSON.stringify(data))};started.push(call);
      return {kill(){},stdin:{on(){},end(value){call.params=JSON.parse(value);}}};
    }});
  const service=new GatewayService(transport),actions=new ConversationActions(service);
  const background=[service.read('agents.list',{}),service.read('sessions.list',{}),service.read('cron.list',{})];
  const polling=service.read('sessions.describe',{key:selected.key,agentId:selected.agentId},0);
  const sending=actions.handle('send',{...selected,message:'Fixture message',requestId:'fixture-promoted',expectedLeafEntryId:'fixture-leaf'});
  assert.equal(started.length,2);
  started[0].finish({agents:[]});assert.equal(started[2].method,'sessions.describe');
  started[2].finish({session:{...selected,lifecycleRevision:'fixture-life'}});await polling;
  await new Promise(resolve=>setImmediate(resolve));
  started[1].finish({sessions:[]});assert.equal(started[4].method,'chat.send');
  assert.equal(started.filter(call=>call.method==='sessions.describe').length,1);
  assert.deepEqual(started[4].params,{sessionKey:selected.key,agentId:selected.agentId,sessionId:selected.sessionId,
    message:'Fixture message',idempotencyKey:'fixture-promoted',expectedLeafEntryId:'fixture-leaf'});
  started[3].finish({jobs:[]});await Promise.all(background);
  started[4].finish({runId:'fixture-promoted',status:'started'});
  assert.deepEqual(await sending,{runId:'fixture-promoted',status:'started'});transport.close();
});

test('public views make only bounded read calls; activity filters before pagination',async()=>{
  const {service,calls}=fixture(method=>({
    'agents.list':{agents:[{id:'coordinator'}]},
    'sessions.list':{sessions:[],hasMore:true,nextOffset:60,totalCount:70},
    'chat.history':{sessionId:'coordinator-1',messages:[{role:'user',content:'Fixture'}]},
    'sessions.processes.list':{sessionId:'coordinator-1',processes:[]},
    'sessions.describe':{session:selected},
    'cron.list':{jobs:[]},'cron.runs':{entries:[]},
  })[method]);
  const overview=await service.overview({activeOnly:true,offset:60,query:'fixture',agentId:'coordinator'});
  assert.equal(overview.page.hasMore,true);
  assert.deepEqual(calls.find(x=>x.method==='sessions.list').params,{
    limit:60,offset:60,includeGlobal:false,includeUnknown:false,includeDerivedTitles:true,
    archived:'all',search:'fixture',agentId:'coordinator',activeOnly:true,
  });
  await service.history(selected); await service.work(selected); await service.automations({});
  const history=calls.find(x=>x.method==='chat.history').params;
  assert.equal(Object.hasOwn(history,'sessionId'),false);
  assert.equal(history.sessionKey,selected.key); assert.equal(history.agentId,'coordinator');
  assert.equal(history.limit,100); assert.equal(history.maxBytes,400000);
  assert.equal(calls.find(x=>x.method==='cron.list').params.limit,100);
  assert.equal(calls.find(x=>x.method==='cron.runs').params.limit,50);
  await service.overview({activeOnly:false});
  assert.equal(Object.hasOwn(calls.at(-1).params,'activeOnly'),false);
});

test('accepted-message refresh promotes the shared history read without forwarding scheduling flags or weakening session checks',async()=>{
  const gate=deferred(),{service,calls}=fixture(()=>gate.promise),promoted=[];
  service.transport.prioritize=(method,params)=>promoted.push({method,params});
  const polling=service.history(selected),readback=service.history({...selected,foreground:true});
  assert.equal(calls.length,1,'the readback shares the current polling request');
  assert.deepEqual(promoted,[calls[0]]);
  assert.equal(Object.hasOwn(calls[0].params,'foreground'),false);
  assert.equal(calls[0].params.limit,100);
  gate.resolve({sessionId:selected.sessionId,messages:[{role:'user',content:'Accepted fixture message'}]});
  const results=await Promise.all([polling,readback]);
  assert.equal(results[1].messages[0].text,'Accepted fixture message');
  await assert.rejects(service.history({...selected,foreground:'true'}),{code:'INVALID'});
  await assert.rejects(service.history({...selected,sessionId:'replacement',foreground:true}),{code:'SESSION_CHANGED'});
  assert.equal(calls.length,1);
});

test('view validation rejects unsupported operations, fields and unbounded inputs',async()=>{
  for(const operation of ['chat.send','constructor','toString','__proto__',{},null]) {
    assert.throws(()=>validate(operation,{}),{code:'INVALID'});
  }
  for(const input of [null,[],{limit:1000},{offset:-1},{offset:0.5},{offset:Infinity},{offset:10000001},
    {query:'x'.repeat(513)},{agentId:''},{agentId:'x'.repeat(1025)},{activeOnly:'true'}]) {
    assert.throws(()=>validate('overview',input),{code:'INVALID'});
  }
  assert.deepEqual(validate('overview',{query:'x'.repeat(512),offset:10000000,activeOnly:true}).offset,10000000);
  assert.throws(()=>validate('history',{}),{code:'INVALID'});
  assert.throws(()=>validate('work',{key:' '}),{code:'INVALID'});
  assert.throws(()=>validate('history',{key:'a',sessionId:null}),{code:'INVALID'});
  const {service,calls}=fixture(()=>{throw new Error('must not run');});
  await assert.rejects(service.overview({activeOnly:1}),{code:'INVALID'});
  assert.equal(calls.length,0);
});

test('history verifies the exact returned session incarnation, including missing identity',async()=>{
  for(const response of [{sessionId:'coordinator-2',messages:[]},{messages:[]},
    {sessionId:'coordinator-1',windowReset:true,messages:[]}]) {
    const {service}=fixture(()=>response);
    await assert.rejects(service.history(selected),{code:'SESSION_CHANGED'});
  }
  const {service}=fixture(()=>({sessionId:'coordinator-1',messages:[]}));
  assert.equal((await service.history(selected)).sessionId,'coordinator-1');
});

test('work rejects a changed or missing process owner rather than exposing another incarnation',async()=>{
  for(const sessionId of ['coordinator-2',undefined]) {
    const {service}=fixture(method=>method==='sessions.processes.list'?{sessionId,processes:[{processId:'wrong'}]}:{sessions:[]});
    await assert.rejects(service.work(selected),{code:'SESSION_CHANGED'});
  }
});

test('delegated routes retain each child agent and distinguish unknown activity from explicit idle',async()=>{
  const {service,calls}=fixture(method=>method==='sessions.describe'?{session:{...selected,hasActiveRun:false}}:method==='sessions.processes.list'?{sessionId:'coordinator-1',processes:[]}:{sessions:[
    {key:'agent:builder:subagent:a',agentId:'builder',sessionId:'builder-1',hasActiveRun:true},
    {key:'agent:reviewer:subagent:b',agentId:'reviewer',sessionId:'reviewer-1',hasActiveSubagentRun:true},
    {key:'agent:researcher:subagent:c',agentId:'researcher',sessionId:'researcher-1',hasActiveRun:false},
    {key:'agent:researcher:subagent:d',agentId:'researcher',sessionId:'researcher-2'},
  ]});
  const result=await service.work(selected);
  assert.deepEqual(result.subagents.map(x=>[x.agentId,x.sessionId,x.status]),[
    ['builder','builder-1','Running'],['reviewer','reviewer-1','Delegating'],['researcher','researcher-1','Idle'],['researcher','researcher-2','Unknown'],
  ]);
  assert.equal(result.subagents[0].sessionKey,'agent:builder:subagent:a');
  const childQuery=calls.find(x=>x.method==='sessions.list').params;
  assert.equal(childQuery.spawnedBy,selected.key);
  assert.equal(Object.hasOwn(childQuery,'agentId'),false,'the parent agent must not exclude cross-agent children');
  assert.equal(sessionRow({key:'agent:researcher:main'}).hasActiveRun,undefined);
  assert.equal(sessionRow({key:'agent:researcher:main',hasActiveRun:false}).hasActiveRun,false);
  assert.equal(calls.at(-1).method,'sessions.describe');
  assert.deepEqual(calls.at(-1).params,{key:selected.key,agentId:selected.agentId});
});

test('work verifies the current parent even when process evidence is unavailable or cached',async()=>{
  for(const processUnavailable of [false,true]) for(const replaced of [false,true]) {
    const {service,calls}=fixture(method=>{
      if(method==='sessions.processes.list') {
        if(processUnavailable)throw new ReadError('ACCESS','Fixture process access unavailable.');
        return {sessionId:selected.sessionId,processes:[]};
      }
      if(method==='sessions.list')return {sessions:[{key:'agent:builder:child',agentId:'builder',sessionId:'builder-1',hasActiveRun:true}]};
      if(method==='sessions.describe')return {session:{...selected,sessionId:replaced?'replacement':selected.sessionId,hasActiveRun:false}};
      throw new Error('Unexpected read');
    });
    if(replaced)await assert.rejects(service.work(selected),{code:'SESSION_CHANGED'});
    else {
      const result=await service.work(selected);
      assert.equal(result.subagents[0].sessionId,'builder-1');
      assert.equal(result.subagents[0].status,'Running');
      assert.equal(result.limitations.some(value=>value.includes('Processes unavailable')),processUnavailable);
    }
    assert.equal(calls.at(-1).method,'sessions.describe');
  }
});

test('work requires exact parent identity and never accepts an inaccessible or foreign final owner',async()=>{
  const untouched=fixture(()=>{throw new Error('must not read');});
  for(const input of [{key:selected.key},{key:selected.key,agentId:selected.agentId}])await assert.rejects(untouched.service.work(input),{code:'INVALID'});
  assert.equal(untouched.calls.length,0);
  for(const owner of [null,{...selected,agentId:'another-agent'},{...selected,key:'another-key'}]) {
    const {service}=fixture(method=>method==='sessions.describe'?{session:owner}:method==='sessions.processes.list'?
      {sessionId:selected.sessionId,processes:[]}:{sessions:[]});
    await assert.rejects(service.work(selected),{code:'SESSION_CHANGED'});
  }
});

test('compact cron fields and full-state fallback preserve timing and status',async()=>{
  const {service}=fixture(method=>method==='cron.list'?{jobs:[
    {id:'compact',enabled:true,schedule:{kind:'cron',expr:'0 8 * * *',tz:'Etc/UTC'},
      runningAtMs:1,lastRunAtMs:2,nextRunAtMs:3,lastRunStatus:'ok'},
    {id:'full',state:{runningAtMs:4,lastRunAtMs:5,nextRunAtMs:6,lastStatus:'error'}},
  ]}:{entries:[]});
  const {jobs}=await service.automations({});
  assert.deepEqual(jobs.map(x=>x.state),[
    {runningAtMs:1,lastRunAtMs:2,nextRunAtMs:3,lastStatus:'ok'},
    {runningAtMs:4,lastRunAtMs:5,nextRunAtMs:6,lastStatus:'error'},
  ]);
});

test('invalidation rejects old promises without replacing fresh cache or pending reads',async()=>{
  const replies=[];
  const {service,calls}=fixture(()=>{const d=deferred();replies.push(d);return d.promise;});
  const old=service.history(selected), oldCheck=assert.rejects(old,{code:'STALE'});
  await Promise.resolve(); service.invalidate();
  const fresh=service.history(selected);
  await Promise.resolve();
  replies[0].resolve({sessionId:'coordinator-1',messages:[{content:'old'}]});
  await oldCheck;
  const duplicate=service.history(selected);
  assert.equal(calls.length,2);
  replies[1].resolve({sessionId:'coordinator-1',messages:[{content:'fresh'}]});
  assert.equal((await fresh).messages[0].text,'fresh');
  assert.equal((await duplicate).messages[0].text,'fresh');
  assert.equal((await service.history(selected)).messages[0].text,'fresh');
  assert.equal(calls.length,2);
});

test('partial views cannot swallow invalidation as an empty successful response',async()=>{
  for(const operation of ['work','automations']) {
    const replies=[];
    const {service}=fixture(()=>{const d=deferred();replies.push(d);return d.promise;});
    const pending=service[operation](operation==='work'?selected:{});
    const check=assert.rejects(pending,{code:'STALE'});
    await Promise.resolve(); service.invalidate();
    for(const d of replies) d.resolve({sessionId:'coordinator-1',processes:[],sessions:[],jobs:[],entries:[]});
    await check;
  }
});

test('cached overview and late transport failures cannot change connection state after invalidation',async()=>{
  const {service}=fixture(method=>method==='agents.list'?{agents:[]}:{sessions:[]});
  await service.overview({});
  const cached=service.overview({}), cachedCheck=assert.rejects(cached,{code:'STALE'});
  service.invalidate(); service.connection.status='disconnected';
  await cachedCheck;
  assert.equal(service.snapshot().status,'disconnected');

  const failure=deferred(),notifications=[];
  const older=new GatewayService({request(){return failure.promise;}},event=>notifications.push(event));
  const pending=older.overview({}), check=assert.rejects(pending,{code:'STALE'});
  older.invalidate(); older.connection.status='connected';
  failure.reject(new ReadError('CONNECTION','Fixture failure'));
  await check;
  assert.equal(older.snapshot().status,'connected'); assert.deepEqual(notifications,[]);
});

async function normalized(messages) {
  const {service}=fixture(()=>({sessionId:'coordinator-1',messages}));
  return (await service.history(selected)).messages;
}

test('history preserves bounded native tool correlation without forwarding runtime metadata',()=>{
  const call=normalizeMessage({role:'assistant',content:[{type:'toolCall',id:'dispatch-1',name:'spawn_agent',
    arguments:{arguments:JSON.stringify({task_name:'review_ui',message:'Review the sample UI.'})},privateField:'omit'}]});
  assert.equal(call.blocks[0].toolCallId,'dispatch-1');
  assert.equal(call.blocks[0].privateField,undefined);
  const source={role:'toolResult',toolCallId:'dispatch-1',toolName:'spawn_agent',isError:false,
    content:[{type:'text',text:JSON.stringify({task_name:'/root/review_ui'})}],
    __openclaw:{id:'receipt-1',runId:'private-runtime-id'},sessionKey:'unverified-route'};
  const receipt=normalizeMessage(source);
  assert.equal(receipt.toolCallId,'dispatch-1');assert.equal(receipt.toolName,'spawn_agent');assert.equal(receipt.isError,false);
  assert.equal(receipt.runId,undefined);assert.equal(receipt.sessionKey,undefined);assert.equal(receipt.__openclaw,undefined);
  assert.notEqual(receipt.id,normalizeMessage({...source,toolCallId:'dispatch-2'}).id);
  assert.equal(normalizeMessage({...source,truncated:true}).truncated,true);
  assert.equal(normalizeMessage({...source,role:'assistant'}).toolCallId,undefined);
});

test('invalid tool correlation fields are omitted rather than shortened or coerced',()=>{
  for(const value of ['', ' padded ', 'bad\nidentifier','x'.repeat(513),{},12]) {
    const call=normalizeMessage({role:'assistant',content:[{type:'toolCall',id:value,name:'spawn_agent',arguments:{}}]});
    const receipt=normalizeMessage({role:'toolResult',toolCallId:value,toolName:value,isError:'false',content:'{}'});
    assert.equal(call.blocks[0].toolCallId,undefined);assert.equal(receipt.toolCallId,undefined);
    assert.equal(receipt.toolName,undefined);assert.equal(receipt.isError,undefined);
  }
});

test('native question evidence retains exact reply binding without exposing identity or runtime payloads',()=>{
  const raw={role:'user',content:'An answer',__openclaw:{id:'saved-answer',seq:14,replyToId:'saved-question',runId:'answer-run',
    senderName:'Private sender',senderIdentity:{private:'omit'},transport:{private:'omit'}},provenance:{kind:'external_user',private:'omit'}};
  assert.deepEqual(normalizeMessage(raw).native,{id:'saved-answer',sequence:14,provenance:'external_user',replyToId:'saved-question',runId:'answer-run'});
  for(const meta of [{id:'saved-answer'},{id:'saved-answer',seq:0},{id:'bad\nid',seq:1}])assert.equal(normalizeMessage({...raw,__openclaw:meta}).native,undefined);
  const imported=normalizeMessage({...raw,__openclaw:{...raw.__openclaw,importedFrom:'fixture-import'}});
  assert.equal(imported.native.imported,true);
  assert.equal(normalizeMessage({...raw,provenance:{kind:'unrecognized'}}).native.provenance,'other');
  assert.equal(normalizeMessage({...raw,provenance:'malformed'}).native.provenance,'other');
  assert.equal(normalizeMessage({...raw,__openclaw:{...raw.__openclaw,replyToId:'bad\nid'}}).native.replyToId,undefined);
});

test('only explicit native successful terminal evidence can retire an older async reminder',()=>{
  const raw={role:'assistant',content:'Finished the example.',stopReason:'stop',__openclaw:{id:'terminal',seq:4,runId:'run-2',runTerminal:true}};
  assert.equal(normalizeMessage(raw).native.terminal,'successful');
  for(const change of [{stopReason:'error'},{stopReason:'aborted'},{channel:'commentary'},{stopReason:undefined},
    {openclawAbort:{aborted:true}},{isError:true},{errorMessage:'Fixture failure'},
    {content:[{type:'toolCall',id:'call-tool',name:'exec',arguments:{}}]}])assert.equal(normalizeMessage({...raw,...change}).native.terminal,'settled');
  for(const change of [{__openclaw:{...raw.__openclaw,runTerminal:false}},
    {__openclaw:{...raw.__openclaw,importedFrom:'fixture'}},{provenance:{kind:'inter_session'}},
    {openclawAsyncDelivery:{itemId:'question',questions:[{title:'Continue?'}]}}])assert.equal(normalizeMessage({...raw,...change}).native.terminal,undefined);
});
const questionMessage=(extra={})=>({role:'assistant',content:'I have a question.',timestamp:123,
  __openclaw:{id:'native-message',seq:42},
  openclawAsyncDelivery:{itemId:'call-question',questions:[{title:'Which path?',options:['First','Second']}]},...extra});

test('async questions retain every title and option as bounded data, including text-only questions',async()=>{
  const raw=questionMessage();
  raw.openclawAsyncDelivery.questions.push({title:'Additional context?',ignored:'not public'});
  raw.openclawAsyncDelivery.privateField='not public';
  const [message]=await normalized([raw]);
  assert.deepEqual(message.asyncQuestion,{id:'call-question',sourceMessageId:'native-message',questions:[
    {title:'Which path?',options:['First','Second']},{title:'Additional context?'}]});
  assert.equal(message.text,'I have a question.');
  raw.openclawAsyncDelivery.questions[0].options[0]='Mutated';
  assert.equal(message.asyncQuestion.questions[0].options[0],'First','normalization owns its display data');
});

test('malformed or oversized async questions stay visible as an unsupported-format notice',async()=>{
  const valid=questionMessage().openclawAsyncDelivery;
  const invalid=[null,[],{}, {...valid,itemId:'x'.repeat(257)}, {...valid,questions:[]},
    {...valid,questions:Array(13).fill({title:'Too many'})},
    ...[null,{title:''},{title:'x'.repeat(4097)},{title:'x',options:[]},
      {title:'x',options:[' ']},{title:'x',options:['x'.repeat(257)]},
      {title:'x',options:['1','2','3','4','5']},{title:'x',options:'first'}].map(q=>({...valid,questions:[q]}))];
  for(const metadata of invalid){
    const [message]=await normalized([questionMessage({openclawAsyncDelivery:metadata})]);
    assert.equal(message.asyncQuestion,undefined);
    assert.ok(message.blocks.some(b=>b.name==='Question unavailable'));
    assert.equal(message.text,'I have a question.');
  }
});

test('only assistant metadata is interactive, and imported/unanchored rows do not claim a native source identity',async()=>{
  for(const role of ['user','tool','toolResult','system']){
    const [message]=await normalized([questionMessage({role})]);
    assert.equal(message.asyncQuestion,undefined);
  }
  for(const meta of [undefined,{id:'id'},{id:'id',seq:0},{id:'id',seq:1.5},
    {id:'id',seq:1,importedFrom:'other'},{id:'id',seq:1,cliSessionId:'other'},{id:'id',seq:1,externalId:'other'}]){
    const [message]=await normalized([questionMessage({__openclaw:meta})]);
    assert.equal(message.asyncQuestion.id,'call-question');
    assert.equal(message.asyncQuestion.sourceMessageId,undefined);
  }
});

test('question definition changes invalidate rendered identity without changing ordinary message hashes',async()=>{
  const first=questionMessage(),second=questionMessage();
  second.openclawAsyncDelivery.questions[0].options=['Changed','Second'];
  const plain={role:'assistant',content:'Plain text',timestamp:123,__openclaw:{id:'native-message',seq:42}};
  const [a,b,c]=await normalized([first,second,plain]);
  assert.notEqual(a.id,b.id);
  const hash=require('node:crypto').createHash('sha256').update(JSON.stringify(['assistant','Plain text',[],123])).digest('hex').slice(0,16);
  assert.equal(c.id,'native-message:'+hash);
});
