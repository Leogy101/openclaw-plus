'use strict';
// Fixed public OpenClaw calls. Prompts, media and configuration edits stay out of argv.
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const MAX_BYTES = 18 * 1024 * 1024;
const FIELDS = new Map([
  ['chat.send',['sessionKey','agentId','sessionId','message','idempotencyKey','expectedLeafEntryId','attachments','replyToId']],
  ['sessions.patch',['key','agentId','expectedSessionId','expectedLifecycleRevision','model','thinkingLevel','permissionMode','expectedPermissionMode']],
  ['config.patch',['baseHash','raw','response','replacePaths']],
  ['tts.speak',['text']],
]);
function validateRequest(method, params) {
  const fields=FIELDS.get(method);
  if (!fields || !params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => !fields.includes(key))) throw new Error('Invalid private request fields');
  if (method==='chat.send' && params.replyToId!==undefined && (typeof params.replyToId!=='string'||!params.replyToId.trim()||params.replyToId.trim()!==params.replyToId||params.replyToId.length>512||/[\x00-\x1f\x7f]/.test(params.replyToId))) throw new Error('Invalid question reply target');
  if (method==='tts.speak' && (typeof params.text!=='string'||!params.text.trim()||params.text.length>4000)) throw new Error('Invalid speech text');
  if (method==='sessions.patch' && (Object.hasOwn(params,'permissionMode')||Object.hasOwn(params,'expectedPermissionMode'))) {
    const modes=[null,'read-only','guarded','workspace','full'];
    if (!Object.hasOwn(params,'permissionMode')||!Object.hasOwn(params,'expectedPermissionMode')||!modes.includes(params.permissionMode)||!modes.includes(params.expectedPermissionMode)||
        Object.keys(params).some(key=>!['key','agentId','expectedSessionId','expectedLifecycleRevision','permissionMode','expectedPermissionMode'].includes(key))||
        ['key','agentId','expectedSessionId',...(Object.hasOwn(params,'expectedLifecycleRevision')?['expectedLifecycleRevision']:[])].some(key=>typeof params[key]!=='string'||!params[key].trim()||params[key].length>1024||/[\x00-\x1f\x7f]/.test(params[key]))) throw new Error('Invalid permission change');
    return params.permissionMode==='full'?['operator.admin']:['operator.write'];
  }
  // Admin authority is limited to the configuration call. Model changes remain session-only.
  return method === 'config.patch' ? ['operator.admin'] : method === 'tts.speak' ? ['operator.write'] : ['operator.read','operator.write'];
}
async function main() {
  const [method, expectUrl, ...extra] = process.argv.slice(2);
  if (extra.length || !FIELDS.has(method) || !/^ws:\/\/127\.0\.0\.1:\d{1,5}$/.test(expectUrl || '')) throw new Error('Invalid private request');
  let bytes = 0; const chunks = [];
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > (method === 'chat.send' ? MAX_BYTES : 131072)) throw new Error('Private request too large');
    chunks.push(chunk);
  }
  const params = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const scopes = validateRequest(method, params);
  const installed = createRequire('/opt/homebrew/lib/node_modules/openclaw/package.json');
  const { callGatewayFromCli } = await import(pathToFileURL(installed.resolve('openclaw/plugin-sdk/gateway-runtime')).href);
  const result = await callGatewayFromCli(method, { expectUrl, json: true, timeout: method==='tts.speak'?'130000':'20000' }, params,
    { scopes, sharedStateMode: 'read-only', progress: false });
  process.stdout.write(JSON.stringify(result) + '\n');
}
if (require.main === module) main().catch(error => {
  const candidate = error?.gatewayCode ?? error?.code;
  const code = typeof candidate === 'string' && /^[A-Z_]{1,80}$/.test(candidate) ? candidate : 'UNAVAILABLE';
  const reason = error?.details?.reason;
  process.stdout.write(JSON.stringify({ ok: false, error: { code,
    ...['active-leaf-changed','session-settings-changed'].includes(reason) ? { reason } : {} } }) + '\n');
  process.exitCode = 1;
});
module.exports = { validateRequest };
