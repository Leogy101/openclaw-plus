'use strict';
const { _electron } = require('./test-support.cjs').playwright;
const { evidenceDirectory } = require('./test-support.cjs');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), evidence = evidenceDirectory('delegation');
const profile = fs.mkdtempSync(path.join(evidence, 'fixture-profile-'));
const env = { ...process.env, OPENCLAW_PLUS_TEST_DATA: profile, OPENCLAW_PLUS_TEST_CLI: path.join(root, 'tests/fixture-gateway.cjs') };
delete env.ELECTRON_RUN_AS_NODE;
const parent = { key: 'agent:main:main', agentId: 'main', sessionId: 'physical-main' };
const child = { key: 'agent:builder:child', agentId: 'builder', sessionId: 'physical-child' };

(async () => {
  const application = await _electron.launch({ executablePath: path.join(root, 'desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [path.join(root, 'desktop')], env });
  const page = await application.firstWindow(); page.setDefaultTimeout(12000);
  const checks = [], errors = [], network = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^(?:https?|wss?):/.test(request.url())) network.push(request.url()); });
  await application.evaluate(({ ipcMain, BrowserWindow, shell }, root) => {
    const { CliTransport } = process.mainModule.require(root + '/desktop/src/gateway-cli.cjs');
    const state = globalThis.__delegationFixture = { mode: 'normal', received: [], native: [] };
    const window = BrowserWindow.getAllWindows()[0]; window.setSize(1440, 1000);
    const send = window.webContents.send.bind(window.webContents);
    // Isolated scenarios explicitly refresh the Work view; native polling must
    // not change which fixture incarnation a click is testing.
    window.webContents.send = (channel, event, ...rest) => { if (channel !== 'gateway:event') return send(channel, event, ...rest); };
    const request = CliTransport.prototype.request;
    CliTransport.prototype.request = async function (method, params) {
      const result = await request.call(this, method, params);
      if (method === 'sessions.list' && params.spawnedBy === 'agent:main:main') result.sessions.push({
        key: 'agent:researcher:unresolved', agentId: 'researcher', displayName: 'Unresolved delegate', hasActiveRun: true,
      });
      if (state.mode === 'child-replaced' && method === 'chat.history' && params.sessionKey === 'agent:builder:child') {
        result.sessionId = 'physical-child-replacement'; result.sessionInfo.sessionId = result.sessionId;
        result.messages = [{ role: 'assistant', content: 'REPLACEMENT CONTENT MUST NOT OPEN' }];
      }
      if (state.mode === 'parent-replaced' && method === 'sessions.describe' && params.key === 'agent:main:main') result.session.sessionId = 'physical-parent-replacement';
      return result;
    };
    const handler = ipcMain._invokeHandlers.get('gateway:request');
    ipcMain.removeHandler('gateway:request');
    ipcMain.handle('gateway:request', async (event, operation, params) => {
      const record = { operation, params: structuredClone(params) }; state.received.push(record);
      const result = await handler(event, operation, params);
      record.ok = result?.ok; record.errorCode = result?.error?.code;
      return result;
    });
    shell.openExternal = async value => { state.native.push(value); throw new Error('External opens are forbidden in this fixture'); };
  }, root);
  const received = () => application.evaluate(() => globalThis.__delegationFixture.received);
  const check = async (name, run) => {
    try { await run(); checks.push({ name, pass: true }); console.log('PASS', name); }
    catch (error) { checks.push({ name, pass: false, error: error.message }); await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {}); throw error; }
  };
  try {
    // Install the fixture projection before a fresh backend read, independent
    // of whether the initial window finished loading before instrumentation.
    await page.getByText('Coordinator is coordinating.', { exact: true }).waitFor();
    await page.locator('#connection-notice [data-action="reconnect"]').click();
    await page.locator('#work-content .work-link[aria-disabled="true"]').waitFor();
    await check('An active delegate appears with its agent and status while its parent has no direct active run', async () => {
      await page.getByText('Coordinator is coordinating.', { exact: true }).waitFor();
      if (!await page.locator('#work-panel').isVisible()) await page.locator('#toggle-work').click();
      const row = page.locator('#work-content .work-link[data-action="session"]');
      await row.waitFor();
      assert.equal(await row.count(), 1);
      assert.equal(await row.locator('.work-title').textContent(), 'Verify changes');
      assert.equal(await row.locator('.work-ident').textContent(), 'Builder');
      assert.equal(await row.locator('.work-state').textContent(), 'Running');
      assert.deepEqual(JSON.parse(await row.getAttribute('data-identity')), [child.agentId, child.key, child.sessionId]);
      assert.equal(await page.locator('#work-content').getByText('Other Builder session', { exact: true }).count(), 0);
      const history = await page.evaluate(context => window.openclawPlusDesktop.gateway('history', context), parent);
      assert.equal(history.data.hasActiveRun, false, 'idle direct parent must not suppress an active delegate');
      await page.screenshot({ path: path.join(evidence, 'delegated-session-visible.png') });
    });
    await check('A related row without physical identity remains visible but cannot open an unpinned conversation', async () => {
      const unavailable = page.locator('#work-content .work-link[aria-disabled="true"]');
      await unavailable.waitFor();
      assert.match(await unavailable.textContent(), /Unresolved delegate.*Exact session unavailable.*Researcher/s);
      assert.equal(await unavailable.locator('[data-action="session"]').count(), 0);
      assert.equal(await unavailable.getAttribute('data-action'), null);
    });
    await check('Clicking the delegated agent opens its exact child session rather than another session for that agent', async () => {
      await page.locator('#composer-input').fill('Parent draft remains here.');
      await page.locator('#work-content .work-link[data-action="session"]').click();
      await page.getByText('Builder exact child history', { exact: true }).waitFor();
      assert.equal(await page.locator('#page-title').textContent(), 'Verify changes');
      const request = (await received()).filter(item => item.operation === 'history').at(-1);
      assert.deepEqual(request.params, { ...child, offset: 0 }); assert.equal(request.ok, true);
      assert.equal(await page.locator('#composer-input').inputValue(), '');
      assert.match(await page.locator('#work-content .work-root').textContent(), /Coordinator.*Source context retained/s);
    });
    await check('Back restores the exact parent conversation and its draft', async () => {
      await page.getByRole('button', { name: 'Back to Coordinator', exact: true }).click();
      await page.getByText('Coordinator is coordinating.', { exact: true }).waitFor();
      assert.equal(await page.locator('#composer-input').inputValue(), 'Parent draft remains here.');
      const request = (await received()).filter(item => item.operation === 'history').at(-1);
      assert.deepEqual(request.params, { ...parent, offset: 0 });
    });
    await check('A stale child click rejects a replaced physical session without displaying replacement content', async () => {
      await application.evaluate(() => { globalThis.__delegationFixture.mode = 'child-replaced'; });
      // Expire the documented 2.5-second history cache from the earlier click.
      await page.waitForTimeout(2600);
      await page.locator('#work-content .work-link[data-action="session"]').click();
      await page.locator('#messages .error-note').filter({ hasText: 'This session changed or its retained history is no longer available.' }).waitFor();
      const request = (await received()).filter(item => item.operation === 'history').at(-1);
      assert.deepEqual(request.params, { ...child, offset: 0 }); assert.equal(request.errorCode, 'SESSION_CHANGED');
      assert.equal(await page.getByText('REPLACEMENT CONTENT MUST NOT OPEN', { exact: true }).count(), 0);
      await page.getByRole('button', { name: 'Back to Coordinator', exact: true }).click();
      await page.getByText('Coordinator is coordinating.', { exact: true }).waitFor();
    });
    await check('Parent replacement clears stale delegated rows instead of presenting them under the retained parent', async () => {
      await application.evaluate(() => { globalThis.__delegationFixture.mode = 'parent-replaced'; });
      await page.locator('#toggle-work').click(); await page.locator('#toggle-work').click();
      await page.locator('#work-content .error-note').filter({ hasText: 'This conversation changed or is no longer accessible.' }).waitFor();
      assert.equal(await page.locator('#work-content [data-action="session"]').count(), 0);
      assert.equal((await received()).filter(item => item.operation === 'work').at(-1).errorCode, 'SESSION_CHANGED');
    });
    await check('Delegation qualification makes no mutations, external network requests or native opens', async () => {
      assert.deepEqual(errors, []); assert.deepEqual(network, []);
      assert.deepEqual(await application.evaluate(() => globalThis.__delegationFixture.native), []);
      const calls = fs.readFileSync(path.join(profile, 'fixture-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.ok(!calls.some(call => ['chat.send', 'chat.abort', 'sessions.patch', 'config.patch', 'approval.resolve'].includes(call.method)));
    });
  } finally {
    fs.writeFileSync(path.join(evidence, 'delegation-tests.json'), JSON.stringify({ at: new Date().toISOString(), checks, errors, network,
      scope: 'Native Electron and actual gateway-service path using fixture-only CLI responses; no production gateway or mutations.' }, null, 2));
    await application.close();
    console.log('Evidence:', evidence);
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
