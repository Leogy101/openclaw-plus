'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {ComposerActions}=require('../desktop/src/composer-actions.cjs');
const {ReadError}=require('../desktop/src/gateway-cli.cjs');
const selected={key:'agent:main:main',agentId:'main',sessionId:'physical-1'};
const thinkingLevels=[{id:'low',label:'Low'},{id:'high',label:'High'}];
function fixture({write,read,isBusy}={}){
 const calls=[],state={...selected,lifecycleRevision:'life-1',modelProvider:'fixture',model:'one',thinkingLevel:'low',thinkingLevels,runtimeSelectionLocked:true};
 const base={generation:0,assertCurrent(g){if(g!==this.generation)throw new ReadError('STALE','Changed');},invalidate(){this.generation++;},async read(method,params,ttl){calls.push({method,params,ttl});if(read)return read(method,params,state);return method==='sessions.describe'?{session:{...state}}:{models:[{provider:'fixture',id:'one',name:'One',available:true,thinkingLevels,input:['text','image']},{provider:'fixture',id:'two',name:'Two',available:true,thinkingLevels},{provider:'fixture',id:'blocked',name:'Blocked',manualSelectionAllowed:false,thinkingLevels}]};},transport:{async write(method,params){calls.push({method,params,write:true});if(write)return write(method,params,state);if(params.model){state.modelProvider='fixture';state.model=params.model.split('/')[1];}if(params.thinkingLevel)state.thinkingLevel=params.thinkingLevel;return {ok:true,key:state.key,entry:{...state}};}}};
 return {actions:new ComposerActions(base,{isBusy}),base,calls,state};
}
test('options use scoped prepared catalog and advertised reasoning; runtime lock is not a model lock',async()=>{
 const {actions,calls}=fixture();const result=await actions.handle('composerOptions',selected);
 assert.equal(result.current.model,'fixture/one');assert.deepEqual(result.models[0].thinkingLevels,thinkingLevels);assert.equal(result.modelSelectionLocked,false);
 assert.deepEqual(calls.find(c=>c.method==='models.list'),{method:'models.list',params:{agentId:'main',sessionKey:selected.key,view:'default',preparedOnly:true,includeDetails:true},ttl:60000});
});
test('explicit settings patch binds session and lifecycle and returns authoritative refreshed choices',async()=>{
 const {actions,calls}=fixture();const result=await actions.handle('setComposer',{...selected,model:'fixture/two',thinkingLevel:'high'});
 const writes=calls.filter(c=>c.write);assert.equal(writes.length,1);assert.deepEqual(writes[0],{method:'sessions.patch',write:true,params:{key:selected.key,agentId:'main',expectedSessionId:'physical-1',expectedLifecycleRevision:'life-1',model:'fixture/two',thinkingLevel:'high'}});
 assert.equal(result.current.model,'fixture/two');assert.equal(result.current.thinkingLevel,'high');
});
test('unknown and forbidden model or reasoning choices never reach patch',async()=>{
 for(const patch of [{model:'invented/model'},{model:'fixture/blocked'},{thinkingLevel:'invented'},{model:'fixture/one',thinkingLevel:'ultra'},{}]){const {actions,calls}=fixture();await assert.rejects(actions.handle('setComposer',{...selected,...patch}),{code:'INVALID'});assert.equal(calls.some(c=>c.write),false);}
});
test('physical replacement, actual model lock and pending send prevent mutation',async()=>{
 for(const change of ['session','lock','busy']){const f=fixture({isBusy:()=>change==='busy'});if(change==='session')f.state.sessionId='other';if(change==='lock')f.state.modelSelectionLocked=true;
 await assert.rejects(f.actions.handle('setComposer',{...selected,model:'fixture/two'}),{code:change==='session'?'SESSION_CHANGED':change==='busy'?'BUSY':'INVALID'});assert.equal(f.calls.some(c=>c.write),false);}
});
test('lost patch response remains uncertain and never automatically retries',async()=>{
 const {actions,calls}=fixture({write:()=>{throw new ReadError('TIMEOUT','not confirmed');}});
 await assert.rejects(actions.handle('setComposer',{...selected,thinkingLevel:'high'}),{code:'UNCERTAIN'});assert.equal(calls.filter(c=>c.write).length,1);
 const denied=fixture({write:()=>{throw new ReadError('ACCESS','Denied');}});await assert.rejects(denied.actions.handle('setComposer',{...selected,thinkingLevel:'high'}),{code:'ACCESS'});
});
test('malformed fields and renderer configuration-default edits are rejected locally',async()=>{
 const {actions,calls}=fixture();for(const input of [{...selected,persistDefault:true},{...selected,model:3},{...selected,thinkingLevel:'\n'},null])await assert.rejects(actions.handle('setComposer',input),{code:'INVALID'});assert.equal(calls.length,0);
});
