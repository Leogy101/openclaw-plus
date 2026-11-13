'use strict';
// Prepared catalog only. No probe, provider discovery, login, config write or inference lane.
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const OPERATIONS = new Set(['capabilities', 'catalog']);
const CAPABILITIES = ['published-model-catalog', 'session-scoped-model-catalog'];
const text = (value, max = 512) => typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value) ? value : undefined;

function validateRequest(operation, expectUrl, extra = []) {
  if (!OPERATIONS.has(operation) || extra.length || !/^ws:\/\/127\.0\.0\.1:\d{1,5}$/.test(expectUrl || '')) throw Object.assign(new Error('Unsupported model read.'), { code: 'INVALID_REQUEST' });
  const port = Number(new URL(expectUrl).port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Object.assign(new Error('Invalid endpoint.'), { code: 'INVALID_REQUEST' });
}
function capabilities(hello) {
  if (!Number.isSafeInteger(hello?.protocol) || hello.protocol < 1 || !/^[0-9A-Za-z.+_-]{1,96}$/.test(hello?.server?.version || '') || !Array.isArray(hello?.features?.methods)) throw Object.assign(new Error('Unsupported handshake.'), { code: 'UNSUPPORTED' });
  const methods = ['models.list'].filter(name => hello.features.methods.includes(name));
  const caps = CAPABILITIES.filter(name => Array.isArray(hello.features.capabilities) && hello.features.capabilities.includes(name));
  return { version: hello.server.version, protocol: hello.protocol, methods, capabilities: caps,
    clientCaps: ['model-selection-policy'], available: methods.length === 1 && caps.includes('published-model-catalog') };
}
function catalogResult(raw) {
  if (!raw || !Array.isArray(raw.models)) throw Object.assign(new Error('Unsupported catalog.'), { code: 'UNSUPPORTED' });
  // Do not forward provider credentials, URLs, arbitrary diagnostics or new upstream fields.
  return { models: raw.models.slice(0, 1001).map(row => {
    if (!row || typeof row !== 'object') return {};
    const item = {};
    for (const key of ['provider', 'id', 'name', 'thinkingDefault']) if (text(row[key]) !== undefined) item[key] = row[key];
    for (const key of ['available', 'manualSelectionAllowed', 'reasoning', 'local', 'supportsTools', 'apiKeySupported']) if (typeof row[key] === 'boolean') item[key] = row[key];
    for (const key of ['contextWindow', 'unavailableUntil']) if (Number.isSafeInteger(row[key]) && row[key] > 0) item[key] = row[key];
    if (['missing-auth', 'auth-failed', 'cooldown'].includes(row.unavailableReason)) item.unavailableReason = row.unavailableReason;
    if (Array.isArray(row.input)) item.input = row.input.filter(value => ['text', 'image', 'audio', 'video', 'document'].includes(value));
    if (text(row.agentRuntime?.id, 80)) item.agentRuntime = { id: row.agentRuntime.id };
    if (Array.isArray(row.thinkingLevels)) item.thinkingLevels = row.thinkingLevels.slice(0, 20).filter(level => text(level?.id,80) && text(level?.label,120)).map(({id,label}) => ({id,label}));
    return item;
  }), ...(raw.refreshFailed === true ? { refreshFailed: true } : {}),
  pendingProviders: Array.isArray(raw.pendingProviders) ? raw.pendingProviders.filter(value => text(value,128)).slice(0,1000) : [] };
}
function nativeSetupUrl(target) {
  const url = new URL(target.originalUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash) throw new Error('Unsupported native setup endpoint.');
  const base = target.controlUiBasePath || '';
  if (typeof base !== 'string' || base.length > 512 || base && (!base.startsWith('/') || /[?#\\\x00-\x20%]/u.test(base) || base.split('/').some(segment => segment === '..' || segment === '.'))) throw new Error('Unsupported native UI path.');
  url.pathname = base.replace(/\/+$/u, '') + '/settings/model-setup';
  return url.href;
}
async function readNative(operation, expectUrl, { GatewayClient, config, resolved, deadline = 10000 }) {
  validateRequest(operation, expectUrl);
  const gateway = config?.gateway, port = gateway?.port ?? 18789;
  if (gateway?.mode !== 'local' || gateway.bind !== 'loopback' || gateway.tls?.enabled || expectUrl !== `ws://127.0.0.1:${port}` || !['token', 'password'].includes(gateway.auth?.mode) || resolved?.unresolvedRefReason || !resolved?.value) throw Object.assign(new Error('Configured connection unavailable.'), { code: 'UNAUTHORIZED' });
  return new Promise((resolve, reject) => {
    let client, settled = false, requested = false;
    const finish = (error, result) => {
      if (settled) return; settled = true; clearTimeout(timer);
      try { client?.stop(); } catch { /* No raw diagnostics cross this boundary. */ }
      if (error) reject(error); else resolve(result);
    };
    const fail = code => finish(Object.assign(new Error('Native model read unavailable.'), { code }));
    const timer = setTimeout(() => fail('TIMEOUT'), deadline);
    client = new GatewayClient({ url: expectUrl, [gateway.auth.mode]: resolved.value,
      deviceIdentity: null, sharedStateMode: 'read-only', clientName: 'cli', mode: 'cli',
      clientDisplayName: 'OpenClaw+ Models', role: 'operator', scopes: ['operator.read'],
      caps: ['model-selection-policy'], notifyOnStartupRetry: true,
      onHelloOk: async hello => {
        if (settled || requested) return; requested = true;
        try {
          const metadata = capabilities(hello);
          if (operation === 'capabilities') return finish(null, metadata);
          if (!metadata.available) return fail('UNSUPPORTED');
          const result = await client.request('models.list', { view: 'default', preparedOnly: true, includeDetails: true, includeProviderCapabilities: true });
          finish(null, catalogResult(result));
        } catch (error) { fail(['UNAUTHORIZED','FORBIDDEN','MISSING_SCOPE'].includes(error?.code) ? error.code : 'UNSUPPORTED'); }
      },
      onConnectError: () => fail('UNAVAILABLE'), onReconnectPaused: () => fail('UNAVAILABLE'), onClose: () => fail('UNAVAILABLE'),
      hostDeps: { logDebug: () => {}, logError: () => {} },
    });
    try { client.start(); } catch { fail('UNAVAILABLE'); }
  });
}
async function main() {
  const [operation, expectUrl, ...extra] = process.argv.slice(2);
  validateRequest(operation, expectUrl, extra);
  if (process.env.OPENCLAW_SHELL !== undefined || process.env.OPENCLAW_SUBAGENT_EXEC !== undefined) throw Object.assign(new Error('Attributed context refused.'), { code: 'FORBIDDEN' });
  const installed = createRequire('/opt/homebrew/lib/node_modules/openclaw/package.json');
  const sdk = name => import(pathToFileURL(installed.resolve(`openclaw/plugin-sdk/${name}`)).href);
  const [{ GatewayClient }, { readConfigFileSnapshot }, { resolveConfiguredSecretInputString }] = await Promise.all([sdk('gateway-runtime'), sdk('health'), sdk('secret-input-runtime')]);
  const snapshot = await readConfigFileSnapshot({ observe: false, isolateEnv: true, recoverSuspicious: false, pluginValidation: 'core-only' });
  const config = snapshot.runtimeConfig ?? snapshot.config;
  if (!snapshot.valid || !['token','password'].includes(config?.gateway?.auth?.mode)) throw Object.assign(new Error('Unavailable configuration.'), { code: 'UNAUTHORIZED' });
  const authName = config.gateway.auth.mode;
  const resolved = await resolveConfiguredSecretInputString({ config, env: process.env, value: config.gateway.auth[authName], path: `gateway.auth.${authName}`, unresolvedReasonStyle: 'generic' });
  process.stdout.write(JSON.stringify(await readNative(operation, expectUrl, { GatewayClient, config, resolved })) + '\n');
}
if (require.main === module) main().catch(error => {
  const code = ['INVALID_REQUEST','UNSUPPORTED','UNAUTHORIZED','FORBIDDEN','MISSING_SCOPE','TIMEOUT'].includes(error?.code) ? error.code : 'UNAVAILABLE';
  process.stdout.write(JSON.stringify({ ok: false, error: { code } }) + '\n'); process.exitCode = 1;
});
module.exports = { validateRequest, capabilities, catalogResult, nativeSetupUrl, readNative };
