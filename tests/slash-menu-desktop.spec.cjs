'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { playwright: { _electron }, evidenceDirectory } = require('./test-support.cjs');
const { READ_METHODS } = require('../desktop/src/gateway-cli.cjs');

const root = path.resolve(__dirname, '..');
const evidence = evidenceDirectory('slash-menu');
const profile = fs.mkdtempSync(path.join(evidence, 'fixture-profile-'));
const env = { ...process.env, OPENCLAW_PLUS_TEST_DATA: profile, OPENCLAW_PLUS_TEST_CLI: path.join(root, 'tests/fixture-gateway.cjs') };
delete env.ELECTRON_RUN_AS_NODE;

function calls() {
  const log = path.join(profile, 'fixture-calls.jsonl');
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
}

const writes = () => calls().filter(({ method }) => !READ_METHODS.has(method));

async function run() {
  const app = await _electron.launch({
    executablePath: path.join(root, 'desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    args: [path.join(root, 'desktop')], env
  });
  let page;
  try {
    page = await app.firstWindow();
    page.setDefaultTimeout(12000);
    const errors = [], network = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/^(?:https?|wss?):/.test(request.url())) network.push(request.url()); });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000));

    const input = page.locator('#composer-input');
    const menu = page.getByRole('listbox', { name: 'Slash commands' });
    const option = command => menu.getByRole('option', { name: new RegExp(`^/${command}(?:\\s|$)`, 'i') });
    const closeMenu = () => menu.waitFor({ state: 'hidden' });

    await page.getByText('Coordinator is coordinating.', { exact: true }).waitFor();
    for (const text of ['Inspect /model documentation', '/Users/example/Documents', 'https://example.invalid/path']) {
      await input.fill(text);
      await closeMenu();
      assert.equal(await input.inputValue(), text);
    }

    await input.fill('');
    await input.press('/');
    await option('status').waitFor();
    await option('model').waitFor();
    assert.equal(await option('review').count(), 0);
    const discovery = calls().find(({ method }) => method === 'commands.list');
    assert.deepEqual(discovery?.params, { sessionKey: 'agent:main:main', agentId: 'main', scope: 'text', includeArgs: false });
    const active = await input.getAttribute('aria-activedescendant');
    assert.ok(active, 'the composer exposes the active command to assistive technology');
    await input.press('ArrowDown');
    assert.notEqual(await input.getAttribute('aria-activedescendant'), active);
    await input.press('ArrowUp');
    assert.equal(await input.getAttribute('aria-activedescendant'), active);
    await page.screenshot({ path: path.join(evidence, 'slash-menu.png') });

    await input.fill('/mod');
    await option('model').waitFor();
    assert.equal(await menu.getByRole('option').count(), 1);
    await input.press('Enter');
    await closeMenu();
    assert.equal((await input.inputValue()).trim(), '/model');
    assert.deepEqual(writes(), [], 'selecting a command only inserts text');
    console.log('PASS Slash opens the current catalog, supports filtering and arrow keys, and inserts without sending');

    await input.fill('/mod');
    await option('model').waitFor();
    await input.press('Escape');
    await closeMenu();
    assert.equal(await input.inputValue(), '/mod');
    await page.locator('#session-list').getByRole('button', { name: 'Open Builder: Verify changes', exact: true }).click();
    await page.getByText('Builder exact child history', { exact: true }).waitFor();
    assert.equal(await input.inputValue(), '');
    await input.press('/');
    await option('review').waitFor();
    assert.equal(await option('model').count(), 0);
    assert.ok(calls().some(({ method, params }) => method === 'commands.list' &&
      params.sessionKey === 'agent:builder:child' && params.agentId === 'builder'));
    await option('review').click();
    await closeMenu();
    assert.equal((await input.inputValue()).trim(), '/review');
    await page.locator('#session-list').getByRole('button', { name: 'Open Coordinator: Workspace review', exact: true }).click();
    await page.getByText('Coordinator is coordinating.', { exact: true }).waitFor();
    assert.equal(await input.inputValue(), '/mod');
    assert.deepEqual(writes(), [], 'dismissal and switching drafts have no gateway write');
    console.log('PASS Escape preserves the draft and switching conversations uses the other agent catalog');

    await input.fill('/stat');
    await option('status').waitFor();
    await option('status').click();
    await closeMenu();
    assert.equal((await input.inputValue()).trim(), '/status');
    assert.deepEqual(writes(), []);
    await page.waitForFunction(() => document.querySelector('#send-message')?.disabled === false);
    await input.press('Enter');
    await page.getByText('Fixture reply received.', { exact: true }).waitFor();
    const [send, extra] = writes();
    assert.equal(extra, undefined);
    assert.equal(send?.method, 'chat.send');
    assert.equal(send.params.message.trim(), '/status');
    assert.equal(send.params.sessionKey, 'agent:main:main');
    assert.equal(send.params.sessionId, 'physical-main');
    assert.equal(send.params.agentId, 'main');
    assert.deepEqual(errors, []);
    assert.deepEqual(network, []);
    console.log('PASS Only sending the completed draft submits the command to the current session');
  } catch (error) {
    console.log('FAIL Slash command desktop workflow', error.message);
    await page?.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    await app.close();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
