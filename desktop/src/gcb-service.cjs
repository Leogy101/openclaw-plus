'use strict';
// GCB owns research, benchmark cases, scoring, durable execution and routing.
// This adapter only owns desktop selection, reviewed consent and CLI lifecycle.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { ReadError } = require('./gateway-cli.cjs');

const PROFILE_OPERATIONS = Object.freeze(['modelsProfileOverview','modelsProfileResearch','modelsProfilePlan',
  'modelsProfileStart','modelsProfilePause','modelsProfileCancel','modelsProfilePreview','modelsProfileLocal','modelsProfileEvidence']);
const SNAPSHOT_FIELDS = ['snapshot_version','checked_at','agent_id','model_ref','openclaw_version','codex_version',
  'context_window','reasoning_settings','selected_reasoning'];
const REASONING = new Set(['off','minimal','low','medium','high','xhigh','adaptive','max','ultra']);
const copy = value => JSON.parse(JSON.stringify(value));
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid = message => { throw new ReadError('INVALID',message || 'This profiling request is invalid.'); };
const boundedId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/+@-]{0,255}$/.test(value);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
function fields(value, required, optional=[]) {
  if (!plain(value) || required.some(key=>!Object.hasOwn(value,key)) || Object.keys(value).some(key=>![...required,...optional].includes(key))) invalid();
}
function snapshotRecord(value) {
  fields(value,SNAPSHOT_FIELDS);
  if (value.snapshot_version!==1 || !/^\d{4}-\d\d-\d\dT/.test(value.checked_at) || !Number.isFinite(Date.parse(value.checked_at)) ||
    !['agent_id','model_ref','openclaw_version','codex_version','selected_reasoning'].every(key=>boundedId(value[key])) ||
    !/^openai\/gpt-/.test(value.model_ref) || value.model_ref.includes('@') ||
    !Number.isInteger(value.context_window) || value.context_window<4096 || value.context_window>10000000 ||
    !Array.isArray(value.reasoning_settings) || !value.reasoning_settings.length || value.reasoning_settings.length>9 ||
    new Set(value.reasoning_settings).size!==value.reasoning_settings.length || value.reasoning_settings.some(x=>!REASONING.has(x)) ||
    !value.reasoning_settings.includes(value.selected_reasoning)) invalid('Use a valid, reviewed GCB OpenClaw host snapshot with exact model and reasoning metadata.');
  return Object.fromEntries(SNAPSHOT_FIELDS.map(key=>[key,copy(value[key])]));
}
const defaults = () => ['forge','scribe'].map(id=>({id,modelRef:`fictional/${id}`,name:id==='forge'?'Forge (offline demo)':'Scribe (offline demo)',mode:'offline'}));
const localId = modelRef => `local-${hash({modelRef,context:4096,output:128}).slice(0,24)}`;
const localEndpoint = value => typeof value==='string'&&/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(value)&&Number(value.split(':').pop())<=65535;
function canResume(target) {
  const status=target.status;
  return Boolean(target.plan && status && ['paused','cancelled','interrupted','rate_limited'].includes(status.status) &&
    !status.cells?.unknown_completion && !status.cells?.running && status.attempts<target.plan.max_requests &&
    status.elapsed_seconds<target.plan.total_timeout_seconds);
}
const publicTarget = target => {
  const {snapshot,binding,grantId,local,...result}=target;
  const safe=copy(result);if(safe.status)delete safe.status.grant_id;
  return {...safe,canResume:canResume(target),limitReached:Boolean(target.plan&&target.status?.attempts>=target.plan.max_requests)};
};
const terminal = status => ['complete','partial_unknown','budget_exhausted','blocked','cancelled'].includes(status);
function recordedEvidence(target, evidence) {
  const fail=()=>{throw new ReadError('GCB','GCB returned unsupported or mismatched recorded evidence. No model call was made.');};
  const json=value=>{if(value===undefined||value===null)return null;try{const text=JSON.stringify(value);if(Buffer.byteLength(text)>8192)fail();return JSON.parse(text);}catch{fail();}};
  const number=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1e12?value:null;
  const time=value=>typeof value==='string'&&/^\d{1,13}(?:\.\d+)?$/.test(value)?number(Number(value)):null;
  const label=value=>typeof value==='string'&&/^[A-Za-z0-9_.:/+@-]{1,256}$/.test(value)?value:null;
  if(!plain(evidence)||evidence.plan?.model_id!==target.id||evidence.status?.plan_id!==target.plan.plan_id||
    !Array.isArray(evidence.cells)||evidence.cells.length>128||!Array.isArray(evidence.attempts)||evidence.attempts.length>64)fail();
  const scope=new Map(target.plan.cells.map(cell=>[cell.cell_id,cell])),seen=new Set();
  const attempts=new Map();
  for(const attempt of evidence.attempts){
    if(!plain(attempt)||attempt.plan_id!==target.plan.plan_id||!scope.has(attempt.cell_id)||!boundedId(attempt.id))fail();
    const values=attempts.get(attempt.cell_id)||[];values.push(attempt);attempts.set(attempt.cell_id,values);
  }
  const records=evidence.cells.map(cell=>{
    const expected=scope.get(cell.cell_id);
    if(!expected||seen.has(cell.cell_id)||cell.configuration_id!==expected.configuration_id||cell.case_id!==expected.case_id||!label(cell.status))fail();
    seen.add(cell.cell_id);
    const observation=plain(cell.observation)?cell.observation:{},evaluation=plain(observation.evaluation)?observation.evaluation:{};
    const retained=cell.status==='observed'&&evaluation.allowlisted_fixture_output!==undefined&&evaluation.allowlisted_fixture_output!==null;
    const config=target.bio?.configurations?.find(row=>row.configuration_id===cell.configuration_id);
    return {cellId:cell.cell_id,caseId:cell.case_id,configurationId:cell.configuration_id,status:cell.status,
      score:typeof observation.correct==='boolean'?observation.correct:null,outcome:label(evaluation.outcome),criterion:json(evaluation.criterion),
      response:{availability:retained?'retained':cell.status==='not_applicable'?'not_applicable':['pending','running'].includes(cell.status)?'pending':'not_retained',
        value:retained?json(evaluation.allowlisted_fixture_output):null},requestedNative:json(config?.native),
      attempts:(attempts.get(cell.cell_id)||[]).map(attempt=>{
        const summary=plain(attempt.summary_json)?attempt.summary_json:{},usage=plain(summary.usage)?summary.usage:{};
        return {id:attempt.id,status:label(attempt.status),startedAt:time(attempt.started_at),endedAt:time(attempt.ended_at),latencyMs:number(summary.latency_ms),
          usage:Object.fromEntries(['input_tokens','output_tokens','reasoning_tokens','estimated_cost_usd','billed_cost_usd'].map(key=>[key,number(usage[key])])),
          servedModel:label(summary.served_model),outputSha256:/^[a-f0-9]{64}$/.test(summary.output_sha256||'')?summary.output_sha256:null,
          finishReason:label(summary.finish_reason),nativeConfirmation:label(summary.native_confirmation),
          effectiveNativeKnown:typeof summary.effective_native_settings_known==='boolean'?summary.effective_native_settings_known:null};
      })};
  });
  if(seen.size!==scope.size)fail();
  const result={targetId:target.id,planId:target.plan.plan_id,modelRef:target.modelRef,evidenceKind:label(evidence.plan.evidence_kind),records,
    limitations:['GCB retains only allowlisted parsed fixture responses, not arbitrary model text, original formatting or hidden thinking.',
      'Expected criteria are separate from recorded responses. Missing responses cannot be reconstructed from a passing score.',
      'Requested native settings are not proof of effective settings. Missing usage remains unknown.']};
  if(Buffer.byteLength(JSON.stringify(result))>262144)fail();
  return result;
}
function privateFile(file, limit=4000000) {
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>limit||stat.mode&0o077||
    typeof process.getuid==='function'&&stat.uid!==process.getuid())throw new ReadError('STORAGE','GCB storage permissions or file type are unsafe. No records were replaced.');
  return stat;
}
function readPrivate(file) {
  const stat=privateFile(file),fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try {const now=fs.fstatSync(fd);if(now.ino!==stat.ino||now.dev!==stat.dev||now.size>4000000)throw new Error('Storage changed');return fs.readFileSync(fd,'utf8');}
  finally{fs.closeSync(fd);}
}
function writeAtomic(file,bytes) {
  const temp=`${file}.${crypto.randomUUID()}.tmp`;let fd;
  try {
    fd=fs.openSync(temp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
    fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temp,file);
  } finally {if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temp);}catch(error){if(error.code!=='ENOENT')throw error;}}
}

class GcbService {
  constructor({directory,home=os.homedir(),authorizeTarget,authorizeLocal,executable,execute=execFile,nativeHelper=path.join(__dirname,'gcb-openclaw.cjs')}={}) {
    if (!path.isAbsolute(directory||'')) throw new TypeError('An absolute application data directory is required');
    this.directory=directory;this.home=home;this.authorizeTarget=authorizeTarget;this.authorizeLocal=authorizeLocal;this.execute=execute;this.nativeHelper=nativeHelper;
    this.executable=null;this.engine={status:'unavailable',message:'Connect an independently installed GCB executable to begin. Python 3.11 or newer is required.'};
    this.targets=defaults();this.active=null;this.reviews=new Map();this.children=new Set();this.queue=Promise.resolve();
    this.closed=false;this.connectionEpoch=0;this.initialized=new Set();this.runPromise=null;this.invalidIndex=false;
    this.index=path.join(directory,'profiles.json');this.savedBytes=null;
    try {
      this._directory(false);
      let bytes=null;try{bytes=readPrivate(this.index);}catch(error){if(error.code!=='ENOENT')throw error;}
      if (bytes!==null) {
        const saved=JSON.parse(bytes);this.savedBytes=bytes;
        if(saved.version!==1 || !Array.isArray(saved.targets) || saved.targets.length>34 ||
           (saved.executable!==null && !path.isAbsolute(saved.executable||''))) throw new Error('invalid');
        const ids=new Set();
        for(const target of saved.targets) {
          if(!plain(target)||!boundedId(target.id)||ids.has(target.id)||!['offline','openclaw','ollama'].includes(target.mode))throw new Error('invalid');
          ids.add(target.id);
          if(target.mode==='offline'&&!['forge','scribe'].includes(target.id))throw new Error('invalid');
          if(target.mode==='openclaw') {
            target.snapshot=snapshotRecord(target.snapshot);
            if(target.id!==`host-${hash(target.snapshot).slice(0,24)}`)throw new Error('invalid');
          }
          if(target.mode==='ollama'&&(!plain(target.local)||target.id!==localId(target.modelRef)||
            target.modelRef!==`ollama/${target.local.nativeModel}`||!boundedId(target.local.nativeModel)||
            !localEndpoint(target.local.endpoint)||/cloud/i.test(target.local.nativeModel)))throw new Error('invalid');
          if(target.plan && (!boundedId(target.plan.plan_id)||target.plan.model_id!==target.id))throw new Error('invalid');
          if(target.grantId&&!boundedId(target.grantId))throw new Error('invalid');
          // A reopened app never treats a prior live preflight as current authority.
          delete target.binding;
          if(target.status?.status==='running')target.status={...target.status,status:'interrupted'};
        }
        if(!ids.has('forge')||!ids.has('scribe'))throw new Error('invalid');
        this.targets=saved.targets;this.executable=saved.executable;
      }
    } catch {
      this.invalidIndex=true;this.executable=null;this.targets=defaults();
      this.engine={status:'unavailable',message:'The saved GCB workspace could not be validated. Preserve its files and review them before reconnecting; no profiling will start.'};
    }
    if(executable&&!this.invalidIndex)this.executable=executable;
    this.ready=this.executable&&!this.invalidIndex ? this._verifyEngine().catch(()=>{}) : Promise.resolve();
  }
  _save() {
    if(this.invalidIndex)throw new ReadError('INVALID','The saved GCB workspace needs review before it can be changed.');
    this._directory();
    this._assertIndex();
    // A new explicit review grants every resumed run. The desktop index needs
    // neither a reusable grant token nor an old native readiness binding.
    const targets=this.targets.map(({grantId,binding,...target})=>{
      const saved=copy(target);if(saved.status)delete saved.status.grant_id;return saved;
    });
    const bytes=JSON.stringify({version:1,executable:this.executable,targets},null,2);
    if(Buffer.byteLength(bytes)>4000000)throw new ReadError('STORAGE','The GCB workspace exceeds its supported size.');
    writeAtomic(this.index,bytes);this.savedBytes=bytes;
    const fd=fs.openSync(this.directory,fs.constants.O_RDONLY);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  }
  _assertIndex() {
    if(this.invalidIndex)throw new ReadError('STORAGE','The saved GCB workspace needs review before it can be changed.');
    let current=null;try{current=readPrivate(this.index);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(current!==this.savedBytes){this.invalidIndex=true;throw new ReadError('CONFLICT','The GCB workspace changed outside this window. Reopen it before making more changes.');}
  }
  _directory(create=true) {
    if(create)fs.mkdirSync(this.directory,{recursive:true,mode:0o700});
    let stat;try{stat=fs.lstatSync(this.directory);}catch(error){if(!create&&error.code==='ENOENT')return;throw error;}
    if(!stat.isDirectory()||stat.isSymbolicLink()||stat.mode&0o077||typeof process.getuid==='function'&&stat.uid!==process.getuid())
      throw new ReadError('STORAGE','The GCB workspace must be a private, owned directory.');
  }
  _databaseFiles(db) {
    this._directory();
    if(!['offline.sqlite3','host.sqlite3','local.sqlite3'].map(file=>path.join(this.directory,file)).includes(db))invalid();
    for(const file of [db,`${db}-journal`,`${db}-wal`,`${db}-shm`])try{privateFile(file,128*1024*1024);}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  _env(binding) {
    const env={HOME:this.home,PATH:'/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      LANG:'en_US.UTF-8',PYTHONIOENCODING:'utf-8',TMPDIR:os.tmpdir()};
    if(binding?.configPath){
      const bin=path.join(this.directory,'native-bin'),shim=path.join(bin,'openclaw');
      fs.mkdirSync(bin,{recursive:true,mode:0o700});
      const stat=fs.lstatSync(bin);
      if(!stat.isDirectory()||stat.isSymbolicLink()||stat.mode&0o077||typeof process.getuid==='function'&&stat.uid!==process.getuid())
        throw new ReadError('STORAGE','The native GCB adapter directory is unsafe.');
      if(!path.isAbsolute(this.nativeHelper)||!fs.statSync(this.nativeHelper).isFile())throw new ReadError('UNAVAILABLE','The native GCB adapter is unavailable.');
      fs.accessSync(this.nativeHelper,fs.constants.X_OK);
      let link;
      try{link=fs.lstatSync(shim);}catch(error){if(error.code!=='ENOENT')throw error;fs.symlinkSync(this.nativeHelper,shim);link=fs.lstatSync(shim);}
      if(!link.isSymbolicLink()||fs.readlinkSync(shim)!==this.nativeHelper||typeof process.getuid==='function'&&link.uid!==process.getuid())
        throw new ReadError('STORAGE','The native GCB adapter binding changed. No model call was started.');
      env.PATH=`${bin}:${env.PATH}`;
      env.OPENCLAW_CONFIG_PATH=binding.configPath;env.OPENCLAW_PLUS_GCB_EXPECT_URL=binding.url;
    }
    return env;
  }
  _command(args,{binding,timeout=15000}={}) {
    if(this.closed) return Promise.reject(new ReadError('CLOSED','The profiling workspace is closed.'));
    if(!this.executable)return Promise.reject(new ReadError('UNAVAILABLE','Connect the GCB executable first.'));
    try{this._directory();this._assertIndex();if(args[0]==='--db')this._databaseFiles(args[1]);}catch(error){return Promise.reject(error);}
    return new Promise((resolve,reject)=>{
      let child,done=false;
      const callback=(error,stdout)=>{
        done=true;if(child)this.children.delete(child);
        let result;
        try { if(Buffer.byteLength(stdout||'')>2000000)throw new Error();result=JSON.parse(stdout); }
        catch { return reject(new ReadError('GCB','GCB could not complete this operation. Check the package and model connection; saved evidence is retained.')); }
        if(error && !(error.code===3 && ['no_eligible','denied'].includes(result?.status)))
          return reject(new ReadError('GCB','GCB rejected or could not confirm this operation. Review the current state before trying again.'));
        resolve(result);
      };
      try {
        child=this.execute(this.executable,args,{shell:false,encoding:'utf8',timeout,maxBuffer:2000000,
          windowsHide:true,cwd:this.directory,env:this._env(binding)},callback);
        if(child&&!done)this.children.add(child);
      } catch { reject(new ReadError('UNAVAILABLE','The selected GCB executable is unavailable. Reconnect an installed package.')); }
    });
  }
  async _verifyEngine() {
    try {
      if(!path.isAbsolute(this.executable||''))throw new Error();
      const stat=fs.statSync(this.executable);
      if(!stat.isFile())throw new Error();
      fs.accessSync(this.executable,fs.constants.X_OK);
      this._directory();
      const doctor=await this._command(['doctor']);
      if(!plain(doctor)||doctor.network_probes!==false||!Array.isArray(doctor.runtime_dependencies)||!/^3\.(1[1-9]|[2-9]\d)\./.test(doctor.python))throw new Error();
      this.engine={status:'ready',message:'GCB is connected. Research and routing previews do not run a model.',python:doctor.python};
      for(const target of this.targets)if(target.plan)await this._refresh(target).catch(()=>{target.error={code:'GCB',message:'Saved evidence could not be refreshed. Check the GCB package and workspace files.'};});
      this._save();
    } catch(error) {
      this.engine={status:'unavailable',message:'GCB could not be opened. Select its installed executable (Python 3.11 or newer), then reconnect.'};
      throw error;
    }
  }
  _serialize(work) {
    const result=this.queue.then(async()=>{await this.ready;if(this.closed)throw new ReadError('CLOSED','The profiling workspace is closed.');return work();});
    this.queue=result.catch(()=>{});return result;
  }
  connect(executable) {return this._serialize(async()=>{
    if(this.invalidIndex)invalid('The saved GCB workspace needs review before reconnecting.');
    if(this.active)throw new ReadError('BUSY','Pause the current profile before changing GCB.');
    if(!path.isAbsolute(executable||''))invalid();
    this.executable=executable;this.reviews.clear();this.initialized.clear();await this._verifyEngine();return this.overview();
  });}
  importSnapshot(snapshot) {return this._serialize(async()=>{
    this._requireEngine();const validated=snapshotRecord(snapshot),id=`host-${hash(validated).slice(0,24)}`;
    if(this.targets.some(target=>target.id===id))return this.overview();
    if(this.targets.length>=34)invalid('This workspace supports at most 32 imported models.');
    // Import is registration only. Fresh native readiness is required at research and dispatch.
    this.targets.push({id,modelRef:validated.model_ref,name:validated.model_ref,mode:'openclaw',snapshot:validated});
    this._save();return this.overview();
  });}
  _requireEngine(){if(this.engine.status!=='ready')throw new ReadError('UNAVAILABLE',this.engine.message);}
  _target(id){if(!boundedId(id))invalid();const result=this.targets.find(target=>target.id===id);if(!result)invalid('Choose a registered model.');return result;}
  _db(target){return path.join(this.directory,target.mode==='offline'?'offline.sqlite3':target.mode==='ollama'?'local.sqlite3':'host.sqlite3');}
  async _init(target){const db=this._db(target);if(!this.initialized.has(db)){
    this._databaseFiles(db);
    try{const fd=fs.openSync(db,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);fs.closeSync(fd);}catch(error){if(error.code!=='EEXIST')throw error;}
    await this._command(['--db',db,'init']);this.initialized.add(db);
  }}
  _backend(target) {
    if(target.mode==='offline')return ['--backend','fictional'];
    if(target.mode==='ollama')return ['--backend','ollama','--endpoint',target.local.endpoint,'--native-model',target.local.nativeModel,
      '--context-tokens','4096','--output-cap','128'];
    const file=path.join(this.directory,`${target.id}.json`);
    try{privateFile(file);}catch(error){if(error.code!=='ENOENT')throw error;}
    writeAtomic(file,JSON.stringify(target.snapshot));
    return ['--backend','openclaw','--host-snapshot',file];
  }
  async _check(target,{requireSame=false}={}) {
    if(target.mode==='offline')return null;
    if(['OPENCLAW_SHELL','OPENCLAW_SUBAGENT_EXEC','OPENCLAW_SUBAGENT_ID'].some(key=>process.env[key]!==undefined))
      throw new ReadError('ACCESS','Host profiling must run from the ordinary desktop owner context with existing OpenClaw permissions.');
    const local=target.mode==='ollama',authorize=local?this.authorizeLocal:this.authorizeTarget;
    if(typeof authorize!=='function')throw new ReadError('UNAVAILABLE',local?'Connect OpenClaw and refresh its local Ollama catalog before profiling.':'Connect OpenClaw and its supported GCB host bridge before profiling.');
    const epoch=this.connectionEpoch;
    const binding=await authorize(local?target.modelRef:copy(target.snapshot));
    if(epoch!==this.connectionEpoch)throw new ReadError('STALE','The OpenClaw connection changed. Research the model again.');
    if(!plain(binding)||typeof binding.metadataFingerprint!=='string'||!binding.metadataFingerprint||
      !path.isAbsolute(binding.configPath||'')||!/^ws:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(binding.url||'')||
      Number(binding.url.split(':').pop())>65535||(!local&&binding.hostVersion!==target.snapshot.openclaw_version)||
      (local&&(!localEndpoint(binding.endpoint)||binding.nativeModel!==target.modelRef.slice('ollama/'.length)||/cloud/i.test(binding.nativeModel))))
      throw new ReadError('UNAVAILABLE','The native model connection could not be verified.');
    if(local&&target.local&&(target.local.endpoint!==binding.endpoint||target.local.nativeModel!==binding.nativeModel))
      throw new ReadError('STALE','The configured local model route changed. Review the retained target before running another check.');
    if(requireSame && (!target.binding || target.binding.metadataFingerprint!==binding.metadataFingerprint ||
      target.binding.connectionGeneration!==binding.connectionGeneration || target.binding.configPath!==binding.configPath || target.binding.url!==binding.url||
      local&&target.binding.endpoint!==binding.endpoint))
      throw new ReadError('STALE','Native model metadata or the connection changed. Research this model again before authorizing usage.');
    return binding;
  }
  overview(){return {engine:copy(this.engine),targets:this.targets.map(publicTarget),active:this.active?.targetId||null};}
  async _refresh(target) {
    if(!target.plan)return;
    target.status=await this._command(['--db',this._db(target),'profile','status',target.plan.plan_id]);
    target.bio=await this._command(['--db',this._db(target),'bio',target.id]);
  }
  handle(operation,params={}) {return this._serialize(async()=>{
    if(!PROFILE_OPERATIONS.includes(operation))invalid();
    const required=operation==='modelsProfileOverview'?[]:operation==='modelsProfileLocal'?['modelRef']:operation==='modelsProfileStart'?['reviewToken','approveUsage','approveHostRuntime']:['targetId'];
    fields(params,required,operation==='modelsProfilePlan'?['contrast']:[]);
    if(operation==='modelsProfileOverview'){
      return this.overview();
    }
    this._requireEngine();
    if(operation==='modelsProfileStart')return this._start(params);
    if(operation==='modelsProfileLocal') {
      if(this.active)throw new ReadError('BUSY','Pause the active profile before adding a local model.');
      if(typeof params.modelRef!=='string'||!/^ollama\/[A-Za-z0-9][A-Za-z0-9_.:/+-]{0,240}$/.test(params.modelRef)||/cloud/i.test(params.modelRef))invalid();
      const id=localId(params.modelRef),existing=this.targets.find(target=>target.id===id);
      const target=existing||{id,modelRef:params.modelRef,name:params.modelRef,mode:'ollama'};
      const binding=await this._check(target);
      if(!existing) {
        if(this.targets.length>=34)invalid('This workspace supports at most 32 registered profiling models.');
        target.local={endpoint:binding.endpoint,nativeModel:binding.nativeModel};this.targets.push(target);this._save();
      }
      return this.overview();
    }
    const target=this._target(params.targetId);
    if(operation==='modelsProfileEvidence') {
      if(!target.plan)invalid('Create a benchmark plan before opening recorded evidence.');
      const evidence=await this._command(['--db',this._db(target),'evidence',target.plan.plan_id]);
      return recordedEvidence(target,evidence);
    }
    if(operation==='modelsProfilePause') {
      if(this.active?.targetId!==target.id)throw new ReadError('INVALID','This model has no active profile to pause.');
      this.active.pause=true;return this.overview();
    }
    if(operation==='modelsProfileCancel') {
      if(!target.plan)invalid('Create a benchmark plan first.');
      if(this.active?.targetId===target.id){this.active.cancel=true;this.active.pause=true;}
      target.status=await this._command(['--db',this._db(target),'profile','cancel',target.plan.plan_id]);
      this._save();return this.overview();
    }
    if(operation==='modelsProfilePreview') {
      if(!target.metadata)invalid('Research this model first.');
      const routes=[];
      for(const [role,category] of [['Coding','coding'],['Code review','code_review'],['Research','research'],['Planning','planning'],['Orchestration','orchestration']]) {
        const preview=await this._command(['--db',this._db(target),'route','--task',JSON.stringify({category}),
          '--policy',JSON.stringify({allowed_configurations:target.metadata.configuration_ids,allow_remote:target.mode==='openclaw'})]);
        routes.push({role,preview});
      }
      return {routes};
    }
    if(this.active)throw new ReadError('BUSY','Pause the current profile before preparing another one.');
    if(operation==='modelsProfileResearch') {
      const epoch=this.connectionEpoch;
      const binding=await this._check(target);await this._init(target);
      const metadata=await this._command(['--db',this._db(target),'profile','research',target.id,...this._backend(target)],{binding:target.mode==='openclaw'?binding:undefined});
      if(target.mode!=='offline'&&epoch!==this.connectionEpoch)throw new ReadError('STALE','The OpenClaw connection changed during research. Check it and research again.');
      if(metadata.model?.id!==target.id||!Array.isArray(metadata.configuration_ids)||!metadata.configuration_ids.length)throw new ReadError('GCB','GCB returned incomplete research metadata.');
      target.metadata=metadata;target.binding=binding;delete target.error;
      target.bio=await this._command(['--db',this._db(target),'bio',target.id]);
      this.reviews.clear();this._save();return this.overview();
    }
    if(operation==='modelsProfilePlan') {
      const epoch=this.connectionEpoch;
      if(params.contrast!==undefined&&typeof params.contrast!=='boolean')invalid();
      if(!target.metadata)invalid('Research the model before planning a benchmark.');
      if(target.mode!=='offline')await this._check(target,{requireSame:true});
      if(target.plan)await this._refresh(target);
      if(target.status?.status==='partial_unknown'||target.status?.cells?.unknown_completion||target.status?.cells?.running)
        throw new ReadError('UNCERTAIN','GCB has uncertain completion. Retain the evidence and reconcile it before running more calls.');
      const resumed=canResume(target);
      const planned=target.plan&&target.status?.status==='planned';
      if(!resumed&&!planned) {
        if(target.plan&&target.status?.status!=='complete')throw new ReadError('INVALID','This plan cannot safely resume. Review its GCB evidence before creating more work.');
        let scope=params.contrast===true?[]:['--no-contrast'];
        if(target.mode==='ollama') {
          const baseline=target.bio?.configurations?.find(row=>row.native?.think===false&&row.native?.options?.num_ctx===4096&&row.native?.options?.num_predict===128&&target.metadata.configuration_ids.includes(row.configuration_id));
          if(!baseline)throw new ReadError('UNAVAILABLE','GCB did not research an exact think:false configuration with the smoke request limits. No inference was authorized.');
          scope=['--no-contrast','--baseline-configuration',baseline.configuration_id];
        }
        target.plan=await this._command(['--db',this._db(target),'profile','plan',target.id,...this._backend(target),
          ...scope,'--max-requests',target.mode==='ollama'?'1':'32','--call-timeout','45','--total-timeout',target.mode==='ollama'?'60':'300'],
          {binding:target.mode==='openclaw'?target.binding:undefined});
        if(!boundedId(target.plan.plan_id)||target.plan.model_id!==target.id)throw new ReadError('GCB','GCB returned an invalid benchmark plan.');
        delete target.grantId;
        await this._refresh(target);
      }
      const reviewToken=crypto.randomUUID();
      if(target.mode!=='offline'&&epoch!==this.connectionEpoch)throw new ReadError('STALE','The OpenClaw connection changed during planning. Review again.');
      this.reviews.clear();this.reviews.set(reviewToken,{targetId:target.id,planId:target.plan.plan_id,digest:hash(target.plan),expires:Date.now()+300000,resumed,epoch});
      this._save();return {reviewToken,plan:copy(target.plan),target:publicTarget(target),resumed};
    }
    invalid();
  });}
  async _start(params) {
    if(params.approveUsage!==true||typeof params.approveHostRuntime!=='boolean')throw new ReadError('ACCESS','Review and explicitly authorize the displayed benchmark scope first.');
    const review=this.reviews.get(params.reviewToken);this.reviews.delete(params.reviewToken);
    if(!review||review.expires<Date.now())throw new ReadError('STALE','This benchmark review expired. Review the current scope again.');
    if(this.active)throw new ReadError('BUSY','Another profile is active.');
    const target=this._target(review.targetId);
    if(target.mode!=='offline'&&review.epoch!==this.connectionEpoch)throw new ReadError('STALE','This benchmark review expired. Review the current scope again.');
    if(target.plan?.plan_id!==review.planId||hash(target.plan)!==review.digest)throw new ReadError('STALE','The benchmark plan changed. Review it again.');
    if(target.mode==='openclaw'&&params.approveHostRuntime!==true)throw new ReadError('ACCESS','Subscription-backed usage needs separate approval.');
    if(target.mode!=='openclaw'&&params.approveHostRuntime!==false)invalid();
    const binding=await this._check(target,{requireSame:true});
    if(binding)target.binding=binding;
    await this._refresh(target);
    if(review.expires<Date.now()||target.mode!=='offline'&&review.epoch!==this.connectionEpoch)throw new ReadError('STALE','The connection or review changed. Review the benchmark scope again.');
    if(target.status?.cells?.unknown_completion||target.status?.cells?.running)throw new ReadError('UNCERTAIN','GCB has an unfinished or uncertain request. Review its evidence before resuming.');
    const active={targetId:target.id,pause:false,cancel:false,epoch:this.connectionEpoch,resumed:review.resumed};
    // Each explicit review obtains a new grant for the SAME immutable plan.
    // GCB retains cumulative attempts/time; this cannot expand its scope.
    delete target.grantId;this.active=active;delete target.error;
    this.runPromise=this._run(target,active).catch(()=>{});
    return this.overview();
  }
  async _run(target,active) {
    try {
      let first=true;
      while(!active.cancel) {
        if(!first&&active.pause)break;
        if(target.mode!=='offline') {
          if(active.epoch!==this.connectionEpoch)break;
          const binding=await this._check(target,{requireSame:true});
          if(active.epoch!==this.connectionEpoch||active.pause)break;
          target.binding=binding;
        }
        const action=first&&!active.resumed?'start':'resume';
        const args=['--db',this._db(target),'profile',action,target.plan.plan_id,...this._backend(target),
          '--max-cells','1',...(target.mode==='openclaw'?['--approve-host-runtime']:[]),
          ...(target.grantId?['--grant',target.grantId]:['--authorize'])];
        const result=await this._command(args,{binding:target.mode==='openclaw'?target.binding:undefined,timeout:65000});
        if(typeof result.grant_id==='string'&&boundedId(result.grant_id))target.grantId=result.grant_id;
        const {grant_id,...status}=result;target.status=status;
        await this._refresh(target);this._save();
        first=false;
        if(terminal(target.status.status)||target.status.status==='rate_limited'||active.pause||target.status.attempts>=target.plan.max_requests)break;
        // Yield between committed GCB cells so pause never requires replay.
        await new Promise(resolve=>setTimeout(resolve,80));
      }
    } catch(error) {
      target.error={code:error.code||'GCB',message:error instanceof ReadError?error.message:'GCB could not confirm this operation. Review saved evidence before continuing.'};
      await this._refresh(target).catch(()=>{});
    } finally {
      if(this.active===active)this.active=null;
      this._save();
    }
  }
  invalidateConnection() {
    this.connectionEpoch++;
    for(const [token,review] of this.reviews)if(this._target(review.targetId).mode!=='offline')this.reviews.delete(token);
    if(this.active&&this._target(this.active.targetId).mode!=='offline')this.active.pause=true;
  }
  async close() {
    if(this.closed)return;
    if(this.active){
      this.active.pause=true;this.active.cancel=true;
      const target=this._target(this.active.targetId);
      await this._command(['--db',this._db(target),'profile','cancel',target.plan.plan_id],{timeout:3000}).catch(()=>{});
    }
    // Ask GCB to cancel its own operation; termination never implies provider completion.
    if(this.runPromise) {
      let timer;await Promise.race([this.runPromise,new Promise(resolve=>{timer=setTimeout(resolve,4000);})]);clearTimeout(timer);
    }
    for(const child of this.children)try{child.kill('SIGTERM');}catch{}
    this.closed=true;this.reviews.clear();
  }
}
module.exports={GcbService,PROFILE_OPERATIONS,snapshotRecord};
