'use strict';
const {_electron}=require('./test-support.cjs').playwright;
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),evidence=require('./test-support.cjs').evidenceDirectory('terminal');
fs.mkdirSync(evidence,{recursive:true});
const profile=fs.mkdtempSync(path.join(evidence,'fixture-profile-'));
fs.writeFileSync(path.join(profile,'fixture-terminal.json'),'{}');
const picture=path.join(profile,'Terminal selection attachment.png');
fs.writeFileSync(picture,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==','base64'));
const env={...process.env,OPENCLAW_PLUS_TEST_DATA:profile,OPENCLAW_PLUS_TEST_CLI:path.join(root,'tests/fixture-gateway.cjs')};
delete env.ELECTRON_RUN_AS_NODE;
const context={key:'agent:main:main',agentId:'main',sessionId:'physical-main'};
const childContext={key:'agent:builder:child',agentId:'builder',sessionId:'physical-child'};
const gatewayCalls=()=>fs.existsSync(path.join(profile,'fixture-calls.jsonl'))?fs.readFileSync(path.join(profile,'fixture-calls.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];

(async()=>{
 const app=await _electron.launch({executablePath:path.join(root,'desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[path.join(root,'desktop')],env});
 const page=await app.firstWindow();page.setDefaultTimeout(12000);
 const checks=[],errors=[],network=[],csp=[];
 page.on('pageerror',error=>errors.push(error.message));
 page.on('request',request=>{if(/^(?:https?|wss?):/.test(request.url()))network.push(request.url());});
 page.on('console',message=>{if(message.type()==='error'&&/Content Security Policy|Refused to (?:apply|execute|load)/i.test(message.text()))csp.push(message.text());});
 const check=async(name,fn)=>{try{await fn();checks.push({name,pass:true});console.log('PASS',name);}catch(error){checks.push({name,pass:false,error:error.message});console.log('FAIL',name,error.message);await page.screenshot({path:path.join(evidence,'failure-'+checks.length+'.png')}).catch(()=>{});}};
 const main=()=>app.evaluate(()=>({calls:globalThis.__terminalFixture.calls,native:globalThis.__terminalFixture.native}));
 const requests=async action=>(await main()).calls.filter(call=>call.action===action);
 const until=async predicate=>{const end=Date.now()+12000;while(Date.now()<end){if(await predicate())return;await page.waitForTimeout(30);}throw new Error('Fixture action did not settle.');};
 const pane=()=>page.locator('#terminal-mount');
 const instance=()=>page.locator('#terminal-mount .terminal-instance:visible');
 const output=()=>instance().locator('.xterm-rows');
 const input=()=>instance().locator('.xterm-helper-textarea');
 const ready=async()=>{const button=page.getByRole('button',{name:'Disconnect terminal',exact:true});await button.waitFor({state:'visible'});await until(()=>button.isEnabled());};
 const openPane=async()=>{if(!await pane().isVisible())await page.locator('#toggle-terminal').click();};
 const theme=id=>app.evaluate(({Menu},id)=>Menu.getApplicationMenu().getMenuItemById('theme:'+id).click(),id);
 const emit=event=>app.evaluate(({BrowserWindow},event)=>BrowserWindow.getAllWindows()[0].webContents.send('terminal:event',event),event);
 const reachable=async locator=>{
  await locator.scrollIntoViewIfNeeded();
  assert.equal(await locator.evaluate(node=>{const box=node.getBoundingClientRect(),hit=document.elementFromPoint(box.x+box.width/2,box.y+box.height/2);return box.x>=0&&box.right<=innerWidth+1&&box.y>=0&&box.bottom<=innerHeight+1&&Boolean(hit&&(hit===node||node.contains(hit)));}),true,'control is reachable inside the window');
 };
 let terminalId,childTerminalId;
 try {
  await app.evaluate(({ipcMain,BrowserWindow,shell,clipboard,dialog},picture)=>{
   BrowserWindow.getAllWindows()[0].setSize(1440,1000);
   const fixture=globalThis.__terminalFixture={calls:[],native:[]};
   const original=ipcMain._invokeHandlers.get('desktop:terminal');
   if(typeof original!=='function')throw new Error('Terminal IPC handler is not installed.');
   ipcMain.removeHandler('desktop:terminal');
   ipcMain.handle('desktop:terminal',async(event,action,params)=>{
    const call={action,params:structuredClone(params)};fixture.calls.push(call);
    const result=await original(event,action,params);call.result=structuredClone(result);return result;
   });
   shell.openExternal=async value=>fixture.native.push(['external',value]);
   shell.showItemInFolder=value=>fixture.native.push(['reveal',value]);
   clipboard.writeText=value=>fixture.native.push(['copy',value]);
   clipboard.readText=()=>{fixture.native.push(['read-clipboard']);return 'Fixture private clipboard';};
   dialog.showOpenDialog=async()=>({canceled:false,filePaths:[picture]});
  },picture);
  await page.addInitScript(()=>{
   window.__terminalNativeAttempts=[];
   window.open=()=>{window.__terminalNativeAttempts.push('open-window');return null;};
   Object.defineProperty(navigator,'clipboard',{configurable:true,value:{
    readText:async()=>{window.__terminalNativeAttempts.push('read-clipboard');return 'Fixture private clipboard';},
    writeText:async()=>{window.__terminalNativeAttempts.push('write-clipboard');},
   }});
  });
  await page.reload();await page.getByText('Coordinator is coordinating.',{exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector('#toggle-terminal')&&!document.querySelector('#toggle-terminal').disabled);
  if(await page.locator('#work-panel').isVisible())await page.locator('#close-work').click();
  await page.locator('#work-panel').waitFor({state:'hidden'});

  await check('Opening the terminal pane requires a separate explicit Start and preserves renderer isolation',async()=>{
   assert.equal(page.url(),'openclaw-plus://ui/index.html');
   assert.deepEqual(await page.evaluate(()=>[typeof require,typeof process]),['undefined','undefined']);
   assert.equal((await requests('open')).length,0);
   await page.locator('#composer-input').fill('Keep this Coordinator draft.');
   await page.locator('#toggle-terminal').focus();await page.keyboard.press('Enter');
   await page.getByRole('button',{name:'Start terminal',exact:true}).waitFor();
   assert.equal((await requests('open')).length,0);assert.equal((await requests('input')).length,0);
   assert.equal(await page.locator('#composer-input').inputValue(),'Keep this Coordinator draft.');
   try {
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(880,640));await page.waitForTimeout(300);
    await reachable(page.getByRole('button',{name:'Start terminal',exact:true}));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:path.join(evidence,'terminal-minimum-start-880.png')});
   } finally {
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1440,1000));await page.waitForTimeout(150);
   }
  });

  await check('Explicit Start opens one exact-session fixture terminal and renders its local output',async()=>{
   await page.getByRole('button',{name:'Start terminal',exact:true}).click();await ready();
   await output().getByText('Fixture terminal — no commands execute.',{exact:false}).waitFor();
   await until(async()=>Boolean((await requests('open'))[0]?.result));
   const opens=await requests('open');assert.equal(opens.length,1);
   assert.deepEqual(Object.fromEntries(Object.keys(context).map(key=>[key,opens[0].params[key]])),context);
   assert.ok(opens[0].params.cols>0&&opens[0].params.rows>0);assert.equal(opens[0].result.ok,true);
   terminalId=opens[0].result.data.terminalId;assert.equal(opens[0].result.data.shell,'Fixture terminal');
   assert.equal(opens[0].result.data.context.sessionId,context.sessionId);
   assert.ok((await input().getAttribute('aria-label'))?.length>0);
  });

  await check('Keyboard text, Enter and Ctrl+C stay in the terminal and never submit or stop chat',async()=>{
   const before=(await requests('input')).length;
   await input().focus();await page.keyboard.type('echo fixture-only');await page.keyboard.press('Enter');await page.keyboard.press('Control+c');
   await until(async()=>(await requests('input')).slice(before).map(call=>call.params.data).join('').endsWith('\x03'));
   const sent=(await requests('input')).slice(before);assert.ok(sent.length>0);
   assert.equal(sent.map(call=>call.params.data).join(''),'echo fixture-only\r\x03');
   assert.ok(sent.every(call=>call.params.terminalId===terminalId&&call.params.sessionId===context.sessionId));
   assert.equal(await page.locator('#composer-input').inputValue(),'Keep this Coordinator draft.');
   assert.equal(gatewayCalls().filter(call=>['chat.send','chat.abort'].includes(call.method)).length,0);
  });

  await check('Hide and reopen preserve the same terminal without detaching or starting another shell',async()=>{
   const detachCount=(await requests('detach')).length;
   await page.getByRole('button',{name:'Hide terminal',exact:true}).click();await pane().waitFor({state:'hidden'});
   assert.equal((await requests('detach')).length,detachCount);
   await openPane();await ready();assert.equal((await requests('open')).length,1);
   assert.equal(await page.locator('#composer-input').inputValue(),'Keep this Coordinator draft.');
   await output().getByText('echo fixture-only',{exact:false}).waitFor();
  });

  await check('Navigation keeps terminals and drafts bound to exact parent and child conversations',async()=>{
   try {
   if(!await page.locator('#work-panel').isVisible())await page.locator('#toggle-work').click();
   await page.locator('#work-content [data-action="session"]').first().click();
   await page.getByText('Builder exact child history',{exact:true}).waitFor();await openPane();
   await page.getByRole('button',{name:'Start terminal',exact:true}).waitFor();assert.equal((await requests('open')).length,1);
   await page.getByRole('button',{name:'Start terminal',exact:true}).click();await ready();
   await until(async()=>Boolean((await requests('open'))[1]?.result));
   const open=(await requests('open')).at(-1);childTerminalId=open.result.data.terminalId;
   assert.notEqual(childTerminalId,terminalId);assert.equal(open.params.key,childContext.key);assert.equal(open.params.agentId,childContext.agentId);
   childContext.sessionId=open.params.sessionId;
   await page.locator('#composer-input').fill('Keep this Builder draft.');
   await input().focus();await page.keyboard.type('builder-only');await page.waitForTimeout(150);
   assert.equal((await requests('input')).at(-1).params.terminalId,childTerminalId);
   await page.keyboard.press('Escape');await page.waitForTimeout(100);
   assert.ok(await page.getByText('Builder exact child history',{exact:true}).isVisible());
   assert.equal(await page.locator('#composer-input').inputValue(),'Keep this Builder draft.');
   assert.ok(await page.getByRole('button',{name:'Back to Coordinator'}).isVisible());
   await page.getByRole('button',{name:'Back to Coordinator'}).click();await page.getByText('Coordinator is coordinating.',{exact:true}).waitFor();await openPane();await ready();
   assert.equal(await page.locator('#composer-input').inputValue(),'Keep this Coordinator draft.');assert.equal((await requests('open')).length,2);
   const wrong=await page.evaluate(async({context,id})=>{try{await window.openclawPlusDesktop.terminal('input',{...context,terminalId:id,data:'wrong-owner'});return {rejected:false};}catch(error){return {rejected:true,message:error.message};}},{context:childContext,id:terminalId});
   assert.equal(wrong.rejected,true);assert.match(wrong.message,/not opened for this exact conversation/i);
   const denial=(await requests('input')).find(call=>call.params.data==='wrong-owner');
   assert.equal(denial.result.ok,false);assert.equal(denial.result.error.code,'DENIED');
   assert.ok((await page.locator('.terminal-instance').allTextContents()).every(text=>!text.includes('wrong-owner')));
   } finally {
    if(await page.locator('#work-panel').isVisible())await page.locator('#close-work').click();
   }
  });

  await check('Terminal output stays inert and cannot open links, read or write the clipboard, or alter another context',async()=>{
   const hostile='<img src=x onerror="window.terminalInjected=true">';
   await emit({kind:'data',context:childContext,terminalId,data:'WRONG CONTEXT OUTPUT',reset:true});
   await emit({kind:'data',context,terminalId,data:hostile+'\r\n\x1b]52;c;c2VjcmV0\x07\x1b]52;c;?\x07\x1b]8;;javascript:window.terminalInjected=true\x07hostile-link\x1b]8;;\x07\r\n$ ',reset:true});
   await output().getByText(hostile,{exact:false}).waitFor();
   assert.equal(await instance().locator('img,script,iframe').count(),0);assert.equal(await page.evaluate(()=>window.terminalInjected),undefined);
   assert.ok(!(await instance().textContent()).includes('WRONG CONTEXT OUTPUT'));
   const link=output().getByText('hostile-link',{exact:true}),linkBox=await link.boundingBox();assert.ok(linkBox);
   await page.keyboard.down('Meta');
   try{await page.mouse.move(linkBox.x+6,linkBox.y+6);await page.waitForTimeout(50);await page.mouse.click(linkBox.x+6,linkBox.y+6);}
   finally{await page.keyboard.up('Meta');}
   assert.equal(page.url(),'openclaw-plus://ui/index.html');assert.deepEqual((await main()).native,[]);
   assert.deepEqual(await page.evaluate(()=>window.__terminalNativeAttempts),[]);
   assert.equal(gatewayCalls().filter(call=>call.method==='chat.send').length,0);
  });

  await check('Add selection prepares an ordinary message while preserving its draft and attachment',async()=>{
   await page.waitForFunction(()=>!document.querySelector('#attach-media').disabled);
   await page.getByRole('button',{name:'Attach media',exact:true}).click();await page.locator('.composer-attachment').waitFor();
   const ids=await page.locator('.composer-attachment').evaluateAll(nodes=>nodes.map(node=>node.dataset.attachmentId));
   await emit({kind:'data',context,terminalId,data:'Shared selection fixture.\r\n$ ',reset:true});
   const text=output().getByText('Shared selection fixture.',{exact:true});await text.waitFor();
   const box=await text.boundingBox();assert.ok(box&&box.width>0);
   await page.mouse.move(box.x+1,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width-1,box.y+box.height/2,{steps:8});await page.mouse.up();
   await page.getByRole('button',{name:'Add selection to message',exact:true}).click();
   const draft=await page.locator('#composer-input').inputValue();assert.ok(draft.startsWith('Keep this Coordinator draft.'));assert.ok(draft.includes('Shared selection fixture'));
   assert.deepEqual(await page.locator('.composer-attachment').evaluateAll(nodes=>nodes.map(node=>node.dataset.attachmentId)),ids);
   assert.equal(gatewayCalls().filter(call=>call.method==='chat.send').length,0);
  });

  await check('Disconnect detaches the viewer and explicit Reconnect reuses the shared shell',async()=>{
   const opened=(await requests('open')).length;
   await page.getByRole('button',{name:'Disconnect terminal',exact:true}).click();
   await page.getByRole('button',{name:'Reconnect terminal',exact:true}).waitFor();
   assert.equal((await requests('detach')).at(-1).params.terminalId,terminalId);
   assert.equal(await input().evaluate(node=>node.readOnly),true);
   await page.getByRole('button',{name:'Reconnect terminal',exact:true}).click();await ready();
   assert.equal((await requests('attach')).at(-1).params.terminalId,terminalId);assert.equal((await requests('open')).length,opened);
   await output().getByText('Fixture terminal — no commands execute.',{exact:false}).waitFor();
  });

  await check('Maximum native replay stays connected and queued output overflow detaches without opening another shell',async()=>{
   const opened=(await requests('open')).length,detached=(await requests('detach')).length;
   const suffix='\r\nMAXIMUM_REPLAY_COMPLETE\r\n$ ';
   await emit({kind:'data',context,terminalId,data:'A'.repeat(2*1024*1024-suffix.length)+suffix,reset:true});
   await output().getByText('MAXIMUM_REPLAY_COMPLETE',{exact:false}).waitFor();await ready();
   assert.equal((await requests('detach')).length,detached);
   await page.evaluate(async()=>{
    const {Terminal}=await import('./vendor/xterm.mjs');
    const original=Terminal.prototype.write,callbacks=[];
    window.__terminalWriteHold={restore(){Terminal.prototype.write=original;for(const callback of callbacks)callback();}};
    // Simulate a slow renderer without rendering megabytes merely to fill the pending queue.
    Terminal.prototype.write=function(data,callback){if(callback){callbacks.push(callback);return;}return original.call(this,data);};
   });
   try{
    for(let index=0;index<17;index++)await emit({kind:'data',context,terminalId,data:'B'.repeat(128*1024)});
    await until(async()=>(await requests('detach')).length>detached);
    await page.getByRole('button',{name:'Reconnect terminal',exact:true}).waitFor();
    assert.ok((await pane().textContent()).includes('Output could not keep up'));
    assert.equal((await requests('open')).length,opened);
   }finally{await page.evaluate(()=>{window.__terminalWriteHold?.restore();delete window.__terminalWriteHold;});}
   await page.getByRole('button',{name:'Reconnect terminal',exact:true}).click();await ready();
   assert.equal((await requests('open')).length,opened);
  });

  await check('Both split orientations fit desktop and narrow windows without CSP errors or native side effects',async()=>{
   if(await page.locator('#work-panel').isVisible())await page.locator('#close-work').click();
   await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1440,1000));await page.waitForTimeout(150);
   await page.locator('#terminal-orientation').selectOption({label:'Beside chat'});await page.waitForTimeout(300);
   const separator=page.locator('#terminal-separator'),before=Number(await separator.getAttribute('aria-valuenow')),beforeWidth=(await pane().boundingBox()).width;
   assert.equal(await separator.getAttribute('aria-orientation'),'vertical');
   await separator.focus();await page.keyboard.press('ArrowLeft');
   await until(async()=>Number(await separator.getAttribute('aria-valuenow'))>before);
   await until(async()=>(await pane().boundingBox()).width>beforeWidth+1);
   await theme('dark');await page.screenshot({path:path.join(evidence,'terminal-dark-1440.png')});
   await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1100,900));await theme('light');await page.waitForTimeout(300);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   await page.screenshot({path:path.join(evidence,'terminal-light-1100.png')});
   await page.locator('#terminal-orientation').selectOption({label:'Below chat'});
   await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(880,900));await page.waitForTimeout(300);
   const box=await pane().boundingBox();assert.ok(box&&box.x>=0&&box.x+box.width<=881);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   for(const call of await requests('resize'))assert.ok(Number.isInteger(call.params.cols)&&call.params.cols>0&&Number.isInteger(call.params.rows)&&call.params.rows>0);
   await page.screenshot({path:path.join(evidence,'terminal-light-880.png')});
   await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(880,640));await page.waitForTimeout(300);
   await reachable(page.getByRole('button',{name:'Add selection to message',exact:true}));
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   await page.screenshot({path:path.join(evidence,'terminal-minimum-share-880.png')});
   assert.deepEqual(errors,[]);assert.deepEqual(csp,[]);assert.deepEqual(network,[]);assert.deepEqual((await main()).native,[]);
   assert.deepEqual(await page.evaluate(()=>window.__terminalNativeAttempts),[]);
   assert.equal(gatewayCalls().filter(call=>['chat.send','chat.abort'].includes(call.method)).length,0);
  });
 } finally {
  fs.writeFileSync(path.join(evidence,'terminal-tests.json'),JSON.stringify({at:new Date().toISOString(),checks,errors,csp,network,profile,scope:'Isolated native app with real TerminalService and in-memory echo connector. No PTY, shell commands, production gateway calls or native clipboard/Finder/external actions.'},null,2));
  await app.close();
 }
 console.log(JSON.stringify({passed:checks.filter(check=>check.pass).length,failed:checks.filter(check=>!check.pass).length,profile}));
 process.exitCode=checks.some(check=>!check.pass)?1:0;
})().catch(error=>{console.error(error);process.exitCode=1;});
