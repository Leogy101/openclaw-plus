'use strict';
const { _electron } = require('./test-support.cjs').playwright;
const { evidenceDirectory } = require('./test-support.cjs');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const evidence = evidenceDirectory('run-status');
const profile = fs.mkdtempSync(path.join(evidence, 'fixture-profile-'));
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
  await app.evaluate(({ ipcMain, BrowserWindow, shell, clipboard }, modulePath) => {
    const { normalizeRunStatus } = process.mainModule.require(modulePath);
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(1440, 1000);
    const state = globalThis.__runStatusFixture = { mode: 'zero', occurrence: 1, startedAt: Date.now() - 2500, calls: [], native: [], reads: 0, activityReads: 0 };
    const original = ipcMain._invokeHandlers.get('gateway:request');
    const send = window.webContents.send.bind(window.webContents);
    state.publish = event => send('gateway:event', event);
    // Poll timing is controlled by this fixture; the real host monitor cannot race a scenario change.
    window.webContents.send = (channel, event, ...rest) => {
      if (channel === 'gateway:event') return;
      return send(channel, event, ...rest);
    };
    state.status = context => {
      const observedAt = Date.now() - (state.mode === 'stale' ? 46000 : state.mode === 'expiring' ? 44500 : 0);
      const child = context.agentId === 'builder';
      const idle = state.mode === 'idle' || child;
      const runId = `run-status-${context.agentId}-${state.occurrence}`;
      const identity = { key: context.key, agentId: context.agentId, sessionId: context.sessionId, lifecycleRevision: 'lifecycle-' + context.sessionId };
      const info = { ...identity, hasActiveRun: !idle, ...(idle ? { activeRunIds: [] } : {}) };
      const events = [];
      if (state.mode !== 'unavailable') events.push({ runId, seq: 1, stream: 'usage', data: { outputTokens: state.mode === 'zero' ? 0 : 2500, ...(state.mode === 'explicit-unavailable' ? { usageReport: { state: 'unavailable' } } : {}) }, ts: observedAt });
      if (state.mode === 'tool') events.push({ runId, seq: 2, stream: 'tool', data: { phase: 'start', name: 'exec', toolCallId: 'fixture-tool', title: '<img src=x onerror=window.runStatusIntruded=true>', args: { command: 'printf "<img src=x onerror=window.runStatusIntruded=true>"' } }, ts: observedAt });
      const raw = {
        sessionKey: context.key, sessionId: state.mode === 'wrong-session' ? 'physical-unrelated' : context.sessionId,
        sessionInfo: info, messages: [],
        ...(!idle ? { inFlightRun: { runId, startedAt: ['stale', 'expiring'].includes(state.mode) ? observedAt - 2500 : state.startedAt, text: '', events } } : {})
      };
      if (state.mode === 'wrong-run') info.activeRunIds = ['other-active-run'];
      return normalizeRunStatus(raw, { context, observedAt });
    };
    ipcMain.removeHandler('gateway:request');
    ipcMain.handle('gateway:request', async (event, operation, params) => {
      state.calls.push({ operation, params: structuredClone(params) });
      if (operation === 'plan') return { ok: true, data: { card: null } };
      const result = await original(event, operation, params);
      if (result?.ok && (operation === 'history' || operation === 'activity')) {
        const context = { key: params.key, agentId: params.agentId, sessionId: params.sessionId };
        result.data.runStatus = state.status(context);
        if (operation === 'history') {
          result.data.hasActiveRun = !['idle', 'wrong-session', 'wrong-run'].includes(state.mode) && context.agentId !== 'builder';
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
  const status = () => page.locator('#run-status');
  const bar = () => status().locator('.run-status-bar');
  const phase = () => status().locator('.run-status-phase');
  const tokens = () => status().locator('[data-run-metric="tokens"]');
  const elapsed = () => status().locator('[data-run-metric="elapsed"]');
  const menu = id => app.evaluate(({ Menu }, id) => Menu.getApplicationMenu().getMenuItemById(id).click(), id);
  const mode = (value, reset = false) => app.evaluate((_, { value, reset }) => { const state = globalThis.__runStatusFixture; state.mode = value; if (reset) { state.occurrence++; state.startedAt = Date.now(); } }, { value, reset });
  const publish = event => app.evaluate((_, event) => globalThis.__runStatusFixture.publish(event), event);
  const refresh = async () => {
    const before = await app.evaluate(() => globalThis.__runStatusFixture.reads);
    await publish({ kind: 'history', key: 'agent:main:main' });
    await page.waitForFunction(() => !document.querySelector('#composer-input')?.disabled);
    const deadline = Date.now() + 12000;
    while (await app.evaluate(() => globalThis.__runStatusFixture.reads) === before) {
      if (Date.now() > deadline) throw new Error('Controlled history refresh did not finish.');
      await page.waitForTimeout(30);
    }
    await page.waitForTimeout(60);
  };
  const refreshActivity = async () => {
    if (!await page.locator('#work-panel').isVisible()) await page.locator('#toggle-work').click();
    const before = await app.evaluate(() => globalThis.__runStatusFixture.activityReads);
    await page.getByRole('button', { name: 'Refresh activity', exact: true }).click();
    const deadline = Date.now() + 12000;
    while (await app.evaluate(() => globalThis.__runStatusFixture.activityReads) === before) {
      if (Date.now() > deadline) throw new Error('Explicit activity refresh did not finish.');
      await page.waitForTimeout(30);
    }
    await page.waitForTimeout(60);
  };
  const expectActive = async () => {
    await page.waitForFunction(() => document.querySelector('#run-status .run-status-phase')?.textContent === 'Active');
    assert.equal(await bar().getAttribute('data-stale'), 'false');
  };
  const check = async (name, fn) => {
    try { await fn(); checks.push({ name, pass: true }); console.log('PASS', name); }
    catch (error) { checks.push({ name, pass: false, error: error.message }); console.log('FAIL', name, error.message); await page.screenshot({ path: path.join(evidence, `failure-${checks.length}.png`) }).catch(() => {}); }
  };
  try {
    await page.reload();
    await page.getByText('Coordinator is coordinating.', { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('#composer-model')?.value);
    await check('Empty-text native run shows Active, a real zero token count and elapsed time above the composer', async () => {
      await expectActive();
      assert.equal(await page.locator('#activity-header [data-activity-state="active"]').count(), 1, 'fresh response proof updates the header without waiting for an unrelated refresh');
      assert.match(await tokens().textContent(), /^0 output tokens$/);
      assert.match(await elapsed().textContent(), /\d/);
      assert.equal(await bar().getAttribute('data-run-id'), 'run-status-main-1');
      assert.equal(await page.locator('[data-message-id^="live:"]').count(), 0);
      assert.equal(await status().evaluate(node => node.previousElementSibling?.id), 'plan-region');
      const position = await status().boundingBox(), composer = await page.locator('.composer').boundingBox();
      assert.ok(position.y + position.height <= composer.y + 1, 'the run indicator belongs between plan and composer');
      await page.screenshot({ path: path.join(evidence, 'run-status-active-dark.png') });
    });
    await check('Reported token counts update, while missing usage stays unavailable without an estimate', async () => {
      await mode('tokens'); await refresh(); await expectActive();
      assert.match(await tokens().textContent(), /^2[.,]5K output tokens$/);
      assert.match(await tokens().getAttribute('title'), /^2[,.]?500 output tokens reported by OpenClaw$/);
      for (const scenario of ['unavailable', 'explicit-unavailable']) {
        await mode(scenario); await refresh();
        assert.equal(await tokens().textContent(), 'Tokens unavailable');
        assert.doesNotMatch(await status().textContent(), /2[,.]?500|2[.,]5K|0 output tokens|estimated|tokens\/s/i);
      }
    });
    await check('Run refreshes and local elapsed ticks preserve composer selection and stable transcript nodes', async () => {
      await mode('tokens'); await refresh();
      await page.locator('#composer-input').fill('Preserve my unfinished message and its selection.');
      await page.locator('#composer-input').evaluate(node => { node.focus(); node.setSelectionRange(9, 22); window.__runStatusComposer = node; window.__runStatusArticle = document.querySelector('[data-message-id^="a1:"]'); });
      assert.equal(await page.evaluate(() => Boolean(window.__runStatusArticle)), true, 'the retained assistant article must exist');
      await refresh();
      const readCount = await app.evaluate(() => globalThis.__runStatusFixture.calls.filter(call => call.operation === 'history').length);
      await page.waitForTimeout(1200);
      assert.deepEqual(await page.locator('#composer-input').evaluate(node => ({ value: node.value, start: node.selectionStart, end: node.selectionEnd, same: node === window.__runStatusComposer, focused: node === document.activeElement })), { value: 'Preserve my unfinished message and its selection.', start: 9, end: 22, same: true, focused: true });
      assert.equal(await page.evaluate(() => document.querySelector('[data-message-id^="a1:"]') === window.__runStatusArticle), true);
      assert.equal(await app.evaluate(() => globalThis.__runStatusFixture.calls.filter(call => call.operation === 'history').length), readCount, 'elapsed display updates do not fetch history');
    });
    await check('Unrelated physical-session and conflicting run identities cannot lend their tokens or Active state', async () => {
      for (const scenario of ['wrong-session', 'wrong-run']) {
        await mode(scenario); await refresh();
        assert.notEqual(await phase().textContent(), 'Active');
        assert.doesNotMatch(await status().textContent(), /(?:2[,.]?500|2[.,]5K) output tokens/);
      }
      await mode('tokens'); await refresh(); await expectActive();
    });
    await check('Selecting a child clears the parent run and Back restores the exact parent draft', async () => {
      if (!await page.locator('#work-panel').isVisible()) await page.locator('#toggle-work').click();
      await page.locator('#work-content [data-action="session"]').first().click();
      await page.getByText('Builder exact child history', { exact: true }).waitFor();
      assert.equal(await status().locator('[data-run-id="run-status-main-1"]').count(), 0);
      assert.equal(await bar().count(), 0, 'quiet child history has no active parent footer');
      await page.getByRole('button', { name: 'Back to Coordinator' }).click();
      await page.getByText('Coordinator is coordinating.', { exact: true }).waitFor(); await expectActive();
      assert.equal(await page.locator('#composer-input').inputValue(), 'Preserve my unfinished message and its selection.');
    });
    await check('Completion removes active presentation and the next occurrence starts a fresh elapsed counter', async () => {
      await mode('idle'); await refresh();
      assert.equal(await bar().count(), 0);
      assert.equal(await status().locator('.is-active').count(), 0);
      await mode('zero', true); await refresh(); await expectActive();
      assert.equal(await bar().getAttribute('data-run-id'), 'run-status-main-2');
      assert.match(await tokens().textContent(), /^0 output tokens$/);
      assert.match(await elapsed().textContent(), /^(?:0[.:]0[0-3]|[0-3]s)(?: elapsed)?$/);
    });
    await check('Expiry and disconnection stop live presentation and freeze observed elapsed time', async () => {
      await mode('expiring'); await refreshActivity(); await refresh();
      await page.waitForFunction(() => document.querySelector('#run-status .run-status-phase')?.textContent === 'Status stale');
      assert.equal(await bar().getAttribute('data-stale'), 'true');
      const staleElapsed = await elapsed().textContent();
      await page.waitForTimeout(1100); assert.equal(await elapsed().textContent(), staleElapsed);
      await mode('tokens'); await refresh(); await expectActive();
      await publish({ kind: 'connection', connection: { status: 'disconnected', label: 'Fixture gateway', message: 'Fixture disconnected' } });
      await page.waitForFunction(() => document.querySelector('#run-status .run-status-phase')?.textContent === 'Disconnected');
      const disconnectedElapsed = await elapsed().textContent();
      await page.waitForTimeout(1100); assert.equal(await elapsed().textContent(), disconnectedElapsed);
      assert.equal(await bar().getAttribute('data-stale'), 'true');
      await publish({ kind: 'connection', connection: { status: 'connected', label: 'Fixture gateway' } });
      await expectActive();
    });
    await check('Older transcript reading keeps live status updates without replacing the retained page', async () => {
      await page.getByRole('button', { name: 'Load earlier messages', exact: true }).click();
      await page.getByText('Earlier fixture message', { exact: true }).waitFor();
      await mode('unavailable');
      await refreshActivity();
      await page.waitForFunction(() => document.querySelector('#run-status [data-run-metric="tokens"]')?.textContent === 'Tokens unavailable');
      assert.ok(await page.getByText('Earlier fixture message', { exact: true }).isVisible());
      assert.equal(await page.locator('#composer-input').inputValue(), 'Preserve my unfinished message and its selection.');
    });
    await check('Tool details remain literal and narrow reduced-motion layout keeps status and composer reachable', async () => {
      await mode('tool');
      await refreshActivity();
      await status().locator('.run-current-tool').waitFor();
      await status().locator('.run-current-tool summary').click();
      assert.match(await status().textContent(), /<img src=x onerror=window\.runStatusIntruded=true>/);
      assert.equal(await status().locator('img,script,a').count(), 0);
      assert.equal(await page.evaluate(() => window.runStatusIntruded), undefined);
      await status().locator('.run-current-tool summary').click();
      if (await page.locator('#work-panel').isVisible()) await page.locator('#toggle-work').click();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await menu('theme:light');
      try {
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(880, 640));
        await page.waitForTimeout(120);
        for (const locator of [status(), page.locator('#composer-input'), page.locator('#send-message')]) {
          const box = await locator.boundingBox(), size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
          assert.ok(box && box.width > 0 && box.height > 0 && box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width + 1 && box.y + box.height <= size.height + 1, 'run status and composer controls must fit the minimum window');
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.equal(await status().evaluate(node => node.getAnimations({ subtree: true }).some(animation => animation.playState === 'running')), false);
        await page.screenshot({ path: path.join(evidence, 'run-status-narrow-light.png') });
      } finally { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000)); }
      assert.deepEqual(errors, []); assert.deepEqual(network, []);
      assert.deepEqual(await app.evaluate(() => globalThis.__runStatusFixture.native), []);
      assert.equal(await app.evaluate(() => globalThis.__runStatusFixture.calls.some(call => ['send', 'abort', 'saveSettings', 'resolveApproval'].includes(call.operation))), false);
    });
  } finally {
    fs.writeFileSync(path.join(evidence, 'run-status-tests.json'), JSON.stringify({ at: new Date().toISOString(), checks, errors, network, profile, scope: 'Isolated native fixture using the real raw-history status normalizer and renderer. No production calls, sends or terminal commands.' }, null, 2));
    await app.close();
    runningApp = null;
  }
  console.log(JSON.stringify({ passed: checks.filter(check => check.pass).length, failed: checks.filter(check => !check.pass).length, profile }));
  process.exitCode = checks.some(check => !check.pass) ? 1 : 0;
})().catch(async error => {
  console.error(error);
  if (runningApp) await runningApp.close().catch(() => {});
  process.exitCode = 1;
});
