'use strict';
const {_electron}=require('./test-support.cjs').playwright;
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),evidence=require('./test-support.cjs').evidenceDirectory('progress');fs.mkdirSync(evidence,{recursive:true});
const profile=fs.mkdtempSync(path.join(evidence,'fixture-profile-'));
const fixtureFile=path.join(profile,'Progress report.md');fs.writeFileSync(fixtureFile,'Fixture-only report.\n');
const bar=(label,value=12,max=12)=>`<progress aria-label="${label}" value="${value}" max="${max}"></progress>`;
const source=['Fixture report',bar('Fixture checks passed · 12/12'),'','File: [Report](<'+fixtureFile+'>)','','Code sample: `'+bar('Inline example')+'`','```html',bar('Fenced example'),'```','<progress aria-label="Rejected extra attribute" value="12" max="12" onclick="window.intruded=true"></progress>','<img src=x onerror="window.intruded=true">'].join('\n');
const extra='Additional report block\n'+bar('Block checks',2,3);
const env={...process.env,OPENCLAW_PLUS_TEST_DATA:profile,OPENCLAW_PLUS_TEST_CLI:path.join(root,'tests/fixture-gateway.cjs')};delete env.ELECTRON_RUN_AS_NODE;
(async()=>{
 const app=await _electron.launch({executablePath:path.join(root,'desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[path.join(root,'desktop')],env});
 const page=await app.firstWindow();page.setDefaultTimeout(10000);
 const errors=[],network=[],checks=[];page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(/^(?:https?|wss?):/.test(request.url()))network.push(request.url());});
 await app.evaluate(({ipcMain,BrowserWindow,clipboard,shell},{source,extra})=>{
  BrowserWindow.getAllWindows()[0].setSize(1440,1000);
  const state=globalThis.__progressFixture={copies:[],reveals:[],external:[]};
  const bar=(label,value=12,max=12)=>`<progress aria-label="${label}" value="${value}" max="${max}"></progress>`;
  const original=ipcMain._invokeHandlers.get('gateway:request');
  ipcMain.removeHandler('gateway:request');ipcMain.handle('gateway:request',async(event,operation,params)=>{
   if(operation==='history')return {ok:true,data:{key:params.key,sessionId:params.sessionId||'physical-main',messages:[
    {id:'progress-report',role:'assistant',text:source,blocks:[{type:'text',text:extra},{type:'thinking',text:bar('Thinking literal')},{type:'tool_result',name:'Tool detail',text:bar('Tool block literal')}]},
    {id:'tool-literal',role:'tool',text:bar('Tool message literal')},
    {id:'user-literal',role:'user',text:bar('User literal')}
   ],total:3,hasMore:false,offset:0,leafEntryId:'fixture-leaf',inFlight:{runId:'fixture-run',text:bar('Streaming checks',4,5)},hasActiveRun:true,activeRunIds:[]}};
   if(operation==='plan')return {ok:true,data:{card:{revision:1,updatedAt:Date.now(),markdown:bar('Plan checks passed · 12/12'),steps:[]}}};
   if(operation==='automations')return {ok:true,data:{jobs:[],runs:[{id:'report-run',jobId:'job-1',title:'Fixture automation report',status:'ok',timestamp:Date.now(),summary:bar('Automation checks',3,4)}],limitations:[]}};
   if(operation==='approvals')return {ok:true,data:{items:[{id:'literal-approval',kind:'exec',status:'pending',title:bar('Approval title literal'),description:'Fixture approval',command:bar('Approval command literal'),agentId:'main',sessionKey:'agent:main:main',host:'fixture',expiresAt:Date.now()+600000,reviewToken:'fixture-token',allowedDecisions:[{id:'deny',label:'Deny'}]}],limitations:[]}};
   return original(event,operation,params);
  });
  clipboard.writeText=text=>state.copies.push(text);shell.showItemInFolder=file=>state.reveals.push(file);shell.openExternal=async url=>state.external.push(url);
 },{source,extra});
 const check=async(name,fn)=>{try{await fn();checks.push({name,pass:true});console.log('PASS',name);}catch(error){checks.push({name,pass:false,error:error.message});console.log('FAIL',name,error.message);await page.screenshot({path:path.join(evidence,'failure-'+checks.length+'.png')}).catch(()=>{});}};
 const menu=id=>app.evaluate(({Menu},id)=>Menu.getApplicationMenu().getMenuItemById(id).click(),id);
 try{
 await page.reload();await page.locator('[data-message-id="progress-report"]').waitFor();
 await check('Assistant report and source plan render actual labeled native progress bars',async()=>{
  const progress=page.getByRole('progressbar',{name:'Fixture checks passed · 12/12',exact:true});await progress.waitFor();
  assert.deepEqual(await progress.evaluate(node=>({tag:node.tagName,value:node.value,max:node.max,position:node.position})),{tag:'PROGRESS',value:12,max:12,position:1});
  assert.equal(await page.locator('[data-message-id="progress-report"] .report-progress-label').first().textContent(),'Fixture checks passed · 12/12');
  assert.equal(await page.getByRole('progressbar',{name:'Block checks',exact:true}).count(),1);
  assert.equal(await page.getByRole('progressbar',{name:'Streaming checks',exact:true}).count(),1);
  assert.equal(await page.getByRole('progressbar',{name:'Plan checks passed · 12/12',exact:true}).count(),1);
  await progress.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(evidence,'report-progress-dark.png')});
 });
 await check('Code samples, unsupported HTML, user text and tool output stay literal',async()=>{
  const report=page.locator('[data-message-id="progress-report"]');assert.equal(await report.locator('progress').count(),2);
  assert.match(await report.textContent(),/<progress aria-label="Inline example"/);assert.match(await report.textContent(),/<progress aria-label="Fenced example"/);
  assert.match(await report.textContent(),/<progress aria-label="Rejected extra attribute"/);
  assert.equal(await page.locator('#messages img,#messages script').count(),0);assert.equal(await page.locator('#messages .tool-output progress').count(),0);
  assert.equal(await page.locator('[data-message-id="tool-literal"] progress,[data-message-id="user-literal"] progress').count(),0);
  assert.equal(await page.evaluate(()=>window.intruded),undefined);
 });
 await check('Copy preserves exact raw report markup and existing file links still reveal the fixture file',async()=>{
  const report=page.locator('[data-message-id="progress-report"]');await report.getByRole('button',{name:'Copy report',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#toast')?.textContent==='Report copied.');
  assert.equal(await app.evaluate(()=>globalThis.__progressFixture.copies.at(-1)),source+'\n\n'+extra);
  const fileLink=report.getByRole('link',{name:'Report',exact:true});assert.equal(await fileLink.getAttribute('data-path'),fixtureFile);await fileLink.click();
  await page.waitForFunction(()=>document.querySelector('#announcer')?.textContent==='Sent to Finder.');
  assert.equal(await app.evaluate(()=>globalThis.__progressFixture.reveals.at(-1)),fixtureFile);
 });
 await check('Automation report summaries render bars while approval commands and titles do not',async()=>{
  await menu('view:Automations');await page.getByRole('progressbar',{name:'Automation checks',exact:true}).waitFor();
  await page.locator('#primary-nav [data-view="Approvals"]').click();await page.locator('.approval-card').waitFor();
  assert.equal(await page.locator('.approval-card progress').count(),0);assert.match(await page.locator('.approval-command').textContent(),/<progress aria-label="Approval command literal"/);
  assert.match(await page.locator('.approval-card h3').textContent(),/<progress aria-label="Approval title literal"/);
 });
 await check('Light-theme native progress stays restrained and no renderer execution or networking occurs',async()=>{
  await menu('view:Conversations');await menu('theme:light');
  await page.getByRole('progressbar',{name:'Fixture checks passed · 12/12',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:path.join(evidence,'report-progress-light.png')});
  assert.deepEqual(errors,[]);assert.deepEqual(network,[]);assert.deepEqual(await app.evaluate(()=>globalThis.__progressFixture.external),[]);
 });
 }finally{
  fs.writeFileSync(path.join(evidence,'progress-tests.json'),JSON.stringify({at:new Date().toISOString(),checks,errors,network,profile,scope:'Native fixture-only report rendering; no production configuration, gateway requests or mutations'},null,2));
  await app.close();
 }
 console.log(JSON.stringify({passed:checks.filter(item=>item.pass).length,failed:checks.filter(item=>!item.pass).length,profile}));process.exitCode=checks.some(item=>!item.pass)?1:0;
})().catch(error=>{console.error(error);process.exitCode=1;});
