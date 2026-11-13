'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {createHash}=require('node:crypto');
const {createProjectObserver,readProjectObservation}=require('../desktop/src/project-observation.cjs');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const temporary=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'project-observation-fixture-')));
  t.after(()=>fs.rm(temporary,{recursive:true,force:true}));
  const root=path.join(temporary,'project'),indexPath=path.join(temporary,'selection.json');
  await fs.mkdir(root);const charterPath=path.join(root,'CHARTER.md'),cursorPath=path.join(root,'PROJECT_STATUS.json');
  const charter=Buffer.from('Fixture charter; not production authority.\n');
  const index={development_workflow:{selection_state:'ACTIVE_FROZEN',scope:'ISOLATED_PROJECT_ENGINEERING_ONLY',
    charter:{path:charterPath,bytes:charter.length,sha256:hash(charter)},task_cursor:cursorPath}};
  const document={schema:1,updated_utc:'2026-11-11T01:02:03.000Z',current_state:'Reported checkpoint A',current_task:'Reported task B',
    next_action:'Reported next step C',private_unselected:'fixture-private-not-for-renderer',
    latest_report:{path:'/do-not-follow/report.md'},nested:{current_state:'Not selected'}};
  const state={checks:0,verified:true,time:Date.parse('2026-11-11T01:03:00.000Z')};
  const writeIndex=()=>fs.writeFile(indexPath,JSON.stringify(index));
  const writeCursor=()=>fs.writeFile(cursorPath,JSON.stringify(document));
  await fs.writeFile(charterPath,charter);await writeIndex();await writeCursor();
  const read=createProjectObserver({indexPath,allowedRoot:root,volumeCheck:async()=>{state.checks++;return state.verified;},now:()=>state.time});
  return {temporary,root,indexPath,charterPath,cursorPath,index,document,state,read,writeIndex,writeCursor};
}

test('public default and incomplete configuration perform no project observation',async()=>{
  for(const read of [readProjectObservation,createProjectObserver({indexPath:'/unconfigured/index.json',allowedRoot:'/unconfigured/project'})]) {
    const result=await read();
    assert.equal(result.available,false);assert.equal(result.selectionVerified,false);assert.equal(result.sourcePath,null);
    assert.equal(result.sha256,null);assert.deepEqual(result.fields,[]);assert.equal(result.currentBlocker,'unselected');
    assert.match(result.limitations.join(' '),/not configured.*No local project files were read/);
  }
});

test('only explicit bounded declarations are returned, with selected bytes and provenance',async t=>{
  const f=await fixture(t),r=await f.read();
  assert.equal(r.available,true);assert.equal(r.selectionVerified,true);assert.equal(r.currentBlocker,'unselected');
  assert.equal(r.sourcePath,f.cursorPath);assert.equal(r.updatedAt,f.document.updated_utc);
  assert.equal(r.sha256,hash(await fs.readFile(f.cursorPath)));
  assert.deepEqual(r.fields,[{path:'current_state',value:f.document.current_state},{path:'current_task',value:f.document.current_task},{path:'next_action',value:f.document.next_action}]);
  assert.match(r.limitations.join(' '),/not live execution status/);
  assert.doesNotMatch(JSON.stringify(r),/fixture-private|do-not-follow|Not selected/);
  const original=await fs.readFile(f.cursorPath);await f.read();assert.deepEqual(await fs.readFile(f.cursorPath),original);
});

test('inactive selection, altered charter and unsupported cursor schema fail unavailable',async t=>{
  for(const kind of ['selection','scope','hash','bytes','schema']) {
    const f=await fixture(t);
    if(kind==='selection')f.index.development_workflow.selection_state='CANDIDATE';
    if(kind==='scope')f.index.development_workflow.scope='OTHER';
    if(kind==='hash')await fs.appendFile(f.charterPath,'changed');
    if(kind==='bytes')f.index.development_workflow.charter.bytes++;
    if(kind==='schema')f.document.schema=2;
    await f.writeIndex();await f.writeCursor();const r=await f.read();
    assert.equal(r.available,false,kind);assert.equal(r.selectionVerified,false);assert.deepEqual(r.fields,[]);assert.equal(r.sha256,null);
  }
});

test('selected cursor and charter cannot escape the fixed project or follow an outside symlink',async t=>{
  for(const kind of ['cursor','charter','symlink']) {
    const f=await fixture(t),outside=path.join(f.temporary,'outside.json');await fs.writeFile(outside,'outside-private-fixture');
    if(kind==='cursor')f.index.development_workflow.task_cursor=outside;
    if(kind==='charter')f.index.development_workflow.charter.path=outside;
    if(kind==='symlink'){await fs.unlink(f.cursorPath);await fs.symlink(outside,f.cursorPath);}
    await f.writeIndex();const r=await f.read();assert.equal(r.available,false,kind);assert.deepEqual(r.fields,[]);
    assert.doesNotMatch(JSON.stringify(r),/outside-private-fixture/);
  }
});

test('missing, malformed and oversized records are unavailable without exposing source bodies',async t=>{
  for(const kind of ['missing','json','oversize']) {
    const f=await fixture(t);
    if(kind==='missing')await fs.unlink(f.cursorPath);
    if(kind==='json')await fs.writeFile(f.cursorPath,'{"private":"fixture-private"');
    if(kind==='oversize')await fs.truncate(f.cursorPath,8388609);
    const r=await f.read();assert.equal(r.available,false,kind);assert.equal(r.currentBlocker,'unselected');
    assert.deepEqual(r.fields,[]);assert.doesNotMatch(JSON.stringify(r),/fixture-private/);
  }
});

test('volume verification caches for 60 seconds and failure never becomes idle',async t=>{
  const f=await fixture(t);
  assert.equal((await f.read()).available,true);assert.equal(f.state.checks,1);
  f.state.time+=59000;assert.equal((await f.read()).available,true);assert.equal(f.state.checks,1);
  f.state.verified=false;f.state.time+=1000;const unavailable=await f.read();
  assert.equal(unavailable.available,false);assert.equal(f.state.checks,2);assert.equal(unavailable.currentBlocker,'unselected');
  assert.deepEqual(unavailable.fields,[]);assert.equal(unavailable.selectionVerified,false);
  f.state.verified=true;f.state.time+=60000;assert.equal((await f.read()).available,true);assert.equal(f.state.checks,3);
});

test('fresh cursor bytes replace reported text without changing its authority classification',async t=>{
  const f=await fixture(t),first=await f.read();f.document.current_state='Different reported state';
  f.document.next_action='x'.repeat(2000)+'\u0000';f.document.current_task={not:'text'};delete f.document.updated_utc;await f.writeCursor();
  const second=await f.read();assert.equal(second.available,true);assert.notEqual(second.sha256,first.sha256);
  assert.equal(second.currentBlocker,'unselected');assert.equal(second.updatedAt,null);assert.equal(second.fields.length,2);
  assert.equal(second.fields[1].value.length,1200);assert.ok(second.fields[1].value.endsWith('…'));
  assert.doesNotMatch(JSON.stringify(second.fields),/\\u0000/);
});
