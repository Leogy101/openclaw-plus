'use strict';
// A fake CLI, not a gateway. It never opens a socket or reads production configuration.
const fs=require('node:fs');
const path=require('node:path');
const args=process.argv.slice(2);
const stdin=args[0]==='--composer-stdin';
if(stdin ? !['chat.send','sessions.patch','config.patch','tts.speak'].includes(args[1])||args[2]!=='ws://127.0.0.1:19999' : args[0]!=='gateway'||args[1]!=='call'||!args.includes('--expect-url')||args[args.indexOf('--expect-url')+1]!=='ws://127.0.0.1:19999') process.exit(2);
const method=stdin?args[1]:args[2],params=JSON.parse(stdin?fs.readFileSync(0,'utf8'):args[args.indexOf('--params')+1]);
fs.mkdirSync(process.env.HOME,{recursive:true});
fs.appendFileSync(path.join(process.env.HOME,'fixture-calls.jsonl'),JSON.stringify({method,params})+'\n');
if(fs.existsSync(path.join(process.env.HOME,'offline'))) {
 console.log(JSON.stringify({error:{code:'UNAVAILABLE',message:'Fixture offline'}}));process.exit(1);
}
const make=(key,agentId,title,extra={})=>({key:'agent:'+agentId+':'+key,agentId,sessionId:'physical-'+key,displayName:title,updatedAt:1700000000000,hasActiveRun:false,activeRunIds:[],...extra});
const coordinator=make('main','main','Workspace review');
const builder=make('child','builder','Verify changes',{parentSessionKey:coordinator.key,hasActiveRun:true,activeRunIds:['run-builder']});
const builderTwo=make('second','builder','Other Builder session');
const rows=[coordinator,builder,builderTwo,...Array.from({length:65},(_,i)=>make('extra'+i,'main','Earlier conversation '+i))];
if(['fixture-terminal.json','fixture-permissions.json','fixture-voice.json'].some(name=>fs.existsSync(path.join(process.env.HOME,name)))){
 for(const row of rows)row.lifecycleRevision='fixture-lifecycle-'+row.sessionId;
}
const reportFile=path.join(process.env.HOME,'fixture-report.md');
const report=fs.existsSync(reportFile)?fs.readFileSync(reportFile,'utf8'):'';
const stateFile=path.join(process.env.HOME,'fixture-state.json');
const persisted=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):{sent:[],approvalStatus:'pending',configHash:'fixture-hash',config:{ui:{name:'Before'},models:{apiKey:'__OPENCLAW_REDACTED__'}},planRevision:1};
for(const row of rows){
 if(persisted.permissionModes?.[row.key]!=null)row.permissionMode=persisted.permissionModes[row.key];
 if(persisted.permissionPending?.[row.key]===true)row.permissionModePending=true;
}
const thinkingLevels=['low','medium','high'].map(id=>({id,label:id[0].toUpperCase()+id.slice(1)}));
for(const row of rows)Object.assign(row,{modelProvider:'fixture',model:'model-one',thinkingLevel:'medium',thinkingLevels,thinkingDefault:'medium',...persisted.composer?.[row.key]});
const save=()=>{fs.writeFileSync(stateFile+'.tmp',JSON.stringify(persisted));fs.renameSync(stateFile+'.tmp',stateFile);};
const approval=()=>({id:'approval-fixture',status:persisted.approvalStatus,createdAtMs:1700000000000,expiresAtMs:fs.statSync(process.env.HOME).birthtimeMs+600000,sourceSessionKey:coordinator.key,presentation:{kind:'exec',commandText:'printf fixture',host:'gateway',agentId:'main',allowedDecisions:['allow-once','deny']}});
let result;
switch(method){
 case 'agents.list':result={defaultId:'main',agents:['main','builder','reviewer','researcher','assistant-c','assistant-b','assistant-a'].map(id=>({id,name:{main:'Coordinator',builder:'Builder',reviewer:'Reviewer',researcher:'Researcher','assistant-a':'Assistant A','assistant-b':'Assistant B','assistant-c':'Assistant C'}[id]||id}))};break;
 case 'sessions.list':{
  let filtered=params.spawnedBy?[builder]:rows;
  if(params.agentId)filtered=filtered.filter(r=>r.agentId===params.agentId);
  if(params.search)filtered=filtered.filter(r=>r.displayName.toLowerCase().includes(params.search.toLowerCase()));
  if(params.activeOnly)filtered=filtered.filter(r=>r.hasActiveRun);
  const offset=params.offset||0,limit=params.limit||60;
  result={sessions:filtered.slice(offset,offset+limit),totalCount:filtered.length,limitApplied:limit,hasMore:offset+limit<filtered.length,nextOffset:Math.min(offset+limit,filtered.length)};break;
 }
 case 'chat.history':{
  if(params.sessionId) {console.log(JSON.stringify({error:{code:'INVALID_REQUEST',message:'sessionId requires messageId'}}));process.exit(1);}
  const row=rows.find(r=>r.key===params.sessionKey);if(!row)process.exit(3);
  const old=params.offset>0;
  result={sessionKey:row.key,sessionId:row.sessionId,totalMessages:103,hasMore:!old,nextOffset:old?103:100,
   messages:old?[{role:'user',content:'Earlier fixture message',__openclaw:{id:'old'}}]:[
    {role:'user',content:'Review the workspace',__openclaw:{id:'u1'}},
    {role:'assistant',content:[{type:'text',text:row.agentId==='builder'?'Builder exact child history':'Coordinator is coordinating.'},{type:'toolCall',name:'verify',arguments:{path:'<img src=x onerror="window.intruded=true">'}}],__openclaw:{id:'a1'}},
    {role:'toolResult',content:[{type:'text',text:'Checks passed. <script>window.intruded=true</script>'}],__openclaw:{id:'t1'}},
    ...persisted.sent.filter(x=>x.sessionKey===row.key).flatMap(x=>[{role:'user',content:x.message,__openclaw:{id:'sent-'+x.idempotencyKey}},{role:'assistant',content:'Fixture reply received.',__openclaw:{id:'reply-'+x.idempotencyKey}}]),
    ...(report?[{role:'assistant',content:[{type:'text',text:report},
      {type:'thinking',thinking:'PROVIDED REASONING: do not copy'},
      {type:'toolCall',name:'fixtureOnly',arguments:{detail:'INTERNAL TOOL DETAIL: do not copy'}}],__openclaw:{id:'report'}}]:[])],sessionInfo:{...row,activeLeafEntryId:persisted.sent.filter(x=>x.sessionKey===row.key).at(-1)?.idempotencyKey||'leaf-1'}};
  const questionFile=path.join(process.env.HOME,'fixture-questions.json');
  if(fs.existsSync(questionFile)) {
   const extra=JSON.parse(fs.readFileSync(questionFile,'utf8'))[row.key]?.[old?'older':'current'];
   if(Array.isArray(extra))result.messages.push(...extra);
  }
  break;
 }
 case 'progressCard.get':result={card:{sessionKey:params.sessionKey,revision:persisted.planRevision,updatedAt:1700000000000,markdown:'Fixture task plan',steps:[{step:'Inspect implementation',status:'completed'},{step:'Implement requested changes',status:'in_progress'},{step:'Verify behavior',status:'pending'}]}};break;
 case 'chat.send':{
  const prior=persisted.sent.find(x=>x.idempotencyKey===params.idempotencyKey);
  if(!prior){persisted.sent.push(params);persisted.planRevision++;save();}
  result={runId:params.idempotencyKey,status:prior?'ok':'started'};break;
 }
 case 'chat.abort':result={ok:true,aborted:true,runIds:[params.runId]};break;
 case 'tts.status':result={enabled:false,auto:'off',provider:'fixture',fallbackProviders:[],providerStates:[{id:'fixture',label:'Fixture',configured:true}]};break;
 case 'tts.speak':{
  if(!stdin||typeof params.text!=='string'||!params.text.trim()||params.text.length>4000||Object.keys(params).some(key=>key!=='text'))process.exit(3);
  // Canonical mono PCM WAV with silence only. Native tests stub playback as well.
  const wav=Buffer.alloc(1644);wav.write('RIFF',0);wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);
  wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(1600,40);
  result={audioBase64:wav.toString('base64'),provider:'fixture',mimeType:'audio/wav',fileExtension:'.wav'};break;
 }
 case 'models.list':result={models:[{id:'model-one',provider:'fixture',name:'Fixture Model',available:true,input:['text','image'],thinkingLevels,thinkingDefault:'medium'},
  {id:'model-two',provider:'fixture',name:'Fixture Vision',available:true,input:['text','image'],thinkingLevels,thinkingDefault:'medium'}]};break;
 case 'sessions.patch':{
  const row=rows.find(row=>row.key===params.key&&row.agentId===params.agentId);
  if(!row||row.sessionId!==params.expectedSessionId){console.log(JSON.stringify({error:{code:'CONFLICT'}}));process.exit(1);}
  if(Object.hasOwn(params,'permissionMode')){
   if(!stdin||!Object.hasOwn(params,'expectedPermissionMode')||(row.permissionMode??null)!==params.expectedPermissionMode||row.lifecycleRevision!==params.expectedLifecycleRevision){console.log(JSON.stringify({error:{code:'CONFLICT'}}));process.exit(1);}
   if(params.permissionMode!==null&&!['read-only','guarded','workspace','full'].includes(params.permissionMode)){console.log(JSON.stringify({error:{code:'INVALID_REQUEST'}}));process.exit(1);}
   persisted.permissionModes??={};persisted.permissionModes[row.key]=params.permissionMode;save();
   const entry={...row};if(params.permissionMode===null)delete entry.permissionMode;else entry.permissionMode=params.permissionMode;
   result={ok:true,key:row.key,entry};break;
  }
  const patch={};
  if(Object.hasOwn(params,'model')){const model=params.model||'fixture/model-one';patch.modelProvider=model.split('/')[0];patch.model=model.slice(model.indexOf('/')+1);}
  if(Object.hasOwn(params,'thinkingLevel'))patch.thinkingLevel=params.thinkingLevel||'medium';
  persisted.composer??={};persisted.composer[row.key]={...persisted.composer[row.key],...patch};save();
  result={ok:true,key:row.key,entry:{...row,...patch}};break;
 }
 case 'exec.approval.list':result=persisted.approvalStatus==='pending'?[{id:'approval-fixture',request:{sessionKey:coordinator.key}}]:[];break;
 case 'plugin.approval.list':case 'openclaw.approval.list':result=[];break;
 case 'approval.get':result={approval:approval()};break;
 case 'approval.resolve':persisted.approvalStatus=params.decision==='deny'?'denied':'allowed';save();result={applied:true,approval:{...approval(),decision:params.decision}};break;
 case 'config.get':result={valid:true,hash:persisted.configHash,config:persisted.config};break;
 case 'config.patch':{
  if(params.baseHash!==persisted.configHash){console.log(JSON.stringify({error:{code:'CONFLICT'}}));process.exit(1);}
  const merge=(a,b)=>{for(const[k,v]of Object.entries(b)){if(v===null)delete a[k];else if(v&&typeof v==='object'&&!Array.isArray(v)){a[k]=merge(a[k]&&typeof a[k]==='object'?a[k]:{},v);}else a[k]=v;}return a;};
  persisted.config=merge(persisted.config,JSON.parse(params.raw));persisted.configHash='changed-hash';save();result={ok:true,hash:persisted.configHash};break;
 }
 case 'sessions.describe': result={session:rows.find(r=>r.key===params.key)||null};break;
 case 'sessions.processes.list':result={sessionId:rows.find(r=>r.key===params.key)?.sessionId||'missing',processes:[{processId:'verify',instanceId:'instance-1',name:'verify.sh',status:'running',startedAt:1700000000000,tail:'Fixture output: checks running',truncated:false,canStop:false}],truncated:false};break;
 case 'cron.list':result={jobs:[{id:'job-1',name:'Workspace index',enabled:true,schedule:{kind:'cron',expr:'0 8 * * *',tz:'Etc/UTC'},lastRunAtMs:1700000000000,nextRunAtMs:1700086400000,lastRunStatus:'ok'}],total:1,hasMore:false};break;
 case 'cron.runs':result={entries:[{runId:'cron-1',jobId:'job-1',jobName:'Workspace index',status:'ok',ts:1700000000000,summary:'Index updated'}],total:1,hasMore:false};break;
 default:process.exit(4);
}
console.log(JSON.stringify(result));
