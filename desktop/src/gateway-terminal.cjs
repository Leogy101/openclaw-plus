'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ReadError } = require('./gateway-cli.cjs');
const MAX_FRAME = 4 * 1024 * 1024;
const MAX_BUFFER = 2 * 1024 * 1024;
const ACTIONS = new Set(['list','open','attach','input','resize','detach']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\x00-\x1f\x7f]/u.test(value);
const dimension = value => Number.isInteger(value) && value >= 1 && value <= 2000;
const contextOf = value => ({key:value.key,agentId:value.agentId,sessionId:value.sessionId});
const contextKey = value => JSON.stringify([value.key,value.agentId,value.sessionId]);
const fail = (code,message) => { throw new ReadError(code,message); };
function validate(action,input) {
  if (!ACTIONS.has(action) || !object(input)) fail('INVALID','Invalid terminal action.');
  const extras = {list:[],open:['cols','rows'],attach:['terminalId'],input:['terminalId','data'],resize:['terminalId','cols','rows'],detach:['terminalId']}[action];
  const fields = ['key','agentId','sessionId',...extras];
  if (Object.keys(input).some(key => !fields.includes(key)) || ['key','agentId','sessionId'].some(key => !identifier(input[key])) ||
      extras.includes('terminalId') && !identifier(input.terminalId) ||
      extras.includes('cols') && (!dimension(input.cols) || !dimension(input.rows)) ||
      action === 'input' && (typeof input.data !== 'string' || Buffer.byteLength(input.data) > 16384)) fail('INVALID','Select an exact session and valid terminal input.');
  return {...input};
}
function safeError(code,write=false) {
  if (/AUTH|PAIR|SCOPE|FORBIDDEN|ACCESS|DENIED/u.test(code || '')) return new ReadError('ACCESS','OpenClaw did not authorize this terminal action.');
  if (/CONFIG/u.test(code || '')) return new ReadError('CONFIG','The terminal requires the configured local gateway and an owner-launched desktop application.');
  if (/INVALID|UNSUPPORTED|NOT_FOUND/u.test(code || '')) return new ReadError('UNAVAILABLE','This terminal is unavailable or no longer attached.');
  return new ReadError(write ? 'UNCERTAIN' : 'CONNECTION',write ? 'The terminal did not confirm this input. It will not be resent. Reconnect and inspect the output.' : 'The terminal connection is unavailable. Reconnect explicitly to inspect the existing shell.');
}

class HelperChannel {
  constructor(transport,helperPath,onMessage,spawnChild=spawn) {
    this.pending = new Map(); this.counter = 0; this.closed = false; this.ready = false; this.onMessage = onMessage;
    const env = {HOME:transport.home,USER:process.env.USER || '',LOGNAME:process.env.LOGNAME || '',
      PATH:'/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',LANG:'en_US.UTF-8',NO_COLOR:'1',TERM:'dumb',
      OPENCLAW_CONFIG_PATH:transport.target.configPath};
    for (const name of ['OPENCLAW_SHELL','OPENCLAW_SUBAGENT_EXEC']) if (process.env[name] !== undefined) env[name]=process.env[name];
    this.started = new Promise((resolve,reject) => {this.resolveStart=resolve;this.rejectStart=reject;});
    this.timer = setTimeout(() => this.end('TIMEOUT'),18000);
    try { this.child = spawnChild(transport.node,[helperPath,transport.target.url],{env,shell:false,stdio:['pipe','pipe','ignore'],windowsHide:true}); }
    catch { this.end('CONNECTION'); return; }
    let text = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data',chunk => {
      text += chunk;
      if (Buffer.byteLength(text) > MAX_FRAME) {this.end('INVALID');return;}
      let split;
      while ((split=text.indexOf('\n')) >= 0) {
        const line=text.slice(0,split);text=text.slice(split+1);
        let message;try {message=JSON.parse(line);} catch {this.end('INVALID');return;}
        if (message?.kind === 'status') {
          if (message.status === 'ready') {this.ready=true;clearTimeout(this.timer);this.resolveStart();}
          else {this.end(message.code);return;}
        } else if (message?.kind === 'reply') {
          const job=this.pending.get(message.id); if (!job) continue;
          clearTimeout(job.timer);this.pending.delete(message.id);
          if (message.ok === true) job.resolve(message.data);else job.reject(safeError(message.error?.code,job.write));
        } else if (message?.kind === 'event' || message?.kind === 'gap') onMessage(message);
        else {this.end('INVALID');return;}
      }
    });
    this.child.on('error',() => this.end('CONNECTION'));this.child.on('exit',() => this.end('CONNECTION'));
    this.child.stdin.on('error',() => this.end('CONNECTION'));
  }
  async request(method,params) {
    await this.started;
    if (this.closed || !this.ready) throw safeError('CONNECTION');
    if (this.pending.size >= 32) fail('BUSY','The terminal is processing input.');
    const requestId=++this.counter,write=method==='terminal.input';
    const line=JSON.stringify({id:requestId,method,params})+'\n';
    if (Buffer.byteLength(line)>128*1024 || this.child.stdin.writableLength>128*1024) fail('BUSY','The terminal input queue is full.');
    return new Promise((resolve,reject) => {
      const timer=setTimeout(() => this.end('TIMEOUT'),method==='terminal.open'?40000:18000);
      this.pending.set(requestId,{resolve,reject,timer,write});this.child.stdin.write(line);
    });
  }
  end(code='CONNECTION') {
    if (this.closed) return;this.closed=true;this.ready=false;clearTimeout(this.timer);
    this.rejectStart(safeError(code));
    for (const job of this.pending.values()) {clearTimeout(job.timer);job.reject(safeError(code,job.write));}
    this.pending.clear();this.child?.kill();this.onMessage({kind:'status',status:'disconnected',code});
  }
  close() {this.end('CLOSED');}
}

// Explicit development fixture: no PTY, command execution, credentials, or production call.
function fixtureChannel(transport,onMessage,state) {
  return {closed:false,async request(method,params) {
    if (this.closed) throw safeError('CONNECTION');
    if (method==='sessions.describe') return transport().request(method,params);
    if (method==='terminal.list') return {sessions:[...state.sessions.values()].map(row=>({...row,buffer:undefined,seq:undefined}))};
    if (method==='terminal.open') {
      const sessionId=`fixture-terminal-${++state.counter}`;
      const buffer='Fixture terminal — no commands execute.\r\n$ ';
      const row={sessionId,agentId:params.agentId,owner:`agent:${params.sessionKey}`,shell:'Fixture terminal',cwd:'/fixture/workspace',confined:false,attached:true,createdAtMs:Date.now(),buffer,seq:buffer.length};
      state.sessions.set(sessionId,row);return {...row};
    }
    const row=state.sessions.get(params.sessionId);if (!row) return {ok:false};
    if (method==='terminal.attach') {row.attached=true;return {...row};}
    if (method==='terminal.close') {row.attached=false;return {ok:true};}
    if (method==='terminal.input') {
      row.buffer=(row.buffer+params.data).slice(-65536);row.seq+=params.data.length;
      onMessage({kind:'event',event:'terminal.data',payload:{sessionId:row.sessionId,seq:row.seq,data:params.data}});
    }
    return {ok:true};
  },close(){if(this.closed)return;this.closed=true;onMessage({kind:'status',status:'disconnected'});}};
}

class TerminalService {
  constructor({transport,notify=()=>{},fixture=false,helperPath=path.join(__dirname,'terminal-rpc.cjs'),channelFactory,spawnChild}={}) {
    this.transport=typeof transport==='function'?transport:()=>transport;this.notify=notify;this.fixture=fixture;
    this.helperPath=helperPath;this.channelFactory=channelFactory;this.spawnChild=spawnChild;
    this.records=new Map();this.channel=null;this.channelGeneration=0;this.closed=false;this.tail=Promise.resolve();this.queued=0;
    this.fixtureState={counter:0,sessions:new Map()};
  }
  snapshot(record,message) {
    return {terminalId:record.terminalId,context:{...record.context},status:record.status,cwd:record.cwd,shell:record.shell,
      confined:false,...message?{message}:record.message?{message:record.message}:{}};
  }
  status(record,status,message) {
    record.status=status;record.message=message;this.notify({kind:'status',context:{...record.context},snapshot:this.snapshot(record)});
  }
  connect() {
    if (this.closed) fail('CLOSED','The terminal workspace is closed.');
    if (this.channel && !this.channel.closed) return this.channel;
    const generation=++this.channelGeneration;
    const onMessage=message=>{if(generation===this.channelGeneration)this.receive(message);};
    this.channel=this.channelFactory?this.channelFactory(onMessage):this.fixture?
      fixtureChannel(this.transport,onMessage,this.fixtureState):new HelperChannel(this.transport(),this.helperPath,onMessage,this.spawnChild);
    return this.channel;
  }
  enqueue(work) {
    if (this.closed) return Promise.reject(new ReadError('CLOSED','The terminal workspace is closed.'));
    if (this.queued>=32) return Promise.reject(new ReadError('BUSY','The terminal is processing input.'));
    this.queued++;const pending=this.tail.then(work);this.tail=pending.catch(()=>{}).finally(()=>{this.queued--;});return pending;
  }
  handle(action,params) {
    let input;try {input=validate(action,params);} catch(error){return Promise.reject(error);}
    return this.enqueue(()=>this.perform(action,input));
  }
  async describe(channel,context,revision) {
    const result=await channel.request('sessions.describe',{key:context.key,agentId:context.agentId});
    const row=result?.session;
    if (!object(row) || row.sessionId!==context.sessionId || row.agentId!==context.agentId ||
        row.key!==undefined && row.key!==context.key || !identifier(row.lifecycleRevision) ||
        revision!==undefined && row.lifecycleRevision!==revision) fail('SESSION_CHANGED','The owning conversation changed. Select its current session before opening a terminal.');
    return row.lifecycleRevision;
  }
  known(input) {
    const record=this.records.get(input.terminalId);
    if (!record || contextKey(record.context)!==contextKey(input)) fail('DENIED','This terminal was not opened for this exact conversation.');
    return record;
  }
  metadata(raw,context,ownerRequired=false) {
    if (!object(raw) || !identifier(raw.sessionId) || raw.agentId!==context.agentId ||
        typeof raw.cwd!=='string' || raw.cwd.length>8192 || typeof raw.shell!=='string' || raw.shell.length>4096 ||
        raw.confined!==false || ownerRequired && raw.owner!==`agent:${context.key}`) fail('UNAVAILABLE','OpenClaw did not confirm this terminal owner.');
  }
  async perform(action,input) {
    if (this.closed) fail('CLOSED','The terminal workspace is closed.');
    const context=contextOf(input);
    if (action==='list') {
      const channel=this.connect();const revision=await this.describe(channel,context);
      const result=await channel.request('terminal.list',{});await this.describe(channel,context,revision);
      if (!Array.isArray(result?.sessions)) fail('UNAVAILABLE','OpenClaw did not return the terminal list.');
      const rows=result.sessions;
      // The native list is global. Retire missing known shells even when their old
      // physical conversation can no longer be selected. Unknown shells stay hidden.
      // Actions are serialized, so an app-owned open cannot be pending in this list.
      for (const record of this.records.values()) {
        const native=rows.find(row=>row.sessionId===record.terminalId);
        if (!native) {
          if (!['exited','stale'].includes(record.status))this.status(record,'exited','This terminal is no longer available.');
        } else if (native.owner!==`agent:${record.context.key}` || native.agentId!==record.context.agentId) this.status(record,'stale','The terminal owner could not be verified.');
        else if (contextKey(record.context)===contextKey(context) && record.revision!==revision) this.status(record,'stale','This shell belongs to an earlier conversation lifecycle.');
      }
      return {terminals:[...this.records.values()].filter(record=>contextKey(record.context)===contextKey(context)).map(record=>this.snapshot(record)),
        limitations:['This pane tracks terminals started during this app session. Other terminals remain available in original OpenClaw.']};
    }
    if (action==='open') {
      const previous=[...this.records.values()].find(record=>contextKey(record.context)===contextKey(context));
      if (previous && !['exited','stale'].includes(previous.status)) fail('BUSY','This conversation already has a terminal. Reconnect to that shell.');
      if (previous) this.records.delete(previous.terminalId);
      for(const [terminalId,record] of this.records)if(['exited','stale'].includes(record.status))this.records.delete(terminalId);
      if (this.records.size>=4) fail('BUSY','This app already tracks four terminal sessions. Existing shared shells remain available in OpenClaw.');
      const channel=this.connect();const revision=await this.describe(channel,context);
      const raw=await channel.request('terminal.open',{agentId:context.agentId,sessionKey:context.key,cols:input.cols,rows:input.rows});
      try {this.metadata(raw,context);await this.describe(channel,context,revision);}
      catch(error) {if(identifier(raw?.sessionId)) await channel.request('terminal.close',{sessionId:raw.sessionId}).catch(()=>{});throw error;}
      const record={terminalId:raw.sessionId,context,revision,cwd:raw.cwd,shell:raw.shell,status:'connecting',seq:0,replaying:false,events:[]};
      this.records.set(record.terminalId,record);
      return this.attach(channel,record);
    }
    const record=this.known(input);
    if (['stale','exited'].includes(record.status)) fail('SESSION_CHANGED','This terminal is no longer current.');
    if (action==='attach') return this.attach(this.connect(),record);
    if (action==='detach' && (!this.channel || this.channel.closed || record.status==='detached')) {
      this.status(record,'detached','The shared shell remains in OpenClaw.');return this.snapshot(record);
    }
    if (!this.channel || this.channel.closed || record.status!=='ready') fail('CONNECTION','Reconnect this terminal before sending input.');
    const channel=this.channel;
    try {
      await this.describe(channel,context,record.revision);
      const method={input:'terminal.input',resize:'terminal.resize',detach:'terminal.close'}[action];
      const params={sessionId:record.terminalId,...action==='input'?{data:input.data}:action==='resize'?{cols:input.cols,rows:input.rows}:{}};
      const result=await channel.request(method,params);
      if(result?.ok!==true) fail('UNAVAILABLE','This terminal is no longer attached. Reconnect before continuing.');
      if(action==='detach')this.status(record,'detached','The shared shell remains in OpenClaw.');
      return this.snapshot(record);
    } catch(error) {
      if(!['exited','detached','stale'].includes(record.status))this.status(record,error.code==='SESSION_CHANGED'?'stale':'disconnected',error.message);throw error;
    }
  }
  async attach(channel,record) {
    record.replaying=true;record.events=[];this.status(record,'connecting');
    try {
      await this.describe(channel,record.context,record.revision);
      const raw=await channel.request('terminal.attach',{sessionId:record.terminalId});
      this.metadata(raw,record.context,true);
      if(raw.sessionId!==record.terminalId || typeof raw.buffer!=='string' || raw.buffer.length>MAX_BUFFER ||
          !Number.isSafeInteger(raw.seq) || raw.seq<raw.buffer.length) fail('UNAVAILABLE','The terminal replay is unavailable.');
      await this.describe(channel,record.context,record.revision);
      if(['exited','detached','stale'].includes(record.status) || channel.closed || this.closed) fail('CONNECTION','The terminal disconnected during replay.');
      record.cwd=raw.cwd;record.shell=raw.shell;record.seq=raw.seq;
      this.notify({kind:'data',context:{...record.context},terminalId:record.terminalId,data:raw.buffer,reset:true});
      const events=record.events;record.events=[];record.replaying=false;this.status(record,'ready');
      for (const data of events)this.output(record,data);
      return this.snapshot(record);
    } catch(error) {
      record.replaying=false;record.events=[];
      if(!['exited','detached','stale'].includes(record.status))this.status(record,error.code==='SESSION_CHANGED'?'stale':'disconnected',error.message);
      // Detach only; never kill or replace an established shared shell after a stale read.
      if(!channel.closed)await channel.request('terminal.close',{sessionId:record.terminalId}).catch(()=>{});
      throw error;
    }
  }
  output(record,payload) {
    if (record.status!=='ready')return;
    if(!Number.isSafeInteger(payload.seq) || typeof payload.data!=='string' || payload.data.length>131072 || payload.seq<payload.data.length) {
      this.status(record,'disconnected','The terminal stream was invalid. Reconnect to replay current output.');return;
    }
    if(payload.seq<=record.seq)return;
    const start=payload.seq-payload.data.length;
    if(start>record.seq){this.recover(record);return;}
    const data=payload.data.slice(Math.max(0,record.seq-start));record.seq=payload.seq;
    if(data)this.notify({kind:'data',context:{...record.context},terminalId:record.terminalId,data});
  }
  recover(record) {
    if(record.recovering || record.status!=='ready')return;
    record.recovering=true;this.status(record,'connecting','Recovering a gap in terminal output.');
    this.enqueue(async()=>{
      try {
        if(this.closed || record.status!=='connecting')return;
        if(!this.channel || this.channel.closed)throw safeError('CONNECTION');
        await this.attach(this.channel,record);
      } finally {record.recovering=false;}
    }).catch(()=>{
      // Admission can fail before the queued callback/finally runs.
      record.recovering=false;
      if(!this.closed && record.status==='connecting')this.status(record,'disconnected','Output recovery could not complete. Reconnect to replay the terminal; input was not retried.');
    });
  }
  receive(message) {
    if(this.closed)return;
    if(message.kind==='status' && message.status==='disconnected') {
      for(const record of this.records.values())if(!['exited','stale','detached'].includes(record.status))this.status(record,'disconnected','The terminal connection closed. Reconnect explicitly; input will not be replayed.');
      return;
    }
    if(message.kind==='gap'){for(const record of this.records.values())this.recover(record);return;}
    const payload=message.payload,record=this.records.get(payload?.sessionId);if(!record)return;
    if(message.event==='terminal.exit') {
      const detached=payload.reason==='detached';
      this.status(record,detached?'detached':'exited',detached?'The terminal viewer was detached.':`The terminal ended${Number.isInteger(payload.exitCode)?` (exit ${payload.exitCode})`:''}.`);return;
    }
    if(message.event!=='terminal.data')return;
    if(record.replaying) {
      if(record.events.length>=128 || record.events.reduce((size,event)=>size+(event.data?.length||0),0)+(payload.data?.length||0)>MAX_BUFFER) {
        record.events=[];this.channel?.close();return;
      }
      record.events.push(payload);
    } else this.output(record,payload);
  }
  close() {
    if(this.closed)return;this.closed=true;this.channelGeneration++;this.channel?.close();this.records.clear();
  }
}
module.exports={TerminalService,HelperChannel,validate};
