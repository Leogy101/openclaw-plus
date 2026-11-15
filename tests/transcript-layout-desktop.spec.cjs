'use strict';
const { _electron } = require('./test-support.cjs').playwright;
const { evidenceDirectory } = require('./test-support.cjs');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), evidence = evidenceDirectory('transcript-layout');
const profile = fs.mkdtempSync(path.join(evidence, 'fixture-profile-'));
const env = { ...process.env, OPENCLAW_PLUS_TEST_DATA: profile, OPENCLAW_PLUS_TEST_CLI: path.join(root, 'tests/fixture-gateway.cjs') };
delete env.ELECTRON_RUN_AS_NODE;
const title = 'Fixture conversation with a deliberately long descriptive title for layout verification — '.repeat(4);
const tool = (id, text) => ({ id, role: 'tool', text });
const call = (id, name) => ({ id, role: 'assistant', blocks: [{ type: 'tool_call', name, text: `Fixture ${name} arguments` }] });
const messages = [call('first-call', 'exec'), tool('first-result', 'First fixture output'),
  { id: 'report-one', role: 'assistant', text: 'First visible fixture report.' }, call('middle-call', 'bash'), tool('middle-result', 'Literal <script>fixtureOnly()</script> output'),
  { id: 'report-two', role: 'assistant', text: 'Second visible fixture report.' }, { id: 'user-note', role: 'user', text: 'Keep this user request visible.' },
  { id: 'question', role: 'assistant', blocks: [{ type: 'tool_call', name: 'ask', text: 'Fixture question receipt' }], asyncQuestion: { id: 'question-one', questions: [{ title: 'Which fixture option?', options: ['Inspect', 'Review'] }] } },
  { id: 'mixed', role: 'assistant', text: 'Mixed report stays visible.', blocks: [{ type: 'tool_call', name: 'diagnostic', text: 'Mixed hidden output' }] },
  { id: 'filler', role: 'assistant', text: Array.from({ length: 16 }, (_, index) => `Fixture reading line ${index + 1}: preserve the reader’s position.`).join('\n') }, call('tail-call', 'verify')];
(async () => {
  const app = await _electron.launch({ executablePath: path.join(root, 'desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [path.join(root, 'desktop')], env });
  const page = await app.firstWindow(); page.setDefaultTimeout(12000); await page.emulateMedia({ reducedMotion: 'reduce' });
  const checks = [], errors = [], network = [], geometry = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (/^(?:https?|wss?):/.test(request.url())) network.push(request.url()); });
  await app.evaluate(({ ipcMain, BrowserWindow, clipboard, shell }, fixture) => {
    const window = BrowserWindow.getAllWindows()[0]; window.setSize(1440, 1000);
    const state = globalThis.__transcriptFixture = { ...fixture, extras: [], reads: 0, copies: [], external: [], calls: [] };
    const original = ipcMain._invokeHandlers.get('gateway:request'), send = window.webContents.send.bind(window.webContents);
    state.publish = () => send('gateway:event', { kind: 'history', key: 'agent:main:main' });
    window.webContents.send = (channel, event, ...rest) => { if (channel === 'gateway:event') return; return send(channel, event, ...rest); };
    ipcMain.removeHandler('gateway:request'); ipcMain.handle('gateway:request', async (event, operation, params) => {
      state.calls.push({ operation, params });
      if (operation === 'plan') return { ok: true, data: { card: null } };
      if (operation === 'history' && params.key === 'agent:main:main') {
        state.reads++; return { ok: true, data: { key: params.key, sessionId: 'physical-main', messages: params.offset ? [{ id: 'older-result', role: 'tool', text: 'Older fixture output' }] : [...state.messages, ...state.extras], hasMore: !params.offset, nextOffset: params.offset ? undefined : 11, offset: params.offset || 0, total: 12 + state.extras.length, leafEntryId: 'fixture-leaf', hasActiveRun: false, activeRunIds: [] } };
      }
      const result = await original(event, operation, params);
      if (operation === 'overview' && result.ok) result.data.sessions = result.data.sessions.map(row => ({ ...row, title: state.title }));
      if (operation === 'work' && result.ok) result.data.subagents = result.data.subagents.map(row => ({ ...row, title: state.title }));
      return result;
    });
    clipboard.writeText = text => state.copies.push(text); shell.openExternal = async url => state.external.push(url);
  }, { messages, title });
  const article = id => page.locator(`article[data-message-id="${id}"]`);
  const batch = id => article(id).locator('xpath=ancestor::details[contains(@class,"tool-batch")]');
  const check = async (name, fn) => { try { await fn(); checks.push({ name, pass: true }); console.log('PASS', name); } catch (error) { checks.push({ name, pass: false, error: error.message }); console.log('FAIL', name, error.message); await page.screenshot({ path: path.join(evidence, `failure-${checks.length}.png`) }).catch(() => {}); throw error; } };
  const publish = async () => { const before = await app.evaluate(() => globalThis.__transcriptFixture.reads); await app.evaluate(() => globalThis.__transcriptFixture.publish()); const deadline = Date.now() + 10000; while (await app.evaluate(() => globalThis.__transcriptFixture.reads) === before) { if (Date.now() > deadline) throw new Error('Fixture history did not refresh'); await page.waitForTimeout(20); } await page.evaluate(() => new Promise(requestAnimationFrame)); };
  const arrowUp = locator => locator.evaluate(node => new DOMMatrix(getComputedStyle(node).transform).a < -.99);
  const saved = () => page.evaluate(() => ({ focus: document.activeElement.dataset.focus, scroll: document.querySelector('#transcript').scrollTop, draft: document.querySelector('#composer-input').value }));
  try {
    await page.reload(); await article('report-one').waitFor(); await page.waitForFunction(() => document.querySelector('#composer-model')?.value);
    await check('Conversation identity and full accessible title share a compact row', async () => {
      const metric = await page.evaluate(() => { const a = document.querySelector('.breadcrumb-agent-name').getBoundingClientRect(), b = document.querySelector('#page-title').getBoundingClientRect(); return { centerDifference: Math.abs(a.y + a.height / 2 - b.y - b.height / 2), height: document.querySelector('.page-header').getBoundingClientRect().height }; });
      assert.ok(metric.centerDifference < 3); assert.ok(metric.height <= 70); assert.equal(await page.locator('#page-title').getAttribute('title'), title);
    });
    await check('Tool-only rows collapse between readable reports without swallowing user, question or mixed rows', async () => {
      assert.equal(await page.locator('.tool-batch').count(), 3); assert.equal(await page.locator('.tool-batch[open]').count(), 0);
      for (const id of ['report-one', 'report-two', 'user-note', 'question', 'mixed']) { assert.equal(await article(id).locator('xpath=ancestor::details[contains(@class,"tool-batch")]').count(), 0); assert.ok(await article(id).isVisible()); }
      assert.ok(await article('question').getByRole('button', { name: 'Jump to question', exact: true }).isVisible()); assert.ok(await page.locator('#pending-question-region').getByRole('radio', { name: 'Inspect', exact: true }).isVisible());
      assert.deepEqual(await page.locator('#messages article[data-message-id]').evaluateAll(nodes => nodes.map(node => node.dataset.messageId)), messages.map(row => row.id));
      for (const message of messages) { if (message.text) assert.ok((await article(message.id).textContent()).includes(message.text)); for (const block of message.blocks || []) assert.ok((await article(message.id).textContent()).includes(block.text)); }
      assert.equal(await batch('middle-call').evaluate(node => [node.previousElementSibling.dataset.messageId, node.nextElementSibling.dataset.messageId].join(',')), 'report-one,report-two');
    });
    await check('Expanded batches retain individual outputs and upward arrows without executing literal content', async () => {
      await batch('middle-call').locator(':scope > summary').click(); await article('middle-call').locator('summary').click(); await article('middle-result').locator('summary').click();
      assert.ok(await arrowUp(batch('middle-call').locator(':scope > summary > svg:last-child'))); assert.ok(await arrowUp(article('middle-call').locator('summary > svg:last-child')));
      assert.equal(await article('middle-result').locator('.tool-output').textContent(), 'Literal <script>fixtureOnly()</script> output'); assert.equal(await page.locator('#messages script').count(), 0);
      await page.locator('#composer-input').fill('Keep this unfinished fixture draft.'); await article('middle-call').locator('summary').focus();
      await article('middle-call').evaluate(node => node.scrollIntoView({ block: 'start', behavior: 'instant' }));
      const before = await saved(); await publish(); assert.deepEqual(await saved(), before);
      await app.evaluate(() => globalThis.__transcriptFixture.extras.push({ id: 'tail-result', role: 'tool', text: 'Appended fixture result' })); await publish(); await article('tail-result').waitFor({ state: 'attached' });
      const after = await saved(); assert.equal(after.focus, before.focus); assert.equal(after.draft, before.draft); assert.ok(Math.abs(after.scroll - before.scroll) < 3);
      assert.equal(await batch('middle-call').getAttribute('open'), ''); assert.equal(await article('middle-call').locator('details').getAttribute('open'), '');
    });
    await check('Report Copy contains only that report and never adjacent tool output', async () => {
      await article('mixed').getByRole('button', { name: 'Copy report', exact: true }).click(); await page.waitForFunction(() => document.querySelector('#toast')?.textContent === 'Report copied.');
      assert.deepEqual(await app.evaluate(() => globalThis.__transcriptFixture.copies), ['Mixed report stays visible.']);
    });
    await check('Loading older history merges a leading tool batch while preserving open output, focus and source order', async () => {
      await batch('first-call').locator(':scope > summary').click(); await article('first-call').locator('summary').click(); await article('first-call').locator('summary').focus();
      await article('first-call').evaluate(node => node.scrollIntoView({ block: 'start', behavior: 'instant' })); const before = await saved(), anchorTop = await article('first-call').evaluate(node => node.getBoundingClientRect().top);
      await page.getByRole('button', { name: 'Load earlier messages', exact: true }).dispatchEvent('click'); await article('older-result').waitFor({ state: 'attached' });
      assert.equal(await batch('first-call').getAttribute('open'), ''); assert.equal(await article('first-call').locator('details').getAttribute('open'), '');
      assert.equal((await saved()).focus, before.focus); assert.equal((await saved()).draft, before.draft);
      assert.ok(Math.abs(await article('first-call').evaluate(node => node.getBoundingClientRect().top) - anchorTop) < 3, 'Earlier-history merge preserves the visible message anchor');
      assert.deepEqual(await page.locator('#messages article[data-message-id]').evaluateAll(nodes => nodes.map(node => node.dataset.messageId)), ['older-result', ...messages.map(row => row.id), 'tail-result']);
      assert.equal(await batch('first-call').locator('.tool-batch-count').textContent(), '3 entries'); assert.ok(await arrowUp(batch('first-call').locator(':scope > summary > svg:last-child')));
    });
    await check('Long titles, status, Back and header actions fit desktop, narrow and 200% zoom', async () => {
      if (!await page.locator('#work-panel').isVisible()) await page.locator('#toggle-work').click();
      await page.locator('#work-content [data-action="session"]').first().click(); await page.getByText('Builder exact child history', { exact: true }).waitFor();
      for (const [width, zoom] of [[1440, 1], [1100, 1], [880, 1], [880, 2]]) {
        await app.evaluate(({ BrowserWindow }, { width, zoom }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(width, 1000); window.webContents.setZoomFactor(zoom); }, { width, zoom });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const metric = await page.evaluate(() => { const header = document.querySelector('.page-header'); const boxes = ['.back-inline', '.breadcrumb', '#page-title', '#activity-header', '#toggle-terminal', '#toggle-work'].map(selector => { const r = header.querySelector(selector).getBoundingClientRect(); return { selector, x: r.x, right: r.right, width: r.width }; }); return { viewport: innerWidth, overflow: header.scrollWidth - header.clientWidth, boxes }; });
        geometry.push({ width, zoom, ...metric }); assert.ok(metric.overflow <= 1, JSON.stringify(metric)); assert.ok(metric.boxes.every(box => box.width > 0 && box.x >= -1 && box.right <= metric.viewport + 1), JSON.stringify(metric));
        assert.equal(await page.locator('#page-title').getAttribute('title'), title); await page.screenshot({ path: path.join(evidence, `header-${width}-${zoom}.png`) });
      }
      await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.webContents.setZoomFactor(1); window.setSize(1440, 1000); });
      await page.getByRole('button', { name: 'Back to Coordinator' }).click(); await article('report-one').waitFor(); assert.equal(await page.locator('#composer-input').inputValue(), 'Keep this unfinished fixture draft.');
      assert.deepEqual(errors, []); assert.deepEqual(network, []); assert.deepEqual(await app.evaluate(() => globalThis.__transcriptFixture.external), []);
      assert.equal(await app.evaluate(() => globalThis.__transcriptFixture.calls.some(call => ['send', 'abort', 'saveSettings', 'resolveApproval'].includes(call.operation))), false);
    });
  } finally {
    fs.writeFileSync(path.join(evidence, 'transcript-layout-tests.json'), JSON.stringify({ at: new Date().toISOString(), checks, errors, network, geometry, scope: 'Isolated native IPC history fixtures; clipboard write intercepted; no production calls.' }, null, 2)); await app.close();
  }
  console.log(JSON.stringify({ passed: checks.filter(item => item.pass).length, failed: checks.filter(item => !item.pass).length }));
})().catch(error => { console.error(error); process.exitCode = 1; });
