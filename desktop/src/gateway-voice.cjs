'use strict';
const path=require('node:path');
const {spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const {ReadError}=require('./gateway-cli.cjs');
const {validateRequest,MAX_LINE,MAX_OUTPUT}=require('./voice-rpc.cjs');
const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
const identifier=x=>typeof x==='string'&&x.length>0&&x.length<=1024&&!/[\x00-\x1f\x7f]/u.test(x);
const base64=x=>typeof x==='string'&&x.length>0&&x.length<=65536&&x.length%4===0&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(x);
const fail=(code,message)=>{throw new ReadError(code,message);};
const contextOf=p=>({key:p.key,agentId:p.agentId,sessionId:p.sessionId});
const safeError=error=>{
  const code=String(error?.code??error?.gatewayCode??'');
  if(error instanceof ReadError)return error;
  if(/AUTH|ACCESS|SCOPE|PAIR|FORBIDDEN|DENIED/u.test(code))return new ReadError('ACCESS','OpenClaw did not authorize this voice action.');
  if(/CONFIG/u.test(code))return new ReadError('CONFIG','Voice requires the configured local gateway and an owner-launched desktop app.');
  if(/INVALID|UNSUPPORTED|UNAVAILABLE|NOT_FOUND/u.test(code))return new ReadError('UNAVAILABLE','This voice option is unavailable. Check voice setup in the original OpenClaw interface.');
  return new ReadError('CONNECTION','The voice connection was lost. Audio will not be resent. Start again explicitly.');
};
function validate(action,p) {
  const fields={catalog:['key','agentId','sessionId'],start:['key','agentId','sessionId','mode'],audio:['id','audioBase64'],played:['id','markId'],stop:['id','discard','detach']}[action];
  if(!fields||!object(p)||Object.keys(p).some(k=>!fields.includes(k)))fail('INVALID','Invalid voice action.');
  if(action==='catalog'||action==='start'){
    if(!['key','agentId','sessionId'].every(k=>identifier(p[k]))||!p.key.startsWith(`agent:${p.agentId}:`))fail('INVALID','Select an exact agent conversation for voice.');
    if(action==='start'&&!['dictation','conversation'].includes(p.mode))fail('INVALID','Choose Dictate or Talk.');
  } else if(!identifier(p.id)||action==='audio'&&!base64(p.audioBase64)||action==='played'&&!identifier(p.markId)||
    action==='stop'&&((p.discard!==undefined&&typeof p.discard!=='boolean')||(p.detach!==undefined&&typeof p.detach!=='boolean')))fail('INVALID','Invalid voice input.');
  return {...p};
}
class VoiceChannel {
  constructor(transport,helperPath,onMessage,spawnChild=spawn) {
    this.closed=false;this.pending=new Map();this.counter=0;this.onMessage=onMessage;this.methods=[];this.capabilities=[];
    this.started=new Promise((resolve,reject)=>{this.resolveStart=resolve;this.rejectStart=reject;});
    this.started.catch(()=>{});
    const env={HOME:transport.home,USER:process.env.USER||'',LOGNAME:process.env.LOGNAME||'',PATH:'/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',LANG:'en_US.UTF-8',NO_COLOR:'1',TERM:'dumb',OPENCLAW_CONFIG_PATH:transport.target.configPath};
    for(const key of ['OPENCLAW_SHELL','OPENCLAW_SUBAGENT_EXEC'])if(process.env[key]!==undefined)env[key]=process.env[key];
    this.timer=setTimeout(()=>this.end('TIMEOUT'),18000);
    try{this.child=spawnChild(transport.node,[helperPath,transport.target.url],{env,shell:false,stdio:['pipe','pipe','ignore'],windowsHide:true});}catch{this.end('CONNECTION');return;}
    let text='';this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data',chunk=>{text+=chunk;if(Buffer.byteLength(text)>MAX_OUTPUT){this.end('INVALID');return;}let split;
      while((split=text.indexOf('\n'))>=0){const line=text.slice(0,split);text=text.slice(split+1);let m;try{m=JSON.parse(line);}catch{this.end('INVALID');return;}
        if(m?.kind==='status'){
          if(m.status!=='ready'){this.end(m.code);return;}
          this.methods=Array.isArray(m.methods)?m.methods:[];this.capabilities=Array.isArray(m.capabilities)?m.capabilities:[];clearTimeout(this.timer);this.resolveStart();
        }else if(m?.kind==='reply'){
          const job=this.pending.get(m.id);if(!job)continue;clearTimeout(job.timer);this.pending.delete(m.id);m.ok===true?job.resolve(m.data):job.reject(safeError(m.error));
        }else if(m?.kind==='event')onMessage(m);else{this.end('INVALID');return;}
      }
    });
    this.child.on('error',()=>this.end('CONNECTION'));this.child.on('exit',()=>this.end('CONNECTION'));this.child.stdin.on('error',()=>this.end('CONNECTION'));
  }
  async request(method,params) {
    await this.started;if(this.closed)throw safeError({code:'CONNECTION'});
    const id=++this.counter,r={id,method,params};
    if(!validateRequest(r)||!this.methods.includes(method))fail('UNAVAILABLE','This voice operation is unavailable.');
    const line=JSON.stringify(r)+'\n';
    if(this.pending.size>=24||Buffer.byteLength(line)>MAX_LINE||this.child.stdin.writableLength>256*1024)fail('BUSY','Voice input fell behind. Stop and start again.');
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>this.end('TIMEOUT'),['agent.wait','talk.session.close'].includes(method)?135000:25000);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(line);});
  }
  end(code='CONNECTION') {
    if(this.closed)return;this.closed=true;clearTimeout(this.timer);const error=safeError({code});this.rejectStart(error);
    for(const job of this.pending.values()){clearTimeout(job.timer);job.reject(error);}this.pending.clear();this.child?.kill();this.onMessage({kind:'status',status:'disconnected',code});
  }
  close(){this.end('CLOSED');}
}
const CORE_METHODS=['talk.session.create','talk.session.appendAudio','talk.session.close'];
function projectCatalog(raw,methods) {
  const complete=CORE_METHODS.every(m=>methods.includes(m));
  const t=raw?.transcription,r=raw?.realtime;
  const p=Array.isArray(r?.providers)?r.providers.find(p=>p.id===r.activeProvider):undefined;
  const dictation=complete&&t?.ready===true;
  const conversation=complete&&r?.ready===true&&p?.configured===true&&p.transports?.includes('gateway-relay')&&p.modes?.includes('realtime')&&p.brains?.includes('agent-consult')&&
    ['talk.session.acknowledgeMark','talk.client.toolCall','talk.session.steer','talk.session.submitToolResult','agent.wait'].every(m=>methods.includes(m));
  return {
    dictation:{available:dictation,...identifier(t?.activeProvider)?{provider:t.activeProvider}:{},...dictation?{}:{reason:'Dictation is not ready. Configure transcription in the original OpenClaw interface.'}},
    // This client pauses input during playback; it does not advertise unimplemented barge-in.
    conversation:{available:!!conversation,supportsBargeIn:false,...identifier(r?.activeProvider)?{provider:r.activeProvider}:{},...conversation?{}:{reason:'Live Talk is not ready for a gateway relay. Check Talk setup in the original OpenClaw interface.'}},
  };
}
function fixtureChannel(transport,onMessage) {
  let current;const channel={closed:false,methods:['sessions.describe','talk.catalog',...CORE_METHODS,'talk.session.acknowledgeMark','talk.client.toolCall','talk.session.steer','talk.session.submitToolResult','agent.wait'],capabilities:['talk-session-close-disposition'],started:Promise.resolve(),
    async request(method,p){
      if(channel.closed)throw safeError({code:'CONNECTION'});
      if(method==='sessions.describe')return transport().request(method,p);
      if(method==='talk.catalog')return {transcription:{ready:true,activeProvider:'fixture',providers:[{id:'fixture',configured:true}]},realtime:{ready:true,activeProvider:'fixture',providers:[{id:'fixture',configured:true,transports:['gateway-relay'],modes:['realtime'],brains:['agent-consult']}]}};
      if(method==='talk.session.create'){
        current={sessionId:'fixture-voice',...p.mode==='transcription'?{transcriptionSessionId:'fixture-voice'}:{relaySessionId:'fixture-voice'},mode:p.mode,transport:p.transport,brain:p.brain,audio:p.mode==='transcription'?{inputEncoding:'g711_ulaw',inputSampleRateHz:8000}:{inputEncoding:'pcm16',inputSampleRateHz:24000,outputEncoding:'pcm16',outputSampleRateHz:24000}};
        queueMicrotask(()=>onMessage({kind:'event',event:'talk.event',payload:{[p.mode==='transcription'?'transcriptionSessionId':'relaySessionId']:current.sessionId,type:'ready'}}));return {...current};
      }
      if(method==='talk.session.appendAudio'&&current?.mode==='realtime'&&!current.sent){
        current.sent=true;
        const emit=payload=>onMessage({kind:'event',event:'talk.event',payload:{relaySessionId:current.sessionId,...payload}});
        emit({type:'transcript',role:'assistant',text:'Fixture Talk — no audio reaches a provider.',final:true,talkEvent:{id:'fixture-live-text',sessionId:current.sessionId,seq:1,turnId:'fixture-turn'}});
        emit({type:'audio',audioBase64:Buffer.alloc(4800).toString('base64'),talkEvent:{id:'fixture-live-audio',sessionId:current.sessionId,seq:2,turnId:'fixture-turn'}});
        emit({type:'mark',markName:'fixture-playback-complete'});
      }
      if(method==='talk.session.close'&&current){
        const owner=current.mode==='transcription'?'transcriptionSessionId':'relaySessionId';
        if(current.mode==='transcription'&&!p.discard)onMessage({kind:'event',event:'talk.event',payload:{[owner]:current.sessionId,type:'transcript',text:'Fixture dictation — no microphone data leaves this app.',final:true,talkEvent:{id:'fixture-final',sessionId:current.sessionId,seq:1,turnId:'fixture-turn'}}});
        onMessage({kind:'event',event:'talk.event',payload:{[owner]:current.sessionId,type:'close',reason:'completed'}});
      }
      return {ok:true};
    },close(){if(channel.closed)return;channel.closed=true;onMessage({kind:'status',status:'disconnected'});}};
  return channel;
}
class VoiceService {
  constructor({transport,notify=()=>{},helperPath=path.join(__dirname,'voice-rpc.cjs'),channelFactory,fixture=false,now=Date.now,guardMs=2000}={}) {
    this.transport=transport;this.notify=notify;this.helperPath=helperPath;this.channelFactory=channelFactory;this.fixture=fixture;this.now=now;this.guardMs=guardMs;
    this.channel=null;this.generation=0;this.active=null;this.starting=false;this.closed=false;this.cached=null;this.pendingEvents=[];
  }
  getTransport(){return typeof this.transport==='function'?this.transport():this.transport;}
  async connect(){
    if(this.closed)fail('CONNECTION','Voice is closed.');
    if(!this.channel||this.channel.closed){const generation=++this.generation;const receive=m=>{if(generation===this.generation)this.receive(m);};
      this.channel=this.channelFactory?this.channelFactory(receive):this.fixture?fixtureChannel(()=>this.getTransport(),receive):new VoiceChannel(this.getTransport(),this.helperPath,receive);this.cached=null;
    }
    await this.channel.started;return this.channel;
  }
  async describe(context,channel=this.channel){
    const row=(await channel.request('sessions.describe',{key:context.key,agentId:context.agentId}))?.session;
    if(!row||row.key!==context.key||row.agentId!==context.agentId||row.sessionId!==context.sessionId||
      Object.hasOwn(row,'lifecycleRevision')&&!identifier(row.lifecycleRevision))fail('SESSION_CHANGED','This conversation changed. Select it again before using voice.');
    return row;
  }
  same(before,after){if(before.lifecycleRevision!==after.lifecycleRevision)fail('SESSION_CHANGED','This conversation changed while voice was connecting.');}
  async catalog(p,force=false){
    const channel=await this.connect(),before=await this.describe(p,channel),key=JSON.stringify([p.key,p.agentId,p.sessionId,before.lifecycleRevision]);
    if(!force&&this.cached?.key===key&&this.cached.until>this.now())return {...this.cached.value};
    const raw=await channel.request('talk.catalog',{sessionKey:p.key});this.same(before,await this.describe(p,channel));
    if(channel!==this.channel||channel.closed)throw safeError({code:'CONNECTION'});
    const value={context:contextOf(p),...projectCatalog(raw,channel.methods??[])};this.cached={key,until:this.now()+30000,value};return value;
  }
  async handle(action,input={}){
    const p=validate(action,input);
    try{
      if(action==='catalog')return await this.catalog(p);
      if(action==='start')return await this.start(p);
      const record=this.active;
      if(!record||record.id!==p.id)fail('SESSION_CHANGED','This voice session has ended.');
      if(action==='stop')return await this.stop(record,p);
      if(record.stopping||record.ended)fail('BUSY','Voice is stopping.');
      if(action==='played')return await this.played(record,p.markId);
      return await this.audio(record,p.audioBase64);
    }catch(error){throw safeError(error);}
  }
  emit(record,type,fields={}){this.notify({id:record.id,context:record.context,mode:record.mode,type,...fields});}
  async start(p){
    if(this.starting||this.active)fail('BUSY','Stop the current voice session first.');this.starting=true;this.pendingEvents=[];
    let record;
    try{
      const options=await this.catalog(p,true);if(!options[p.mode].available)fail('UNAVAILABLE',options[p.mode].reason);
      const channel=this.channel,before=await this.describe(p,channel);
      record={id:randomUUID(),context:contextOf(p),mode:p.mode,channel,lifecycle:before.lifecycleRevision,ready:false,adopted:false,ended:false,stopping:false,
        tail:Promise.resolve(),queued:0,bytes:0,marks:new Map(),calls:new Map(),runs:new Map(),earlyChat:new Map(),transcripts:new Set(),lastSeq:0,verifiedAt:this.now()};
      this.active=record;
      const result=await channel.request('talk.session.create',{sessionKey:p.key,mode:p.mode==='dictation'?'transcription':'realtime',transport:'gateway-relay',brain:p.mode==='dictation'?'none':'agent-consult'});
      if(!identifier(result?.sessionId))fail('UNAVAILABLE','OpenClaw returned an invalid voice session.');
      record.nativeId=result.sessionId;
      if(result.transport!=='gateway-relay'||result.mode!==(p.mode==='dictation'?'transcription':'realtime')||result.brain!==(p.mode==='dictation'?'none':'agent-consult')||
        (p.mode==='dictation'&&result.transcriptionSessionId!==undefined&&result.transcriptionSessionId!==record.nativeId)||
        (p.mode==='conversation'&&result.relaySessionId!==record.nativeId))fail('UNAVAILABLE','OpenClaw returned an unsupported voice route.');
      const a=result.audio;
      if(!object(a)||(p.mode==='dictation'?(a.inputEncoding!=='g711_ulaw'||a.inputSampleRateHz!==8000):
        (a.inputEncoding!=='pcm16'||a.outputEncoding!=='pcm16'||a.inputSampleRateHz!==24000||a.outputSampleRateHz!==24000)))fail('UNAVAILABLE','OpenClaw returned an unsupported audio format.');
      record.audio={inputEncoding:a.inputEncoding,inputSampleRateHz:a.inputSampleRateHz,...p.mode==='conversation'?{outputEncoding:a.outputEncoding,outputSampleRateHz:a.outputSampleRateHz}:{}};
      this.same(before,await this.describe(p,channel));
      if(channel.closed||record.ended||this.active!==record)throw safeError({code:'CONNECTION'});
      record.adopted=true;
      const early=this.pendingEvents;this.pendingEvents=[];for(const message of early)this.event(record,message);
      if(record.ended)throw safeError({code:'CONNECTION'});
      record.timer=setInterval(()=>this.guard(record).catch(error=>this.failRecord(record,error)),this.guardMs);record.timer.unref?.();
      const resultView={id:record.id,context:record.context,mode:record.mode,status:record.ready?'ready':'connecting',audio:record.audio,supportsBargeIn:false};
      this.emit(record,'state',{status:resultView.status});return resultView;
    }catch(error){if(record){if(!record.nativeId)record.channel.close();else await this.cleanupRemote(record,true).catch(()=>record.channel.close());this.finish(record,safeError(error));}throw error;}
    finally{this.starting=false;this.pendingEvents=[];}
  }
  async guard(record){
    if(record.ended||this.active!==record)fail('SESSION_CHANGED','This voice session ended.');
    if(record.guard)return record.guard;
    record.guard=(async()=>{const row=await this.describe(record.context,record.channel);if(row.lifecycleRevision!==record.lifecycle)fail('SESSION_CHANGED','This conversation changed. Voice has stopped.');record.verifiedAt=this.now();})();
    try{return await record.guard;}finally{record.guard=null;}
  }
  async audio(record,data){
    const bytes=Buffer.from(data,'base64').length;
    if(record.queued>=8||record.bytes+bytes>144000){this.failRecord(record,new ReadError('BUSY','Voice input fell behind. Stop and start again; audio will not be replayed.'));fail('BUSY','Voice input fell behind.');}
    if(record.audio.inputEncoding==='pcm16'&&bytes%2)fail('INVALID','PCM audio frames must contain whole samples.');
    record.queued++;record.bytes+=bytes;
    const job=record.tail.then(async()=>{
      if(record.ended||record.discard||this.active!==record)fail('SESSION_CHANGED','This voice session ended.');
      if(this.now()-record.verifiedAt>=this.guardMs)await this.guard(record);
      const result=await record.channel.request('talk.session.appendAudio',{sessionId:record.nativeId,audioBase64:data});
      if(result?.ok!==true)throw safeError({code:'CONNECTION'});return {ok:true};
    });
    record.tail=job.catch(()=>{});
    try{return await job;}catch(error){this.failRecord(record,error);throw error;}finally{record.queued--;record.bytes-=bytes;}
  }
  async played(record,markId){
    const mark=record.marks.get(markId);if(!mark)fail('INVALID','That playback mark is no longer current.');record.marks.delete(markId);
    try{await record.channel.request('talk.session.acknowledgeMark',{sessionId:record.nativeId,markName:mark});return {ok:true};}catch(e){this.failRecord(record,e);throw e;}
  }
  async stop(record,p){
    if(record.stopPromise){if(p.discard&&!record.discard){record.discard=true;await this.cleanupRemote(record,true);}return record.stopPromise;}
    record.stopping=true;record.discard=p.discard===true;clearInterval(record.timer);this.emit(record,'state',{status:'stopping'});
    record.stopPromise=(async()=>{
      try{
        if(!record.discard)await record.tail;
        if(!record.ended){await this.guard(record);await this.cleanupRemote(record,record.discard||p.detach===true,p.detach===true);}
        this.finish(record);return {id:record.id,status:'closed'};
      }catch(error){await this.cleanupRemote(record,true,true);this.finish(record,safeError(error));throw error;}
    })();return record.stopPromise;
  }
  async cleanupRemote(record,cancel=false,detach=false){
    if(!record.nativeId||record.channel.closed)return;
    if(record.mode==='dictation'){await record.channel.request('talk.session.close',{sessionId:record.nativeId,...cancel?{discard:true}:{}}).catch(error=>{if(!record.ended)throw error;});return;}
    if(cancel||detach){
      if(!record.channel.capabilities?.includes('talk-session-close-disposition')){record.channel.close();return;}
      await record.channel.request('talk.session.close',{sessionId:record.nativeId,disposition:'detach'}).catch(()=>record.channel.close());return;
    }
    await record.channel.request('talk.session.close',{sessionId:record.nativeId});
  }
  failRecord(record,error){
    if(record.ended||record.failing)return;record.failing=true;record.discard=true;record.stopping=true;clearInterval(record.timer);
    this.emit(record,'error',{code:safeError(error).code,message:safeError(error).message});
    this.cleanupRemote(record,true,true).catch(()=>record.channel.close()).finally(()=>this.finish(record));
  }
  finish(record,error){
    if(record.ended)return;record.ended=true;clearInterval(record.timer);record.marks.clear();
    for(const wait of record.runs.values()){clearTimeout(wait.timer);wait.reject(new ReadError('CONNECTION','Voice ended.'));}record.runs.clear();
    if(error)this.emit(record,'error',{code:error.code,message:error.message});this.emit(record,'clear');this.emit(record,'closed');if(this.active===record)this.active=null;
  }
  receive(message){
    const r=this.active;if(!r)return;
    if(message.kind==='status'){this.finish(r,safeError({code:message.code}));return;}
    if(message.kind!=='event')return;
    if(!r.adopted){if(this.pendingEvents.length>=32||this.pendingEvents.reduce((n,e)=>n+JSON.stringify(e).length,0)+JSON.stringify(message).length>262144){this.failRecord(r,new ReadError('UNAVAILABLE','Voice sent too much data before connection completed.'));return;}this.pendingEvents.push(message);return;}
    this.event(r,message);
  }
  event(r,message){
    if(r.ended||this.active!==r)return;
    const p=message.payload;if(!object(p))return;
    if(message.event==='chat'){
      if(!identifier(p.runId)||!['final','aborted','error'].includes(p.state))return;
      if(p.sessionKey!==undefined&&p.sessionKey!==r.context.key||p.agentId!==undefined&&p.agentId!==r.context.agentId)return;
      const wait=r.runs.get(p.runId);if(wait){this.completeRun(r,p,wait);return;}
      if(r.earlyChat.size<16)r.earlyChat.set(p.runId,p);return;
    }
    if(message.event!=='talk.event'||p[r.mode==='dictation'?'transcriptionSessionId':'relaySessionId']!==r.nativeId)return;
    const e=p.talkEvent;
    if(e&&(!object(e)||e.sessionId!==r.nativeId||!Number.isSafeInteger(e.seq)||e.seq<1))return;
    if(e){if(e.seq<=r.lastSeq)return;r.lastSeq=e.seq;}
    switch(p.type){
      case 'ready':r.ready=true;if(!r.stopping)this.emit(r,'state',{status:'ready'});break;
      case 'partial':case 'transcript':{
        if(r.discard||typeof p.text!=='string'||p.text.length>32768||!p.text.trim())return;
        const final=p.type==='transcript'&&p.final===true;
        const transcriptId=identifier(p.transcriptId)?p.transcriptId:identifier(e?.id)?e.id:randomUUID();
        if(final&&r.transcripts.has(transcriptId))return;
        if(final){if(r.transcripts.size>=512){this.failRecord(r,new ReadError('UNAVAILABLE','This voice session reached its transcript limit. Start another call.'));return;}r.transcripts.add(transcriptId);}
        this.emit(r,'transcript',{text:p.text,final,transcriptId,...['assistant','user'].includes(p.role)?{role:p.role}:{},...['delta','replace'].includes(p.textMode)?{textMode:p.textMode}:{}});break;
      }
      case 'audio':if(r.mode==='conversation'){
        if(!base64(p.audioBase64)||Buffer.from(p.audioBase64,'base64').length%2!==0||!identifier(e?.turnId)){this.failRecord(r,new ReadError('UNAVAILABLE','OpenClaw returned an unsupported audio frame.'));return;}
        this.emit(r,'audio',{audioBase64:p.audioBase64,turnId:e.turnId});
      }break;
      case 'clear':this.emit(r,'clear',{...identifier(e?.turnId)?{turnId:e.turnId}:{}});break;
      case 'mark':{
        if(!identifier(p.markName))return;if(r.marks.size>=32){this.failRecord(r,new ReadError('BUSY','Voice playback fell behind. Start another call.'));return;}
        const markId=randomUUID();r.marks.set(markId,p.markName);this.emit(r,'mark',{markId});break;
      }
      case 'toolCall':if(r.mode==='conversation')void this.tool(r,p);break;
      case 'toolCallCancelled':{const c=r.calls.get(p.callId);if(c)c.cancelled=true;break;}
      case 'toolResult':{const c=r.calls.get(p.callId);if(c&&e?.type!=='tool.progress'&&e?.final!==false)c.completed=true;break;}
      case 'error':this.failRecord(r,new ReadError('UNAVAILABLE','OpenClaw could not complete this voice session. Check Talk setup and try again.'));break;
      case 'close':this.finish(r,p.reason==='error'?new ReadError('UNAVAILABLE','OpenClaw ended the voice session after an error.'):undefined);break;
      default:break;
    }
  }
  async tool(r,p){
    if(!identifier(p.callId)||r.calls.has(p.callId)||r.stopping||r.ended)return;
    if(r.calls.size>=64){this.failRecord(r,new ReadError('UNAVAILABLE','This call reached its tool limit. Start another call.'));return;}
    const call={cancelled:false,completed:false};r.calls.set(p.callId,call);
    const current=()=>this.active===r&&!r.ended&&!r.stopping&&!call.cancelled&&!call.completed;
    const submit=async(result,continuing=false)=>{if(!current())return;await this.guard(r);if(current())await r.channel.request('talk.session.submitToolResult',{sessionId:r.nativeId,callId:p.callId,result,...continuing?{options:{willContinue:true}}:{}});};
    try{
      await this.guard(r);if(!current())return;
      let args=p.args;if(typeof args==='string'){if(args.length>16384)fail('INVALID','Voice tool input is too large.');try{args=JSON.parse(args);}catch{fail('INVALID','Voice tool input is invalid.');}}
      if(!object(args)||JSON.stringify(args).length>16384)fail('INVALID','Voice tool input is invalid.');
      if(p.name==='openclaw_agent_control'){
        const text=['text','message','request','query'].map(k=>args[k]).find(x=>typeof x==='string'&&x.trim());
        if(!text||text.length>8192||args.mode!==undefined&&!['status','steer','cancel','followup'].includes(args.mode))fail('INVALID','Voice control is invalid.');
        const result=await r.channel.request('talk.session.steer',{sessionId:r.nativeId,sessionKey:r.context.key,text,...args.mode?{mode:args.mode}:{}});await submit(result);
      }else if(p.name==='openclaw_agent_consult'){
        if(p.forced===true){await submit({status:'working',tool:'openclaw_agent_consult',message:'OpenClaw is working. Wait for its final result.'},true);return;}
        const receipt=await r.channel.request('talk.client.toolCall',{sessionKey:r.context.key,relaySessionId:r.nativeId,callId:p.callId,name:p.name,args});
        if(!identifier(receipt?.runId)||receipt.agentId!==r.context.agentId||receipt.agentSessionKey!==r.context.key)fail('SESSION_CHANGED','Voice delegation returned a different conversation.');
        if(!current())return;const text=await this.waitRun(r,receipt.runId);await submit({result:text});
      }else await submit({error:'This tool is unavailable in OpenClaw+ voice.'});
    }catch(error){if(error?.code==='SESSION_CHANGED'){this.failRecord(r,error);return;}if(current()){try{await submit({error:'OpenClaw could not complete this voice request.'});}catch{this.failRecord(r,error);}}}
  }
  waitRun(r,runId){
    return new Promise((resolve,reject)=>{
      const wait={resolve,reject,fallback:false,timer:setTimeout(()=>{r.runs.delete(runId);reject(new ReadError('TIMEOUT','The voice request did not finish in time.'));},120000)};wait.timer.unref?.();
      r.runs.set(runId,wait);const early=r.earlyChat.get(runId);r.earlyChat.delete(runId);if(early)this.completeRun(r,early,wait);
    });
  }
  completeRun(r,p,wait){
    if(p.sessionKey!==undefined&&p.sessionKey!==r.context.key||p.agentId!==undefined&&p.agentId!==r.context.agentId)return;
    const finish=(error,text)=>{if(r.runs.get(p.runId)!==wait)return;r.runs.delete(p.runId);clearTimeout(wait.timer);error?wait.reject(error):wait.resolve(text);};
    if(p.state!=='final'){finish(new ReadError('UNAVAILABLE','The voice request stopped without a result.'));return;}
    const text=typeof p.message?.text==='string'?p.message.text:Array.isArray(p.message?.content)?p.message.content.filter(x=>x?.type==='text'&&typeof x.text==='string').map(x=>x.text).join('\n\n'):'';
    if(text.trim()){finish(null,text.slice(0,32768));return;}
    if(wait.fallback)return;wait.fallback=true;
    r.channel.request('agent.wait',{runId:p.runId,timeoutMs:120000}).then(result=>{
      if(result?.status==='error'||result?.status==='timeout'||result?.aborted===true)finish(new ReadError('UNAVAILABLE','The voice request did not finish successfully.'));
      else finish(null,'OpenClaw finished with no text.');
    },error=>finish(safeError(error)));
  }
  async close(){
    if(this.closed)return;this.closed=true;
    const r=this.active;if(r){r.stopping=true;r.discard=true;clearInterval(r.timer);await this.cleanupRemote(r,true,true).catch(()=>{});this.finish(r);}
    this.generation++;this.channel?.close();this.channel=null;this.cached=null;
  }
}
module.exports={VoiceService,VoiceChannel,validate,projectCatalog};
