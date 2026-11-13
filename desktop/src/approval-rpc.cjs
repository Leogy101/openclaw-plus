'use strict';
// The public OpenClaw client helper preserves configured authentication and endpoint pinning.
// Approval review needs the same operator scopes as the official `approvals` CLI.
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const methods = new Set(['exec.approval.list','plugin.approval.list','openclaw.approval.list','approval.get','approval.resolve']);
(async () => {
  const [method, expectUrl, raw, ...extra] = process.argv.slice(2);
  if (extra.length || !methods.has(method) || !/^ws:\/\/127\.0\.0\.1:\d{1,5}$/.test(expectUrl || '') ||
      typeof raw !== 'string' || Buffer.byteLength(raw)>32768) throw new Error('Invalid approval request');
  const params = JSON.parse(raw);
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('Invalid params');
  const fields = method==='approval.resolve'?['id','kind','decision']:method==='approval.get'?['id']:[];
  if (Object.keys(params).some(key=>!fields.includes(key))) throw new Error('Invalid fields');
  if (method.startsWith('approval.') && (typeof params.id!=='string'||!params.id||params.id.length>2048||/[\x00-\x1f\x7f]/.test(params.id))) throw new Error('Invalid id');
  if (method==='approval.resolve' && (!['exec','plugin','system-agent'].includes(params.kind)||!['allow-once','allow-always','deny'].includes(params.decision))) throw new Error('Invalid decision');
  const installed = createRequire('/opt/homebrew/lib/node_modules/openclaw/package.json');
  const { callGatewayFromCli } = await import(pathToFileURL(installed.resolve('openclaw/plugin-sdk/gateway-runtime')).href);
  const result = await callGatewayFromCli(method,{expectUrl,json:true,timeout:'10000'},params,
    {scopes:['operator.admin','operator.approvals'],sharedStateMode:'read-only',progress:false});
  process.stdout.write(JSON.stringify(result)+'\n');
})().catch(error=>{
  // Raw SDK messages can include sensitive tool/config details. Forward a bounded category only.
  const candidate = error?.gatewayCode ?? error?.code;
  const code = typeof candidate==='string' && /^[A-Z_]{1,80}$/.test(candidate)?candidate:'UNAVAILABLE';
  process.stdout.write(JSON.stringify({ok:false,error:{code}})+'\n');
  process.exitCode=1;
});
