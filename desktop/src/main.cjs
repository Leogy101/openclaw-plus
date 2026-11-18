'use strict';

const { app, BrowserWindow, Menu, protocol, session, ipcMain, nativeTheme, screen, dialog, shell, clipboard, systemPreferences } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { CliTransport, ReadError } = require('./gateway-cli.cjs');
const { GatewayService, validate } = require('./gateway-service.cjs');
const { ConversationActions } = require('./gateway-conversation.cjs');
const { InteractionService } = require('./gateway-actions.cjs');
const { ActivityService } = require('./gateway-activity.cjs');
const { AttachmentStore, attachmentContext, EXTENSIONS } = require('./attachments.cjs');
const { ComposerActions } = require('./composer-actions.cjs');
const { TerminalService } = require('./gateway-terminal.cjs');
const { SpeechService } = require('./gateway-speech.cjs');
const { PermissionService } = require('./gateway-permissions.cjs');
const { VoiceService } = require('./gateway-voice.cjs');
const { MicrophonePermission } = require('./microphone-permission.cjs');
const { ModelManagerService } = require('./model-manager.cjs');
const { GcbService, PROFILE_OPERATIONS } = require('./gcb-service.cjs');
const { authorizeProfileTarget, authorizeLocalProfileTarget } = require('./gcb-native.cjs');
const { nativeSetupUrl } = require('./model-rpc.cjs');
const { readProjectObservation } = require('./project-observation.cjs');
const INTERACTIVE = new Set(['plan','send','abort','createConversation','approvals','resolveApproval','settings','saveSettings','composerOptions','setComposer']);
const MUTATIONS = new Set(['send','abort','resolveApproval','saveSettings','setComposer']);

const NAME = 'OpenClaw+';
const ENTRY = 'openclaw-plus://ui/index.html';
const ROOT = path.resolve(__dirname, '..');
const testData = process.env.OPENCLAW_PLUS_TEST_DATA;
// Tests opt into a separate directory; normal use owns only this app's support directory.
const userData = !app.isPackaged && testData && path.isAbsolute(testData)
  ? testData : path.join(app.getPath('appData'), 'OpenClawPlus');
app.setName(NAME);
app.setPath('userData', userData);
app.setPath('sessionData', path.join(userData, 'Chromium'));
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');

protocol.registerSchemesAsPrivileged([{
  scheme: 'openclaw-plus',
  privileges: { standard: true, secure: true, supportFetchAPI: true },
}]);

let window;
let quitting = false;
let preferences = { theme: 'dark' };
let gateway;
let actions;
let activity;
let terminals;
let speech;
let permissions;
let voice;
let models;
let profiles;
let choosingProfileFile = false;
let closingProfiles = false;
const microphone = new MicrophonePermission({entry:ENTRY,contents:()=>window?.webContents});
let refreshTimer;
const attachments = new AttachmentStore();
let choosingAttachments = false;
function trustedFrame(event) {
  return window && !window.isDestroyed() && event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === ENTRY;
}
async function localFile(value) {
  if (typeof value !== 'string' || !value || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('This is not a supported local file path.');
  }
  let target = value;
  if (/^file:/i.test(target)) {
    const url = new URL(target);
    if (url.host && url.host !== 'localhost' || url.search || url.hash && !/^#L\d+(?:C\d+)?$/.test(url.hash)) {
      throw new Error('Only local file links can be revealed in Finder.');
    }
    url.hash = '';
    target = fileURLToPath(url);
  }
  if (target.startsWith('~/')) target = app.getPath('home') + '/' + target.slice(2);
  if (!path.isAbsolute(target) || target.startsWith('//') || /[\x00-\x1f\x7f]/.test(target)) {
    throw new Error('Only absolute local file paths can be revealed in Finder.');
  }
  // Prefer literal names. Line/column references are stripped only if the literal is absent.
  const candidates = [...new Set([target, target.replace(/(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)$/, '')])];
  for (const candidate of candidates) {
    try { await fs.promises.lstat(candidate); return candidate; }
    catch (error) { if (!['ENOENT','ENOTDIR'].includes(error.code)) throw new Error('Finder could not access this location.'); }
  }
  throw new Error('This file is not available on this Mac. It may have moved or its volume may be disconnected.');
}
const publish = event => { if(event.kind==='connection'){models?.invalidateConnection();profiles?.invalidateConnection();} if (window && !window.isDestroyed()) window.webContents.send('gateway:event', event); };
function getProfiles() {
  if (!models) models = new ModelManagerService({gateway:()=>getGateway(),registryPath:path.join(userData,'ModelManager','registry.json')});
  if (!profiles) profiles = new GcbService({directory:path.join(userData,'GCB'),home:app.getPath('home'),
    nativeHelper:app.isPackaged?path.join(process.resourcesPath,'gcb-openclaw.cjs'):path.join(__dirname,'gcb-openclaw.cjs'),
    authorizeTarget:snapshot=>authorizeProfileTarget({models,gateway:()=>getGateway()},snapshot),
    authorizeLocal:modelRef=>authorizeLocalProfileTarget({models,gateway:()=>getGateway()},modelRef),
    ...(!app.isPackaged && testData && path.isAbsolute(process.env.OPENCLAW_PLUS_TEST_GCB || '')
      ? {executable:process.env.OPENCLAW_PLUS_TEST_GCB} : {})});
  return profiles;
}
async function chooseProfileFile(operation, params) {
  if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).length)
    throw new ReadError('INVALID','This action accepts no file path or configuration from the page.');
  if (choosingProfileFile) throw new ReadError('BUSY','A GCB file chooser is already open.');
  choosingProfileFile = true;
  try {
    const importing = operation === 'modelsProfileImport';
    const selected = await dialog.showOpenDialog(window, {title:importing?'Choose a reviewed GCB host snapshot':'Choose your installed GCB executable',
      buttonLabel:importing?'Import snapshot':'Connect GCB',properties:['openFile'],
      ...(importing?{filters:[{name:'GCB host snapshot',extensions:['json']}]}:{})});
    if (selected.canceled || selected.filePaths.length !== 1) return {cancelled:true};
    const file = selected.filePaths[0];
    if (!importing) return getProfiles().connect(file);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new ReadError('INVALID','Choose a regular GCB host snapshot JSON file smaller than 64 KB.');
    const fd = fs.openSync(file,fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const current = fs.fstatSync(fd);
      if (current.ino !== stat.ino || current.dev !== stat.dev || current.size > 65536) throw new ReadError('INVALID','The selected snapshot changed. Select it again.');
      let snapshot;
      try { snapshot = JSON.parse(fs.readFileSync(fd,'utf8')); }
      catch { throw new ReadError('INVALID','The selected file is not valid snapshot JSON.'); }
      return await getProfiles().importSnapshot(snapshot);
    } finally { fs.closeSync(fd); }
  } finally { choosingProfileFile = false; }
}
function getGateway() {
  if (!gateway) {
    // Explicit development-only fixture seam. Packaged builds ignore these environment variables.
    const fixture = !app.isPackaged && testData && process.env.OPENCLAW_PLUS_TEST_CLI;
    const options = fixture && path.isAbsolute(fixture)
      ? {home:testData,cli:fixture,target:{url:'ws://127.0.0.1:19999',originalUrl:'http://127.0.0.1:19999/',configPath:path.join(testData,'fixture.json')}}
      : {home:app.getPath('home')};
    gateway = new GatewayService(new CliTransport({...options,...(app.isPackaged?{approvalHelper:path.join(process.resourcesPath,'approval-rpc.cjs'),composerHelper:path.join(process.resourcesPath,'composer-rpc.cjs'),modelHelper:path.join(process.resourcesPath,'model-rpc.cjs')}:{})}), publish);
  }
  return gateway;
}
function getTerminals() {
  if (!terminals) {
    const fixture = !app.isPackaged && testData && path.isAbsolute(process.env.OPENCLAW_PLUS_TEST_CLI || '');
    terminals = new TerminalService({
      transport: () => getGateway().transport,
      fixture: Boolean(fixture),
      helperPath: app.isPackaged ? path.join(process.resourcesPath, 'terminal-rpc.cjs') : path.join(__dirname, 'terminal-rpc.cjs'),
      notify: event => { if (window && !window.isDestroyed()) window.webContents.send('terminal:event', event); },
    });
  }
  return terminals;
}
function getVoice() {
  if (!voice) voice = new VoiceService({
    transport: () => getGateway().transport,
    fixture: Boolean(!app.isPackaged && testData && path.isAbsolute(process.env.OPENCLAW_PLUS_TEST_CLI || '')),
    helperPath: app.isPackaged ? path.join(process.resourcesPath, 'voice-rpc.cjs') : path.join(__dirname, 'voice-rpc.cjs'),
    notify: event => { if (window && !window.isDestroyed()) window.webContents.send('voice:event', event); },
  });
  return voice;
}
function closeVoice() {
  microphone.cancel();
  // macOS can minimize the native window without changing document.visibilityState.
  // Cancel renderer capture even while permission/getUserMedia has no native voice ID.
  try {
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('voice:event', {type:'capture-cancelled'});
  } catch { /* A crashed renderer cannot receive cancellation; close its native connection below. */ }
  const previous = voice; voice = undefined;
  previous?.close().catch(()=>{});
}
const preferenceFile = path.join(userData, 'desktop-preferences.json');
try {
  const stored = JSON.parse(fs.readFileSync(preferenceFile, 'utf8'));
  if (stored.theme === 'light' || stored.theme === 'dark') preferences.theme = stored.theme;
  if (stored.bounds && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(stored.bounds[k]))) {
    preferences.bounds = stored.bounds;
  }
} catch { /* First launch or invalid preferences uses defaults. */ }

function savePreferences() {
  try {
    fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
    fs.writeFileSync(preferenceFile + '.tmp', JSON.stringify(preferences, null, 2), { mode: 0o600 });
    fs.renameSync(preferenceFile + '.tmp', preferenceFile);
  } catch { /* A read-only support directory must not prevent the preview from opening. */ }
}

function initialBounds() {
  const primary = screen.getPrimaryDisplay().workArea;
  const b = preferences.bounds;
  if (b && b.width >= 880 && b.height >= 640) {
    const work = screen.getDisplayMatching(b).workArea;
    const width = Math.min(b.width, work.width), height = Math.min(b.height, work.height);
    return { width, height, x: Math.max(work.x, Math.min(b.x, work.x + work.width - width)),
      y: Math.max(work.y, Math.min(b.y, work.y + work.height - height)) };
  }
  return { width: Math.min(1440, primary.width), height: Math.min(920, primary.height) };
}

function showWindow() {
  if (!window || window.isDestroyed()) createWindow();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  publish({kind:'sessions'});
}

function command(value) {
  showWindow();
  const send = () => window?.webContents.send('desktop:command', value);
  if (window.webContents.isLoadingMainFrame()) window.webContents.once('did-finish-load', send);
  else send();
}

function createMenu() {
  const item = (id, label, accelerator, value = id) => ({
    id, label, accelerator, click: () => command(value),
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: NAME, submenu: [
      { role: 'about' }, { type: 'separator' },
      item('settings', 'Settings…', 'Command+,', 'settings'),
      { type: 'separator' }, { role: 'services' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
    ] },
    { label: 'File', submenu: [item('new', 'New Conversation…', 'Command+N'),
      item('quick-open', 'Quick Open…', 'Command+K'), { type: 'separator' }, { role: 'close' }] },
    { role: 'editMenu' },
    { label: 'View', submenu: [
      item('toggle-navigation', 'Toggle Navigation', 'Command+B'),
      item('toggle-work', 'Toggle Work Sidebar', 'Alt+Command+I'),
      item('toggle-terminal', 'Toggle Terminal Split', 'Control+`'),
      { type: 'separator' },
      ...['Conversations', 'Agents', 'Projects', 'Activity', 'Automations','Approvals','Models','Office'].map((name, i) =>
        item('view:' + name, name, 'Command+' + (i + 1))),
      { type: 'separator' },
      { label: 'Appearance', submenu: [item('theme:dark', 'Dark'), item('theme:light', 'Light')] },
      { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' }, { role: 'togglefullscreen' },
    ] },
    { role: 'windowMenu' },
    { label: 'Help', submenu: [item('settings-help', 'Connection Details…', undefined, 'settings'), {
      label: 'About This Connection', click: () => dialog.showMessageBox(window, {
        type: 'info', title: NAME, message: 'Your OpenClaw · Connected workspace',
        detail: 'View and message existing conversations, inspect your agent’s published checklist, review approvals and edit supported OpenClaw settings. Your existing gateway retains credentials, permissions and execution authority. Visible views refresh automatically; advanced capabilities remain available in the original interface.',
      }),
    }] },
  ]));
}

function createWindow() {
  window = new BrowserWindow({
    ...initialBounds(), minWidth: 880, minHeight: 640, show: false,
    title: NAME, titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: preferences.theme === 'dark' ? '#161314' : '#fcf9fa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      webviewTag: false, webSecurity: true, allowRunningInsecureContent: false,
      devTools: !app.isPackaged, spellcheck: false,
      additionalArguments: ['--openclaw-plus-theme=' + preferences.theme],
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('context-menu', (_event, params) => {
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()
      || params.frame !== window.webContents.mainFrame || params.frame?.url !== ENTRY) return;
    const edit = (role, flag) => ({ role, enabled: params.editFlags[flag] });
    const items = params.isEditable ? [
      edit('undo', 'canUndo'), edit('redo', 'canRedo'), { type: 'separator' },
      edit('cut', 'canCut'), edit('copy', 'canCopy'), edit('paste', 'canPaste'),
      { type: 'separator' }, edit('selectAll', 'canSelectAll'),
    ] : params.selectionText && params.editFlags.canCopy ? [{ role: 'copy' }] : [];
    // Native roles preserve the focused control, its selection and normal input events.
    if (items.length) Menu.buildFromTemplate(items).popup({ window, frame: params.frame });
  });
  window.webContents.on('will-navigate', (event, url) => { if (url !== ENTRY) event.preventDefault(); });
  window.webContents.on('will-frame-navigate', (event) => {
    if (event.url !== ENTRY) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.on('page-title-updated', event => event.preventDefault());
  window.on('close', event => {
    preferences.bounds = window.getNormalBounds();
    savePreferences();
    if (!quitting) { event.preventDefault(); window.hide(); }
  });
  window.on('closed', () => { window = null; });
  window.on('hide', closeVoice);
  window.on('minimize', closeVoice);
  window.webContents.on('render-process-gone', closeVoice);
  window.once('ready-to-show', () => window.show());
  window.loadURL(ENTRY);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.on('before-quit', event => {
    if (profiles && !closingProfiles) {
      event.preventDefault(); closingProfiles = true;
      Promise.resolve().then(()=>profiles.close()).catch(()=>{}).finally(()=>app.quit()); return;
    }
    quitting = true; clearInterval(refreshTimer); closeVoice(); terminals?.close(); gateway?.close();
  });
  app.on('activate', showWindow);
  app.whenReady().then(() => {
    nativeTheme.themeSource = preferences.theme;
    app.setAboutPanelOptions({ applicationName: NAME, applicationVersion: app.getVersion(),
      version: 'Connected OpenClaw workspace', copyright: 'OpenClaw+ contributors' });
    const assets = new Map([
      ['/index.html', ['index.html', 'text/html; charset=utf-8']],
      ['/app.css', ['app.css', 'text/css; charset=utf-8']],
      ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
      ['/models.css', ['models.css', 'text/css; charset=utf-8']],
      ['/models-view.mjs', ['models-view.mjs', 'text/javascript; charset=utf-8']],
      ['/profile-view.mjs', ['profile-view.mjs', 'text/javascript; charset=utf-8']],
      ['/office.css', ['office.css', 'text/css; charset=utf-8']],
      ['/office-view.mjs', ['office-view.mjs', 'text/javascript; charset=utf-8']],
      ['/office-scene.mjs', ['office-scene.mjs', 'text/javascript; charset=utf-8']],
      ['/content.mjs', ['content.mjs', 'text/javascript; charset=utf-8']],
      ['/terminal-view.mjs', ['terminal-view.mjs', 'text/javascript; charset=utf-8']],
      ['/read-aloud.mjs', ['read-aloud.mjs', 'text/javascript; charset=utf-8']],
      ['/voice-view.mjs', ['voice-view.mjs', 'text/javascript; charset=utf-8']],
      ['/voice-capture-worklet.js', ['voice-capture-worklet.js', 'text/javascript; charset=utf-8']],
      ['/vendor/xterm.mjs', ['vendor/xterm.mjs', 'text/javascript; charset=utf-8']],
      ['/vendor/addon-fit.mjs', ['vendor/addon-fit.mjs', 'text/javascript; charset=utf-8']],
      ['/vendor/xterm.css', ['vendor/xterm.css', 'text/css; charset=utf-8']],
      ['/shared/activity-model.mjs', ['../shared/activity-model.mjs', 'text/javascript; charset=utf-8']],
      ['/shared/office-cast.mjs', ['../shared/office-cast.mjs', 'text/javascript; charset=utf-8']],
      ['/shared/run-status.mjs', ['../shared/run-status.mjs', 'text/javascript; charset=utf-8']],
      ['/shared/helper-tasks.mjs', ['../shared/helper-tasks.mjs', 'text/javascript; charset=utf-8']],
      ['/shared/async-questions.mjs', ['../shared/async-questions.mjs', 'text/javascript; charset=utf-8']],
    ]);
    protocol.handle('openclaw-plus', request => {
      const url = new URL(request.url), asset = assets.get(url.pathname);
      if (url.host !== 'ui' || !asset || request.method !== 'GET' || url.search || url.hash) {
        return new Response('Not found', { status: 404 });
      }
      return new Response(fs.readFileSync(path.join(ROOT, 'renderer', asset[0])), {
        headers: { 'Content-Type': asset[1], 'X-Content-Type-Options': 'nosniff' },
      });
    });
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((contents, permission, callback, details) => callback(microphone.allow(contents,permission,details)));
    ses.setPermissionCheckHandler((contents, permission, origin, details) => microphone.check(contents,permission,origin,details));
    ses.on('will-download', event => event.preventDefault());
    ses.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url);
      const allowed = url.protocol === 'openclaw-plus:' && url.host === 'ui' && assets.has(url.pathname)
        || details.resourceType==='media' && /^blob:openclaw-plus:\/\/ui\/[a-f0-9-]{36}$/i.test(details.url);
      callback({ cancel: !allowed });
    });
    ipcMain.handle('desktop:terminal', async (event, operation, params) => {
      if (!trustedFrame(event)) return {ok:false,error:{code:'ACCESS',message:'Untrusted application frame.'}};
      try { return {ok:true,data:await getTerminals().handle(operation,params)}; }
      catch (error) {
        return {ok:false,error:{code:error instanceof ReadError?error.code:'UNAVAILABLE',
          message:error instanceof ReadError?error.message:'The terminal request could not be confirmed. Reconnect before entering more input.'}};
      }
    });
    ipcMain.handle('desktop:voice', async (event, operation, params = {}) => {
      if (!trustedFrame(event)) return {ok:false,error:{code:'ACCESS',message:'Untrusted application frame.'}};
      try {
        if ((operation==='start'||operation==='capturePermission'&&params?.cancel!==true) && (!window.isVisible()||window.isMinimized())) throw new ReadError('ACCESS','Open the app window before starting voice.');
        if (operation === 'capturePermission') {
          if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key=>key!=='cancel') || params.cancel!==undefined && typeof params.cancel!=='boolean') throw new ReadError('INVALID','Invalid microphone request.');
          if (params.cancel) { microphone.cancel(); return {ok:true,data:{granted:false}}; }
          const result = await microphone.request(()=>systemPreferences.askForMediaAccess('microphone'));
          if (!trustedFrame(event)) { microphone.cancel(); return {ok:true,data:{granted:false}}; }
          return {ok:true,data:result};
        }
        if (operation === 'stop') microphone.cancel();
        return {ok:true,data:await getVoice().handle(operation,params)};
      } catch (error) {
        return {ok:false,error:{code:error instanceof ReadError?error.code:'UNAVAILABLE',
          message:error instanceof ReadError?error.message:'Voice could not connect. Check microphone access and voice setup before trying again.'}};
      }
    });
    ipcMain.on('desktop:appearance', (event, theme) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
        || event.senderFrame.url !== ENTRY || !['dark', 'light'].includes(theme)) return;
      preferences.theme = theme;
      nativeTheme.themeSource = theme;
      window.setBackgroundColor(theme === 'dark' ? '#161314' : '#fcf9fa');
      savePreferences();
    });
    ipcMain.handle('desktop:copy-report', async (event, text) => {
      if (!trustedFrame(event)) return {ok:false,message:'Untrusted application frame.'};
      if (typeof text !== 'string' || !text.trim() || text.length > 262144) return {ok:false,message:'This report cannot be copied.'};
      try { await clipboard.writeText(text); return {ok:true}; }
      catch { return {ok:false,message:'The report could not be copied. Please try again.'}; }
    });
    ipcMain.handle('desktop:reveal-file', async (event, value) => {
      if (!trustedFrame(event)) return {ok:false,message:'Untrusted application frame.'};
      let target;
      try { target = await localFile(value); }
      catch (error) { return {ok:false,message:error instanceof TypeError ? 'This is not a supported local file path.' : error.message}; }
      if (!trustedFrame(event)) return {ok:false,message:'The application view has changed.'};
      try { shell.showItemInFolder(target); return {ok:true}; }
      catch { return {ok:false,message:'Finder could not reveal this item. Please try again.'}; }
    });
    ipcMain.handle('desktop:pick-attachments', async (event, params) => {
      if (!trustedFrame(event)) return {ok:false,error:{code:'DENIED',message:'Untrusted application frame.'}};
      if (choosingAttachments) return {ok:false,error:{code:'BUSY',message:'A file picker is already open.'}};
      choosingAttachments = true;
      try {
        if (!params || Object.keys(params).some(key => !['key','agentId','sessionId'].includes(key))) throw new ReadError('INVALID','Invalid attachment selection.');
        const selected = attachmentContext(params);
        const chosen = await dialog.showOpenDialog(window,{title:'Attach files',properties:['openFile','multiSelections'],filters:[{name:'Supported media and documents',extensions:EXTENSIONS}]});
        if (!trustedFrame(event)) throw new ReadError('STALE','The application view changed. Choose the files again.');
        if (chosen.canceled) return {ok:true,data:{items:[]}};
        const service = getGateway(), generation = service.generation;
        const result = await service.read('sessions.describe',{key:selected.key,agentId:selected.agentId},0);
        service.assertCurrent(generation);
        if (result?.session?.sessionId !== selected.sessionId || result.session.agentId !== undefined && result.session.agentId !== selected.agentId) throw new ReadError('SESSION_CHANGED','This session changed. Select it again before attaching files.');
        const items = await attachments.addFiles(selected,chosen.filePaths);
        return {ok:true,data:{items}};
      } catch (error) { return {ok:false,error:{code:error instanceof ReadError?error.code:'UNAVAILABLE',message:error instanceof ReadError?error.message:'Files could not be attached. Existing attachments are unchanged.'}}; }
      finally { choosingAttachments = false; }
    });
    ipcMain.handle('desktop:remove-attachment', async (event, params) => {
      if (!trustedFrame(event)) return {ok:false,error:{code:'DENIED',message:'Untrusted application frame.'}};
      try {
        if (!params || Object.keys(params).some(key => !['key','agentId','sessionId','id'].includes(key)) || typeof params.id !== 'string') throw new ReadError('INVALID','Invalid attachment selection.');
        attachments.remove(attachmentContext(params),params.id);
        return {ok:true,data:{removed:true}};
      } catch (error) { return {ok:false,error:{code:error instanceof ReadError?error.code:'UNAVAILABLE',message:error instanceof ReadError?error.message:'The attachment could not be removed.'}}; }
    });
    ipcMain.handle('desktop:models', async (event, operation, params) => {
      if (!trustedFrame(event)) return {ok:false,error:{code:'DENIED',message:'Untrusted application frame.'}};
      try {
        if (operation === 'modelsProfileConnect' || operation === 'modelsProfileImport')
          return {ok:true,data:await chooseProfileFile(operation,params)};
        if (PROFILE_OPERATIONS.includes(operation)) return {ok:true,data:await getProfiles().handle(operation,params)};
        if (!models) models = new ModelManagerService({gateway:()=>getGateway(),registryPath:path.join(userData,'ModelManager','registry.json')});
        const data = await models.handle(operation,params);
        if (operation === 'modelsOnboarding') {
          await shell.openExternal(nativeSetupUrl(getGateway().transport.target));
          return {ok:true,data:{...data,opened:true}};
        }
        return {ok:true,data};
      } catch(error) {
        return {ok:false,error:{code:error instanceof ReadError?error.code:'UNAVAILABLE',message:error instanceof ReadError?error.message:'Models could not complete this action. Refresh and review before trying again.'}};
      }
    });
    ipcMain.handle('gateway:request', async (event, operation, params) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
        || event.senderFrame.url !== ENTRY) return {ok:false,error:{code:'DENIED',message:'Untrusted application frame.'}};
      try {
        if (operation==='permissionOptions'||operation==='setPermissions') {
          const service=getGateway();
          if(permissions?.base!==service) permissions=new PermissionService(service,{isBusy:context=>Boolean(actions?.interaction.writing||actions?.composer.writing||actions?.conversation.hasPendingFor(context))});
          const data=await permissions.handle(operation,params);
          if(operation==='setPermissions') publish({kind:'sessions'});
          return {ok:true,data};
        }
        if (operation==='speechOptions'||operation==='speak') {
          const service=getGateway();
          if(speech?.base!==service) speech=new SpeechService(service);
          return {ok:true,data:await speech.handle(operation,params)};
        }
        if (operation === 'activity') {
          const service=getGateway();
          if(activity?.base!==service) activity=new ActivityService(service,{projectReader:!app.isPackaged&&testData?undefined:readProjectObservation});
          return {ok:true,data:await activity.read(params)};
        }
        if (INTERACTIVE.has(operation)) {
          const service=getGateway();
          if (actions?.gateway!==service) {
            const conversation = new ConversationActions(service,{attachments});
            if (actions?.conversation) {
              conversation.submissions = actions.conversation.submissions;
              conversation.creations = actions.conversation.creations;
            }
            actions={gateway:service,conversation,interaction:new InteractionService(service)};
            actions.composer = new ComposerActions(service,{isBusy:context=>actions.interaction.writing || actions.conversation.hasPendingFor(context) || permissions?.writing===true});
          }
          const handler=['plan','send','abort','createConversation'].includes(operation)?actions.conversation:['composerOptions','setComposer'].includes(operation)?actions.composer:actions.interaction;
          const data=await handler.handle(operation,params);
          if (MUTATIONS.has(operation)) { service.invalidate(); publish({kind:'sessions'}); publish({kind:'approvals'}); }
          if (operation==='createConversation') { service.invalidate(); publish({kind:'sessions'}); }
          return {ok:true,data};
        }
        validate(operation,params);
        if(operation==='reconnect') {
          closeVoice();
          gateway?.close(); gateway=undefined;
          const service=getGateway(); publish({kind:'connection',connection:service.snapshot()});
          return {ok:true,data:await service.overview({})};
        }
        const service=getGateway();
        if(operation==='original') {
          await shell.openExternal(service.transport.target.originalUrl);
          return {ok:true,data:{opened:true}};
        }
        return {ok:true,data:await service[operation](params)};
      } catch(error) {
        return {ok:false,error:{code:error instanceof ReadError?error.code:'UNAVAILABLE',
          message:error instanceof ReadError?error.message:'The request could not be completed. Refresh the view before trying again.',uncertain:error?.uncertain===true,
          notSent:['send','createConversation'].includes(operation)&&error instanceof ReadError&&error.preflight===true&&error.code!=='UNCERTAIN'}};
      }
    });
    createMenu();
    createWindow();
    let lastActivityRefresh=0;
    refreshTimer=setInterval(()=>{
      if(window?.isVisible() && !window.isMinimized()) {
        publish({kind:'sessions'});
        if(Date.now()-lastActivityRefresh>=15000){lastActivityRefresh=Date.now();publish({kind:'activity'});}
      }
    },3000);
  });
}
