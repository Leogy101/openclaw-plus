const contextKey=context=>JSON.stringify([context?.key,context?.agentId,context?.sessionId]);
const exactContext=context=>context&&['key','agentId','sessionId'].every(key=>typeof context[key]==='string'&&context[key].length>0);
const voiceError=message=>new Error(message);
const text=value=>typeof value==='string'?value:'';
function base64(bytes) {let binary='';for(const value of bytes)binary+=String.fromCharCode(value);return btoa(binary);}
function audioBytes(value) {
  if(typeof value!=='string'||!value.length||value.length>65536||value.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))throw voiceError('OpenClaw returned invalid voice audio.');
  const binary=atob(value);if(btoa(binary)!==value)throw voiceError('OpenClaw returned invalid voice audio.');
  return Uint8Array.from(binary,c=>c.charCodeAt(0));
}
export function encodeVoiceFrame(samples,encoding) {
  if(!(samples instanceof Float32Array)||!samples.length||samples.length>9600||!['pcm16','g711_ulaw'].includes(encoding))throw voiceError('Unsupported microphone audio.');
  const bytes=new Uint8Array(samples.length*(encoding==='pcm16'?2:1)),view=new DataView(bytes.buffer);
  for(let i=0;i<samples.length;i++) {
    const value=samples[i];if(!Number.isFinite(value))throw voiceError('Invalid microphone sample.');
    const clipped=Math.max(-1,Math.min(1,value));let sample=Math.round(clipped*(clipped<0?32768:32767));
    if(encoding==='pcm16')view.setInt16(i*2,sample,true);
    else {
      const sign=sample<0?128:0;if(sign)sample=-sample;
      sample=Math.min(sample,32635)+132;
      let exponent=7;for(let mask=16384;exponent>0&&!(sample&mask);mask>>=1)exponent--;
      bytes[i]=~(sign|(exponent<<4)|((sample>>(exponent+3))&15))&255;
    }
  }
  return base64(bytes);
}
export function decodeVoicePCM(value) {
  const bytes=audioBytes(value);if(bytes.length%2)throw voiceError('OpenClaw returned incomplete voice audio.');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),samples=new Float32Array(bytes.length/2);
  for(let i=0;i<samples.length;i++)samples[i]=view.getInt16(i*2,true)/32768;
  return samples;
}
export function validVoiceAudio(audio,mode) {
  return audio&&Number.isSafeInteger(audio.inputSampleRateHz)&&audio.inputSampleRateHz>=8000&&audio.inputSampleRateHz<=48000&&
    (mode==='dictation'?audio.inputEncoding==='g711_ulaw'&&audio.inputSampleRateHz===8000:
      audio.inputEncoding==='pcm16'&&audio.outputEncoding==='pcm16'&&Number.isSafeInteger(audio.outputSampleRateHz)&&audio.outputSampleRateHz>=8000&&audio.outputSampleRateHz<=48000);
}

export function createVoiceController({desktop,onChange=()=>{},onError=()=>{},onDictation=()=>{},stopOtherAudio=()=>{},
  getUserMedia=constraints=>navigator.mediaDevices.getUserMedia(constraints),
  createAudioContext=options=>new AudioContext(options),
  createWorkletNode=context=>new AudioWorkletNode(context,'openclaw-voice-capture',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]}),
  workletURL=new URL('./voice-capture-worklet.js',import.meta.url).href}) {
  let current=null,catalogCache=null,pendingStop=Promise.resolve();
  const call=(operation,params={})=>desktop.voice(operation,params);
  const active=record=>current===record&&!record.discarded;
  const change=(record,phase)=>{if(current!==record||phase&&record.phase===phase)return;if(phase)record.phase=phase;onChange(record);};
  // Local capture clears immediately; an explicit next start still awaits native teardown.
  function trackStop(promise){pendingStop=Promise.all([pendingStop,Promise.resolve(promise).catch(()=>{})]).then(()=>{});return pendingStop;}
  function disarm(){return trackStop(call('capturePermission',{cancel:true}));}
  function closeTracks(stream){for(const track of stream?.getTracks?.()||[])track.stop();}
  function releaseCapture(record) {
    record.capturing=false;
    if(record.worklet){record.worklet.port.onmessage=null;record.worklet.port.postMessage({type:'stop'});record.worklet.port.close?.();record.worklet.disconnect();record.worklet=null;}
    record.source?.disconnect();record.silent?.disconnect();record.source=null;record.silent=null;
    closeTracks(record.stream);record.stream=null;disarm();
  }
  function clearPlayback(record,acknowledge=false) {
    for(const source of record.sources){source.onended=null;try{source.stop();}catch{}}
    record.sources.clear();record.playbackEnd=record.audioContext?.currentTime||0;
    if(record.markTimer){clearTimeout(record.markTimer);record.markTimer=null;}
    if(acknowledge)for(const mark of record.marks.splice(0))ackMark(record,mark.id);
    else record.marks=[];
  }
  function cleanup(record) {
    if(record.cleaned)return;record.cleaned=true;releaseCapture(record);clearPlayback(record);
    record.inputQueue=[];record.early=[];record.audioContext?.close().catch(()=>{});record.audioContext=null;
  }
  function commitDictation(record) {
    if(record.mode!=='dictation'||record.discarded||record.committed)return;
    record.committed=true;const value=[...record.finalText.values()].join('\n').trim();
    if(value)onDictation({...record.context},value);
  }
  function finish(record,{commit=false}={}) {
    if(commit)commitDictation(record);cleanup(record);
    if(current===record){current=null;onChange(null);}
  }
  function fail(record,error) {
    if(current!==record)return;
    // Only native final transcripts survive an ordinary error; partial words are never appended.
    commitDictation(record);record.discarded=true;finish(record);
    if(record.id&&!record.stopRequested){record.stopRequested=true;trackStop(call('stop',{id:record.id,discard:true,detach:true}));}
    onError(error instanceof Error?error:voiceError('Voice could not continue.'));
  }
  async function catalog(context) {
    if(!exactContext(context))throw voiceError('Choose an exact conversation before using voice.');
    const result=await call('catalog',{key:context.key,agentId:context.agentId,sessionId:context.sessionId});
    if(!result||contextKey(result.context)!==contextKey(context))throw voiceError('Voice options belong to a different conversation.');
    catalogCache={key:contextKey(context),at:Date.now(),value:result};return result;
  }
  function ackMark(record,markId) {
    if(!active(record)||!record.id)return;
    call('played',{id:record.id,markId}).catch(error=>{if(active(record))fail(record,error);});
  }
  function checkMarks(record) {
    if(!active(record)||!record.audioContext)return;
    if(record.markTimer){clearTimeout(record.markTimer);record.markTimer=null;}
    const now=record.audioContext.currentTime;
    while(record.marks.length&&record.marks[0].at<=now)ackMark(record,record.marks.shift().id);
    if(record.marks.length)record.markTimer=setTimeout(()=>checkMarks(record),Math.min(250,Math.max(10,(record.marks[0].at-now)*1000)));
  }
  function output(record,event) {
    if(record.mode!=='conversation'||!record.audioContext||record.discarded)return;
    if(event.turnId&&record.clearedTurns.has(event.turnId))return;
    const samples=decodeVoicePCM(event.audioBase64),rate=record.audio.outputSampleRateHz;
    const start=Math.max(record.audioContext.currentTime,record.playbackEnd),end=start+samples.length/rate;
    if(end-record.audioContext.currentTime>30||record.sources.size>=600)throw voiceError('Voice output could not keep up. The call stopped; start again when ready.');
    const buffer=record.audioContext.createBuffer(1,samples.length,rate);buffer.copyToChannel(samples,0);
    const source=record.audioContext.createBufferSource();source.buffer=buffer;source.connect(record.audioContext.destination);
    record.sources.add(source);record.playbackEnd=end;
    source.onended=()=>{record.sources.delete(source);checkMarks(record);if(active(record)&&record.playbackEnd<=record.audioContext.currentTime)change(record,'listening');};
    source.start(start);change(record,'speaking');
  }
  function queueEarly(record,event) {
    record.earlyBytes+=(event.audioBase64?.length||event.text?.length||256);
    if(record.early.length>=64||record.earlyBytes>2*1024*1024)throw voiceError('Voice startup received too much data. Start again when ready.');
    record.early.push(event);
  }
  function processEvent(record,event) {
    if(!active(record))return;
    if(!record.id){queueEarly(record,event);return;}
    if(event.id!==record.id)return;
    if(!record.setup&&['audio','mark','clear'].includes(event.type)){queueEarly(record,event);return;}
    if(event.type==='state') {
      if(event.status==='ready'){record.ready=true;if(record.setup&&!record.finalizing)change(record,'listening');}
      else if(event.status==='connecting'&&!record.finalizing)change(record,'connecting');
    } else if(event.type==='transcript') {
      if(typeof event.text!=='string'||event.text.length>262144)throw voiceError('The voice transcript was too large.');
      const role=event.role||'user';
      record.transcript=event.textMode==='delta'&&role===record.transcriptRole?(record.transcript+event.text).slice(-2000):event.text.slice(-2000);record.transcriptRole=role;
      if(record.mode==='dictation'&&event.final===true&&event.text.trim()) {
        if(typeof event.transcriptId!=='string'||!event.transcriptId||event.transcriptId.length>512)throw voiceError('The final dictation identity was unavailable.');
        if(!record.finalText.has(event.transcriptId)) {
          if(record.finalText.size>=128||[...record.finalText.values()].reduce((n,value)=>n+value.length,0)+event.text.length>262144)throw voiceError('Dictation reached its size limit.');
          record.finalText.set(event.transcriptId,event.text);
        }
      }
      change(record);
    } else if(event.type==='audio')output(record,event);
    else if(event.type==='mark') {
      if(typeof event.markId!=='string'||!event.markId||event.markId.length>512)throw voiceError('Voice playback confirmation was unavailable.');
      if(record.seenMarks.has(event.markId))return;
      if(record.marks.length>=128)throw voiceError('Voice playback confirmations could not keep up.');
      record.seenMarks.add(event.markId);if(record.seenMarks.size>512)record.seenMarks.delete(record.seenMarks.values().next().value);
      record.marks.push({id:event.markId,at:record.playbackEnd});checkMarks(record);
    } else if(event.type==='clear') {
      if(event.turnId){record.clearedTurns.add(event.turnId);if(record.clearedTurns.size>128)record.clearedTurns.delete(record.clearedTurns.values().next().value);}
      clearPlayback(record,true);change(record,'listening');
    } else if(event.type==='error')fail(record,voiceError(text(event.message)||'OpenClaw could not continue voice.'));
    else if(event.type==='closed')finish(record,{commit:record.mode==='dictation'});
  }
  const unsubscribe=desktop.onVoiceEvent(event=>{
    // Main-process window lifecycle cancellation also applies before a native ID exists.
    if(event?.type==='capture-cancelled'){stop({discard:true,detach:true});return;}
    const record=current;if(!record||!event||contextKey(event.context)!==contextKey(record.context)||event.mode!==record.mode)return;
    try{processEvent(record,event);}catch(error){fail(record,error);}
  });
  function flushEarly(record) {
    const events=record.early.splice(0);record.earlyBytes=0;
    for(const event of events){if(!active(record))break;processEvent(record,event);}
  }
  function acceptFrame(record,event) {
    if(!active(record))return;
    const ack=()=>record.worklet?.port.postMessage({type:'ack'});
    if(!record.capturing){if(event.type==='frame')ack();return;}
    if(event.type==='overflow'){fail(record,voiceError('The microphone connection could not keep up. Voice stopped; no audio will be resent.'));return;}
    if(event.type!=='frame')return;
    if(!record.ready||record.finalizing||record.mode==='conversation'&&!record.supportsBargeIn&&record.playbackEnd>record.audioContext.currentTime){ack();return;}
    try {
      if(!(event.samples instanceof Float32Array)||event.samples.length>record.audio.inputSampleRateHz/10)throw voiceError('The microphone returned an unsupported audio frame.');
      if(record.inputQueue.length>=8)throw voiceError('The microphone connection could not keep up. Voice stopped; no audio will be resent.');
      record.inputQueue.push({audioBase64:encodeVoiceFrame(event.samples,record.audio.inputEncoding),ack});
      if(record.draining)return;
      record.draining=true;
      record.inputPromise=(async()=>{
        try {
          while(active(record)&&record.inputQueue.length) {
            const frame=record.inputQueue.shift();await call('audio',{id:record.id,audioBase64:frame.audioBase64});frame.ack();
          }
        }catch(error){fail(record,error);}finally{record.draining=false;}
      })();
    } catch(error){fail(record,error);}
  }
  async function start(context,mode) {
    if(!exactContext(context)||!['dictation','conversation'].includes(mode)){onError(voiceError('Choose a conversation and voice mode.'));return;}
    const previousStop=stop({discard:true,detach:true});
    const record={context:{key:context.key,agentId:context.agentId,sessionId:context.sessionId},mode,phase:'checking',id:null,ready:false,setup:false,capturing:false,discarded:false,
      inputQueue:[],inputPromise:Promise.resolve(),draining:false,early:[],earlyBytes:0,sources:new Set(),marks:[],seenMarks:new Set(),clearedTurns:new Set(),playbackEnd:0,
      finalText:new Map(),transcript:'',transcriptRole:'user',supportsBargeIn:false};
    current=record;change(record);
    try {
      await previousStop;if(!active(record))return;
      const options=catalogCache?.key===contextKey(context)&&Date.now()-catalogCache.at<60000?catalogCache.value:await catalog(context);
      if(!active(record))return;
      if(options?.[mode]?.available!==true)throw voiceError(options?.[mode]?.reason||'This voice mode is not configured in OpenClaw.');
      stopOtherAudio();change(record,'permission');
      const permission=await call('capturePermission',{});if(!active(record))return;
      if(permission?.granted!==true)throw voiceError('Microphone access was not granted. You can allow it in macOS settings and try again.');
      const stream=await getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
      if(!active(record)){closeTracks(stream);return;}
      record.stream=stream;change(record,'connecting');
      const result=await call('start',{...record.context,mode});
      if(!active(record)){if(result?.id)trackStop(call('stop',{id:result.id,discard:true,detach:true}));return;}
      if(typeof result?.id==='string'&&result.id.length>0&&result.id.length<=512&&!/[\x00-\x1f\x7f]/.test(result.id))record.id=result.id;
      if(!record.id||result.mode!==mode||result.context&&contextKey(result.context)!==contextKey(context)||!validVoiceAudio(result.audio,mode))throw voiceError('OpenClaw returned unsupported voice settings.');
      record.id=result.id;record.audio=result.audio;record.ready=result.status==='ready';record.supportsBargeIn=result.supportsBargeIn===true;
      flushEarly(record);if(!active(record))return;
      const audioContext=createAudioContext({sampleRate:result.audio.inputSampleRateHz,latencyHint:'interactive'});record.audioContext=audioContext;
      if(audioContext.sampleRate!==result.audio.inputSampleRateHz)throw voiceError('This Mac could not use the required microphone sample rate.');
      await audioContext.audioWorklet.addModule(workletURL);if(!active(record))return;
      const source=audioContext.createMediaStreamSource(stream),worklet=createWorkletNode(audioContext),silent=audioContext.createGain();silent.gain.value=0;
      record.source=source;record.worklet=worklet;record.silent=silent;
      worklet.port.onmessage=event=>acceptFrame(record,event.data||{});source.connect(worklet);worklet.connect(silent);silent.connect(audioContext.destination);
      for(const track of stream.getAudioTracks())track.addEventListener('ended',()=>{if(active(record)&&record.capturing)fail(record,voiceError('The microphone disconnected. Start voice again when it is available.'));},{once:true});
      await audioContext.resume();if(!active(record))return;
      record.setup=true;record.capturing=true;flushEarly(record);
      if(active(record))change(record,record.playbackEnd>audioContext.currentTime?'speaking':record.ready?'listening':'connecting');
    }catch(error){fail(record,error);}
  }
  function stop({discard=false,detach=false}={}) {
    const record=current;if(!record)return disarm();
    if(discard||detach||record.mode==='conversation'||!record.id) {
      record.discarded=discard||detach||!record.id;finish(record);
      if(record.id&&!record.stopRequested){record.stopRequested=true;return trackStop(call('stop',{id:record.id,...(discard?{discard:true}:{}),...(detach?{detach:true}:{})}));}
      return trackStop(record.stopPromise);
    }
    if(record.finalizing)return record.stopPromise;
    record.finalizing=true;releaseCapture(record);change(record,'finalizing');
    record.stopPromise=(async()=>{
      await record.inputPromise;if(!active(record))return;
      record.stopRequested=true;
      try{await call('stop',{id:record.id});if(active(record))finish(record,{commit:true});}
      catch(error){fail(record,error);}
    })();
    return trackStop(record.stopPromise);
  }
  return {get current(){return current;},catalog,start,stop,destroy(){stop({discard:true,detach:true});unsubscribe?.();}};
}
