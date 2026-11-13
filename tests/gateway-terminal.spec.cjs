'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { execFile } = require('node:child_process');
const path = require('node:path');
const { TerminalService, HelperChannel } = require('../desktop/src/gateway-terminal.cjs');
const { validateRequest } = require('../desktop/src/terminal-rpc.cjs');
const selected={key:'agent:main:main',agentId:'main',sessionId:'physical-1'};
const size={cols:80,rows:24};
function fixture(overrides={}) {
  const calls=[],events=[],shells=new Map();let receiver,incarnation='physical-1',revision='life-1',count=0,connections=0;
  const service=new TerminalService({notify:event=>events.push(event),channelFactory:onMessage=>{
    receiver=onMessage;connections++;
    return {closed:false,async request(method,params){
      calls.push({method,params:structuredClone(params)});
      const special=await overrides.request?.(method,params,{shells,onMessage,connection:this});
      if(special!==undefined)return special;
      if(method==='sessions.describe')return {session:{key:params.key,agentId:params.agentId,sessionId:incarnation,lifecycleRevision:revision}};
      if(method==='terminal.list')return {sessions:[...shells.values()]};
      if(method==='terminal.open'){
        const shell={sessionId:`terminal-${++count}`,agentId:params.agentId,owner:`agent:${params.sessionKey}`,cwd:'/fixture',shell:'/bin/zsh',confined:false,buffer:'hello',seq:5};
        shells.set(shell.sessionId,shell);return {...shell};
      }
      const shell=shells.get(params.sessionId);
      if(method==='terminal.attach')return {...shell};
      return {ok:!!shell};
    },close(){if(this.closed)return;this.closed=true;onMessage({kind:'status',status:'disconnected'});}};
  }});
  return {service,calls,events,shells,get connections(){return connections;},set incarnation(value){incarnation=value;},set revision(value){revision=value;},emit:value=>receiver(value),
    async open(){return service.handle('open',{...selected,...size});}};
}

test('open binds the exact physical session before adoption, then delivers replay',async()=>{
  const f=fixture(),result=await f.open();
  assert.equal(result.status,'ready');assert.equal(result.terminalId,'terminal-1');assert.deepEqual(result.context,selected);
  assert.deepEqual(f.calls.map(call=>call.method),['sessions.describe','terminal.open','sessions.describe','sessions.describe','terminal.attach','sessions.describe']);
  assert.deepEqual(f.calls[1].params,{agentId:'main',sessionKey:selected.key,...size});
  assert.deepEqual(f.events.find(event=>event.reset),{kind:'data',context:selected,terminalId:'terminal-1',data:'hello',reset:true});
  f.service.close();
});
test('existing native terminals with only logical ownership are not adopted',async()=>{
  const f=fixture();f.shells.set('external',{sessionId:'external',agentId:'main',owner:`agent:${selected.key}`});
  const list=await f.service.handle('list',selected);assert.deepEqual(list.terminals,[]);assert.ok(list.limitations.length);
  await assert.rejects(f.service.handle('attach',{...selected,terminalId:'external'}),{code:'DENIED'});
  assert.equal(f.calls.some(call=>call.method==='terminal.attach'),false);f.service.close();
});
test('foreign physical context cannot operate a known terminal',async()=>{
  const f=fixture();await f.open();const before=f.calls.length;
  for(const action of ['attach','input','resize','detach'])await assert.rejects(f.service.handle(action,{
    ...selected,sessionId:'other',terminalId:'terminal-1',...action==='input'?{data:'x'}:action==='resize'?size:{},
  }),{code:'DENIED'});
  assert.equal(f.calls.length,before);f.service.close();
});
test('replacement detected after native open closes only the unadopted shell',async()=>{
  let reads=0;const f=fixture({request:method=>{
    if(method==='sessions.describe'&&++reads===2)return {session:{...selected,sessionId:'replacement',lifecycleRevision:'life-2'}};
  }});
  await assert.rejects(f.open(),{code:'SESSION_CHANGED'});
  assert.equal(f.calls.at(-1).method,'terminal.close');assert.equal(f.calls.some(call=>call.method==='terminal.attach'),false);
  assert.equal(f.service.records.size,0);f.service.close();
});
test('lifecycle change blocks input even when the physical ID is unchanged',async()=>{
  const f=fixture();await f.open();f.revision='life-2';
  await assert.rejects(f.service.handle('input',{...selected,terminalId:'terminal-1',data:'unsafe\r'}),{code:'SESSION_CHANGED'});
  assert.equal(f.calls.some(call=>call.method==='terminal.input'),false);assert.equal(f.service.records.get('terminal-1').status,'stale');f.service.close();
});
test('attach rejects mismatched owner and never displays its replay',async()=>{
  const f=fixture();await f.open();f.events.length=0;f.shells.get('terminal-1').owner='agent:other:main';
  await assert.rejects(f.service.handle('attach',{...selected,terminalId:'terminal-1'}),{code:'UNAVAILABLE'});
  assert.equal(f.events.some(event=>event.kind==='data'),false);f.service.close();
});
test('input preserves ordering and exact bytes without appending Enter',async()=>{
  const f=fixture();await f.open();
  await Promise.all(['printf ','hello','\r'].map(data=>f.service.handle('input',{...selected,terminalId:'terminal-1',data})));
  assert.deepEqual(f.calls.filter(call=>call.method==='terminal.input').map(call=>call.params),[
    {sessionId:'terminal-1',data:'printf '},{sessionId:'terminal-1',data:'hello'},{sessionId:'terminal-1',data:'\r'},
  ]);f.service.close();
});
test('unconfirmed input is not retried and requires explicit attach',async()=>{
  const f=fixture({request:method=>{if(method==='terminal.input'){const error=new Error('Lost receipt');error.code='UNCERTAIN';throw error;}}});
  await f.open();await assert.rejects(f.service.handle('input',{...selected,terminalId:'terminal-1',data:'run\r'}),{code:'UNCERTAIN'});
  await assert.rejects(f.service.handle('input',{...selected,terminalId:'terminal-1',data:'x'}),{code:'CONNECTION'});
  assert.equal(f.calls.filter(call=>call.method==='terminal.input').length,1);f.service.close();
});
test('disconnect never opens a replacement; explicit attach reuses known shell',async()=>{
  const f=fixture();await f.open();f.service.channel.close();
  assert.equal(f.service.records.get('terminal-1').status,'disconnected');assert.equal(f.connections,1);
  await assert.rejects(f.service.handle('input',{...selected,terminalId:'terminal-1',data:'x'}),{code:'CONNECTION'});
  const result=await f.service.handle('attach',{...selected,terminalId:'terminal-1'});
  assert.equal(result.status,'ready');assert.equal(f.connections,2);assert.equal(f.calls.filter(call=>call.method==='terminal.open').length,1);f.service.close();
});
test('UTF-16 output deduplicates overlap, including multibyte emoji',async()=>{
  const f=fixture();await f.open();f.events.length=0;
  f.emit({kind:'event',event:'terminal.data',payload:{sessionId:'terminal-1',seq:8,data:'🙂a'}});
  f.emit({kind:'event',event:'terminal.data',payload:{sessionId:'terminal-1',seq:8,data:'🙂a'}});
  f.emit({kind:'event',event:'terminal.data',payload:{sessionId:'terminal-1',seq:9,data:'ab'}});
  assert.deepEqual(f.events.filter(event=>event.kind==='data').map(event=>event.data),['🙂a','b']);f.service.close();
});
test('a sequence gap replays the same shell without sending input or opening',async()=>{
  const f=fixture();await f.open();f.events.length=0;
  Object.assign(f.shells.get('terminal-1'),{buffer:'hello missing!',seq:14});
  f.emit({kind:'event',event:'terminal.data',payload:{sessionId:'terminal-1',seq:14,data:'!'}});
  await f.service.tail;
  assert.equal(f.events.find(event=>event.reset)?.data,'hello missing!');
  assert.equal(f.calls.filter(call=>call.method==='terminal.open').length,1);
  assert.equal(f.calls.filter(call=>call.method==='terminal.input').length,0);f.service.close();
});
test('gap recovery rejected by a full queue leaves an explicit reconnect state',async()=>{
  let block=false,release,entered;
  const blocked=new Promise(resolve=>{entered=resolve;});
  const f=fixture({request:method=>{
    if(method==='sessions.describe'&&block){block=false;entered();return new Promise(resolve=>{release=()=>resolve({session:{...selected,lifecycleRevision:'life-1'}});});}
  }});
  await f.open();block=true;
  const pending=[f.service.handle('input',{...selected,terminalId:'terminal-1',data:'x'}).catch(error=>error)];
  await blocked;
  for(let i=0;i<31;i++)pending.push(f.service.handle('input',{...selected,terminalId:'terminal-1',data:'x'}).catch(error=>error));
  assert.equal(f.service.queued,32);
  f.emit({kind:'event',event:'terminal.data',payload:{sessionId:'terminal-1',seq:99,data:'gap'}});
  await Promise.resolve();
  assert.equal(f.service.records.get('terminal-1').status,'disconnected');assert.equal(f.service.records.get('terminal-1').recovering,false);
  release();await Promise.all(pending);
  await f.service.handle('attach',{...selected,terminalId:'terminal-1'});assert.equal(f.service.records.get('terminal-1').status,'ready');f.service.close();
});
test('a terminal exit while gap recovery is queued is not overwritten or reattached',async()=>{
  let block=false,release,entered;const blocked=new Promise(resolve=>{entered=resolve;});
  const f=fixture({request:method=>{
    if(method==='sessions.describe'&&block){block=false;entered();return new Promise(resolve=>{release=()=>resolve({session:{...selected,lifecycleRevision:'life-1'}});});}
  }});
  await f.open();block=true;
  const pending=f.service.handle('resize',{...selected,terminalId:'terminal-1',cols:90,rows:30});await blocked;
  f.emit({kind:'event',event:'terminal.data',payload:{sessionId:'terminal-1',seq:99,data:'gap'}});
  f.emit({kind:'event',event:'terminal.exit',payload:{sessionId:'terminal-1',reason:'process_exit',exitCode:0}});
  release();await pending;await f.service.tail;
  assert.equal(f.service.records.get('terminal-1').status,'exited');assert.equal(f.calls.filter(call=>call.method==='terminal.attach').length,1);f.service.close();
});
test('events racing with attach are merged after replay using offset sequence',async()=>{
  let attachCount=0;const f=fixture({request:(method,params,{onMessage,shells})=>{
    if(method==='terminal.attach'&&++attachCount===2){
      onMessage({kind:'event',event:'terminal.data',payload:{sessionId:params.sessionId,seq:6,data:'!'}});
      return {...shells.get(params.sessionId)};
    }
  }});
  await f.open();f.events.length=0;await f.service.handle('attach',{...selected,terminalId:'terminal-1'});
  assert.deepEqual(f.events.filter(event=>event.kind==='data').map(event=>[event.data,!!event.reset]),[['hello',true],['!',false]]);f.service.close();
});
test('exit during attachment remains terminal and never exposes a stale replay',async()=>{
  let attaches=0;const f=fixture({request:(method,params,{onMessage,shells})=>{
    if(method==='terminal.attach'&&++attaches===2){onMessage({kind:'event',event:'terminal.exit',payload:{sessionId:params.sessionId,reason:'process_exit',exitCode:0}});return {...shells.get(params.sessionId)};}
  }});
  await f.open();f.events.length=0;
  await assert.rejects(f.service.handle('attach',{...selected,terminalId:'terminal-1'}),{code:'CONNECTION'});
  assert.equal(f.service.records.get('terminal-1').status,'exited');assert.equal(f.events.some(event=>event.kind==='data'),false);
  await assert.rejects(f.service.handle('attach',{...selected,terminalId:'terminal-1'}),{code:'SESSION_CHANGED'});f.service.close();
});
test('late events from a retired helper cannot disconnect or write into a new connection',async()=>{
  let oldReceiver;const f=fixture({request:(_method,_params,{onMessage})=>{oldReceiver??=onMessage;}});
  await f.open();f.service.channel.close();await f.service.handle('attach',{...selected,terminalId:'terminal-1'});f.events.length=0;
  oldReceiver({kind:'status',status:'disconnected'});
  oldReceiver({kind:'event',event:'terminal.data',payload:{sessionId:'terminal-1',seq:100,data:'old'}});
  assert.equal(f.service.records.get('terminal-1').status,'ready');assert.deepEqual(f.events,[]);f.service.close();
});
test('detach calls native close once, retaining known shared identity for explicit reattach',async()=>{
  const f=fixture();await f.open();const result=await f.service.handle('detach',{...selected,terminalId:'terminal-1'});
  assert.equal(result.status,'detached');assert.equal(f.service.records.size,1);
  await f.service.handle('detach',{...selected,terminalId:'terminal-1'});
  assert.equal(f.calls.filter(call=>call.method==='terminal.close').length,1);
  await f.service.handle('attach',{...selected,terminalId:'terminal-1'});assert.equal(f.calls.filter(call=>call.method==='terminal.open').length,1);f.service.close();
});
test('one shell per context and four known contexts bound terminal resources',async()=>{
  const f=fixture();await f.open();await assert.rejects(f.open(),{code:'BUSY'});
  for(let i=2;i<=4;i++)await f.service.handle('open',{...selected,key:`agent:main:session-${i}`,...size});
  await assert.rejects(f.service.handle('open',{...selected,key:'agent:main:session-5',...size}),{code:'BUSY'});
  assert.equal(f.calls.filter(call=>call.method==='terminal.open').length,4);
  f.emit({kind:'event',event:'terminal.exit',payload:{sessionId:'terminal-1',reason:'process_exit',exitCode:0}});
  await f.service.handle('open',{...selected,key:'agent:main:session-5',...size});assert.equal(f.service.records.size,4);f.service.close();
});
test('global list retires ended shells from other physical contexts and releases the four-shell limit',async()=>{
  const f=fixture();await f.open();
  for(let i=2;i<=4;i++)await f.service.handle('open',{...selected,key:`agent:main:session-${i}`,...size});
  f.service.channel.close();f.shells.clear();f.events.length=0;
  const newContext={...selected,key:'agent:main:new-physical-conversation'};
  const list=await f.service.handle('list',newContext);assert.deepEqual(list.terminals,[]);
  const retired=f.events.filter(event=>event.kind==='status'&&event.snapshot.status==='exited');
  assert.equal(retired.length,4);assert.equal(new Set(retired.map(event=>event.context.key)).size,4);
  assert.ok(retired.every(event=>event.context.key!==newContext.key));
  await f.service.handle('open',{...newContext,...size});assert.equal(f.service.records.size,1);f.service.close();
});
test('bad actions, dimensions, oversized paste and arbitrary methods fail before connecting',async()=>{
  const f=fixture();
  for(const [action,input] of [['exec',selected],['open',{...selected,cols:0,rows:24}],['input',{...selected,terminalId:'x',data:'x'.repeat(16385)}],
    ['open',{...selected,...size,command:'anything'}],['list',{...selected,sessionId:'bad\nvalue'}]])await assert.rejects(f.service.handle(action,input),{code:'INVALID'});
  assert.equal(f.connections,0);f.service.close();
});
test('exited terminals cannot accept input and raw terminal errors never reach renderer',async()=>{
  const f=fixture();await f.open();f.events.length=0;
  f.emit({kind:'event',event:'terminal.exit',payload:{sessionId:'terminal-1',reason:'error',error:'SECRET should not display',exitCode:1}});
  await assert.rejects(f.service.handle('input',{...selected,terminalId:'terminal-1',data:'x'}),{code:'SESSION_CHANGED'});
  assert.equal(JSON.stringify(f.events).includes('SECRET'),false);f.service.close();
});
test('explicit fixture is inert echo and resolves session reads through latest transport provider',async()=>{
  const calls=[],events=[];let generation=1;
  const service=new TerminalService({fixture:true,transport:()=>({request:async(method,params)=>{
    calls.push({generation,method,params});return {session:{...selected,lifecycleRevision:'life-1'}};
  }}),notify:event=>events.push(event)});
  const opened=await service.handle('open',{...selected,...size});generation=2;
  await service.handle('input',{...selected,terminalId:opened.terminalId,data:'rm -rf / --fixture-text-only\r'});
  assert.ok(events.some(event=>event.data?.includes('no commands execute')));assert.ok(events.some(event=>event.data?.includes('fixture-text-only')));
  assert.ok(calls.every(call=>call.method==='sessions.describe'));assert.equal(calls.at(-1).generation,2);service.close();
});
test('private helper validation fixes method/fields and rejects standalone or catalog shells',()=>{
  const request=(method,params)=>({id:1,method,params});
  assert.equal(validateRequest(request('terminal.open',{agentId:'main',sessionKey:selected.key,...size})),true);
  assert.equal(validateRequest(request('terminal.open',{agentId:'main',...size})),false);
  assert.equal(validateRequest(request('terminal.open',{agentId:'main',sessionKey:selected.key,...size,catalog:{}})),false);
  assert.equal(validateRequest(request('chat.send',{})),false);
  assert.equal(validateRequest(request('terminal.upload',{})),false);
  assert.equal(validateRequest(request('terminal.input',{sessionId:'terminal-1',data:'🙂'})),true);
});
test('persistent helper IPC strips inherited credentials, bounds frames, and never retries input after loss',async()=>{
  let child,spawnArgs;const messages=[];
  const channel=new HelperChannel({home:'/fixture',node:'/fixture/node',target:{url:'ws://127.0.0.1:18789',configPath:'/fixture/config'}},'/fixture/helper.cjs',message=>messages.push(message),(...args)=>{
    spawnArgs=args;child=new EventEmitter();child.stdout=new PassThrough();child.stdin=new PassThrough();child.kill=()=>{child.killed=true;};return child;
  });
  child.stdout.write(JSON.stringify({kind:'status',status:'ready'})+'\n');await channel.started;
  let request='';child.stdin.on('data',chunk=>{request+=chunk;});
  const pending=channel.request('terminal.input',{sessionId:'terminal-1',data:'x'});await Promise.resolve();
  child.emit('exit',1);await assert.rejects(pending,{code:'UNCERTAIN'});
  assert.equal(request.trim().split('\n').length,1);assert.equal(spawnArgs[2].shell,false);assert.equal(spawnArgs[2].env.OPENCLAW_GATEWAY_TOKEN,undefined);
  assert.equal(child.killed,true);assert.equal(messages.at(-1).status,'disconnected');
});
test('oversized private helper output is rejected without exposing it',async()=>{
  let child;const events=[];
  const channel=new HelperChannel({home:'/fixture',node:'/fixture/node',target:{url:'ws://127.0.0.1:18789',configPath:'/fixture/config'}},'/fixture/helper.cjs',event=>events.push(event),()=>{
    child=new EventEmitter();child.stdout=new PassThrough();child.stdin=new PassThrough();child.kill=()=>{};return child;
  });
  child.stdout.write(JSON.stringify({kind:'status',status:'ready'})+'\n');await channel.started;
  child.stdout.write('x'.repeat(4*1024*1024+1));assert.equal(channel.closed,true);assert.equal(events.some(event=>event.kind==='data'),false);
});
test('production helper refuses inherited agent context before SDK or credentials are read',async()=>{
  for(const marker of ['OPENCLAW_SHELL','OPENCLAW_SUBAGENT_EXEC']){
    const result=await new Promise(resolve=>execFile(process.execPath,[path.join(__dirname,'../desktop/src/terminal-rpc.cjs'),'ws://127.0.0.1:18789'],
      {env:{[marker]:'test',OPENCLAW_CONFIG_PATH:'/nonexistent-fixture-config'},timeout:3000},(error,stdout,stderr)=>resolve({error,stdout,stderr})));
    assert.equal(result.error?.code,1);assert.equal(result.stderr,'');
    assert.deepEqual(JSON.parse(result.stdout),{kind:'status',status:'disconnected',code:'CONFIG'});
  }
});
