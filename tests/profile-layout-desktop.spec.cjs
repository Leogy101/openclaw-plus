'use strict';
// Actual desktop shell and Models renderer, with deterministic IPC records only.
// Restart restores this test's JSON fixture; GCB persistence is covered by gcb-desktop.
const { _electron } = require('./test-support.cjs').playwright;
const { evidenceDirectory } = require('./test-support.cjs');
const { createRequire } = require('node:module');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),evidence=evidenceDirectory('profile-layout');
const {expect}=createRequire(path.join(root,'desktop/package.json'))('playwright/test');
const profile=fs.mkdtempSync(path.join(evidence,'fixture-profile-'));
const fixtureFile=path.join(profile,'layout-fixture.json');
const env={...process.env,OPENCLAW_PLUS_TEST_DATA:profile,OPENCLAW_PLUS_TEST_CLI:path.join(root,'tests/fixture-gateway.cjs')};
delete env.ELECTRON_RUN_AS_NODE;delete env.OPENCLAW_PLUS_TEST_GCB;
const captureOnly=process.argv.includes('--capture-layout');
const longWord='UnbrokenFixtureIdentifier'.repeat(16),responseMarker='RETAINED_RESPONSE_V1';
const native={think:false,options:{num_ctx:4096,num_predict:128}};
const target={id:'local-layout-fixture',modelRef:'ollama/'+longWord,name:'Local fixture '+longWord,mode:'ollama',canResume:false,limitReached:true,
  metadata:{metadata_id:'metadata-layout',model:{context_window:4096,max_output:128,modalities:['text'],native_tools:false,
    reasoning:{semantics:'boolean',native_configurations:[native,{think:true}]}}},
  plan:{plan_id:'plan-layout-v1',configuration_ids:['cfg-off'],max_requests:1,max_output_tokens:128,concurrency:1,call_timeout_seconds:45,total_timeout_seconds:60,
    cells:[{case_id:'coding.json'},{case_id:'research.sources'},{case_id:'planning.steps'}]},
  status:{status:'paused',attempts:1,total_cells:3,cells:{observed:1,pending:2}},
  bio:{evidence_kind:'local_model',uncertainty:'Layout fixture: one attempt is partial evidence, never a full model qualification.',limitations:['Fixture limitation '+longWord],
    research_sources:[{title:'Fixture metadata source',url:'https://example.invalid/'+longWord}],
    configurations:[false,true].map((think,index)=>({configuration_id:index?'cfg-on':'cfg-off',native:{...native,think},attempt_count:index?0:1,
      categories:{coding:{correct:index?0:1,observed:index?0:1},research:{pending:1},planning:{pending:1}},
      strengths:index?[]:['Retained structured output matched the fixture. '+longWord],weaknesses:['Untested beyond this fixture. '+longWord],
      untested_categories:['research','planning'],latency_ms:{median:index?null:12},usage:{input_tokens:30,output_tokens:12,billed_cost_usd:null}}))}};
const attempts=[{id:'attempt-fixture',status:'observed',startedAt:'2026-01-01T00:00:00Z',endedAt:'2026-01-01T00:00:01Z',latencyMs:12,
  usage:{input_tokens:30,output_tokens:12,reasoning_tokens:null,estimated_cost_usd:null,billed_cost_usd:null},servedModel:target.modelRef,
  outputSha256:'fixture-digest',finishReason:'stop',nativeConfirmation:null,effectiveNativeKnown:false}];
const record=(cellId,availability,value,criterion=null)=>({cellId,caseId:cellId,configurationId:'cfg-off',status:availability==='pending'?'pending':'observed',
  score:availability==='retained'?true:null,outcome:'fixture',criterion,response:{availability,value},requestedNative:native,attempts:availability==='pending'?[]:attempts});
const fixture={snapshot:{engine:{status:'ready',message:'Fixture engine; no executable is invoked'},targets:[target],active:null},
  response:{targetId:target.id,planId:target.plan.plan_id,modelRef:target.modelRef,evidenceKind:'local_model',records:[
    record('coding.json','retained',{marker:responseMarker,literal:'<script>window.fixtureInjected=true</script>',long:longWord.repeat(12),tail:'RETAINED_END'}, {expected:'EXPECTED_ONLY_FIXTURE'}),
    record('research.sources','not_retained',null,{expected:'EXPECTED_MUST_NOT_BECOME_RESPONSE'}),
    record('planning.steps','pending',null),record('coding.long','retained','CAPPED_RESPONSE_START '+longWord.repeat(30)+' CAPPED_RESPONSE_END')],
    limitations:['Structured fixture only; original response formatting is unavailable.']}};
fs.writeFileSync(fixtureFile,JSON.stringify(fixture));
let app,page;const checks=[],errors=[],network=[],geometry=[],launches=[];
const details=()=>page.locator('details[data-profile-disclosure="responses"]');
const summary=()=>details().locator(':scope > summary');
const calls=operation=>app.evaluate((_,operation)=>globalThis.__profileLayoutFixture.calls.filter(call=>call.operation===operation),operation);
async function menu(id){await app.evaluate(({Menu},id)=>{const item=Menu.getApplicationMenu().getMenuItemById(id);if(!item)throw new Error('Missing menu '+id);item.click();},id);}
async function screenshot(options){
  await settle();
  const png=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
  fs.writeFileSync(options.path,Buffer.from(png,'base64'));
}
async function settle(){await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
async function launch(){
  app=await _electron.launch({executablePath:path.join(root,'desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[path.join(root,'desktop')],env});
  page=await app.firstWindow();page.setDefaultTimeout(10000);await page.emulateMedia({reducedMotion:'reduce'});
  page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(/^(?:https?|wss?|file):/.test(request.url()))network.push(request.url());});
  await app.evaluate(({ipcMain,BrowserWindow},saved)=>{
    const window=BrowserWindow.getAllWindows()[0];window.setSize(1440,1000);
    const state=globalThis.__profileLayoutFixture={...saved,calls:[],pendingEvidence:[],holdEvidence:false};
    ipcMain.removeHandler('desktop:models');
    ipcMain.handle('desktop:models',async(_event,operation,params={})=>{
      state.calls.push({operation,params});
      if(['modelsOverview','modelsRefresh'].includes(operation))return {ok:true,data:{connection:{status:'connected'},catalog:{models:[],providers:[],observedAt:'2026-01-01T00:00:00Z'},
        registry:{items:[],status:'ready'},providerSetup:{status:'available',items:[],limitations:[]},actions:{canRegister:false}}};
      if(operation==='modelsProfileOverview')return {ok:true,data:structuredClone(state.snapshot)};
      if(operation==='modelsProfileEvidence'){
        if(Object.keys(params).length!==1||params.targetId!==state.snapshot.targets[0].id)throw new Error('Unexpected evidence target');
        if(state.failEvidence)return {ok:false,error:{code:'UNAVAILABLE',message:'Fixture evidence read unavailable.'}};
        const data=structuredClone(state.response);if(state.holdEvidence)await new Promise(resolve=>state.pendingEvidence.push(resolve));
        return {ok:true,data};
      }
      throw new Error('Unexpected fixture mutation: '+operation);
    });
  },JSON.parse(fs.readFileSync(fixtureFile,'utf8')));
  await page.getByText('Coordinator is coordinating.',{exact:true}).waitFor();await menu('view:Models');
  await page.locator('[data-models-action="tab"][data-view="Checks"]').click();
  await expect(page.locator('.mm-profile-progress-title')).toContainText('Smoke limit reached');
}
async function close(){if(app){launches.push(await app.evaluate(()=>globalThis.__profileLayoutFixture.calls));await app.close();app=null;}}
async function check(name,fn){try{await fn();checks.push({name,pass:true});console.log('PASS',name);}catch(error){checks.push({name,pass:false,error:error.stack||error.message});await screenshot({path:path.join(evidence,'failure-'+checks.length+'.png')}).catch(()=>{});throw error;}}
async function size(width,height,zoom,theme,nav){
  await app.evaluate(({BrowserWindow},{width,height,zoom})=>{const window=BrowserWindow.getAllWindows()[0];window.setSize(width,height);window.webContents.setZoomFactor(zoom);},{width,height,zoom});
  await menu('theme:'+theme);await settle();
  if(nav!=='auto'){
    const hidden=await page.locator('body').evaluate(node=>node.classList.contains('nav-hidden'));
    if(hidden!==(nav==='collapsed'))await page.locator('#toggle-navigation').click();
  }
  await settle();
}
async function layoutMetric(label){
  const metric=await page.evaluate(()=>{
    const rect=node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
    const main=document.querySelector('#main-region'),content=document.querySelector('#page-content'),detail=document.querySelector('.mm-profile-detail');
    return {viewport:{width:innerWidth,height:innerHeight},main:rect(main),content:rect(content),detail:rect(detail),
      documentOverflow:document.documentElement.scrollWidth-innerWidth,contentOverflow:content.scrollWidth-content.clientWidth,
      detailOverflow:detail.scrollWidth-detail.clientWidth,navHidden:document.body.classList.contains('nav-hidden')};
  });geometry.push({label,...metric});
  if(!captureOnly){assert.ok(metric.main.width>metric.viewport.width*.55,'Models must retain usable shell width: '+JSON.stringify(metric));
    assert.ok(metric.main.x>=-1&&metric.main.right<=metric.viewport.width+1,'Main region must remain in the viewport');
    assert.ok(metric.content.height>30&&metric.detail.width>150,'Content must be reachable');
    assert.ok(metric.documentOverflow<=1&&metric.contentOverflow<=1&&metric.detailOverflow<=1,'Overflow must stay in intentional table/output scrollers: '+JSON.stringify(metric));}
}
async function waitOverviewAfter(before){await expect.poll(async()=>(await calls('modelsProfileOverview')).length,{timeout:5000}).toBeGreaterThan(before);await settle();}
async function setPlan(version){
  const before=(await calls('modelsProfileOverview')).length;
  await app.evaluate((_,version)=>{const state=globalThis.__profileLayoutFixture;state.snapshot.targets[0].plan.plan_id='plan-layout-v'+version;
    state.snapshot.targets[0].bio.uncertainty='Evidence fixture revision '+version;state.response.planId='plan-layout-v'+version;
    state.response.records[0].response.value.marker='RETAINED_RESPONSE_V'+version;},version);
  await waitOverviewAfter(before);await expect(page.locator('.mm-profile-bio')).toContainText('Evidence fixture revision '+version);
}
(async()=>{
  try{
    await launch();
    await check('The previous collapsed-navigation grid defect is reproduced with a temporary test style',async()=>{
      await size(1440,1000,1,'dark','collapsed');
      const previous=await page.addStyleTag({content:'.nav-hidden .shell{grid-template-columns:0 minmax(0,1fr)!important}'});
      try{
        await settle();const width=await page.locator('#main-region').evaluate(node=>node.getBoundingClientRect().width);
        assert.ok(width<2,'The old rule must reproduce the collapsed content column');
        await screenshot({path:path.join(evidence,'before-collapsed.png')});
      }finally{await previous.evaluate(node=>node.remove());await settle();}
      await layoutMetric('after-collapsed');await screenshot({path:path.join(evidence,'after-collapsed.png')});
    });
    await check('Real Models shell remains readable with navigation expanded, collapsed, narrow and scaled',async()=>{
      for(const [width,height,zoom,theme,nav] of [[1440,1000,1,'dark','expanded'],[1440,1000,1,'dark','collapsed'],[1100,800,1,'light','expanded'],[880,640,1,'light','auto'],[880,640,1.5,'dark','auto'],[880,640,2,'light','auto']]){
        await size(width,height,zoom,theme,nav);await page.locator('#page-content').evaluate(node=>{node.scrollTop=0;});
        const label=`${width}-${zoom}-${theme}-${nav}`;await layoutMetric(label);
        await screenshot({path:path.join(evidence,`fixture-models-${label}.png`)});
        if(!captureOnly){await page.locator('.mm-profile-bio').scrollIntoViewIfNeeded();await layoutMetric(label+'-bio');
          const scroller=page.locator('.mm-profile-table-scroll');await scroller.evaluate(node=>{node.scrollLeft=node.scrollWidth;});
          assert.equal(await scroller.evaluate(node=>node.scrollWidth<=node.clientWidth+1||node.scrollLeft>0),true,'Wide comparison remains scrollable');
          await screenshot({path:path.join(evidence,`fixture-bio-${label}.png`)});}
      }
      assert.equal((await calls('modelsProfileEvidence')).length,0,'Layout and polling must not request responses');
    });
    if(captureOnly)return;
    await check('Recorded responses open by keyboard, remain literal and separate from criteria, and explain missing output',async()=>{
      await summary().scrollIntoViewIfNeeded();await summary().focus();await page.keyboard.press('Enter');
      await expect(details().locator('.mm-recorded-text').first()).toContainText(responseMarker);
      await expect(details().locator('.mm-recorded-text').first()).toContainText('RETAINED_END');
      await expect(details().locator('.mm-recorded-text').first()).toContainText('<script>window.fixtureInjected=true</script>');
      assert.equal(await details().locator('script,img').count(),0);assert.equal(await page.evaluate(()=>window.fixtureInjected),undefined);
      await expect(details()).toContainText('Response unavailable or not retained');await expect(details()).toContainText('Not measured — no response');
      await expect(details()).toContainText('Display limited to 8,192 characters');await expect(details()).not.toContainText('CAPPED_RESPONSE_END');
      const criterion=details().getByText('EXPECTED_ONLY_FIXTURE',{exact:false});await expect(criterion).toBeHidden();
      await details().locator('.mm-recorded-check').first().locator('details > summary').press('Enter');await expect(criterion).toBeVisible();
      assert.equal((await calls('modelsProfileEvidence')).length,1);await layoutMetric('recorded-response-200-percent');
      await details().locator('.mm-recorded-text').first().scrollIntoViewIfNeeded();await screenshot({path:path.join(evidence,'fixture-recorded-response-light-200-percent.png')});
    });
    await check('Polling preserves an expanded response and keyboard focus without silently rereading evidence',async()=>{
      await size(1440,1000,1,'dark','collapsed');await summary().scrollIntoViewIfNeeded();await summary().focus();
      const scrollBefore=await page.locator('#page-content').evaluate(node=>node.scrollTop),before=(await calls('modelsProfileOverview')).length;
      await app.evaluate(()=>{globalThis.__profileLayoutFixture.snapshot.targets[0].bio.uncertainty='Updated fixture: one attempt is partial evidence, never a full model qualification.';});
      await waitOverviewAfter(before);await expect(summary()).toBeFocused();await expect(details()).toHaveAttribute('open','');
      assert.ok(Math.abs(await page.locator('#page-content').evaluate(node=>node.scrollTop)-scrollBefore)<6,'Reader position must be retained');
      assert.equal((await calls('modelsProfileEvidence')).length,1);
      await page.locator('[data-models-action="refresh"]').click();await expect(page.locator('[data-models-action="refresh"]')).toBeEnabled();
      assert.equal((await calls('modelsProfileEvidence')).length,1,'Snapshot refresh must not read responses');
      await setPlan(2);assert.equal((await calls('modelsProfileEvidence')).length,1,'Changed evidence requires an explicit new read');
      await expect(details()).not.toContainText(responseMarker);
    });
    await check('Delayed same-target evidence cannot replace a newer plan or reopen closed details',async()=>{
      if(await details().getAttribute('open')!==null)await summary().press('Enter');
      await app.evaluate(()=>{globalThis.__profileLayoutFixture.holdEvidence=true;});await summary().press('Enter');
      await expect.poll(()=>app.evaluate(()=>globalThis.__profileLayoutFixture.pendingEvidence.length)).toBe(1);
      await setPlan(3);await app.evaluate(()=>globalThis.__profileLayoutFixture.pendingEvidence.splice(0).forEach(resolve=>resolve()));await settle();
      await expect(details()).not.toContainText('RETAINED_RESPONSE_V2');assert.equal((await calls('modelsProfileEvidence')).length,2);
      if(await details().getAttribute('open')!==null)await summary().press('Enter');await summary().press('Enter');
      await expect.poll(()=>app.evaluate(()=>globalThis.__profileLayoutFixture.pendingEvidence.length)).toBe(1);
      await summary().press('Enter');await app.evaluate(()=>{const state=globalThis.__profileLayoutFixture;state.holdEvidence=false;state.pendingEvidence.splice(0).forEach(resolve=>resolve());});
      await settle();await expect(details()).not.toHaveAttribute('open','');assert.equal((await calls('modelsProfileEvidence')).length,3);
      await summary().press('Enter');await expect(details()).toContainText('RETAINED_RESPONSE_V3');
      await details().locator('.mm-recorded-check').first().scrollIntoViewIfNeeded();
      await screenshot({path:path.join(evidence,'fixture-recorded-response-dark-collapsed.png')});
    });
    await check('An evidence read error survives polling and retries only after an explicit reopen',async()=>{
      if(await details().getAttribute('open')!==null)await summary().press('Enter');await setPlan(4);
      await app.evaluate(()=>{globalThis.__profileLayoutFixture.failEvidence=true;});await summary().press('Enter');
      await expect(details()).toContainText('Fixture evidence read unavailable.');
      const reads=(await calls('modelsProfileEvidence')).length,before=(await calls('modelsProfileOverview')).length;
      await waitOverviewAfter(before);await expect(details()).toContainText('Fixture evidence read unavailable.');
      assert.equal((await calls('modelsProfileEvidence')).length,reads,'Polling must not retry a failed evidence read');
      await summary().press('Enter');await app.evaluate(()=>{globalThis.__profileLayoutFixture.failEvidence=false;});await summary().press('Enter');
      await expect(details()).toContainText('RETAINED_RESPONSE_V4');assert.equal((await calls('modelsProfileEvidence')).length,reads+1);
    });
    await check('A fresh application renders the restored fixture result without inference or automatic response retrieval',async()=>{
      const saved=await app.evaluate(()=>{const {snapshot,response}=globalThis.__profileLayoutFixture;return {snapshot,response};});fs.writeFileSync(fixtureFile,JSON.stringify(saved));
      await close();await launch();await expect(page.locator('.mm-profile-progress-title')).toContainText('Smoke limit reached');
      await expect(page.locator('.mm-profile-bio')).toContainText('Evidence fixture revision 4');assert.equal((await calls('modelsProfileEvidence')).length,0);
      await summary().press('Enter');await expect(details()).toContainText('RETAINED_RESPONSE_V4');
      assert.equal((await calls('modelsProfileEvidence')).length,1);
    });
    await check('Layout and response fixtures dispatch no model, configuration change or external request',async()=>{
      assert.deepEqual(errors,[]);assert.deepEqual(network,[]);
      for(const launch of [...launches,await app.evaluate(()=>globalThis.__profileLayoutFixture.calls)])assert.ok(launch.every(call=>['modelsOverview','modelsRefresh','modelsProfileOverview','modelsProfileEvidence'].includes(call.operation)));
      const file=path.join(profile,'fixture-calls.jsonl'),nativeCalls=fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
      assert.equal(nativeCalls.some(call=>['chat.send','config.patch','sessions.patch','approval.resolve','gcb.profile.complete','gcb.profile.preflight'].includes(call.method)),false);
    });
  }catch(error){if(!checks.some(check=>!check.pass))checks.push({name:'Fixture setup',pass:false,error:error.stack||error.message});console.error(error.message);}
  finally{
    await app?.evaluate(()=>globalThis.__profileLayoutFixture.pendingEvidence.splice(0).forEach(resolve=>resolve())).catch(()=>{});await close().catch(()=>{});
    fs.writeFileSync(path.join(evidence,'profile-layout-tests.json'),JSON.stringify({at:new Date().toISOString(),checks,errors,network,geometry,launches,captureOnly,
      scope:'Actual native Models shell with deterministic mocked IPC records. Restart restores test JSON, not GCB persistence. No model/backend execution.'},null,2));
    const passed=checks.filter(check=>check.pass).length,failed=checks.filter(check=>!check.pass).length;console.log(JSON.stringify({passed,failed,evidence}));process.exitCode=failed||errors.length||network.length||!checks.length?1:0;
  }
})();
