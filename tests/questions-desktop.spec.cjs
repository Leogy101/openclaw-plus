'use strict';
const {_electron}=require('./test-support.cjs').playwright;
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {normalizeMessage}=require('../desktop/src/gateway-service.cjs');
const root=path.resolve(__dirname,'..'),evidence=require('./test-support.cjs').evidenceDirectory('questions');fs.mkdirSync(evidence,{recursive:true});
const profile=fs.mkdtempSync(path.join(evidence,'fixture-profile-'));
const title='Choose the review scope',noteTitle='Anything else to keep in mind?';
const hostileTitle='Choose <img src=x onerror="window.questionInjected=true"> safely';
const hostileOption='<script>window.questionInjected=true</script>';
const question=(id,questions,seq)=>({role:'assistant',content:[],openclawAsyncDelivery:{itemId:id,questions},__openclaw:{id:'message-'+id,seq,runId:'fixture-question-run'}});
const repeatedTitle='A repeated retained request',repeated=question('repeated',[{title:repeatedTitle,options:['First choice','Second choice']}],22);
fs.writeFileSync(path.join(profile,'fixture-questions.json'),JSON.stringify({
 'agent:main:main':{current:[question('scope',[{title,options:['Focused review','Full workspace']},{title:noteTitle}],20),question('hostile',[{title:hostileTitle,options:[hostileOption,'Safe choice']}],21),repeated,{...repeated,__openclaw:{...repeated.__openclaw,id:'message-repeated-copy',seq:23}},question('remote-choice',[{title:'Remote answer fixture',options:['Inspect','Wait']}],24)],older:[question('older',[{title:'Older retained question',options:['Keep history','Review later']}],2)]},
 'agent:builder:child':{current:[question('scope',[{title:'Builder child decision',options:['Inspect changes','Run tests']}],10)]},
}));
const picture=path.join(profile,'Question attachment.png');
fs.writeFileSync(picture,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==','base64'));
const env={...process.env,OPENCLAW_PLUS_TEST_DATA:profile,OPENCLAW_PLUS_TEST_CLI:path.join(root,'tests/fixture-gateway.cjs')};delete env.ELECTRON_RUN_AS_NODE;
const calls=()=>fs.existsSync(path.join(profile,'fixture-calls.jsonl'))?fs.readFileSync(path.join(profile,'fixture-calls.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
const writes=()=>calls().filter(call=>['chat.send','chat.abort','sessions.patch','approval.resolve','config.patch'].includes(call.method));
const state=()=>JSON.parse(fs.readFileSync(path.join(profile,'fixture-state.json'),'utf8'));

(async()=>{
 const app=await _electron.launch({executablePath:path.join(root,'desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[path.join(root,'desktop')],env});
 const page=await app.firstWindow();page.setDefaultTimeout(12000);await page.emulateMedia({reducedMotion:'reduce'});
 const checks=[],errors=[],network=[];page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(/^(?:https?|wss?):/.test(request.url()))network.push(request.url());});
 const check=async(name,fn)=>{try{await fn();checks.push({name,pass:true});console.log('PASS',name);}catch(error){checks.push({name,pass:false,error:error.message});console.log('FAIL',name,error.message);await page.screenshot({path:path.join(evidence,'failure-'+checks.length+'.png')}).catch(()=>{});}};
 const cards=()=>page.locator('#pending-question-region .async-question-card');
 const summary=prompt=>page.locator('#messages .async-question-summary').filter({hasText:prompt});
 const card=prompt=>cards().filter({hasText:prompt});
 const menu=id=>app.evaluate(({Menu},id)=>Menu.getApplicationMenu().getMenuItemById(id).click(),id);
 const main=()=>app.evaluate(()=>({calls:globalThis.__questionsFixture.calls,native:globalThis.__questionsFixture.native}));
 const ready=()=>page.waitForFunction(()=>document.querySelector('#composer-model')&&!document.querySelector('#composer-model').disabled);
 const chipIds=()=>page.locator('.composer-attachment').evaluateAll(nodes=>nodes.map(node=>node.dataset.attachmentId));
 let clockOffset=0;
 const refreshQuestions=async()=>{clockOffset+=16000;await page.clock.setFixedTime(new Date(Date.now()+clockOffset));const before=(await main()).calls.filter(call=>call.operation==='history').length;await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.send('gateway:event',{kind:'activity'}));const deadline=Date.now()+10000;while((await main()).calls.filter(call=>call.operation==='history').length===before){if(Date.now()>deadline)throw new Error('No bounded question refresh');await page.waitForTimeout(25);}await page.evaluate(()=>new Promise(requestAnimationFrame));};
 const showQuestionForCapture=async(prompt=title)=>{
  if(await page.locator('#work-panel').isVisible())await page.locator('#close-work').click();
  if(await page.locator('.source-plan[open]').count())await page.locator('.source-plan>summary').click();
  await page.waitForTimeout(1000); // Let the existing transcript-follow motion finish before choosing a visual anchor.
  await card(prompt).evaluate(node=>node.scrollIntoView({block:'start',inline:'nearest',behavior:'instant'}));await page.waitForTimeout(100);
  const viewport=await page.locator('#pending-question-region').boundingBox();assert.ok(viewport&&viewport.height>0);
  for(const node of [card(prompt).locator('h3'),card(prompt).locator('legend').first(),card(prompt).locator('.async-question-option').nth(0),card(prompt).locator('.async-question-option').nth(1)]){
   const box=await node.boundingBox();assert.ok(box&&box.y>=viewport.y-1&&box.y+box.height<=viewport.y+viewport.height+1,'question heading and choices are inside the bounded composer dock');
  }
  const button=await card(prompt).locator('[data-action="send-async-reply"]').boundingBox();assert.ok(button&&button.y>=viewport.y-1&&button.y+button.height<=viewport.y+viewport.height+1,'Send answer remains fully visible within the dock');
 };
 let expectedDraft,attachmentIds;
 try {
  await app.evaluate(({ipcMain,dialog,shell,clipboard,BrowserWindow},picture)=>{
   BrowserWindow.getAllWindows()[0].setSize(1440,1000);
   const fixture=globalThis.__questionsFixture={calls:[],native:[],releases:[],holdNext:false,rejectNext:false,uncertainNext:false,extras:[],historyError:null};
   const original=ipcMain._invokeHandlers.get('gateway:request');ipcMain.removeHandler('gateway:request');
   ipcMain.handle('gateway:request',async(event,operation,params)=>{
    fixture.calls.push({operation,params:structuredClone(params)});
    if(operation==='history'&&fixture.historyError)return {ok:false,error:{code:fixture.historyError,message:'Fixture history access unavailable'}};
    if(operation==='send'&&fixture.rejectNext){fixture.rejectNext=false;return {ok:false,error:{code:'CONFLICT',message:'Fixture branch changed',uncertain:false}};}
    if(operation==='send'&&fixture.holdNext){fixture.holdNext=false;await new Promise(resolve=>fixture.releases.push(resolve));}
    const result=await original(event,operation,params);
    if(operation==='send'&&fixture.uncertainNext){fixture.uncertainNext=false;return {ok:false,error:{code:'UNAVAILABLE',message:'Fixture acknowledgement lost',uncertain:true}};}
    if(operation==='history'&&params.key==='agent:main:main'&&!params.offset&&result.ok){const copy=structuredClone(result);copy.data.messages.push(...fixture.extras);return copy;}
    return result;
   });
   dialog.showOpenDialog=async()=>({canceled:false,filePaths:[picture]});
   shell.openExternal=async value=>fixture.native.push(['external',value]);shell.showItemInFolder=value=>fixture.native.push(['reveal',value]);clipboard.writeText=value=>fixture.native.push(['copy',value]);
  },picture);
  await page.reload();await page.getByText('Coordinator is coordinating.',{exact:true}).waitFor();await card(title).waitFor();await ready();

  await check('Raw gateway async metadata renders structured questions without selecting or executing anything',async()=>{
   assert.equal(page.url(),'openclaw-plus://ui/index.html');assert.deepEqual(await page.evaluate(()=>[typeof require,typeof process]),['undefined','undefined']);
   assert.equal(await cards().count(),4);assert.equal(await page.locator('#messages .async-question-card').count(),0);assert.equal(await card(title).locator('fieldset').count(),2);
   assert.ok(await card(title).getByRole('radio',{name:'Focused review',exact:true}).isVisible());assert.ok(await card(title).getByRole('radio',{name:'Full workspace',exact:true}).isVisible());
   assert.ok((await card(title).textContent()).includes(noteTitle));assert.equal(await cards().locator('input[type="radio"]:checked').count(),0);
   assert.deepEqual(writes(),[]);assert.equal(calls().filter(call=>call.method.startsWith('question.')).length,0);
   assert.equal(calls().filter(call=>call.method==='chat.history'&&call.params.offset>0).length,0);
  });

  await check('Repeated history occurrences share one dock form and retain distinct source summaries',async()=>{
   const repeatedCards=card(repeatedTitle);assert.equal(await repeatedCards.count(),1);assert.equal(await summary(repeatedTitle).count(),2);
   const ids=await cards().locator('[id]').evaluateAll(nodes=>nodes.map(node=>node.id));assert.equal(new Set(ids).size,ids.length);
   const names=await repeatedCards.locator('input[type="radio"]').evaluateAll(nodes=>[...new Set(nodes.map(node=>node.name))]);assert.equal(names.length,1);
   await repeatedCards.nth(0).getByRole('radio',{name:'First choice',exact:true}).check();
   await summary(repeatedTitle).first().getByRole('button',{name:'Jump to question'}).click();assert.equal(await repeatedCards.getByRole('radio',{name:'First choice',exact:true}).isChecked(),true);
   assert.equal(await card(title).locator('input[type="radio"]:checked').count(),0);assert.deepEqual(writes(),[]);
  });

  await check('Sending an unanswered or incomplete request preserves the draft and performs no send',async()=>{
   await page.locator('#composer-input').fill('Existing Coordinator draft.');await card(title).getByRole('button',{name:'Send answer',exact:true}).click();
   assert.equal(await page.locator('#composer-input').inputValue(),'Existing Coordinator draft.');assert.equal(await card(title).locator('input[type="radio"]:checked').count(),0);
   assert.match(await card(title).locator('.async-reply-status').textContent(),/answer for every question/);
   await card(title).getByRole('radio',{name:'Focused review',exact:true}).check();await card(title).getByRole('button',{name:'Send answer',exact:true}).click();
   assert.match(await card(title).locator('.async-reply-status').textContent(),/answer for every question/);
   assert.deepEqual(writes(),[]);
   if(await page.locator('#work-panel').isVisible())await page.locator('#close-work').click();
   await showQuestionForCapture();await menu('theme:dark');await page.screenshot({path:path.join(evidence,'questions-dark-1440.png')});
   await menu('theme:light');await page.screenshot({path:path.join(evidence,'questions-light-1440.png')});
  });

  await check('Explicit choices and free text survive refresh and exact-session navigation',async()=>{
   const focused=card(title).getByRole('radio',{name:'Focused review',exact:true});await focused.focus();await page.keyboard.press('Space');
   await card(title).locator('textarea[data-async-other][data-question-index="1"]').fill('Keep the existing tests.');
   const before=(await main()).calls.length;await page.waitForTimeout(3400);assert.ok((await main()).calls.length>before);
   assert.equal(await focused.isChecked(),true);assert.equal(await card(title).locator('textarea[data-question-index="1"]').inputValue(),'Keep the existing tests.');
   if(!await page.locator('#work-panel').isVisible())await page.locator('#toggle-work').click();
   await page.locator('#work-content [data-action="session"]').first().click();await page.getByText('Builder exact child history',{exact:true}).waitFor();await card('Builder child decision').waitFor();await ready();
   assert.equal(await card('Builder child decision').locator('input[type="radio"]:checked').count(),0);assert.equal(await page.locator('#composer-input').inputValue(),'');
   await card('Builder child decision').getByRole('radio',{name:'Run tests',exact:true}).check();await page.locator('#composer-input').fill('Builder draft is separate.');
   await page.getByRole('button',{name:'Back to Coordinator'}).click();await card(title).waitFor();await ready();
   assert.equal(await card(title).getByRole('radio',{name:'Focused review',exact:true}).isChecked(),true);
   assert.equal(await card(title).locator('textarea[data-question-index="1"]').inputValue(),'Keep the existing tests.');assert.equal(await page.locator('#composer-input').inputValue(),'Existing Coordinator draft.');
   assert.deepEqual(writes(),[]);
  });

  await check('Send answer submits only its formatted reply once while preserving composer text and attachments',async()=>{
   await page.getByRole('button',{name:'Attach media',exact:true}).click();await page.locator('.composer-attachment').waitFor();attachmentIds=await chipIds();assert.equal(attachmentIds.length,1);
   expectedDraft='> '+title+'\n\nFocused review\n\n> '+noteTitle+'\n\nKeep the existing tests.';
   await page.locator('#composer-input').fill(expectedDraft);await app.evaluate(()=>{globalThis.__questionsFixture.holdNext=true;});
   const button=card(title).locator('[data-action="send-async-reply"]');await button.click();await button.dispatchEvent('click');
   assert.equal((await main()).calls.filter(call=>call.operation==='send').length,1);assert.equal(await button.isDisabled(),true);assert.equal(await page.locator('#send-message').isDisabled(),true);
   await app.evaluate(()=>globalThis.__questionsFixture.releases.splice(0).forEach(resolve=>resolve()));await card(title).waitFor({state:'detached'});await summary(title).filter({hasText:'Answer sent'}).waitFor();
   const sent=state().sent[0],request=(await main()).calls.find(call=>call.operation==='send').params;
   assert.equal(sent.message,expectedDraft);assert.equal(sent.sessionKey,'agent:main:main');assert.equal(sent.sessionId,'physical-main');assert.equal(sent.agentId,'main');assert.equal(sent.idempotencyKey,request.requestId);assert.equal(request.expectedLeafEntryId,'leaf-1');assert.equal(request.attachmentIds,undefined);assert.equal(request.replyToId,'message-scope');
   assert.equal(await page.locator('#composer-input').inputValue(),expectedDraft);assert.deepEqual(await chipIds(),attachmentIds);
   assert.equal(await summary(title).locator('button').count(),0);assert.equal((await main()).calls.filter(call=>call.operation==='send').length,1);assert.doesNotMatch(await summary(title).textContent(),/Question resolved/);
  });

  await check('Other text stays inert and a rejected answer retains its controls for explicit recovery',async()=>{
   assert.ok((await card(hostileTitle).textContent()).includes(hostileOption));assert.equal(await cards().locator('img,script,iframe,a[href^="javascript:"]').count(),0);assert.equal(await page.evaluate(()=>window.questionInjected),undefined);
   assert.equal(await card(hostileTitle).locator('input[type="radio"]:checked').count(),0);
   await card(hostileTitle).locator('textarea[data-async-other]').fill('My own answer\nwith a second line.');
   assert.equal(await card(hostileTitle).locator('input[value="other"]').isChecked(),true);
   await ready();await app.evaluate(()=>{globalThis.__questionsFixture.rejectNext=true;});await card(hostileTitle).getByRole('button',{name:'Send answer',exact:true}).click();
   await page.waitForFunction(()=>[...document.querySelectorAll('.async-reply-status')].some(node=>node.textContent.includes('Answer was not sent')));
   assert.equal(await card(hostileTitle).locator('textarea').inputValue(),'My own answer\nwith a second line.');assert.equal(state().sent.length,1);
   await card(hostileTitle).getByRole('button',{name:'Send answer',exact:true}).click();await card(hostileTitle).waitFor({state:'detached'});await summary(hostileTitle).filter({hasText:'Answer sent'}).waitFor();
   assert.equal(state().sent[1].message,'> '+hostileTitle+'\n\nMy own answer\nwith a second line.');
   assert.equal(await page.locator('#composer-input').inputValue(),expectedDraft);assert.deepEqual(await chipIds(),attachmentIds);
   assert.match(await summary(title).textContent(),/Answer sent/);
  });

  await check('Unconfirmed answers retry only explicitly with the same body and idempotency key',async()=>{
   await ready();await app.evaluate(()=>{globalThis.__questionsFixture.uncertainNext=true;});await card(repeatedTitle).nth(0).getByRole('button',{name:'Send answer',exact:true}).click();
   await card(repeatedTitle).nth(0).getByRole('button',{name:'Retry answer',exact:true}).waitFor();const before=(await main()).calls.filter(call=>call.operation==='send'),request=before.at(-1).params;
   assert.equal(await page.locator('#send-message').isDisabled(),true);assert.equal(await card(repeatedTitle).nth(0).locator('input').first().isDisabled(),true);
   await page.locator('#send-message').dispatchEvent('click');await page.locator('#composer-input').press('Enter');assert.equal((await main()).calls.filter(call=>call.operation==='send').length,before.length);
   await card(repeatedTitle).getByRole('button',{name:'Retry answer',exact:true}).click();await card(repeatedTitle).waitFor({state:'detached'});
   assert.deepEqual((await main()).calls.filter(call=>call.operation==='send').at(-1).params,request);assert.equal(state().sent.length,3);assert.equal(await summary(repeatedTitle).filter({hasText:'Answer sent'}).count(),2);
   assert.equal(await page.locator('#composer-input').inputValue(),expectedDraft);assert.deepEqual(await chipIds(),attachmentIds);
  });

  await check('Navigating during a question send preserves both sessions and cannot clear the destination draft',async()=>{
   await ready();if(!await page.locator('#work-panel').isVisible())await page.locator('#toggle-work').click();await page.locator('#work-content [data-action="session"]').first().click();await card('Builder child decision').waitFor();await ready();
   await app.evaluate(()=>{globalThis.__questionsFixture.holdNext=true;});await card('Builder child decision').getByRole('button',{name:'Send answer',exact:true}).click();
   await page.getByRole('button',{name:'Back to Coordinator'}).click();await summary(title).waitFor();assert.equal(await page.locator('#composer-input').inputValue(),expectedDraft);
   await app.evaluate(()=>globalThis.__questionsFixture.releases.splice(0).forEach(resolve=>resolve()));await ready();
   await page.locator('#work-content [data-action="session"]').first().click();await summary('Builder child decision').filter({hasText:'Answer sent'}).waitFor();
   assert.equal(await page.locator('#composer-input').inputValue(),'Builder draft is separate.');const sent=state().sent.at(-1);assert.equal(sent.sessionKey,'agent:builder:child');assert.equal(sent.sessionId,'physical-child');assert.equal(sent.message,'> Builder child decision\n\nRun tests');
   await page.getByRole('button',{name:'Back to Coordinator'}).click();await summary(title).waitFor();assert.equal(await page.locator('#composer-input').inputValue(),expectedDraft);assert.deepEqual(await chipIds(),attachmentIds);
  });

  await check('Retained older questions stay readable without automatic history scans',async()=>{
   await page.getByRole('button',{name:'Load earlier messages',exact:true}).click();await card('Older retained question').waitFor();
   assert.ok(await card('Older retained question').getByRole('radio',{name:'Keep history',exact:true}).isVisible());assert.equal(await card('Older retained question').locator('input:checked').count(),0);
   const older=calls().filter(call=>call.method==='chat.history'&&call.params.offset>0).length;assert.equal(older,1);
   await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.send('gateway:event',{kind:'sessions'}));await page.getByRole('button',{name:'Refresh latest messages',exact:true}).waitFor();await page.waitForTimeout(3400);
   assert.ok(await card('Older retained question').isVisible());assert.equal(calls().filter(call=>call.method==='chat.history'&&call.params.offset>0).length,older);
   assert.equal(calls().filter(call=>call.method.startsWith('question.')).length,0);assert.equal(writes().length,4);
  });

  await check('A fresh dock question appears during older-history reading and survives latest-window rollover',async()=>{
   const visible=await page.locator('#messages article').evaluateAll(nodes=>nodes.map(node=>node.dataset.messageId));
   await app.evaluate((_electron,message)=>globalThis.__questionsFixture.extras.push(message),normalizeMessage(question('window-choice',[{title:'Window rollover fixture',options:['Inspect','Review']}],120)));
   await refreshQuestions();await card('Window rollover fixture').waitFor();assert.equal(await summary('Window rollover fixture').count(),0);
   assert.deepEqual(await page.locator('#messages article').evaluateAll(nodes=>nodes.map(node=>node.dataset.messageId)),visible);
   await app.evaluate(()=>{globalThis.__questionsFixture.extras=[];});await refreshQuestions();assert.equal(await card('Window rollover fixture').count(),1);
   await app.evaluate((_electron,message)=>{globalThis.__questionsFixture.extras=[message];},normalizeMessage({role:'user',content:'External fixture decision.',__openclaw:{id:'remote-window-answer',seq:121,replyToId:'message-window-choice'}}));
   await refreshQuestions();await card('Window rollover fixture').waitFor({state:'detached'});
   assert.deepEqual(await page.locator('#messages article').evaluateAll(nodes=>nodes.map(node=>node.dataset.messageId)),visible);assert.equal(writes().length,4);
  });

  await check('A durable answer from another client suppresses uncertain retries without claiming our delivery',async()=>{
   await card('Remote answer fixture').getByRole('radio',{name:'Inspect',exact:true}).check();await app.evaluate(()=>{globalThis.__questionsFixture.uncertainNext=true;});await card('Remote answer fixture').getByRole('button',{name:'Send answer'}).click();
   await card('Remote answer fixture').getByRole('button',{name:'Retry answer'}).waitFor();const before=(await main()).calls.filter(call=>call.operation==='send').length;
   await app.evaluate((_electron,message)=>globalThis.__questionsFixture.extras.push(message),normalizeMessage({role:'user',content:'A decision recorded by another client.',__openclaw:{id:'remote-answer',seq:122,replyToId:'message-remote-choice'}}));
   await refreshQuestions();
   await card('Remote answer fixture').waitFor({state:'detached'});assert.match(await summary('Remote answer fixture').textContent(),/Answer recorded.*Earlier send outcome unconfirmed/);
   assert.equal((await main()).calls.filter(call=>call.operation==='send').length,before);assert.equal(await page.locator('#composer-input').inputValue(),expectedDraft);assert.deepEqual(await chipIds(),attachmentIds);
   await page.waitForFunction(()=>!document.querySelector('#send-message').disabled);assert.equal(state().sent.length,5);
  });

  await check('Definitive refresh errors remove stale question controls until exact-session recovery',async()=>{
   await app.evaluate(()=>{globalThis.__questionsFixture.historyError='SESSION_CHANGED';});await refreshQuestions();
   await page.locator('#pending-question-region').getByText('Questions could not be refreshed',{exact:true}).waitFor();assert.equal(await cards().count(),0);
   assert.equal(await page.locator('#composer-input').inputValue(),expectedDraft);assert.deepEqual(await chipIds(),attachmentIds);
   await app.evaluate((_electron,message)=>{const state=globalThis.__questionsFixture;state.historyError=null;state.extras.push(message);},normalizeMessage(question('fresh-choice',[{title:'Fresh pending choice',options:['Inspect','Review']}],130)));
   await page.locator('#pending-question-region [data-action="refresh-questions"]').click();await card('Fresh pending choice').waitFor();
   const dock=await page.locator('#pending-question-region').boundingBox(),composer=await page.locator('.composer').boundingBox();assert.ok(dock.y+dock.height<=composer.y+1);assert.ok(dock.height<=311);
  });

  await check('Disconnected question answers stay editable but cannot send or retry automatically',async()=>{
   await card('Older retained question').getByRole('radio',{name:'Keep history',exact:true}).check();
   fs.writeFileSync(path.join(profile,'offline'),'fixture offline');
   await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.send('gateway:event',{kind:'connection',connection:{status:'disconnected',message:'Fixture disconnected'}}));
   const button=card('Older retained question').getByRole('button',{name:'Send answer',exact:true});assert.equal(await button.isDisabled(),true);
   const before=(await main()).calls.filter(call=>call.operation==='send').length;await button.dispatchEvent('click');assert.equal((await main()).calls.filter(call=>call.operation==='send').length,before);
   assert.equal(await card('Older retained question').getByRole('radio',{name:'Keep history',exact:true}).isChecked(),true);assert.equal(await page.locator('#composer-input').inputValue(),expectedDraft);assert.deepEqual(await chipIds(),attachmentIds);
   fs.unlinkSync(path.join(profile,'offline'));await page.locator('#connection-notice').getByRole('button',{name:'Reconnect',exact:true}).click();await ready();
   assert.equal((await main()).calls.filter(call=>call.operation==='send').length,before);assert.equal(state().sent.length,5);
   if(await page.getByRole('button',{name:'Refresh latest messages',exact:true}).count())await page.getByRole('button',{name:'Refresh latest messages',exact:true}).click();await summary(title).waitFor();
  });

  await check('Question controls fit a narrow window with no script errors or native external effects',async()=>{
   await showQuestionForCapture('Fresh pending choice');await page.screenshot({path:path.join(evidence,'questions-ready-1440.png')});
   await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(880,820));await showQuestionForCapture('Fresh pending choice');
   for(const selector of ['fieldset','textarea','button[data-action="send-async-reply"]'])for(const node of await card('Fresh pending choice').locator(selector).all()){
    const box=await node.boundingBox();assert.ok(box&&box.x>=0&&box.x+box.width<=880+1,selector+' fits');
   }
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:path.join(evidence,'questions-light-880.png')});
   assert.equal(await page.evaluate(()=>window.questionInjected),undefined);assert.deepEqual(errors,[]);assert.deepEqual(network,[]);assert.deepEqual((await main()).native,[]);
  });
 } finally {
  fs.writeFileSync(path.join(evidence,'questions-tests.json'),JSON.stringify({at:new Date().toISOString(),checks,errors,network,profile,scope:'Isolated native fake-gateway fixture. Raw async metadata passes through the actual normalizer. Picker intercepted; only explicit Send answer clicks write fixture messages. No production calls or native external effects.'},null,2));
  await app.close();
 }
 console.log(JSON.stringify({passed:checks.filter(item=>item.pass).length,failed:checks.filter(item=>!item.pass).length,profile}));process.exitCode=checks.some(item=>!item.pass)?1:0;
})().catch(error=>{console.error(error);process.exitCode=1;});
