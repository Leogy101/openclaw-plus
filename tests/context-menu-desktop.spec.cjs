'use strict';
const { _electron } = require('./test-support.cjs').playwright;
const { evidenceDirectory } = require('./test-support.cjs');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), evidence = evidenceDirectory('context-menu');
const profile = fs.mkdtempSync(path.join(evidence, 'fixture-profile-'));
const env = { ...process.env, OPENCLAW_PLUS_TEST_DATA: profile, OPENCLAW_PLUS_TEST_CLI: path.join(root, 'tests/fixture-gateway.cjs') };
delete env.ELECTRON_RUN_AS_NODE;
(async () => {
  const app = await _electron.launch({ executablePath: path.join(root, 'desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [path.join(root, 'desktop')], env });
  const page = await app.firstWindow(); page.setDefaultTimeout(10000);
  const checks = [], errors = [], network = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (/^(?:https?|wss?):/.test(request.url())) network.push(request.url()); });
  await app.evaluate(({ Menu, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]; window.setSize(1440, 1000);
    const contents = window.webContents, state = globalThis.__contextMenuFixture = { menus: [], contexts: [] };
    // Capture the real native menu built after an actual right-click. Never invoke a clipboard role.
    Menu.prototype.popup = function (options) { state.menus.push({ items: this.items.map(item => ({ role: item.role, type: item.type, enabled: item.enabled })), trusted: options.window === window && options.frame === contents.mainFrame }); };
    contents.on('context-menu', (_event, params) => state.contexts.push({ editable: params.isEditable, flags: params.editFlags }));
  });
  const snapshot = () => app.evaluate(() => globalThis.__contextMenuFixture);
  const clear = () => app.evaluate(() => { globalThis.__contextMenuFixture.menus = []; globalThis.__contextMenuFixture.contexts = []; });
  const input = page.locator('#composer-input');
  const rightClick = async (locator, force = false) => { await clear(); await locator.click({ button: 'right', force }); await app.evaluate(() => new Promise(resolve => setImmediate(resolve))); return snapshot(); };
  const action = async name => {
    // Target Electron's native editing command at this fixture's WebContents.
    // A captured popup has no OS first responder; global menu dispatch can
    // otherwise act on a different foreground application in unattended runs.
    await input.focus();
    await app.evaluate(({ BrowserWindow }, name) => {
      const contents=BrowserWindow.getAllWindows()[0].webContents;
      if(name==='selectAll:')contents.selectAll();
      else if(name==='undo:')contents.undo();
      else throw new Error('Unsupported fixture editing command.');
    },name);
  };
  const check = async (name, fn) => { try { await fn(); checks.push({ name, pass: true }); console.log('PASS', name); } catch (error) { checks.push({ name, pass: false, error: error.message }); console.log('FAIL', name, error.message); await page.screenshot({ path: path.join(evidence, `failure-${checks.length}.png`) }).catch(() => {}); throw error; } };
  try {
    await page.getByText('Coordinator is coordinating.', { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('#composer-model')?.value);
    await check('A real composer right-click builds native editing roles with Chromium capability flags', async () => {
      await input.fill('Parent draft.'); await input.evaluate(node => { node.focus(); node.select(); });
      const state = await rightClick(input), menu = state.menus.at(-1), context = state.contexts.at(-1);
      assert.ok(menu?.trusted); assert.equal(context.editable, true);
      const items = menu.items.filter(item => item.type !== 'separator');
      assert.deepEqual(items.map(item => item.role), ['undo', 'redo', 'cut', 'copy', 'paste', 'selectall']);
      for (const [index, flag] of ['canUndo', 'canRedo', 'canCut', 'canCopy', 'canPaste', 'canSelectAll'].entries()) assert.equal(items[index].enabled, context.flags[flag]);
      assert.equal(await input.inputValue(), 'Parent draft.');
    });
    await check('Window-targeted native Select All and Undo preserve input events and exact-session drafts without clipboard access', async () => {
      await input.focus(); await input.press('End'); await input.pressSequentially('x');
      await rightClick(input); await action('selectAll:');
      await page.waitForFunction(() => {const input=document.querySelector('#composer-input');return input.selectionStart===0&&input.selectionEnd===input.value.length;});
      assert.deepEqual(await input.evaluate(node => [node.selectionStart, node.selectionEnd]), [0, 'Parent draft.x'.length]);
      await action('undo:'); await page.waitForFunction(() => document.querySelector('#composer-input').value === 'Parent draft.');
      if (!await page.locator('#work-panel').isVisible()) await page.locator('#toggle-work').click();
      await page.locator('#work-content [data-action="session"]').first().click(); await page.getByText('Builder exact child history', { exact: true }).waitFor();
      assert.equal(await input.inputValue(), ''); await input.fill('Child draft.');
      await page.getByRole('button', { name: 'Back to Coordinator' }).click(); await page.getByText('Coordinator is coordinating.', { exact: true }).waitFor();
      assert.equal(await input.inputValue(), 'Parent draft.');
    });
    await check('Read-only and disabled inputs expose no mutating menu action', async () => {
      for (const property of ['readOnly', 'disabled']) {
        await input.evaluate((node, property) => { node.focus(); node.select(); node[property] = true; }, property);
        try {
          const state = await rightClick(input, property === 'disabled');
          assert.ok(state.menus.every(menu => menu.items.every(item => item.role === 'copy' || item.type === 'separator' || !item.enabled)));
          assert.equal(await input.inputValue(), 'Parent draft.');
        } finally { await input.evaluate((node, property) => { node[property] = false; }, property); }
      }
    });
    await check('Selected report text offers Copy without editing or clipboard operations', async () => {
      const report = page.getByText('Coordinator is coordinating.', { exact: true });
      await report.evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); });
      const state = await rightClick(report);
      assert.deepEqual(state.menus.at(-1)?.items.map(item => item.role), ['copy']); assert.equal(await input.inputValue(), 'Parent draft.');
    });
    await check('Missing and foreign frames cannot open an editing menu', async () => {
      await clear(); await app.evaluate(({ BrowserWindow }) => {
        const contents = BrowserWindow.getAllWindows()[0].webContents;
        for (const frame of [null, { url: contents.getURL() }, { url: 'https://example.invalid/' }]) contents.emit('context-menu', {}, { frame, isEditable: true, editFlags: { canCut: true, canCopy: true, canPaste: true } });
      }); assert.deepEqual((await snapshot()).menus, []);
      const calls = fs.readFileSync(path.join(profile, 'fixture-calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
      assert.equal(calls.some(call => ['chat.send', 'sessions.patch', 'config.patch', 'approval.resolve'].includes(call.method)), false);
      assert.deepEqual(errors, []); assert.deepEqual(network, []);
    });
  } finally {
    fs.writeFileSync(path.join(evidence, 'context-menu-tests.json'), JSON.stringify({ at: new Date().toISOString(), checks, errors, network, scope: 'Native fixture-only right-click and editing actions. Popup captured; Cut, Copy and Paste never invoked; OS clipboard untouched.' }, null, 2));
    await app.close();
  }
  console.log(JSON.stringify({ passed: checks.filter(item => item.pass).length, failed: checks.filter(item => !item.pass).length }));
})().catch(error => { console.error(error); process.exitCode = 1; });
