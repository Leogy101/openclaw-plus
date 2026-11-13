'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {EventEmitter}=require('node:events');
const path=require('node:path');
const {VoiceService,VoiceChannel,projectCatalog}=require('../desktop/src/gateway-voice.cjs');
const {validateRequest,projectChat}=require('../desktop/src/voice-rpc.cjs');
const context={key:'agent:main:fixture',agentId:'main',sessionId:'physical-1'};
const methods=['sessions.describe','talk.catalog','talk.session.create','talk.session.appendAudio','talk.session.close','talk.session.acknowledgeMark','talk.client.toolCall','talk.session.steer','talk.session.submitToolResult','agent.wait'];
const catalog=()=>({transcription:{ready:true,activeProvider:'fixture',providers:[{id:'fixture',configured:true}]},realtime:{ready:true,activeProvider:'fixture',providers:[{id:'fixture',configured:true,transports:['gateway-relay'],modes:['realtime'],brains:['agent-consult'],supportsBargeIn:true}]}});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function settled(){for(let i=0;i<8;i++)await tick();}
function fixture(overrides={}){
  const calls=[],events=[],channels=[];let receiver,physical='physical-1',life='life-1',now=1000,seq=0,mode='transcription';
  const service=new VoiceService({notify:event=>events.push(event),now:()=>now,guardMs:100000,channelFactory:receive=>{
    receiver=receive;
    const channel={closed:false,methods,capabilities:['talk-session-close-disposition'],started:Promise.resolve(),async request(method,params){
      calls.push({method,params:structuredClone(params)});
      const custom=await overrides.request?.(method,params,{receive,channel});if(custom!==undefined)return custom;
      if(method==='sessions.describe')return {session:{...context,key:params.key,agentId:params.agentId,sessionId:physical,lifecycleRevision:life}};
      if(method==='talk.catalog')return catalog();
      if(method==='talk.session.create'){
        mode=params.mode;receive({kind:'event',event:'talk.event',payload:{[mode==='transcription'?'transcriptionSessionId':'relaySessionId']:'native-voice',type:'ready'}});
        return {sessionId:'native-voice',...(mode==='transcription'?{transcriptionSessionId:'native-voice'}:{relaySessionId:'native-voice'}),mode,transport:'gateway-relay',brain:params.brain,
          audio:mode==='transcription'?{inputEncoding:'g711_ulaw',inputSampleRateHz:8000}:{inputEncoding:'pcm16',inputSampleRateHz:24000,outputEncoding:'pcm16',outputSampleRateHz:24000}};
      }
      if(method==='talk.client.toolCall')return {runId:'native-run',idempotencyKey:'call-1',agentId:'main',agentSessionKey:context.key};
      if(method==='agent.wait')return {status:'ok'};
      return {ok:true};
    },close(){if(channel.closed)return;channel.closed=true;receive({kind:'status',status:'disconnected',code:'CONNECTION'});}};
    channels.push(channel);return channel;
  }});
  return {service,calls,events,channels,set physical(v){physical=v;},set life(v){life=v;},set now(v){now=v;},
    emit:payload=>receiver({kind:'event',event:'talk.event',payload:{[mode==='transcription'?'transcriptionSessionId':'relaySessionId']:'native-voice',...payload}}),
    canonical:(type,p={})=>({id:`event-${++seq}`,sessionId:'native-voice',seq,turnId:'turn-1',type,...p}),
    chat:p=>receiver({kind:'event',event:'chat',payload:p}),start:mode=>service.handle('start',{...context,mode:mode??'dictation'}),
  };
}
test('catalog is read-only, session-pinned and caches only the same incarnation',async()=>{
  const f=fixture(),first=await f.service.handle('catalog',context);assert.equal(first.dictation.available,true);assert.equal(first.conversation.available,true);assert.equal(first.conversation.supportsBargeIn,false);
  await f.service.handle('catalog',context);assert.equal(f.calls.filter(c=>c.method==='talk.catalog').length,1);assert.equal(f.calls.some(c=>c.method==='talk.session.create'),false);
  f.physical='replacement';await assert.rejects(f.service.handle('catalog',context),{code:'SESSION_CHANGED'});await f.service.close();
});
test('legacy rows may omit lifecycle revision while exact physical ownership remains pinned',async()=>{
  let revision;const f=fixture({request:m=>m==='sessions.describe'?{session:{...context,...revision===undefined?{}:{lifecycleRevision:revision}}}:undefined});
  assert.equal((await f.service.handle('catalog',context)).conversation.available,true);
  const r=await f.start();await f.service.handle('audio',{id:r.id,audioBase64:'AQID'});
  revision='newly-present';f.now=200000;
  await assert.rejects(f.service.handle('audio',{id:r.id,audioBase64:'AQID'}),{code:'SESSION_CHANGED'});await settled();await f.service.close();
});
test('a supplied malformed lifecycle revision is rejected rather than treated as absent',async()=>{
  for(const value of [null,'',false,123,undefined]){
    const f=fixture({request:m=>m==='sessions.describe'?{session:{...context,lifecycleRevision:value}}:undefined});
    await assert.rejects(f.service.handle('catalog',context),{code:'SESSION_CHANGED'});assert.equal(f.calls.some(c=>c.method==='talk.session.create'),false);await f.service.close();
  }
});
test('lifecycle revision disappearing during creation fails closed',async()=>{
  let reads=0;const f=fixture({request:m=>{if(m==='sessions.describe'&&++reads===4)return {session:{...context}};}});
  await assert.rejects(f.start(),{code:'SESSION_CHANGED'});assert.deepEqual(f.calls.find(c=>c.method==='talk.session.close').params,{sessionId:'native-voice',discard:true});await f.service.close();
});
test('unconfigured and unsupported routes remain setup states without allocation',async()=>{
  const raw=catalog();raw.transcription.ready=false;raw.realtime.providers[0].transports=['webrtc'];
  const projected=projectCatalog(raw,methods);assert.equal(projected.dictation.available,false);assert.equal(projected.conversation.available,false);
  const f=fixture({request:m=>m==='talk.catalog'?raw:undefined});await assert.rejects(f.start(),{code:'UNAVAILABLE'});assert.equal(f.calls.some(c=>c.method==='talk.session.create'),false);await f.service.close();
});
test('start adopts only the exact source and returns a sanitized negotiated contract',async()=>{
  const f=fixture(),r=await f.start('conversation');assert.equal(r.status,'ready');assert.deepEqual(r.audio,{inputEncoding:'pcm16',inputSampleRateHz:24000,outputEncoding:'pcm16',outputSampleRateHz:24000});
  assert.notEqual(r.id,'native-voice');assert.equal(JSON.stringify(r).includes('native-voice'),false);
  assert.deepEqual(f.calls.find(c=>c.method==='talk.session.create').params,{sessionKey:context.key,mode:'realtime',transport:'gateway-relay',brain:'agent-consult'});
  await assert.rejects(f.start(),{code:'BUSY'});await f.service.handle('stop',{id:r.id});assert.deepEqual(f.calls.at(-1).params,{sessionId:'native-voice'});await f.service.close();
});
test('replaced physical session during creation discards early output and closes only its voice handle',async()=>{
  let reads=0;const f=fixture({request:m=>{if(m==='sessions.describe'&&++reads===4)return {session:{...context,sessionId:'replacement',lifecycleRevision:'life-2'}};}});
  await assert.rejects(f.start(),{code:'SESSION_CHANGED'});assert.equal(f.events.some(e=>e.type==='transcript'||e.type==='audio'||e.status==='ready'),false);
  assert.deepEqual(f.calls.find(c=>c.method==='talk.session.close').params,{sessionId:'native-voice',discard:true});await f.service.close();
});
test('uncertain create with no returned voice ID closes the owning connection and never retries',async()=>{
  const f=fixture({request:m=>{if(m==='talk.session.create')throw Object.assign(new Error('Lost receipt'),{code:'CONNECTION'});}});
  await assert.rejects(f.start(),{code:'CONNECTION'});assert.equal(f.channels[0].closed,true);assert.equal(f.calls.filter(c=>c.method==='talk.session.create').length,1);await f.service.close();
});
test('lifecycle replacement blocks audio before dispatch and stops the voice session',async()=>{
  const f=fixture(),r=await f.start();f.life='changed';f.now=200000;
  await assert.rejects(f.service.handle('audio',{id:r.id,audioBase64:'AQID'}),{code:'SESSION_CHANGED'});await settled();
  assert.equal(f.calls.some(c=>c.method==='talk.session.appendAudio'),false);assert.equal(f.events.some(e=>e.type==='closed'),true);await f.service.close();
});
test('queued dictation frames flush in order before finalization; final text precedes close',async()=>{
  let release;const hold=new Promise(resolve=>{release=resolve;});let first=true;
  const f=fixture({request:async(m,p,{receive})=>{
    if(m==='talk.session.appendAudio'&&first){first=false;await hold;return {ok:true};}
    if(m==='talk.session.close'){receive({kind:'event',event:'talk.event',payload:{transcriptionSessionId:'native-voice',type:'transcript',text:'A fixture draft.',final:true,talkEvent:{sessionId:'native-voice',seq:1,id:'final-1',turnId:'turn-1'}}});return {ok:true};}
  }});const r=await f.start();
  const a=f.service.handle('audio',{id:r.id,audioBase64:'AQID'}),b=f.service.handle('audio',{id:r.id,audioBase64:'BAUG'});const stop=f.service.handle('stop',{id:r.id});await tick();
  assert.equal(f.calls.some(c=>c.method==='talk.session.close'),false);release();await Promise.all([a,b,stop]);
  assert.deepEqual(f.calls.filter(c=>c.method==='talk.session.appendAudio').map(c=>c.params.audioBase64),['AQID','BAUG']);
  assert.ok(f.events.findIndex(e=>e.type==='transcript')<f.events.findIndex(e=>e.type==='closed'));assert.equal(f.calls.some(c=>c.method==='chat.send'),false);await f.service.close();
});
test('cancel discards dictation and suppresses later final transcript',async()=>{
  const f=fixture(),r=await f.start();await f.service.handle('stop',{id:r.id,discard:true});f.emit({type:'transcript',text:'late',final:true});
  assert.deepEqual(f.calls.find(c=>c.method==='talk.session.close').params,{sessionId:'native-voice',discard:true});assert.equal(f.events.some(e=>e.type==='transcript'),false);await f.service.close();
});
test('navigation detaches live work; older gateways disconnect rather than guessing an abort',async()=>{
  const f=fixture(),r=await f.start('conversation');await f.service.handle('stop',{id:r.id,detach:true});
  assert.deepEqual(f.calls.find(c=>c.method==='talk.session.close').params,{sessionId:'native-voice',disposition:'detach'});await f.service.close();
  const g=fixture(),s=await g.start('conversation');g.channels[0].capabilities=[];await g.service.handle('stop',{id:s.id,detach:true});
  assert.equal(g.calls.some(c=>c.method==='talk.session.close'),false);assert.equal(g.channels[0].closed,true);await g.service.close();
});
test('transport loss never replays microphone frames or resumes automatically',async()=>{
  const f=fixture({request:m=>{if(m==='talk.session.appendAudio')throw Object.assign(new Error('secret provider error'),{code:'CONNECTION'});}}),r=await f.start();
  await assert.rejects(f.service.handle('audio',{id:r.id,audioBase64:'AQID'}),{code:'CONNECTION'});await settled();
  assert.equal(f.calls.filter(c=>c.method==='talk.session.appendAudio').length,1);assert.equal(f.channels.length,1);assert.equal(JSON.stringify(f.events).includes('secret provider'),false);await f.service.close();
});
test('foreign events, contradictory ownership and duplicate canonical transcripts are ignored',async()=>{
  const f=fixture(),r=await f.start();f.emit({transcriptionSessionId:'foreign',type:'transcript',text:'foreign',final:true});
  f.emit({type:'transcript',text:'foreign explicit owner',final:true,talkEvent:f.canonical('transcript.done',{sessionId:'foreign'})});
  const e={type:'transcript',text:'right',final:true,talkEvent:f.canonical('transcript.done')};f.emit(e);f.emit(e);
  assert.deepEqual(f.events.filter(e=>e.type==='transcript').map(e=>e.text),['right']);await f.service.handle('stop',{id:r.id,discard:true});await f.service.close();
});
test('audio and marks are bounded, owner-scoped and acknowledged only explicitly once',async()=>{
  const f=fixture(),r=await f.start('conversation');f.emit({type:'audio',audioBase64:'AAA=',talkEvent:f.canonical('output.audio.delta')});f.emit({type:'mark',markName:'native-mark'});
  const mark=f.events.find(e=>e.type==='mark');assert.ok(mark.markId);assert.equal(JSON.stringify(mark).includes('native-mark'),false);
  assert.equal(f.calls.some(c=>c.method==='talk.session.acknowledgeMark'),false);await f.service.handle('played',{id:r.id,markId:mark.markId});
  assert.deepEqual(f.calls.at(-1).params,{sessionId:'native-voice',markName:'native-mark'});await assert.rejects(f.service.handle('played',{id:r.id,markId:mark.markId}),{code:'INVALID'});
  await assert.rejects(f.service.handle('audio',{id:r.id,audioBase64:'AQID'}),{code:'INVALID'});await f.service.close();
});
test('native consult is forwarded once and only exact accepted run completion is returned',async()=>{
  const f=fixture(),r=await f.start('conversation');const call={type:'toolCall',callId:'native-call',name:'openclaw_agent_consult',args:{prompt:'Fixture task'}};f.emit(call);f.emit(call);await settled();
  assert.equal(f.calls.filter(c=>c.method==='talk.client.toolCall').length,1);
  f.chat({runId:'unrelated',state:'final',message:{text:'foreign'}});await settled();assert.equal(f.calls.some(c=>c.method==='talk.session.submitToolResult'),false);
  f.chat({runId:'native-run',sessionKey:context.key,agentId:'main',state:'final',message:{text:'Fixture result'}});await settled();
  assert.deepEqual(f.calls.find(c=>c.method==='talk.session.submitToolResult').params,{sessionId:'native-voice',callId:'native-call',result:{result:'Fixture result'}});await f.service.close();
});
test('early run final receipt is retained; textless final uses supported agent.wait',async()=>{
  let f;f=fixture({request:(m,p)=>{if(m==='talk.client.toolCall'){f.chat({runId:'native-run',sessionKey:context.key,agentId:'main',state:'final',message:{text:''}});return {runId:'native-run',agentId:'main',agentSessionKey:context.key};}}});
  await f.start('conversation');f.emit({type:'toolCall',callId:'call',name:'openclaw_agent_consult',args:{prompt:'fixture'}});await settled();
  assert.equal(f.calls.filter(c=>c.method==='agent.wait').length,1);assert.equal(f.calls.find(c=>c.method==='talk.session.submitToolResult').params.result.result,'OpenClaw finished with no text.');await f.service.close();
});
test('foreign early finals cannot fill the bounded cache before the current consult receipt',async()=>{
  let f;f=fixture({request:m=>{if(m==='talk.client.toolCall'){
    for(let i=0;i<32;i++)f.chat({runId:`foreign-${i}`,sessionKey:i%2?context.key:'agent:main:other',agentId:i%2?'other':'main',state:'final',message:{text:'Foreign result'}});
    f.chat({runId:'native-run',sessionKey:context.key,agentId:'main',state:'final',message:{text:'Own early result'}});
    return {runId:'native-run',agentId:'main',agentSessionKey:context.key};
  }}});
  await f.start('conversation');f.emit({type:'toolCall',callId:'call',name:'openclaw_agent_consult',args:{prompt:'fixture'}});await settled();
  assert.equal(f.calls.find(c=>c.method==='talk.session.submitToolResult').params.result.result,'Own early result');
  assert.equal(f.service.active.earlyChat.size,0);assert.equal(f.calls.some(c=>c.method==='agent.wait'),false);await f.service.close();
});
test('control uses native steering and arbitrary provider tools never execute',async()=>{
  const f=fixture();await f.start('conversation');f.emit({type:'toolCall',callId:'control',name:'openclaw_agent_control',args:{text:'status',mode:'status'}});f.emit({type:'toolCall',callId:'unknown',name:'exec',args:{command:'never'}});await settled();
  assert.equal(f.calls.filter(c=>c.method==='talk.session.steer').length,1);assert.equal(f.calls.some(c=>c.method==='exec'||c.method==='chat.send'),false);
  assert.ok(f.calls.find(c=>c.method==='talk.session.submitToolResult'&&c.params.callId==='unknown').params.result.error);await f.service.close();
});
test('cancelled tool calls cannot submit a late result',async()=>{
  const f=fixture();await f.start('conversation');f.emit({type:'toolCall',callId:'call',name:'openclaw_agent_consult',args:{prompt:'fixture'}});await settled();f.emit({type:'toolCallCancelled',callId:'call'});
  f.chat({runId:'native-run',state:'final',message:{text:'late'}});await settled();assert.equal(f.calls.some(c=>c.method==='talk.session.submitToolResult'),false);await f.service.close();
});
test('Gateway-forced consult is acknowledged as continuing without starting duplicate work',async()=>{
  const f=fixture();await f.start('conversation');f.emit({type:'toolCall',callId:'forced',name:'openclaw_agent_consult',args:{prompt:'fixture'},forced:true});await settled();
  assert.equal(f.calls.some(c=>c.method==='talk.client.toolCall'),false);assert.deepEqual(f.calls.find(c=>c.method==='talk.session.submitToolResult').params.options,{willContinue:true});await f.service.close();
});
test('returned foreign consultation target closes voice without forwarding completion',async()=>{
  const f=fixture({request:m=>m==='talk.client.toolCall'?{runId:'foreign',agentId:'other',agentSessionKey:'agent:other:x'}:undefined});await f.start('conversation');f.emit({type:'toolCall',callId:'call',name:'openclaw_agent_consult',args:{prompt:'fixture'}});await settled();
  assert.equal(f.calls.some(c=>c.method==='agent.wait'||c.method==='talk.session.submitToolResult'),false);assert.equal(f.events.some(e=>e.code==='SESSION_CHANGED'),true);await f.service.close();
});
test('renderer cannot supply arbitrary methods, foreign IDs or oversized input',async()=>{
  const f=fixture();for(const [action,p] of [['start',{...context,key:'global',mode:'dictation'}],['start',{...context,mode:'dictation',provider:'arbitrary'}],['audio',{id:'x',audioBase64:'A'.repeat(65540)}],['write',{method:'config.patch'}]])await assert.rejects(f.service.handle(action,p),{code:'INVALID'});
  assert.equal(f.channels.length,0);const r=await f.start();await assert.rejects(f.service.handle('audio',{id:'other',audioBase64:'AQID'}),{code:'SESSION_CHANGED'});await f.service.handle('stop',{id:r.id,discard:true});await f.service.close();
});
test('audio admission is bounded and stops visibly instead of dropping queued data silently',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});const f=fixture({request:async m=>{if(m==='talk.session.appendAudio'){await gate;return {ok:true};}}});const r=await f.start();
  const jobs=[];for(let i=0;i<8;i++)jobs.push(f.service.handle('audio',{id:r.id,audioBase64:'AQID'}).catch(e=>e));
  await assert.rejects(f.service.handle('audio',{id:r.id,audioBase64:'AQID'}),{code:'BUSY'});release();await Promise.all(jobs);await settled();assert.equal(f.events.some(e=>e.type==='error'&&e.code==='BUSY'),true);await f.service.close();
});
test('helper permits only fixed voice requests and projects no reasoning/tool content',()=>{
  const request=(method,params)=>({id:1,method,params});
  assert.equal(validateRequest(request('talk.session.create',{sessionKey:context.key,mode:'realtime',transport:'gateway-relay',brain:'agent-consult'})),true);
  for(const r of [request('config.patch',{}),request('chat.send',{message:'bad'}),request('talk.session.create',{sessionKey:context.key,mode:'realtime',transport:'managed-room',brain:'direct-tools'}),request('talk.session.appendAudio',{sessionId:'x',audioBase64:'bad'}),request('talk.client.toolCall',{sessionKey:context.key,relaySessionId:'x',callId:'c',name:'exec',args:{}})])assert.equal(validateRequest(r),false);
  const p=projectChat({runId:'r',state:'final',message:{content:[{type:'thinking',text:'secret reasoning'},{type:'text',text:'visible'}]}});assert.equal(p.message.text,'visible');
});
test('private channel bounds IPC and rejects pending work on loss without exposing raw errors',async()=>{
  const child=new EventEmitter(),stdout=new EventEmitter(),stdin=new EventEmitter(),writes=[],events=[];let launch;
  stdout.setEncoding=()=>{};stdin.writableLength=0;stdin.write=line=>writes.push(JSON.parse(line));child.stdout=stdout;child.stdin=stdin;child.kill=()=>{child.killed=true;};
  const channel=new VoiceChannel({home:'/fixture',node:'/fixture/node',target:{url:'ws://127.0.0.1:1234',configPath:'/fixture/openclaw.json'}},'/fixture/helper.cjs',e=>events.push(e),(file,args,options)=>{launch={file,args,options};return child;});
  stdout.emit('data',JSON.stringify({kind:'status',status:'ready',methods,capabilities:['talk-session-close-disposition']})+'\n');
  const read=channel.request('talk.catalog',{sessionKey:context.key});await tick();
  stdout.emit('data',JSON.stringify({kind:'reply',id:writes[0].id,ok:true,data:catalog()})+'\n');assert.equal((await read).realtime.ready,true);
  assert.equal(launch.options.shell,false);assert.deepEqual(launch.args,['/fixture/helper.cjs','ws://127.0.0.1:1234']);assert.equal(Object.hasOwn(launch.options.env,'NODE_OPTIONS'),false);
  const pending=channel.request('talk.session.appendAudio',{sessionId:'voice',audioBase64:'AAA='});await tick();child.emit('exit',1);await assert.rejects(pending,{code:'CONNECTION'});assert.equal(child.killed,true);assert.equal(writes.length,2);
});
test('agent-launched helper refuses before authentication imports or Gateway access',async()=>{
  const result=await promisify(execFile)(process.execPath,[path.resolve(__dirname,'../desktop/src/voice-rpc.cjs'),'ws://127.0.0.1:1'],{env:{OPENCLAW_SHELL:'1'},timeout:3000}).catch(e=>e);
  assert.equal(result.code,1);assert.deepEqual(JSON.parse(result.stdout),{kind:'status',status:'disconnected',code:'CONFIG'});
});
test('explicit fixture voice uses only injected session reads, with no helper or provider',async()=>{
  const reads=[],events=[];const service=new VoiceService({fixture:true,notify:e=>events.push(e),transport:()=>({request:async(m,p)=>{reads.push(m);return {session:{...context,lifecycleRevision:'fixture-life'}};}})});
  const r=await service.handle('start',{...context,mode:'dictation'});await service.handle('audio',{id:r.id,audioBase64:'AQID'});await service.handle('stop',{id:r.id});
  assert.equal(reads.every(m=>m==='sessions.describe'),true);assert.match(events.find(e=>e.type==='transcript').text,/Fixture dictation/);await service.close();
});
test('explicit fixture conversation negotiates live audio and playback marks without a provider',async()=>{
  const events=[];const service=new VoiceService({fixture:true,notify:e=>events.push(e),transport:()=>({request:async()=>({session:{...context,lifecycleRevision:'fixture-life'}})})});
  const r=await service.handle('start',{...context,mode:'conversation'});assert.equal(r.status,'ready');await service.handle('audio',{id:r.id,audioBase64:'AAA='});
  assert.equal(events.find(e=>e.type==='audio').audioBase64.length,6400);const mark=events.find(e=>e.type==='mark');await service.handle('played',{id:r.id,markId:mark.markId});await service.handle('stop',{id:r.id});await service.close();
});
