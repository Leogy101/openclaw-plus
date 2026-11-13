// Portable observation reducer. No filesystem, network, Electron, DOM or implicit clock.
// A future client supplies the same read snapshots; this module owns no execution state.
export const FRESH_MS = 45000;
const list = value => Array.isArray(value) ? value : [];
const text = (value, max = 600) => typeof value === 'string' ? value.slice(0, max) : '';
const time = value => Number.isFinite(value) && value > 0 ? value : undefined;
const key = row => row?.key || row?.sessionKey;
const identity = row => JSON.stringify([row?.agentId, key(row), row?.sessionId]);
const activityConflict = row => typeof row.hasActiveRun==='boolean'&&(Array.isArray(row.activeRunIds)?row.hasActiveRun!==(row.activeRunIds.length>0):row.activeRunIds===undefined&&row.hasActiveRun===false&&list(row.observedRunIds).length>0);
// Observed in-flight IDs are positive evidence only when the native active set is absent.
const activeIds = row => list(row.activeRunIds===undefined?row.observedRunIds:row.activeRunIds).filter(id=>typeof id==='string'&&id.trim()&&!/[\x00-\x1f\x7f]/.test(id));
const exactIdentity = row => [row?.agentId,key(row),row?.sessionId].every(id=>typeof id==='string'&&id.trim()&&!/[\x00-\x1f\x7f]/.test(id));
// Full OpenClaw rows omit a false subagent aggregate when no subagent record exists.
// Partial projections and sentinel rows can omit it for other reasons.
const subagentsQuiet = row => row.hasActiveSubagentRun===false || row.hasActiveSubagentRun===undefined&&
  row.rowMode===undefined&&typeof key(row)==='string'&&key(row).length>0&&!['global','unknown'].includes(key(row))&&
  row.hasActiveRun===false&&Array.isArray(row.activeRunIds)&&row.activeRunIds.length===0;
const terminal = status => ['succeeded','failed','cancelled','timed_out','completed','killed'].includes(status);
const substantive = category => category === 'engineering' || category === 'research';
const latest = events => [...events].filter(e => time(e.timestamp)).sort((a,b) => b.timestamp-a.timestamp)[0] || null;

// Only exact tool identities or complete, conservative command forms classify work.
// In particular, process names, summaries, progress percentages and prose never do.
export function classifyTool(name, args) {
  if (['progress_card','progressCard.put','progressCard.clear'].includes(name)) return {classification:'status', title:'Status card update'};
  if (['web_search','web_fetch'].includes(name)) return {classification:'research', title:'Research tool invocation'};
  const codePath = path => typeof path==='string' && path.length<2048 && /\.(?:[cm]?[jt]sx?|py|swift|go|rs|[ch](?:pp)?|sh)$/.test(path);
  if (['edit','write'].includes(name) && codePath(args?.file_path || args?.path)) return {classification:'engineering',title:'Source edit invocation'};
  if(name==='apply_patch') {
    const patch=args?.patch || args?.input;
    if(typeof patch==='string'&&patch.length<=65536&&patch.trim().endsWith('*** End Patch')) {
      const paths=[...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(m=>m[1]);
      if(paths.length&&paths.every(codePath))return {classification:'engineering',title:'Source patch invocation'};
    }
  }
  if (!['exec','bash','shell'].includes(name) || typeof args?.command !== 'string') return {classification:'unknown',title:'Tool invocation'};
  const command = args.command.trim();
  if (!command || command.length > 4096 || /[\n\r;&|`$<>\\]/.test(command)) return {classification:'unknown',title:'Command invocation'};
  const parts = command.split(/\s+/);
  if(parts.some(p=>['--help','-h','--version'].includes(p)))return {classification:'unknown',title:'Command invocation'};
  const executable = parts[0].split('/').at(-1);
  const p = parts.slice(1);
  const test = executable === 'pytest' || /^python[\d.]*$/.test(executable) && p[0] === '-m' && p[1] === 'pytest'
    || executable === 'node' && p[0] === '--test'
    || ['cargo','go','swift'].includes(executable) && p[0] === 'test'
    || executable === 'ctest';
  const build = ['cargo','go','swift'].includes(executable) && p[0] === 'build'
    || executable === 'cmake' && p[0] === '--build';
  // npm/pnpm scripts are arbitrary user code, not proof of the script's purpose.
  if (test || build) return {classification:'engineering',title:test?'Test command invocation':'Build command invocation'};
  return {classification:'unknown',title:'Command invocation'};
}

export function mergeTimeline(previous = [], incoming = []) {
  const events = new Map();
  for (const item of [...list(previous), ...list(incoming)]) {
    if (!item?.id) continue;
    const old = events.get(item.id);
    const sameReceipt=old&&old.agentId===item.agentId&&old.sessionKey===item.sessionKey&&old.sessionId===item.sessionId&&old.runId===item.runId&&old.toolCallId===item.toolCallId&&old.phase===item.phase;
    // Preserve an observed command classification for the same immutable receipt.
    const preserve = sameReceipt && substantive(old.classification) && item.classification === 'unknown';
    const merged=preserve?{...item,classification:old.classification,description:old.description}:{...item};
    // A later metadata-only reread cannot erase the observed command outcome.
    if(sameReceipt&&item.id.startsWith('audit:')&&item.phase==='end'&&old.outcome&&old.outcome!=='succeeded'&&item.outcome==='succeeded')Object.assign(merged,{outcome:old.outcome,result:old.result,source:old.source,type:old.type});
    events.set(item.id,merged);
  }
  // A durable receipt replaces the same transient tool phase in every consumer,
  // including renderer merges of retained pages with a refreshed server snapshot.
  const phaseKey=item=>{
    const values=[item.agentId,item.sessionKey,item.sessionId,item.runId,item.toolCallId,item.phase];
    return ['start','end'].includes(item.phase)&&values.every(value=>typeof value==='string'&&value.trim()&&!/[\x00-\x1f\x7f]/.test(value))?JSON.stringify(values):null;
  };
  const durable=new Set([...events.values()].filter(item=>typeof item.id==='string'&&item.id.startsWith('audit:')).map(phaseKey).filter(Boolean));
  return [...events.values()].filter(item=>!(typeof item.id==='string'&&item.id.startsWith('tool:')&&durable.has(phaseKey(item))))
    .sort((a,b) => (time(b.timestamp) || 0)-(time(a.timestamp) || 0) || a.id.localeCompare(b.id)).slice(0,500);
}

function liveTools(snapshot, sessions) {
  const tools = new Map();
  for (const event of [...list(snapshot.liveEvents)].sort((a,b)=>(a.seq||0)-(b.seq||0))) {
    const row = sessions.find(s=>key(s)===event.sessionKey && s.agentId===event.agentId && s.sessionId===event.sessionId);
    if (!row || row.hasActiveRun !== true || !activeIds(row).includes(event.runId)) continue;
    const d=event.data || {};
    const id=d.toolCallId || (event.stream==='item' ? d.itemId : undefined);
    if (!id || !['tool','item'].includes(event.stream) || d.unpairedCall === true) continue;
    const mapKey=JSON.stringify([row.agentId,row.sessionId,event.runId,id]);
    const prior=tools.get(mapKey) || {id:mapKey,agentId:row.agentId,sessionKey:key(row),sessionId:row.sessionId,runId:event.runId,toolCallId:id,classification:'unknown',title:'Tool invocation'};
    const item={...prior,name:text(d.name || prior.name,120),observedAt:snapshot.observedAt,lastSeq:event.seq};
    if (event.stream==='tool') {
      if (d.phase==='start') {
        Object.assign(item,classifyTool(item.name,d.args));item.startedAt=time(event.ts);item.active=true;
      } else if (d.phase==='result' || d.phase==='end') {
        item.active=false;item.endedAt=time(event.ts);item.outcome=d.isError===true?'failed':d.isError===false?'succeeded':'unknown';
        delete item.blocker;
        const details=d.result?.details;
        if(details?.status==='running')item.outcome='background_running';
        if(details?.status==='failed'||Number.isInteger(details?.exitCode)&&details.exitCode!==0)item.outcome='failed';
        if(['approval-pending','approval-unavailable','skipped'].includes(details?.status)) {
          item.outcome='blocked';item.approvalId=text(details.approvalId,512);
          item.blocker={kind:details.status==='approval-unavailable'?'technical':'recorded',reason:details.status==='approval-unavailable'?'No interactive approval route is available. Authorization alone does not supply the missing route.':details.status==='approval-pending'?'Execution reached an approval boundary; current approval state needs verification.':'The runtime skipped this tool action.',source:'Runtime tool result',at:time(event.ts)};
        }
      }
    } else {
      if (!prior.name) Object.assign(item,classifyTool(item.name));
      if (d.status==='running' && d.phase!=='end') item.active=true;
      if (['completed','failed','blocked','skipped'].includes(d.status) || d.phase==='end') {
        item.active=false;item.outcome=d.status==='completed'?item.outcome || 'succeeded':d.status || item.outcome || 'unknown';
      }
      item.startedAt=time(d.startedAt) || item.startedAt;
      item.endedAt=time(d.endedAt) || item.endedAt;
      if(d.approvalId)item.approvalId=text(d.approvalId,512);
      if(d.status==='blocked'&&!item.blocker) item.blocker={kind:'recorded',reason:d.approvalId?'Execution is waiting at an approval boundary; current approval state needs verification.':'The runtime recorded a blocked tool action.',source:'Current runtime item',at:time(d.endedAt)||time(event.ts)};
    }
    tools.set(mapKey,item);
  }
  return [...tools.values()];
}

function relatedRows(rows,seeds) {
  const scope=new Set(seeds.map(identity)), keys=new Set(seeds.map(key));
  for(let round=0;round<rows.length;round++) {
    let added=false;
    for(const row of rows) {
      const parent=row.parentSessionKey || row.spawnedBy || row.controlOwnerSessionKey || row.parentKey;
      const parents=rows.filter(candidate=>scope.has(identity(candidate))&&(key(candidate)===parent||list(row.childOwnerSessionKeys).includes(key(candidate))));
      if(row.parentSessionId&&parents.some(candidate=>candidate.sessionId===row.parentSessionId)&&!scope.has(identity(row))){scope.add(identity(row));keys.add(key(row));added=true;}
    }
    if(!added)break;
  }
  return rows.filter(row=>scope.has(identity(row)));
}
const scopeSessions = snapshot => relatedRows(list(snapshot.sessions),[snapshot.context || {}]);

function auditEvents(snapshot, tools) {
  const events=[];
  for(const row of list(snapshot.audit?.events)) {
    if(row.schemaVersion!==1 || !row.eventId || row.redaction!=='metadata_only')continue;
    if(!['agent_run','tool_action','inbound_message','outbound_message'].includes(row.eventType))continue;
    const tool=tools.find(t=>t.runId===row.runId&&t.agentId===row.agentId&&t.sessionId===row.sessionId&&t.toolCallId===row.toolCallId);
    const cls=row.eventType==='tool_action' ? tool || classifyTool(row.toolName) : {classification:'unknown'};
    // A successful tool invocation can still return a failed or running command.
    const outcome=row.status==='succeeded'&&tool?.outcome?tool.outcome:row.status;
    const base={id:'audit:'+row.eventId,timestamp:time(row.occurredAt),agentId:text(row.agentId,200),sessionKey:row.sessionKey,sessionId:row.sessionId,runId:row.runId,toolCallId:row.toolCallId,classification:cls.classification,source:outcome===row.status?'OpenClaw audit receipt':'OpenClaw audit receipt + observed tool result',phase:row.status==='started'?'start':'end',outcome,result:text(row.errorCode || outcome,120)};
    if(row.eventType==='agent_run') {
      base.type=row.status==='started'?'run_started':row.status==='succeeded'?'run_completed':row.status==='cancelled'?'run_stopped':'run_finished';
      base.description=row.status==='started'?'Agent turn started; work type unverified':row.status==='succeeded'?'Agent turn completed; project completion not established':`Agent turn ${row.status}`;
    } else if(row.eventType==='tool_action') {
      base.type=cls.classification==='status'?'status_report':row.status==='started'?'tool_started':'tool_completed';
      base.description=`${cls.title || 'Tool invocation'} · ${text(row.toolName,100) || 'unnamed tool'} · ${outcome}`;
      if(outcome==='blocked')base.type='tool_blocked';
      if(outcome==='failed')base.type='task_failed';
    } else {
      base.type='message';base.description=row.eventType==='inbound_message'?'Message processing receipt':'Message delivery receipt';
    }
    events.push(base);
  }
  return events;
}

function observedEvents(snapshot,tools) {
  const result=[];
  for(const tool of tools) {
    for(const end of [false,true]) {
      if(end&&!tool.outcome)continue;
      // A canonical audit event wins when it records the same tool phase.
      if(list(snapshot.audit?.events).some(e=>e.eventType==='tool_action'&&e.runId===tool.runId&&e.agentId===tool.agentId&&e.sessionId===tool.sessionId&&e.toolCallId===tool.toolCallId&&(end?e.status!=='started':e.status==='started')))continue;
      result.push({id:`tool:${tool.id}:${end?'end':'start'}`,timestamp:end?tool.endedAt:tool.startedAt,type:tool.classification==='status'?'status_report':end?'tool_completed':'tool_started',agentId:tool.agentId,sessionKey:tool.sessionKey,sessionId:tool.sessionId,runId:tool.runId,toolCallId:tool.toolCallId,classification:tool.classification,description:tool.title,phase:end?'end':'start',outcome:end?tool.outcome:'started',result:end?tool.outcome:'Started',source:'Observed runtime tool lifecycle'});
    }
  }
  for(const process of list(snapshot.processes)) {
    if(!process.instanceId||!process.processId)continue;
    for(const end of [false,true]) {
      if(end&&!terminal(process.status))continue;
      result.push({id:`process:${process.agentId}:${process.sessionId}:${process.processId}:${process.instanceId}:${end?'end':'start'}`,timestamp:time(end?process.endedAt:process.startedAt),type:end?'process_completed':'process_started',agentId:process.agentId,sessionKey:process.sessionKey,sessionId:process.sessionId,classification:'unknown',description:end?'Background command finished; work type unverified':'Background command started; work type unverified',outcome:end?process.status:'started',result:end?`${process.status}${Number.isInteger(process.exitCode)?' · exit '+process.exitCode:''}`:undefined,source:'Session process lifecycle'});
    }
  }
  for(const row of list(snapshot.sessions)) {
    const goal=row.goal;
    if(!goal?.id||goal.schemaVersion!==1)continue;
    const status=goal.status, timestamp=time(status==='blocked'?goal.blockedAt:status==='paused'?goal.pausedAt:status==='complete'?goal.completedAt:undefined);
    if(['blocked','paused','complete'].includes(status))result.push({id:`goal:${row.agentId}:${row.sessionId}:${goal.id}:${status}:${timestamp||'unknown'}`,timestamp,type:status==='blocked'?'blocker_recorded':status==='paused'?'explicit_pause':'goal_completed',agentId:row.agentId,sessionKey:key(row),sessionId:row.sessionId,classification:'unknown',description:`Goal ${status} recorded`,result:text(goal.lastStatusNote)||undefined,source:'Reported session goal; not acceptance evidence'});
  }
  for(const card of list(snapshot.cards)) {
    result.push({id:`card:${card.agentId}:${card.sessionId}:${card.revision}`,timestamp:time(card.updatedAt),type:'status_report',agentId:card.agentId,sessionKey:card.sessionKey,sessionId:card.sessionId,classification:'status',description:'Published status card updated',result:'Reported plan; no execution or accepted progress implied',source:'Published progress card'});
  }
  for(const run of list(snapshot.occurrences)) {
    const occurrence=run.runId || (time(run.runAtMs)?'at:'+run.runAtMs:undefined);
    if(!run.jobId||!occurrence)continue;
    result.push({id:`cron:${run.jobId}:${occurrence}`,timestamp:time(run.ts),type:'automation_executed',agentId:run.agentId||list(snapshot.jobs).find(j=>j.id===run.jobId)?.agentId,sessionKey:run.sessionKey,sessionId:run.sessionId,runId:run.runId,classification:'unknown',description:'Automation occurrence finished; engineering not established',result:`Execution ${text(run.status,60)||'unknown'} · delivery/completion ${text(run.completionStatus,60)||'unknown'}`,source:'Automation occurrence receipt'});
  }
  return result;
}

function sameScope(event,rows) {
  // No title matching, logical-key-only reset attribution, or invented message ownership.
  return rows.some(row=>event.agentId===row.agentId&&event.sessionKey===key(row)&&event.sessionId===row.sessionId);
}
function boundJob(job,row) {
  const agent=job.effectiveAgentId || job.agentId;
  if(agent!==row.agentId)return false;
  const target=job.sessionTarget;
  const targetKey=target==='main'?`agent:${agent}:main`:
    ['isolated','current'].includes(target)?`agent:${agent}:cron:${job.id}`:
    typeof target==='string'&&target.startsWith('session:')?target.slice(8):undefined;
  // owner is creator authority, not the execution/delivery session binding.
  return [targetKey,job.sessionKey,job.sourceConversation?.sessionKey].includes(key(row));
}
function summaryFor(snapshot,rows,agentId,tools,events,now,{selected=false}={}) {
  const current=tools.filter(t=>t.active&&rows.some(r=>identity(r)===identity(t)));
  const confirmed=current.filter(t=>substantive(t.classification));
  const activeRows=rows.filter(row=>exactIdentity(row)&&row.hasActiveRun===true&&activeIds(row).length>0&&!activityConflict(row));
  const activeProcesses=list(snapshot.processes).filter(process=>process.status==='running'&&process.processId&&process.instanceId&&exactIdentity(process)&&rows.some(row=>identity(row)===identity(process)));
  const executionActive=activeRows.length>0||activeProcesses.length>0;
  const ownExecutionActive=[...activeRows,...activeProcesses].some(row=>row.agentId===agentId),teamExecutionActive=[...activeRows,...activeProcesses].some(row=>row.agentId!==agentId);
  for(const row of activeRows)for(const runId of activeIds(row).slice(0,20)) {
    if(current.some(t=>identity(t)===identity(row)&&t.runId===runId))continue;
    const start=latest(events.filter(e=>e.type==='run_started'&&e.runId===runId&&sameScope(e,[row])));
    current.push({id:`run:${identity(row)}:${runId}`,agentId:row.agentId,sessionKey:key(row),sessionId:row.sessionId,runId,title:'Active agent turn · purpose unverified',classification:'unknown',startedAt:start?.timestamp});
  }
  for(const process of activeProcesses)current.push({id:`process:${process.processId}:${process.instanceId}`,agentId:process.agentId,sessionKey:process.sessionKey,sessionId:process.sessionId,title:'Background command · purpose unverified',classification:'unknown',startedAt:time(process.startedAt)});
  const unknownExecution=rows.some(r=>r.hasActiveRun===true||r.hasActiveSubagentRun===true)&&!confirmed.length || list(snapshot.processes).some(p=>p.status==='running'&&rows.some(r=>identity(r)===identity(p)));
  const ownWorking=confirmed.some(t=>t.agentId===agentId),teamWorking=confirmed.some(t=>t.agentId!==agentId);
  const blockers=[];
  for(const row of rows) {
    if(row.goal?.status==='blocked')blockers.push({kind:'recorded',reason:text(row.goal.lastStatusNote)||'A blocker is recorded on this session goal; no cause was supplied.',source:'Reported session goal',at:time(row.goal.blockedAt),agentId:row.agentId});
  }
  for(const tool of tools.filter(t=>t.blocker&&rows.some(r=>identity(r)===identity(t)))) {
    const approval=list(snapshot.approvals).find(a=>a.id===tool.approvalId);
    if(!approval)blockers.push({...tool.blocker,agentId:tool.agentId});
  }
  for(const approval of list(snapshot.approvals)) {
    if(approval.status==='pending'&&approval.agentId&&approval.sessionKey&&rows.some(r=>r.agentId===approval.agentId&&key(r)===approval.sessionKey&&(approval.sessionId===r.sessionId||list(r.activeRunIds).includes(approval.runId)))&&(!approval.expiresAt||approval.expiresAt>now))blockers.push({kind:'authorization',reason:'A current OpenClaw approval is pending for this execution.',source:'Pending approval',at:time(approval.createdAt),agentId:approval.agentId,nextStep:'Review the existing request in Approvals.'});
  }
  const jobs=list(snapshot.jobs).filter(j=>rows.some(r=>boundJob(j,r)));
  const next=jobs.filter(j=>j.enabled===true&&time(j.state?.nextRunAtMs??j.nextRunAtMs)&& (j.state?.nextRunAtMs??j.nextRunAtMs)>now).sort((a,b)=>(a.state?.nextRunAtMs??a.nextRunAtMs)-(b.state?.nextRunAtMs??b.nextRunAtMs))[0];
  const nextScheduled=next?{at:next.state?.nextRunAtMs??next.nextRunAtMs,jobId:next.id,name:text(next.name)}:null;
  const disabledSchedules=jobs.length>0&&jobs.every(job=>job.enabled===false);
  const scoped=events.filter(e=>sameScope(e,rows));
  const lastEngineering=latest(scoped.filter(e=>e.classification==='engineering'&&e.type!=='status_report'));
  const lastCompleted=latest(scoped.filter(e=>['run_completed','tool_completed','process_completed'].includes(e.type)&&['succeeded','completed'].includes(e.outcome)));
  const lastTerminal=latest(scoped.filter(e=>['run_completed','run_finished','run_stopped','tool_completed','task_failed','tool_blocked','process_completed'].includes(e.type)&&e.phase!=='start'));
  const lastStatus=latest(scoped.filter(e=>e.classification==='status'&&(!e.outcome||e.outcome==='succeeded')));
  const paused=rows.some(r=>['paused','usage_limited','budget_limited'].includes(r.goal?.status));
  const goalActive=rows.some(r=>r.goal?.schemaVersion===1&&r.goal.id&&r.goal.status==='active');
  const conflicting=rows.some(activityConflict);
  const coverage=selected&&snapshot.coverage?.session===true&&snapshot.coverage?.children===true&&snapshot.coverage?.processes===true;
  const provenQuiet=coverage&&!conflicting&&rows.length>0&&rows.every(r=>r.hasActiveRun===false&&subagentsQuiet(r))&&!list(snapshot.processes).some(p=>p.status==='running'&&rows.some(r=>identity(r)===identity(p)));
  let state='unknown',label='UNKNOWN',detail='Available evidence cannot establish current substantive work.';
  if(!selected)detail='This snapshot does not cover every session and background process for this agent.';
  else if(snapshot.coverage?.session!==true||!rows.length)detail='Current evidence for the selected session is unavailable.';
  else if(snapshot.coverage?.children!==true)detail='Related-session coverage is incomplete; current execution could not be verified.';
  else if(snapshot.coverage?.processes!==true)detail='Background-process coverage is incomplete; current execution could not be verified.';
  else if(rows.some(r=>typeof r.hasActiveRun!=='boolean'))detail='OpenClaw did not provide a current direct-run flag for this session.';
  else if(rows.some(r=>!subagentsQuiet(r)))detail='Current descendant activity could not be established from the returned session projection.';
  if(blockers.length){state='blocked';label='BLOCKED';detail=confirmed.length?'Independent substantive work remains active.':'NO CONFIRMED ACTIVE ENGINEERING';}
  else if(confirmed.length){state='working';label='WORKING';detail=teamWorking&&!ownWorking?'A delegated agent is doing confirmed substantive work.':'Confirmed substantive tool execution.';}
  else if(conflicting){detail='Activity sources disagree; current execution could not be verified.';}
  else if(executionActive){state='active';label='ACTIVE';detail=current.length&&current.every(item=>item.classification==='status')?'A status update is running. Reporting does not establish engineering progress.':teamExecutionActive&&!ownExecutionActive?'A physically linked delegate is active. Its current work type has not been classified.':'OpenClaw confirms active execution. Its current work type has not been classified.';}
  else if(unknownExecution){detail=paused?'The goal is paused, but execution is still active; substantive work is unverified.':current.some(t=>t.classification==='status')?'A status update tool is active; substantive engineering is unverified.':'Execution is active, but current tool evidence cannot establish its purpose.';}
  else if(paused){state='paused';label='PAUSED / STOPPED';detail='An explicit goal pause or limit is recorded; scheduled work is separate.';}
  else if(provenQuiet&&disabledSchedules){state='paused';label='PAUSED / STOPPED';detail='The bound automation schedule is disabled. This does not establish a project-wide pause or stop independent work.';}
  else if(provenQuiet&&['cancelled','killed'].includes(lastTerminal?.outcome)){state='paused';label='PAUSED / STOPPED';detail='The last observed execution was stopped. A project-wide pause is not implied.';}
  else if(provenQuiet&&lastTerminal&&!['succeeded','completed'].includes(lastTerminal.outcome)){detail=`The latest observed execution ended with ${lastTerminal.outcome||'an unverified outcome'}. Whether required work can advance is unverified.`;}
  else if(provenQuiet&&nextScheduled){state='scheduled';label='SCHEDULED / IDLE';detail='No confirmed execution in this conversation scope. A future automation is scheduled.';}
  else if(provenQuiet&&goalActive){detail='The recorded goal remains active; its next execution could not be verified.';}
  else if(provenQuiet&&lastCompleted){state='completed';label='COMPLETED';detail='Last observed execution finished. Overall project completion is not established.';}
  else if(provenQuiet){state='scheduled';label='SCHEDULED / IDLE';detail='No current execution reported in this bounded conversation scope. No next run is available.';}
  return {agentId,state,label,detail,working:confirmed.length>0,teamWorking,ownWorking,executionActive,ownExecutionActive,teamExecutionActive,current:current.slice(0,30),blockers,recordedPause:paused,lastEngineering,lastCompleted,lastStatus,nextScheduled,recovery:'Unverified',scope:selected?'Selected conversation and physically bound descendants':'Observed agent sessions'};
}

export function viewAtTime(view, now, connected=true) {
  if(!view)return null;
  const stale=!connected||!time(view.freshUntil)||now>view.freshUntil;
  const qualify=summary=>!summary?summary:stale?{...summary,lastKnownState:summary.state,state:'unknown',label:connected?'UNKNOWN · STALE':'UNKNOWN / DISCONNECTED',detail:`Current execution is unverified. Last observation: ${summary.label}.`,working:false,ownWorking:false,teamWorking:false,executionActive:false,ownExecutionActive:false,teamExecutionActive:false,current:list(summary.current).map(c=>({...c,unverified:true}))}:{...summary};
  return {...view,stale,summary:qualify(view.summary),agents:list(view.agents).map(qualify)};
}

export function buildActivity(snapshot,{now,previous}={}) {
  if(!Number.isFinite(now))throw new TypeError('An explicit observation clock is required.');
  const context=snapshot.context || {}, sessions=list(snapshot.sessions), rows=scopeSessions(snapshot), tools=liveTools(snapshot,sessions);
  const sameContext=previous&&identity(previous.context)===identity(context);
  const prior=sameContext?list(previous.timeline?.items):[];
  const observed=observedEvents(snapshot,tools);
  const audited=auditEvents(snapshot,tools).map(event=>{
    if(!event.toolCallId)return event;
    const matching=[...prior,...observed].find(e=>e.id.startsWith('tool:')&&e.agentId===event.agentId&&e.sessionKey===event.sessionKey&&e.sessionId===event.sessionId&&e.runId===event.runId&&e.toolCallId===event.toolCallId&&e.phase===event.phase);
    if(!matching)return event;
    const outcome=event.outcome==='succeeded'&&event.phase==='end'&&matching.outcome?matching.outcome:event.outcome;
    const enriched=event.classification==='unknown'&&substantive(matching.classification);
    return {...event,...(enriched?{classification:matching.classification,description:`${matching.description} · ${outcome}`} : {}),
      ...(outcome!==event.outcome?{outcome,result:outcome,source:'OpenClaw audit receipt + observed tool result',...(outcome==='failed'?{type:'task_failed'}:outcome==='blocked'?{type:'tool_blocked'}:{})}:{})};
  });
  const incoming=[...audited,...observed];
  const displayEvents=incoming.flatMap(event=>sameScope(event,rows)?[event]:
    !event.sessionId&&rows.some(row=>event.agentId===row.agentId&&event.sessionKey===key(row))?
      [{...event,classification:'unknown',source:event.source+' · session incarnation unverified'}]:[]);
  const events=mergeTimeline(sameContext?previous.timeline?.items:[],displayEvents);
  const summary=summaryFor(snapshot,rows,context.agentId,tools,events,now,{selected:true});
  const agents=list(snapshot.agents).map(agent=>({...summaryFor(snapshot,relatedRows(sessions,sessions.filter(s=>s.agentId===agent.id)),agent.id,tools,incoming,now),name:agent.name}));
  const observedAt=time(snapshot.observedAt);
  const freshUntil=Math.min(time(snapshot.freshUntil)||observedAt+FRESH_MS,observedAt+FRESH_MS);
  const unbound=sessions.some(row=>!row.parentSessionId&&(row.parentSessionKey===context.key||row.spawnedBy===context.key||list(row.childOwnerSessionKeys).includes(context.key)));
  return viewAtTime({context:{...context},observedAt,freshUntil,summary,agents,timeline:{items:events,nextCursor:snapshot.audit?.nextCursor},project:snapshot.project,runStatus:snapshot.runStatus,limitations:[...list(snapshot.limitations),...(unbound?['Related sessions lack a physical parent identity. Their own activity may be known, but current delegation to this conversation is unverified.']:[]),'Engineering classification requires current tool evidence. Generic runs, commands, reports and schedules are not engineering progress.','Audit retention is bounded and best effort; missing records do not prove no work. Project acceptance and recovery status are not established by successful execution.']},now);
}
