'use strict';
// Real GCB CLI + its bundled FictionalBackend, inside an isolated Electron profile.
// This suite never selects a real provider or contacts the production Gateway.
const { _electron } = require('./test-support.cjs').playwright;
const { evidenceDirectory } = require('./test-support.cjs');
const { createRequire } = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const desktopRequire = createRequire(path.join(root, 'desktop/package.json'));
const { expect } = desktopRequire('playwright/test');
const evidence = evidenceDirectory('gcb-desktop');
const profile = fs.mkdtempSync(path.join(evidence, 'fixture-profile-'));
const invalidSnapshot=path.join(profile,'invalid-host-snapshot.json');
fs.writeFileSync(invalidSnapshot,JSON.stringify({snapshot_version:1,model_ref:'openai/gpt-fixture',api_key:'FIXTURE-SECRET-DO-NOT-DISPLAY'}),{mode:0o600});
const executable = process.env.OPENCLAW_PLUS_TEST_GCB;
const env = { ...process.env, OPENCLAW_PLUS_TEST_DATA: profile,
  OPENCLAW_PLUS_TEST_CLI: path.join(root, 'tests/fixture-gateway.cjs'),
  OPENCLAW_PLUS_TEST_GCB: executable };
delete env.ELECTRON_RUN_AS_NODE;
const checks = [], errors = [], network = [], launches = [];
let application, page;

async function launch() {
  application = await _electron.launch({ executablePath: path.join(root, 'desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [path.join(root, 'desktop')], env });
  page = await application.firstWindow();page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^(?:https?|wss?|file):/.test(request.url())) network.push(request.url()); });
  await application.evaluate(({ BrowserWindow, ipcMain, dialog, shell }, { root, executable }) => {
    const { CliTransport, ReadError } = process.mainModule.require(root + '/desktop/src/gateway-cli.cjs');
    const { ModelManagerService } = process.mainModule.require(root + '/desktop/src/model-manager.cjs');
    const window = BrowserWindow.getAllWindows()[0];window.setSize(1440, 1000);
    const state = globalThis.__gcbDesktopFixture = { native: [], ipc: [], catalogCalls: [] };
    ModelManagerService.prototype.loadProviderOptions = function () { this.providerSetup = {status:'available',source:'fixture',items:[],limitations:[]}; };
    CliTransport.prototype.modelRead = async function (operation) {
      state.catalogCalls.push(operation);
      if (operation === 'capabilities') return {version:'2026.11.1',protocol:4,methods:['models.list'],capabilities:['published-model-catalog','session-scoped-model-catalog'],clientCaps:['model-selection-policy'],available:true};
      if (operation === 'catalog') return {models:[{provider:'fixture',id:'model-one',name:'Native catalog fixture',available:true,manualSelectionAllowed:true,contextWindow:32000,input:['text'],thinkingLevels:[{id:'medium',label:'Medium'}]}]};
      throw new ReadError('INVALID','Only prepared fixture metadata is available.');
    };
    const original=ipcMain._invokeHandlers.get('desktop:models');
    if(!original)throw new Error('Models IPC handler is missing.');
    state.original=original;ipcMain.removeHandler('desktop:models');
    ipcMain.handle('desktop:models',async(event,operation,params)=>{
      const call={operation,params:structuredClone(params)};state.ipc.push(call);
      const result=await original(event,operation,params);call.ok=result?.ok;return result;
    });
    const send=window.webContents.send.bind(window.webContents);
    window.webContents.send=(channel,event,...rest)=>channel==='gateway:event'?undefined:send(channel,event,...rest);
    dialog.showOpenDialog=async()=>{state.native.push({kind:'choose-file'});const picked=state.nextPick||executable;state.nextPick=null;return {canceled:false,filePaths:[picked]};};
    shell.openExternal=async value=>state.native.push({kind:'external',value});
    shell.openPath=async value=>{state.native.push({kind:'openPath',value});return 'Disabled in fixture';};
  }, {root,executable});
  await page.reload();await page.getByText('Coordinator is coordinating.',{exact:true}).waitFor();
}
const rpc=(operation,params={})=>page.evaluate(({operation,params})=>window.openclawPlusDesktop.models(operation,params),{operation,params});
const action=name=>page.locator(`[data-profile-action="${name}"]`);
const dialog=()=>page.locator('.mm-profile-dialog[open]');
async function menu(id){await application.evaluate(({Menu},id)=>{const item=Menu.getApplicationMenu().getMenuItemById(id);if(!item)throw new Error('Missing menu '+id);item.click();},id);}
async function tab(name){await page.locator(`[data-models-action="tab"][data-view="${name}"]`).click();}
async function overview(){const result=await rpc('modelsProfileOverview');assert.equal(result.ok,true,JSON.stringify(result.error));return result.data;}
async function targetState(id){return (await overview()).targets.find(target=>target.id===id);}
async function waitForTarget(id,predicate,timeout=30000){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){const view=await overview(),target=view.targets.find(item=>item.id===id);if(predicate(target,view))return target;await page.waitForTimeout(100);}
  throw new Error('GCB target did not reach the expected state: '+JSON.stringify(await targetState(id)));
}
async function choose(id){await page.locator(`[data-profile-action="select"][data-target-id=${JSON.stringify(id)}]`).click();}
async function state(){return application.evaluate(()=>{const {native,ipc,catalogCalls}=globalThis.__gcbDesktopFixture;return {native,ipc,catalogCalls};});}
async function closeApp(){if(application){launches.push(await state().catch(()=>null));await application.close();application=null;}}
async function check(name,fn){
  try{await fn();checks.push({name,pass:true});console.log('PASS',name);}
  catch(error){checks.push({name,pass:false,error:error.stack||error.message});console.log('FAIL',name,error.message);if(page&&!page.isClosed())await page.screenshot({path:path.join(evidence,'failure-'+checks.length+'.png')}).catch(()=>{});throw error;}
}
async function approveAndStart(){
  await expect(action('start')).toBeDisabled();
  await dialog().locator('[data-profile-input="approve-usage"]').check();
  await expect(action('start')).toBeEnabled();await action('start').click();await expect(dialog()).toHaveCount(0);
}
const statusOf=target=>typeof target.status==='string'?target.status:target.status?.status;

(async()=>{
  let forge,scribe,completed;
  try{
    if(!executable||!path.isAbsolute(executable)||!fs.existsSync(executable))throw new Error('Set OPENCLAW_PLUS_TEST_GCB to an independently installed GCB executable before this offline integration suite.');
    await launch();await page.locator('#composer-input').fill('Keep this conversation draft while profiling offline examples.');
    await menu('view:Models');await tab('Checks');
    await check('Installed GCB is connected separately and examples are explicitly synthetic',async()=>{
      let view=await overview();
      if(view.engine.status!=='ready'){await action('connect').first().click();view=await overview();}
      assert.equal(view.engine.status,'ready',view.engine.message);
      forge=view.targets.find(item=>item.mode==='offline'&&/forge/i.test(item.id+' '+item.name));
      scribe=view.targets.find(item=>item.mode==='offline'&&/scribe/i.test(item.id+' '+item.name));
      assert.ok(forge&&scribe,'Both real GCB fictional examples are exposed');
      await choose(forge.id);await expect(page.locator('[data-profile-region="detail"]')).toContainText('Synthetic example');
      assert.equal((await rpc('modelsOverview')).data.registry.items.length,0);
    });
    await check('Untrusted frames, generic commands and unreviewed usage are rejected without model work',async()=>{
      const denied=await application.evaluate(async({BrowserWindow})=>{
        const window=BrowserWindow.getAllWindows()[0];
        return globalThis.__gcbDesktopFixture.original({sender:window.webContents,senderFrame:{url:window.webContents.getURL()}},'modelsProfileStart',{reviewToken:'forged',approveUsage:true,approveHostRuntime:true});
      });
      assert.equal(denied.error.code,'DENIED');
      assert.equal((await rpc('modelsProfileExecute',{command:'arbitrary'})).ok,false);
      assert.equal((await rpc('modelsProfileResearch',{targetId:forge.id,executable:'/bin/sh'})).ok,false);
      assert.equal((await rpc('modelsProfileStart',{reviewToken:'forged',approveUsage:true,approveHostRuntime:false})).ok,false);
      assert.equal((await targetState(forge.id)).plan==null,true);
    });
    await check('Invalid host metadata is rejected without storing a target or exposing its contents',async()=>{
      const before=(await overview()).targets.length;
      await application.evaluate((_,file)=>{globalThis.__gcbDesktopFixture.nextPick=file;},invalidSnapshot);
      await action('import').click();
      await expect.poll(async()=>Boolean((await state()).ipc.find(call=>call.operation==='modelsProfileImport'&&call.ok===false))).toBe(true);
      assert.equal((await overview()).targets.length,before);
      assert.equal((await page.locator('body').textContent()).includes('FIXTURE-SECRET-DO-NOT-DISPLAY'),false);
    });
    await check('Research and review display GCB scope without starting benchmark attempts',async()=>{
      await action('research').click();await expect(action('plan')).toBeEnabled();
      await expect(page.locator('[data-profile-region="detail"]')).toContainText('Researched capabilities');
      await expect(page.locator('[data-profile-region="detail"]')).toContainText('high');
      await action('plan').click();await expect(dialog()).toBeVisible();await expect(action('start')).toBeDisabled();
      const target=await targetState(forge.id);assert.ok(target.plan.plan_id);assert.equal(target.status.attempts,0);
      assert.ok(target.plan.configuration_ids.length>1);assert.ok(target.plan.max_requests>0);
      assert.equal(target.plan.estimated_cost_usd,null);assert.equal(target.plan.concurrency,1);
      await expect(dialog()).toContainText('Maximum requests');await expect(dialog()).toContainText('No provider is contacted');
      const calls=(await state()).ipc;assert.equal(calls.some(call=>call.operation==='modelsProfileStart'&&call.params.reviewToken!=='forged'),false);
      await page.screenshot({path:path.join(evidence,'models-benchmark-review-dark-1440.png')});
    });
    await check('Explicit authorization starts GCB; pausing retains partial evidence without replay',async()=>{
      await approveAndStart();
      const reply=await rpc('modelsProfilePause',{targetId:forge.id});assert.equal(reply.ok,true,JSON.stringify(reply.error));
      const partial=await waitForTarget(forge.id,(target,view)=>view.active===null&&statusOf(target)==='paused');
      assert.ok(partial.status.attempts>0);assert.ok(partial.status.cells.observed>0);assert.ok(partial.status.cells.pending>0);
      await expect(page.locator('[data-profile-region="detail"]')).toContainText('Paused');
      await expect(page.getByRole('region',{name:'Capability bio'})).toBeVisible();
      await page.locator('.mm-profile-progress').scrollIntoViewIfNeeded();
      await page.screenshot({path:path.join(evidence,'models-partial-profile-dark-1440.png')});
      forge.partial=partial;assert.ok((await state()).ipc.some(call=>call.operation==='modelsProfileStart'&&call.params.approveUsage===true&&call.params.approveHostRuntime===false));
    });
    await check('An interrupted workflow restores partial evidence after restart and waits for fresh authorization',async()=>{
      await closeApp();await launch();
      await page.locator('#composer-input').fill('Keep this conversation draft while profiling offline examples.');
      await menu('view:Models');await tab('Checks');await choose(forge.id);
      const restored=await targetState(forge.id);
      assert.equal(restored.plan.plan_id,forge.partial.plan.plan_id);assert.equal(restored.status.attempts,forge.partial.status.attempts);
      assert.equal(restored.status.cells.observed,forge.partial.status.cells.observed);assert.equal((await overview()).active,null);
      assert.ok(['paused','interrupted'].includes(statusOf(restored)));
      assert.equal((await state()).ipc.some(call=>call.operation==='modelsProfileStart'),false);
      await expect(action('plan')).toHaveText('Review and resume');
    });
    await check('Resume is reviewed separately and produces GCB capability bios and reasoning comparisons',async()=>{
      await action('plan').click();await expect(dialog()).toContainText('Completed checks are retained');await approveAndStart();
      completed=await waitForTarget(forge.id,(target,view)=>view.active===null&&statusOf(target)==='complete',60000);
      assert.equal(completed.plan.plan_id,forge.partial.plan.plan_id);assert.ok(completed.status.attempts>forge.partial.status.attempts);
      assert.equal(completed.status.cells.pending||0,0);assert.ok(completed.bio.configurations.length>1);
      assert.equal(completed.bio.evidence_kind,'synthetic_fixture');
      assert.ok(completed.bio.configurations.every(config=>config.usage.billed_cost_usd===null));
      await expect(page.getByRole('table',{name:'Reasoning configuration comparison'})).toBeVisible();
      await expect(page.getByRole('region',{name:'Capability bio'})).toContainText('Unknown');
      const current=await rpc('modelsOverview');assert.equal(current.data.registry.items.length,0);assert.equal(current.data.routing,'preview-only');
      await expect(page.locator('.mm-profile-progress-title')).toContainText('Complete');
      await page.getByRole('table',{name:'Reasoning configuration comparison'}).scrollIntoViewIfNeeded();
      await page.screenshot({path:path.join(evidence,'models-capability-bio-dark-1440.png'),fullPage:true});
    });
    await check('GCB supplies explainable role previews while live routing stays disabled',async()=>{
      await tab('Personal routing');await choose(forge.id);await action('preview').click();
      await expect(page.locator('.mm-route-cards')).toBeVisible();
      await expect(page.locator('.mm-route-cards article')).toHaveCount(5);
      await expect(action('unavailable-route')).toBeDisabled();
      await expect(page.locator('[data-profile-region="detail"]')).toContainText('Preview-only');
      await page.locator('.mm-route-cards article').first().getByText('Why this recommendation?',{exact:true}).click();
      await expect(page.locator('.mm-route-reason').first()).toContainText('GCB');
      const result=await rpc('modelsProfilePreview',{targetId:forge.id});assert.equal(result.ok,true);
      const allowed=new Set(completed.bio.configurations.map(config=>config.configuration_id));
      for(const {preview} of result.data.routes){assert.ok(preview.candidates.every(candidate=>allowed.has(candidate.configuration_id)));assert.equal(preview.enforcement,'preview_only');}
      await page.screenshot({path:path.join(evidence,'models-routing-preview-dark-1440.png')});
    });
    await check('Cancellation preserves a separate example and cannot manufacture completed results',async()=>{
      await tab('Checks');await choose(scribe.id);await action('research').click();await expect(action('plan')).toBeEnabled();await action('plan').click();await approveAndStart();
      const reply=await rpc('modelsProfileCancel',{targetId:scribe.id});assert.equal(reply.ok,true,JSON.stringify(reply.error));
      const cancelled=await waitForTarget(scribe.id,(target,view)=>view.active===null&&['cancelled','partial_unknown'].includes(statusOf(target)));
      assert.notEqual(statusOf(cancelled),'complete');assert.equal((await targetState(forge.id)).plan.plan_id,completed.plan.plan_id);
      await page.waitForTimeout(250);assert.equal((await targetState(scribe.id)).status.attempts,cancelled.status.attempts);
      if(statusOf(cancelled)==='partial_unknown')await expect(action('plan')).toBeDisabled();
    });
    await check('Completed bios are readable at narrow widths in both themes without losing the conversation draft',async()=>{
      await choose(forge.id);
      for(const [width,height,theme] of [[1440,1000,'light'],[1100,800,'light'],[880,640,'dark']]){
        await menu('theme:'+theme);await application.evaluate(({BrowserWindow},{width,height})=>BrowserWindow.getAllWindows()[0].setSize(width,height),{width,height});
        await expect(page.getByRole('region',{name:'Capability bio'})).toBeVisible();
        await page.getByRole('table',{name:'Reasoning configuration comparison'}).scrollIntoViewIfNeeded();
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
        await page.screenshot({path:path.join(evidence,`models-capability-bio-${theme}-${width}.png`)});
      }
      await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1440,1000));await menu('theme:dark');
      await menu('view:Conversations');await expect(page.locator('#composer-input')).toHaveValue('Keep this conversation draft while profiling offline examples.');
    });
    await check('GCB evidence persists across application restart without rerunning completed work',async()=>{
      await closeApp();await launch();await menu('view:Models');await tab('Checks');await choose(forge.id);
      const restored=await targetState(forge.id);assert.equal(statusOf(restored),'complete');assert.equal(restored.status.attempts,completed.status.attempts);assert.equal(restored.plan.plan_id,completed.plan.plan_id);
      assert.deepEqual(restored.bio.configurations.map(config=>config.categories),completed.bio.configurations.map(config=>config.categories));
      await expect(page.getByRole('region',{name:'Capability bio'})).toBeVisible();
      assert.equal((await overview()).active,null);
    });
    await check('Offline profiling made no external renderer requests, native model calls or configuration changes',async()=>{
      assert.deepEqual(errors,[]);assert.deepEqual(network,[]);
      const file=path.join(profile,'fixture-calls.jsonl');const calls=fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
      assert.equal(calls.some(call=>['chat.send','sessions.patch','config.patch','approval.resolve','agent','tts.speak','models.authStatus','gcb.profile.complete','gcb.profile.preflight','plugins.setEnabled'].includes(call.method)),false);
      for(const record of [...launches,await state()]){assert.equal(record.native.some(call=>call.kind==='external'||call.kind==='openPath'),false);assert.ok(record.catalogCalls.every(operation=>['capabilities','catalog'].includes(operation)));}
    });
  }catch(error){if(!checks.some(check=>!check.pass)){checks.push({name:'Fixture setup',pass:false,error:error.stack||error.message});console.error(error.message);}}
  finally{
    await closeApp().catch(()=>{});
    fs.writeFileSync(path.join(evidence,'gcb-desktop-tests.json'),JSON.stringify({at:new Date().toISOString(),checks,errors,network,launches,profile,scope:'Real installed GCB CLI with bundled FictionalBackend through main/service/preload/UI. No live providers, production Gateway, routing activation or native settings changes.'},null,2));
    const passed=checks.filter(check=>check.pass).length,failed=checks.filter(check=>!check.pass).length;
    console.log(JSON.stringify({passed,failed,evidence}));process.exitCode=failed||errors.length||network.length||!checks.length?1:0;
  }
})();
