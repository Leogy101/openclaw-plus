import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeRunStatus,viewRunStatus,RUN_FRESH_MS} from '../desktop/shared/run-status.mjs';
const now=1700000100000,context={key:'agent:main:fixture',agentId:'main',sessionId:'physical-one'};
const event=(seq,stream,data,extra={})=>({runId:'run-one',seq,stream,ts:now-1000,sessionKey:context.key,agentId:context.agentId,data,...extra});
function history(events=[event(1,'usage',{outputTokens:2500})]){return {sessionKey:context.key,sessionId:context.sessionId,sessionInfo:{...context,lifecycleRevision:'life-one',hasActiveRun:true},inFlightRun:{runId:'run-one',startedAt:now-10000,text:'',events}};}
const project=h=>normalizeRunStatus(h,{context,observedAt:now});
test('authoritative empty-text run remains active with omitted complete IDs and real per-run usage',()=>{
 const result=project(history());assert.equal(result.state,'active');assert.equal(result.runId,'run-one');assert.equal(result.startedAt,now-10000);assert.equal(result.outputTokens,2500);assert.equal(result.usageUnavailable,false);assert.equal(result.lifecycleRevision,'life-one');
 assert.equal(viewRunStatus(result,now+2000).elapsedMs,12000);
});
test('missing usage stays unavailable, zero stays zero and latest unavailable overrides an earlier count',()=>{
 assert.equal(project(history([])).outputTokens,undefined);assert.equal(project(history([event(1,'usage',{outputTokens:0})])).outputTokens,0);
 const result=project(history([event(2,'usage',{outputTokens:100}),event(3,'usage',{usageReport:{state:'unavailable'}})]));
 assert.equal(result.outputTokens,undefined);assert.equal(result.usageUnavailable,true);
 for(const outputTokens of [-1,1.5,Infinity,'2500',Number.MAX_SAFE_INTEGER+1])assert.equal(project(history([event(1,'usage',{outputTokens})])).outputTokens,undefined);
});
test('usage is ordered by native sequence and duplicate or foreign-run events cannot replace it',()=>{
 const result=project(history([event(8,'usage',{outputTokens:9}),event(5,'usage',{outputTokens:20}),event(8,'usage',{outputTokens:99}),event(9,'usage',{outputTokens:999},{runId:'other'}),event(10,'usage',{outputTokens:999},{sessionKey:'other'}),event(11,'usage',{outputTokens:999},{sessionId:'other'}),event(12,'usage',{outputTokens:999},{agentId:'other'})]));
 assert.equal(result.outputTokens,9);
});
test('contradictory direct flags, explicit empty or wrong complete IDs never animate the retained run',()=>{
 for(const info of [{hasActiveRun:false},{hasActiveRun:true,activeRunIds:[]},{hasActiveRun:true,activeRunIds:['other']},{hasActiveRun:true,activeRunIds:null},{hasActiveRun:true,activeRunIds:['']}]){
  const h=history();Object.assign(h.sessionInfo,info);const result=project(h);assert.equal(result.state,'unknown');assert.equal(viewRunStatus(result,now).active,false);assert.equal(result.outputTokens,undefined);
 }
});
test('the explicit history owner is used within a multi-run set, never the first array entry',()=>{
 const h=history();h.sessionInfo.activeRunIds=['other','run-one'];assert.equal(project(h).runId,'run-one');
 delete h.inFlightRun;const result=project(h);assert.equal(result.state,'active');assert.equal(result.runId,undefined);assert.equal(result.outputTokens,undefined);
});
test('foreign physical identity, key and owner or reset snapshot cannot publish a footer',()=>{
 const cases=[h=>h.sessionId='replacement',h=>h.sessionKey='other',h=>h.sessionInfo.sessionId='replacement',h=>h.sessionInfo.agentId='other',h=>h.windowReset=true,h=>h.inFlightRun.sessionId='replacement'];
 for(const change of cases){const h=history();change(h);assert.equal(project(h).state,'unknown');}
 assert.equal(project(null).state,'unknown');assert.equal(normalizeRunStatus(history(),{context:{key:context.key},observedAt:now}).state,'unknown');
});
test('reported session totals and prose never become live output tokens or elapsed time',()=>{
 const h=history([]);h.sessionInfo.outputTokens=99999;h.inFlightRun.text='I have emitted 900 tokens and worked for an hour.';delete h.inFlightRun.startedAt;
 const result=project(h);assert.equal(result.outputTokens,undefined);assert.equal(result.startedAt,undefined);assert.equal(viewRunStatus(result,now).elapsedMs,undefined);
 h.inFlightRun.startedAt=now+1;assert.equal(project(h).startedAt,undefined);
});
test('tool lifecycle exposes only a currently running bounded label and clears completed tools',()=>{
 const start=event(1,'tool',{phase:'start',toolCallId:'call-one',name:'exec'}),item=event(2,'item',{phase:'start',status:'running',toolCallId:'call-one',title:'Run focused checks',name:'exec'});
 assert.deepEqual(project(history([start,item])).tool,{name:'exec',title:'Run focused checks',status:'running'});
 assert.equal(project(history([start,item,event(3,'tool',{phase:'result',toolCallId:'call-one',name:'exec'})])).tool,undefined);
 const result=project(history([event(1,'tool',{phase:'start',toolCallId:'call-one',name:'x'.repeat(300)}),event(2,'item',{phase:'start',toolCallId:'call-one',title:'x'.repeat(500)})]));assert.equal(result.tool.name.length,120);assert.equal(result.tool.title.length,200);
});
test('new occurrence and completed direct response never inherit prior usage or tool identity',()=>{
 project(history());const next=history([]);next.inFlightRun.runId='run-two';delete next.inFlightRun.startedAt;
 const current=project(next);assert.equal(current.runId,'run-two');assert.equal(current.outputTokens,undefined);assert.equal(current.startedAt,undefined);
 next.sessionInfo.hasActiveRun=false;next.sessionInfo.activeRunIds=[];delete next.inFlightRun;
 assert.equal(project(next).state,'idle');assert.equal(viewRunStatus(project(next),now).active,false);
});
test('stale and disconnected responses freeze at their real last observation and stop animation',()=>{
 const status=project(history());
 for(const [at,online]of [[now+RUN_FRESH_MS+1,true],[now+15000,false]]){
  const view=viewRunStatus(status,at,online);assert.equal(view.active,false);assert.equal(view.state,'unknown');assert.equal(view.stale,true);assert.equal(view.elapsedMs,10000);assert.equal(view.outputTokens,2500);
 }
 assert.equal(status.state,'active');assert.equal(viewRunStatus(status,now-1).active,false);
});
test('terminal lifecycle receipts cannot be shown as an active response despite a stale aggregate flag',()=>{
 const result=project(history([event(1,'usage',{outputTokens:10}),event(2,'lifecycle',{phase:'end'})]));assert.equal(result.state,'unknown');assert.equal(viewRunStatus(result,now).active,false);
});
