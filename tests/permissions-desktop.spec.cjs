'use strict';
const { _electron } = require('./test-support.cjs').playwright;
const { evidenceDirectory } = require('./test-support.cjs');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), evidence = evidenceDirectory('permissions');
const profile = fs.mkdtempSync(path.join(evidence, 'fixture-profile-'));
fs.writeFileSync(path.join(profile, 'fixture-permissions.json'), '{}');
const env = { ...process.env, OPENCLAW_PLUS_TEST_DATA: profile, OPENCLAW_PLUS_TEST_CLI: path.join(root, 'tests/fixture-gateway.cjs') };
delete env.ELECTRON_RUN_AS_NODE;
const selected = { key: 'agent:main:main', agentId: 'main', sessionId: 'physical-main' };
const calls = () => fs.existsSync(path.join(profile, 'fixture-calls.jsonl')) ? fs.readFileSync(path.join(profile, 'fixture-calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const writes = () => calls().filter(call => call.method === 'sessions.patch' && Object.hasOwn(call.params, 'permissionMode'));
function fixtureState(update) {
  const file = path.join(profile, 'fixture-state.json');
  const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { sent: [], approvalStatus: 'pending', configHash: 'fixture-hash', config: {}, planRevision: 1 };
  update(state); fs.writeFileSync(file + '.tmp', JSON.stringify(state)); fs.renameSync(file + '.tmp', file);
}
let runningApp;
(async () => {
  const app = await _electron.launch({ executablePath: path.join(root, 'desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [path.join(root, 'desktop')], env });
  runningApp = app;
  const page = await app.firstWindow(); page.setDefaultTimeout(12000);
  const checks = [], errors = [], network = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (/^(?:https?|wss?|file):/.test(request.url())) network.push(request.url()); });
  await app.evaluate(({ ipcMain, BrowserWindow, shell, clipboard }) => {
    const window = BrowserWindow.getAllWindows()[0]; window.setSize(1440, 1000);
    const state = globalThis.__permissionFixture = { calls: [], hold: false, releases: [], uncertain: false, native: [] };
    const original = ipcMain._invokeHandlers.get('gateway:request'), send = window.webContents.send.bind(window.webContents);
    state.original = original; state.publish = event => send('gateway:event', event);
    window.webContents.send = (channel, event, ...rest) => { if (channel === 'gateway:event') return; return send(channel, event, ...rest); };
    ipcMain.removeHandler('gateway:request'); ipcMain.handle('gateway:request', async (event, operation, params) => {
      state.calls.push({ operation, params: structuredClone(params) });
      if (operation === 'plan') return { ok: true, data: { card: null } };
      if (operation === 'setPermissions' && state.hold) await new Promise(resolve => state.releases.push(resolve));
      const result = await original(event, operation, params);
      if (operation === 'setPermissions' && result?.ok && state.uncertain) { state.uncertain = false; return { ok: false, error: { code: 'UNCERTAIN', uncertain: true, message: 'Fixture saved the mode but its confirmation was lost.' } }; }
      return result;
    });
    shell.openExternal = async value => state.native.push(['external', value]); shell.openPath = async value => state.native.push(['open', value]);
    shell.showItemInFolder = value => state.native.push(['reveal', value]); clipboard.writeText = value => state.native.push(['copy', value]);
  });
  const dialog = () => page.getByRole('dialog', { name: 'Execution permissions', exact: true });
  const radio = value => dialog().locator(`input[name="permission-mode"][value="${value}"]`);
  const apply = () => dialog().getByRole('button', { name: 'Apply permissions', exact: true });
  const refresh = async () => { await dialog().getByRole('button', { name: 'Refresh permissions', exact: true }).click(); await page.waitForFunction(() => document.querySelector('#permission-status') && !document.querySelector('#permission-status').textContent.includes('Reading this exact')); };
  const open = async () => { await page.getByRole('button', { name: 'Execution permissions', exact: true }).click(); await dialog().locator('input[name="permission-mode"]').first().waitFor(); };
  const close = () => dialog().getByRole('button', { name: 'Close', exact: true }).click();
  const current = async label => { await page.waitForFunction(label => document.querySelector('.permission-current')?.textContent === 'Current: ' + label, label); };
  const waitMain = async predicate => { const deadline = Date.now() + 12000; while (!await app.evaluate(predicate)) { if (Date.now() > deadline) throw new Error('Permission fixture wait timed out.'); await page.waitForTimeout(25); } };
  const check = async (name, fn) => { try { await fn(); checks.push({ name, pass: true }); console.log('PASS', name); } catch (error) { checks.push({ name, pass: false, error: error.message }); console.log('FAIL', name, error.message); await page.screenshot({ path: path.join(evidence, `failure-${checks.length}.png`) }).catch(() => {}); } };
  try {
    await page.reload(); await page.getByText('Coordinator is coordinating.', { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('#composer-model')?.value);
    await page.locator('#composer-input').fill('Keep this unsent draft while I review permissions.');
    await check('Permissions control is beside Attach and opening Default only reads the selected session', async () => {
      assert.equal(await page.locator('#composer-permissions').evaluate(node => node.previousElementSibling?.id), 'attach-media');
      assert.equal(writes().length, 0); await open(); await current('Default');
      assert.equal(await dialog().locator('input[name="permission-mode"]').count(), 5); assert.equal(await radio('default').isChecked(), true);
      assert.match(await dialog().textContent(), /not a guarantee of restrictions/); assert.equal(await apply().isDisabled(), true);
      assert.equal(writes().length, 0);
    });
    await check('Full access requires deliberate selection, unchecked acknowledgement and explicit Apply with null CAS', async () => {
      const before = writes().length; await radio('full').check();
      const acknowledgement = dialog().getByRole('checkbox', { name: 'I understand Full access grants broad execution access', exact: true });
      assert.equal(await acknowledgement.isChecked(), false); assert.equal(await apply().isDisabled(), true); assert.equal(writes().length, before);
      await acknowledgement.check(); assert.equal(await apply().isEnabled(), true); assert.equal(writes().length, before);
      await apply().click(); await current('Full access');
      await page.waitForFunction(() => document.querySelector('#permission-status')?.textContent === 'Session permissions updated.');
      assert.equal(writes().length, before + 1); assert.deepEqual(writes().at(-1).params, { key: selected.key, agentId: 'main', expectedSessionId: selected.sessionId, expectedLifecycleRevision: 'fixture-lifecycle-physical-main', expectedPermissionMode: null, permissionMode: 'full' });
      assert.equal(await apply().isDisabled(), true); await close();
      assert.equal(await page.locator('#composer-input').inputValue(), 'Keep this unsent draft while I review permissions.');
    });
    await check('Default explicitly clears the session override rather than saving a guessed restrictive mode', async () => {
      await open(); await current('Full access'); const before = writes().length;
      await radio('default').check(); assert.match(await dialog().textContent(), /Default inherits your OpenClaw configuration/); assert.equal(writes().length, before);
      await apply().click(); await current('Default'); assert.equal(writes().length, before + 1);
      assert.equal(writes().at(-1).params.expectedPermissionMode, 'full'); assert.equal(writes().at(-1).params.permissionMode, null); await close();
    });
    await check('Native pending status disables changes and an explicit refresh reconciles it without writing', async () => {
      fixtureState(state => { state.permissionPending = { [selected.key]: true }; });
      await open(); await page.waitForFunction(() => document.querySelector('#permission-status')?.textContent.includes('still applying'));
      assert.equal(await radio('full').isDisabled(), true); assert.equal(await apply().isDisabled(), true);
      assert.equal(await dialog().getByRole('button', { name: 'Refresh permissions', exact: true }).isEnabled(), true);
      const before = writes().length; fixtureState(state => { state.permissionPending = {}; }); await refresh();
      assert.equal(await radio('full').isEnabled(), true); assert.equal(writes().length, before); await close();
    });
    await check('A changed permission snapshot is rejected before patch and must be explicitly refreshed', async () => {
      await open(); await current('Default'); await radio('workspace').check(); const before = writes().length;
      fixtureState(state => { state.permissionModes[selected.key] = 'guarded'; });
      await apply().click(); await page.waitForFunction(() => document.querySelector('#permission-status')?.textContent.includes('Refresh permissions'));
      assert.equal(writes().length, before); assert.equal(await apply().isDisabled(), true);
      await refresh(); await current('Guarded'); assert.equal(await radio('guarded').isChecked(), true); await close();
    });
    await check('Pending Apply cannot submit twice and an uncertain saved result needs refresh without automatic retry', async () => {
      await open(); await radio('workspace').check(); const before = writes().length;
      await app.evaluate(() => { const s = globalThis.__permissionFixture; s.hold = true; s.uncertain = true; });
      await apply().click(); await waitMain(() => globalThis.__permissionFixture.releases.length === 1);
      assert.equal(await radio('full').isDisabled(), true); assert.equal(await dialog().getByRole('button', { name: 'Applying…', exact: true }).isDisabled(), true);
      await app.evaluate(() => { const s = globalThis.__permissionFixture; s.hold = false; s.releases.splice(0).forEach(resolve => resolve()); });
      await page.waitForFunction(() => document.querySelector('#permission-status')?.textContent.includes('outcome is unconfirmed'));
      assert.equal(writes().length, before + 1); assert.equal(await apply().isDisabled(), true);
      await page.waitForTimeout(200); assert.equal(writes().length, before + 1);
      await refresh(); await current('Workspace'); assert.equal(writes().length, before + 1); assert.equal(await radio('workspace').isChecked(), true);
      await close(); assert.equal(await page.locator('#composer-input').inputValue(), 'Keep this unsent draft while I review permissions.');
    });
    await check('Child permission choices bind to the child and returning restores the parent draft', async () => {
      if (!await page.locator('#work-panel').isVisible()) await page.locator('#toggle-work').click();
      await page.locator('#work-content [data-action="session"]').first().click(); await page.getByText('Builder exact child history', { exact: true }).waitFor();
      await open(); await current('Default'); assert.match(await dialog().locator('.permission-context').textContent(), /^Builder/);
      const request = await app.evaluate(() => globalThis.__permissionFixture.calls.filter(call => call.operation === 'permissionOptions').at(-1));
      assert.deepEqual(request.params, { key: 'agent:builder:child', agentId: 'builder', sessionId: 'physical-child' });
      await close(); await page.getByRole('button', { name: 'Back to Coordinator' }).click(); await page.getByText('Coordinator is coordinating.', { exact: true }).waitFor();
      assert.equal(await page.locator('#composer-input').inputValue(), 'Keep this unsent draft while I review permissions.');
    });
    await check('Foreign IPC frames cannot request permission changes and narrow review remains usable', async () => {
      const before = writes().length;
      const result = await app.evaluate(async ({ BrowserWindow }, selected) => {
        const window = BrowserWindow.getAllWindows()[0], invoke = globalThis.__permissionFixture.original;
        return invoke({ sender: window.webContents, senderFrame: { url: window.webContents.getURL() } }, 'setPermissions', { ...selected, expectedPermissionMode: 'workspace', expectedLifecycleRevision: 'fixture-lifecycle-physical-main', permissionMode: 'full' });
      }, selected);
      assert.equal(result.ok, false); assert.equal(result.error.code, 'DENIED'); assert.equal(writes().length, before);
      if (await page.locator('#work-panel').isVisible()) await page.locator('#toggle-work').click();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      try {
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(880, 640)); await open(); await current('Workspace');
        await radio('full').check(); await dialog().getByRole('checkbox').scrollIntoViewIfNeeded();
        await dialog().getByRole('checkbox').check(); await apply().scrollIntoViewIfNeeded();
        const box = await apply().boundingBox(), viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({ path: path.join(evidence, 'permissions-review-narrow.png') }); await close(); assert.equal(writes().length, before);
      } finally { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000)); }
      assert.deepEqual(errors, []); assert.deepEqual(network, []); assert.deepEqual(await app.evaluate(() => globalThis.__permissionFixture.native), []);
      assert.equal(calls().some(call => ['chat.send', 'approval.resolve', 'config.patch'].includes(call.method)), false);
    });
    await check('A native session without optional lifecycle revision still supports exact physical and mode CAS', async () => {
      fs.unlinkSync(path.join(profile, 'fixture-permissions.json'));
      await open(); await current('Workspace');
      const before = writes().length; await radio('read-only').check(); await apply().click(); await current('Read only');
      await page.waitForFunction(() => document.querySelector('#permission-status')?.textContent === 'Session permissions updated.');
      assert.equal(writes().length, before + 1);
      assert.deepEqual(writes().at(-1).params, { key: selected.key, agentId: 'main', expectedSessionId: selected.sessionId, expectedPermissionMode: 'workspace', permissionMode: 'read-only' });
      await close(); assert.equal(await page.locator('#composer-input').inputValue(), 'Keep this unsent draft while I review permissions.');
    });
  } finally {
    await app.evaluate(() => { const state = globalThis.__permissionFixture; state?.releases.splice(0).forEach(resolve => resolve()); }).catch(() => {});
    fs.writeFileSync(path.join(evidence, 'permissions-tests.json'), JSON.stringify({ at: new Date().toISOString(), checks, errors, network, profile, scope: 'Isolated native main/service/fake gateway permission changes only. No production permissions, configuration, provider, microphone or other external changes.' }, null, 2));
    await app.close(); runningApp = null;
  }
  console.log(JSON.stringify({ passed: checks.filter(check => check.pass).length, failed: checks.filter(check => !check.pass).length, profile }));
  process.exitCode = checks.some(check => !check.pass) ? 1 : 0;
})().catch(async error => { console.error(error); if (runningApp) await runningApp.close().catch(() => {}); process.exitCode = 1; });
