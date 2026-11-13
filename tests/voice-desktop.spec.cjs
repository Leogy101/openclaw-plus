'use strict';
const { _electron } = require('./test-support.cjs').playwright;
const { evidenceDirectory } = require('./test-support.cjs');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), evidence = evidenceDirectory('voice');
const profile = fs.mkdtempSync(path.join(evidence, 'fixture-profile-'));
fs.writeFileSync(path.join(profile, 'fixture-voice.json'), '{}');
const env = { ...process.env, OPENCLAW_PLUS_TEST_DATA: profile, OPENCLAW_PLUS_TEST_CLI: path.join(root, 'tests/fixture-gateway.cjs') };
delete env.ELECTRON_RUN_AS_NODE;
const mainContext = { key: 'agent:main:main', agentId: 'main', sessionId: 'physical-main' };
const childContext = { key: 'agent:builder:child', agentId: 'builder', sessionId: 'physical-child' };
const finalDictation = 'Fixture dictation — no microphone data leaves this app.';
const cliCalls = () => fs.existsSync(path.join(profile, 'fixture-calls.jsonl')) ? fs.readFileSync(path.join(profile, 'fixture-calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
let runningApp;
(async () => {
  const app = await _electron.launch({ executablePath: path.join(root, 'desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [path.join(root, 'desktop')], env });
  runningApp = app;
  const page = await app.firstWindow(); page.setDefaultTimeout(12000);
  const checks = [], errors = [], network = [], diagnostics = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^(?:https?|wss?|file):/.test(request.url())) network.push(request.url()); });
  await app.evaluate(({ ipcMain, BrowserWindow, systemPreferences, shell }, gatePath) => {
    const window = BrowserWindow.getAllWindows()[0]; window.setSize(1440, 1000);
    const s = globalThis.__voiceFixture = { calls: [], events: [], asks: [], askMode: 'grant', releases: [], unavailable: false, native: [] };
    const send = window.webContents.send.bind(window.webContents);
    s.publish = event => send('gateway:event', event);
    window.webContents.send = (channel, event, ...rest) => {
      if (channel === 'gateway:event') return;
      if (channel === 'voice:event') s.events.push(structuredClone(event));
      return send(channel, event, ...rest);
    };
    const original = ipcMain._invokeHandlers.get('desktop:voice'); s.original = original;
    ipcMain.removeHandler('desktop:voice'); ipcMain.handle('desktop:voice', async (event, operation, params) => {
      const entry = { operation, params: structuredClone(params) }; s.calls.push(entry);
      if (operation === 'catalog' && s.unavailable) return { ok: true, data: { context: params, dictation: { available: false, reason: 'Fixture dictation is not configured.' }, conversation: { available: false, reason: 'Fixture Talk is not configured.' } } };
      const result = await original(event, operation, params); entry.result = structuredClone(result); return result;
    });
    const gateway = ipcMain._invokeHandlers.get('gateway:request');
    ipcMain.removeHandler('gateway:request'); ipcMain.handle('gateway:request', (event, operation, params) => operation === 'plan' ? { ok: true, data: { card: null } } : gateway(event, operation, params));
    systemPreferences.askForMediaAccess = type => {
      s.asks.push(type);
      if (s.askMode === 'hold') return new Promise(resolve => s.releases.push(resolve));
      return Promise.resolve(s.askMode !== 'deny');
    };
    const { MicrophonePermission } = process.mainModule.require(gatePath), request = MicrophonePermission.prototype.request;
    MicrophonePermission.prototype.request = function (ask) { s.gate = this; return request.call(this, ask); };
    shell.openExternal = async value => s.native.push(['external', value]); shell.openPath = async value => s.native.push(['open', value]);
  }, path.join(root, 'desktop/src/microphone-permission.cjs'));
  await page.addInitScript(() => {
    // Actual AudioWorklet and DSP, but no OS capture or audible output. A silent
    // synthetic MediaStream feeds the unmodified renderer capture pipeline.
    const NativeContext = window.AudioContext;
    const s = window.__voiceCapture = { calls: [], streams: [], contexts: [], modules: [], holds: [], holdMedia: false, played: 0 };
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async constraints => {
      s.calls.push(structuredClone(constraints));
      const context = new NativeContext({ sampleRate: 48000 }), source = context.createOscillator(), silence = context.createGain(), destination = context.createMediaStreamDestination();
      silence.gain.value = 0; source.connect(silence); silence.connect(destination); source.start(); await context.resume();
      const stream = destination.stream, record = { stream, context, stopped: 0 }; s.streams.push(record);
      for (const track of stream.getTracks()) {
        const stop = track.stop.bind(track); track.stop = () => { record.stopped++; stop(); try { source.stop(); } catch {} context.close().catch(() => {}); };
      }
      if (s.holdMedia) await new Promise(resolve => s.holds.push(resolve));
      return stream;
    } });
    window.AudioContext = function (options) {
      const context = new NativeContext(options); s.contexts.push(context);
      const add = context.audioWorklet.addModule.bind(context.audioWorklet);
      context.audioWorklet.addModule = async url => { await add(url); s.modules.push(url); };
      const create = context.createBufferSource.bind(context);
      context.createBufferSource = () => {
        const source = create(), connect = source.connect.bind(source), start = source.start.bind(source), silence = context.createGain();
        silence.gain.value = 0; silence.connect(context.destination);
        source.connect = () => connect(silence);
        source.start = (...args) => { s.played++; return start(...args); };
        return source;
      };
      return context;
    };
    window.AudioContext.prototype = NativeContext.prototype;
  });
  const calls = operation => app.evaluate((_electron, operation) => globalThis.__voiceFixture.calls.filter(call => call.operation === operation), operation);
  const waitMain = async predicate => { const deadline = Date.now() + 12000; while (!await app.evaluate(predicate)) { if (Date.now() > deadline) throw new Error('Voice fixture wait timed out.'); await page.waitForTimeout(25); } };
  const check = async (name, fn) => {
    try { await fn(); checks.push({ name, pass: true }); console.log('PASS', name); }
    catch (error) { checks.push({ name, pass: false, error: error.message }); console.log('FAIL', name, error.message); await page.screenshot({ path: path.join(evidence, `failure-${checks.length}.png`) }).catch(() => {}); throw error; }
  };
  // Selectors are the accessible user actions; no controller state is mutated.
  const openMenu = async () => { await page.getByRole('button', { name: 'Voice options', exact: true }).click(); };
  const start = async mode => { await openMenu(); await page.locator(`[data-action="voice-start"][data-mode="${mode}"]`).click(); };
  const stop = () => page.locator('#voice-status [data-action="voice-stop"]').click();
  const cancel = () => page.locator('#voice-status [data-action="voice-cancel"]').click();
  const ready = () => page.waitForFunction(() => document.querySelector('#voice-status [data-voice-phase]')?.dataset.voicePhase === 'listening');
  const finished = () => page.waitForFunction(() => !document.querySelector('#voice-status [data-voice-phase]'), null, { polling: 100 });
  const closeMenu = async () => { if (await page.getByRole('button', { name: 'Dictate', exact: true }).isVisible()) await page.getByRole('dialog', { name: 'Voice', exact: true }).getByRole('button', { name: 'Close dialog', exact: true }).click(); };
  try {
    await page.reload(); await page.getByText('Coordinator is coordinating.', { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('#composer-model')?.value);
    await check('Voice is explicit and offers two available modes without capture or session creation', async () => {
      assert.equal((await calls('catalog')).length, 0); assert.equal((await calls('start')).length, 0);
      await openMenu(); await page.getByRole('button', { name: 'Dictate', exact: true }).waitFor();
      await page.waitForFunction(() => document.querySelector('[data-action="voice-start"][data-mode="dictation"]')?.disabled === false);
      assert.equal(await page.getByRole('button', { name: 'Dictate', exact: true }).isEnabled(), true);
      assert.equal(await page.locator('[data-action="voice-start"][data-mode="conversation"]').isEnabled(), true);
      assert.deepEqual((await calls('catalog')).at(-1).params, mainContext);
      assert.equal(await app.evaluate(() => globalThis.__voiceFixture.asks.length), 0);
      assert.equal(await page.evaluate(() => window.__voiceCapture.calls.length), 0); assert.equal((await calls('start')).length, 0); await closeMenu();
    });
    await check('Unconfigured voice modes explain availability without asking for microphone access', async () => {
      await app.evaluate(() => { globalThis.__voiceFixture.unavailable = true; });
      await openMenu(); await page.getByText('Fixture dictation is not configured.', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Dictate', exact: true }).isDisabled(), true);
      assert.equal(await page.locator('[data-action="voice-start"][data-mode="conversation"]').isDisabled(), true);
      assert.equal(await app.evaluate(() => globalThis.__voiceFixture.asks.length), 0); await closeMenu();
      await app.evaluate(() => { globalThis.__voiceFixture.unavailable = false; });
    });
    await check('Dictation uses the real local worklet and appends final words to the exact existing draft only after Stop', async () => {
      await page.locator('#composer-input').fill('Existing draft.'); await start('dictation'); await ready();
      await waitMain(() => globalThis.__voiceFixture.calls.some(call => call.operation === 'audio' && call.result?.ok));
      assert.deepEqual((await calls('start')).at(-1).params, { ...mainContext, mode: 'dictation' });
      assert.equal(await page.locator('#composer-input').inputValue(), 'Existing draft.');
      assert.deepEqual(await page.evaluate(() => window.__voiceCapture.modules), ['openclaw-plus://ui/voice-capture-worklet.js']);
      assert.deepEqual(await page.evaluate(() => window.__voiceCapture.calls[0]), { audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      await page.locator('#composer-input').fill('Existing draft. Added while listening.');
      await app.evaluate(() => globalThis.__voiceFixture.publish({ kind: 'sessions' }));
      await stop(); await finished(); await page.waitForFunction(final => document.querySelector('#composer-input').value.includes(final), finalDictation);
      assert.equal(await page.locator('#composer-input').inputValue(), 'Existing draft. Added while listening.\n\n' + finalDictation);
      assert.equal(await page.evaluate(() => window.__voiceCapture.streams.every(record => record.stream.getTracks().every(track => track.readyState === 'ended'))), true);
      assert.equal(await page.evaluate(() => window.__voiceCapture.contexts.every(context => context.state === 'closed')), true);
      assert.equal(cliCalls().some(call => call.method === 'chat.send'), false);
    });
    await check('Stop during an outstanding OS permission request prevents later capture and native session creation', async () => {
      const captures = await page.evaluate(() => window.__voiceCapture.calls.length), starts = (await calls('start')).length;
      await app.evaluate(() => { globalThis.__voiceFixture.askMode = 'hold'; });
      await start('dictation'); await waitMain(() => globalThis.__voiceFixture.releases.length === 1);
      await cancel(); await finished();
      await app.evaluate(() => { const s = globalThis.__voiceFixture; s.askMode = 'grant'; s.releases.splice(0).forEach(resolve => resolve(true)); });
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => window.__voiceCapture.calls.length), captures); assert.equal((await calls('start')).length, starts);
    });
    await check('Late synthetic capture tracks are stopped after cancellation, never attached to a voice session', async () => {
      const starts = (await calls('start')).length;
      await page.evaluate(() => { window.__voiceCapture.holdMedia = true; });
      await start('dictation'); await page.waitForFunction(() => window.__voiceCapture.holds.length === 1);
      await cancel(); await finished();
      await page.evaluate(() => { const s = window.__voiceCapture; s.holdMedia = false; s.holds.splice(0).forEach(resolve => resolve()); });
      await page.waitForFunction(() => window.__voiceCapture.streams.every(record => record.stream.getTracks().every(track => track.readyState === 'ended')));
      assert.equal((await calls('start')).length, starts);
    });
    await check('Minimizing while capture is pending closes late tracks and cannot create a hidden voice session', async () => {
      const starts = (await calls('start')).length;
      await page.evaluate(() => { window.__voiceCapture.holdMedia = true; });
      await start('dictation'); await page.waitForFunction(() => window.__voiceCapture.holds.length === 1);
      try {
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
        await waitMain(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized());
        diagnostics.push({ minimized: await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; return { minimized: window.isMinimized(), visible: window.isVisible() }; }), renderer: await page.evaluate(() => ({ hidden: document.hidden, visibility: document.visibilityState, phase: document.querySelector('[data-voice-phase]')?.dataset.voicePhase })) });
        console.log('MINIMIZE', JSON.stringify(diagnostics.at(-1))); await finished();
        await page.evaluate(() => { const s = window.__voiceCapture; s.holdMedia = false; s.holds.splice(0).forEach(resolve => resolve()); });
        await page.waitForFunction(() => window.__voiceCapture.streams.every(record => record.stream.getTracks().every(track => track.readyState === 'ended')), null, { polling: 100 });
        assert.equal((await calls('start')).length, starts);
      } finally {
        await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.restore(); window.show(); window.focus(); });
        await page.waitForFunction(() => !document.hidden);
      }
    });
    await check('Navigation detaches capture and child dictation cannot replace the parent draft', async () => {
      await page.locator('#composer-input').fill('Parent draft stays here.'); await start('dictation'); await ready();
      if (!await page.locator('#work-panel').isVisible()) await page.locator('#toggle-work').click();
      await page.locator('#work-content [data-action="session"]').first().click(); await page.getByText('Builder exact child history', { exact: true }).waitFor(); await finished();
      await waitMain(() => globalThis.__voiceFixture.calls.some(call => call.operation === 'stop' && call.params.detach === true));
      assert.equal(await page.evaluate(() => window.__voiceCapture.streams.every(record => record.stream.getTracks().every(track => track.readyState === 'ended'))), true);
      await page.locator('#composer-input').fill('Child draft.'); await start('dictation'); await ready();
      assert.deepEqual((await calls('start')).at(-1).params, { ...childContext, mode: 'dictation' });
      await stop(); await finished(); await page.waitForFunction(final => document.querySelector('#composer-input').value.includes(final), finalDictation);
      assert.equal(await page.locator('#composer-input').inputValue(), 'Child draft.\n\n' + finalDictation);
      await page.getByRole('button', { name: 'Back to Coordinator' }).click(); await page.getByText('Coordinator is coordinating.', { exact: true }).waitFor();
      assert.equal(await page.locator('#composer-input').inputValue(), 'Parent draft stays here.');
    });
    await check('A disconnect stops capture and playback without an automatic restart', async () => {
      await start('dictation'); await ready(); const starts = (await calls('start')).length;
      await app.evaluate(() => globalThis.__voiceFixture.publish({ kind: 'connection', connection: { status: 'disconnected', label: 'Fixture gateway', message: 'Fixture disconnected' } }));
      await finished(); await page.waitForFunction(() => window.__voiceCapture.streams.every(record => record.stream.getTracks().every(track => track.readyState === 'ended')));
      assert.equal(await page.locator('#composer-input').inputValue(), 'Parent draft stays here.');
      await app.evaluate(() => globalThis.__voiceFixture.publish({ kind: 'connection', connection: { status: 'connected', label: 'Fixture gateway' } }));
      await page.waitForFunction(() => !document.querySelector('#composer-input').disabled); await page.waitForTimeout(300);
      assert.equal((await calls('start')).length, starts);
    });
    await check('Talk streams fixture PCM, displays its caption and acknowledges playback without sending the draft', async () => {
      await start('conversation'); await page.locator('.voice-caption').filter({ hasText: 'Fixture Talk — no audio reaches a provider.' }).waitFor();
      await waitMain(() => globalThis.__voiceFixture.calls.some(call => call.operation === 'played' && call.result?.ok));
      assert.deepEqual((await calls('start')).at(-1).params, { ...mainContext, mode: 'conversation' });
      assert.ok(await page.evaluate(() => window.__voiceCapture.played) > 0);
      const eventTypes = await app.evaluate(() => globalThis.__voiceFixture.events.filter(event => event.mode === 'conversation').map(event => event.type));
      for (const type of ['state', 'transcript', 'audio', 'mark']) assert.ok(eventTypes.includes(type), type);
      assert.equal(await page.locator('#composer-input').inputValue(), 'Parent draft stays here.'); await stop(); await finished();
      assert.equal((await calls('stop')).at(-1).params.detach, undefined);
      assert.equal(cliCalls().some(call => call.method === 'chat.send'), false);
    });
    await check('Stopping from the active voice menu makes the configured modes available without reopening it', async () => {
      await start('conversation'); await page.locator('.voice-caption').filter({ hasText: 'Fixture Talk — no audio reaches a provider.' }).waitFor();
      await openMenu(); const menu = page.getByRole('dialog', { name: 'Voice', exact: true });
      await menu.locator('[data-action="voice-stop"]').click(); await finished();
      await page.waitForFunction(() => document.querySelector('[data-action="voice-start"][data-mode="dictation"]')?.disabled === false);
      await menu.locator('[data-action="voice-start"][data-mode="dictation"]').click(); await ready(); await cancel(); await finished();
    });
    await check('Foreign frames, camera and combined media cannot use the explicit microphone grant', async () => {
      const result = await app.evaluate(async ({ BrowserWindow }) => {
        const s = globalThis.__voiceFixture, window = BrowserWindow.getAllWindows()[0], contents = window.webContents;
        const before = s.asks.length, foreign = await s.original({ sender: contents, senderFrame: { url: contents.getURL() } }, 'capturePermission', {});
        const sameAskCount = before === s.asks.length;
        await s.original({ sender: contents, senderFrame: contents.mainFrame }, 'capturePermission', {});
        const details = { isMainFrame: true, requestingUrl: contents.getURL() };
        const allowed = s.gate.allow(contents, 'media', { ...details, mediaTypes: ['audio'] });
        const denied = [s.gate.allow(contents, 'media', { ...details, mediaTypes: ['video'] }), s.gate.allow(contents, 'media', { ...details, mediaTypes: ['audio', 'video'] }), s.gate.allow(contents, 'media', { ...details, isMainFrame: false, mediaTypes: ['audio'] }), s.gate.allow({}, 'media', { ...details, mediaTypes: ['audio'] }), s.gate.allow(contents, 'media', { ...details, requestingUrl: 'https://example.invalid', mediaTypes: ['audio'] }), s.gate.check(contents, 'media', 'openclaw-plus://ui', { ...details, mediaType: 'video' })];
        await s.original({ sender: contents, senderFrame: contents.mainFrame }, 'capturePermission', { cancel: true });
        return { foreign, sameAskCount, allowed, denied, afterCancel: s.gate.allow(contents, 'media', { ...details, mediaTypes: ['audio'] }) };
      });
      assert.equal(result.foreign.ok, false); assert.equal(result.foreign.error.code, 'ACCESS'); assert.equal(result.sameAskCount, true);
      assert.equal(result.allowed, true); assert.deepEqual(result.denied, Array(6).fill(false)); assert.equal(result.afterCancel, false);
    });
    await check('Denied microphone access is explicit and narrow reduced-motion voice controls remain reachable', async () => {
      await app.evaluate(() => { globalThis.__voiceFixture.askMode = 'deny'; });
      const captures = await page.evaluate(() => window.__voiceCapture.calls.length); await start('dictation');
      await page.getByText('Microphone access was not granted. You can allow it in macOS settings and try again.', { exact: true }).waitFor(); await finished();
      assert.equal(await page.evaluate(() => window.__voiceCapture.calls.length), captures);
      await page.waitForFunction(() => !document.querySelector('#toast')?.textContent);
      await app.evaluate(() => { globalThis.__voiceFixture.askMode = 'grant'; });
      if (await page.locator('#work-panel').isVisible()) await page.locator('#toggle-work').click();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      try {
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(880, 640));
        await start('dictation'); await ready();
        const button = page.locator('#voice-status [data-action="voice-stop"]'); await button.scrollIntoViewIfNeeded();
        const box = await button.boundingBox(), size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width + 1 && box.y + box.height <= size.height + 1);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({ path: path.join(evidence, 'voice-narrow-reduced-motion.png') }); await stop(); await finished();
      } finally { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000)); }
      assert.deepEqual(errors, []); assert.deepEqual(network, []); assert.deepEqual(await app.evaluate(() => globalThis.__voiceFixture.native), []);
      assert.equal(cliCalls().some(call => ['chat.send', 'config.patch', 'sessions.patch', 'tts.speak'].includes(call.method)), false);
      assert.equal(await app.evaluate(() => globalThis.__voiceFixture.asks.every(type => type === 'microphone')), true);
    });
  } finally {
    await app.evaluate(() => globalThis.__voiceFixture?.releases.splice(0).forEach(resolve => resolve(false))).catch(() => {});
    await page.evaluate(() => { const s = window.__voiceCapture; s?.holds.splice(0).forEach(resolve => resolve()); for (const record of s?.streams || []) for (const track of record.stream.getTracks()) track.stop(); }).catch(() => {});
    fs.writeFileSync(path.join(evidence, 'voice-tests.json'), JSON.stringify({ at: new Date().toISOString(), checks, errors, network, diagnostics, profile, scope: 'Isolated native main/VoiceService fixture and real local AudioWorklet with synthetic silent MediaStream. OS permission prompt replaced; no physical microphone, provider, production gateway or audible playback.' }, null, 2));
    await app.close(); runningApp = null;
  }
  console.log(JSON.stringify({ passed: checks.filter(check => check.pass).length, failed: checks.filter(check => !check.pass).length, profile }));
  process.exitCode = checks.some(check => !check.pass) ? 1 : 0;
})().catch(async error => { console.error(error); if (runningApp) await runningApp.close().catch(() => {}); process.exitCode = 1; });
