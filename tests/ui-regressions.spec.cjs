'use strict';
// Exercise the shipped renderer functions with minimal platform fakes; no Electron or gateway.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=name=>fs.readFileSync(path.join(__dirname,'../desktop/ui',name),'utf8');
function between(text,start,end){const offset=text.indexOf(start);assert.notEqual(offset,-1);const stop=text.indexOf(end,offset);assert.notEqual(stop,-1);return text.slice(offset,stop);}
function regionHarness(){
  const pendingRegions=new Map(),element={innerHTML:'A',contains:()=>false,querySelectorAll:()=>[],querySelector:()=>null};
  let selected=true;
  const scope={pendingRegions,$:()=>element,selectionInside:()=>selected,document:{activeElement:null},actionKey:()=>null};
  vm.createContext(scope);
  vm.runInContext(between(source('app.js'),'function replaceRegion(','function cacheSession('),scope);
  return {element,pendingRegions,render:scope.replaceRegion,release(){selected=false;for(const [id,html]of [...pendingRegions])scope.replaceRegion(id,html);}};
}
test('a return to the visible state cancels an obsolete deferred update',()=>{
  const h=regionHarness();h.render('activity-current','B');assert.equal(h.element.innerHTML,'A');assert.equal(h.pendingRegions.get('activity-current'),'B');
  h.render('activity-current','A');h.release();assert.equal(h.element.innerHTML,'A');assert.equal(h.pendingRegions.size,0);
});
test('a newer deferred state still applies when the text selection is released',()=>{
  const h=regionHarness();h.render('activity-current','B');h.render('activity-current','C');h.release();assert.equal(h.element.innerHTML,'C');assert.equal(h.pendingRegions.size,0);
});
function terminalHarness(){
  const context={agentId:'main',key:'agent:main:fixture',sessionId:'fixture-session'},writes=[],requests=[];
  const record={context,snapshot:{context,terminalId:'fixture-terminal',status:'ready'},attached:true,overflow:false,pendingOutput:0,terminal:{options:{disableStdin:false},write(data,done){writes.push({data,done});}}};
  const text=source('terminal-view.mjs');
  const constants=between(text,'// A maximum-size replay','let libraries;');
  const callback=between(text,'  const unsubscribe=desktop?.onTerminalEvent?.(event=>{','  return {');
  let receive;
  const scope={desktop:{onTerminalEvent(fn){receive=fn;}},recordFor:()=>record,active:()=>record,update(){},keyOf:value=>JSON.stringify(value),messageOf:error=>error.message,
    applySnapshot(target,snapshot){target.snapshot=snapshot;},request(action,target,params){requests.push({action,params});return Promise.resolve();}};
  vm.createContext(scope);vm.runInContext(constants+callback,scope);
  return {record,writes,requests,emit(data,reset=false){receive({kind:'data',context,terminalId:'fixture-terminal',data,reset});}};
}
test('an exact maximum replay fits with its ordered reset prefix',()=>{
  const h=terminalHarness(),buffer='x'.repeat(2*1024*1024);h.emit(buffer,true);
  assert.equal(h.writes.length,1);assert.equal(h.writes[0].data,'\x1bc'+buffer);assert.equal(h.record.overflow,false);assert.equal(h.record.attached,true);assert.equal(h.requests.length,0);
  h.writes[0].done();assert.equal(h.record.pendingOutput,0);
});
test('a backed-up terminal queue detaches once without retrying input or growing further',()=>{
  const h=terminalHarness(),chunk='x'.repeat(128*1024);
  for(let i=0;i<16;i++)h.emit(chunk);
  assert.equal(h.record.pendingOutput,2*1024*1024);h.emit('more');
  assert.equal(h.record.overflow,true);assert.equal(h.record.attached,false);assert.equal(h.record.terminal.options.disableStdin,true);assert.match(h.record.error,/Output could not keep up/);
  assert.deepEqual(h.requests.map(item=>item.action),['detach']);assert.equal(h.writes.length,16);
  h.emit(chunk);assert.equal(h.writes.length,16);assert.equal(h.requests.length,1);
  for(const write of h.writes)write.done();assert.equal(h.record.pendingOutput,0);
});
