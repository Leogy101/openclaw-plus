'use strict';
const { _electron } = require('./test-support.cjs').playwright;
const { evidenceDirectory } = require('./test-support.cjs');
const { createRequire } = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const desktopRequire = createRequire(path.join(root, 'desktop/package.json'));
const { expect } = desktopRequire('playwright/test');
const evidence = evidenceDirectory('model-manager');
const profile = fs.mkdtempSync(path.join(evidence, 'fixture-profile-'));
fs.writeFileSync(path.join(profile, 'fixture-terminal.json'), '{}');
const env = { ...process.env, OPENCLAW_PLUS_TEST_DATA: profile, OPENCLAW_PLUS_TEST_CLI: path.join(root, 'tests/fixture-gateway.cjs') };
delete env.ELECTRON_RUN_AS_NODE;

const catalog = {
  models: [
    { provider: 'fixture', id: 'model-one', name: 'Fixture Model', available: true, manualSelectionAllowed: true, contextWindow: 32000, supportsTools: true, reasoning: true,
      thinkingLevels: [{ id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }], thinkingDefault: 'medium', input: ['text', 'image'], agentRuntime: { id: 'openclaw', source: 'model' }, apiKey: 'FIXTURE-SECRET-DO-NOT-PUBLISH' },
    { provider: 'fixture', id: 'restricted', name: 'Restricted fixture', available: true, manualSelectionAllowed: false, input: ['text'] },
    { provider: 'fixture', id: 'missing-auth', name: 'Setup needed fixture', available: false, unavailableReason: 'missing-auth', input: ['text'], apiKeySupported: true },
    { provider: 'other', id: 'model-one', name: 'Unknown availability fixture' },
    { provider: 'fixture', id: 'nested/model', name: 'Nested model fixture', available: true, local: true, input: ['text'] },
  ],
};
const providerSetup = {status:'available',source:'installed-openclaw-metadata',version:'2026.11.1',limitations:[],items:[
  {id:'fixture',label:'Fixture provider',providerIds:['fixture'],methods:[{id:'api-key',label:'API key'}]},
  {id:'anthropic',label:'Anthropic',providerIds:['anthropic'],methods:[{id:'api-key',label:'API key'}]},
  {id:'local',label:'Ollama',providerIds:['ollama','ollama-cloud'],methods:[{id:'local',label:'Local setup'},{id:'cloud',label:'Cloud sign-in'}]},
  {id:'custom',label:'Custom provider',providerIds:[],methods:[]},
]};
const checks = [], errors = [], network = [], launches = [];
let application, page;
const gatewayCalls = () => {
  const file = path.join(profile, 'fixture-calls.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
};
async function launch() {
  application = await _electron.launch({ executablePath: path.join(root, 'desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [path.join(root, 'desktop')], env });
  page = await application.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^(?:https?|wss?|file):/.test(request.url())) network.push(request.url()); });
  await application.evaluate(({ BrowserWindow, ipcMain, shell, clipboard }, { root, catalog, providerSetup }) => {
    const { CliTransport, ReadError } = process.mainModule.require(root + '/desktop/src/gateway-cli.cjs');
    const { ModelManagerService } = process.mainModule.require(root + '/desktop/src/model-manager.cjs');
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(1440, 1000);
    const state = globalThis.__modelManagerFixture = { calls: [], catalog, initialCatalog:structuredClone(catalog), providerSetup, initialProviderSetup:structuredClone(providerSetup), mode: 'ready', hold: false, releases: [], native: [], ipc: [], terminal: [] };
    ModelManagerService.prototype.loadProviderOptions = function () { this.providerSetup = structuredClone(state.providerSetup); };
    CliTransport.prototype.modelRead = async function (operation, params) {
      state.calls.push({ operation, params: structuredClone(params) });
      state.transport = this;
      if (!['capabilities', 'catalog'].includes(operation)) throw new ReadError('INVALID', 'The passive fixture rejects discovery and auth operations.');
      if (state.hold) await new Promise(resolve => state.releases.push(resolve));
      if (state.mode === 'offline') throw new ReadError('UNAVAILABLE', 'Fixture native catalog unavailable.');
      if (operation === 'capabilities') return { version: '2026.11.1', protocol: 4, methods: ['models.list'], capabilities: state.mode === 'unsupported' ? [] : ['published-model-catalog', 'session-scoped-model-catalog'], available: state.mode !== 'unsupported', clientCaps: ['model-selection-policy'] };
      if (state.mode === 'malformed') return { models: null };
      return structuredClone(state.catalog);
    };
    const original = ipcMain._invokeHandlers.get('desktop:models');
    if (!original) throw new Error('Models IPC handler is missing.');
    if (original) {
      state.original = original;
      ipcMain.removeHandler('desktop:models');
      ipcMain.handle('desktop:models', async (event, operation, params) => {
        state.ipc.push({ operation, params: structuredClone(params) });
        return original(event, operation, params);
      });
    }
    const terminal = ipcMain._invokeHandlers.get('desktop:terminal');
    if(terminal){ipcMain.removeHandler('desktop:terminal');ipcMain.handle('desktop:terminal',async(event,action,params)=>{const call={action,params:structuredClone(params)};state.terminal.push(call);const reply=await terminal(event,action,params);call.reply=structuredClone(reply);return reply;});}
    const send = window.webContents.send.bind(window.webContents);
    state.publish = event => send('gateway:event', event);
    window.webContents.send = (channel, event, ...rest) => channel === 'gateway:event' ? undefined : send(channel, event, ...rest);
    shell.openExternal = async value => state.native.push({ kind: 'external', value });
    shell.openPath = async value => { state.native.push({ kind: 'openPath', value }); return 'Disabled in fixture'; };
    clipboard.writeText = value => state.native.push({ kind: 'clipboard', value });
  }, { root, catalog, providerSetup });
  await page.reload();
  await page.getByText('Coordinator is coordinating.', { exact: true }).waitFor();
}
async function state() { return application.evaluate(() => { const { calls, native, ipc, terminal } = globalThis.__modelManagerFixture; return { calls, native, ipc, terminal }; }); }
async function closeApp() { if(application){launches.push(await state().catch(()=>null));await application.close();application=null;} }
async function setMode(mode) { await application.evaluate((_, mode) => { globalThis.__modelManagerFixture.mode = mode; }, mode); }
async function menu(id) { await application.evaluate(({ Menu }, id) => { const item = Menu.getApplicationMenu().getMenuItemById(id); if (!item) throw new Error('Missing native menu ' + id); item.click(); }, id); }
async function check(name, fn) {
  try { await fn(); checks.push({ name, pass: true }); console.log('PASS', name); }
  catch (error) { checks.push({ name, pass: false, error: error.message }); console.log('FAIL', name, error.message); if (page && !page.isClosed()) await page.screenshot({ path: path.join(evidence, 'failure-' + checks.length + '.png') }).catch(() => {}); }
}

(async () => {
  try {
    await launch();

    const registryPath = path.join(profile, 'ModelManager', 'registry.json');
    const registry = () => JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const rpc = (operation, params = {}) => page.evaluate(({operation,params}) => window.openclawPlusDesktop.models(operation, params), {operation,params});
    const action = name => page.locator(`[data-models-action="${name}"]`);
    const dialog = () => page.locator('.mm-dialog[open]');
    const openAdd = async () => { await action('add').first().click(); await dialog().getByLabel('Published model', {exact:true}).waitFor(); };
    const closeDialog = async () => { if (await dialog().count()) await dialog().getByRole('button',{name:'Close model dialog',exact:true}).click(); };
    const choose = ref => action('select').filter({has:page.locator(`small:text-is("${ref}")`)}).click();
    const refresh = async () => { await action('refresh').click(); await expect(action('refresh')).toBeEnabled(); };
    const ready = async () => { await expect(page.locator('[data-models-region="status"]')).toContainText('Published catalog'); await expect(action('add').first()).toBeEnabled(); };
    const pause = ms => page.waitForTimeout(ms);
    const waitMain = async predicate => { const end = Date.now()+10000; while(!await application.evaluate(predicate)){if(Date.now()>end)throw new Error('Main fixture wait timed out.');await pause(25);} };
    await page.locator('#composer-input').fill('Preserve this unsent draft while managing models.');
    await menu('view:Models'); await ready();

    await check('Published catalog is passive, preserves exact identity and does not imply authentication or qualification', async () => {
      await expect(action('select')).toHaveCount(5);
      assert.deepEqual((await action('select').evaluateAll(nodes=>nodes.map(n=>n.dataset.modelRef))).sort(),catalog.models.map(row=>row.provider+'/'+row.id).sort());
      const snapshot=await rpc('modelsOverview'); assert.equal(snapshot.ok,true);
      assert.equal(snapshot.data.catalog.models.find(row=>row.modelRef==='other/model-one').available,null);
      assert.equal(snapshot.data.catalog.models.find(row=>row.modelRef==='fixture/model-one').apiKey,undefined);
      assert.equal(snapshot.data.catalog.providers.every(row=>row.authStatus==='not-checked'),true);
      assert.equal(snapshot.data.execution,'unavailable'); assert.equal(snapshot.data.routing,'preview-only');
      assert.equal(registry().registrations.length,0);
      await expect(page.locator('.mm-role-table tbody tr')).toHaveCount(4);
      assert.equal(await page.locator('.mm-role-table tbody td').filter({hasText:/^Not checked$/}).count(),4);
      assert.equal(await page.locator('.mm-role-table tbody td').filter({hasText:/^Not admitted$/}).count(),4);
      assert.match(await page.locator('[data-models-region="status"]').textContent(),/Authentication and inference are not tested/);
      assert.equal((await state()).calls.every(call=>['capabilities','catalog'].includes(call.operation)),true);
      assert.equal((await state()).native.length,0);
      assert.equal(await page.locator('body').textContent().then(text=>text.includes('FIXTURE-SECRET-DO-NOT-PUBLISH')),false);
    });


    await check('All providers includes native setup choices without fabricated model rows or authentication claims', async () => {
      const providers=page.getByRole('combobox',{name:'Filter models by provider'});
      assert.deepEqual(await providers.locator('option').evaluateAll(nodes=>nodes.map(node=>({value:node.value,label:node.textContent}))),[
        {value:'',label:'All providers'},{value:'fixture',label:'Fixture provider'},{value:'anthropic',label:'Anthropic'},
        {value:'local',label:'Ollama'},{value:'custom',label:'Custom provider'},{value:'other',label:'other'},
      ]);
      await providers.selectOption('anthropic');
      await expect(action('select')).toHaveCount(0);
      await expect(page.locator('[data-models-region="detail"]')).toContainText('No published models for this provider');
      await expect(page.locator('[data-models-region="detail"]').getByRole('heading',{name:'Anthropic',exact:true})).toBeVisible();
      await expect(page.locator('.mm-chips')).toContainText('Available in OpenClaw setup');
      await expect(page.locator('.mm-chips')).toContainText('Authentication not checked');
      assert.doesNotMatch(await page.locator('.mm-chips').textContent(),/Advertised available|Connected|Registered|Not registered/);
      await expect(action('add').first()).toBeDisabled();
      assert.equal(await page.locator('[data-models-region="detail"]').textContent().then(text=>text.includes('fixture/model-one')),false);
      assert.equal(registry().registrations.length,0);
      assert.equal((await rpc('modelsOverview')).data.catalog.models.length,5);
      await providers.selectOption(''); await ready();
    });

    await check('An empty setup choice opens only the fixed native onboarding page, including Custom provider',async()=>{
      const providers=page.getByRole('combobox',{name:'Filter models by provider'});
      await providers.selectOption('custom');
      await expect(page.locator('[data-models-region="detail"]').getByRole('heading',{name:'Custom provider',exact:true})).toBeVisible();
      await expect(action('select')).toHaveCount(0); await expect(action('add').first()).toBeDisabled();
      const before=(await state()).native.length;
      await page.locator('[data-models-region="detail"] [data-models-action="onboard"]').click();
      await expect(page.locator('#toast')).toContainText('Provider setup opened in OpenClaw');
      assert.deepEqual((await state()).native.slice(before),[{kind:'external',value:'http://127.0.0.1:19999/settings/model-setup'}]);
      assert.equal(registry().registrations.length,0);
      await providers.selectOption(''); await ready();
    });

    await check('Provider and search selection survive passive refresh and leaving Models without restoring an unrelated model',async()=>{
      const providers=page.getByRole('combobox',{name:'Filter models by provider'}),search=page.getByRole('searchbox',{name:'Find a model'});
      await providers.selectOption('anthropic'); await search.fill('Retained search'); await refresh();
      await expect(providers).toHaveValue('anthropic'); await expect(search).toHaveValue('Retained search');
      await expect(page.locator('[data-models-region="detail"]').getByRole('heading',{name:'Anthropic',exact:true})).toBeVisible();
      await menu('view:Conversations'); await expect(page.locator('#composer-input')).toHaveValue('Preserve this unsent draft while managing models.');
      await menu('view:Models'); await expect(action('refresh')).toBeEnabled();
      await expect(page.getByRole('combobox',{name:'Filter models by provider'})).toHaveValue('anthropic');
      await expect(page.getByRole('searchbox',{name:'Find a model'})).toHaveValue('Retained search');
      await expect(page.locator('[data-models-region="detail"]').getByRole('heading',{name:'Anthropic',exact:true})).toBeVisible();
      await page.getByRole('searchbox',{name:'Find a model'}).fill('');
      await page.getByRole('combobox',{name:'Filter models by provider'}).selectOption(''); await ready();
    });

    await check('Partial or unavailable setup metadata is visible and retains a prior provider as unverified',async()=>{
      const providers=page.getByRole('combobox',{name:'Filter models by provider'});
      try {
        await providers.selectOption('anthropic');
        await application.evaluate(()=>{const state=globalThis.__modelManagerFixture;state.providerSetup={...state.providerSetup,status:'partial',items:state.providerSetup.items.slice(0,2),limitations:['Fixture optional metadata unavailable.']};});
        await refresh(); await expect(page.locator('.mm-provider-note').first()).toContainText('incomplete');
        await expect(providers.locator('option').first()).toHaveText('All listed providers'); await expect(providers).toHaveValue('anthropic');
        await application.evaluate(()=>{globalThis.__modelManagerFixture.providerSetup={status:'unavailable',source:'installed-openclaw-metadata',items:[],limitations:['Fixture metadata unavailable.']};});
        await refresh(); await expect(page.locator('.mm-provider-note').first()).toContainText('unavailable');
        await expect(providers).toHaveValue('anthropic'); await expect(providers.locator('option[value="anthropic"]')).toContainText('previously listed');
        await expect(page.locator('.mm-chips')).toContainText('Previously listed setup choice');
        assert.equal(await page.locator('.mm-chips').textContent().then(text=>text.includes('Available in OpenClaw setup')),false);
        await expect(action('add').first()).toBeDisabled();
      } finally {
        await application.evaluate(()=>{const state=globalThis.__modelManagerFixture;state.providerSetup=structuredClone(state.initialProviderSetup);});
        await refresh(); await providers.selectOption(''); await ready();
      }
    });

    await check('One native setup group matches only its exact advertised provider routes',async()=>{
      const providers=page.getByRole('combobox',{name:'Filter models by provider'});
      try {
        await application.evaluate(()=>globalThis.__modelManagerFixture.catalog.models.push(
          {provider:'ollama',id:'fixture-local',name:'Local setup fixture',available:true},
          {provider:'ollama-cloud',id:'fixture-cloud',name:'Cloud setup fixture',available:true},
          {provider:'ollama-compatible',id:'fixture-unrelated',name:'Unrelated prefix fixture',available:true},
        ));
        await refresh(); await providers.selectOption('local');
        await expect(action('select')).toHaveCount(2);
        assert.deepEqual((await action('select').evaluateAll(nodes=>nodes.map(node=>node.dataset.modelRef))).sort(),['ollama-cloud/fixture-cloud','ollama/fixture-local']);
        await expect(page.locator('[data-models-region="detail"]').getByRole('heading',{name:'Local setup fixture',exact:true})).toBeVisible();
      } finally {
        await application.evaluate(()=>{const state=globalThis.__modelManagerFixture;state.catalog=structuredClone(state.initialCatalog);});
        await refresh(); await providers.selectOption(''); await ready();
      }
    });

    await check('Registration selection and review preserve keyboard focus and require a separate save', async () => {
      await openAdd();
      await dialog().getByLabel('Published model',{exact:true}).selectOption('fixture/model-one');
      await expect(dialog().getByLabel('Published model',{exact:true})).toBeFocused();
      assert.deepEqual(await page.locator('#mm-registration-reasoning option').evaluateAll(nodes=>nodes.map(n=>n.value)),['','medium','high']);
      await page.locator('#mm-registration-reasoning').selectOption('high');
      await action('plan-registration').click();
      await expect(dialog()).toContainText('Review local registration');
      assert.equal(registry().registrations.length,0);
      await expect(dialog()).toContainText('fixture/model-one'); await expect(dialog()).toContainText('high');
      const first=dialog().getByRole('button',{name:'Close model dialog',exact:true}),last=action('register');
      await last.focus(); await page.keyboard.press('Tab'); await expect(first).toBeFocused();
      await first.focus(); await page.keyboard.press('Shift+Tab'); await expect(last).toBeFocused();
      await page.keyboard.press('Escape'); await expect(dialog()).toHaveCount(0); await expect(action('add').first()).toBeFocused();
      assert.equal(registry().registrations.length,0);
    });

    await check('Explicit save records only the reviewed native model/reasoning locally, with private storage and no admission', async () => {
      await openAdd(); await expect(page.locator('#mm-registration-reasoning')).toHaveValue('high');
      await action('plan-registration').click(); await action('register').click(); await expect(dialog()).toHaveCount(0); await ready();
      const stored=registry(); assert.equal(stored.registrations.length,1);
      assert.equal(stored.registrations[0].modelRef,'fixture/model-one'); assert.equal(stored.registrations[0].reasoning,'high');
      assert.equal(fs.statSync(registryPath).mode & 0o777,0o600); assert.equal(fs.statSync(path.dirname(registryPath)).mode & 0o777,0o700);
      assert.equal(fs.readFileSync(registryPath,'utf8').includes('FIXTURE-SECRET-DO-NOT-PUBLISH'),false);
      const view=(await rpc('modelsOverview')).data; assert.equal(view.registry.items[0].qualification,'pending'); assert.equal(view.registry.items[0].admission,'not-approved');
      await expect(page.locator('.mm-chips')).toContainText('Registered'); await expect(page.locator('.mm-chips')).toContainText('Not admitted');
      await expect(page.locator('.mm-metadata').first()).toContainText('high');
    });

    await check('Checks and personal routing remain unavailable with no fabricated results or execution controls', async () => {
      await page.locator('[data-models-action="tab"][data-view="Checks"]').click();
      await expect(action('unavailable-check')).toBeDisabled(); await expect(page.locator('#mm-check-reason')).toContainText('not been enabled');
      await page.locator('[data-models-action="tab"][data-view="Personal routing"]').click();
      await expect(action('unavailable-route')).toBeDisabled(); await expect(page.locator('.mm-phase')).toContainText('Preview-only');
      await page.locator('[data-models-action="tab"][data-view="Catalog"]').click();
    });

    await check('A changed catalog invalidates the exact reviewed registration instead of saving new unreviewed metadata', async () => {
      const before=registry().registrations.length;
      await choose('fixture/nested/model'); await openAdd(); await action('plan-registration').click(); await expect(action('register')).toBeEnabled();
      await application.evaluate(()=>{globalThis.__modelManagerFixture.catalog.models.find(m=>m.id==='nested/model').contextWindow=64000;});
      await action('register').click(); await expect(dialog().locator('[data-mm-error]')).toContainText('inventory changed');
      await expect(action('register')).toBeDisabled(); assert.equal(registry().registrations.length,before);
      await pause(150); assert.equal(registry().registrations.length,before); await closeDialog(); await refresh(); await ready();
    });

    await check('Unavailable and policy-restricted models can be recorded but remain blocked; unknown is not invented availability', async () => {
      await choose('fixture/missing-auth'); await openAdd(); await action('plan-registration').click(); await action('register').click(); await expect(dialog()).toHaveCount(0); await ready();
      const view=(await rpc('modelsOverview')).data;
      assert.equal(view.registry.items.find(item=>item.modelRef==='fixture/missing-auth').status,'blocked');
      await expect(page.locator('.mm-chips')).toContainText('Reference unavailable');
      await choose('fixture/restricted'); await page.getByText('Advertised capabilities and source details',{exact:true}).click();
      await expect(page.locator('[data-models-region="detail"]')).toContainText('Not allowed by the native catalog');
      await choose('other/model-one'); await expect(page.locator('[data-models-region="detail"]')).toContainText('Availability not reported');
      await expect(page.locator('.mm-chips')).toContainText('Not registered');
    });

    await check('Native onboarding uses only the fixed original settings route and preserves the unsaved registration draft', async () => {
      await choose('fixture/model-one'); await openAdd(); await page.locator('#mm-registration-reasoning').selectOption('medium');
      await application.evaluate(()=>{globalThis.__modelManagerFixture.transport.target.controlUiBasePath='/nested/control';});
      const before=(await state()).native.length; await dialog().locator('[data-models-action="onboard"]').click();
      await expect(dialog().locator('[data-mm-error]')).toContainText('Your reference draft is retained');
      assert.deepEqual((await state()).native.slice(before),[{kind:'external',value:'http://127.0.0.1:19999/nested/control/settings/model-setup'}]);
      await expect(page.locator('#mm-registration-reasoning')).toHaveValue('medium');
      assert.equal((await rpc('modelsOnboarding',{url:'https://invalid.example/'})).error.code,'INVALID');
      await closeDialog();
    });

    await check('Failed refresh retains stale records, disables saving and recovers only through a passive reread', async () => {
      const before=registry().registrations.length;
      await setMode('offline'); await refresh();
      await expect(page.locator('[data-models-region="notice"]')).toContainText('stale'); await expect(action('add').first()).toBeDisabled();
      await expect(action('select')).toHaveCount(5); assert.equal(registry().registrations.length,before);
      const view=(await rpc('modelsOverview')).data; assert.equal(view.catalog.stale,true); assert.equal(view.registry.items.every(item=>item.status==='stale'),true);
      await setMode('ready'); await refresh(); await ready();
      assert.equal(registry().registrations.length,before);
      await setMode('unsupported'); const count=(await state()).calls.filter(call=>call.operation==='catalog').length; await refresh();
      await expect(page.locator('[data-models-region="status"]')).toContainText('Catalog unavailable'); await expect(action('add').first()).toBeDisabled();
      assert.equal((await state()).calls.filter(call=>call.operation==='catalog').length,count);
      await setMode('ready'); await refresh(); await ready();
    });

    await check('Disconnect immediately invalidates an open review and a late catalog response cannot restore another view', async () => {
      await openAdd(); await action('plan-registration').click(); await expect(action('register')).toBeEnabled();
      await application.evaluate(()=>globalThis.__modelManagerFixture.publish({kind:'connection',connection:{status:'disconnected',message:'Fixture disconnected.'}}));
      await expect(action('register')).toBeDisabled(); await expect(dialog().locator('[data-mm-error]')).toContainText('connection changed');
      await closeDialog(); await application.evaluate(()=>globalThis.__modelManagerFixture.publish({kind:'connection',connection:{status:'connected',label:'Fixture local'}})); await ready();
      await application.evaluate(()=>{globalThis.__modelManagerFixture.hold=true;}); await action('refresh').click();
      await waitMain(()=>globalThis.__modelManagerFixture.releases.length>0);
      await menu('view:Conversations'); await expect(page.locator('#composer-input')).toHaveValue('Preserve this unsent draft while managing models.');
      await application.evaluate(()=>{const s=globalThis.__modelManagerFixture;s.hold=false;s.releases.splice(0).forEach(resolve=>resolve());});
      await pause(150); assert.equal(await page.locator('#main-region').getAttribute('data-mode'),'conversation');
      await menu('view:Models'); await ready();
    });

    await check('Untrusted IPC frames, unsupported operations and caller-supplied settings are rejected before native effects', async () => {
      const before=(await state()).calls.length;
      const denied=await application.evaluate(async ({BrowserWindow})=>{
        const window=BrowserWindow.getAllWindows()[0];return globalThis.__modelManagerFixture.original({sender:window.webContents,senderFrame:{url:window.webContents.getURL()}},'modelsRegister',{reviewToken:'foreign',registryRevision:0});
      });
      assert.equal(denied.error.code,'DENIED');
      assert.equal((await rpc('modelsDiscover')).error.code,'INVALID');
      assert.equal((await rpc('modelsRefresh',{refresh:true})).error.code,'INVALID');
      assert.equal((await rpc('modelsPlanRegistration',{modelRef:'fixture/model-one',reasoning:'invented'})).error.code,'INVALID');
      assert.equal((await state()).calls.length,before);
      assert.equal((await state()).calls.every(call=>['capabilities','catalog'].includes(call.operation)),true);
      assert.equal(gatewayCalls().some(call=>['chat.send','sessions.patch','config.patch','approval.resolve','agent','tts.speak','models.authStatus'].includes(call.method)),false);
    });

    await check('Models temporarily hides an existing fixture terminal and restores the same terminal and unsent conversation draft', async()=>{
      await menu('view:Conversations'); await expect(page.locator('#composer-input')).toHaveValue('Preserve this unsent draft while managing models.');
      if(await page.locator('#work-panel').isVisible())await page.locator('#close-work').click();
      await page.locator('#toggle-terminal').click(); await page.getByRole('button',{name:'Start terminal',exact:true}).click();
      await expect(page.getByRole('button',{name:'Disconnect terminal',exact:true})).toBeEnabled();
      await expect(page.locator('#terminal-mount .xterm-rows')).toContainText('Fixture terminal');
      const terminalBefore=(await state()).terminal; const opened=terminalBefore.find(call=>call.action==='open'); assert.equal(opened.reply.ok,true);
      const detachCount=terminalBefore.filter(call=>call.action==='detach').length;
      await menu('view:Models'); await ready(); await expect(page.locator('#terminal-mount')).toBeHidden(); await expect(page.locator('#toggle-terminal')).toBeHidden();
      await menu('view:Conversations'); await expect(page.locator('#terminal-mount')).toBeVisible();
      await expect(page.getByRole('button',{name:'Disconnect terminal',exact:true})).toBeEnabled();
      const after=(await state()).terminal; assert.equal(after.filter(call=>call.action==='open').length,1);assert.equal(after.filter(call=>call.action==='detach').length,detachCount);
      assert.equal(after.find(call=>call.action==='open').reply.data.terminalId,opened.reply.data.terminalId);
      await expect(page.locator('#composer-input')).toHaveValue('Preserve this unsent draft while managing models.');
      await page.getByRole('button',{name:'Hide terminal',exact:true}).click();
      // Keep the Work preference enabled while Models hides it; Escape must still close the navigation drawer.
      await page.locator('#toggle-work').click(); await menu('view:Models'); await ready();
    });

    await check('Escape closes the narrow Models navigation drawer even with a hidden Work sidebar preference',async()=>{
      try{
        await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(880,640));
        await page.locator('#toggle-navigation').click(); await expect(page.locator('#navigation')).toHaveClass(/drawer/);
        await page.keyboard.press('Escape'); await expect(page.locator('#navigation')).not.toHaveClass(/drawer/);
        assert.equal(await page.locator('#main-region').getAttribute('data-mode'),'Models');
      }finally{await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1440,1000));}
    });

    await check('Search, model selection and review stay usable at 1440, 1100 and 880 pixels in both themes', async () => {
      await choose('fixture/model-one');
      const source=page.locator('details[data-disclosure="source"]'); if(await source.getAttribute('open')!==null)await source.locator('summary').click();
      const search=page.getByRole('searchbox',{name:'Find a model'}); await search.fill('nested/model'); await expect(search).toBeFocused(); await expect(action('select')).toHaveCount(1); await search.fill('');
      await page.getByRole('combobox',{name:'Filter models by provider'}).selectOption('other'); await expect(action('select')).toHaveCount(1); await page.getByRole('combobox',{name:'Filter models by provider'}).selectOption('');
      await page.emulateMedia({reducedMotion:'reduce'});
      for(const [width,height,theme] of [[1440,1000,'dark'],[1100,800,'light'],[880,640,'light']]){
        try{
          await menu('theme:'+theme); await application.evaluate(({BrowserWindow},{width,height})=>BrowserWindow.getAllWindows()[0].setSize(width,height),{width,height});
          await expect(action('add').first()).toBeEnabled();
          assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
          await page.screenshot({path:path.join(evidence,`models-catalog-${width}-${theme}.png`)});
          await openAdd(); await page.locator('#mm-registration-reasoning').selectOption('medium'); await action('plan-registration').click();
          await action('register').scrollIntoViewIfNeeded(); const box=await action('register').boundingBox(),viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
          assert.ok(box&&box.x>=0&&box.y>=0&&box.x+box.width<=viewport.width+1&&box.y+box.height<=viewport.height+1,'Review action must be reachable inside the window.');
          assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
          await page.screenshot({path:path.join(evidence,`models-review-${width}-${theme}.png`)}); await closeDialog();
        }finally{await closeDialog();await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1440,1000));}
      }
      await menu('theme:dark');
    });

    await check('Personal references survive restart and corrupt current storage recovers a previous snapshot read-only', async () => {
      const expected=registry().registrations.map(row=>row.modelRef+':'+row.reasoning).sort();
      await closeApp(); await launch(); await menu('view:Models'); await ready();
      assert.deepEqual(registry().registrations.map(row=>row.modelRef+':'+row.reasoning).sort(),expected);
      const view=(await rpc('modelsOverview')).data; assert.equal(view.registry.items.length,expected.length);
      await refresh(); // Ensure the previous snapshot contains the current references.
      await closeApp();
      fs.writeFileSync(registryPath,'{fixture-corrupt', {mode:0o600});
      await launch(); await menu('view:Models');
      await expect(page.locator('[data-models-region="notice"]')).toContainText('read-only');
      await expect(action('add').first()).toBeDisabled(); await expect(action('select')).toHaveCount(5);
      const recovered=(await rpc('modelsOverview')).data; assert.equal(recovered.registry.status,'recovered'); assert.equal(recovered.registry.readOnly,true); assert.equal(recovered.registry.items.length,expected.length);
      assert.equal(fs.readFileSync(registryPath,'utf8'),'{fixture-corrupt');
    });

    await check('The entire fixture run made no external requests, provider probes or gateway writes', async()=>{
      assert.deepEqual(errors,[]); assert.deepEqual(network,[]);
      assert.equal(gatewayCalls().some(call=>['chat.send','sessions.patch','config.patch','approval.resolve','agent','tts.speak','models.authStatus'].includes(call.method)),false);
      assert.equal((await state()).calls.every(call=>['capabilities','catalog'].includes(call.operation)),true);
    });

  } catch (error) {
    checks.push({ name: 'Fixture setup', pass: false, error: error.stack || error.message });
    console.error(error.message);
  } finally {
    const native = application ? await state().catch(() => null) : null;
    if(native)launches.push(native);
    await application?.evaluate(() => globalThis.__modelManagerFixture?.releases.splice(0).forEach(resolve => resolve())).catch(() => {});
    await application?.close().catch(() => {});
    fs.writeFileSync(path.join(evidence, 'model-manager-tests.json'), JSON.stringify({ at: new Date().toISOString(), checks, errors, network, native, launches, profile,
      scope: 'Isolated Electron main/service/preload/UI with a raw catalog transport fixture. No real provider, production Gateway, discovery, authentication, benchmark, admission or routing actions.' }, null, 2));
    const passed = checks.filter(check => check.pass).length, failed = checks.filter(check => !check.pass).length;
    console.log(JSON.stringify({ passed, failed, evidence }));
    process.exitCode = failed || errors.length || network.length || !checks.length ? 1 : 0;
  }
})();
