const { contextBridge, ipcRenderer } = require('electron');

const allowed = new Set([
  'new', 'quick-open', 'toggle-navigation', 'toggle-work', 'toggle-terminal', 'settings', 'demo',
  'theme:light', 'theme:dark', 'view:Conversations', 'view:Agents',
  'view:Projects', 'view:Activity', 'view:Automations', 'view:Approvals', 'view:Models', 'view:Office',
]);
const initialTheme = process.argv.includes('--openclaw-plus-theme=light') ? 'light' : 'dark';

contextBridge.exposeInMainWorld('openclawPlusDesktop', Object.freeze({
  isDesktop: true,
  initialTheme,
  async models(operation, params = {}) {
    if (!['modelsOverview','modelsPlanRegistration','modelsRegister','modelsRefresh','modelsOnboarding',
      'modelsProfileOverview','modelsProfileConnect','modelsProfileImport','modelsProfileLocal','modelsProfileResearch','modelsProfilePlan',
      'modelsProfileStart','modelsProfilePause','modelsProfileCancel','modelsProfilePreview','modelsProfileEvidence'].includes(operation)) return {ok:false,error:{code:'INVALID',message:'Unsupported Models operation.'}};
    return ipcRenderer.invoke('desktop:models', operation, params);
  },
  async voice(operation, params = {}) {
    if (!['catalog','capturePermission','start','audio','played','stop'].includes(operation)) throw new Error('Unsupported voice operation.');
    const result = await ipcRenderer.invoke('desktop:voice', operation, params);
    if (!result?.ok) throw Object.assign(new Error(result?.error?.message || 'Voice could not connect.'),{code:result?.error?.code});
    return result.data;
  },
  onVoiceEvent(callback) {
    if (typeof callback !== 'function') throw new TypeError('A callback is required');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('voice:event',listener);
    return () => ipcRenderer.removeListener('voice:event',listener);
  },
  async terminal(operation, params = {}) {
    if (!['list','open','attach','input','resize','detach'].includes(operation)) throw new Error('Unsupported terminal operation.');
    const result = await ipcRenderer.invoke('desktop:terminal', operation, params);
    if (!result?.ok) throw Object.assign(new Error(result?.error?.message || 'The terminal request could not be completed.'),{code:result?.error?.code});
    return result.data;
  },
  onTerminalEvent(callback) {
    if (typeof callback !== 'function') throw new TypeError('A callback is required');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('terminal:event',listener);
    return () => ipcRenderer.removeListener('terminal:event',listener);
  },
  async pickAttachments(context) {
    const result = await ipcRenderer.invoke('desktop:pick-attachments',context);
    if (!result?.ok) throw Object.assign(new Error(result?.error?.message || 'Files could not be attached.'),{code:result?.error?.code});
    return result.data;
  },
  async removeAttachment(params) {
    const result = await ipcRenderer.invoke('desktop:remove-attachment',params);
    if (!result?.ok) throw Object.assign(new Error(result?.error?.message || 'The attachment could not be removed.'),{code:result?.error?.code});
    return result.data;
  },
  async copyReport(text) {
    const result = await ipcRenderer.invoke('desktop:copy-report', text);
    if (!result?.ok) throw new Error(result?.message || 'The report could not be copied.');
  },
  async revealFile(path) {
    const result = await ipcRenderer.invoke('desktop:reveal-file', path);
    if (!result?.ok) throw new Error(result?.message || 'Finder could not reveal this item.');
  },
  async gateway(operation, params = {}) {
    if (!['overview','history','work','office','automations','reconnect','original','plan','send','abort','createConversation','approvals','resolveApproval','settings','saveSettings','activity','composerOptions','setComposer','slashCommandCatalog','speechOptions','speak','permissionOptions','setPermissions'].includes(operation)) {
      return {ok:false,error:{code:'INVALID',message:'Unsupported workspace operation.'}};
    }
    // Structured errors preserve machine-readable state across Electron's isolated bridge.
    return ipcRenderer.invoke('gateway:request', operation, params);
  },
  onGatewayEvent(callback) {
    if(typeof callback !== 'function') throw new TypeError('A callback is required');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('gateway:event',listener);
    return () => ipcRenderer.removeListener('gateway:event',listener);
  },
  onCommand(callback) {
    if (typeof callback !== 'function') throw new TypeError('A callback is required');
    const listener = (_event, command) => {
      if (allowed.has(command)) callback(command);
    };
    ipcRenderer.on('desktop:command', listener);
    return () => ipcRenderer.removeListener('desktop:command', listener);
  },
  setAppearance(theme) {
    if (theme === 'dark' || theme === 'light') ipcRenderer.send('desktop:appearance', theme);
  },
}));
