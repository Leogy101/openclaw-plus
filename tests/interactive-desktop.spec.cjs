'use strict';
const {_electron}=require('./test-support.cjs').playwright;
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),evidence=require('./test-support.cjs').evidenceDirectory('interactive');
fs.mkdirSync(evidence,{recursive:true});
const profile=fs.mkdtempSync(path.join(evidence,'fixture-profile-'));
const env={...process.env,OPENCLAW_PLUS_TEST_DATA:profile,OPENCLAW_PLUS_TEST_CLI:path.join(root,'tests/fixture-gateway.cjs')};
delete env.ELECTRON_RUN_AS_NODE;
const calls=()=>fs.existsSync(path.join(profile,'fixture-calls.jsonl'))?fs.readFileSync(path.join(profile,'fixture-calls.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
const count=method=>calls().filter(call=>call.method===method).length;
const fixture=()=>fs.existsSync(path.join(profile,'fixture-state.json'))?JSON.parse(fs.readFileSync(path.join(profile,'fixture-state.json'),'utf8')):null;
(async()=>{
 const application=await _electron.launch({executablePath:path.join(root,'desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[path.join(root,'desktop')],env});
 const page=await application.firstWindow();page.setDefaultTimeout(12000);
 const errors=[],requests=[],checks=[];page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(/^(?:https?|wss?):/.test(request.url()))requests.push(request.url());});
 await application.evaluate(({ipcMain,shell,clipboard,BrowserWindow})=>{
  BrowserWindow.getAllWindows()[0].setSize(1440,1000);
  const original=ipcMain._invokeHandlers.get('gateway:request');
  const state=globalThis.__interactiveFixture={received:[],historyReads:[],planMode:'source',holdPlan:false,planReleases:[],planRequests:0,rejectSend:false,holdSend:false,releases:[],holdApprovals:false,approvalReleases:[],approvalRequests:0,lastApprovalItems:[],nativeEffects:[],refreshEvents:0,overviewResponses:0};
  const contents=BrowserWindow.getAllWindows()[0].webContents,send=contents.send.bind(contents);
  contents.send=(channel,event,...rest)=>{if(channel==='gateway:event'&&event?.kind==='sessions')state.refreshEvents++;return send(channel,event,...rest);};
  ipcMain.removeHandler('gateway:request');
  ipcMain.handle('gateway:request',async(event,operation,params)=>{
   if(['send','abort','resolveApproval','saveSettings'].includes(operation))state.received.push({operation,params});
   if(operation==='history')state.historyReads.push(structuredClone(params));
   if(operation==='send'&&state.rejectSend){state.rejectSend=false;return {ok:false,error:{code:'CONFLICT',message:'Fixture branch changed',uncertain:false}};}
   if(operation==='send'&&state.holdSend)await new Promise(resolve=>state.releases.push(resolve));
   if(operation==='plan'&&state.planMode==='empty'){state.planRequests++;if(state.holdPlan)await new Promise(resolve=>state.planReleases.push(resolve));return {ok:true,data:{card:null}};}
   if(operation==='approvals'){state.approvalRequests++;if(state.holdApprovals)await new Promise(resolve=>state.approvalReleases.push(resolve));}
   const result=await original(event,operation,params);
   if(operation==='approvals'&&result?.ok)state.lastApprovalItems=result.data.items;
   if(operation==='overview'&&result?.ok)state.overviewResponses++;
   return result;
  });
  shell.openExternal=async value=>{state.nativeEffects.push(['openExternal',value]);throw new Error('External opens are not permitted in this fixture test');};
  shell.showItemInFolder=value=>{state.nativeEffects.push(['reveal',value]);};
  clipboard.writeText=value=>{state.nativeEffects.push(['copy',value]);};
 });
 const check=async(name,fn)=>{try{await fn();checks.push({name,pass:true});console.log('PASS',name);}catch(error){checks.push({name,pass:false,error:error.message});console.log('FAIL',name,error.message);await page.screenshot({path:path.join(evidence,'failure-'+checks.length+'.png')}).catch(()=>{});}};
 const menu=id=>application.evaluate(({Menu},id)=>Menu.getApplicationMenu().getMenuItemById(id).click(),id);
 const publish=event=>application.evaluate(({BrowserWindow},event)=>BrowserWindow.getAllWindows()[0].webContents.send('gateway:event',event),event);
 const received=()=>application.evaluate(()=>globalThis.__interactiveFixture.received);
 const waitMain=async predicate=>{const deadline=Date.now()+8000;while(!await application.evaluate(predicate)){if(Date.now()>deadline)throw new Error('Fixture main-state wait timed out');await page.waitForTimeout(30);}};
 const closeModal=async()=>{if(await page.locator('#overlay [role="dialog"]').count())await page.keyboard.press('Escape');};
 const openApprovals=async()=>{await closeModal();await page.locator('#primary-nav [data-view="Approvals"]').click();await page.locator('.approval-card').waitFor();};
 try{
 await check('Connected native fixture exposes an explicit source checklist above its composer',async()=>{
  await page.getByText('Coordinator is coordinating.',{exact:true}).waitFor();
  await page.locator('.source-plan[open]').waitFor();
  assert.equal(page.url(),'openclaw-plus://ui/index.html');
  assert.deepEqual(await page.evaluate(()=>[typeof require,typeof process]),['undefined','undefined']);
  const steps=page.locator('.plan-step');assert.equal(await steps.count(),3);
  assert.match(await steps.nth(0).textContent(),/Inspect implementation.*Completed/s);
  assert.match(await steps.nth(1).textContent(),/Implement requested changes.*In progress/s);
  assert.match(await steps.nth(2).textContent(),/Verify behavior.*Remaining/s);
  const plan=await page.locator('#plan-region').boundingBox(),composer=await page.locator('.composer').boundingBox();assert.ok(plan.y+plan.height<=composer.y+1);
  await page.locator('.source-plan>summary').click();await publish({kind:'sessions'});await page.waitForTimeout(700);
  assert.equal(await page.locator('.source-plan').getAttribute('open'),null);
  assert.ok(await page.getByText('Current: Implement requested changes',{exact:true}).isVisible());
  await page.locator('.source-plan>summary').click();
  await page.screenshot({path:path.join(evidence,'conversation-checklist-composer.png')});
 });
 await check('Drafts stay bound to exact sessions across delegated navigation and Back',async()=>{
  await page.locator('#composer-input').fill('Coordinator draft stays here.');
  if(!await page.locator('#work-panel').isVisible())await page.locator('#toggle-work').click();
  await page.locator('#work-content [data-action="session"]').first().click();
  await page.getByText('Builder exact child history',{exact:true}).waitFor();
  assert.equal(await page.locator('#composer-input').inputValue(),'');
  await page.locator('#composer-input').fill('Builder draft stays here.');
  await page.getByRole('button',{name:'Back to Coordinator'}).click();
  await page.getByText('Coordinator is coordinating.',{exact:true}).waitFor();
  assert.equal(await page.locator('#composer-input').inputValue(),'Coordinator draft stays here.');
  await page.locator('#work-content [data-action="session"]').first().click();
  await page.getByText('Builder exact child history',{exact:true}).waitFor();
  assert.equal(await page.locator('#composer-input').inputValue(),'Builder draft stays here.');
 });
 await check('Enter sends one exact session request; repeated in-flight sends cannot duplicate it',async()=>{
  await page.locator('#composer-input').fill('Fixture-only message for Builder.');
  await page.waitForFunction(()=>!document.querySelector('#send-message').disabled);
  await application.evaluate(()=>{globalThis.__interactiveFixture.holdSend=true;});
  await page.locator('#composer-input').press('Enter');
  await page.waitForFunction(()=>document.querySelector('#send-message')?.textContent.includes('Sending'));
  await page.locator('#send-message').dispatchEvent('click');await page.locator('#send-message').dispatchEvent('click');
  await page.locator('#composer-input').press('Enter');
  const submitted=(await received()).filter(item=>item.operation==='send');assert.equal(submitted.length,1);
  assert.equal(submitted[0].params.key,'agent:builder:child');assert.equal(submitted[0].params.agentId,'builder');
  assert.equal(submitted[0].params.sessionId,'physical-child');assert.equal(submitted[0].params.expectedLeafEntryId,'leaf-1');
  assert.match(submitted[0].params.requestId,/^[a-f\d-]{36}$/i);assert.equal(count('chat.send'),0);
  // A later draft must survive acknowledgement of the earlier submission.
  await page.locator('#composer-input').fill('Next Builder draft.');
  await application.evaluate(()=>{const state=globalThis.__interactiveFixture;state.holdSend=false;state.releases.splice(0).forEach(resolve=>resolve());});
  await page.getByText('Fixture reply received.',{exact:true}).waitFor();
  assert.equal(count('chat.send'),1);const sent=fixture().sent;assert.equal(sent.length,1);
  assert.equal(sent[0].sessionKey,'agent:builder:child');assert.equal(sent[0].sessionId,'physical-child');assert.equal(sent[0].agentId,'builder');
  assert.equal(sent[0].expectedLeafEntryId,'leaf-1');assert.equal(sent[0].idempotencyKey,submitted[0].params.requestId);
  assert.equal(sent[0].message,'Fixture-only message for Builder.');assert.equal(await page.locator('#composer-input').inputValue(),'Next Builder draft.');
  const readback=await application.evaluate(()=>globalThis.__interactiveFixture.historyReads.filter(params=>params.foreground===true));
  assert.deepEqual(readback,[{key:'agent:builder:child',agentId:'builder',sessionId:'physical-child',offset:0,foreground:true}]);
  assert.ok(calls().filter(call=>call.method==='chat.history').every(call=>!Object.hasOwn(call.params,'foreground')));
 });
 await check('Shift Enter creates a newline without a request',async()=>{
  const before=(await received()).length;
  await page.locator('#composer-input').fill('Line one');await page.locator('#composer-input').press('Shift+Enter');await page.locator('#composer-input').pressSequentially('Line two');
  assert.equal(await page.locator('#composer-input').inputValue(),'Line one\nLine two');assert.equal((await received()).length,before);
 });
 await check('Structured pre-mutation rejection survives the bridge and preserves the draft without a write',async()=>{
  const before=count('chat.send');await application.evaluate(()=>{globalThis.__interactiveFixture.rejectSend=true;});
  await page.locator('#composer-input').fill('Preserve this conflicted draft.');
  await page.waitForFunction(()=>!document.querySelector('#send-message').disabled);
  await page.locator('#composer-input').press('Enter');
  await page.waitForFunction(()=>document.querySelector('#composer-status')?.textContent.includes('Message was not sent.'));
  assert.match(await page.locator('#composer-status').textContent(),/Fixture branch changed/);
  assert.doesNotMatch(await page.locator('#composer-status').textContent(),/unconfirmed/i);
  assert.equal(await page.locator('#composer-input').inputValue(),'Preserve this conflicted draft.');
  assert.equal(count('chat.send'),before);assert.equal(await application.evaluate(()=>globalThis.__interactiveFixture.rejectSend),false);
 });
 await check('Approval review shows command and host and makes no decision until final confirmation',async()=>{
  await application.evaluate(()=>{globalThis.__interactiveFixture.holdApprovals=true;});
  await openApprovals();await waitMain(()=>globalThis.__interactiveFixture.approvalReleases.length===1);
  assert.equal(await page.getByRole('button',{name:'Allow once',exact:true}).isDisabled(),true,'cached approval decisions must be disabled during an explicit fresh read');
  // An explicit request arriving during a read must queue another authoritative read.
  await page.locator('#primary-nav [data-view="Approvals"]').click();
  await application.evaluate(()=>{globalThis.__interactiveFixture.approvalReleases.shift()();});
  await waitMain(()=>globalThis.__interactiveFixture.approvalReleases.length===1);
  assert.equal(await page.getByRole('button',{name:'Allow once',exact:true}).isDisabled(),true,'a queued explicit read must keep decisions disabled');
  await application.evaluate(()=>{const state=globalThis.__interactiveFixture;state.holdApprovals=false;state.approvalReleases.splice(0).forEach(resolve=>resolve());});
  const before=count('approval.resolve');
  await page.getByRole('button',{name:'Allow once',exact:true}).click();
  const dialog=page.locator('#overlay [role="dialog"]');await dialog.waitFor();
  assert.ok((await dialog.textContent()).includes('printf fixture'));assert.ok((await dialog.textContent()).includes('gateway'));
  assert.ok((await dialog.textContent()).includes('Execution scope'));await dialog.getByText('Full review details',{exact:true}).click();
  assert.match(await dialog.locator('.approval-review-details pre').textContent(),/commandText/);
  assert.equal(count('approval.resolve'),before);assert.equal((await received()).filter(item=>item.operation==='resolveApproval').length,0);
  const reviewedToken=await application.evaluate(()=>globalThis.__interactiveFixture.lastApprovalItems[0]?.reviewToken);assert.ok(reviewedToken);
  await page.screenshot({path:path.join(evidence,'approval-review.png')});
  await dialog.getByRole('button',{name:'Allow once',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('#overlay [role="dialog"]'));
  assert.equal(count('approval.resolve'),before+1);assert.equal(fixture().approvalStatus,'allowed');
  const call=calls().find(item=>item.method==='approval.resolve');assert.equal(call.params.id,'approval-fixture');assert.equal(call.params.decision,'allow-once');
  assert.equal((await received()).find(item=>item.operation==='resolveApproval').params.reviewToken,reviewedToken,'the final decision must retain the original reviewed token');
 });
 await check('Configuration loads redacted and dirty edits survive actual periodic polling and navigation',async()=>{
  await menu('settings');await page.locator('.settings-advanced>summary').click();
  assert.equal(count('config.get'),0);await page.getByRole('button',{name:'Load configuration',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('#settings-editor').disabled);
  const loaded=JSON.parse(await page.locator('#settings-editor').inputValue());assert.equal(loaded.models.apiKey,'__OPENCLAW_REDACTED__');
  loaded.ui.name='After';const raw=JSON.stringify(loaded,null,2);await page.locator('#settings-editor').fill(raw);
  // A normal refresh may legitimately reuse the 12-second gateway read cache.
  // Observe the real host event and completed renderer request, not another CLI read.
  await application.evaluate(()=>{const state=globalThis.__interactiveFixture;state.refreshStart=state.refreshEvents;state.overviewStart=state.overviewResponses;});
  await waitMain(()=>{const state=globalThis.__interactiveFixture;return state.refreshEvents>state.refreshStart&&state.overviewResponses>state.overviewStart;});
  assert.equal(await page.locator('#settings-editor').inputValue(),raw);assert.equal(count('config.patch'),0);
  await menu('view:Agents');await menu('settings');await page.locator('.settings-advanced>summary').click();
  assert.equal(await page.locator('#settings-editor').inputValue(),raw);assert.equal(count('config.patch'),0);
 });
 await check('Configuration review is inert until confirmation; saving sends a minimal hash-bound patch',async()=>{
  await page.getByRole('button',{name:'Review changes',exact:true}).click();
  const dialog=page.locator('#overlay [role="dialog"]');await dialog.waitFor();
  assert.match(await dialog.textContent(),/may restart the gateway/);assert.match(await dialog.textContent(),/After/);
  assert.equal(count('config.patch'),0);assert.equal((await received()).filter(item=>item.operation==='saveSettings').length,0);
  await page.screenshot({path:path.join(evidence,'settings-review.png')});
  await dialog.getByRole('button',{name:'Save configuration',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('#overlay [role="dialog"]'));
  assert.equal(count('config.patch'),1);const patch=calls().find(item=>item.method==='config.patch').params;
  assert.equal(patch.baseHash,'fixture-hash');assert.deepEqual(JSON.parse(patch.raw),{ui:{name:'After'}});
  assert.equal(fixture().config.models.apiKey,'__OPENCLAW_REDACTED__');assert.equal(fixture().config.ui.name,'After');
 });
 await check('Disconnect disables sends and preserves the exact-session draft through reconnect',async()=>{
  await menu('view:Conversations');await page.locator('#composer-input').fill('Keep this offline draft.');
  const before=count('chat.send');fs.writeFileSync(path.join(profile,'offline'),'fixture only');
  await page.locator('#connection-notice [data-action="reconnect"]').click();
  await page.waitForFunction(()=>document.querySelector('#connection-button')?.textContent.includes('disconnected'));
  assert.equal(await page.locator('#send-message').isDisabled(),true);await page.locator('#composer-input').press('Enter');
  assert.equal(count('chat.send'),before);assert.equal(await page.locator('#composer-input').inputValue(),'Keep this offline draft.');
  fs.unlinkSync(path.join(profile,'offline'));await page.locator('#connection-notice [data-action="reconnect"]').click();
  await page.waitForFunction(()=>document.querySelector('#connection-button')?.textContent.includes('Connected'));
  assert.equal(await page.locator('#composer-input').inputValue(),'Keep this offline draft.');
 });
 await check('Unsupported mutations and malformed operations are rejected with no fixture write',async()=>{
  const before=count('chat.send')+count('approval.resolve')+count('config.patch');
  const rejected=await page.evaluate(async()=>Promise.all([
   window.openclawPlusDesktop.gateway('config.set',{}).then(result=>result?.ok===false,()=>true),
   window.openclawPlusDesktop.gateway('chat.send',{}).then(result=>result?.ok===false,()=>true),
   window.openclawPlusDesktop.gateway('resolveApproval',{id:'x',kind:'exec',decision:'invented'}).then(result=>result?.ok===false,()=>true),
   window.openclawPlusDesktop.gateway('saveSettings',{baseHash:'x',raw:'{}',method:'config.set'}).then(result=>result?.ok===false,()=>true),
  ]));assert.ok(rejected.every(Boolean));assert.equal(count('chat.send')+count('approval.resolve')+count('config.patch'),before);
 });
 await check('Slow checklist reads settle and preserve a known empty state during background refresh',async()=>{
  await closeModal();await menu('view:Conversations');
  await application.evaluate(()=>{const state=globalThis.__interactiveFixture;state.planMode='empty';state.holdPlan=true;state.planRequests=0;});
  await page.locator('#session-list [data-action="session"]').filter({hasText:'Other Builder session'}).click();
  await waitMain(()=>globalThis.__interactiveFixture.planReleases.length===1);
  await page.getByText('Reading the task checklist…',{exact:true}).waitFor();
  await page.waitForTimeout(5200);
  assert.equal(await application.evaluate(()=>globalThis.__interactiveFixture.planRequests),1,'a slow initial read must not overlap another plan request');
  await application.evaluate(()=>{globalThis.__interactiveFixture.planReleases.shift()();});
  await page.getByText('No task checklist supplied for this conversation.',{exact:true}).waitFor();
  await publish({kind:'sessions'});await page.waitForTimeout(650);
  assert.equal(await application.evaluate(()=>globalThis.__interactiveFixture.planRequests),1,'the five-second polling interval must start when the slow read finishes');
  await page.waitForTimeout(5200);await publish({kind:'sessions'});
  await waitMain(()=>globalThis.__interactiveFixture.planReleases.length===1);
  assert.equal(await application.evaluate(()=>globalThis.__interactiveFixture.planRequests),2);
  assert.ok(await page.getByText('No task checklist supplied for this conversation.',{exact:true}).isVisible());
  assert.equal(await page.getByText('Reading the task checklist…',{exact:true}).count(),0,'a known empty result must stay visible during a background refresh');
  await publish({kind:'sessions'});await publish({kind:'plan'});await page.waitForTimeout(650);
  assert.equal(await application.evaluate(()=>globalThis.__interactiveFixture.planRequests),2,'the held background refresh must not overlap another request');
  await application.evaluate(()=>{const state=globalThis.__interactiveFixture;state.holdPlan=false;state.planReleases.splice(0).forEach(resolve=>resolve());});
  await page.waitForTimeout(100);await publish({kind:'sessions'});await page.waitForTimeout(650);
  assert.equal(await application.evaluate(()=>globalThis.__interactiveFixture.planRequests),2);
  assert.ok(await page.getByText('No task checklist supplied for this conversation.',{exact:true}).isVisible());
  await application.evaluate(()=>{globalThis.__interactiveFixture.planMode='source';});
 });
 await check('Fixture renderer makes no network requests or script errors and never opens native external content',async()=>{
  assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
  assert.deepEqual(await application.evaluate(()=>globalThis.__interactiveFixture.nativeEffects),[]);
  assert.equal(await page.evaluate(()=>window.intruded),undefined);
  assert.equal(await page.locator('#messages script,#messages img').count(),0);
 });
 }finally{
  await application.evaluate(()=>{globalThis.__interactiveFixture?.releases.splice(0).forEach(resolve=>resolve());globalThis.__interactiveFixture?.approvalReleases.splice(0).forEach(resolve=>resolve());globalThis.__interactiveFixture?.planReleases.splice(0).forEach(resolve=>resolve());}).catch(()=>{});
  fs.writeFileSync(path.join(evidence,'interactive-tests.json'),JSON.stringify({at:new Date().toISOString(),checks,errors,requests,profile,scope:'Native Electron fixture CLI only; isolated profile, no production configuration, credentials or gateway'},null,2));
  await application.close();
 }
 console.log(JSON.stringify({passed:checks.filter(check=>check.pass).length,failed:checks.filter(check=>!check.pass).length,profile}));
 process.exitCode=checks.some(check=>!check.pass)?1:0;
})().catch(error=>{console.error(error);process.exitCode=1;});
