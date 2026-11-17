'use strict';
// Renderer state/authorization checks with explicit RPC fixtures. No GCB or model dispatch.
const { _electron } = require('./test-support.cjs').playwright;
const { evidenceDirectory } = require('./test-support.cjs');
const { createRequire } = require('node:module');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root=path.resolve(__dirname,'..'),evidence=evidenceDirectory('profile-view');
const { expect }=createRequire(path.join(root,'desktop/package.json'))('playwright/test');
const profile=fs.mkdtempSync(path.join(evidence,'fixture-profile-'));
const env={...process.env,OPENCLAW_PLUS_TEST_DATA:profile,OPENCLAW_PLUS_TEST_CLI:path.join(root,'tests/fixture-gateway.cjs')};
delete env.ELECTRON_RUN_AS_NODE;delete env.OPENCLAW_PLUS_TEST_GCB;
let application,page;
const checks=[],errors=[],network=[];
const action=name=>page.locator(`[data-profile-action="${name}"]`);
const dialog=()=>page.locator('.mm-profile-dialog[open]');
const notice=()=>page.locator('[data-profile-region="notice"]');
const update=values=>page.evaluate(values=>Object.assign(window.__profileViewFixture,values),values);
const calls=operation=>page.evaluate(operation=>window.__profileViewFixture.calls.filter(call=>call.operation===operation),operation);
async function reset(mode='offline',requestedRef=''){
  await page.evaluate(({mode,requestedRef})=>window.__resetProfileViewFixture(mode,requestedRef),{mode,requestedRef});
  await expect.poll(async()=>Boolean(await page.evaluate(()=>window.__profileViewFixture.calls.some(call=>call.operation==='modelsProfileOverview')))).toBe(true);
}
async function check(name,fn){
  try{await fn();checks.push({name,pass:true});console.log('PASS',name);}
  catch(error){checks.push({name,pass:false,error:error.stack||error.message});await page.screenshot({path:path.join(evidence,'failure-'+checks.length+'.png')}).catch(()=>{});throw error;}
}
(async()=>{
  try{
    application=await _electron.launch({executablePath:path.join(root,'desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[path.join(root,'desktop')],env});
    page=await application.firstWindow();page.setDefaultTimeout(10000);
    page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(/^(?:https?|wss?|file):/.test(request.url()))network.push(request.url());});
    await page.getByText('Coordinator is coordinating.',{exact:true}).waitFor();
    await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1440,1000));
    await page.evaluate(async()=>{
      const {createProfileView}=await import('openclaw-plus://ui/profile-view.mjs');
      const container=document.createElement('main');container.id='profile-view-fixture';container.className='models-workspace';
      container.style.cssText='position:fixed;inset:0;z-index:100;padding:28px;overflow:auto;background:var(--bg,#161314);';document.body.append(container);
      const configuration=(id,native,observed=0)=>({configuration_id:id,native,attempt_count:observed,
        categories:{coding:{correct:observed,observed,pending:observed?0:1}},strengths:observed?['coding: 1/1 exact fixture response']:[],weaknesses:[],
        untested_categories:['research','planning'],latency_ms:{median:null},usage:{input_tokens:null,output_tokens:null,billed_cost_usd:null}});
      const targetFor=(mode,id)=>({id,modelRef:mode==='offline'?'fictional/forge':mode==='ollama'?'ollama/qwen3.5:9b':'openai/gpt-fixture',name:mode==='ollama'?'Local fixture':'Fixture model',mode,
        metadata:{metadata_id:'metadata-'+id,model:{context_window:4096,max_output:mode==='ollama'?128:512,modalities:['text'],native_tools:false,
          reasoning:{semantics:mode==='ollama'?'boolean':'effort',native_configurations:mode==='ollama'?[{think:false},{think:true}]:[{reasoning_effort:'low'},{reasoning_effort:'high'}]}}},
        bio:{evidence_kind:mode==='offline'?'synthetic_fixture':mode==='ollama'?'local_model':'host_runtime',uncertainty:'One fixture is not broad capability evidence.',
          configurations:mode==='ollama'?[configuration('cfg-local-off',{think:false,options:{num_ctx:4096,num_predict:128}}),configuration('cfg-local-on',{think:true,options:{num_ctx:4096,num_predict:128}})]:[configuration('cfg-low',{reasoning_effort:'low'}),configuration('cfg-high',{reasoning_effort:'high'})]},canResume:false});
      window.__resetProfileViewFixture=(mode='offline',requestedRef='')=>{
        window.__profileViewFixture?.view.destroy();container.replaceChildren();
        const selected=targetFor(mode,mode==='ollama'?'local-fixture':mode==='openclaw'?'host-fixture':'forge');
        const state=window.__profileViewFixture={calls:[],pendingPlans:[],pendingPreviews:[],snapshot:{engine:{status:'ready',message:'Fixture engine'},targets:[selected],active:null},requestedRef};
        const rpc=async(operation,params={})=>{
          state.calls.push({operation,params:structuredClone(params)});
          const target=state.snapshot.targets.find(target=>target.id===params.targetId)||state.snapshot.targets.at(-1);
          if(operation==='modelsProfileOverview')return structuredClone(state.snapshot);
          if(operation==='modelsProfileLocal'){
            if(Object.keys(params).length!==1||params.modelRef!=='ollama/qwen3.5:9b')throw new Error('Exact model reference required.');
            const local=targetFor('ollama','local-fixture');delete local.metadata;delete local.bio;state.snapshot.targets.push(local);return structuredClone(state.snapshot);
          }
          if(operation==='modelsProfileResearch'){
            if(state.failResearch)throw new Error('Provider disconnected. Reconnect it in OpenClaw, then research again.');
            if(target.mode==='ollama')Object.assign(target,targetFor('ollama',target.id));
            return structuredClone(state.snapshot);
          }
          if(operation==='modelsProfilePlan'){
            if(state.holdPlan)await new Promise(resolve=>state.pendingPlans.push(resolve));
            const local=target.mode==='ollama';
            const plan={plan_id:'plan-'+target.id,model_id:target.id,configuration_ids:state.unmapped?['missing-config']:local?['cfg-local-off']:['cfg-high','cfg-low'],
              cells:[{case_id:'coding.json'},{case_id:'research.sources'}],max_requests:local?1:32,max_output_tokens:local?128:512,
              call_timeout_seconds:45,total_timeout_seconds:local?60:300,concurrency:1,estimated_cost_usd:null};
            target.plan=plan;target.status={status:'planned',attempts:0,cells:{pending:2},total_cells:2};
            return {reviewToken:'review-'+target.id,plan:structuredClone(plan),target:structuredClone(target),resumed:false};
          }
          if(operation==='modelsProfileStart'){
            if(state.failStart)throw new Error('This exact review is no longer valid.');
            if(target.mode==='ollama'){
              target.status={status:'paused',attempts:1,total_cells:2,cells:{observed:1,pending:1}};target.limitReached=true;target.canResume=false;
              target.bio.configurations[0]=configuration('cfg-local-off',{think:false,options:{num_ctx:4096,num_predict:128}},1);
            }
            return structuredClone(state.snapshot);
          }
          if(operation==='modelsProfilePreview'){
            if(state.holdPreview)await new Promise(resolve=>state.pendingPreviews.push(resolve));
            return {routes:[{role:'Coding',preview:{enforcement:'preview_only',selected_configuration_id:'cfg-high',ranking:'fixture evidence',
              candidates:[{configuration_id:'cfg-high',model_id:target.id,eligible:true,reasons:[],comparable_observed:1,comparable_correct:1,comparable_latency_ms:null}]}}]};
          }
          throw new Error('Unexpected fixture operation: '+operation);
        };
        state.view=createProfileView({rpc});state.view.render(container,'Checks',requestedRef);
      };
    });
    await check('Failed action messages survive successful background overview polling',async()=>{
      await reset();await update({failResearch:true});await action('research').click();await expect(notice()).toContainText('Provider disconnected');
      const before=(await calls('modelsProfileOverview')).length;
      await expect.poll(async()=>(await calls('modelsProfileOverview')).length,{timeout:5000}).toBeGreaterThan(before);
      await expect(notice()).toContainText('Provider disconnected');
      await update({failResearch:false});await action('research').click();await expect(notice()).toHaveText('');
    });
    await check('Usage review resolves exact native settings by plan configuration identity',async()=>{
      await reset();await action('plan').click();await expect(dialog()).toBeVisible();
      await expect(dialog().getByRole('row').filter({has:page.getByRole('rowheader',{name:'Exact native settings 1',exact:true})})).toContainText('{"reasoning_effort":"high"}');
      await expect(dialog().getByRole('row').filter({has:page.getByRole('rowheader',{name:'Exact native settings 2',exact:true})})).toContainText('{"reasoning_effort":"low"}');
      await expect(action('start')).toBeDisabled();assert.equal((await calls('modelsProfileStart')).length,0);
      await action('close-review').first().click();await update({unmapped:true});await action('plan').click();
      await expect(notice()).toContainText('exact native settings');await expect(dialog()).toHaveCount(0);assert.equal((await calls('modelsProfileStart')).length,0);
    });
    await check('Host usage requires both consents and failed Start cannot reuse the review',async()=>{
      await reset('openclaw');await action('plan').click();await expect(dialog()).toBeVisible();
      const usage=dialog().locator('[data-profile-input="approve-usage"]'),host=dialog().locator('[data-profile-input="approve-host"]');
      await usage.check();await expect(action('start')).toBeDisabled();await host.check();await expect(action('start')).toBeEnabled();
      await usage.uncheck();await expect(action('start')).toBeDisabled();await usage.check();await update({failStart:true});await action('start').click();
      await expect(dialog().locator('[data-profile-error]')).toContainText('no longer valid');
      await host.uncheck();await host.check();await usage.uncheck();await usage.check();await expect(action('start')).toBeDisabled();
      const starts=await calls('modelsProfileStart');assert.equal(starts.length,1);assert.equal(starts[0].params.approveHostRuntime,true);
    });
    await check('A delayed host plan cannot reopen usage authorization after disconnection',async()=>{
      await reset('openclaw');await update({holdPlan:true});await action('plan').click();
      await page.waitForFunction(()=>window.__profileViewFixture.pendingPlans.length===1);
      await page.evaluate(()=>{const state=window.__profileViewFixture;state.view.invalidateConnection();state.pendingPlans.splice(0).forEach(resolve=>resolve());});
      await expect(notice()).toContainText('connection changed');await expect(dialog()).toHaveCount(0);assert.equal((await calls('modelsProfileStart')).length,0);
    });
    await check('Changed profile evidence invalidates existing routing recommendations',async()=>{
      await reset();await page.evaluate(()=>window.__profileViewFixture.view.render(document.querySelector('#profile-view-fixture'),'Personal routing'));
      await action('preview').click();await expect(page.locator('.mm-route-cards article')).toHaveCount(1);
      await page.evaluate(async()=>{const state=window.__profileViewFixture;state.snapshot.targets[0].metadata.metadata_id='new-research';await state.view.load();});
      await expect(page.locator('.mm-route-cards')).toHaveCount(0);await action('preview').click();await expect(page.locator('.mm-route-cards article')).toHaveCount(1);
    });
    await check('A delayed live preview cannot restore recommendations after disconnection',async()=>{
      await reset('openclaw');await page.evaluate(()=>window.__profileViewFixture.view.render(document.querySelector('#profile-view-fixture'),'Personal routing'));
      await update({holdPreview:true});await action('preview').click();await page.waitForFunction(()=>window.__profileViewFixture.pendingPreviews.length===1);
      await page.evaluate(()=>{const state=window.__profileViewFixture;state.view.invalidateConnection();state.pendingPreviews.splice(0).forEach(resolve=>resolve());});
      await expect(action('preview')).toBeEnabled();await expect(page.locator('.mm-route-cards')).toHaveCount(0);
    });
    await check('Local smoke preparation and authorization stay exact, bounded and visibly partial',async()=>{
      await reset('offline','ollama/qwen3.5:9b');await expect(action('prepare-local')).toBeEnabled();await action('prepare-local').click();
      await expect(page.locator('[data-profile-region="detail"]')).toContainText('Local Ollama');
      assert.deepEqual((await calls('modelsProfileLocal'))[0].params,{modelRef:'ollama/qwen3.5:9b'});assert.equal((await calls('modelsProfileStart')).length,0);
      await action('research').click();await expect(action('plan')).toBeEnabled();
      await expect(page.locator('[data-profile-input="contrast"]')).toBeDisabled();await expect(page.locator('[data-profile-input="contrast"]')).not.toBeChecked();
      await action('plan').click();await expect(dialog()).toBeVisible();
      assert.deepEqual((await calls('modelsProfilePlan'))[0].params,{targetId:'local-fixture',contrast:false});
      await expect(dialog()).toContainText('"think":false');await expect(dialog()).toContainText('4096');await expect(dialog()).toContainText('128');
      await expect(dialog()).toContainText('Maximum local attempts');await expect(dialog()).toContainText('45 seconds');await expect(dialog()).toContainText('60 seconds');
      await expect(dialog().locator('[data-profile-input="approve-host"]')).toHaveCount(0);await expect(action('start')).toBeDisabled();
      await page.screenshot({path:path.join(evidence,'local-smoke-review-fixture.png')});
      await dialog().locator('[data-profile-input="approve-usage"]').check();await expect(action('start')).toBeEnabled();await action('start').click();await expect(dialog()).toHaveCount(0);
      const starts=await calls('modelsProfileStart');assert.equal(starts.length,1);assert.equal(starts[0].params.approveHostRuntime,false);assert.equal(starts[0].params.approveUsage,true);
      await expect(page.locator('.mm-profile-progress-title')).toContainText('Smoke limit reached · partial evidence');
      await expect(page.getByRole('heading',{name:'Partial capability bio',exact:true})).toBeVisible();await expect(action('plan')).toBeDisabled();
      await page.getByRole('heading',{name:'Partial capability bio',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:path.join(evidence,'local-smoke-partial-fixture.png')});
    });
    await check('Renderer fixtures neither dispatch a model nor make external requests',async()=>{
      assert.deepEqual(errors,[]);assert.deepEqual(network,[]);
      const file=path.join(profile,'fixture-calls.jsonl');const native=fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
      assert.equal(native.some(call=>['gcb.profile.complete','gcb.profile.preflight','chat.send','config.patch','sessions.patch','approval.resolve'].includes(call.method)),false);
    });
  }catch(error){if(!checks.some(check=>!check.pass))checks.push({name:'Fixture setup',pass:false,error:error.stack||error.message});console.error(error.message);}
  finally{
    await page?.evaluate(()=>window.__profileViewFixture?.view.destroy()).catch(()=>{});await application?.close().catch(()=>{});
    fs.writeFileSync(path.join(evidence,'profile-view-tests.json'),JSON.stringify({at:new Date().toISOString(),checks,errors,network,scope:'Renderer module in native Electron with explicit mocked RPC results. No GCB executable or live inference.'},null,2));
    const passed=checks.filter(check=>check.pass).length,failed=checks.filter(check=>!check.pass).length;console.log(JSON.stringify({passed,failed,evidence}));process.exitCode=failed||errors.length||network.length||!checks.length?1:0;
  }
})();
