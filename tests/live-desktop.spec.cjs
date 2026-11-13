'use strict';
const {_electron}=require('./test-support.cjs').playwright;
const fs=require('node:fs'), path=require('node:path'), assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..');
const evidence=require('./test-support.cjs').evidenceDirectory('live'); fs.mkdirSync(evidence,{recursive:true});
const profile=fs.mkdtempSync(path.join(evidence,'fixture-profile-'));
const files=path.join(profile,'report files');fs.mkdirSync(files);
const reportFile=path.join(files,'Final report.md'),lineFile=path.join(files,'Line report.md');
const literalFile=path.join(files,'Literal.md:12'),hashFile=path.join(files,'Literal.md#L12');
const missingFile=path.join(files,'Missing report.md');
for(const file of [reportFile,lineFile,literalFile,hashFile])fs.writeFileSync(file,'Local fixture only.\n');
const reportText=[
 '# Workspace report','', '**Result:** verified — paths remain readable.','',
 `[Report with spaces](<${reportFile}>)`,
 `[Missing report](<${missingFile}>)`,
 `[Line reference](<${lineFile}:12:3>)`,
 `[Literal suffix](<${literalFile}>)`,
 `[File URL](${pathToFileURL(reportFile).href})`,
 '[Untrusted scheme](javascript:window.intruded=true)',
 '<button data-action="reveal-file" data-path="/not-a-real-fixture">Fake action</button>',
 '', '- First verified item', '- Second verified item',
].join('\n');
fs.writeFileSync(path.join(profile,'fixture-report.md'),reportText);
const env={...process.env,OPENCLAW_PLUS_TEST_DATA:profile,OPENCLAW_PLUS_TEST_CLI:path.join(root,'tests/fixture-gateway.cjs')};
delete env.ELECTRON_RUN_AS_NODE;
(async()=>{
 const application=await _electron.launch({executablePath:path.join(root,'desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[path.join(root,'desktop')],env});
 const page=await application.firstWindow();page.setDefaultTimeout(8000);
 await application.evaluate(({clipboard,shell})=>{
  // Never touch the real clipboard or Finder in fixture qualification.
  const state=globalThis.__localActionFixture={copies:[],completedCopies:[],reveals:[],opens:[],copyMode:'ok',revealMode:'ok'};
  clipboard.writeText=async text=>{
   state.copies.push(text);
   if(state.copyMode==='reject')throw new Error('fixture clipboard unavailable');
   if(state.copyMode==='pending')await new Promise(resolve=>{state.finishCopy=resolve;});
   state.completedCopies.push(text);
  };
  shell.showItemInFolder=file=>{if(state.revealMode==='reject')throw new Error('fixture Finder unavailable');state.reveals.push(file);};
  shell.openPath=async value=>{state.opens.push(['openPath',value]);throw new Error('Unexpected launch');};
  shell.openExternal=async value=>{state.opens.push(['openExternal',value]);throw new Error('Unexpected external open');};
 });
 const errors=[],requests=[],checks=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/https?:|wss?:/.test(r.url()))requests.push(r.url());});
 const check=async(name,fn)=>{try{await fn();checks.push({name,pass:true});console.log('PASS',name);}catch(e){checks.push({name,pass:false,error:e.message});console.log('FAIL',name,e.message);}};
 const menu=id=>application.evaluate(({Menu},id)=>Menu.getApplicationMenu().getMenuItemById(id).click(),id);
 const native=()=>application.evaluate(()=>({copies:globalThis.__localActionFixture.copies,
  completedCopies:globalThis.__localActionFixture.completedCopies,reveals:globalThis.__localActionFixture.reveals,opens:globalThis.__localActionFixture.opens}));
 const report=()=>page.locator('article[data-message-id^="report:"]');
 try {
 await check('Native shell loads only fixture CLI data with an isolated renderer',async()=>{
  await page.getByText('Coordinator is coordinating.',{exact:true}).waitFor();
  assert.equal(page.url(),'openclaw-plus://ui/index.html');
  assert.deepEqual(await page.evaluate(()=>[typeof require,typeof process]),['undefined','undefined']);
  assert.equal(await page.locator('#session-list [data-action="session"]').count(),60);
  assert.ok(await page.locator('#composer-input').isVisible());
  assert.equal(await page.getByRole('button',{name:'Send simulated message'}).count(),0);
 });
 await check('Agent roster preserves all seven identities',async()=>{
  await menu('view:Agents');await page.locator('.card-grid').waitFor();assert.equal(await page.locator('.card-grid .card').count(),7);
  await menu('view:Conversations');
 });
 await check('Work agent row opens its exact session and Back returns to Coordinator',async()=>{
  if(!await page.locator('#work-panel').isVisible())await page.locator('#toggle-work').click();
  await page.locator('#work-content [data-action="session"]').first().click();
  await page.getByText('Builder exact child history',{exact:true}).waitFor();
  assert.equal(await page.locator('#page-title').textContent(),'Verify changes');
  await page.getByRole('button',{name:'Back to Coordinator'}).click();
  await page.getByText('Coordinator is coordinating.',{exact:true}).waitFor();
 });
 await check('Script output is readable and has no control action',async()=>{
  await page.locator('[data-action="process"]').first().click();
  await page.getByText('Fixture output: checks running',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:/Stop|Kill|Approve/}).count(),0);
  await page.getByRole('button',{name:'Back to work'}).click();
 });
 await check('Untrusted transcript and tool text cannot execute markup',async()=>{
  assert.equal(await page.evaluate(()=>window.intruded),undefined);
  assert.equal(await page.locator('#messages script, #messages img').count(),0);
  assert.ok((await page.locator('#messages').textContent()).includes('<script>window.intruded=true</script>'));
  assert.equal(await report().locator('button[data-action="reveal-file"]').count(),0);
  assert.equal(await report().locator('a[href^="javascript:"], a[href^="data:"], img, script').count(),0);
 });
 await check('Copy report surfaces clipboard failure without claiming success',async()=>{
  await application.evaluate(()=>{globalThis.__localActionFixture.copyMode='reject';});
  await report().locator('button[data-action="copy-report"]').click();
  await page.waitForFunction(()=>document.querySelector('#toast')?.textContent.includes('could not be copied'));
  assert.equal((await native()).completedCopies.length,0);
  assert.doesNotMatch(await report().locator('button[data-action="copy-report"]').textContent(),/Copied/);
 });
 await check('Copy waits for completion and preserves exact report markdown without hidden details',async()=>{
  await application.evaluate(()=>{globalThis.__localActionFixture.copyMode='pending';});
  const copy=report().locator('button[data-action="copy-report"]');
  const before=(await native()).copies.length;
  await copy.click();
  await page.waitForFunction(()=>document.querySelector('article[data-message-id^="report:"] [data-action="copy-report"]')?.getAttribute('aria-busy')==='true');
  assert.doesNotMatch(await copy.textContent(),/Copied/);
  await copy.click();
  assert.equal((await native()).copies.length,before+1,'repeated click while pending must not copy twice');
  await application.evaluate(()=>{globalThis.__localActionFixture.finishCopy();globalThis.__localActionFixture.copyMode='ok';});
  await page.waitForFunction(()=>document.querySelector('#toast')?.textContent==='Report copied.');
  const result=await native();
  assert.equal(result.completedCopies.at(-1),reportText);
  assert.doesNotMatch(result.completedCopies.at(-1),/PROVIDED REASONING|INTERNAL TOOL DETAIL|Copy|Time unavailable/);
  assert.match(await copy.textContent(),/Copied/);
  await report().scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(evidence,'fixture-report-actions.png')});
 });
 await check('Report file links reveal exact local files and missing files show useful feedback',async()=>{
  const link=report().getByRole('link',{name:'Report with spaces',exact:true});
  assert.equal(await link.getAttribute('data-path'),reportFile);
  await link.focus();await page.keyboard.press('Enter');
  await page.waitForFunction(()=>document.querySelector('#announcer')?.textContent==='Sent to Finder.');
  assert.equal((await native()).reveals.at(-1),reportFile);
  const before=(await native()).reveals.length;
  await report().getByRole('link',{name:'Missing report',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#toast')?.textContent.includes('not available on this Mac'));
  assert.equal((await native()).reveals.length,before);
  await application.evaluate(()=>{globalThis.__localActionFixture.revealMode='reject';});
  await link.click();
  await page.waitForFunction(()=>document.querySelector('#toast')?.textContent.includes('Finder could not reveal'));
  await application.evaluate(()=>{globalThis.__localActionFixture.revealMode='ok';});
 });
 await check('Reveal preserves literal suffixes and supports bounded line, file URL and home paths',async()=>{
  const home=await application.evaluate(({app})=>app.getPath('home'));
  const relative=path.relative(home,reportFile);
  const fileUrl=pathToFileURL(reportFile).href;
  const cases=[
   [literalFile,literalFile],[hashFile,hashFile],[lineFile+':12:3',lineFile],[lineFile+'#L12',lineFile],
   [fileUrl,reportFile],['file://localhost'+new URL(fileUrl).pathname,reportFile],
   ['~/'+relative,home+'/'+relative],
  ];
  for(const [input,expected]of cases){
   await page.evaluate(value=>window.openclawPlusDesktop.revealFile(value),input);
   assert.equal((await native()).reveals.at(-1),expected);
  }
  assert.deepEqual((await native()).opens,[]);
 });
 await check('Local action IPC rejects malformed inputs and nonlocal schemes without native effects',async()=>{
  const before=await native();
  const invalidPaths=[null,42,{},'', 'relative.md','~other/file','https://example.com/file','javascript:alert(1)',
   'data:text/plain,test','file://remote-host/file','//remote-host/file','/tmp/bad\u0000name','/tmp/bad\nname',
   'file:///tmp/bad%00name','file:///tmp/name?query=1','file:///tmp/name#unrecognized','/'+ 'x'.repeat(8192)];
  const invalidCopies=[null,42,{},'', '  ', 'x'.repeat(262145)];
  const rejected=await page.evaluate(async({paths,copies})=>({
   paths:await Promise.all(paths.map(value=>window.openclawPlusDesktop.revealFile(value).then(result=>result?.ok===false,()=>true))),
   copies:await Promise.all(copies.map(value=>window.openclawPlusDesktop.copyReport(value).then(result=>result?.ok===false,()=>true))),
  }),{paths:invalidPaths,copies:invalidCopies});
  assert.ok(rejected.paths.every(Boolean));assert.ok(rejected.copies.every(Boolean));
  assert.deepEqual(await native(),before);
 });
 await check('Native local action handlers reject foreign senders and frames before side effects',async()=>{
  const before=await native();
  // Electron's test-side handler map lets this exercise the real guard without loading another renderer.
  const results=await application.evaluate(async({ipcMain,BrowserWindow},file)=>{
   const contents=BrowserWindow.getAllWindows()[0].webContents;
   const handlers=ipcMain._invokeHandlers;
   if(!(handlers instanceof Map))throw new Error('Electron fixture handler instrumentation is unavailable');
   const results=[];
   for(const [channel,value]of [['desktop:copy-report','fixture'],['desktop:reveal-file',file]]){
    const handler=handlers.get(channel);
    for(const event of [{sender:{},senderFrame:contents.mainFrame},
     {sender:contents,senderFrame:{url:'openclaw-plus://ui/index.html'}},
     {sender:contents,senderFrame:null}])results.push(await handler(event,value));
   }
   return results;
  },reportFile);
  assert.ok(results.every(result=>result.ok===false&&/Untrusted/.test(result.message)));
  assert.deepEqual(await native(),before);
 });
 await check('Earlier history survives periodic invalidation with explicit freshness notice',async()=>{
  await page.getByRole('button',{name:'Load earlier messages'}).click();
  await page.getByText('Earlier fixture message',{exact:true}).waitFor();
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.send('gateway:event',{kind:'sessions'}));
  await page.getByRole('button',{name:'Refresh latest messages'}).waitFor();
  assert.ok(await page.getByText('Earlier fixture message',{exact:true}).isVisible());
  await page.getByRole('button',{name:'Refresh latest messages'}).click();
 });
 await check('Session pagination is retained during refresh',async()=>{
  await page.getByRole('button',{name:'Load more conversations'}).click();
  await page.waitForFunction(()=>document.querySelectorAll('#session-list [data-action="session"]').length===68);
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.send('gateway:event',{kind:'sessions'}));
  await page.getByRole('button',{name:'Refresh list',exact:true}).waitFor();
  assert.equal(await page.locator('#session-list [data-action="session"]').count(),68);
 });
 await check('Search is performed against the gateway and exact second agent session opens',async()=>{
  await page.locator('#session-search').fill('Other Builder');
  await page.waitForFunction(()=>document.querySelectorAll('#session-list [data-action="session"]').length===1);
  await page.locator('#session-list [data-action="session"]').click();
  await page.waitForFunction(()=>document.querySelector('#page-title')?.textContent==='Other Builder session');
  await page.locator('#session-search').fill('');
 });
 await check('Activity requests active-only rows and automations show schedules/history',async()=>{
  await menu('view:Activity');await page.locator('#page-content .list-row').waitFor();
  await menu('view:Automations');await page.waitForFunction(()=>document.querySelector('#page-content')?.textContent.includes('Index updated'));
  assert.ok((await page.locator('#page-content').textContent()).includes('0 8 * * *'));
 });
 await check('Bridge rejects mutations and unexpected parameters',async()=>{
  const results=await page.evaluate(async()=>Promise.all([
   window.openclawPlusDesktop.gateway('chat.send',{}).then(result=>result?.ok===false,()=>true),
   window.openclawPlusDesktop.gateway('overview',{method:'config.set'}).then(result=>result?.ok===false,()=>true),
   window.openclawPlusDesktop.gateway('history',{key:'agent:main:main',offset:-1}).then(result=>result?.ok===false,()=>true),
  ]));assert.deepEqual(results,[true,true,true]);
 });
 await check('Disconnect is visible and reconnect recovers without duplicate execution',async()=>{
  fs.writeFileSync(path.join(profile,'offline'),'fixture');
  await page.locator('#connection-notice [data-action="reconnect"]').click();
  await page.waitForFunction(()=>document.querySelector('#connection-button')?.textContent.includes('disconnected'));
  fs.unlinkSync(path.join(profile,'offline'));
  await page.locator('#connection-notice [data-action="reconnect"]').click();
  await page.waitForFunction(()=>document.querySelector('#connection-button')?.textContent.includes('Connected'));
 });
 await check('Narrow Work sheet traps focus and supports Escape',async()=>{
  await menu('view:Conversations');await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1000,760));
  if(!await page.locator('#work-panel').isVisible())await page.locator('#toggle-work').click();
  await page.waitForFunction(()=>document.querySelector('#work-panel')?.getAttribute('role')==='dialog');
  await page.locator('#work-panel button').last().focus();await page.keyboard.press('Tab');
  assert.ok(await page.evaluate(()=>!!document.activeElement.closest('#work-panel')));
  await page.screenshot({path:path.join(evidence,'fixture-narrow.png')});
  await page.keyboard.press('Escape');assert.equal(await page.locator('#work-panel').isVisible(),false);
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1440,920));
  await page.locator('#toggle-work').click();await page.screenshot({path:path.join(evidence,'fixture-dark.png')});
  await menu('theme:light');await page.screenshot({path:path.join(evidence,'fixture-light.png')});
 });
 await check('All observed gateway calls are reads; no renderer network or script errors',async()=>{
  const calls=fs.readFileSync(path.join(profile,'fixture-calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  const allowed=['agents.list','sessions.list','chat.history','sessions.describe','sessions.processes.list','cron.list','cron.runs','progressCard.get','exec.approval.list','plugin.approval.list','openclaw.approval.list','approval.get','audit.activity.list','models.list'];
  assert.ok(calls.every(c=>allowed.includes(c.method)));
  assert.ok(calls.some(c=>c.method==='sessions.list'&&c.params.activeOnly===true));
  assert.ok(calls.some(c=>c.method==='sessions.list'&&c.params.spawnedBy==='agent:main:main'&&!c.params.agentId));
  assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
 });
 }finally{
  fs.writeFileSync(path.join(evidence,'desktop-tests.json'),JSON.stringify({at:new Date().toISOString(),checks,errors,requests,scope:'Native Electron fixture CLI only; no production requests or credentials'},null,2));
  await application.close();
 }
 console.log(JSON.stringify({passed:checks.filter(x=>x.pass).length,failed:checks.filter(x=>!x.pass).length}));
 process.exitCode=checks.some(x=>!x.pass)?1:0;
})().catch(e=>{console.error(e);process.exitCode=1});
