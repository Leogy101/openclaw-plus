'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { playwright: { _electron }, evidenceDirectory } = require('./test-support.cjs');
const { READ_METHODS } = require('../desktop/src/gateway-cli.cjs');

const root = path.resolve(__dirname, '..');
const evidence = evidenceDirectory('new-conversation');
const profile = fs.mkdtempSync(path.join(evidence, 'fixture-profile-'));
const env = { ...process.env, OPENCLAW_PLUS_TEST_DATA: profile, OPENCLAW_PLUS_TEST_CLI: path.join(root, 'tests/fixture-gateway.cjs') };
delete env.ELECTRON_RUN_AS_NODE;

const writes = () => {
  const log = path.join(profile, 'fixture-calls.jsonl');
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    .filter(({ method }) => !READ_METHODS.has(method));
};

async function run() {
  const application = await _electron.launch({
    executablePath: path.join(root, 'desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    args: [path.join(root, 'desktop')], env
  });
  let page;
  try {
    page = await application.firstWindow();
    page.setDefaultTimeout(12000);
    const errors = [], network = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/^(?:https?|wss?):/.test(request.url())) network.push(request.url()); });
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000));

    const composer = page.locator('#composer-input');
    const dialog = page.getByRole('dialog', { name: 'New Conversation', exact: true });
    const agent = dialog.locator('#new-conversation-agent');
    const previousDraft = 'Keep this in the existing conversation.';
    await page.getByText('Coordinator is coordinating.', { exact: true }).waitFor();
    await composer.fill(previousDraft);
    await page.locator('#new-conversation').click();
    await dialog.waitFor();
    assert.equal(await agent.inputValue(), 'main');
    await page.screenshot({ path: path.join(evidence, 'new-conversation.png') });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await composer.inputValue(), previousDraft);
    assert.deepEqual(writes(), [], 'opening and cancelling the picker have no mutation');
    console.log('PASS The sidebar opens the picker with the current agent, and cancelling keeps the existing draft');

    const accelerator = await application.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu().getMenuItemById('new');
      item.click();
      return item.accelerator;
    });
    assert.match(accelerator, /(?:Command|Cmd)\+N/i);
    await dialog.waitFor();
    await agent.selectOption('builder');
    await dialog.locator('#create-conversation').click();
    await dialog.waitFor({ state: 'hidden' });
    assert.match(await composer.getAttribute('placeholder'), /Message Builder/);
    assert.equal(await composer.inputValue(), '');
    assert.equal(await composer.evaluate(input => input === document.activeElement), true);
    const [create] = writes();
    assert.equal(create.method, 'sessions.create');
    assert.match(create.params.key, /^agent:builder:dashboard:[a-f\d-]{36}$/i);
    assert.deepEqual(writes(), [{ method: 'sessions.create', params: { key: create.params.key, agentId: 'builder' } }]);
    const createdRow = page.locator('#session-list .session-item.active');
    await createdRow.waitFor();
    const [agentId, key, sessionId] = JSON.parse(await createdRow.getAttribute('data-identity'));
    assert.equal(agentId, 'builder');
    assert.equal(key, create.params.key);
    assert.ok(sessionId, 'the new sidebar entry has a real physical session id');
    assert.equal(await page.locator('#messages [data-message-id]').count(), 0);
    console.log('PASS File → New Conversation creates a separate empty session for the chosen agent');

    const firstPrompt = 'This fixture prompt belongs in the new conversation.';
    await composer.fill(firstPrompt);
    await page.waitForFunction(() => document.querySelector('#send-message')?.disabled === false);
    await composer.press('Enter');
    await page.getByText('Fixture reply received.', { exact: true }).waitFor();
    const [, send, extra] = writes();
    assert.equal(send?.method, 'chat.send');
    assert.equal(extra, undefined);
    assert.equal(send.params.sessionKey, key);
    assert.equal(send.params.sessionId, sessionId);
    assert.equal(send.params.agentId, agentId);
    assert.equal(send.params.message, firstPrompt);
    assert.equal(send.params.expectedLeafEntryId, null);
    await page.getByRole('button', { name: 'Open Coordinator: Workspace review', exact: true }).click();
    await page.getByText('Coordinator is coordinating.', { exact: true }).waitFor();
    assert.equal(await composer.inputValue(), previousDraft);
    assert.deepEqual(errors, []);
    assert.deepEqual(network, []);
    console.log('PASS The first prompt targets the exact new session and the previous draft remains in place');
  } catch (error) {
    console.log('FAIL New conversation desktop workflow', error.message);
    await page?.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    await application.close();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
