'use strict';
const { _electron } = require('./test-support.cjs').playwright;
const { evidenceDirectory } = require('./test-support.cjs');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const evidence = evidenceDirectory('send-stop');
const profile = fs.mkdtempSync(path.join(evidence, 'fixture-profile-'));
const picture = path.join(profile, 'Fixture image.png');
fs.writeFileSync(picture, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64'));
const env = { ...process.env, OPENCLAW_PLUS_TEST_DATA: profile, OPENCLAW_PLUS_TEST_CLI: path.join(root, 'tests/fixture-gateway.cjs') };
delete env.ELECTRON_RUN_AS_NODE;
let runningApp;

(async () => {
  const app = await _electron.launch({ executablePath: path.join(root, 'desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [path.join(root, 'desktop')], env });
  runningApp = app;
  const page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  const checks = [], errors = [], network = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^(?:https?|wss?):/.test(request.url())) network.push(request.url()); });
  await app.evaluate(({ ipcMain, BrowserWindow, dialog, shell, clipboard }, modulePath) => {
    const { normalizeRunStatus } = process.mainModule.require(modulePath);
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(1440, 1000);
    const state = globalThis.__sendStopFixture = {
      mode: 'idle', runId: 'fixture-main-run', reads: 0, activityReads: 0,
      calls: [], native: [], picks: [], holdSend: false, sendReleases: [], holdHistory: false, historyReleases: [], uncertainSend: false
    };
    const original = ipcMain._invokeHandlers.get('gateway:request');
    const send = window.webContents.send.bind(window.webContents);
    state.publish = event => send('gateway:event', event);
    // Keep scenarios deterministic: fixture events, not the host refresh timer, drive observations.
    window.webContents.send = (channel, event, ...rest) => channel === 'gateway:event' ? undefined : send(channel, event, ...rest);
    dialog.showOpenDialog = async () => state.picks.shift() || { canceled: true, filePaths: [] };
    state.status = context => {
      const child = context.agentId === 'builder';
      const mode = child ? 'active' : state.mode;
      const runId = child ? 'fixture-child-run' : state.runId;
      const observedAt = Date.now() - (mode === 'stale' ? 46000 : mode === 'expiring' ? 42000 : 0);
      const info = { key: context.key, agentId: context.agentId, sessionId: context.sessionId, hasActiveRun: mode !== 'idle', activeRunIds: mode === 'idle' ? [] : mode === 'multiple' ? ['unowned-one', 'unowned-two'] : [runId] };
      if (mode === 'unknown') delete info.hasActiveRun;
      return normalizeRunStatus({
        sessionKey: context.key, sessionId: mode === 'replaced' ? 'physical-replacement' : context.sessionId, sessionInfo: info, messages: [],
        ...(!['idle', 'multiple', 'unknown'].includes(mode) ? { inFlightRun: { runId, startedAt: observedAt - 2500, text: '', events: [] } } : {})
      }, { context, observedAt });
    };
    ipcMain.removeHandler('gateway:request');
    ipcMain.handle('gateway:request', async (event, operation, params) => {
      state.calls.push({ operation, params: structuredClone(params) });
      if (operation === 'plan') return { ok: true, data: { card: null } };
      if (operation === 'history' && state.holdHistory) await new Promise(resolve => state.historyReleases.push(resolve));
      if (operation === 'send') {
        if (state.holdSend) await new Promise(resolve => state.sendReleases.push(resolve));
        if (state.uncertainSend) {
          state.uncertainSend = false;
          return { ok: false, error: { code: 'UNCERTAIN', message: 'Fixture receipt unavailable.', uncertain: true } };
        }
      }
      // Native UI boundary only. Exact-run backend validation has separate service tests.
      if (operation === 'abort') {
        state.mode = 'idle';
        return { ok: true, data: { ok: true, aborted: true, runIds: [params.runId] } };
      }
      const result = await original(event, operation, params);
      if (result?.ok && operation === 'send') { state.runId = result.data.runId; state.mode = 'active'; }
      if (result?.ok && ['history', 'activity'].includes(operation)) {
        const context = { key: params.key, agentId: params.agentId, sessionId: params.sessionId };
        result.data.runStatus = state.status(context);
        if (operation === 'history') {
          result.data.hasActiveRun = result.data.runStatus.state === 'active';
          result.data.inFlight = undefined;
          state.reads++;
        } else state.activityReads++;
      }
      return result;
    });
    shell.openExternal = async value => state.native.push(['external', value]);
    shell.showItemInFolder = value => state.native.push(['reveal', value]);
    clipboard.writeText = value => state.native.push(['copy', value]);
  }, path.join(root, 'desktop/shared/run-status.mjs'));

  const button = () => page.locator('#send-message');
  const input = () => page.locator('#composer-input');
  const calls = operation => app.evaluate((_, operation) => globalThis.__sendStopFixture.calls.filter(call => call.operation === operation), operation);
  const update = values => app.evaluate((_, values) => Object.assign(globalThis.__sendStopFixture, values), values);
  const publish = event => app.evaluate((_, event) => globalThis.__sendStopFixture.publish(event), event);
  const waitMain = async predicate => {
    const deadline = Date.now() + 12000;
    while (!await app.evaluate(predicate)) {
      if (Date.now() > deadline) throw new Error('Controlled fixture state did not settle.');
      await page.waitForTimeout(25);
    }
  };
  const ready = () => page.waitForFunction(() => document.querySelector('#composer-model')?.value && !document.querySelector('#composer-model').disabled);
  const refresh = async mode => {
    await update({ mode });
    const before = await app.evaluate(() => globalThis.__sendStopFixture.reads);
    await publish({ kind: 'history', key: 'agent:main:main' });
    const deadline = Date.now() + 12000;
    while (await app.evaluate(() => globalThis.__sendStopFixture.reads) === before) {
      if (Date.now() > deadline) throw new Error('Controlled history refresh did not finish.');
      await page.waitForTimeout(25);
    }
    // History and the open Work panel are independent observations. Update both
    // so a fresh activity snapshot cannot hide a deliberately stale history one.
    if (await page.locator('#work-panel').isVisible()) {
      const activityBefore = await app.evaluate(() => globalThis.__sendStopFixture.activityReads);
      await page.getByRole('button', { name: 'Refresh activity', exact: true }).click();
      while (await app.evaluate(() => globalThis.__sendStopFixture.activityReads) === activityBefore) {
        if (Date.now() > deadline) throw new Error('Controlled activity refresh did not finish.');
        await page.waitForTimeout(25);
      }
    }
    await page.waitForTimeout(60);
  };
  const expectSend = async enabled => {
    await page.waitForFunction(() => document.querySelector('#send-message')?.getAttribute('aria-label') === 'Send message');
    assert.equal(await button().isEnabled(), enabled);
    assert.equal(await button().getAttribute('data-action'), 'send');
  };
  const expectStop = async runId => {
    await page.getByRole('button', { name: 'Stop response', exact: true }).waitFor();
    assert.equal(await button().isEnabled(), true);
    assert.equal(await button().getAttribute('data-action'), 'review-stop');
    assert.equal(await button().getAttribute('data-run'), runId);
    assert.equal(await page.locator('#composer-action button').count(), 1);
  };
  const release = () => app.evaluate(() => {
    const state = globalThis.__sendStopFixture;
    state.holdSend = false; state.holdHistory = false;
    state.sendReleases.splice(0).forEach(resolve => resolve());
    state.historyReleases.splice(0).forEach(resolve => resolve());
  });
  const check = async (name, fn) => {
    try { await fn(); checks.push({ name, pass: true }); console.log('PASS', name); }
    catch (error) { checks.push({ name, pass: false, error: error.message }); console.log('FAIL', name, error.message); await page.screenshot({ path: path.join(evidence, `failure-${checks.length}.png`) }).catch(() => {}); await release(); }
  };
  try {
    await page.reload();
    await page.getByText('Coordinator is coordinating.', { exact: true }).waitFor(); await ready();
    await check('One primary action changes from idle Send to exact Stop, then Send while typing', async () => {
      await expectSend(false);
      await refresh('active'); await expectStop('fixture-main-run');
      await input().fill('A follow-up draft.'); await expectSend(true);
      await input().fill(''); await expectStop('fixture-main-run');
      const before = await calls('abort');
      await input().press('Enter'); await page.waitForTimeout(80);
      assert.deepEqual(await calls('abort'), before);
      assert.equal(await page.getByRole('heading', { name: 'Stop this response?', exact: true }).count(), 0, 'empty Enter must never stop a response');
      await page.screenshot({ path: path.join(evidence, 'stop-active-dark.png') });
    });
    await check('A follow-up sends during active work without aborting or duplicating a pending submission', async () => {
      const beforeSend = (await calls('send')).length, beforeAbort = (await calls('abort')).length;
      await update({ holdSend: true });
      await input().fill('Continue with this additional instruction.'); await button().click();
      await waitMain(() => globalThis.__sendStopFixture.sendReleases.length === 1);
      assert.match(await button().textContent(), /Sending/); assert.equal(await button().isDisabled(), true);
      await input().fill('A newer unsent draft.'); await input().press('Enter');
      assert.equal((await calls('send')).length, beforeSend + 1);
      await release(); await page.waitForFunction(() => document.querySelector('#composer-status')?.textContent.includes('Message accepted'));
      assert.equal(await input().inputValue(), 'A newer unsent draft.'); await expectSend(true);
      assert.equal((await calls('abort')).length, beforeAbort, 'follow-up submission is not an implicit abort');
      const sent = (await calls('send')).at(-1).params;
      assert.equal(sent.message, 'Continue with this additional instruction.');
      await input().fill(''); await expectStop(sent.requestId);
    });
    await check('An accepted started receipt exposes Stop before delayed history and newer idle removes it', async () => {
      await refresh('idle');
      await update({ holdHistory: true });
      await input().fill('An acknowledged response with delayed history.'); await button().click();
      await waitMain(() => globalThis.__sendStopFixture.historyReleases.length > 0);
      const sent = (await calls('send')).at(-1).params;
      await expectStop(sent.requestId);
      assert.equal(await input().inputValue(), '');
      await update({ mode: 'idle' }); await release();
      await page.waitForFunction(() => document.querySelector('#send-message')?.getAttribute('aria-label') === 'Send message');
      await expectSend(false);
    });
    await check('Attachment-only drafts use Send and removing an attachment restores Stop', async () => {
      await refresh('active');
      const runId = await app.evaluate(() => globalThis.__sendStopFixture.runId);
      await app.evaluate((_, picture) => globalThis.__sendStopFixture.picks.push({ canceled: false, filePaths: [picture] }), picture);
      await page.getByRole('button', { name: 'Attach media', exact: true }).click();
      await page.locator('.composer-attachment').waitFor();
      await page.waitForFunction(() => !document.querySelector('#attach-media').disabled);
      assert.equal(await input().inputValue(), ''); await expectSend(true);
      await page.getByRole('button', { name: 'Remove attachment Fixture image.png', exact: true }).click();
      await expectStop(runId);
    });
    await check('Stop still requires explicit review and sends only the selected exact run to abort', async () => {
      const before = (await calls('abort')).length;
      const runId = await button().getAttribute('data-run');
      await button().click();
      await page.getByRole('heading', { name: 'Stop this response?', exact: true }).waitFor();
      assert.equal((await calls('abort')).length, before);
      await page.getByRole('button', { name: 'Keep running', exact: true }).click();
      await expectStop(runId); assert.equal((await calls('abort')).length, before);
      await button().click(); await page.getByRole('button', { name: 'Stop this response', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('[data-action="confirm-stop"]'));
      const aborted = (await calls('abort')).slice(before);
      assert.equal(aborted.length, 1);
      assert.deepEqual(aborted[0].params, { key: 'agent:main:main', agentId: 'main', sessionId: 'physical-main', runId });
      await expectSend(false);
    });
    await check('Unknown, stale, replaced and ambiguous unowned run observations cannot expose Stop', async () => {
      for (const mode of ['unknown', 'stale', 'replaced', 'multiple']) {
        try {
          await refresh(mode); await expectSend(false);
          await input().fill('Draft remains available.'); await expectSend(true);
          await input().fill(''); await expectSend(false);
        } catch (error) { throw new Error(`${mode}: ${error.message}`); }
      }
    });
    await check('Local freshness expiry withdraws Stop without another history request', async () => {
      // Start a new view so a newer observation retained by the previous scenario
      // cannot mask this deliberately old, nearly-expired observation.
      await update({ mode: 'expiring' }); await page.reload();
      await page.getByText('Coordinator is coordinating.', { exact: true }).waitFor(); await ready();
      await expectStop(await app.evaluate(() => globalThis.__sendStopFixture.runId));
      const before = (await calls('history')).length;
      await page.waitForFunction(() => document.querySelector('#send-message')?.getAttribute('aria-label') === 'Send message');
      await expectSend(false);
      assert.equal((await calls('history')).length, before);
    });
    await check('Disconnection disables the primary action and retains a drafted follow-up', async () => {
      await refresh('active');
      await publish({ kind: 'connection', connection: { status: 'disconnected', label: 'Fixture gateway' } });
      await expectSend(false);
      await input().fill('Keep this while disconnected.'); await expectSend(false);
      const before = (await calls('send')).length;
      await input().press('Enter'); assert.equal((await calls('send')).length, before);
      await publish({ kind: 'connection', connection: { status: 'connected', label: 'Fixture gateway' } });
      await ready(); await expectSend(true);
      assert.equal(await input().inputValue(), 'Keep this while disconnected.');
    });
    await check('Child navigation switches the exact Stop target and preserves the parent draft', async () => {
      if (!await page.locator('#work-panel').isVisible()) await page.locator('#toggle-work').click();
      await page.locator('#work-content [data-action="session"]').first().click();
      await page.getByText('Builder exact child history', { exact: true }).waitFor(); await ready();
      await expectStop('fixture-child-run');
      assert.equal(await input().inputValue(), '');
      await button().click();
      assert.match(await page.getByRole('dialog').textContent(), /fixture-child-run/);
      assert.doesNotMatch(await page.getByRole('dialog').textContent(), /fixture-main-run/);
      await page.getByRole('button', { name: 'Keep running', exact: true }).click();
      await page.getByRole('button', { name: 'Back to Coordinator', exact: true }).click();
      await page.getByText('Coordinator is coordinating.', { exact: true }).waitFor(); await ready();
      assert.equal(await input().inputValue(), 'Keep this while disconnected.'); await expectSend(true);
      await input().fill(''); await expectStop(await app.evaluate(() => globalThis.__sendStopFixture.runId));
    });
    await check('Uncertain delivery retains exact-request retry instead of becoming Stop or sending a new draft', async () => {
      await update({ uncertainSend: true });
      await input().fill('Retry this exact fixture request.'); await button().click();
      await page.getByRole('button', { name: 'Retry the same message request', exact: true }).waitFor();
      await input().fill('Later instruction stays in the composer.');
      assert.equal(await button().getAttribute('aria-label'), 'Retry the same message request');
      await button().click();
      await page.waitForFunction(() => document.querySelector('#composer-status')?.textContent.includes('Message accepted'));
      const sends = (await calls('send')).slice(-2);
      assert.deepEqual(sends[0].params, sends[1].params);
      assert.equal(await input().inputValue(), 'Later instruction stays in the composer.'); await expectSend(true);
      await input().fill(''); await expectStop(sends[1].params.requestId);
    });
    await check('Minimum-width light layout keeps the single primary action reachable without external effects', async () => {
      if (await page.locator('#work-panel').isVisible()) await page.locator('#close-work').click();
      await app.evaluate(({ Menu, BrowserWindow }) => { Menu.getApplicationMenu().getMenuItemById('theme:light').click(); BrowserWindow.getAllWindows()[0].setSize(880, 640); });
      await page.emulateMedia({ reducedMotion: 'reduce' }); await page.waitForTimeout(150);
      for (const locator of [input(), button()]) {
        const box = await locator.boundingBox(), size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width + 1 && box.y + box.height <= size.height + 1);
      }
      assert.equal(await page.locator('#composer-action button').count(), 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: path.join(evidence, 'stop-narrow-light.png') });
      assert.deepEqual(errors, []); assert.deepEqual(network, []);
      assert.deepEqual(await app.evaluate(() => globalThis.__sendStopFixture.native), []);
      assert.equal((await calls('abort')).length, 1, 'only the explicitly confirmed stop may reach the abort boundary');
      assert.equal(await app.evaluate(() => globalThis.__sendStopFixture.calls.some(call => ['setComposer', 'saveSettings', 'resolveApproval'].includes(call.operation))), false);
    });
  } finally {
    await release().catch(() => {});
    fs.writeFileSync(path.join(evidence, 'send-stop-tests.json'), JSON.stringify({ at: new Date().toISOString(), checks, errors, network, profile, scope: 'Isolated native desktop fixture. Sends use the real app service against the fake CLI; run observations and abort acknowledgements are controlled IPC fixtures. No production reads, messages, stops or configuration changes.' }, null, 2));
    await app.close(); runningApp = null;
  }
  console.log(JSON.stringify({ passed: checks.filter(check => check.pass).length, failed: checks.filter(check => !check.pass).length, profile }));
  process.exitCode = checks.some(check => !check.pass) ? 1 : 0;
})().catch(async error => { console.error(error); if (runningApp) await runningApp.close().catch(() => {}); process.exitCode = 1; });
