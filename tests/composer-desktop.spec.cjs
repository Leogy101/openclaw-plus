'use strict';
const {_electron}=require('./test-support.cjs').playwright;
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),evidence=require('./test-support.cjs').evidenceDirectory('composer');fs.mkdirSync(evidence,{recursive:true});
const profile=fs.mkdtempSync(path.join(evidence,'composer-fixture-'));
const picture=path.join(profile,'Picture & sample.png');
const pictureBytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==','base64');
fs.writeFileSync(picture,pictureBytes);
const env={...process.env,OPENCLAW_PLUS_TEST_DATA:profile,OPENCLAW_PLUS_TEST_CLI:path.join(root,'tests/fixture-gateway.cjs')};delete env.ELECTRON_RUN_AS_NODE;
const calls=()=>fs.existsSync(path.join(profile,'fixture-calls.jsonl'))?fs.readFileSync(path.join(profile,'fixture-calls.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
const count=method=>calls().filter(call=>call.method===method).length;
const persisted=()=>JSON.parse(fs.readFileSync(path.join(profile,'fixture-state.json'),'utf8'));

(async()=>{
 const app=await _electron.launch({executablePath:path.join(root,'desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[path.join(root,'desktop')],env});
 const page=await app.firstWindow();page.setDefaultTimeout(12000);
 const errors=[],network=[],checks=[];page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(/^(?:https?|wss?):/.test(request.url()))network.push(request.url());});
 const check=async(name,fn)=>{try{await fn();checks.push({name,pass:true});console.log('PASS',name);}catch(error){checks.push({name,pass:false,error:error.message});console.log('FAIL',name,error.message);await page.screenshot({path:path.join(evidence,'composer-failure-'+checks.length+'.png')}).catch(()=>{});}};
 const menu=id=>app.evaluate(({Menu},id)=>Menu.getApplicationMenu().getMenuItemById(id).click(),id);
 const main=()=>app.evaluate(()=>({calls:globalThis.__composerFixture.calls,dialogs:globalThis.__composerFixture.dialogs,native:globalThis.__composerFixture.native,lastOptions:globalThis.__composerFixture.lastOptions}));
 const waitMain=async predicate=>{const deadline=Date.now()+10000;while(!await app.evaluate(predicate)){if(Date.now()>deadline)throw new Error('Fixture main-state wait timed out');await page.waitForTimeout(25);}};
 const ready=()=>page.waitForFunction(()=>document.querySelector('#composer-model')&&!document.querySelector('#composer-model').disabled&&document.querySelector('#composer-reasoning')&&!document.querySelector('#composer-reasoning').disabled);
 const queuePick=files=>app.evaluate((_,files)=>{globalThis.__composerFixture.picks.push({canceled:!files.length,filePaths:files});},files);
 const attach=async()=>{await page.getByRole('button',{name:'Attach media',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('#attach-media')?.disabled);};
 const chips=()=>page.locator('.composer-attachment');
 const chipIds=()=>chips().evaluateAll(nodes=>nodes.map(node=>node.dataset.attachmentId));
 const refreshOptions=async()=>{await page.getByRole('button',{name:'Refresh options',exact:true}).click();await ready();};
 const originalContext={key:'agent:main:main',agentId:'main',sessionId:'physical-main'};
 try {
  await app.evaluate(({ipcMain,dialog,shell,clipboard,BrowserWindow})=>{
   BrowserWindow.getAllWindows()[0].setSize(1440,1000);
   const contextByAgent={
    main:{usedTokens:8000,capacityTokens:32000,budget:'window',fresh:true,modelRef:'fixture/model-one'},
    builder:{usedTokens:8000,capacityTokens:16000,budget:'window',fresh:true,modelRef:'fixture/model-one'},
   };
   const state=globalThis.__composerFixture={calls:[],dialogs:[],picks:[],pickerHold:false,pickerReleases:[],pickerError:false,optionsMode:'source',settingError:false,uncertainSend:false,native:[],lastOptions:null,historyRunActive:null,contextByAgent};
   dialog.showOpenDialog=async(...args)=>{
    state.dialogs.push(args.at(-1));
    if(state.pickerError){state.pickerError=false;throw new Error('Fixture picker unavailable');}
    const selected=state.picks.shift()||{canceled:true,filePaths:[]};
    if(state.pickerHold)await new Promise(resolve=>state.pickerReleases.push(resolve));
    return selected;
   };
   const original=ipcMain._invokeHandlers.get('gateway:request');
   ipcMain.removeHandler('gateway:request');ipcMain.handle('gateway:request',async(event,operation,params)=>{
    state.calls.push({operation,params:structuredClone(params)});
    if(operation==='send'&&state.uncertainSend){state.uncertainSend=false;return {ok:false,error:{code:'UNCERTAIN',message:'Fixture send outcome unconfirmed.',uncertain:true}};}
    if(operation==='setComposer'&&state.settingError){state.settingError=false;return {ok:false,error:{code:'UNCERTAIN',message:'Fixture setting outcome unconfirmed.',uncertain:true}};}
    if(operation==='composerOptions'&&state.optionsMode==='error')return {ok:false,error:{code:'UNAVAILABLE',message:'Fixture model options unavailable.'}};
    const result=await original(event,operation,params);
    if(['composerOptions','setComposer'].includes(operation)&&result?.ok){
     if(state.optionsMode==='locked')result.data={...result.data,modelSelectionLocked:true};
     if(state.optionsMode==='unavailable')result.data={...result.data,models:[],limitations:['Fixture model catalog unavailable.']};
     state.lastOptions=structuredClone(result.data);
    }
    if(operation==='history'&&result?.ok)result.data.contextUsage=state.contextByAgent[params.agentId]??null;
    if(['history','activity'].includes(operation)&&result?.ok&&state.historyRunActive!==null){
     const runId='fixture-picker-run',observedAt=Date.now();
     const context={key:params.key,agentId:params.agentId,sessionId:params.sessionId};
     result.data.runStatus={
      context,observedAt,freshUntil:observedAt+45000,
      state:state.historyRunActive?'active':'idle',
      ...(state.historyRunActive?{runId,startedAt:observedAt}:{})
     };
    }
    return result;
   });
   shell.openExternal=async value=>state.native.push(['external',value]);shell.showItemInFolder=value=>state.native.push(['reveal',value]);clipboard.writeText=value=>state.native.push(['copy',value]);
  });
  await page.reload();await page.getByText('Coordinator is coordinating.',{exact:true}).waitFor();await ready();

  await check('Authenticated fixture catalog supplies labeled model and reasoning controls without an initial write',async()=>{
   assert.equal(page.url(),'openclaw-plus://ui/index.html');assert.deepEqual(await page.evaluate(()=>[typeof require,typeof process]),['undefined','undefined']);
   assert.ok(await page.getByRole('combobox',{name:'Model',exact:true}).isVisible());assert.ok(await page.getByRole('combobox',{name:'Reasoning level',exact:true}).isVisible());
   const options=(await main()).lastOptions;assert.ok(options.models.length>=2);assert.equal(await page.locator('#composer-model').inputValue(),options.current.model);assert.equal(await page.locator('#composer-reasoning').inputValue(),options.current.thinkingLevel);
   assert.ok((await page.locator('#composer-model option').allTextContents()).every(label=>label.trim()));assert.equal(count('sessions.patch'),0);
   assert.equal(await page.getByRole('button',{name:'Attach media',exact:true}).isEnabled(),true);
  });

  await check('Context meter updates while model and reasoning pickers stay open',async()=>{
   const initialUsage={usedTokens:8000,capacityTokens:32000,budget:'window',fresh:true,modelRef:'fixture/model-one'};
   const promptUsage={...initialUsage,usedTokens:20000,capacityTokens:40000,budget:'prompt'};
   const approximateUsage={...initialUsage,usedTokens:24000,fresh:false};
   const publishRun=(active,usage)=>app.evaluate(({BrowserWindow},{active,usage})=>{
    const fixture=globalThis.__composerFixture;
    fixture.historyRunActive=active;
    fixture.contextByAgent.main=usage;
    BrowserWindow.getAllWindows()[0].webContents.send('gateway:event',{kind:'history',key:'agent:main:main'});
   },{active,usage});
   const contextMeter=page.locator('#composer-context');
   const waitContext=pattern=>page.waitForFunction(pattern=>
    new RegExp(pattern,'i').test(document.querySelector('#composer-context')?.textContent.trim()||''),pattern.source);
   await waitContext(/25%/);
   assert.match(await contextMeter.getAttribute('aria-valuetext'),/8\D?000.*32\D?000/);
   await page.evaluate(()=>{
    // Restoring focus to a replacement select still dismisses the native popup.
    window.__composerPickerNodes=['composer-model','composer-reasoning'].map(id=>{
     const select=document.getElementById(id);
     return {select,options:[...select.options],value:select.value};
    });
   });
   const assertPickerOpen=async id=>{
    const actual=await page.evaluate(id=>{
     const stable=window.__composerPickerNodes.every(({select,options,value})=>
      document.getElementById(select.id)===select&&select.value===value&&
      select.options.length===options.length&&options.every((option,index)=>option===select.options[index]));
     const active=document.getElementById(id);
     return {stable,open:active.matches(':open'),focused:active.contains(document.activeElement)};
    },id);
    assert.deepEqual(actual,{stable:true,open:true,focused:true},id);
   };
   const dismiss=async id=>{
    await page.keyboard.press('Escape');
    await page.waitForFunction(id=>!document.getElementById(id).matches(':open'),id);
   };
   try {
    await page.locator('#composer-model').click();
    await assertPickerOpen('composer-model');
    await publishRun(true,promptUsage);
    await page.getByRole('button',{name:'Stop response',exact:true}).waitFor();
    await waitContext(/50%/);
    assert.match(await contextMeter.getAttribute('aria-valuetext'),/20\D?000.*40\D?000/);
    // The popup must also survive the next repaint of the live run timer.
    await page.waitForFunction(()=>{
     const elapsed=document.querySelector('[data-run-metric="elapsed"]');
     return elapsed&&elapsed.textContent!=='0s';
    });
    await assertPickerOpen('composer-model');
    await dismiss('composer-model');

    await page.locator('#composer-reasoning').click();
    await assertPickerOpen('composer-reasoning');
    await page.locator('#composer-input').evaluate(input=>{
     input.value='Background draft update.';
     input.dispatchEvent(new Event('input',{bubbles:true}));
    });
    await page.getByRole('button',{name:'Send message',exact:true}).waitFor();
    await assertPickerOpen('composer-reasoning');

    await publishRun(false,approximateUsage);
    await page.waitForFunction(()=>!document.querySelector('.run-status-bar.is-active'));
    await waitContext(/[~≈]\s*75%/);
    assert.match(await contextMeter.getAttribute('aria-valuetext'),/approximat/i);
    await assertPickerOpen('composer-reasoning');
    await publishRun(false,null);
    await waitContext(/Context\s*—/);
    await assertPickerOpen('composer-reasoning');
    await dismiss('composer-reasoning');
    assert.equal(count('sessions.patch'),0);
   } finally {
    if(await page.locator('.composer-select:open').count())await page.keyboard.press('Escape');
    await publishRun(null,initialUsage);
    await page.locator('#composer-input').fill('');
    await page.evaluate(()=>{delete window.__composerPickerNodes;});
   }
  });

  await check('Model and reasoning changes target the exact session and ordinary polling does not reload options',async()=>{
   const before=(await main()).calls.filter(c=>c.operation==='setComposer').length;
   const next=await page.locator('#composer-model').evaluate(select=>[...select.options].find(option=>option.value&&option.value!==select.value&&!option.disabled)?.value);assert.ok(next);
   await page.locator('#composer-model').selectOption(next);await ready();assert.equal(await page.locator('#composer-model').inputValue(),next);
   const level=await page.locator('#composer-reasoning').evaluate(select=>[...select.options].find(option=>option.value&&option.value!==select.value&&!option.disabled)?.value);assert.ok(level);
   await page.locator('#composer-reasoning').selectOption(level);await ready();
   const changes=(await main()).calls.filter(c=>c.operation==='setComposer').slice(before);assert.equal(changes.length,2);
   assert.deepEqual(changes[0].params,{...originalContext,model:next});assert.deepEqual(changes[1].params,{...originalContext,thinkingLevel:level});
   assert.equal(count('sessions.patch'),2);
   const reads=(await main()).calls.filter(c=>c.operation==='composerOptions').length,all=(await main()).calls.length;
   await page.locator('#composer-input').fill('Draft survives background refresh.');await page.waitForTimeout(3400);
   assert.ok((await main()).calls.length>all);assert.equal((await main()).calls.filter(c=>c.operation==='composerOptions').length,reads);
   assert.equal(await page.locator('#composer-input').inputValue(),'Draft survives background refresh.');assert.equal(await page.locator('#composer-model').inputValue(),next);assert.equal(await page.locator('#composer-reasoning').inputValue(),level);
  });

  await check('Native picker cancellation, opaque chips, removal and picker errors stay local',async()=>{
   await queuePick([]);await attach();assert.equal(await chips().count(),0);
   await queuePick([picture]);await attach();assert.equal(await chips().count(),1);assert.match(await chips().textContent(),/Picture & sample.png/);
   const [id]=await chipIds();assert.ok(id);assert.ok(!id.includes('/')&&!id.includes(pictureBytes.toString('base64')));
   assert.doesNotMatch(await page.locator('#composer-attachments').innerHTML(),new RegExp(profile.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
   await page.getByRole('button',{name:'Remove attachment Picture & sample.png',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.composer-attachment'));
   await app.evaluate(()=>{globalThis.__composerFixture.pickerError=true;});await attach();await page.waitForFunction(()=>document.querySelector('#composer-options-error')?.textContent.trim());assert.equal(await chips().count(),0);
   await refreshOptions();assert.equal(await page.locator('#composer-options-error .is-error').count(),0);
   assert.equal(count('chat.send'),0);
  });

  await check('A delayed picker and drafts remain bound to their originating session across child navigation',async()=>{
   await page.locator('#composer-input').fill('Coordinator draft with a pending picker.');await queuePick([picture]);
   await app.evaluate(()=>{globalThis.__composerFixture.pickerHold=true;});await page.getByRole('button',{name:'Attach media',exact:true}).click();
   await waitMain(()=>globalThis.__composerFixture.pickerReleases.length===1);
   if(!await page.locator('#work-panel').isVisible())await page.locator('#toggle-work').click();
   await page.locator('#work-content [data-action="session"]').first().click();await page.getByText('Builder exact child history',{exact:true}).waitFor();await ready();
   await page.waitForFunction(()=>document.querySelector('#composer-context')?.textContent.includes('50%'));
   assert.match(await page.locator('#composer-context').getAttribute('aria-valuetext'),/8\D?000.*16\D?000/);
   assert.equal(await page.locator('#composer-input').inputValue(),'');await page.locator('#composer-input').fill('Builder draft is separate.');
   await app.evaluate(()=>{const s=globalThis.__composerFixture;s.pickerHold=false;s.pickerReleases.splice(0).forEach(resolve=>resolve());});
   await page.waitForTimeout(120);assert.equal(await chips().count(),0);assert.equal(await page.locator('#composer-input').inputValue(),'Builder draft is separate.');
   await page.getByRole('button',{name:'Back to Coordinator'}).click();await page.getByText('Coordinator is coordinating.',{exact:true}).waitFor();await ready();
   assert.equal(await page.locator('#composer-input').inputValue(),'Coordinator draft with a pending picker.');assert.equal(await chips().count(),1);
  });

  await check('An attachment-only send reaches the actual backend and fake gateway with exact token and session identity',async()=>{
   const options=(await main()).lastOptions,imageModel=options.models.find(model=>model.available!==false&&model.manualSelectionAllowed!==false&&model.input?.includes('image'));assert.ok(imageModel);
   if(await page.locator('#composer-model').inputValue()!==imageModel.value){await page.locator('#composer-model').selectOption(imageModel.value);await ready();}
   await page.locator('#composer-input').fill('');const ids=await chipIds();assert.equal(ids.length,1);
   const before=count('chat.send');await page.waitForFunction(()=>!document.querySelector('#send-message').disabled);await page.getByRole('button',{name:'Send message',exact:true}).click();
   await page.waitForFunction(()=>document.querySelector('#composer-status')?.textContent.includes('Message accepted'));
   assert.equal(count('chat.send'),before+1);const sent=persisted().sent.at(-1),received=(await main()).calls.filter(c=>c.operation==='send').at(-1).params;
   assert.deepEqual(received.attachmentIds,ids);assert.equal(received.message,'');assert.equal(received.sessionId,originalContext.sessionId);assert.equal(received.agentId,'main');
   assert.equal(sent.sessionKey,originalContext.key);assert.equal(sent.sessionId,originalContext.sessionId);assert.equal(sent.message,'');assert.equal(sent.idempotencyKey,received.requestId);assert.equal(sent.attachments.length,1);
   assert.ok(JSON.stringify(sent.attachments).includes(pictureBytes.toString('base64')));assert.equal(await chips().count(),0);
   assert.equal(Object.hasOwn(received,'attachments'),false);assert.equal(Object.hasOwn(received,'paths'),false);
  });

  await check('Uncertain send retries retain exact attachment IDs and submission identity while preserving a newer draft',async()=>{
   await queuePick([picture]);await attach();await page.locator('#composer-input').fill('Fixture attachment retry.');const ids=await chipIds(),before=count('chat.send');
   await app.evaluate(()=>{globalThis.__composerFixture.uncertainSend=true;});await page.getByRole('button',{name:'Send message',exact:true}).click();
   await page.getByRole('button',{name:'Retry the same message request',exact:true}).waitFor();
   assert.deepEqual(await chipIds(),ids);assert.equal(await page.getByRole('button',{name:'Attach media',exact:true}).isDisabled(),true);assert.equal(await page.locator('#composer-model').isDisabled(),true);
   assert.equal(await page.getByRole('button',{name:'Remove attachment Picture & sample.png',exact:true}).isDisabled(),true);
   await page.locator('#composer-input').fill('Newer draft survives the retry.');await page.getByRole('button',{name:'Retry the same message request',exact:true}).click();
   await page.waitForFunction(()=>document.querySelector('#composer-status')?.textContent.includes('Message accepted'));
   const sends=(await main()).calls.filter(c=>c.operation==='send').slice(-2);assert.deepEqual(sends[0].params,sends[1].params);assert.deepEqual(sends[1].params.attachmentIds,ids);
   assert.equal(count('chat.send'),before+1);assert.equal(await chips().count(),0);assert.equal(await page.locator('#composer-input').inputValue(),'Newer draft survives the retry.');
  });

  await check('Unconfirmed model changes require a fresh options read and do not lose the draft',async()=>{
   await ready();const before=count('sessions.patch'),next=await page.locator('#composer-model').evaluate(select=>[...select.options].find(option=>option.value&&option.value!==select.value&&!option.disabled)?.value);assert.ok(next);
   await app.evaluate(()=>{globalThis.__composerFixture.settingError=true;});await page.locator('#composer-model').selectOption(next);
   await page.waitForFunction(()=>document.querySelector('#composer-options-error')?.textContent.includes('Setting outcome unconfirmed'));
   assert.equal(await page.locator('#composer-model').isDisabled(),true);assert.equal(await page.locator('#composer-reasoning').isDisabled(),true);assert.equal(count('sessions.patch'),before);
   assert.equal(await page.locator('#composer-input').inputValue(),'Newer draft survives the retry.');await refreshOptions();assert.equal(await page.locator('#composer-options-error .is-error').count(),0);
  });

  await check('Locked, unavailable and failed model catalogs are explicit and recover through a read',async()=>{
   await app.evaluate(()=>{globalThis.__composerFixture.optionsMode='locked';});await page.reload();await page.getByText('Coordinator is coordinating.',{exact:true}).waitFor();
   await page.waitForFunction(()=>document.querySelector('#composer-options-error')?.textContent.includes('locked'));
   assert.equal(await page.locator('#composer-model').isDisabled(),true);assert.equal(await page.locator('#composer-reasoning').isDisabled(),false);
   await app.evaluate(()=>{globalThis.__composerFixture.optionsMode='unavailable';});await page.reload();await page.waitForFunction(()=>document.querySelector('#composer-options-error')?.textContent.includes('catalog unavailable'));
   assert.equal(await page.locator('#composer-model').isDisabled(),true);assert.equal(await page.locator('#composer-reasoning').isDisabled(),true);
   await app.evaluate(()=>{globalThis.__composerFixture.optionsMode='error';});await page.reload();await page.getByText('Fixture model options unavailable.',{exact:false}).waitFor();
   assert.equal(await page.locator('#composer-model').isDisabled(),true);await app.evaluate(()=>{globalThis.__composerFixture.optionsMode='source';});await refreshOptions();
  });

  await check('Offline controls cannot pick or mutate options and retain exact-session attachments',async()=>{
   await queuePick([picture]);await attach();const ids=await chipIds();await page.locator('#composer-input').fill('Offline draft.');const before=(await main()).calls.length,dialogCount=(await main()).dialogs.length;
   fs.writeFileSync(path.join(profile,'offline'),'fixture only');await page.locator('#connection-notice [data-action="reconnect"]').click();
   await page.waitForFunction(()=>document.querySelector('#attach-media')?.disabled&&document.querySelector('#send-message')?.disabled);
   assert.equal(await page.locator('#composer-model').isDisabled(),true);assert.equal(await page.locator('#composer-reasoning').isDisabled(),true);assert.deepEqual(await chipIds(),ids);
   await page.locator('#composer-input').press('Enter');assert.equal((await main()).dialogs.length,dialogCount);assert.equal((await main()).calls.slice(before).filter(c=>['send','setComposer'].includes(c.operation)).length,0);
   fs.unlinkSync(path.join(profile,'offline'));await page.locator('#connection-notice [data-action="reconnect"]').click();await ready();assert.equal(await page.locator('#composer-input').inputValue(),'Offline draft.');assert.deepEqual(await chipIds(),ids);
  });

  await check('Composer controls remain within 1100 and 880 pixel windows with no external effects',async()=>{
   await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1440,1000));await page.locator('#composer-input').fill('Summarize this image.');
   if(!await page.locator('#work-panel').isVisible())await page.locator('#toggle-work').click();
   for(const theme of ['dark','light']){await menu('theme:'+theme);await page.screenshot({path:path.join(evidence,`composer-1440-${theme}.png`)});}
   if(await page.locator('#work-panel').isVisible())await page.locator('#close-work').click();
   for(const width of [1100,880]){
    await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,820),width);await page.waitForTimeout(180);
    for(const selector of ['#attach-media','#composer-model','#composer-reasoning','#composer-context','#send-message']){
     const box=await page.locator(selector).boundingBox();assert.ok(box&&box.x>=0&&box.x+box.width<=width+1,`${selector} fits ${width}`);
    }
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:path.join(evidence,`composer-${width}.png`)});
   }
   assert.deepEqual(errors,[]);assert.deepEqual(network,[]);assert.deepEqual((await main()).native,[]);
  });
 } finally {
  await app.evaluate(()=>{globalThis.__composerFixture?.pickerReleases.splice(0).forEach(resolve=>resolve());}).catch(()=>{});
  fs.writeFileSync(path.join(evidence,'composer-tests.json'),JSON.stringify({at:new Date().toISOString(),checks,errors,network,profile,scope:'Isolated native fixture. Picker intercepted; supported backend reads/writes use fake CLI only. No production reads, sends, settings changes, gateway mutations or native external actions.'},null,2));
  await app.close();
 }
 console.log(JSON.stringify({passed:checks.filter(item=>item.pass).length,failed:checks.filter(item=>!item.pass).length,profile}));process.exitCode=checks.some(item=>!item.pass)?1:0;
})().catch(error=>{console.error(error);process.exitCode=1;});
