'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

// Fixed read and write lanes; the renderer never supplies a method or executable.
const READ_METHODS = new Set(['agents.list', 'sessions.list', 'sessions.describe', 'chat.history', 'commands.list',
  'sessions.processes.list', 'cron.list', 'cron.runs', 'progressCard.get',
  'exec.approval.list','plugin.approval.list','openclaw.approval.list','approval.get','config.get','audit.activity.list','models.list','tts.status','gcb.profile.preflight']);
const WRITE_METHODS = new Set(['chat.send','chat.abort','approval.resolve','config.patch','sessions.patch','sessions.create','tts.speak']);
const APPROVAL_METHODS = new Set(['exec.approval.list','plugin.approval.list','openclaw.approval.list','approval.get','approval.resolve']);
const DEFAULT_NODE = '/opt/homebrew/bin/node';
const DEFAULT_CLI = '/opt/homebrew/lib/node_modules/openclaw/openclaw.mjs';

class ReadError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function localTarget(home) {
  const configPath = path.join(home, '.openclaw', 'openclaw.json');
  let config;
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch { throw new ReadError('CONFIG', 'The local OpenClaw configuration could not be read. Open the original interface to check it.'); }
  const gateway = config.gateway || {};
  if (gateway.mode !== 'local' || gateway.bind !== 'loopback') {
    throw new ReadError('CONFIG', 'This connection supports the existing local loopback gateway. Remote connections need separate setup.');
  }
  const port = gateway.port ?? 18789;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ReadError('CONFIG', 'The configured gateway port is invalid.');
  return { url: `ws://127.0.0.1:${port}`, originalUrl: `http://127.0.0.1:${port}/`, configPath, controlUiBasePath: gateway.controlUi?.basePath || '' };
}

function classifyFailure(output, timedOut, write = false, checked = false, method) {
  let data;
  try { data = JSON.parse(output); } catch { /* Raw CLI errors are never exposed or logged. */ }
  const rawCode = String(data?.error?.code ?? data?.code ?? '').toUpperCase();
  const detail = String(data?.error?.details?.code ?? data?.details?.code ?? data?.error?.reason ?? '').toUpperCase();
  if(checked&&data?.error?.preflight===true){
    const error=rawCode==='SESSION_CHANGED'?new ReadError('SESSION_CHANGED','This session changed. Refresh it before sending.'):
      rawCode==='UNAVAILABLE'?new ReadError('UNAVAILABLE','The current session or supported gateway client is unavailable. Refresh before sending.'):
      classifyFailure(output,timedOut||rawCode==='TIMEOUT',false);
    error.preflight=true;return error;
  }
  if (write) {
    if (method==='sessions.create' && ['UNKNOWN_METHOD','UNSUPPORTED'].includes(rawCode)) {
      return new ReadError('UNSUPPORTED','This OpenClaw gateway does not support starting a conversation from this app. Try New Session in original OpenClaw.');
    }
    if (/AUTH|PAIR|SCOPE|FORBIDDEN|ACCESS|UNAUTHORIZED/.test(rawCode+detail)) return new ReadError('ACCESS','OpenClaw did not authorize this action. Your existing permissions still apply.');
    if (/ACTIVE.LEAF.CHANGED|SESSION.SETTINGS.CHANGED|CONFLICT|STALE/.test(rawCode+detail)) return new ReadError('CONFLICT','This session or configuration changed. Refresh and review before trying again.');
    if (/INVALID_REQUEST|UNKNOWN_METHOD|NOT_FOUND|UNSUPPORTED/.test(rawCode+detail)) return new ReadError('INVALID','OpenClaw rejected this action. Refresh the current session or settings and review your input.');
    const error=new ReadError('UNCERTAIN','OpenClaw did not confirm the outcome. Refresh the session, approval or settings before deciding whether to retry.');
    error.uncertain=true;return error;
  }
  if (/AUTH|PAIR|SCOPE|FORBIDDEN|ACCESS|UNAUTHORIZED/.test(rawCode + detail)) {
    return new ReadError('ACCESS', 'OpenClaw did not authorize this read. Check access in the original OpenClaw interface.');
  }
  if (/INVALID_REQUEST|UNKNOWN_METHOD|NOT_FOUND|UNSUPPORTED/.test(rawCode + detail)) {
    return new ReadError('UNAVAILABLE', 'This read is unavailable on the current gateway or the selected session no longer exists.');
  }
  if (timedOut) return new ReadError('TIMEOUT', 'OpenClaw did not finish this read in time. The last displayed data may be stale; retry when the gateway is ready.');
  return new ReadError('CONNECTION', 'The local OpenClaw gateway could not complete this read. Check that it is available, then retry.');
}

class CliTransport {
  constructor({ home, target, node = DEFAULT_NODE, cli = DEFAULT_CLI, approvalHelper = path.join(__dirname,'approval-rpc.cjs'), composerHelper = path.join(__dirname,'composer-rpc.cjs'), modelHelper = path.join(__dirname,'model-rpc.cjs'), execute = execFile } = {}) {
    this.home = home;
    this.target = target || localTarget(home);
    this.node = node; this.cli = cli; this.approvalHelper = approvalHelper; this.composerHelper = composerHelper; this.modelHelper = modelHelper; this.execute = execute;
    this.supportsCheckedSend = cli === DEFAULT_CLI;
    this.active = 0; this.queue = []; this.children = new Set(); this.closed = false; this.nextOrder = 0;
    try { this.version = JSON.parse(fs.readFileSync(path.join(path.dirname(cli), 'package.json'), 'utf8')).version; } catch { this.version = undefined; }
  }
  request(method, params = {}) { return this.enqueue(method,params,false); }
  write(method, params = {}) { return this.enqueue(method,params,true); }
  sendChecked(params) {
    if(!this.supportsCheckedSend)return Promise.reject(new ReadError('UNAVAILABLE','Checked send is not available on this transport.'));
    return this.enqueue('chat.send',params,true,undefined,true).catch(error=>{
      // Admission failure or closing an unstarted queued job cannot have sent.
      // An owned running helper is already classified UNCERTAIN by drain().
      if(error instanceof ReadError&&['BUSY','CLOSED'].includes(error.code))error.preflight=true;
      throw error;
    });
  }
  prioritize(method, params = {}) {
    const key=JSON.stringify([method,params]);
    // A cache invalidation can leave an obsolete identical read queued. The
    // current coalesced request is the newest issuance for this exact key.
    let index=-1;
    for(let i=0;i<this.queue.length;i++)if(this.queue[i].key===key&&(index<0||this.queue[i].order>this.queue[index].order))index=i;
    if(index<0||this.queue[index].foreground)return false;
    const [job]=this.queue.splice(index,1);job.foreground=true;
    const next=this.queue.findIndex(item=>!item.foreground);
    this.queue.splice(next<0?this.queue.length:next,0,job);
    this.drain();return true;
  }
  modelRead(operation) {
    if (!['capabilities','catalog'].includes(operation)) return Promise.reject(new ReadError('DENIED','This model operation is not available.'));
    // Fixtures must explicitly replace this narrow reader; never reach a real gateway by accident.
    if (this.cli !== DEFAULT_CLI) return Promise.reject(new ReadError('UNAVAILABLE','The model catalog fixture is not installed.'));
    return this.enqueue('models.list',{},false,operation);
  }
  enqueue(method, params, write, modelOperation, checked = false) {
    if (!(write ? WRITE_METHODS : READ_METHODS).has(method)) return Promise.reject(new ReadError('DENIED', 'This operation is not allowed on the selected request lane.'));
    const stdin = write && ['chat.send','sessions.patch','sessions.create','config.patch','tts.speak'].includes(method);
    const media = method === 'chat.send' && Array.isArray(params?.attachments) && params.attachments.length > 0;
    if (!params || typeof params !== 'object' || Array.isArray(params) || Buffer.byteLength(JSON.stringify(params)) > (write && media ? 18 * 1024 * 1024 : write ? 131072 : 32768)) {
      return Promise.reject(new ReadError('INVALID', 'Invalid read parameters.'));
    }
    if (this.closed) return Promise.reject(new ReadError('CLOSED', 'The connection is closed.'));
    if (this.queue.length > 20) return Promise.reject(new ReadError('BUSY', 'A refresh is already in progress.'));
    return new Promise((resolve, reject) => {
      const job={method,params,write,stdin,modelOperation,checked,resolve,reject,foreground:write,order:this.nextOrder++,key:write?undefined:JSON.stringify([method,params])};
      const next=write?this.queue.findIndex(item=>!item.foreground):-1;
      this.queue.splice(next<0?this.queue.length:next,0,job);this.drain();
    });
  }
  drain() {
    while (!this.closed && this.active < 2 && this.queue.length) {
      const job = this.queue.shift(); this.active++;
      const args = job.modelOperation ? [this.modelHelper,job.modelOperation,this.target.url]
        : job.stdin ? (this.cli===DEFAULT_CLI ? [this.composerHelper,job.checked?'chat.send.checked':job.method,this.target.url] : [this.cli,'--composer-stdin',job.method,this.target.url])
        : this.cli===DEFAULT_CLI && APPROVAL_METHODS.has(job.method)
        ? [this.approvalHelper,job.method,this.target.url,JSON.stringify(job.params)]
        : [this.cli, 'gateway', 'call', job.method, '--params', JSON.stringify(job.params),
          '--json', '--expect-url', this.target.url, '--timeout', job.write ? '20000' : '10000'];
      // No inherited token overrides, profile selection, Node injection or proxy configuration.
      const env = { HOME: this.home, USER: process.env.USER || '', LOGNAME: process.env.LOGNAME || '',
        PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8',
        NO_COLOR: '1', TERM: 'dumb', OPENCLAW_CONFIG_PATH: this.target.configPath };
      // Preserve attribution restrictions when launched from an agent execution context.
      for (const name of ['OPENCLAW_SHELL','OPENCLAW_SUBAGENT_EXEC']) if(process.env[name] !== undefined) env[name]=process.env[name];
      let child;
      child = this.execute(this.node, args, { env, shell: false, encoding: 'utf8',
        timeout: job.method==='tts.speak' ? 140000 : job.checked ? 38000 : job.write ? 28000 : 18000, maxBuffer: (job.method==='tts.speak' ? 17 : 4) * 1024 * 1024, windowsHide: true }, (error, stdout) => {
        this.children.delete(child); this.active--;
        if (this.closed) job.reject(job.write ? classifyFailure('',false,true) : new ReadError('CLOSED', 'The connection is closed.'));
        else if (error) job.reject(classifyFailure(stdout, error.killed || error.code === 'ETIMEDOUT', job.write, job.checked, job.method));
        else {
          try {
            const result = JSON.parse(stdout);
            if (!result || typeof result !== 'object' || result.ok === false && result.error) throw new Error('Invalid reply');
            job.resolve(result);
          } catch { job.reject(classifyFailure(stdout, false, job.write, job.checked, job.method)); }
        }
        this.drain();
      });
      if (child) this.children.add(child);
      if (job.stdin) {
        if (!child?.stdin) { child?.kill(); continue; }
        child.stdin.on('error', () => {}); // The process callback reports the bounded, uncertain outcome.
        child.stdin.end(JSON.stringify(job.params));
      }
    }
  }
  close() {
    this.closed = true;
    for (const job of this.queue.splice(0)) job.reject(new ReadError('CLOSED', 'The connection is closed.'));
    for (const child of this.children) child.kill();
  }
}
module.exports = { CliTransport, ReadError, READ_METHODS, WRITE_METHODS, localTarget, classifyFailure };
