import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeVoiceFrame,decodeVoicePCM,validVoiceAudio,createVoiceController} from '../desktop/ui/voice-view.mjs';

const context={key:'agent:main:main',agentId:'main',sessionId:'physical-fixture'};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function stream() {
  const track=new EventTarget();track.stopped=false;track.stop=()=>{track.stopped=true;};
  return {track,getTracks:()=>[track],getAudioTracks:()=>[track]};
}
function fixture({hook,getMedia}={}) {
  const calls=[],streams=[],contexts=[],worklets=[],sources=[],dictations=[],errors=[],changes=[];let listener;
  const node=()=>({connect(){return this;},disconnect(){this.disconnected=true;}});
  const desktop={onVoiceEvent(callback){listener=callback;return()=>{listener=null;};},async voice(operation,params){
    calls.push({operation,params});const override=hook?.(operation,params);if(override!==undefined)return override;
    if(operation==='catalog')return {context:{...params},dictation:{available:true},conversation:{available:true,supportsBargeIn:false}};
    if(operation==='capturePermission')return {granted:!params.cancel};
    if(operation==='start')return {id:'voice-fixture',context,mode:params.mode,status:'ready',supportsBargeIn:false,audio:params.mode==='dictation'?{inputEncoding:'g711_ulaw',inputSampleRateHz:8000}:{inputEncoding:'pcm16',inputSampleRateHz:24000,outputEncoding:'pcm16',outputSampleRateHz:24000}};
    return {id:params.id,status:'closed'};
  }};
  const controller=createVoiceController({desktop,onChange:record=>changes.push(record?.phase||'idle'),onError:error=>errors.push(error),onDictation:(owner,text)=>dictations.push({owner,text}),
    getUserMedia:async constraints=>{assert.equal(constraints.video,false);const value=getMedia?await getMedia():stream();streams.push(value);return value;},
    createAudioContext:options=>{
      const ac={sampleRate:options.sampleRate,currentTime:0,destination:{},audioWorklet:{async addModule(url){ac.moduleURL=url;}},
        createMediaStreamSource:node,createGain:()=>({...node(),gain:{value:1}}),
        createBuffer:(_channels,length,rate)=>({length,rate,copyToChannel(samples){this.samples=samples;}}),
        createBufferSource:()=>{const source={...node(),start(at){this.at=at;},stop(){this.stopped=true;}};sources.push(source);return source;},
        async resume(){this.running=true;},async close(){this.closed=true;}};contexts.push(ac);return ac;
    },createWorkletNode:()=>{const worklet={...node(),port:{messages:[],postMessage(message){this.messages.push(message);},close(){this.closed=true;}}};worklets.push(worklet);return worklet;},
    workletURL:'openclaw-plus://ui/voice-capture-worklet.js'});
  const emit=(event,mode=controller.current?.mode||'conversation')=>listener?.({id:'voice-fixture',context,mode,...event});
  const frame=()=>worklets.at(-1).port.onmessage?.({data:{type:'frame',samples:new Float32Array(contexts.at(-1).sampleRate*.05)}});
  return {controller,calls,streams,contexts,worklets,sources,dictations,errors,changes,emit,frame};
}

test('PCM16 and G.711 μ-law encoding use bounded canonical samples and little-endian PCM',()=>{
  assert.deepEqual([...Buffer.from(encodeVoiceFrame(new Float32Array([-1,0,1]),'pcm16'),'base64')],[0,128,0,0,255,127]);
  assert.deepEqual([...Buffer.from(encodeVoiceFrame(new Float32Array([-1,0,1]),'g711_ulaw'),'base64')],[0,255,128]);
  assert.deepEqual([...decodeVoicePCM('AIAAAP9/')],[-1,0,32767/32768]);
  for(const value of ['https://example.com','YQ==','YR==','!!!!'])assert.throws(()=>decodeVoicePCM(value));
  assert.throws(()=>encodeVoiceFrame(new Float32Array([NaN]),'pcm16'));
  assert.equal(validVoiceAudio({inputEncoding:'g711_ulaw',inputSampleRateHz:24000},'dictation'),false);
});

test('an unavailable voice mode never asks for a microphone or starts capture',async()=>{
  const f=fixture({hook:operation=>operation==='catalog'?{context,dictation:{available:false,reason:'Not configured'},conversation:{available:false}}:undefined});
  await f.controller.start(context,'dictation');
  assert.equal(f.streams.length,0);assert.equal(f.calls.some(call=>call.operation==='capturePermission'&&!call.params.cancel),false);
  assert.equal(f.calls.some(call=>call.operation==='start'),false);assert.equal(f.errors[0].message,'Not configured');
});

test('cancelling pending OS permission or capture closes late resources and never starts a session',async()=>{
  for(const kind of ['permission','capture']) {
    const held=deferred(),late=stream();const f=fixture({hook:(op,p)=>kind==='permission'&&op==='capturePermission'&&!p.cancel?held.promise:undefined,getMedia:kind==='capture'?()=>held.promise:undefined});
    const starting=f.controller.start(context,'dictation');await tick();await f.controller.stop({discard:true,detach:true});
    held.resolve(kind==='permission'?{granted:true}:late);await starting;
    assert.equal(f.calls.some(call=>call.operation==='start'),false);assert.equal(f.controller.current,null);
    if(kind==='capture')assert.equal(late.track.stopped,true);
  }
});

test('main window cancellation invalidates pending capture even without renderer visibility or a native session ID',async()=>{
  const held=deferred(),late=stream(),f=fixture({getMedia:()=>held.promise});
  const starting=f.controller.start(context,'dictation');await tick();
  assert.equal(f.controller.current.id,null);
  f.emit({type:'capture-cancelled',context:undefined,id:undefined,mode:undefined});
  assert.equal(f.controller.current,null);held.resolve(late);await starting;
  assert.equal(late.track.stopped,true);
  assert.equal(f.calls.some(call=>call.operation==='start'),false);
  assert.deepEqual(f.dictations,[]);
});

test('capture uses the negotiated sample rate and serial acknowledged 50ms frames',async()=>{
  const first=deferred();let inputs=0;const f=fixture({hook:op=>op==='audio'&&++inputs===1?first.promise:undefined});
  await f.controller.start(context,'dictation');assert.equal(f.contexts[0].sampleRate,8000);
  assert.equal(f.contexts[0].moduleURL,'openclaw-plus://ui/voice-capture-worklet.js');
  f.frame();f.frame();await tick();assert.equal(f.calls.filter(call=>call.operation==='audio').length,1);
  first.resolve({});await tick();assert.equal(f.calls.filter(call=>call.operation==='audio').length,2);
  assert.equal(Buffer.from(f.calls.find(call=>call.operation==='audio').params.audioBase64,'base64').length,400);
  assert.equal(f.worklets[0].port.messages.filter(message=>message.type==='ack').length,2);
  await f.controller.stop({discard:true,detach:true});assert.ok(f.streams[0].track.stopped&&f.contexts[0].closed);
});

test('native final dictation is appended once to its exact owner, only on finalization',async()=>{
  const held=deferred(),f=fixture({hook:op=>op==='stop'?held.promise:undefined});await f.controller.start(context,'dictation');
  f.emit({type:'transcript',text:'unfinished',final:false,transcriptId:'partial'});assert.equal(f.dictations.length,0);
  const stopping=f.controller.stop();await tick();assert.equal(f.controller.current.phase,'finalizing');assert.equal(f.streams[0].track.stopped,true);
  const final={type:'transcript',text:'Final dictated sentence.',final:true,transcriptId:'final-1'};f.emit(final);f.emit(final);
  assert.equal(f.dictations.length,0);f.emit({type:'closed'});assert.deepEqual(f.dictations,[{owner:context,text:'Final dictated sentence.'}]);
  held.resolve({id:'voice-fixture',status:'closed'});await stopping;assert.equal(f.dictations.length,1);assert.equal(f.controller.current,null);
});

test('Cancel discards uncommitted dictation and ignores late or foreign transcript events',async()=>{
  const f=fixture();await f.controller.start(context,'dictation');
  f.emit({type:'transcript',text:'foreign',final:true,transcriptId:'foreign',context:{...context,sessionId:'different'}});
  f.emit({type:'transcript',text:'pending final',final:true,transcriptId:'final'});
  await f.controller.stop({discard:true,detach:true});f.emit({type:'transcript',text:'late final',final:true,transcriptId:'late'},'dictation');
  assert.deepEqual(f.dictations,[]);assert.equal(f.controller.current,null);
});

test('an explicit new start waits for detached native teardown after navigation clears local capture',async()=>{
  const held=deferred();let stopping=false,starts=0;
  const f=fixture({hook:operation=>{
    if(operation==='stop'){stopping=true;return held.promise.then(()=>{stopping=false;return {status:'closed'};});}
    if(operation==='start'){starts++;if(stopping)throw new Error('Native voice is still stopping.');}
  }});
  await f.controller.start(context,'dictation');
  const detached=f.controller.stop({discard:true,detach:true});
  assert.equal(f.controller.current,null);assert.equal(f.streams[0].track.stopped,true);
  const next=f.controller.start(context,'dictation');await tick();
  assert.equal(starts,1,'another native start must not overtake the pending detach');
  assert.equal(f.streams.length,1,'capture must also wait for the pending detach');
  held.resolve();await detached;await next;
  assert.equal(starts,2);assert.equal(f.controller.current.phase,'listening');assert.deepEqual(f.errors,[]);
  await f.controller.stop({discard:true,detach:true});
});

test('cancelling a new start while prior teardown is pending never restarts capture afterward',async()=>{
  const held=deferred(),f=fixture({hook:operation=>operation==='stop'?held.promise:undefined});
  await f.controller.start(context,'dictation');
  const detached=f.controller.stop({discard:true,detach:true});
  const next=f.controller.start(context,'dictation');await tick();
  const cancelled=f.controller.stop({discard:true,detach:true});
  held.resolve();await Promise.all([detached,next,cancelled]);
  assert.equal(f.controller.current,null);assert.equal(f.streams.length,1);
  assert.equal(f.calls.filter(call=>call.operation==='start').length,1);
  assert.deepEqual(f.dictations,[]);assert.deepEqual(f.errors,[]);
});

test('live caption turns preserve each speaker’s words without attributing the user’s text to the agent',async()=>{
  const f=fixture();await f.controller.start(context,'conversation');
  f.emit({type:'transcript',role:'user',text:'Please review my changes.',textMode:'replace',final:true,transcriptId:'user-turn'});
  f.emit({type:'transcript',role:'assistant',text:'I will review',textMode:'delta',final:false,transcriptId:'assistant-part-1'});
  assert.equal(f.controller.current.transcript,'I will review');assert.equal(f.controller.current.transcriptRole,'assistant');
  f.emit({type:'transcript',role:'assistant',text:' the changes.',textMode:'delta',final:true,transcriptId:'assistant-part-2'});
  assert.equal(f.controller.current.transcript,'I will review the changes.');
  f.emit({type:'transcript',role:'user',text:'Thanks.',textMode:'delta',final:true,transcriptId:'next-user-turn'});
  assert.equal(f.controller.current.transcript,'Thanks.');assert.equal(f.controller.current.transcriptRole,'user');
  assert.deepEqual(f.dictations,[],'live captions never fabricate typed chat messages');
  await f.controller.stop({discard:true,detach:true});
});

test('speaker playback mutes non-barge-in input and acknowledges marks only after sound or explicit clear',async()=>{
  const f=fixture();await f.controller.start(context,'conversation');const pcm=Buffer.alloc(4800).toString('base64');
  f.emit({type:'audio',audioBase64:pcm,turnId:'turn-1'});f.emit({type:'mark',markId:'mark-1'});f.frame();await tick();
  assert.equal(f.calls.filter(call=>call.operation==='played').length,0);assert.equal(f.calls.filter(call=>call.operation==='audio').length,0);
  f.contexts[0].currentTime=.1;f.sources[0].onended();await tick();assert.equal(f.calls.filter(call=>call.operation==='played').length,1);
  f.frame();await tick();assert.equal(f.calls.filter(call=>call.operation==='audio').length,1);
  f.emit({type:'audio',audioBase64:pcm,turnId:'turn-2'});f.emit({type:'mark',markId:'mark-2'});f.emit({type:'clear',turnId:'turn-2'});await tick();
  assert.equal(f.calls.filter(call=>call.operation==='played').length,2);assert.equal(f.sources[1].stopped,true);
  f.emit({type:'audio',audioBase64:pcm,turnId:'turn-2'});assert.equal(f.sources.length,2);
  await f.controller.stop({discard:true,detach:true});
});

test('capture backlog and oversized playback stop visibly instead of retaining unbounded audio',async()=>{
  const held=deferred(),f=fixture({hook:op=>op==='audio'?held.promise:undefined});await f.controller.start(context,'conversation');
  for(let i=0;i<10;i++)f.frame();assert.equal(f.controller.current,null);assert.equal(f.streams[0].track.stopped,true);assert.equal(f.errors.length,1);
  held.resolve({});await tick();assert.equal(f.calls.filter(call=>call.operation==='audio').length,1);
  const g=fixture();await g.controller.start(context,'conversation');const pcm=Buffer.alloc(48000).toString('base64');
  for(let i=0;i<31;i++)g.emit({type:'audio',audioBase64:pcm,turnId:'long-turn'});
  assert.equal(g.controller.current,null);assert.equal(g.errors.length,1);assert.ok(g.sources.every(source=>source.stopped));
});

test('a returned session is detached if negotiated audio is unsupported',async()=>{
  const f=fixture({hook:op=>op==='start'?{id:'voice-fixture',context,mode:'conversation',status:'ready',audio:{inputEncoding:'unexpected'}}:undefined});
  await f.controller.start(context,'conversation');await tick();
  assert.equal(f.errors.length,1);assert.equal(f.streams[0].track.stopped,true);
  assert.ok(f.calls.some(call=>call.operation==='stop'&&call.params.id==='voice-fixture'&&call.params.detach===true));
});
