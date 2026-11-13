'use strict';
const { _electron } = require('./test-support.cjs').playwright;
const { evidenceDirectory } = require('./test-support.cjs');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), evidence = evidenceDirectory('read-aloud');
const profile = fs.mkdtempSync(path.join(evidence, 'fixture-profile-'));
const reportText = '# Readable report\n\n**Visible summary:** verified text for the listener.\n\n- First visible item.\n- Second visible item.\n\n[Readable reference](https://example.invalid/private-target)\n\n```sh\nHIDDEN_CODE_SENTINEL --never-run\n```';
const longText = Array.from({ length: 8 }, (_, index) => `Sentence ${index + 1} keeps every ordinary word in its original order.`).join(' ');
fs.writeFileSync(path.join(profile, 'fixture-report.md'), reportText);
fs.writeFileSync(path.join(profile, 'fixture-questions.json'), JSON.stringify({ 'agent:main:main': { current: [
  { role: 'assistant', content: 'A second short report for explicit playback switching.', __openclaw: { id: 'speech-second' } },
  { role: 'assistant', content: longText, __openclaw: { id: 'speech-long' } }
] } }));
const env = { ...process.env, OPENCLAW_PLUS_TEST_DATA: profile, OPENCLAW_PLUS_TEST_CLI: path.join(root, 'tests/fixture-gateway.cjs') };
delete env.ELECTRON_RUN_AS_NODE;
const cliCalls = () => fs.existsSync(path.join(profile, 'fixture-calls.jsonl')) ? fs.readFileSync(path.join(profile, 'fixture-calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
let runningApp;
(async () => {
  const app = await _electron.launch({ executablePath: path.join(root, 'desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [path.join(root, 'desktop')], env });
  runningApp = app;
  const page = await app.firstWindow(); page.setDefaultTimeout(12000);
  const checks = [], errors = [], network = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^(?:https?|wss?|file):/.test(request.url())) network.push(request.url()); });
  await page.addInitScript(() => {
    const state = window.__readAloudMedia = { players: [], plays: [], pauses: [], blobs: [], revoked: [], rejectNext: false };
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); state.blobs.push({ url, type: blob.type, size: blob.size }); return url; };
    URL.revokeObjectURL = url => { state.revoked.push(url); return revoke(url); };
    HTMLMediaElement.prototype.play = function () {
      if (!state.players.includes(this)) state.players.push(this);
      state.plays.push(this.src);
      if (state.rejectNext) { state.rejectNext = false; return Promise.reject(new Error('Fixture playback unavailable')); }
      this.__fixturePlaying = true;
      this.dispatchEvent(new Event('playing'));
      return Promise.resolve();
    };
    HTMLMediaElement.prototype.pause = function () { this.__fixturePlaying = false; state.pauses.push(this.src); };
    HTMLMediaElement.prototype.load = function () {};
    state.end = () => { const player = state.players.find(item => item.__fixturePlaying); if (!player) throw new Error('No fixture audio is playing.'); player.__fixturePlaying = false; player.dispatchEvent(new Event('ended')); };
    state.fail = () => { const player = state.players.find(item => item.__fixturePlaying); if (!player) throw new Error('No fixture audio is playing.'); player.dispatchEvent(new Event('error')); };
  });
  await app.evaluate(({ ipcMain, BrowserWindow, shell, clipboard }) => {
    const window = BrowserWindow.getAllWindows()[0]; window.setSize(1440, 1000);
    const state = globalThis.__readAloudFixture = { mode: 'source', maxTextLength: null, calls: [], releases: [], native: [], historyReads: 0, replaceReport: false, responses: [] };
    const original = ipcMain._invokeHandlers.get('gateway:request'), send = window.webContents.send.bind(window.webContents);
    state.publish = event => send('gateway:event', event);
    window.webContents.send = (channel, event, ...rest) => { if (channel === 'gateway:event') return; return send(channel, event, ...rest); };
    ipcMain.removeHandler('gateway:request');
    ipcMain.handle('gateway:request', async (event, operation, params) => {
      state.calls.push({ operation, params: structuredClone(params) });
      const mode = state.mode;
      if (operation === 'plan') return { ok: true, data: { card: null } };
      if (operation === 'speechOptions') {
        if (mode === 'pending-options') await new Promise(resolve => state.releases.push(resolve));
        if (mode === 'unavailable') return { ok: true, data: { available: false, maxTextLength: 4000, reason: 'Fixture speech provider is unavailable.' } };
      }
      if (operation === 'speak') {
        if (mode === 'pending-speak') await new Promise(resolve => state.releases.push(resolve));
        if (mode === 'speech-error') return { ok: false, error: { code: 'UNAVAILABLE', message: 'Fixture speech request failed.' } };
        if (mode === 'url-audio') return { ok: true, data: { audioBase64: 'https://example.invalid/forbidden.wav', mimeType: 'audio/wav' } };
        if (mode === 'file-audio') return { ok: true, data: { audioBase64: 'file:///not-a-fixture.wav', mimeType: 'audio/wav' } };
      }
      const result = await original(event, operation, params);
      if (result?.ok && operation === 'speechOptions' && state.maxTextLength) result.data.maxTextLength = state.maxTextLength;
      if (result?.ok && operation === 'speak' && mode === 'bad-mime') result.data.mimeType = 'text/html';
      if (result?.ok && operation === 'history') {
        state.historyReads++;
        if (state.replaceReport) result.data.messages = result.data.messages.map(message => message.id.startsWith('report:') ? { ...message, id: 'report:changed-fixture', text: 'Updated visible report after refresh.', blocks: [] } : message);
      }
      if (['speechOptions', 'speak'].includes(operation)) state.responses.push(operation);
      return result;
    });
    shell.openExternal = async value => state.native.push(['external', value]);
    shell.openPath = async value => state.native.push(['open', value]);
    shell.showItemInFolder = value => state.native.push(['reveal', value]);
    clipboard.writeText = value => state.native.push(['copy', value]);
  });
  const report = prefix => page.locator(`article[data-message-id^="${prefix}:"]`);
  const primary = () => report('report'), secondary = () => report('speech-second'), longReport = () => report('speech-long');
  const button = locator => locator.locator('[data-action="read-aloud"]');
  const speechCalls = () => app.evaluate(() => globalThis.__readAloudFixture.calls.filter(call => ['speechOptions', 'speak'].includes(call.operation)));
  const media = () => page.evaluate(() => { const s = window.__readAloudMedia; return { plays: s.plays, pauses: s.pauses, blobs: s.blobs, revoked: s.revoked, playing: s.players.filter(player => player.__fixturePlaying).length }; });
  const setMode = (mode, cap = null) => app.evaluate((_, { mode, cap }) => { const s = globalThis.__readAloudFixture; s.mode = mode; s.maxTextLength = cap; }, { mode, cap });
  const waitMain = async predicate => { const deadline = Date.now() + 12000; while (!await app.evaluate(predicate)) { if (Date.now() > deadline) throw new Error('Speech fixture response timed out.'); await page.waitForTimeout(25); } };
  const start = async locator => { const before = (await media()).plays.length; await button(locator).click(); await page.waitForFunction(before => window.__readAloudMedia.plays.length > before, before); await page.waitForTimeout(30); };
  const stop = async locator => { await button(locator).click(); await page.waitForFunction(() => !document.querySelector('[data-action="read-aloud"][aria-label="Stop reading report"]')); assert.equal((await media()).playing, 0); };
  const publish = event => app.evaluate((_, event) => globalThis.__readAloudFixture.publish(event), event);
  const refresh = async () => { const before = await app.evaluate(() => globalThis.__readAloudFixture.historyReads); await publish({ kind: 'history', key: 'agent:main:main' }); const deadline = Date.now() + 12000; while (await app.evaluate(() => globalThis.__readAloudFixture.historyReads) === before) { if (Date.now() > deadline) throw new Error('History refresh timed out.'); await page.waitForTimeout(25); } await page.waitForTimeout(50); };
  const menu = id => app.evaluate(({ Menu }, id) => Menu.getApplicationMenu().getMenuItemById(id).click(), id);
  const check = async (name, fn) => {
    try { await fn(); checks.push({ name, pass: true }); console.log('PASS', name); }
    catch (error) { checks.push({ name, pass: false, error: error.message }); console.log('FAIL', name, error.message); await page.screenshot({ path: path.join(evidence, `failure-${checks.length}.png`) }).catch(() => {}); }
  };
  try {
    await page.reload(); await primary().waitFor(); await page.waitForFunction(() => document.querySelector('#composer-model')?.value);
    await check('Read aloud is beside Copy on assistant reports and does not synthesize during load or polling', async () => {
      assert.equal(await primary().getByRole('button', { name: 'Read report aloud', exact: true }).count(), 1);
      assert.equal(await primary().locator('.message-actions [data-action="copy-report"]').count(), 1);
      assert.equal(await button(primary()).evaluate(node => node.parentElement.classList.contains('message-actions')), true);
      assert.equal(await page.locator('[data-message-role="user"] [data-action="read-aloud"], [data-message-role="tool"] [data-action="read-aloud"]').count(), 0);
      await refresh(); assert.deepEqual(await speechCalls(), []);
      assert.equal(cliCalls().filter(call => call.method.startsWith('tts.')).length, 0);
    });
    await check('Explicit reading reaches native speech through the real service and excludes hidden/code/formatting content', async () => {
      await start(primary());
      const calls = cliCalls(); assert.ok(calls.some(call => call.method === 'tts.status'));
      const spoken = calls.filter(call => call.method === 'tts.speak'); assert.equal(spoken.length, 1);
      assert.deepEqual(Object.keys(spoken[0].params), ['text']);
      for (const phrase of ['Readable report', 'Visible summary', 'First visible item', 'Second visible item', 'Readable reference']) assert.ok(spoken[0].params.text.includes(phrase));
      assert.doesNotMatch(spoken[0].params.text, /HIDDEN_CODE_SENTINEL|PROVIDED REASONING|INTERNAL TOOL DETAIL|```|\*\*|private-target|Copy|Read aloud/);
      const audio = await media(); assert.equal(audio.playing, 1); assert.equal(audio.blobs.at(-1).type, 'audio/wav'); assert.ok(audio.plays.at(-1).startsWith('blob:openclaw-plus://'));
      assert.equal(await button(primary()).getAttribute('aria-label'), 'Stop reading report');
      await stop(primary()); assert.ok((await media()).revoked.includes(audio.blobs.at(-1).url));
    });
    await check('Stop during options or synthesis ignores late responses and never resumes automatically', async () => {
      for (const mode of ['pending-options', 'pending-speak']) {
        await setMode(mode); const before = await media(), beforeCalls = await speechCalls();
        const operation = mode === 'pending-options' ? 'speechOptions' : 'speak';
        const beforeResponses = await app.evaluate((_, operation) => globalThis.__readAloudFixture.responses.filter(item => item === operation).length, operation);
        await button(primary()).click(); await waitMain(() => globalThis.__readAloudFixture.releases.length === 1);
        assert.equal(await button(primary()).isEnabled(), true);
        await stop(primary());
        await app.evaluate(() => { const state = globalThis.__readAloudFixture; state.mode = 'source'; state.releases.splice(0).forEach(resolve => resolve()); });
        const deadline = Date.now() + 12000;
        while (await app.evaluate((_, operation) => globalThis.__readAloudFixture.responses.filter(item => item === operation).length, operation) === beforeResponses) { if (Date.now() > deadline) throw new Error('Cancelled fixture response did not arrive.'); await page.waitForTimeout(25); }
        await page.waitForTimeout(60);
        assert.equal((await media()).plays.length, before.plays.length); assert.equal((await media()).blobs.length, before.blobs.length);
        if (mode === 'pending-options') assert.equal((await speechCalls()).filter(call => call.operation === 'speak').length, beforeCalls.filter(call => call.operation === 'speak').length);
      }
    });
    await check('Selecting another report or child conversation stops the previous player without overlap', async () => {
      await setMode('source'); await start(primary()); const first = (await media()).blobs.at(-1).url;
      await start(secondary()); assert.equal((await media()).playing, 1); assert.ok((await media()).revoked.includes(first));
      assert.equal(await button(primary()).getAttribute('aria-label'), 'Read report aloud');
      if (!await page.locator('#work-panel').isVisible()) await page.locator('#toggle-work').click();
      await page.locator('#work-content [data-action="session"]').first().click(); await page.getByText('Builder exact child history', { exact: true }).waitFor();
      assert.equal((await media()).playing, 0); assert.equal(await page.getByRole('button', { name: 'Stop reading report', exact: true }).count(), 0);
      await page.getByRole('button', { name: 'Back to Coordinator' }).click(); await primary().waitFor();
      assert.equal((await media()).playing, 0);
    });
    await check('Ordinary polling preserves playback and the draft; a changed report or view stops reading', async () => {
      await start(primary());
      await page.locator('#composer-input').fill('This draft and selection remain untouched.');
      await page.locator('#composer-input').evaluate(node => { node.focus(); node.setSelectionRange(5, 10); window.__speechComposer = node; });
      const before = await media(), requestCount = (await speechCalls()).length;
      await refresh();
      assert.equal((await media()).playing, 1); assert.equal((await media()).plays.length, before.plays.length); assert.equal((await speechCalls()).length, requestCount);
      assert.deepEqual(await page.locator('#composer-input').evaluate(node => ({ text: node.value, start: node.selectionStart, end: node.selectionEnd, same: node === window.__speechComposer })), { text: 'This draft and selection remain untouched.', start: 5, end: 10, same: true });
      await app.evaluate(() => globalThis.__readAloudFixture.replaceReport = true); await refresh();
      assert.equal((await media()).playing, 0, 'a changed source report stops its old playback');
      await start(primary()); await menu('view:Agents'); assert.equal((await media()).playing, 0); await menu('view:Conversations');
    });
    await check('Disconnect stops playback and reconnect does not resume it automatically', async () => {
      await setMode('source'); await start(primary());
      const calls = (await speechCalls()).length;
      await publish({ kind: 'connection', connection: { status: 'disconnected', label: 'Fixture gateway', message: 'Fixture connection lost' } });
      await page.waitForFunction(() => !window.__readAloudMedia.players.some(player => player.__fixturePlaying));
      assert.equal(await button(primary()).isDisabled(), true);
      await publish({ kind: 'connection', connection: { status: 'connected', label: 'Fixture gateway' } });
      await page.waitForFunction(() => !document.querySelector('article[data-message-id^="report:"] [data-action="read-aloud"]')?.disabled);
      await page.waitForTimeout(300);
      assert.equal((await media()).playing, 0); assert.equal((await speechCalls()).length, calls);
    });
    await check('Unavailable speech, request failure and playback failure show feedback without automatic retry', async () => {
      for (const mode of ['unavailable', 'speech-error']) {
        await setMode(mode); const before = await speechCalls();
        await button(primary()).click();
        await page.waitForFunction(expected => document.querySelector('#toast')?.textContent === expected, mode === 'unavailable' ? 'Fixture speech provider is unavailable.' : 'Fixture speech request failed.');
        await page.waitForFunction(() => !document.querySelector('[data-action="read-aloud"][aria-label="Stop reading report"]'));
        const after = await speechCalls(); await page.waitForTimeout(200); assert.equal((await speechCalls()).length, after.length);
        if (mode === 'unavailable') assert.equal(after.filter(call => call.operation === 'speak').length, before.filter(call => call.operation === 'speak').length);
        assert.equal((await media()).playing, 0);
      }
      await setMode('source'); await page.evaluate(() => window.__readAloudMedia.rejectNext = true);
      await button(primary()).click(); await page.waitForFunction(() => !window.__readAloudMedia.rejectNext);
      await page.waitForFunction(() => !document.querySelector('[data-action="read-aloud"][aria-label="Stop reading report"]'));
      assert.equal((await media()).playing, 0); assert.match(await page.locator('#toast').textContent(), /Audio could not start/);
      await start(primary()); const count = (await speechCalls()).length; await page.evaluate(() => window.__readAloudMedia.fail());
      await page.waitForFunction(() => !document.querySelector('[data-action="read-aloud"][aria-label="Stop reading report"]'));
      await page.waitForTimeout(150); assert.equal((await speechCalls()).length, count); assert.match(await page.locator('#toast').textContent(), /Audio playback failed/);
    });
    await check('Long reports synthesize sequential bounded chunks and retain every prose word in order', async () => {
      await setMode('source', 80); const before = (await speechCalls()).filter(call => call.operation === 'speak').length;
      await start(longReport()); let chunks = 0;
      while (await button(longReport()).getAttribute('aria-label') === 'Stop reading report') {
        assert.equal((await media()).playing, 1); const requests = (await speechCalls()).filter(call => call.operation === 'speak').slice(before);
        assert.equal(requests.length, chunks + 1, 'the next chunk must not be requested before the current one ends');
        const plays = (await media()).plays.length; await page.evaluate(() => window.__readAloudMedia.end()); chunks++;
        await page.waitForFunction(plays => window.__readAloudMedia.plays.length > plays || !document.querySelector('[data-action="read-aloud"][aria-label="Stop reading report"]'), plays);
        if (chunks > 20) throw new Error('Long report did not finish within its bounded chunk count.');
      }
      const spoken = (await speechCalls()).filter(call => call.operation === 'speak').slice(before).map(call => call.params.text);
      assert.ok(spoken.length > 1); assert.ok(spoken.every(text => text.length > 0 && text.length <= 80));
      assert.equal(spoken.join(' ').replace(/\s+/g, ' ').trim(), longText); assert.equal((await media()).playing, 0);
      const audio = await media(); assert.ok(audio.blobs.every(blob => audio.revoked.includes(blob.url)), 'every completed or stopped clip is released');
    });
    await check('URL/file payloads and unsupported MIME types never become audio sources', async () => {
      for (const mode of ['url-audio', 'file-audio', 'bad-mime']) {
        await setMode(mode); const plays = (await media()).plays.length;
        await button(primary()).click();
        await page.waitForFunction(() => !document.querySelector('[data-action="read-aloud"][aria-label="Stop reading report"]'));
        assert.equal((await media()).plays.length, plays); assert.equal((await media()).playing, 0);
      }
      assert.deepEqual(network, []);
    });
    await check('Read and Stop controls remain reachable with reduced motion in a narrow window and no external effects', async () => {
      await setMode('source'); if (await page.locator('#work-panel').isVisible()) await page.locator('#toggle-work').click();
      await page.emulateMedia({ reducedMotion: 'reduce' }); await menu('theme:light');
      try {
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(880, 640));
        await button(primary()).scrollIntoViewIfNeeded(); await page.waitForTimeout(120);
        await page.waitForFunction(() => document.querySelector('#toast')?.textContent === '');
        const box = await button(primary()).boundingBox(), viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1);
        await button(primary()).focus(); await page.keyboard.press('Enter');
        await page.waitForFunction(() => window.__readAloudMedia.players.some(player => player.__fixturePlaying));
        assert.equal(await button(primary()).isEnabled(), true); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({ path: path.join(evidence, 'read-aloud-narrow-light.png') }); await stop(primary());
      } finally { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000)); }
      await menu('theme:dark'); await button(primary()).scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(evidence, 'read-aloud-dark.png') });
      assert.deepEqual(errors, []); assert.deepEqual(network, []); assert.deepEqual(await app.evaluate(() => globalThis.__readAloudFixture.native), []);
      assert.equal(cliCalls().some(call => ['chat.send', 'approval.resolve', 'config.patch', 'sessions.patch'].includes(call.method)), false);
    });
  } finally {
    await app.evaluate(() => { const state = globalThis.__readAloudFixture; state?.releases.splice(0).forEach(resolve => resolve()); }).catch(() => {});
    fs.writeFileSync(path.join(evidence, 'read-aloud-tests.json'), JSON.stringify({ at: new Date().toISOString(), checks, errors, network, profile, scope: 'Isolated native fixture using the real speech service and silent WAV output; media play/pause stubbed. No audible playback, production speech, external networking, credentials or provider changes.' }, null, 2));
    await app.close(); runningApp = null;
  }
  console.log(JSON.stringify({ passed: checks.filter(check => check.pass).length, failed: checks.filter(check => !check.pass).length, profile }));
  process.exitCode = checks.some(check => !check.pass) ? 1 : 0;
})().catch(async error => { console.error(error); if (runningApp) await runningApp.close().catch(() => {}); process.exitCode = 1; });
