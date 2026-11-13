'use strict';
const {_electron}=require('./test-support.cjs').playwright;
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),evidence=require('./test-support.cjs').evidenceDirectory('questions');fs.mkdirSync(evidence,{recursive:true});
const profile=fs.mkdtempSync(path.join(evidence,'fixture-profile-'));
const title='Choose the review scope',noteTitle='Anything else to keep in mind?';
const hostileTitle='Choose <img src=x onerror="window.questionInjected=true"> safely';
const hostileOption='<script>window.questionInjected=true</script>';
const question=(id,questions,seq)=>({role:'assistant',content:[],openclawAsyncDelivery:{itemId:id,questions},__openclaw:{id:'message-'+id,seq,runId:'fixture-question-run'}});
const repeatedTitle='A repeated retained request',repeated=question('repeated',[{title:repeatedTitle,options:['First choice','Second choice']}],22);
fs.writeFileSync(path.join(profile,'fixture-questions.json'),JSON.stringify({
 'agent:main:main':{current:[question('scope',[{title,options:['Focused review','Full workspace']},{title:noteTitle}],20),question('hostile',[{title:hostileTitle,options:[hostileOption,'Safe choice']}],21),repeated,{...repeated,__openclaw:{...repeated.__openclaw,id:'message-repeated-copy',seq:23}}],older:[question('older',[{title:'Older retained question',options:['Keep history','Review later']}],2)]},
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
 const page=await app.firstWindow();page.setDefaultTimeout(12000);
 const checks=[],errors=[],network=[];page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(/^(?:https?|wss?):/.test(request.url()))network.push(request.url());});
 const check=async(name,fn)=>{try{await fn();checks.push({name,pass:true});console.log('PASS',name);}catch(error){checks.push({name,pass:false,error:error.message});console.log('FAIL',name,error.message);await page.screenshot({path:path.join(evidence,'failure-'+checks.length+'.png')}).catch(()=>{});}};
 const cards=()=>page.locator('.async-question-card');
 const card=prompt=>cards().filter({hasText:prompt});
 const menu=id=>app.evaluate(({Menu},id)=>Menu.getApplicationMenu().getMenuItemById(id).click(),id);
 const main=()=>app.evaluate(()=>({calls:globalThis.__questionsFixture.calls,native:globalThis.__questionsFixture.native}));
 const ready=()=>page.waitForFunction(()=>document.querySelector('#composer-model')&&!document.querySelector('#composer-model').disabled);
 const chipIds=()=>page.locator('.composer-attachment').evaluateAll(nodes=>nodes.map(node=>node.dataset.attachmentId));
 const showQuestionForCapture=async()=>{
  if(await page.locator('.source-plan[open]').count())await page.locator('.source-plan>summary').click();
  await page.waitForTimeout(1000); // Let the existing transcript-follow motion finish before choosing a visual anchor.
  await card(title).evaluate(node=>node.scrollIntoView({block:'start',inline:'nearest',behavior:'instant'}));await page.waitForTimeout(100);
  const viewport=await page.locator('#transcript').boundingBox();assert.ok(viewport&&viewport.height>0);
  for(const node of [card(title).locator('h3'),card(title).locator('legend').first(),card(title).locator('.async-question-option').nth(0),card(title).locator('.async-question-option').nth(1)]){
   const box=await node.boundingBox();assert.ok(box&&box.y>=viewport.y-1&&box.y+box.height<=viewport.y+viewport.height+1,'question heading and choices are inside transcript viewport');
  }
 };
 let expectedDraft,attachmentIds;
 try {
  await app.evaluate(({ipcMain,dialog,shell,clipboard,BrowserWindow},picture)=>{
   BrowserWindow.getAllWindows()[0].setSize(1440,1000);
   const fixture=globalThis.__questionsFixture={calls:[],native:[]};
   const original=ipcMain._invokeHandlers.get('gateway:request');ipcMain.removeHandler('gateway:request');
   ipcMain.handle('gateway:request',async(event,operation,params)=>{fixture.calls.push({operation,params:structuredClone(params)});return original(event,operation,params);});
   dialog.showOpenDialog=async()=>({canceled:false,filePaths:[picture]});
   shell.openExternal=async value=>fixture.native.push(['external',value]);shell.showItemInFolder=value=>fixture.native.push(['reveal',value]);clipboard.writeText=value=>fixture.native.push(['copy',value]);
  },picture);
  await page.reload();await page.getByText('Coordinator is coordinating.',{exact:true}).waitFor();await card(title).waitFor();await ready();

  await check('Raw gateway async metadata renders structured questions without selecting or executing anything',async()=>{
   assert.equal(page.url(),'openclaw-plus://ui/index.html');assert.deepEqual(await page.evaluate(()=>[typeof require,typeof process]),['undefined','undefined']);
   assert.equal(await cards().count(),4);assert.equal(await card(title).locator('fieldset').count(),2);
   assert.ok(await card(title).getByRole('radio',{name:'Focused review',exact:true}).isVisible());assert.ok(await card(title).getByRole('radio',{name:'Full workspace',exact:true}).isVisible());
   assert.ok((await card(title).textContent()).includes(noteTitle));assert.equal(await cards().locator('input[type="radio"]:checked').count(),0);
   assert.deepEqual(writes(),[]);assert.equal(calls().filter(call=>call.method.startsWith('question.')).length,0);
   assert.equal(calls().filter(call=>call.method==='chat.history'&&call.params.offset>0).length,0);
  });

  await check('Repeated request occurrences retain unique DOM identities and synchronize the same scoped choice',async()=>{
   const repeatedCards=card(repeatedTitle);assert.equal(await repeatedCards.count(),2);
   const ids=await cards().locator('[id]').evaluateAll(nodes=>nodes.map(node=>node.id));assert.equal(new Set(ids).size,ids.length);
   const names=await repeatedCards.locator('input[type="radio"]').evaluateAll(nodes=>[...new Set(nodes.map(node=>node.name))]);assert.equal(names.length,2);
   await repeatedCards.nth(0).getByRole('radio',{name:'First choice',exact:true}).check();
   assert.equal(await repeatedCards.nth(1).getByRole('radio',{name:'First choice',exact:true}).isChecked(),true);
   assert.equal(await card(title).locator('input[type="radio"]:checked').count(),0);assert.deepEqual(writes(),[]);
  });

  await check('Preparing an unanswered request preserves the existing draft and performs no send',async()=>{
   await page.locator('#composer-input').fill('Existing Coordinator draft.');await card(title).getByRole('button',{name:'Prepare reply',exact:true}).click();
   assert.equal(await page.locator('#composer-input').inputValue(),'Existing Coordinator draft.');assert.equal(await card(title).locator('input[type="radio"]:checked').count(),0);
   assert.deepEqual(writes(),[]);
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

  await check('Prepare reply appends exact official framing while preserving native attachment tokens',async()=>{
   await page.getByRole('button',{name:'Attach media',exact:true}).click();await page.locator('.composer-attachment').waitFor();attachmentIds=await chipIds();assert.equal(attachmentIds.length,1);
   await card(title).getByRole('button',{name:'Prepare reply',exact:true}).click();
   expectedDraft='Existing Coordinator draft.\n\n> '+title+'\n\nFocused review\n\n> '+noteTitle+'\n\nKeep the existing tests.';
   assert.equal(await page.locator('#composer-input').inputValue(),expectedDraft);assert.deepEqual(await chipIds(),attachmentIds);assert.deepEqual(writes(),[]);
   assert.ok(await card(title).isVisible());assert.doesNotMatch(await card(title).textContent(),/Answer sent|Question resolved/);
   if(await page.locator('#work-panel').isVisible())await page.locator('#close-work').click();
   await showQuestionForCapture();await menu('theme:dark');await page.screenshot({path:path.join(evidence,'questions-dark-1440.png')});
   await menu('theme:light');await page.screenshot({path:path.join(evidence,'questions-light-1440.png')});
  });

  await check('Separate requests allow Other text and display hostile titles and options as inert text',async()=>{
   assert.ok((await card(hostileTitle).textContent()).includes(hostileOption));assert.equal(await cards().locator('img,script,iframe,a[href^="javascript:"]').count(),0);assert.equal(await page.evaluate(()=>window.questionInjected),undefined);
   assert.equal(await card(hostileTitle).locator('input[type="radio"]:checked').count(),0);
   await card(hostileTitle).locator('textarea[data-async-other]').fill('My own answer\nwith a second line.');
   assert.equal(await card(hostileTitle).locator('input[value="other"]').isChecked(),true);
   await card(hostileTitle).getByRole('button',{name:'Prepare reply',exact:true}).click();
   expectedDraft+='\n\n> '+hostileTitle+'\n\nMy own answer\nwith a second line.';
   assert.equal(await page.locator('#composer-input').inputValue(),expectedDraft);assert.deepEqual(await chipIds(),attachmentIds);
   assert.equal(await card(title).getByRole('radio',{name:'Focused review',exact:true}).isChecked(),true);assert.deepEqual(writes(),[]);
  });

  await check('Only explicit Send uses the existing exact-session idempotent message route',async()=>{
   await page.waitForFunction(()=>!document.querySelector('#send-message').disabled);await page.getByRole('button',{name:'Send message',exact:true}).click();
   await page.waitForFunction(()=>document.querySelector('#composer-status')?.textContent.includes('Message accepted'));
   const sent=state().sent;assert.equal(sent.length,1);assert.equal(sent[0].message,expectedDraft);assert.equal(sent[0].sessionKey,'agent:main:main');assert.equal(sent[0].sessionId,'physical-main');
   const requests=(await main()).calls.filter(call=>call.operation==='send');assert.equal(requests.length,1);assert.equal(sent[0].idempotencyKey,requests[0].params.requestId);assert.deepEqual(requests[0].params.attachmentIds,attachmentIds);
   assert.equal(writes().length,1);assert.equal(writes()[0].method,'chat.send');assert.equal(await page.locator('.composer-attachment').count(),0);
  });

  await check('Retained older questions stay readable without automatic history scans',async()=>{
   await page.getByRole('button',{name:'Load earlier messages',exact:true}).click();await card('Older retained question').waitFor();
   assert.ok(await card('Older retained question').getByRole('radio',{name:'Keep history',exact:true}).isVisible());assert.equal(await card('Older retained question').locator('input:checked').count(),0);
   const older=calls().filter(call=>call.method==='chat.history'&&call.params.offset>0).length;assert.equal(older,1);
   await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.send('gateway:event',{kind:'sessions'}));await page.getByRole('button',{name:'Refresh latest messages',exact:true}).waitFor();await page.waitForTimeout(3400);
   assert.ok(await card('Older retained question').isVisible());assert.equal(calls().filter(call=>call.method==='chat.history'&&call.params.offset>0).length,older);
   assert.equal(calls().filter(call=>call.method.startsWith('question.')).length,0);assert.equal(writes().length,1);
   await page.getByRole('button',{name:'Refresh latest messages',exact:true}).click();await card(title).waitFor();
  });

  await check('Question controls fit a narrow window with no script errors or native external effects',async()=>{
   await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(880,820));await showQuestionForCapture();
   for(const selector of ['fieldset','textarea','button[data-action="prepare-async-reply"]'])for(const node of await card(title).locator(selector).all()){
    const box=await node.boundingBox();assert.ok(box&&box.x>=0&&box.x+box.width<=880+1,selector+' fits');
   }
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:path.join(evidence,'questions-light-880.png')});
   assert.equal(await page.evaluate(()=>window.questionInjected),undefined);assert.deepEqual(errors,[]);assert.deepEqual(network,[]);assert.deepEqual((await main()).native,[]);
  });
 } finally {
  fs.writeFileSync(path.join(evidence,'questions-tests.json'),JSON.stringify({at:new Date().toISOString(),checks,errors,network,profile,scope:'Isolated native fake-gateway fixture. Raw async metadata passes through the actual normalizer. Picker intercepted; only the explicit fixture Send writes. No production calls or native external effects.'},null,2));
  await app.close();
 }
 console.log(JSON.stringify({passed:checks.filter(item=>item.pass).length,failed:checks.filter(item=>!item.pass).length,profile}));process.exitCode=checks.some(item=>!item.pass)?1:0;
})().catch(error=>{console.error(error);process.exitCode=1;});
