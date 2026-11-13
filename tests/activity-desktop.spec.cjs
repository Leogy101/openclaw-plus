'use strict';
const {_electron}=require('./test-support.cjs').playwright;
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),evidence=require('./test-support.cjs').evidenceDirectory('activity');fs.mkdirSync(evidence,{recursive:true});
const profile=fs.mkdtempSync(path.join(evidence,'fixture-profile-'));
const env={...process.env,OPENCLAW_PLUS_TEST_DATA:profile,OPENCLAW_PLUS_TEST_CLI:path.join(root,'tests/fixture-gateway.cjs')};delete env.ELECTRON_RUN_AS_NODE;
(async()=>{
 const app=await _electron.launch({executablePath:path.join(root,'desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[path.join(root,'desktop')],env});
 const page=await app.firstWindow();page.setDefaultTimeout(10000);
 const errors=[],network=[],checks=[];page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(/^(?:https?|wss?):/.test(request.url()))network.push(request.url());});
 await app.evaluate(({ipcMain,BrowserWindow,shell,clipboard})=>{
  const window=BrowserWindow.getAllWindows()[0];window.setSize(1440,1000);
  const state=globalThis.__activityFixture={mode:'working',calls:[],native:[],holdKey:null,releases:[],eventTime:Date.now()};
  const original=ipcMain._invokeHandlers.get('gateway:request'),send=window.webContents.send.bind(window.webContents);
  state.publish=event=>send('gateway:event',event);
  // Isolate monitor behavior from unrelated host poll timers in this fixture process.
  window.webContents.send=(channel,event,...rest)=>{if(channel==='gateway:event'&&['sessions','activity'].includes(event?.kind))return;return send(channel,event,...rest);};
  ipcMain.removeHandler('gateway:request');ipcMain.handle('gateway:request',async(event,operation,params)=>{
   state.calls.push({operation,params});if(operation==='composerOptions')return {ok:true,data:{models:[{value:'fixture/model',label:'Fixture model',available:true,manualSelectionAllowed:true,thinkingLevels:[{id:'high',label:'High'}]}],current:{model:'fixture/model',thinkingLevel:'high'},modelSelectionLocked:false,limitations:[]}};if(operation!=='activity')return original(event,operation,params);
   if(params.key===state.holdKey)await new Promise(resolve=>state.releases.push(resolve));
   const now=Date.now(),working=['working','short','other-session'].includes(state.mode),scheduled=['scheduled','scoped-scheduled'].includes(state.mode),blocked=['blocked','approval'].includes(state.mode),paused=state.mode==='paused',completed=state.mode==='completed';
   const events=Array.from({length:15},(_,i)=>({id:'event-'+String(i).padStart(2,'0'),timestamp:state.eventTime-i*1000,type:i%3===0?'status_report':'tool_result',agentId:i%2?'builder':'main',description:i===0?'Reported status update':`Fixture engineering event ${i}`,result:i===11?'<script>window.activityIntruded=true</script>':'Recorded fixture result',classification:i%3===0?'status':'engineering',source:i%3===0?'Status report':'Tool receipt'}));
   const summary=id=>({agentId:id,scope:'Selected conversation and linked delegates',state:working?'working':scheduled?'scheduled':blocked?'blocked':paused?'paused':completed?'completed':'unknown',label:working?(id==='main'?'WORKING · TEAM':'WORKING'):scheduled?'SCHEDULED':blocked?'BLOCKED':paused?'PAUSED':completed?'COMPLETED':'UNKNOWN',detail:working?(id==='main'?'Builder is executing a verified test command.':'Current tool evidence reports test execution.'):scheduled?'No current execution; the next schedule is reported.':blocked?'A technical blocker is reported, not independently verified.':'Execution is not verified.',working,teamWorking:working&&id==='main',ownWorking:working&&id!=='main',current:working?[{id:'active-1',agentId:'builder',sessionKey:'agent:builder:child',sessionId:'physical-child',runId:'run-builder',title:'Run test suite',classification:'engineering',startedAt:now-4000}]:[],blockers:blocked?[state.mode==='approval'?{kind:'authorization',reason:'An execution is awaiting your approval.',source:'Pending approval'}:{kind:'technical',reason:'Native goal reported a verification failure.',source:'Native goal report · unverified',nextStep:'Review the recorded failure.'}]:[],lastEngineering:events[1],lastCompleted:events[2],lastStatus:events[0],nextScheduled:scheduled?{at:now+300000,jobId:'job-1',name:'Workspace index'}:null,recovery:'Unverified'});
   return {ok:true,data:{context:{key:params.key,agentId:params.agentId,sessionId:params.sessionId},observedAt:now,freshUntil:now+(state.mode==='short'?350:45000),summary:state.mode==='other-session'?{...summary(params.agentId),state:'unknown',label:'UNKNOWN IN SELECTED SESSION',detail:'Execution is not verified in this selected session.',working:false,ownWorking:false,teamWorking:false,current:[]}:summary(params.agentId),agents:['main','builder','reviewer','researcher','assistant-c','assistant-b','assistant-a'].map(id=>state.mode==='scoped-scheduled'?{...summary(id),state:'unknown',label:'UNKNOWN',detail:'Agent-wide coverage is incomplete.',nextScheduled:null}:summary(id)),timeline:{items:params.cursor?[events[11],...events.slice(12)]:events.slice(0,12),...(params.cursor?{}:{nextCursor:'page-2'})},project:{sourcePath:'/Volumes/Fixture/owner-cursor.json',updatedAt:now,fields:[{path:'phase',value:'Fixture phase'}],currentBlocker:'unselected',limitations:['Project report has no verified blocker selection.']},limitations:['Fixture observations cover only supplied runtime records.']}};
  });
  shell.openExternal=async value=>{state.native.push(['external',value]);};shell.showItemInFolder=value=>state.native.push(['reveal',value]);clipboard.writeText=value=>state.native.push(['copy',value]);
 });
 const check=async(name,fn)=>{try{await fn();checks.push({name,pass:true});console.log('PASS',name);}catch(error){checks.push({name,pass:false,error:error.message});console.log('FAIL',name,error.message);await page.screenshot({path:path.join(evidence,'failure-'+checks.length+'.png')}).catch(()=>{});}};
 const calls=()=>app.evaluate(()=>globalThis.__activityFixture.calls);
 const count=async operation=>(await calls()).filter(call=>call.operation===operation).length;
 const mode=value=>app.evaluate((_,value)=>{globalThis.__activityFixture.mode=value;},value);
 const refresh=async()=>{await page.getByRole('button',{name:'Refresh activity',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#activity-current [data-action="refresh-activity"]')?.getAttribute('aria-busy')==='false');};
 const publish=event=>app.evaluate((_,event)=>globalThis.__activityFixture.publish(event),event);
 const menu=id=>app.evaluate(({Menu},id)=>Menu.getApplicationMenu().getMenuItemById(id).click(),id);
 try{
 await page.reload();await page.getByText('Coordinator is coordinating.',{exact:true}).waitFor();
 if(!await page.locator('#work-panel').isVisible())await page.locator('#toggle-work').click();
 await check('Fresh source activity appears in header, Work and agent badges without guessing progress',async()=>{
  await page.locator('#activity-header .is-working').waitFor();await page.getByText('Run test suite',{exact:true}).first().waitFor();
  assert.match(await page.locator('#activity-header button').getAttribute('title'),/Confirmed work by Builder/);
  assert.ok(await page.getByText('Project work status could not be verified.',{exact:true}).isVisible());
  assert.match(await page.locator('#activity-current').textContent(),/elapsed/);
  assert.match(await page.locator('#activity-facts').textContent(),/Recovery status unknown/);
  assert.equal(await page.locator('#activity-facts details[open]').count(),0);
  assert.equal(await page.locator('[data-activity-event]').count(),3);
  const panel=await page.locator('#work-scroll').boundingBox(),last=await page.locator('[data-activity-event]').nth(2).boundingBox();assert.ok(last.y+last.height<=panel.y+panel.height,'all three recent events should fit near the top');
  await page.locator('#activity-facts summary').filter({hasText:'Execution details'}).click();
  assert.ok(await page.getByText('Scope: Selected conversation and linked delegates',{exact:true}).isVisible());
  assert.match(await page.locator('#activity-facts').textContent(),/run-builder/);
  await page.locator('#activity-facts summary').filter({hasText:'Execution details'}).click();
  await page.locator('#activity-facts summary').filter({hasText:'Latest project update'}).click();
  assert.match(await page.locator('#activity-facts').textContent(),/separate from the selected conversation/);
  assert.doesNotMatch(await page.locator('#activity-facts').textContent(),/update from Coordinator/i);
  await page.locator('#activity-facts summary').filter({hasText:'Latest project update'}).click();
  await page.locator('#work-scroll').evaluate(node=>node.scrollTop=0);
  await page.screenshot({path:path.join(evidence,'activity-working-dark.png')});
  await menu('view:Agents');await page.locator('[data-activity-agent="main"] .is-working').waitFor();
  assert.equal(await page.locator('[data-activity-agent]').count(),7);await menu('view:Conversations');
 });
 await check('Conversation header and visible Unknown reason use exact session evidence while agent cards retain broader work',async()=>{
  await mode('other-session');await refresh();
  assert.equal(await page.locator('#activity-header .is-working').count(),0);
  assert.equal(await page.locator('#activity-header [data-activity-state="unknown"]').count(),1);
  assert.equal(await page.locator('#activity-current > [data-activity-state="unknown"]').count(),1);
  assert.equal(await page.locator('#activity-current .activity-detail').textContent(),'Execution is not verified in this selected session.');
  assert.match(await page.locator('#activity-header button').getAttribute('title'),/Selected conversation.*Workspace review.*Execution is not verified in this selected session/s);
  assert.match(await page.locator('#activity-header .activity-badge').getAttribute('title'),/Selected conversation/);
  await menu('view:Agents');assert.equal(await page.locator('[data-activity-agent="main"] .is-working').count(),1);await menu('view:Conversations');
  await mode('working');await refresh();
 });
 await check('Known Scheduled conversation remains Scheduled in the header when broader agent coverage is Unknown',async()=>{
  await mode('scoped-scheduled');await refresh();
  assert.equal(await page.locator('#activity-header [data-activity-state="scheduled"]').count(),1);
  assert.equal(await page.locator('#activity-current > [data-activity-state="scheduled"]').count(),1);
  assert.match(await page.locator('#activity-header button').getAttribute('title'),/Selected conversation.*Next run: Workspace index/s);
  assert.equal(await page.locator('#activity-header .is-working').count(),0);
  await page.screenshot({path:path.join(evidence,'activity-scoped-scheduled.png')});
  await menu('view:Agents');assert.equal(await page.locator('[data-activity-agent="main"] [data-activity-state="unknown"]').count(),1);await menu('view:Conversations');
  assert.equal(await page.locator('#activity-header [data-activity-state="scheduled"]').count(),1);
  await mode('working');await refresh();
 });
 await check('Timeline initially shows three events, expands locally, then merges a cursor page by identity',async()=>{
  assert.equal(await page.locator('[data-activity-event]').count(),3);const before=await count('activity');
  await page.getByRole('button',{name:'Show older activity',exact:true}).click();assert.equal(await page.locator('[data-activity-event]').count(),12);assert.equal(await count('activity'),before);
  await page.getByRole('button',{name:'Show older activity',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('[data-activity-event]').length===15);
  assert.equal(await count('activity'),before+1);assert.equal(new Set(await page.locator('[data-activity-event]').evaluateAll(nodes=>nodes.map(node=>node.dataset.activityEvent))).size,15);
  assert.equal(await page.getByRole('button',{name:'Show older activity',exact:true}).count(),0);
  assert.ok((await calls()).some(call=>call.operation==='activity'&&call.params.cursor==='page-2'));
  assert.equal(await page.evaluate(()=>window.activityIntruded),undefined);assert.equal(await page.locator('#activity-timeline script').count(),0);assert.match(await page.locator('[data-activity-event="event-11"]').textContent(),/<script>window.activityIntruded=true<\/script>/);
 });
 await check('Monitor refresh preserves transcript DOM, draft, disclosure and focus without a history read',async()=>{
  await page.locator('#composer-input').fill('Activity refresh must preserve this draft.');
  await page.locator('#messages details').first().evaluate(node=>node.open=true);
  await page.evaluate(()=>{window.__messageNode=document.querySelector('#messages article');window.__timelineNode=document.querySelector('#activity-timeline');});
  const historyBefore=await count('history');await refresh();
  assert.equal(await count('history'),historyBefore);assert.equal(await page.locator('#composer-input').inputValue(),'Activity refresh must preserve this draft.');
  assert.equal(await page.evaluate(()=>document.querySelector('#messages article')===window.__messageNode),true);
  assert.equal(await page.locator('#messages details').first().getAttribute('open'),'');
  assert.equal(await page.evaluate(()=>document.activeElement?.dataset.action),'refresh-activity');
  const monitorBefore=await count('activity');await publish({kind:'sessions'});await page.waitForTimeout(650);
  assert.equal(await count('activity'),monitorBefore,'the three-second session-refresh path must not fetch activity');
  assert.equal(await page.evaluate(()=>document.querySelector('#activity-timeline')===window.__timelineNode),true);
 });
 await check('Scheduled and reported technical-blocker states do not animate as engineering execution',async()=>{
  await mode('scheduled');await refresh();assert.equal(await page.locator('#activity-header .is-working').count(),0);assert.match(await page.locator('#activity-current').textContent(),/Workspace index/);
  await mode('blocked');await refresh();assert.equal(await page.locator('#activity-header .is-working').count(),0);
  assert.match(await page.locator('#activity-current').textContent(),/Technical issue/);assert.match(await page.locator('#activity-current').textContent(),/no approval request confirmed/);
  assert.equal(await page.locator('#activity-header [data-activity-state="blocked"]').count(),1);
 });
 await check('Approval, paused and completion presentations preserve their distinct evidence and attention',async()=>{
  await mode('approval');await refresh();assert.ok(await page.getByText('Approval requested.',{exact:false}).isVisible());assert.ok(await page.getByRole('button',{name:'Review approvals',exact:true}).isVisible());assert.equal(await page.locator('#activity-header .is-working').count(),0);
  await mode('paused');await refresh();assert.equal(await page.locator('#activity-header [data-activity-state="paused"]').count(),1);assert.ok(await page.getByText('A pause or stop is recorded.',{exact:true}).isVisible());
  await mode('completed');await refresh();assert.equal(await page.locator('#activity-header [data-activity-state="completed"]').count(),1);assert.ok(await page.getByText('An execution finished. Project completion is not verified.',{exact:true}).isVisible());
 });
 await check('Freshness expiry stops animation locally without another monitor request',async()=>{
  await mode('short');await refresh();await page.locator('#activity-header .is-working').waitFor();const before=await count('activity');
  await page.waitForFunction(()=>document.querySelector('#activity-header [data-activity-state="unknown"]'));
  assert.equal(await page.locator('#activity-header .is-working').count(),0);assert.equal(await count('activity'),before);
  assert.match(await page.locator('#activity-current').textContent(),/Last observed|could not be verified/);
 });
 await check('Disconnected observations stop animation while retaining the timeline',async()=>{
  await mode('working');await refresh();const events=await page.locator('[data-activity-event]').count();
  await publish({kind:'connection',connection:{status:'disconnected',message:'Fixture disconnected'}});
  await page.waitForFunction(()=>document.querySelector('#activity-header [data-activity-state="disconnected"]'));
  assert.equal(await page.locator('#activity-header .is-working').count(),0);assert.equal(await page.locator('[data-activity-event]').count(),events);
  await publish({kind:'connection',connection:{status:'connected',message:'Fixture connected'}});await refresh();
 });
 await check('Delegated navigation keeps Work activity context and restores the original draft',async()=>{
  await page.locator('#work-content [data-action="session"]').first().click();await page.getByText('Builder exact child history',{exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector('#activity-header button')?.getAttribute('aria-label').startsWith('Builder activity'));
  assert.match(await page.locator('#activity-current .activity-heading').textContent(),/^Coordinator/);
  assert.equal(await page.locator('#composer-input').inputValue(),'');
  await page.getByRole('button',{name:'Back to Coordinator'}).click();await page.getByText('Coordinator is coordinating.',{exact:true}).waitFor();
  assert.equal(await page.locator('#composer-input').inputValue(),'Activity refresh must preserve this draft.');
 });
 await check('Dark and light layouts preserve the compact timeline at 1440, 1100 and 880 without horizontal overflow',async()=>{
  await page.reload();await page.getByText('Coordinator is coordinating.',{exact:true}).waitFor();await page.locator('#activity-header .is-working').waitFor();await page.waitForFunction(()=>document.querySelector('#composer-model')?.value==='fixture/model');await page.locator('.source-plan[open]').waitFor();
  assert.equal(await page.locator('[data-activity-event]').count(),3);
  for(const [width,height,theme] of [[1440,1000,'dark'],[1100,850,'light'],[880,760,'light']]){
   await menu('theme:'+theme);await app.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows()[0].setSize(...size),[width,height]);
   if(!await page.locator('#work-panel').isVisible())await page.locator('#toggle-work').click();
   await page.waitForFunction(width=>innerWidth===width,width);await page.waitForFunction(width=>(document.querySelector('#work-panel')?.getAttribute('role')==='dialog')===(width<1280),width);await page.locator('#work-scroll').evaluate(node=>node.scrollTop=0);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   assert.equal(await page.locator('#work-scroll').evaluate(node=>node.scrollWidth>node.clientWidth),false);
   await page.screenshot({path:path.join(evidence,`activity-polish-${theme}-${width}.png`)});
  }
  assert.equal(await page.locator('#work-panel').getAttribute('role'),'dialog');
  assert.equal(await page.evaluate(()=>window.activityIntruded),undefined);assert.equal(await page.locator('#activity-timeline script,#activity-current script,#activity-facts script').count(),0);
  await page.keyboard.press('Escape');assert.equal(await page.locator('#work-panel').isVisible(),false);
  assert.deepEqual(errors,[]);assert.deepEqual(network,[]);assert.deepEqual(await app.evaluate(()=>globalThis.__activityFixture.native),[]);
 });
 }finally{
  await app.evaluate(()=>globalThis.__activityFixture.releases.splice(0).forEach(resolve=>resolve())).catch(()=>{});
  fs.writeFileSync(path.join(evidence,'activity-tests.json'),JSON.stringify({at:new Date().toISOString(),checks,errors,network,profile,scope:'Native fixture UI and normalized activity view only; no production access or mutations'},null,2));
  await app.close();
 }
 console.log(JSON.stringify({passed:checks.filter(item=>item.pass).length,failed:checks.filter(item=>!item.pass).length,profile}));process.exitCode=checks.some(item=>!item.pass)?1:0;
})().catch(error=>{console.error(error);process.exitCode=1;});
