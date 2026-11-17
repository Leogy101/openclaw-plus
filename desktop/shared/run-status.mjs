// Portable projection of an authoritative chat.history snapshot. No IO or implicit clock.
// Run activity and usage do not establish engineering progress or project completion.
export const RUN_FRESH_MS = 45000;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const id=value=>typeof value==='string'&&value.length>0&&value.length<=1024&&!/[\x00-\x1f\x7f]/u.test(value);
const label=(value,max)=>typeof value==='string'?value.replace(/[\x00-\x1f\x7f]/gu,' ').slice(0,max):'';
const timestamp=value=>Number.isFinite(value)&&value>0;
const count=value=>Number.isSafeInteger(value)&&value>=0;
const owns=(row,key)=>Object.hasOwn(row,key);

export function normalizeRunStatus(history,{context,observedAt}={}) {
  if(!timestamp(observedAt))throw new TypeError('An explicit observation clock is required.');
  const result={state:'unknown',context:{key:context?.key,agentId:context?.agentId,sessionId:context?.sessionId},
    observedAt,freshUntil:observedAt+RUN_FRESH_MS,usageUnavailable:true,detail:'Current response status is unavailable.'};
  if(!object(history)||!['key','agentId','sessionId'].every(key=>id(context?.[key])))return result;
  if(history.sessionId!==context.sessionId||history.windowReset||history.sessionKey!==undefined&&history.sessionKey!==context.key)return result;
  const info=object(history.sessionInfo)?history.sessionInfo:{};
  if(info.sessionId!==undefined&&info.sessionId!==context.sessionId||info.key!==undefined&&info.key!==context.key||
      info.agentId!==undefined&&info.agentId!==context.agentId)return result;
  if(id(info.lifecycleRevision))result.lifecycleRevision=info.lifecycleRevision;
  const exactPresent=owns(info,'activeRunIds'),exact=info.activeRunIds;
  if(exactPresent&&(!Array.isArray(exact)||exact.some(value=>!id(value))))return result;
  if(typeof info.hasActiveRun!=='boolean')return result;
  if(exactPresent&&info.hasActiveRun!==(exact.length>0))return {...result,detail:'Current response sources disagree.'};
  const run=history.inFlightRun;
  if(info.hasActiveRun===false) {
    if(run!=null)return {...result,detail:'A retained response conflicts with current idle telemetry.'};
    return {...result,state:'idle',detail:'No active direct response is reported.'};
  }
  if(run==null)return {...result,state:'active',...(exactPresent&&exact.length===1?{runId:exact[0]}:{}),
    detail:'OpenClaw reports an active response; run details are unavailable.'};
  if(!object(run)||!id(run.runId)||exactPresent&&!exact.includes(run.runId))return {...result,detail:'The visible response is not confirmed by current run identity.'};
  if(run.sessionId!==undefined&&run.sessionId!==context.sessionId||run.sessionKey!==undefined&&run.sessionKey!==context.key||
      run.agentId!==undefined&&run.agentId!==context.agentId)return result;
  result.state='active';result.runId=run.runId;result.detail='OpenClaw confirms an active response. Work type is separate.';
  if(timestamp(run.startedAt)&&run.startedAt<=observedAt)result.startedAt=run.startedAt;
  // These are bounded full snapshots, not a client event cache. Never carry usage or
  // an unfinished tool across occurrences, missing fields, or a new incarnation.
  const events=(Array.isArray(run.events)?run.events:[]).slice(-200).filter(event=>object(event)&&event.runId===run.runId&&
    Number.isSafeInteger(event.seq)&&event.seq>=0&&
    (event.sessionKey===undefined||event.sessionKey===context.key)&&
    (event.agentId===undefined||event.agentId===context.agentId)&&
    (event.sessionId===undefined||event.sessionId===context.sessionId)).sort((a,b)=>a.seq-b.seq);
  const tools=new Map();let lastSequence=-1,usage;
  for(const event of events) {
    if(event.seq<=lastSequence)continue;
    lastSequence=event.seq;
    const data=object(event.data)?event.data:{};
    if(event.stream==='lifecycle'&&['end','error','aborted'].includes(data.phase))return {...result,state:'unknown',detail:'This response ended; current execution needs another observation.'};
    if(event.stream==='usage')usage=data;
    if(!['tool','item'].includes(event.stream)||data.unpairedCall===true)continue;
    const toolId=data.toolCallId||data.itemId;
    if(!id(toolId))continue;
    const previous=tools.get(toolId)||{name:'',title:'',active:false,seq:0};
    const current={...previous,name:label(data.name,120)||previous.name,title:label(data.title,200)||previous.title,seq:event.seq};
    if(data.phase==='start'||data.status==='running'&&data.phase!=='end')current.active=true;
    if(['result','end'].includes(data.phase)||['completed','failed','blocked','skipped','cancelled'].includes(data.status))current.active=false;
    tools.set(toolId,current);
  }
  if(usage?.usageReport?.state!=='unavailable'&&count(usage?.outputTokens)) {
    result.outputTokens=usage.outputTokens;result.usageUnavailable=false;
  }
  const current=[...tools.values()].filter(tool=>tool.active).sort((a,b)=>b.seq-a.seq)[0];
  if(current)result.tool={name:current.name,title:current.title||current.name||'Tool execution',status:'running'};
  return result;
}

export function viewRunStatus(status,now,connected=true) {
  if(!status)return null;
  if(!timestamp(now))throw new TypeError('An explicit presentation clock is required.');
  const stale=!connected||!timestamp(status.observedAt)||!timestamp(status.freshUntil)||now>status.freshUntil||status.observedAt>now;
  const active=!stale&&status.state==='active';
  const end=stale?Math.min(now,status.observedAt):now;
  const elapsedMs=timestamp(status.startedAt)&&timestamp(end)&&status.startedAt<=end?end-status.startedAt:undefined;
  return {...status,stale,active,...(elapsedMs!==undefined?{elapsedMs}:{}),
    ...(stale?{lastKnownState:status.state,state:'unknown',detail:connected?'Response status is stale; the last observation is unverified.':'Disconnected; showing the last observed response.'}:{})};
}

// An exact cancellation target is separate from engineering activity or progress.
// A locally owned started receipt bridges only the short gap before fresh telemetry.
export function stoppableRunId({context,status,submission,now,connected=true}={}) {
  if(!timestamp(now))throw new TypeError('An explicit presentation clock is required.');
  const fields=['key','agentId','sessionId'];
  if(!connected||!fields.every(key=>id(context?.[key])))return null;
  const sameContext=value=>object(value)&&fields.every(key=>value[key]===context[key]);
  const observed=object(status)&&sameContext(status.context)&&timestamp(status.observedAt)?status:null;
  const current=observed?viewRunStatus(observed,now,connected):null;
  // An explicitly stale snapshot cannot revive a receipt after telemetry loss.
  if(observed?.stale===true||current?.stale)return null;
  const local=object(submission)&&sameContext(submission.selected)&&submission.status==='accepted'&&
    submission.stopReceiptSuperseded!==true&&
    timestamp(submission.acceptedAt)&&submission.acceptedAt<=now&&now-submission.acceptedAt<=RUN_FRESH_MS&&
    ['started','in_flight'].includes(submission.receipt?.status)&&id(submission.receipt?.runId);
  if(local&&(!observed||submission.acceptedAt>observed.observedAt))return submission.receipt.runId;
  if(!observed||observed.stale===true||observed.active===false||!id(observed.runId))return null;
  return current.active?observed.runId:null;
}
