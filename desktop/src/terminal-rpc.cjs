'use strict';
// One private, persistent local Gateway connection. No credential is sent over IPC.
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const MAX_LINE = 128 * 1024;
const MAX_OUTPUT = 4 * 1024 * 1024;
const METHODS = new Set(['sessions.describe','terminal.list','terminal.open','terminal.attach','terminal.input','terminal.resize','terminal.close']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\x00-\x1f\x7f]/u.test(value);
const dimension = value => Number.isInteger(value) && value >= 1 && value <= 2000;

function validateRequest(value) {
  if (!object(value) || Object.keys(value).some(key => !['id','method','params'].includes(key)) ||
      !Number.isSafeInteger(value.id) || value.id < 1 || !METHODS.has(value.method) || !object(value.params)) return false;
  const p = value.params;
  const fields = { 'sessions.describe':['key','agentId'], 'terminal.list':[],
    'terminal.open':['agentId','sessionKey','cols','rows'], 'terminal.attach':['sessionId'],
    'terminal.input':['sessionId','data'], 'terminal.resize':['sessionId','cols','rows'], 'terminal.close':['sessionId'] }[value.method];
  if (Object.keys(p).length !== fields.length || fields.some(key => !Object.hasOwn(p,key))) return false;
  if (value.method === 'terminal.list') return true;
  if (value.method === 'sessions.describe') return id(p.key) && id(p.agentId);
  if (value.method === 'terminal.open') return id(p.agentId) && id(p.sessionKey) && dimension(p.cols) && dimension(p.rows);
  if (!id(p.sessionId)) return false;
  if (value.method === 'terminal.resize') return dimension(p.cols) && dimension(p.rows);
  return value.method !== 'terminal.input' || typeof p.data === 'string' && Buffer.byteLength(p.data) <= 16384;
}

function errorCode(error) {
  const code = error?.gatewayCode ?? error?.code;
  return typeof code === 'string' && /^[A-Z_]{1,80}$/u.test(code) ? code : 'CONNECTION';
}

async function run() {
  // This is an owner-operated desktop shell, never a new operator lane for agent exec.
  if (process.env.OPENCLAW_SHELL !== undefined || process.env.OPENCLAW_SUBAGENT_EXEC !== undefined) throw new Error('Agent execution context');
  const [expectUrl,...extra] = process.argv.slice(2);
  if (extra.length || !/^ws:\/\/127\.0\.0\.1:\d{1,5}$/u.test(expectUrl || '')) throw new Error('Invalid terminal target');
  const installed = createRequire('/opt/homebrew/lib/node_modules/openclaw/package.json');
  const sdk = async name => import(pathToFileURL(installed.resolve(`openclaw/plugin-sdk/${name}`)).href);
  const [{ GatewayClient }, { readConfigFileSnapshot }, { resolveConfiguredSecretInputString }] = await Promise.all([
    sdk('gateway-runtime'), sdk('health'), sdk('secret-input-runtime'),
  ]);
  const snapshot = await readConfigFileSnapshot({ observe:false, isolateEnv:true, recoverSuspicious:false, pluginValidation:'core-only' });
  const config = snapshot.runtimeConfig ?? snapshot.config;
  const gateway = config?.gateway;
  const port = gateway?.port ?? 18789;
  if (!snapshot.valid || gateway?.mode !== 'local' || gateway?.bind !== 'loopback' || gateway.tls?.enabled ||
      !Number.isInteger(port) || port < 1 || port > 65535 || expectUrl !== `ws://127.0.0.1:${port}` ||
      !['token','password'].includes(gateway.auth?.mode)) throw new Error('Unsupported configured terminal target');
  const authName = gateway.auth.mode;
  const resolved = await resolveConfiguredSecretInputString({ config, env:process.env,
    value:gateway.auth[authName], path:`gateway.auth.${authName}`, unresolvedReasonStyle:'generic' });
  if (resolved.unresolvedRefReason || !resolved.value) throw new Error('Configured terminal authentication unavailable');

  let stopped = false, client, ready = false, active = 0, pending = 0;
  let tail = Promise.resolve();
  const send = message => {
    if (stopped) return;
    const line = JSON.stringify(message) + '\n';
    if (Buffer.byteLength(line) > MAX_OUTPUT || process.stdout.writableLength + Buffer.byteLength(line) > MAX_OUTPUT) {
      stop(); return;
    }
    process.stdout.write(line);
  };
  function stop() {
    if (stopped) return;
    stopped = true; clearTimeout(startupTimer); client?.stop(); process.stdin.pause();
    process.stdout.end(() => process.exit(0));
    setTimeout(() => process.exit(0),500).unref();
  }
  const startupTimer = setTimeout(() => { send({kind:'status',status:'disconnected',code:'TIMEOUT'}); stop(); },15000);
  client = new GatewayClient({ url:expectUrl, [authName]:resolved.value, deviceIdentity:null, sharedStateMode:'read-only',
    clientName:'gateway-client', clientDisplayName:'OpenClaw+ terminal', mode:'backend', role:'operator',
    scopes:['operator.admin'], caps:['terminal-offset-seq','terminal-session-metadata'], requestTimeoutMs:20000,
    onHelloOk:hello => {
      if (!Array.isArray(hello?.features?.methods) || [...METHODS].some(method => !hello.features.methods.includes(method))) {
        send({kind:'status',status:'disconnected',code:'UNSUPPORTED'}); stop(); return;
      }
      ready = true; clearTimeout(startupTimer); send({kind:'status',status:'ready'});
    },
    onEvent:frame => {
      if (frame.event === 'terminal.data' || frame.event === 'terminal.exit') send({kind:'event',event:frame.event,payload:frame.payload});
    },
    onGap:() => send({kind:'gap'}),
    onConnectError:error => { send({kind:'status',status:'disconnected',code:errorCode(error)}); stop(); },
    onClose:() => { ready = false; send({kind:'status',status:'disconnected',code:'CONNECTION'}); stop(); },
    hostDeps:{ logDebug:() => {}, logError:() => {} },
  });
  // No generic method bridge, catalog launch, uploads, config mutations, or shell arguments.
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data',chunk => {
    input += chunk;
    if (Buffer.byteLength(input) > MAX_LINE) { stop(); return; }
    let split;
    while ((split = input.indexOf('\n')) >= 0) {
      const line = input.slice(0,split); input = input.slice(split+1);
      let request;
      try { request = JSON.parse(line); } catch { stop(); return; }
      if (!validateRequest(request) || !ready || ++pending > 32) { stop(); return; }
      tail = tail.then(async () => {
        pending--; if (stopped) return; active++;
        try {
          const result = await client.request(request.method,request.params,{timeoutMs:request.method === 'terminal.open' ? 35000 : 15000});
          // The terminal adapter needs only identity, never session messages or goals.
          const data = request.method === 'sessions.describe' ? { session: result?.session ? {
            key:result.session.key, agentId:result.session.agentId, sessionId:result.session.sessionId,
            lifecycleRevision:result.session.lifecycleRevision,
          } : null } : result;
          send({kind:'reply',id:request.id,ok:true,data});
        } catch (error) { send({kind:'reply',id:request.id,ok:false,error:{code:errorCode(error)}}); }
        finally { active--; }
      });
    }
  });
  process.stdin.on('end',stop); process.stdin.on('error',stop);
  process.on('SIGTERM',stop); process.on('SIGINT',stop);
  client.start();
}

if (require.main === module) run().catch(() => {
  process.stdout.write(JSON.stringify({kind:'status',status:'disconnected',code:'CONFIG'})+'\n'); process.exitCode=1;
});
module.exports = { validateRequest, MAX_LINE, MAX_OUTPUT };
