'use strict';
const {_electron}=require('./test-support.cjs').playwright;
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),evidence=require('./test-support.cjs').evidenceDirectory('chat-motion');fs.mkdirSync(evidence,{recursive:true});
const profile=fs.mkdtempSync(path.join(evidence,'fixture-profile-'));
const env={...process.env,OPENCLAW_PLUS_TEST_DATA:profile,OPENCLAW_PLUS_TEST_CLI:path.join(root,'tests/fixture-gateway.cjs')};delete env.ELECTRON_RUN_AS_NODE;
const cliCalls=()=>fs.existsSync(path.join(profile,'fixture-calls.jsonl'))?fs.readFileSync(path.join(profile,'fixture-calls.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
(async()=>{
 const app=await _electron.launch({executablePath:path.join(root,'desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[path.join(root,'desktop')],env});
 const page=await app.firstWindow();page.setDefaultTimeout(12000);
 const checks=[],errors=[],network=[];page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(/^(?:https?|wss?):/.test(request.url()))network.push(request.url());});
 await page.addInitScript(()=>{
  window.__motionCalls=[];window.__motionNodes=new Map();
  const original=Element.prototype.animate;
  Element.prototype.animate=function(keyframes,options){
   const animation=original.call(this,keyframes,options);
   if(this.matches?.('#messages [data-message-id]')){
    window.__motionCalls.push({id:this.dataset.messageId,role:this.dataset.messageRole,keyframes:JSON.parse(JSON.stringify(keyframes)),options:typeof options==='object'?{...options}:options,time:performance.now()});
    window.__motionNodes.set(this.dataset.messageId,this);
   }
   return animation;
  };
 });
 await app.evaluate(({ipcMain,BrowserWindow,shell,clipboard})=>{
  const window=BrowserWindow.getAllWindows()[0];window.setSize(1440,1000);
  const state=globalThis.__chatMotionFixture={reads:0,calls:[],native:[],inFlight:'',extras:[]};
  const original=ipcMain._invokeHandlers.get('gateway:request'),send=window.webContents.send.bind(window.webContents);
  state.publish=event=>send('gateway:event',event);
  window.webContents.send=(channel,event,...rest)=>{if(channel==='gateway:event'&&['sessions','history','activity','plan'].includes(event?.kind))return;return send(channel,event,...rest);};
  ipcMain.removeHandler('gateway:request');ipcMain.handle('gateway:request',async(event,operation,params)=>{
   state.calls.push({operation,params:structuredClone(params)});
   if(operation==='plan')return {ok:true,data:{card:null}};
   const result=await original(event,operation,params);
   if(operation==='history'&&result?.ok){
    const filler=Array.from({length:14},(_,index)=>({id:`motion-history-${params.key}-${index}`,role:index%2?'user':'assistant',text:`Earlier conversation ${index}. `+'This is stable fixture history used to measure scroll movement. '.repeat(8)}));
    result.data.messages=params.offset?result.data.messages:[...filler,...result.data.messages,...state.extras];
    if(!params.offset&&params.key==='agent:main:main'&&state.inFlight)result.data.inFlight={runId:'fixture-motion-run',text:state.inFlight};
    else result.data.inFlight=undefined;
    state.reads++;
   }
   return result;
  });
  shell.openExternal=async value=>state.native.push(['external',value]);shell.showItemInFolder=value=>state.native.push(['reveal',value]);clipboard.writeText=value=>state.native.push(['copy',value]);
 });
 const check=async(name,fn)=>{try{await fn();checks.push({name,pass:true});console.log('PASS',name);}catch(error){checks.push({name,pass:false,error:error.message});console.log('FAIL',name,error.message);await page.screenshot({path:path.join(evidence,'failure-'+checks.length+'.png')}).catch(()=>{});}};
 const metrics=()=>page.locator('#transcript').evaluate(el=>({top:el.scrollTop,max:el.scrollHeight-el.clientHeight,height:el.clientHeight}));
 const motionCalls=()=>page.evaluate(()=>window.__motionCalls);
 const publish=async()=>{const before=await app.evaluate(()=>globalThis.__chatMotionFixture.reads);await app.evaluate(()=>globalThis.__chatMotionFixture.publish({kind:'history',key:'agent:main:main'}));const deadline=Date.now()+10000;while(await app.evaluate(()=>globalThis.__chatMotionFixture.reads)===before){if(Date.now()>deadline)throw new Error('History fixture read timed out');await page.waitForTimeout(20);}};
 const atBottom=async()=>{await page.locator('#transcript').evaluate(el=>el.scrollTop=el.scrollHeight);await page.waitForTimeout(80);};
 const settledBottom=()=>page.waitForFunction(()=>{const el=document.querySelector('#transcript');return el&&Math.abs(el.scrollHeight-el.clientHeight-el.scrollTop)<3;});
 const ready=async()=>{await page.getByText('Coordinator is coordinating.',{exact:true}).waitFor();await page.getByText('No task checklist supplied for this conversation.',{exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector('#composer-model')?.value);await atBottom();};
 const longText=(prefix,lines=15)=>Array.from({length:lines},(_,i)=>`${prefix} ${i+1}: observe actual browser motion without changing production.`).join('\n');
 try{
  await page.reload();await ready();
  await check('Initial history and older-page hydration never replay message entrances',async()=>{
   assert.equal((await motionCalls()).length,0);
   await page.getByRole('button',{name:'Load earlier messages',exact:true}).click();await page.getByText('Earlier fixture message',{exact:true}).waitFor();await page.waitForTimeout(150);
   assert.equal((await motionCalls()).length,0);assert.ok(await page.getByText('Earlier fixture message',{exact:true}).isVisible());
   await page.reload();await ready();assert.equal((await motionCalls()).length,0);
  });
  await check('Actual fixture send uses a soft native entrance and gradual bottom follow without losing the next draft',async()=>{
   await atBottom();const before=await metrics(),callsBefore=cliCalls().filter(call=>call.method==='chat.send').length;
   await page.locator('#composer-input').fill(longText('Fixture send'));
   await page.waitForFunction(()=>!document.querySelector('#send-message').disabled);
   await page.locator('#composer-input').press('Enter');await page.locator('#composer-input').fill('Preserve this next draft.');
   await page.waitForFunction(()=>window.__motionCalls.some(call=>call.role==='user'));
   const entered=await metrics();assert.ok(entered.max>before.max+100,'new message must provide a measurable scroll distance');
   await page.waitForTimeout(120);const middle=await metrics();assert.ok(middle.top>before.top+1&&middle.top<middle.max-4,JSON.stringify({before,middle}));
   assert.ok(await page.locator('#messages [data-message-role="user"]').evaluateAll(nodes=>nodes.some(node=>node.getAnimations().some(animation=>animation.playState==='running'))),'the user entry animation should still be running after finally repaint');
   assert.equal(await page.evaluate(()=>[...window.__motionNodes].every(([id,node])=>document.querySelector(`[data-message-id="${CSS.escape(id)}"]`)===node)),true,'unchanged finally renders retain animated article nodes');
   await settledBottom();await page.waitForTimeout(120);
   const animated=await motionCalls();assert.ok(animated.some(call=>call.role==='assistant'));for(const call of animated)assert.ok(call.options.duration>=600&&call.options.duration<=900);
   assert.equal(cliCalls().filter(call=>call.method==='chat.send').length,callsBefore+1);
   const sent=cliCalls().filter(call=>call.method==='chat.send').at(-1);assert.equal(sent.params.sessionKey,'agent:main:main');assert.equal(sent.params.sessionId,'physical-main');
   assert.equal(await page.locator('#composer-input').inputValue(),'Preserve this next draft.');
   fs.writeFileSync(path.join(evidence,'send-motion-observation.json'),JSON.stringify({before,entered,middle,after:await metrics(),animations:animated},null,2));
   await page.screenshot({path:path.join(evidence,'chat-after-send.png')});
  });
  await check('Unchanged polling preserves article identity and does not restart animation or scrolling',async()=>{
   await page.waitForTimeout(750);const before=(await motionCalls()).length,pos=await metrics();
   await page.evaluate(()=>{window.__stableArticles=new Map([...document.querySelectorAll('#messages [data-message-id]')].map(node=>[node.dataset.messageId,node]));});
   await publish();await page.waitForTimeout(180);
   assert.equal((await motionCalls()).length,before);
   assert.equal(await page.evaluate(()=>[...window.__stableArticles].every(([id,node])=>document.querySelector(`[data-message-id="${CSS.escape(id)}"]`)===node)),true);
   assert.ok(Math.abs((await metrics()).top-pos.top)<3);
   assert.equal(await page.locator('#composer-input').inputValue(),'Preserve this next draft.');
  });
  await check('A streaming run enters once; later text growth keeps its run identity without replay',async()=>{
   await atBottom();await app.evaluate((_,text)=>globalThis.__chatMotionFixture.inFlight=text,longText('First stream',4));await publish();
   await page.locator('[data-message-id="live:fixture-motion-run"]').waitFor();await settledBottom();await page.waitForTimeout(750);
   const before=(await motionCalls()).filter(call=>call.id==='live:fixture-motion-run').length;assert.equal(before,1);
   await app.evaluate((_,text)=>globalThis.__chatMotionFixture.inFlight=text,longText('Stream extended',10));await publish();
   await page.getByText(/Stream extended 10:/).waitFor();await settledBottom();
   assert.equal((await motionCalls()).filter(call=>call.id==='live:fixture-motion-run').length,before);
   assert.equal(await page.locator('#composer-input').inputValue(),'Preserve this next draft.');
  });
  await check('User wheel interruption preserves the reading position and navigation cancels the old scroll',async()=>{
   await atBottom();await app.evaluate((_,text)=>globalThis.__chatMotionFixture.inFlight=text,longText('Interrupt stream',30));await publish();await page.getByText(/Interrupt stream 30:/).waitFor();await page.waitForTimeout(110);
   const box=await page.locator('#transcript').boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.wheel(0,-280);await page.waitForTimeout(150);
   const stopped=await metrics();assert.ok(stopped.max-stopped.top>100);await page.waitForTimeout(1000);assert.ok(Math.abs((await metrics()).top-stopped.top)<3);
   await publish();await page.waitForTimeout(250);assert.ok(Math.abs((await metrics()).top-stopped.top)<3,'unchanged refresh cannot restart follow after the user interrupts');
   await app.evaluate((_,text)=>globalThis.__chatMotionFixture.inFlight=text,longText('More while reading',34));await publish();await page.getByText(/More while reading 34:/).waitFor();await page.waitForTimeout(1000);assert.ok(Math.abs((await metrics()).top-stopped.top)<3,'new content must preserve a reader away from bottom');
   await atBottom();await app.evaluate((_,text)=>globalThis.__chatMotionFixture.inFlight=text,longText('Before navigation',44));await publish();await page.getByText(/Before navigation 44:/).waitFor();
   await page.evaluate(()=>document.addEventListener('click',event=>{if(event.target.closest('#work-content [data-action="session"]'))window.__savedMotionOrigin=document.querySelector('#transcript').scrollTop;},{capture:true,once:true}));
   await page.locator('#work-content [data-action="session"]').first().click();await page.getByText('Builder exact child history',{exact:true}).waitFor();await page.waitForTimeout(80);const child=await metrics();await page.waitForTimeout(1000);assert.ok(Math.abs((await metrics()).top-child.top)<3);
   await page.getByRole('button',{name:'Back to Coordinator'}).click();await page.getByText('Coordinator is coordinating.',{exact:true}).waitFor();await page.waitForTimeout(150);assert.ok(Math.abs((await metrics()).top-await page.evaluate(()=>window.__savedMotionOrigin))<3,'Back restores the exact origin reading position');assert.equal(await page.locator('#composer-input').inputValue(),'Preserve this next draft.');
  });
  await check('Reduced motion inserts immediately with no message animation and no external effects',async()=>{
   await page.emulateMedia({reducedMotion:'reduce'});await atBottom();const before=(await motionCalls()).length;
   await app.evaluate((_,text)=>{const state=globalThis.__chatMotionFixture;state.extras.push({id:'reduced-motion-result',role:'assistant',text});},longText('Reduced motion result',8));
   await publish();await page.locator('[data-message-id="reduced-motion-result"]').waitFor();
   assert.equal((await motionCalls()).length,before);assert.ok((await metrics()).max-(await metrics()).top<3);
   assert.equal(await page.locator('#composer-input').inputValue(),'Preserve this next draft.');
   assert.deepEqual(errors,[]);assert.deepEqual(network,[]);assert.deepEqual(await app.evaluate(()=>globalThis.__chatMotionFixture.native),[]);
  });
 }finally{
  fs.writeFileSync(path.join(evidence,'chat-motion-tests.json'),JSON.stringify({at:new Date().toISOString(),checks,errors,network,profile,scope:'Isolated native fixture only; actual fixture send, controlled history and browser motion; no production state'},null,2));
  await app.close();
 }
 console.log(JSON.stringify({passed:checks.filter(item=>item.pass).length,failed:checks.filter(item=>!item.pass).length,profile}));process.exitCode=checks.some(item=>!item.pass)?1:0;
})().catch(error=>{console.error(error);process.exitCode=1;});
