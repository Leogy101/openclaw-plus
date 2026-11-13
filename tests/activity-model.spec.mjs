import test from 'node:test';
import assert from 'node:assert/strict';
import {buildActivity,viewAtTime,classifyTool,mergeTimeline} from '../desktop/shared/activity-model.mjs';

const now=1800000000000;
const coordinator={key:'agent:main:work',agentId:'main',sessionId:'coordinator-1',hasActiveRun:false,hasActiveSubagentRun:false,activeRunIds:[]};
const builder={key:'agent:builder:child',agentId:'builder',sessionId:'builder-1',parentSessionKey:coordinator.key,parentSessionId:coordinator.sessionId,hasActiveRun:true,hasActiveSubagentRun:false,activeRunIds:['run-builder']};
const base=()=>({context:{key:coordinator.key,agentId:coordinator.agentId,sessionId:coordinator.sessionId},observedAt:now,freshUntil:now+45000,agents:[{id:'main',name:'Coordinator'},{id:'builder',name:'Builder'}],sessions:[{...coordinator}],processes:[],liveEvents:[],audit:{events:[],available:true},cards:[],jobs:[],occurrences:[],coverage:{session:true,children:true,processes:true,audit:true,activeSessions:true,automations:true},limitations:[]});
const tool=(row=coordinator,extra={})=>({sessionKey:row.key,sessionId:row.sessionId,agentId:row.agentId,runId:row.activeRunIds[0]||'run-coordinator',seq:1,ts:now-1000,stream:'tool',data:{phase:'start',name:'edit',toolCallId:'tool-1',args:{path:'/fixture/main.ts'}},...extra});
const audit=(extra={})=>({schemaVersion:1,eventType:'agent_run',eventId:'a1',sequence:1,sourceSequence:1,occurredAt:now-2000,kind:'agent_run',action:'agent.run.finished',status:'succeeded',redaction:'metadata_only',agentId:'main',sessionKey:coordinator.key,sessionId:coordinator.sessionId,runId:'run-old',...extra});
const active=s=>{s.sessions[0]={...coordinator,hasActiveRun:true,activeRunIds:['run-coordinator']};s.liveEvents=[tool(s.sessions[0])];return s;};
const run=s=>buildActivity(s,{now});

test('1 Coordinator source implementation requires actual active exact tool evidence',()=>{
 const s=active(base()),v=run(s);assert.equal(v.summary.state,'working');assert.equal(v.summary.current[0].classification,'engineering');
 s.liveEvents[0].sessionId='old-incarnation';assert.equal(run(s).summary.state,'active');assert.equal(run(s).summary.working,false);assert.equal(run(s).summary.lastEngineering,null);
});
test('2 no active work plus an exact enabled future schedule is scheduled, not working',()=>{
 const s=base();s.jobs=[{id:'j',agentId:'main',sessionKey:coordinator.key,enabled:true,state:{nextRunAtMs:now+900000}}];
 const v=run(s);assert.equal(v.summary.state,'scheduled');assert.equal(v.summary.nextScheduled.at,now+900000);assert.equal(v.summary.working,false);
});
test('3 completion and a different current run coexist without completing the project',()=>{
 const s=active(base());s.audit.events=[audit()];const v=run(s);assert.equal(v.summary.state,'working');assert.equal(v.summary.lastCompleted.runId,'run-old');assert.match(v.summary.lastCompleted.description,/project completion not established/);
});
test('4 inactive Coordinator plus exact owned active child shows team work and executing agent',()=>{
 const s=base();s.sessions.push(builder);s.liveEvents=[tool(builder)];const v=run(s);assert.equal(v.summary.state,'working');assert.equal(v.summary.ownWorking,false);assert.equal(v.summary.teamWorking,true);assert.equal(v.summary.current[0].agentId,'builder');
});
test('5 scheduled status reporting cannot update last engineering or animate',()=>{
 const s=active(base());s.liveEvents=[tool(s.sessions[0],{data:{phase:'start',name:'progress_card',toolCallId:'report',args:{markdown:'12 fixture checks passed'}}})];
 s.cards=[{sessionKey:coordinator.key,sessionId:coordinator.sessionId,agentId:'main',revision:7,updatedAt:now-200,markdown:'60% complete'}];s.occurrences=[{jobId:'j',runId:'cron-1',agentId:'main',sessionKey:coordinator.key,sessionId:coordinator.sessionId,runAtMs:now-1000,ts:now,status:'ok',summary:'Engineering completed'}];
 const v=run(s);assert.equal(v.summary.working,false);assert.equal(v.summary.lastEngineering,null);assert.equal(v.summary.lastStatus.timestamp,now-200);assert.ok(v.timeline.items.some(e=>e.type==='automation_executed'&&e.classification==='unknown'));
});
test('6 technical blocker scenario stays blocked despite reporting schedule',()=>{
 const s=base();s.sessions[0].goal={schemaVersion:1,id:'g',status:'blocked',objective:'Fixture build integration',blockedAt:now-5000,lastStatusNote:'Required fixture build tool is unavailable. Integration remains unverified. Install the supported build tool before retrying.'};
 s.jobs=[{id:'dev',agentId:'main',sessionKey:coordinator.key,enabled:true,state:{nextRunAtMs:now+900000}}];s.cards=[{sessionKey:coordinator.key,sessionId:coordinator.sessionId,agentId:'main',revision:1,updatedAt:now-1000,markdown:'60% estimated; fixture milestone Alpha accepted; 12/12 fixture checks passed.'}];
 const v=run(s);assert.equal(v.summary.state,'blocked');assert.equal(v.summary.detail,'NO CONFIRMED ACTIVE ENGINEERING');assert.match(v.summary.blockers[0].reason,/build tool is unavailable/);assert.notEqual(v.summary.blockers[0].kind,'authorization');assert.equal(v.summary.lastEngineering,null);
});
test('7 actual current bound pending approval is distinct from a technical blocker',()=>{
 const s=base();s.approvals=[{status:'pending',agentId:'main',sessionKey:coordinator.key,sessionId:coordinator.sessionId,id:'approval-1',expiresAt:now+30000}];let v=run(s);assert.equal(v.summary.blockers[0].kind,'authorization');
 s.approvals[0].sessionId='old';assert.equal(run(s).summary.blockers.length,0);s.approvals[0].sessionId=coordinator.sessionId;s.approvals[0].status='resolved';assert.equal(run(s).summary.blockers.length,0);
});
test('8 explicit pause stays separate from inactivity and disabled schedule',()=>{
 const s=base();s.sessions[0].goal={schemaVersion:1,id:'g',status:'paused',pausedAt:now-3000};assert.equal(run(s).summary.state,'paused');
 delete s.sessions[0].goal;s.jobs=[{id:'j',enabled:false,agentId:'main',sessionKey:coordinator.key}];assert.equal(run(s).summary.state,'paused');assert.match(run(s).summary.detail,/schedule is disabled/);
 s.jobs=[];assert.notEqual(run(s).summary.state,'paused');
});
test('9 execution complete never means project complete or formal checkpoint acceptance',()=>{
 const s=base();s.audit.events=[audit()];const v=run(s);assert.equal(v.summary.state,'completed');assert.match(v.summary.detail,/project completion is not established/);assert.equal(v.summary.lastEngineering,null);
});
test('10 partial/unavailable/stale telemetry never becomes unqualified idle or Working',()=>{
 const s=base();s.coverage.session=false;s.sessions=[];assert.equal(run(s).summary.state,'unknown');
 const v=run(active(base()));assert.equal(viewAtTime(v,now+45001).summary.working,false);assert.equal(viewAtTime(v,now+45001).summary.state,'unknown');assert.equal(viewAtTime(v,now,false).summary.label,'UNKNOWN / DISCONNECTED');
});
test('11 duplicate completion receipts and matching runtime evidence collapse',()=>{
 const s=active(base());s.liveEvents.push(tool(s.sessions[0],{seq:2,ts:now-500,data:{phase:'result',name:'edit',toolCallId:'tool-1',isError:false}}));
 const receipt=audit({eventId:'finished-tool',eventType:'tool_action',kind:'tool_action',runId:'run-coordinator',toolCallId:'tool-1',toolName:'edit',occurredAt:now-500});s.audit.events=[receipt,receipt];
 const v=run(s);assert.equal(v.timeline.items.filter(e=>e.toolCallId==='tool-1'&&e.phase==='end').length,1);assert.equal(v.summary.lastEngineering.timestamp,now-500);assert.equal(v.summary.working,false);
});
test('12 new automation occurrence never inherits previous session completion',()=>{
 const s=base();s.audit.events=[audit()];s.context={...s.context,sessionId:'coordinator-2'};s.sessions=[{...coordinator,sessionId:'coordinator-2',hasActiveRun:true,activeRunIds:['new-occurrence']}];
 s.occurrences=[{jobId:'dev',runId:'old-occurrence',agentId:'main',sessionKey:coordinator.key,sessionId:'coordinator-1',ts:now-500,status:'ok'}];const v=run(s);assert.equal(v.summary.state,'active');assert.equal(v.summary.working,false);assert.equal(v.summary.lastCompleted,null);assert.equal(v.timeline.items.length,0);
});
test('blocker and independently active engineering remain visible together',()=>{
 const s=base();s.sessions[0].goal={schemaVersion:1,id:'g',status:'blocked',lastStatusNote:'Capability missing'};s.sessions.push(builder);s.liveEvents=[tool(builder)];const v=run(s);assert.equal(v.summary.state,'blocked');assert.equal(v.summary.teamWorking,true);assert.equal(v.summary.working,true);
});
test('tool names and status summaries cannot manufacture command purpose or success',()=>{
 for(const command of ['echo test passed','npm test','python script.py','pytest; echo report','node --test && echo done','pytest --help'])assert.equal(classifyTool('exec',{command}).classification,'unknown',command);
 assert.equal(classifyTool('exec',{command:'node --test tests/scope.test.js'}).classification,'engineering');assert.equal(classifyTool('exec',{command:'cargo build'}).classification,'engineering');
 assert.equal(classifyTool('edit',{path:'REPORT.md'}).classification,'unknown');assert.equal(classifyTool('web_search',{}).classification,'research');
});
test('unknown times stay unknown, failed commands are not successful completions',()=>{
 const s=base();s.audit.events=[audit({occurredAt:undefined,status:'failed',errorCode:'run_failed'})];const v=run(s);assert.equal(v.timeline.items[0].timestamp,undefined);assert.equal(v.summary.lastCompleted,null);
});
test('message suppression and historical denied tool events are not current engineering blockers',()=>{
 const s=base();s.audit.events=[audit({eventId:'tool-denied',eventType:'tool_action',status:'blocked',toolName:'exec'}),audit({eventId:'message',eventType:'outbound_message',kind:'message',status:'blocked',sessionKey:undefined,sessionId:undefined})];assert.equal(run(s).summary.blockers.length,0);assert.equal(run(s).timeline.items.some(e=>e.id==='audit:message'),false);
});
test('bounded immutable receipt enrichment survives metadata-only refresh, without reviving work',()=>{
 const s=active(base());s.audit.events=[audit({eventId:'tool-start',eventType:'tool_action',status:'started',toolCallId:'tool-1',toolName:'edit',runId:'run-coordinator'})];const previous=run(s);s.liveEvents=[];s.sessions=[{...coordinator}];const v=buildActivity(s,{now:now+15000,previous});assert.equal(v.summary.working,false);assert.equal(v.summary.lastEngineering.classification,'engineering');
 assert.equal(mergeTimeline([],Array.from({length:600},(_,i)=>({id:String(i),timestamp:i+1}))).length,500);
});
test('other active sessions are not overwritten by the selected quiet conversation',()=>{
 const s=base(),other={...coordinator,key:'agent:main:other',sessionId:'other',hasActiveRun:true,activeRunIds:['other-run']};s.sessions.push(other);s.liveEvents=[tool(other)];
 assert.equal(run(s).summary.working,false);assert.equal(run(s).agents.find(a=>a.agentId==='main').working,true);
});
test('pause is a goal fact, not proof that a continuing run stopped',()=>{
 const s=base();s.sessions[0]={...coordinator,hasActiveRun:true,activeRunIds:['r'],goal:{schemaVersion:1,id:'g',status:'paused'}};const v=run(s);assert.equal(v.summary.state,'active');assert.equal(v.summary.working,false);assert.equal(v.summary.recordedPause,true);
 s.sessions[0].hasActiveRun=false;s.sessions[0].hasActiveSubagentRun=true;assert.equal(run(s).summary.state,'unknown');
});
test('parallel work does not resolve an approval-bound blocked item',()=>{
 const s=active(base());s.liveEvents=[tool(s.sessions[0],{stream:'item',seq:1,data:{itemId:'blocked',toolCallId:'blocked',phase:'end',kind:'tool',status:'blocked',approvalId:'a'}}),tool(s.sessions[0],{seq:2})];
 const v=run(s);assert.equal(v.summary.state,'blocked');assert.equal(v.summary.working,true);
});
test('later durable receipt inherits exact observed tool purpose and supersedes transient completion',()=>{
 const s=active(base());s.liveEvents.push(tool(s.sessions[0],{seq:2,ts:now-500,data:{phase:'result',name:'edit',toolCallId:'tool-1',isError:false}}));const previous=run(s);
 s.sessions=[{...coordinator}];s.liveEvents=[];s.audit.events=[audit({eventId:'later',eventType:'tool_action',toolCallId:'tool-1',toolName:'edit',runId:'run-coordinator',occurredAt:now-400})];const v=buildActivity(s,{now,previous});assert.equal(v.summary.lastEngineering.timestamp,now-400);assert.equal(v.timeline.items.filter(e=>e.toolCallId==='tool-1'&&e.phase==='end').length,1);
});
test('omitted result flags remain unknown; unavailable approval route is technical',()=>{
 const s=active(base());s.liveEvents.push(tool(s.sessions[0],{seq:2,data:{phase:'result',name:'edit',toolCallId:'tool-1'}}));assert.equal(run(s).summary.lastCompleted,null);
 s.liveEvents.at(-1).data.result={details:{status:'approval-unavailable'}};const v=run(s);assert.equal(v.summary.blockers[0].kind,'technical');assert.equal(v.summary.working,false);
});
test('reducer is deterministic and does not mutate input event order',()=>{
 const s=active(base());s.liveEvents.push(tool(s.sessions[0],{seq:0}));const before=JSON.stringify(s);assert.deepEqual(run(s),run(s));assert.equal(JSON.stringify(s),before);
});
test('missing or replaced physical parent never establishes current delegated work',()=>{
 for(const parentSessionId of [undefined,'old-parent']) {const s=base(),child={...builder,parentSessionId};s.sessions.push(child);s.liveEvents=[tool(child)];s.coverage.processes=false;const v=run(s);assert.equal(v.summary.teamWorking,false);assert.equal(v.summary.state,'unknown');assert.equal(v.agents.find(a=>a.agentId==='builder').working,true);}
});
test('canonical pending approval replaces a generic boundary notice and resolution clears it',()=>{
 const s=active(base());s.liveEvents=[tool(s.sessions[0],{stream:'item',data:{itemId:'blocked',toolCallId:'blocked',phase:'end',kind:'tool',status:'blocked',approvalId:'a'}})];s.approvals=[{id:'a',status:'pending',agentId:'main',sessionKey:coordinator.key,sessionId:coordinator.sessionId,expiresAt:now+2000}];assert.equal(run(s).summary.blockers.length,1);assert.equal(run(s).summary.blockers[0].kind,'authorization');s.approvals[0].status='resolved';assert.equal(run(s).summary.blockers.length,0);
});
test('isolated cron schedules bind by native target identity, not creator or display name',()=>{
 const s=base();s.context.key='agent:main:cron:j';s.sessions[0].key=s.context.key;s.jobs=[{id:'j',effectiveAgentId:'main',sessionTarget:'isolated',enabled:true,state:{nextRunAtMs:now+60000}}];assert.equal(run(s).summary.nextScheduled.jobId,'j');
 s.jobs[0].sessionTarget='session:agent:main:elsewhere';s.jobs[0].owner={agentId:'main',sessionKey:s.context.key};assert.equal(run(s).summary.nextScheduled,null);
});
test('audit records without physical identity are visible but cannot establish selected completion',()=>{
 const s=base();s.audit.events=[audit({sessionId:undefined})];const v=run(s);assert.equal(v.timeline.items.length,1);assert.match(v.timeline.items[0].source,/incarnation unverified/);assert.equal(v.summary.lastCompleted,null);
});
test('a newer failed execution never inherits the completed state of an older success',()=>{
 const s=base();s.audit.events=[audit(),audit({eventId:'failed-new',runId:'new',status:'failed',errorCode:'run_failed',occurredAt:now-100})];const v=run(s);assert.equal(v.summary.state,'unknown');assert.equal(v.summary.lastCompleted.runId,'run-old');assert.match(v.summary.detail,/failed/);
});
test('an explicit execution cancellation is shown without inventing a project pause',()=>{
 const s=base();s.audit.events=[audit({status:'cancelled',errorCode:'run_cancelled'})];const v=run(s);assert.equal(v.summary.state,'paused');assert.match(v.summary.detail,/project-wide pause is not implied/);
});
test('a returned exec result is not command success while running or after a nonzero exit',()=>{
 for(const details of [{status:'running',sessionId:'process'},{status:'completed',exitCode:1},{status:'failed'}]) {
  const s=active(base());s.liveEvents=[tool(s.sessions[0],{data:{phase:'start',name:'exec',toolCallId:'tool-1',args:{command:'node --test test.cjs'}}}),tool(s.sessions[0],{seq:2,data:{phase:'result',name:'exec',toolCallId:'tool-1',isError:false,result:{details}}})];
  const v=run(s);assert.equal(v.summary.lastCompleted,null);assert.equal(v.summary.working,false);
 }
});

test('conflicting direct-run aggregate and exact active set remain unknown',()=>{
 for(const [hasActiveRun,activeRunIds]of [[false,['contradictory-run']],[true,[]]]) {
  const s=base();Object.assign(s.sessions[0],{hasActiveRun,activeRunIds});
  s.audit.events=[audit()];s.jobs=[{id:'later',agentId:'main',sessionKey:coordinator.key,enabled:true,nextRunAtMs:now+60000}];
  const v=run(s);assert.equal(v.summary.state,'unknown');assert.equal(v.summary.working,false);assert.match(v.summary.detail,/disagree|conflict/);
  assert.equal(v.summary.lastCompleted.runId,'run-old');assert.equal(v.summary.nextScheduled.jobId,'later');
 }
});

test('generic completed item cannot turn explicit command failure or background acknowledgement into success',()=>{
 for(const details of [{status:'completed',exitCode:1},{status:'failed'},{status:'running',sessionId:'process'}]) {
  const s=active(base());s.liveEvents=[
   tool(s.sessions[0],{data:{phase:'start',name:'exec',toolCallId:'command',args:{command:'node --test test.cjs'}}}),
   tool(s.sessions[0],{seq:2,data:{phase:'result',name:'exec',toolCallId:'command',isError:false,result:{details}}}),
   tool(s.sessions[0],{seq:3,stream:'item',data:{phase:'end',status:'completed',name:'exec',toolCallId:'command',itemId:'command'}})
  ];
  const v=run(s);assert.equal(v.summary.lastCompleted,null);assert.equal(v.summary.working,false);
  assert.equal(v.timeline.items.find(e=>e.toolCallId==='command'&&e.phase==='end').outcome,details.status==='running'?'background_running':'failed');
 }
});

test('an active persisted goal does not finish just because its previous automation turn succeeded',()=>{
 const s=base();s.sessions[0].goal={schemaVersion:1,id:'continuing-goal',status:'active',continuationTurns:2};s.audit.events=[audit()];
 const v=run(s);assert.equal(v.summary.state,'unknown');assert.equal(v.summary.working,false);assert.equal(v.summary.lastCompleted.runId,'run-old');
 assert.match(v.summary.detail,/goal remains active/);assert.equal(v.summary.nextScheduled,null);
});

test('one goal continues across engineering, scheduled gap, reporting turn and resumed engineering without invented progress',()=>{
 const goal={schemaVersion:1,id:'continuing-goal',status:'active',continuationTurns:1},s=active(base());s.sessions[0].goal=goal;
 s.liveEvents.push(tool(s.sessions[0],{seq:2,ts:now-500,data:{phase:'result',name:'edit',toolCallId:'tool-1',isError:false}}));
 let view=run(s);const firstEngineering=view.summary.lastEngineering.timestamp;
 s.sessions=[{...coordinator,goal}];s.liveEvents=[];s.audit.events=[audit({runId:'run-coordinator',occurredAt:now-400})];
 s.jobs=[{id:'continue',agentId:'main',sessionKey:coordinator.key,enabled:true,nextRunAtMs:now+60000}];
 view=buildActivity(s,{now,previous:view});assert.equal(view.summary.state,'scheduled');assert.equal(view.summary.lastEngineering.timestamp,firstEngineering);
 s.sessions[0]={...coordinator,goal:{...goal,continuationTurns:2},hasActiveRun:true,activeRunIds:['report-turn']};
 s.liveEvents=[tool(s.sessions[0],{ts:now,data:{phase:'start',name:'progress_card',toolCallId:'status-only',args:{markdown:'All work is done'}}})];
 s.cards=[{sessionKey:coordinator.key,sessionId:coordinator.sessionId,agentId:'main',revision:2,updatedAt:now,markdown:'Complete'}];
 s.occurrences=[{jobId:'continue',runId:'run-coordinator',agentId:'main',sessionKey:coordinator.key,sessionId:coordinator.sessionId,ts:now-300,status:'ok',completionStatus:'succeeded',summary:'Complete'}];
 view=buildActivity(s,{now,previous:view});assert.equal(view.summary.state,'active');assert.equal(view.summary.working,false);assert.equal(view.summary.lastEngineering.timestamp,firstEngineering);assert.equal(view.summary.lastStatus.timestamp,now);
 s.sessions[0]={...coordinator,goal:{...goal,continuationTurns:3},hasActiveRun:true,activeRunIds:['engineering-turn-2']};
 s.liveEvents=[tool(s.sessions[0],{ts:now+1000,data:{phase:'start',name:'exec',toolCallId:'new-tests',args:{command:'node --test test.cjs'}}})];
 s.observedAt=now+1000;s.freshUntil=now+46000;
 view=buildActivity(s,{now:now+1000,previous:view});assert.equal(view.summary.state,'working');assert.equal(view.summary.current[0].runId,'engineering-turn-2');assert.equal(view.summary.lastEngineering.timestamp,now+1000);
 assert.equal(view.timeline.items.filter(e=>e.id==='cron:continue:run-coordinator').length,1);assert.match(view.summary.lastCompleted.description,/project completion not established/);
});

test('same goal and automation labels cannot join work across a replaced physical session',()=>{
 const s=active(base());s.sessions[0].goal={schemaVersion:1,id:'reused-goal',status:'active'};const previous=run(s);
 s.context={...s.context,sessionId:'replacement'};s.sessions=[{...coordinator,sessionId:'replacement',goal:s.sessions[0].goal}];s.liveEvents=[];
 s.audit.events=[audit({runId:'old-turn'})];s.occurrences=[{jobId:'same-job',runId:'old-turn',agentId:'main',sessionKey:coordinator.key,sessionId:coordinator.sessionId,ts:now,status:'ok'}];
 const v=buildActivity(s,{now,previous});assert.equal(v.summary.state,'unknown');assert.equal(v.summary.lastEngineering,null);assert.equal(v.summary.lastCompleted,null);assert.equal(v.timeline.items.length,0);
});

test('reused tool-call ID in a different run remains a distinct completion receipt',()=>{
 const s=active(base());s.liveEvents.push(tool(s.sessions[0],{seq:2,ts:now-500,data:{phase:'result',name:'edit',toolCallId:'tool-1',isError:false}}));
 s.audit.events=[audit({eventId:'other-run-receipt',eventType:'tool_action',toolName:'edit',toolCallId:'tool-1',runId:'different-run',occurredAt:now-2000})];
 const v=run(s),ends=v.timeline.items.filter(e=>e.toolCallId==='tool-1'&&e.phase==='end');assert.equal(ends.length,2);assert.deepEqual(new Set(ends.map(e=>e.runId)),new Set(['run-coordinator','different-run']));
 assert.equal(ends.find(e=>e.runId==='different-run').classification,'unknown');assert.equal(ends.find(e=>e.runId==='run-coordinator').classification,'engineering');
});

test('successful tool-call receipts do not erase a known failed or background-running command outcome',()=>{
 for(const deferred of [false,true])for(const details of [{status:'completed',exitCode:1},{status:'running',sessionId:'process'}]) {
  const s=active(base());s.liveEvents=[
   tool(s.sessions[0],{data:{phase:'start',name:'exec',toolCallId:'command',args:{command:'node --test test.cjs'}}}),
   tool(s.sessions[0],{seq:2,ts:now-500,data:{phase:'result',name:'exec',toolCallId:'command',isError:false,result:{details}}})
  ];
  const previous=deferred?run(s):undefined;
  if(deferred){s.liveEvents=[];s.sessions=[{...coordinator}];}
  s.audit.events=[audit({eventId:'returned-call',eventType:'tool_action',toolName:'exec',toolCallId:'command',runId:'run-coordinator',occurredAt:now-400})];
  const v=buildActivity(s,{now,previous}),receipt=v.timeline.items.find(e=>e.id==='audit:returned-call');
  assert.equal(v.summary.lastCompleted,null);assert.equal(receipt.outcome,details.status==='running'?'background_running':'failed');
  assert.equal(v.timeline.items.filter(e=>e.toolCallId==='command'&&e.phase==='end').length,1);
  s.liveEvents=[];s.sessions=[{...coordinator}];const refreshed=buildActivity(s,{now:now+1000,previous:v});
  assert.equal(refreshed.summary.lastCompleted,null);assert.equal(refreshed.timeline.items.find(e=>e.id===receipt.id).outcome,receipt.outcome);
 }
});

test('full quiet rows may omit the false subagent flag without losing idle or scheduled state',()=>{
 const s=base();delete s.sessions[0].hasActiveSubagentRun;const before=JSON.stringify(s);
 let v=run(s);assert.equal(v.summary.state,'scheduled');assert.match(v.summary.detail,/No current execution reported/);assert.equal(v.summary.nextScheduled,null);assert.equal(v.summary.working,false);assert.equal(JSON.stringify(s),before);
 s.jobs=[{id:'later',agentId:'main',sessionKey:coordinator.key,enabled:true,nextRunAtMs:now+60000}];
 v=run(s);assert.equal(v.summary.state,'scheduled');assert.equal(v.summary.nextScheduled.jobId,'later');assert.match(v.summary.detail,/future automation/);
 assert.equal(viewAtTime(v,now+45001).summary.state,'unknown');assert.equal(viewAtTime(v,now,false).summary.working,false);
});

test('omission-based quiet requires a full nonsentinel row and an explicit empty direct-run set',()=>{
 const cases=[{activeRunIds:undefined},{activeRunIds:null},{hasActiveRun:undefined},{hasActiveRun:null},
  {hasActiveRun:true,activeRunIds:['running']},{activeRunIds:['conflicting']},{hasActiveSubagentRun:null},
  {hasActiveSubagentRun:true},{rowMode:'compact'},{rowMode:'sidebar'},{rowMode:'dashboard'},
  {key:'global'},{key:'unknown'}];
 for(const fields of cases) {
  const s=base();delete s.sessions[0].hasActiveSubagentRun;Object.assign(s.sessions[0],fields);s.context.key=s.sessions[0].key;
  s.jobs=[{id:'later',agentId:'main',sessionKey:s.context.key,enabled:true,nextRunAtMs:now+60000}];
  const v=run(s);assert.equal(v.summary.state,fields.hasActiveRun===true?'active':'unknown',JSON.stringify(fields));assert.equal(v.summary.working,false);
 }
});

test('Unknown identifies missing run flags and incomplete selected evidence coverage',()=>{
 for(const [field,pattern]of [['session',/selected session is unavailable/],['children',/Related-session coverage is incomplete/],['processes',/Background-process coverage is incomplete/]]) {
  const s=base();delete s.sessions[0].hasActiveSubagentRun;s.coverage[field]=false;
  const v=run(s);assert.equal(v.summary.state,'unknown');assert.match(v.summary.detail,pattern);
 }
 const s=base();delete s.sessions[0].hasActiveRun;assert.match(run(s).summary.detail,/direct-run flag/);
 delete s.sessions[0].hasActiveSubagentRun;s.sessions[0].hasActiveRun=false;s.sessions[0].rowMode='compact';assert.match(run(s).summary.detail,/returned session projection/);
});

test('a current status tool is explained without describing a finished report as still active',()=>{
 const s=active(base());s.liveEvents=[tool(s.sessions[0],{data:{phase:'start',name:'progress_card',toolCallId:'report',args:{markdown:'Complete'}}})];
 let v=run(s);assert.equal(v.summary.state,'active');assert.match(v.summary.detail,/status update is running/);assert.equal(v.summary.working,false);
 s.liveEvents.push(tool(s.sessions[0],{seq:2,data:{phase:'result',name:'progress_card',toolCallId:'report',isError:false}}));
 v=run(s);assert.equal(v.summary.state,'active');assert.match(v.summary.detail,/active execution/);assert.doesNotMatch(v.summary.detail,/status update is running/);
 s.sessions=[{...coordinator}];delete s.sessions[0].hasActiveSubagentRun;s.liveEvents=[];s.cards=[{sessionKey:coordinator.key,sessionId:coordinator.sessionId,agentId:'main',revision:2,updatedAt:now}];
 v=run(s);assert.equal(v.summary.state,'scheduled');assert.doesNotMatch(v.summary.detail,/status update tool is active/);assert.equal(v.summary.lastEngineering,null);
});

test('quiet omitted flags do not finish an active goal or conceal a registered process',()=>{
 const s=base();delete s.sessions[0].hasActiveSubagentRun;s.sessions[0].goal={schemaVersion:1,id:'goal',status:'active'};s.audit.events=[audit()];
 let v=run(s);assert.equal(v.summary.state,'unknown');assert.match(v.summary.detail,/goal remains active/);assert.equal(v.summary.lastCompleted.runId,'run-old');
 delete s.sessions[0].goal;s.processes=[{agentId:coordinator.agentId,sessionKey:coordinator.key,sessionId:coordinator.sessionId,processId:'p',instanceId:'i',status:'running'}];
 v=run(s);assert.equal(v.summary.state,'active');assert.match(v.summary.detail,/active execution/);assert.equal(v.summary.working,false);
});

test('selected-conversation quiet never claims whole-agent quiet without broader coverage',()=>{
 const s=base();delete s.sessions[0].hasActiveSubagentRun;const v=run(s),agent=v.agents.find(a=>a.agentId==='main');
 assert.equal(v.summary.state,'scheduled');assert.equal(agent.state,'unknown');assert.match(agent.detail,/does not cover every session and background process/);
 const other={...coordinator,key:'agent:main:other',sessionId:'other',hasActiveRun:true,activeRunIds:['other-run']};s.sessions.push(other);
 const next=run(s);assert.equal(next.summary.state,'scheduled');assert.equal(next.agents.find(a=>a.agentId==='main').state,'active');assert.match(next.agents.find(a=>a.agentId==='main').detail,/active execution/);
});


test('portable timeline merging replaces a transient tool phase with its exact durable receipt',()=>{
 const fields={agentId:'main',sessionKey:coordinator.key,sessionId:coordinator.sessionId,runId:'run-coordinator',toolCallId:'call',phase:'end',timestamp:now};
 const transient={...fields,id:'tool:call:end',classification:'engineering'},receipt={...fields,id:'audit:receipt',classification:'engineering'};
 const older={id:'older-page',timestamp:now-5000};
 const merged=mergeTimeline([transient,older],[receipt]);
 assert.deepEqual(merged.map(item=>item.id),['audit:receipt','older-page']);
 assert.deepEqual(mergeTimeline(merged,[transient,receipt]),merged);
});

test('timeline receipt replacement requires every exact identity component and phase',()=>{
 const fields={agentId:'main',sessionKey:coordinator.key,sessionId:coordinator.sessionId,runId:'run-coordinator',toolCallId:'call',phase:'end',timestamp:now};
 const transient={...fields,id:'tool:call:end'},receipt={...fields,id:'audit:receipt'};
 for(const field of ['agentId','sessionKey','sessionId','runId','toolCallId','phase']) {
  const other={...receipt,[field]:field==='phase'?'start':'different-'+receipt[field]};
  assert.equal(mergeTimeline([transient],[other]).length,2,field);
 }
});

test('missing or unusable identity cannot collapse unrelated transient and audit events',()=>{
 const fields={agentId:'main',sessionKey:coordinator.key,sessionId:coordinator.sessionId,runId:'run-coordinator',toolCallId:'call',phase:'end',timestamp:now};
 for(const field of ['agentId','sessionKey','sessionId','runId','toolCallId','phase'])for(const value of [undefined,'','   ','bad\nidentity']) {
  const partial={...fields,[field]:value};
  assert.equal(mergeTimeline([{...partial,id:'tool:partial'}],[{...partial,id:'audit:partial'}]).length,2,field+':'+String(value));
 }
});


test('fresh exact unclassified runs are Active without claiming substantive work or progress',()=>{
 const s=active(base());s.liveEvents=[];const v=run(s);
 assert.equal(v.summary.state,'active');assert.equal(v.summary.executionActive,true);assert.equal(v.summary.ownExecutionActive,true);
 assert.equal(v.summary.working,false);assert.equal(v.summary.lastEngineering,null);assert.match(v.summary.detail,/work type has not been classified/);
 for(const stale of [viewAtTime(v,now+45001),viewAtTime(v,now,false)]){assert.equal(stale.summary.state,'unknown');assert.equal(stale.summary.executionActive,false);assert.equal(stale.summary.ownExecutionActive,false);}
});

test('observed in-flight identity fills an absent active set only as positive execution evidence',()=>{
 const s=active(base());delete s.sessions[0].activeRunIds;s.sessions[0].observedRunIds=['run-coordinator'];
 let v=run(s);assert.equal(v.summary.state,'working');assert.equal(v.summary.executionActive,true);
 s.liveEvents=[];v=run(s);assert.equal(v.summary.state,'active');assert.equal(v.summary.working,false);
 s.sessions[0].hasActiveRun=false;s.sessions[0].observedRunIds=[];delete s.sessions[0].hasActiveSubagentRun;
 assert.equal(run(s).summary.state,'unknown','observed IDs do not prove a complete quiet set');
});

test('observed IDs cannot override explicit empty, invalid or contradictory native activity fields',()=>{
 for(const fields of [{hasActiveRun:true,activeRunIds:[]},{hasActiveRun:false,activeRunIds:['run-coordinator']},{hasActiveRun:false,activeRunIds:undefined},{hasActiveRun:true,activeRunIds:null}]){
  const s=active(base());Object.assign(s.sessions[0],fields,{observedRunIds:['run-coordinator']});
  const v=run(s);assert.equal(v.summary.state,'unknown',JSON.stringify(fields));assert.equal(v.summary.working,false);assert.equal(v.summary.executionActive,false);
 }
 const s=active(base());s.sessions[0].activeRunIds=['different-run'];s.sessions[0].observedRunIds=['run-coordinator'];
 const v=run(s);assert.equal(v.summary.state,'active');assert.equal(v.summary.working,false);assert.equal(v.summary.lastEngineering,null);assert.equal(v.summary.current[0].runId,'different-run');
});

test('unbound aggregate child activity remains unknown while a physical delegate can be Active',()=>{
 const s=base();s.sessions[0].hasActiveSubagentRun=true;let v=run(s);assert.equal(v.summary.state,'unknown');assert.equal(v.summary.executionActive,false);
 s.sessions.push({...builder});v=run(s);assert.equal(v.summary.state,'active');assert.equal(v.summary.teamExecutionActive,true);assert.equal(v.summary.ownExecutionActive,false);assert.equal(v.summary.working,false);
 s.sessions[1].parentSessionId='old-parent';v=run(s);assert.equal(v.summary.state,'unknown');assert.equal(v.summary.executionActive,false);
});

test('blocker priority retains a separate active execution fact and exact run-status snapshot',()=>{
 const s=active(base());s.liveEvents=[];s.sessions[0].goal={schemaVersion:1,id:'g',status:'blocked',lastStatusNote:'Capability missing'};
 s.runStatus={context:s.context,state:'active',runId:'run-coordinator',observedAt:now,freshUntil:now+45000};
 const v=run(s);assert.equal(v.summary.state,'blocked');assert.equal(v.summary.executionActive,true);assert.equal(v.summary.working,false);assert.equal(v.summary.lastEngineering,null);assert.deepEqual(v.runStatus,s.runStatus);
});
