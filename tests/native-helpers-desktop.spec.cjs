'use strict';
const { _electron } = require('./test-support.cjs').playwright;
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), evidence = require('./test-support.cjs').evidenceDirectory('native-helpers');
const profile = fs.mkdtempSync(path.join(evidence, 'fixture-profile-'));
const call = (id, name) => ({ role: 'assistant', timestamp: 1700000000000, __openclaw: { id: 'call-' + id }, content: [{ type: 'toolCall', id, name: 'spawn_agent', arguments: { arguments: JSON.stringify({ task_name: name, message: 'Inspect the sample changes.' }) } }] });
const receipt = (id, name, isError) => ({ role: 'toolResult', timestamp: 1700000001000, __openclaw: { id: 'receipt-' + id }, toolCallId: id, toolName: 'spawn_agent', isError, content: [{ type: 'text', text: JSON.stringify({ task_name: '/root/' + name }) }] });
const parallelCall = { ...call('parallel', 'inspect_parallel_a'), content: [...call('parallel-a', 'inspect_parallel_a').content, ...call('parallel-b', 'inspect_parallel_b').content] };
const report = (id, text) => ({ role: 'assistant', content: text, __openclaw: { id } });
fs.writeFileSync(path.join(profile, 'fixture-questions.json'), JSON.stringify({ 'agent:main:main': { current: [
  report('before-helper', 'I am reviewing the sample changes.'), call('acknowledged', 'inspect_sample'), receipt('acknowledged', 'inspect_sample', false),
  report('after-helper', 'The helper dispatch was acknowledged. Its live status is not exposed.'),
  parallelCall, receipt('parallel-a', 'inspect_parallel_a', false), receipt('parallel-b', 'inspect_parallel_b', false),
  call('failed', 'failed_sample'), receipt('failed', 'failed_sample', true), call('missing', 'unconfirmed_sample'),
  report('claim', 'A claimed helper is working. This sentence is not an execution receipt.'),
] } }));
const env = { ...process.env, OPENCLAW_PLUS_TEST_DATA: profile, OPENCLAW_PLUS_TEST_CLI: path.join(root, 'tests/fixture-gateway.cjs') };
delete env.ELECTRON_RUN_AS_NODE;
const calls = () => fs.existsSync(path.join(profile, 'fixture-calls.jsonl')) ? fs.readFileSync(path.join(profile, 'fixture-calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
(async () => {
  const app = await _electron.launch({ executablePath: path.join(root, 'desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [path.join(root, 'desktop')], env });
  const page = await app.firstWindow(); page.setDefaultTimeout(12000); await page.emulateMedia({ reducedMotion: 'reduce' });
  const checks = [], errors = [], network = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (/^(?:https?|wss?):/.test(request.url())) network.push(request.url()); });
  await app.evaluate(({ ipcMain, BrowserWindow, clipboard, shell }) => {
    BrowserWindow.getAllWindows()[0].setSize(1440, 1000);
    const state = globalThis.__helperFixture = { calls: [], native: [], historyIdentity: 'valid', missingContextField: null, workChanged: false }, original = ipcMain._invokeHandlers.get('gateway:request');
    ipcMain.removeHandler('gateway:request'); ipcMain.handle('gateway:request', async (event, operation, params) => {
      state.calls.push({ operation, params });
      const reply = structuredClone(await original(event, operation, params));
      if (reply.ok && operation === 'overview' && state.missingContextField) for (const row of reply.data.sessions || []) delete row[state.missingContextField];
      if (reply.ok && operation === 'history' && params.key === 'agent:main:main') {
        if (state.historyIdentity === 'missing') delete reply.data.sessionId;
        if (state.historyIdentity === 'mismatch') reply.data.sessionId = 'physical-replacement';
        if (state.historyIdentity === 'changed-error') return { ok: false, error: { code: 'SESSION_CHANGED', message: 'Fixture parent incarnation changed.' } };
      }
      if (reply.ok && operation === 'work' && params.key === 'agent:main:main' && state.workChanged) return { ok: false, error: { code: 'SESSION_CHANGED', message: 'Fixture source work session changed.' } };
      return reply;
    });
    clipboard.writeText = text => state.native.push(['copy', text]); shell.openExternal = async url => state.native.push(['external', url]);
  });
  const check = async (name, fn) => { try { await fn(); checks.push({ name, pass: true }); console.log('PASS', name); } catch (error) { checks.push({ name, pass: false, error: error.message }); await page.screenshot({ path: path.join(evidence, `failure-${checks.length}.png`) }).catch(() => {}); throw error; } };
  const helpers = () => page.locator('#work-content [data-action="helper-dispatch"]');
  const card = id => page.locator(`#work-content [data-action="helper-dispatch"][data-helper-id="helper:${id}"]`);
  const source = (id='acknowledged') => page.locator(`article[data-message-id^="receipt-${id}:"]`);
  const batch = (id='acknowledged') => source(id).locator('xpath=ancestor::details[contains(@class,"tool-batch")]');
  const ready = () => page.waitForFunction(() => document.querySelector('#composer-model') && !document.querySelector('#composer-model').disabled);
  const ipc = () => app.evaluate(() => globalThis.__helperFixture.calls);
  const assertRevealed = async (id='acknowledged',name='inspect_sample') => {
    await page.waitForFunction(id => document.activeElement?.closest('article')?.dataset.messageId.startsWith(`receipt-${id}:`),id);
    assert.equal(await batch(id).getAttribute('open'), ''); assert.equal(await source(id).locator('details').getAttribute('open'), '');
    assert.ok((await source(id).locator('.tool-output').textContent()).includes('/root/'+name));
  };
  const historyMode = mode => app.evaluate((_,mode)=>{globalThis.__helperFixture.historyIdentity=mode;},mode);
  const refreshHistory = () => app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.send('gateway:event',{kind:'history',key:'agent:main:main'}));
  const waitCards = count => page.waitForFunction(count=>document.querySelectorAll('#work-content [data-action="helper-dispatch"]').length===count,count);
  try {
    await page.reload(); await page.getByText('Coordinator is coordinating.', { exact: true }).waitFor(); await ready();
    if (!await page.locator('#work-panel').isVisible()) await page.locator('#toggle-work').click();
    await helpers().first().waitFor();
    await check('Only acknowledged native dispatches create non-live helper cards', async () => {
      assert.equal(await helpers().count(), 3); const acknowledged = card('acknowledged'), text = await acknowledged.textContent();
      assert.match(text, /\/root\/inspect_sample/); assert.match(text, /Dispatch recorded/); assert.match(text, /Session and live status unavailable/); assert.doesNotMatch(text, /Working|Running|Completed/i);
      assert.equal(await acknowledged.getAttribute('href'), null); assert.equal(await acknowledged.getAttribute('data-session'), null); assert.equal(await acknowledged.locator('[data-action="session"]').count(), 0);
      assert.equal(await batch().getAttribute('open'), null);
      if (await page.locator('.source-plan[open]').count()) await page.locator('.source-plan > summary').click();
      await page.locator('#transcript').evaluate(node => node.scrollTo({ top: 0, behavior: 'instant' }));
      const screenshot = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
      fs.writeFileSync(path.join(evidence, 'parent-header-collapsed-tools.png'), Buffer.from(screenshot, 'base64'));
    });
    await check('View dispatch opens the exact receipt and containing batch without replacing the draft', async () => {
      await page.locator('#composer-input').fill('Parent fixture draft.'); const before = (await ipc()).filter(call => call.operation === 'history').length;
      await card('acknowledged').click(); await assertRevealed(); assert.equal(await page.locator('#composer-input').inputValue(), 'Parent fixture draft.');
      assert.equal((await ipc()).filter(call => call.operation === 'history').length, before);
    });
    await check('Tasks from one assistant call article reveal their own distinct receipts', async () => {
      assert.equal(await page.locator('article[data-message-id^="call-parallel:"]').count(),1);
      for (const [id,name] of [['parallel-a','inspect_parallel_a'],['parallel-b','inspect_parallel_b']]) {
        await card(id).click(); await assertRevealed(id,name);
        assert.equal(await page.locator('#composer-input').inputValue(),'Parent fixture draft.');
      }
    });
    await check('Registered delegates still open their exact gateway session while parent helpers remain visible', async () => {
      await page.locator('#work-content [data-action="session"]').first().click(); await page.getByText('Builder exact child history', { exact: true }).waitFor(); await ready();
      const request = (await ipc()).filter(call => call.operation === 'history').at(-1).params;
      assert.deepEqual({ key: request.key, agentId: request.agentId, sessionId: request.sessionId }, { key: 'agent:builder:child', agentId: 'builder', sessionId: 'physical-child' });
      assert.equal(await helpers().count(), 3); assert.match(await page.locator('.work-root').textContent(), /Source context retained/); assert.equal(await page.locator('#composer-input').inputValue(), '');
      await page.locator('#composer-input').fill('Child fixture draft.');
    });
    await check('A parent helper viewed from a child returns to its exact dispatch and keeps Back history', async () => {
      await card('acknowledged').click(); await assertRevealed(); await ready();
      const request = (await ipc()).filter(call => call.operation === 'history').at(-1).params;
      assert.deepEqual({ key: request.key, agentId: request.agentId, sessionId: request.sessionId }, { key: 'agent:main:main', agentId: 'main', sessionId: 'physical-main' });
      assert.equal(await page.locator('#composer-input').inputValue(), 'Parent fixture draft.');
      await page.getByRole('button', { name: 'Back to Builder' }).click(); await page.getByText('Builder exact child history', { exact: true }).waitFor(); assert.equal(await page.locator('#composer-input').inputValue(), 'Child fixture draft.');
      await page.getByRole('button', { name: 'Back to Coordinator' }).click(); await page.getByText('Coordinator is coordinating.', { exact: true }).waitFor(); assert.equal(await page.locator('#composer-input').inputValue(), 'Parent fixture draft.');
    });
    await check('A changed parent work session clears its cached helpers while the child remains selected', async () => {
      await page.locator('#work-content [data-action="session"]').first().click(); await page.getByText('Builder exact child history', { exact: true }).waitFor();
      assert.equal(await helpers().count(),3);
      await app.evaluate(()=>{globalThis.__helperFixture.workChanged=true;});
      await page.locator('#toggle-work').click(); await page.locator('#toggle-work').click(); await waitCards(0);
      await page.locator('#work-content .error-note').filter({hasText:'Fixture source work session changed.'}).waitFor();
      assert.equal(await page.locator('#composer-input').inputValue(),'Child fixture draft.');
      await page.getByText('Builder exact child history',{exact:true}).waitFor();
      await app.evaluate(()=>{globalThis.__helperFixture.workChanged=false;});
      await page.getByRole('button',{name:'Back to Coordinator'}).click(); await waitCards(3);
      assert.equal(await page.locator('#composer-input').inputValue(),'Parent fixture draft.');
    });
    await check('Missing or mismatched history identity and definitive replacement errors invalidate cached parent cards', async () => {
      for (const mode of ['missing','mismatch','changed-error']) {
        assert.equal(await helpers().count(),3);
        await historyMode(mode); await refreshHistory(); await waitCards(0);
        if (mode==='mismatch') await page.locator('#messages .error-note').filter({hasText:'This session identity changed after selection. No replacement conversation was opened.'}).waitFor();
        if (mode==='changed-error') await page.locator('#messages .error-note').filter({hasText:'Fixture parent incarnation changed.'}).waitFor();
        assert.equal(await page.locator('#composer-input').inputValue(),'Parent fixture draft.');
        await historyMode('valid'); await refreshHistory(); await waitCards(3);
      }
    });
    await check('Missing physical or agent identity never creates a helper navigation card', async () => {
      for (const field of ['sessionId','agentId']) {
        await app.evaluate((_,field)=>{globalThis.__helperFixture.missingContextField=field;},field);
        await page.reload(); await page.getByText('I am reviewing the sample changes.',{exact:true}).waitFor();
        if(!await page.locator('#work-panel').isVisible())await page.locator('#toggle-work').click();
        assert.equal(await helpers().count(),0);
        const request=(await ipc()).filter(call=>call.operation==='history').at(-1);
        assert.equal(request.params[field],undefined);
      }
      await app.evaluate(()=>{globalThis.__helperFixture.missingContextField=null;});
      await page.reload(); await page.getByText('I am reviewing the sample changes.',{exact:true}).waitFor(); await waitCards(3);
    });
    await check('Helper inspection creates no synthetic session requests, writes or native side effects', async () => {
      assert.deepEqual(errors, []); assert.deepEqual(network, []); assert.deepEqual(await app.evaluate(() => globalThis.__helperFixture.native), []);
      assert.ok((await ipc()).filter(call => call.operation === 'history').every(call => ['agent:main:main', 'agent:builder:child'].includes(call.params.key)));
      assert.equal((await ipc()).some(call => ['send', 'abort', 'saveSettings', 'resolveApproval'].includes(call.operation)), false);
      assert.equal(calls().some(call => ['chat.send', 'chat.abort', 'sessions.patch', 'config.patch', 'approval.resolve'].includes(call.method)), false);
    });
  } finally {
    fs.writeFileSync(path.join(evidence, 'native-helpers-tests.json'), JSON.stringify({ at: new Date().toISOString(), checks, errors, network, scope: 'Isolated native CLI fixture; successful raw tool receipts only. No production connections or writes.' }, null, 2)); await app.close();
  }
  console.log(JSON.stringify({ passed: checks.filter(check => check.pass).length, failed: checks.filter(check => !check.pass).length }));
})().catch(error => { console.error(error); process.exitCode = 1; });
