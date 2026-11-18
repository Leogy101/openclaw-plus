'use strict';
const { _electron } = require('./test-support.cjs').playwright;
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const evidence = require('./test-support.cjs').evidenceDirectory('office');
const profile = fs.mkdtempSync(path.join(evidence, 'fixture-profile-'));
const env = { ...process.env, OPENCLAW_PLUS_TEST_DATA: profile, OPENCLAW_PLUS_TEST_CLI: path.join(root, 'tests/fixture-gateway.cjs') };
delete env.ELECTRON_RUN_AS_NODE;

(async () => {
  const app = await _electron.launch({ executablePath: path.join(root, 'desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [path.join(root, 'desktop')], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const checks = [], errors = [], network = [], screenshots = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^(?:https?|wss?):/.test(request.url())) network.push(request.url()); });
  await app.evaluate(({ ipcMain, BrowserWindow, shell, clipboard }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(1440, 1000);
    const original = ipcMain._invokeHandlers.get('gateway:request');
    const send = window.webContents.send.bind(window.webContents);
    const state = globalThis.__officeFixture = {
      calls: [], native: [], terminal: [], projection: {
        observedAt: Date.now(), limited: true,
        // These names and events are synthetic demonstration data, not observed user work.
        agents: [
          { id: 'main', name: 'Tom', state: 'idle' },
          { id: 'spike', name: 'Spike', state: 'working' },
          { id: 'athena', name: 'Athena', state: 'working' },
          { id: 'goose', name: 'Goose', state: 'unknown' },
          { id: 'steve', name: 'Steve', state: 'idle' },
          { id: 'gemini', name: 'Gemini', state: 'unknown' },
          { id: 'chatgpt', name: 'ChatGPT', state: 'working' },
        ],
        events: [
          { id: 'historical-report', kind: 'report', from: 'main', to: null, at: Date.now() - 60000 },
          { id: 'outside-cast', kind: 'handoff', from: 'chatgpt', to: 'main', at: Date.now() - 1000 },
        ],
      },
    };
    state.publish = event => send('gateway:event', event);
    // The suite controls invalidations; native host timers must not race its event clock.
    window.webContents.send = (channel, event, ...rest) => {
      if (channel === 'gateway:event') return;
      return send(channel, event, ...rest);
    };
    ipcMain.removeHandler('gateway:request');
    ipcMain.handle('gateway:request', async (event, operation, params) => {
      state.calls.push({ operation, params });
      if (operation === 'office') return { ok: true, data: structuredClone(state.projection) };
      return original(event, operation, params);
    });
    const terminal = ipcMain._invokeHandlers.get('desktop:terminal');
    ipcMain.removeHandler('desktop:terminal');
    ipcMain.handle('desktop:terminal', (event, operation, params) => {
      state.terminal.push(operation);
      return terminal(event, operation, params);
    });
    shell.openExternal = async value => { state.native.push(['external', value]); };
    shell.showItemInFolder = value => state.native.push(['reveal', value]);
    clipboard.writeText = value => state.native.push(['copy', value]);
  });

  const menu = id => app.evaluate(({ Menu }, id) => {
    const item = Menu.getApplicationMenu().getMenuItemById(id);
    if (!item) throw new Error('Missing native menu item: ' + id);
    item.click();
  }, id);
  const calls = () => app.evaluate(() => globalThis.__officeFixture.calls);
  const officeCount = async () => (await calls()).filter(call => call.operation === 'office').length;
  const publish = event => app.evaluate((_, event) => globalThis.__officeFixture.publish(event), event);
  const refresh = async (event, age = 0) => {
    const before = await officeCount();
    await app.evaluate((_, { event, age }) => {
      const state = globalThis.__officeFixture;
      state.projection.observedAt = Date.now() - age;
      if (event) state.projection.events = [{ ...event, at: Date.now() }];
      state.publish({ kind: 'activity' });
    }, { event, age });
    const deadline = Date.now() + 12000;
    while (await officeCount() === before) {
      if (Date.now() >= deadline) throw new Error('Office did not consume the fixture invalidation.');
      await page.waitForTimeout(25);
    }
  };
  const status = kind => page.locator(`.office-status[data-kind="${kind}"]`);
  const animated = kind => page.locator(`.office-status[data-kind="${kind}"][data-animating="true"]`);
  const staticStatus = kind => page.locator(`.office-status[data-kind="${kind}"][data-animating="false"]`);
  const canvasFrame = () => page.locator('.office-canvas').evaluate(canvas => canvas.toDataURL());
  const capture = async (file, description) => {
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
    fs.writeFileSync(path.join(evidence, file), Buffer.from(png, 'base64'));
    screenshots.push({ file, description, synthetic: true });
  };
  const check = async (name, run) => {
    try { await run(); checks.push({ name, pass: true }); console.log('PASS', name); }
    catch (error) {
      checks.push({ name, pass: false, error: error.message });
      await capture('failure-' + checks.length + '.png', 'Fixture-only failure capture').catch(() => {});
      throw error;
    }
  };

  try {
    await page.reload();
    await page.getByText('Coordinator is coordinating.', { exact: true }).waitFor();
    await page.locator('#composer-input').fill('Preserve this offline draft while visiting the Office.');
    const panelWasVisible = await page.locator('#work-panel').isVisible();
    const terminalWasVisible = await page.locator('#terminal-mount').isVisible();
    assert.equal(await officeCount(), 0, 'Office must not read metadata before navigation');

    await check('Native Office navigation mounts a read-only scene and keeps historical events static', async () => {
      assert.ok(await page.locator('#primary-nav').getByRole('button', { name: 'The Office', exact: true }).isVisible());
      assert.equal(await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('view:Office').label), 'The Office');
      await menu('view:Office');
      await page.locator('.office-connection[data-state="live"]').waitFor();
      await staticStatus('report').waitFor();
      assert.ok(await page.getByRole('heading', { name: 'The Office', exact: true }).isVisible());
      assert.deepEqual(await page.locator('.office-roster strong').allTextContents(), ['The Boss', 'Tom', 'Spike', 'Athena', 'Goose']);
      assert.equal(await page.locator('.office-agent[data-state="working"]').count(), 2);
      assert.equal(await page.locator('.office-agent[data-state="unknown"]').count(), 1);
      assert.match(await status('report').textContent(), /Tom.*The Boss.*Final reply recorded/s);
      assert.match(await page.locator('.office-note').textContent(), /partial/i);
      const canvas = await page.locator('.office-stage canvas').boundingBox();
      assert.ok(canvas && canvas.width > 200 && canvas.height > 100, 'scene must occupy visible space');
      assert.equal(await page.locator('.office-page button,.office-page input,.office-page textarea,.office-page select,.office-page a[href]').count(), 0);
      assert.equal(await page.locator('#toggle-work').isVisible(), false);
      assert.equal(await page.locator('#toggle-terminal').isVisible(), false);
      await page.evaluate(() => { window.__officeCanvas = document.querySelector('.office-stage canvas'); });
      await capture('office-history-dark-1440.png', 'Synthetic office roster with a historical final reply; no replay animation');
    });

    await check('Idle characters move around the break area using only the existing observation', async () => {
      const saved = await app.evaluate(() => {
        const agents = globalThis.__officeFixture.projection.agents;
        const initial = structuredClone(agents);
        for (const agent of agents) agent.state = agent.id === 'goose' ? 'idle' : 'unknown';
        return initial;
      });
      await refresh();
      await page.locator('.office-agent[data-state="idle"]').filter({ hasText: 'Goose' }).waitFor();
      assert.equal(await page.locator('.office-agent[data-state="working"]').count(), 0);
      const before = await officeCount();
      const first = await canvasFrame();
      await page.waitForFunction(previous => document.querySelector('.office-canvas').toDataURL() !== previous, first, { polling: 120, timeout: 5000 });
      assert.equal(await officeCount(), before, 'ambient activity must not trigger Office reads');
      await capture('office-break-dark-1440.png', 'Goose takes a break while the other agents have unknown activity');
      await app.evaluate(() => { globalThis.__officeFixture.projection.agents.find(agent => agent.id === 'goose').state = 'unknown'; });
      await refresh();
      await page.waitForFunction(() => document.querySelectorAll('.office-agent[data-state="unknown"]').length === 4);
      const stationary = await canvasFrame();
      await page.waitForTimeout(450);
      assert.equal(await canvasFrame(), stationary, 'unknown activity must not animate a break');
      await app.evaluate((_, agents) => { globalThis.__officeFixture.projection.agents = agents; }, saved);
      await refresh();
      await page.locator('.office-agent[data-state="working"]').filter({ hasText: 'Spike' }).waitFor();
    });

    await check('A fresh delegation animates once and unchanged refreshes preserve the scene', async () => {
      await refresh({ id: 'delegation-1', kind: 'delegation', from: 'main', to: 'spike' });
      await animated('delegation').waitFor();
      assert.match(await status('delegation').textContent(), /Tom.*Spike.*Task delegated/s);
      await page.waitForTimeout(1400);
      await capture('office-delegation-dark-1440.png', 'Synthetic Tom-to-Spike delegation in progress');
      await staticStatus('delegation').waitFor({ timeout: 25000 });
      await refresh();
      await page.waitForTimeout(150);
      assert.equal(await animated('delegation').count(), 0, 'a previously seen event must not replay');
      await refresh({ id: 'hidden-handoff', kind: 'handoff', from: 'spike', to: 'chatgpt' });
      await page.waitForTimeout(150);
      assert.equal(await animated('handoff').count(), 0, 'a route outside the visible team must not play');
      assert.match(await status('delegation').textContent(), /Tom.*Spike/);
      assert.equal(await page.evaluate(() => window.__officeCanvas === document.querySelector('.office-stage canvas')), true);
    });

    await check('Recorded handoffs and owner replies remain legible in light and narrow layouts', async () => {
      await menu('theme:light');
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 850));
      await page.waitForFunction(() => innerWidth === 1100);
      await refresh({ id: 'handoff-1', kind: 'handoff', from: 'spike', to: 'athena' });
      await animated('handoff').waitFor();
      assert.match(await status('handoff').textContent(), /Spike.*Athena.*Handoff recorded/s);
      await page.waitForTimeout(1400);
      await capture('office-handoff-light-1100.png', 'Synthetic Spike-to-Athena handoff with the explanatory status card');
      await staticStatus('handoff').waitFor({ timeout: 25000 });
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(880, 760));
      await page.waitForFunction(() => innerWidth === 880);
      await refresh({ id: 'report-1', kind: 'report', from: 'main', to: null });
      await animated('report').waitFor();
      assert.match(await status('report').textContent(), /Tom.*The Boss.*Final reply recorded/s);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(await page.locator('.office-page').evaluate(node => node.scrollWidth > node.clientWidth), false);
      const layout = await page.locator('.office-stage').evaluate(node => {
        const stage = node.getBoundingClientRect(), card = node.querySelector('.office-status').getBoundingClientRect();
        return { stageLeft: stage.left, stageRight: stage.right, cardLeft: card.left, cardRight: card.right };
      });
      assert.ok(layout.cardLeft >= layout.stageLeft - 1 && layout.cardRight <= layout.stageRight + 1, 'status card must fit the scene');
      await page.waitForTimeout(2500);
      await capture('office-report-light-880.png', 'Synthetic Tom final reply arriving at The Boss’s room');
      await menu('theme:dark');
      await capture('office-report-dark-880.png', 'The same synthetic final reply in the narrow dark layout');
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.5));
      await page.waitForFunction(() => innerWidth < 600);
      assert.equal(await page.locator('.office-page').evaluate(node => node.scrollWidth > node.clientWidth), false);
      assert.equal(await page.locator('.office-stage').evaluate(node => node.scrollWidth > node.clientWidth + 1), false);
      await capture('office-zoom-dark-880.png', 'The open plan scaled to a narrow viewport at 150% zoom');
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
      await page.waitForFunction(() => innerWidth === 880);
    });

    await check('Reduced motion keeps the canvas stationary while retaining a readable event receipt', async () => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await staticStatus('report').waitFor({ timeout: 25000 });
      await refresh({ id: 'report-reduced', kind: 'report', from: 'main', to: null });
      await animated('report').waitFor();
      await page.waitForTimeout(100);
      const first = await page.locator('.office-stage canvas').evaluate(node => node.toDataURL());
      await page.waitForTimeout(300);
      const second = await page.locator('.office-stage canvas').evaluate(node => node.toDataURL());
      assert.equal(second, first, 'reduced-motion canvas must not walk, type, or flash');
      await staticStatus('report').waitFor({ timeout: 5000 });
      await page.emulateMedia({ reducedMotion: 'no-preference' });
    });

    await check('Expired and disconnected observations stop motion and mark agent activity unknown', async () => {
      await refresh(null, 44000);
      const beforeExpiry = await officeCount();
      await page.locator('.office-connection[data-state="stale"]').waitFor({ timeout: 5000 });
      assert.equal(await page.locator('.office-agent[data-state="working"]').count(), 0);
      assert.equal(await page.locator('.office-agent[data-state="unknown"]').count(), 4);
      assert.equal(await officeCount(), beforeExpiry, 'freshness expiry must not poll the backend');
      await refresh({ id: 'disconnect-handoff', kind: 'handoff', from: 'spike', to: 'athena' });
      await animated('handoff').waitFor();
      await publish({ kind: 'connection', connection: { status: 'disconnected', message: 'Fixture disconnected' } });
      await page.locator('.office-connection[data-state="offline"]').waitFor();
      assert.equal(await page.locator('.office-status[data-animating="true"]').count(), 0);
      assert.equal(await page.locator('.office-agent[data-state="working"]').count(), 0);
      const first = await canvasFrame();
      await page.waitForTimeout(400);
      assert.equal(await canvasFrame(), first, 'disconnected cast must remain stationary');
      await capture('office-disconnected-dark-880.png', 'Synthetic disconnected observation; no working or transfer animation');
      await publish({ kind: 'connection', connection: { status: 'connected', label: 'Fixture gateway' } });
      await page.locator('.office-connection[data-state="live"]').waitFor();
    });

    await check('The cast uses its fixed names and leaving Office preserves the conversation', async () => {
      await app.evaluate(() => {
        const main = globalThis.__officeFixture.projection.agents.find(agent => agent.id === 'main');
        main.name = '<img src=x onerror="window.officeIntruded=true">';
        main.state = 'working';
      });
      await refresh();
      await page.locator('.office-agent[data-state="working"]').filter({ hasText: 'Tom' }).waitFor();
      assert.equal(await page.locator('.office-page img,.office-page script').count(), 0);
      assert.equal(await page.evaluate(() => window.officeIntruded), undefined);
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000));
      await page.waitForFunction(() => innerWidth === 1440);
      await menu('view:Conversations');
      await page.getByText('Coordinator is coordinating.', { exact: true }).waitFor();
      assert.equal(await page.locator('#composer-input').inputValue(), 'Preserve this offline draft while visiting the Office.');
      assert.equal(await page.locator('#work-panel').isVisible(), panelWasVisible);
      assert.equal(await page.locator('#terminal-mount').isVisible(), terminalWasVisible);
      const afterLeave = await officeCount();
      await publish({ kind: 'activity' });
      await publish({ kind: 'sessions' });
      await page.waitForTimeout(700);
      assert.equal(await officeCount(), afterLeave, 'hidden Office must not read on host invalidations');
      assert.equal(await page.locator('.office-page').count(), 0);
    });

    await check('Office uses only empty read requests and fixture-only native operations', async () => {
      const received = await calls();
      for (const call of received.filter(call => call.operation === 'office')) assert.deepEqual(call.params, {});
      assert.deepEqual(await app.evaluate(() => globalThis.__officeFixture.native), []);
      assert.deepEqual(await app.evaluate(() => globalThis.__officeFixture.terminal), []);
      const fixtureCalls = fs.readFileSync(path.join(profile, 'fixture-calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
      const reads = new Set(['agents.list', 'sessions.list', 'sessions.describe', 'chat.history', 'progressCard.get', 'sessions.processes.list', 'audit.activity.list', 'cron.list', 'cron.runs', 'exec.approval.list', 'plugin.approval.list', 'openclaw.approval.list', 'approval.get', 'models.list', 'config.get', 'commands.list', 'tts.status']);
      const unexpected = [...new Set(fixtureCalls.map(call => call.method).filter(method => !reads.has(method)))];
      assert.deepEqual(unexpected, [], 'fixture calls must stay within the existing read operations');
      assert.deepEqual(errors, []);
      assert.deepEqual(network, []);
    });
  } finally {
    fs.writeFileSync(path.join(evidence, 'office-tests.json'), JSON.stringify({ at: new Date().toISOString(), checks, errors, network, screenshots,
      scope: 'Native Electron shell and Office renderer with synthetic metadata through fixture IPC; no production Gateway, model calls, or project observations.' }, null, 2));
    await app.close();
    console.log('Evidence:', evidence);
  }
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
