'use strict';
// Portfolio captures of the real desktop UI and GCB FictionalBackend only.
const { _electron } = require('./test-support.cjs').playwright;
const { evidenceDirectory } = require('./test-support.cjs');
const { createRequire } = require('node:module');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),output=evidenceDirectory('profile-demo');
const {expect}=createRequire(path.join(root,'desktop/package.json'))('playwright/test');
const executable=process.env.OPENCLAW_PLUS_TEST_GCB;
const profile=fs.mkdtempSync(path.join(output,'private-fixture-profile-'));
const env={...process.env,OPENCLAW_PLUS_TEST_DATA:profile,OPENCLAW_PLUS_TEST_CLI:path.join(root,'tests/fixture-gateway.cjs'),OPENCLAW_PLUS_TEST_GCB:executable};
delete env.ELECTRON_RUN_AS_NODE;
let app,page;const captures=[],errors=[],network=[];
const action=name=>page.locator(`[data-profile-action="${name}"]`);
const review=()=>page.locator('.mm-profile-dialog[open]');
const rpc=(operation,params={})=>page.evaluate(({operation,params})=>window.openclawPlusDesktop.models(operation,params),{operation,params});
async function overview(){const reply=await rpc('modelsProfileOverview');assert.equal(reply.ok,true,reply.error?.message);return reply.data;}
async function menu(id){await app.evaluate(({Menu},id)=>{const item=Menu.getApplicationMenu().getMenuItemById(id);if(!item)throw new Error('Missing demo menu');item.click();},id);}
async function tab(view){await page.locator(`[data-models-action="tab"][data-view="${view}"]`).click();}
async function align(locator){await locator.evaluate(node=>node.scrollIntoView({block:'start',behavior:'instant'}));}
async function capture(file,caption){
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const visible=await page.locator('body').innerText();
  assert.equal(/\/(?:Users|Volumes|home)\/|file:\/\//i.test(visible),false,'A private path is visible; capture withheld.');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'Viewport must not clip horizontal content');
  const result=await app.evaluate(async({BrowserWindow})=>{const image=await BrowserWindow.getAllWindows()[0].webContents.capturePage();return {png:image.toPNG().toString('base64'),...image.getSize()};});
  const bytes=Buffer.from(result.png,'base64');fs.writeFileSync(path.join(output,file),bytes);
  captures.push({file,caption,width:result.width,height:result.height,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
  console.log('Captured '+file);
}
async function waitState(id,status){
  await expect.poll(async()=>{const view=await overview(),target=view.targets.find(item=>item.id===id);return view.active===null?target?.status?.status:null;},{timeout:60000,intervals:[150,300,600]}).toBe(status);
  await expect(page.locator('.mm-profile-progress-title')).toContainText(status==='paused'?'Paused':'Complete');
  return (await overview()).targets.find(item=>item.id===id);
}
async function authorizeOffline(){
  await expect(review()).toContainText('No provider is contacted');await expect(action('start')).toBeDisabled();
  await review().locator('[data-profile-input="approve-usage"]').check();await expect(action('start')).toBeEnabled();
  assert.equal(await review().locator('[data-profile-input="approve-host"]').count(),0);
  await action('start').click();await expect(review()).toHaveCount(0);
}
(async()=>{
  try{
    assert.ok(executable&&path.isAbsolute(executable)&&fs.existsSync(executable),'Set OPENCLAW_PLUS_TEST_GCB to the reviewed, independently installed GCB executable.');
    app=await _electron.launch({executablePath:path.join(root,'desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[path.join(root,'desktop')],env});
    page=await app.firstWindow();page.setDefaultTimeout(15000);await page.emulateMedia({reducedMotion:'reduce'});
    page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(/^(?:https?|wss?|file):/.test(request.url()))network.push(request.url());});
    await app.evaluate(({BrowserWindow,ipcMain,dialog,shell},{root,executable})=>{
      const {CliTransport,ReadError}=process.mainModule.require(root+'/desktop/src/gateway-cli.cjs');
      const {ModelManagerService}=process.mainModule.require(root+'/desktop/src/model-manager.cjs');
      const window=BrowserWindow.getAllWindows()[0];window.setSize(1440,1000);window.webContents.setZoomFactor(1);
      const state=globalThis.__profileDemo={operations:[],catalog:[],external:[]};
      ModelManagerService.prototype.loadProviderOptions=function(){this.providerSetup={status:'available',source:'synthetic-demo',items:[],limitations:[]};};
      CliTransport.prototype.modelRead=async function(operation){
        state.catalog.push(operation);
        if(operation==='capabilities')return {version:'2026.11.1',protocol:4,methods:['models.list'],capabilities:['published-model-catalog','session-scoped-model-catalog'],clientCaps:['model-selection-policy'],available:true};
        if(operation==='catalog')return {models:['forge','scribe'].map(id=>({provider:'fictional',id,name:(id==='forge'?'Forge':'Scribe')+' (synthetic demo)',available:true,manualSelectionAllowed:true,contextWindow:32000,input:['text'],thinkingLevels:['low','medium','high'].map(id=>({id,label:id}))}))};
        throw new ReadError('INVALID','Only synthetic demo catalog metadata is available.');
      };
      const original=ipcMain._invokeHandlers.get('desktop:models');if(!original)throw new Error('Models IPC unavailable');
      const allowed=new Set(['modelsOverview','modelsProfileOverview','modelsProfileResearch','modelsProfilePlan','modelsProfileStart','modelsProfilePause','modelsProfilePreview','modelsProfileEvidence','modelsProfileConnect']);
      ipcMain.removeHandler('desktop:models');ipcMain.handle('desktop:models',async(event,operation,params={})=>{
        if(!allowed.has(operation)||params.targetId&&!['forge','scribe'].includes(params.targetId)||operation==='modelsProfileStart'&&(params.approveUsage!==true||params.approveHostRuntime!==false))throw new Error('Only the synthetic offline demo is permitted.');
        state.operations.push(operation);return original(event,operation,params);
      });
      const send=window.webContents.send.bind(window.webContents);window.webContents.send=(channel,...args)=>channel==='gateway:event'?undefined:send(channel,...args);
      dialog.showOpenDialog=async()=>({canceled:false,filePaths:[executable]});
      shell.openExternal=async()=>{state.external.push('external');throw new Error('External navigation disabled in the demo.');};
      shell.openPath=async()=>{state.external.push('path');return 'Disabled in demo';};
    },{root,executable});
    await page.reload();await page.getByText('Coordinator is coordinating.',{exact:true}).waitFor();
    await menu('theme:dark');await menu('view:Models');
    const forgeChoice=page.locator('[data-models-action="select"][data-model-ref="fictional/forge"]');await forgeChoice.click();
    await expect(page.locator('[data-models-region="detail"]')).toContainText('Forge (synthetic demo)');
    await capture('01-model-selection-dark.png','Actual Models catalog; Forge and Scribe availability is mocked synthetic metadata.');
    await page.locator('[data-models-action="profile-model"]').click();
    let view=await overview();if(view.engine.status!=='ready'){await action('connect').first().click();view=await overview();}
    assert.equal(view.engine.status,'ready');assert.equal(view.targets.length,2);
    assert.ok(view.targets.every(item=>item.mode==='offline'&&['fictional/forge','fictional/scribe'].includes(item.modelRef)));
    await page.locator('[data-profile-action="select"][data-target-id="forge"]').click();await action('research').click();await expect(action('plan')).toBeEnabled();
    await expect(page.locator('[data-profile-region="detail"]')).toContainText('Synthetic example');
    await align(page.locator('.mm-profile-title'));await capture('02-researched-synthetic-model-dark.png','GCB research for Forge, visibly labeled as a synthetic offline example.');
    await action('plan').click();await expect(review()).toBeVisible();
    assert.equal((await overview()).targets.find(item=>item.id==='forge').status.attempts,0);
    await capture('03-explicit-usage-review-dark.png','Exact GCB plan and native reasoning settings before explicit offline authorization.');
    await authorizeOffline();const pause=await rpc('modelsProfilePause',{targetId:'forge'});assert.equal(pause.ok,true);
    const partial=await waitState('forge','paused');assert.ok(partial.status.cells.observed>0&&partial.status.cells.pending>0);
    await align(page.locator('.mm-profile-progress'));await capture('04-paused-partial-evidence-dark.png','Paused synthetic benchmark with committed partial evidence and safe resumption.');
    await action('plan').click();await expect(review()).toContainText('Completed checks are retained');await authorizeOffline();
    const completed=await waitState('forge','complete');assert.equal(completed.bio.evidence_kind,'synthetic_fixture');assert.ok(completed.bio.configurations.length>1);
    await align(page.getByRole('region',{name:'Capability bio'}));await capture('05-capability-bio-reasoning-dark.png','Completed synthetic capability bio and GCB reasoning-configuration comparison.');
    const responses=page.locator('[data-profile-disclosure="responses"]');await responses.locator(':scope > summary').click();
    const retained=responses.locator('.mm-recorded-check').filter({has:page.getByText('Actual retained structured response (formatted for display).',{exact:true})}).first();
    await expect(retained.locator('.mm-recorded-text').first()).toBeVisible();
    await align(retained);await capture('06-recorded-synthetic-response-dark.png','GCB-retained structured response, separate from scoring criteria; original formatting may be unavailable.');
    await tab('Personal routing');await action('preview').click();await expect(page.locator('.mm-route-cards article')).toHaveCount(5);await expect(action('unavailable-route')).toBeDisabled();
    await page.locator('.mm-route-cards article').first().locator('summary').click();await align(page.locator('.mm-profile-title'));
    await capture('07-explainable-routing-preview-dark.png','Five GCB role recommendations using synthetic evidence; live routing remains disabled.');
    await tab('Checks');await menu('theme:light');await align(page.getByRole('region',{name:'Capability bio'}));
    await capture('08-capability-bio-reasoning-light.png','The same completed synthetic evidence in the native light theme.');
    assert.deepEqual(errors,[]);assert.deepEqual(network,[]);
    const audit=await app.evaluate(()=>globalThis.__profileDemo);assert.deepEqual(audit.external,[]);assert.ok(audit.catalog.every(operation=>['capabilities','catalog'].includes(operation)));
    const callsFile=path.join(profile,'fixture-calls.jsonl'),calls=fs.readFileSync(callsFile,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.equal(calls.some(call=>['chat.send','sessions.patch','config.patch','approval.resolve','tts.speak','gcb.profile.complete','gcb.profile.preflight','plugins.setEnabled'].includes(call.method)),false);
    fs.writeFileSync(path.join(output,'demo.json'),JSON.stringify({title:'OpenClaw+ synthetic Models demo',scope:'Actual desktop renderer and independently installed GCB FictionalBackend. Catalog and sessions are isolated fixtures. No real inference or configuration changes.',captures,
      checks:{rendererErrors:0,externalRequests:0,nativeModelCalls:0,liveRouting:false},sharing:'Share only the PNG files and this manifest. The adjacent fixture profile is local test state.'},null,2));
    console.log('Demo saved to '+path.relative(root,output));
  }catch(error){console.error('Demo capture failed: '+String(error.message).replace(/\/(?:Users|Volumes|home)\/[^\s]*/g,'[local path]'));process.exitCode=1;}
  finally{await app?.close().catch(()=>{});}
})();
