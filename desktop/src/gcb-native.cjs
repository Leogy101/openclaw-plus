'use strict';
// Metadata-only bridge check. GCB alone owns benchmark dispatch and scoring.
const { ReadError } = require('./gateway-cli.cjs');
const fs = require('node:fs');
const path = require('node:path');
const fail = (code, message) => { throw new ReadError(code, message); };
async function authorizeProfileTarget({ models, gateway }, snapshot) {
  const owner = gateway(), generation = owner.generation;
  await models.handle('modelsRefresh', {});
  if (gateway() !== owner) fail('STALE', 'The OpenClaw connection changed. Research this model again.');
  owner.assertCurrent(generation);
  const view = models.overview();
  const model = view.catalog.models.find(row => row.modelRef === snapshot.model_ref);
  if (view.connection.status !== 'connected' || view.catalog.stale || !model ||
      model.available !== true || model.manualSelectionAllowed !== true)
    fail('UNAVAILABLE', 'This model is not currently advertised as available and selectable. Check its provider in OpenClaw, then refresh.');
  if (snapshot.context_window !== model.contextWindow || !Array.isArray(snapshot.reasoning_settings) ||
      snapshot.reasoning_settings.some(value => !model.thinkingLevels.some(level => level.id === value)))
    fail('STALE', 'The reviewed snapshot no longer matches native model metadata. Import a current GCB host snapshot.');
  if (owner.transport.version !== snapshot.openclaw_version)
    fail('STALE', 'The installed OpenClaw version differs from the reviewed host snapshot. Import a current snapshot.');
  // No new auth lane: the native CLI resolves the existing configured credentials.
  // Legacy single-model bridge entries reject a model selector. A metadata-only
  // retry without it is safe only when the returned exact model is checked below.
  const params = { expectedHostVersion: snapshot.openclaw_version, model: snapshot.model_ref };
  let result = await owner.transport.request('gcb.profile.preflight', params);
  if (result?.code === 'BRIDGE_INPUT_REJECTED')
    result = await owner.transport.request('gcb.profile.preflight', { expectedHostVersion: snapshot.openclaw_version });
  if (gateway() !== owner) fail('STALE', 'The OpenClaw connection changed during verification.');
  owner.assertCurrent(generation);
  const facts = result?.result;
  if (result?.status !== 'subscription_route_verified' || result?.readiness?.state !== 'ready' ||
      facts?.metadataOnly !== true || facts.authRequirement !== 'subscription' ||
      facts.agentId !== snapshot.agent_id || facts.model !== snapshot.model_ref ||
      facts.hostVersion !== snapshot.openclaw_version || !Array.isArray(facts.allowedReasoning) ||
      snapshot.reasoning_settings.some(value => !facts.allowedReasoning.includes(value)))
    fail('UNAVAILABLE', 'GCB’s OpenClaw bridge is unavailable, busy, or does not permit this exact model and reasoning scope. Review its setup in OpenClaw; no model call was started.');
  return { metadataFingerprint: model.metadataFingerprint, connectionGeneration: generation, hostVersion: facts.hostVersion,
    configPath: owner.transport.target?.configPath, url: owner.transport.target?.url };
}
async function authorizeLocalProfileTarget({models,gateway},modelRef) {
  if(typeof modelRef!=='string'||!/^ollama\/[A-Za-z0-9][A-Za-z0-9_.:/+-]{0,240}$/.test(modelRef)||/cloud/i.test(modelRef))
    fail('INVALID','Choose an existing local Ollama model from the native catalog.');
  const owner=gateway(),generation=owner.generation;
  await models.handle('modelsRefresh',{});
  if(gateway()!==owner)fail('STALE','The OpenClaw connection changed. Refresh the model catalog.');
  owner.assertCurrent(generation);
  const view=models.overview(),model=view.catalog.models.find(row=>row.modelRef===modelRef);
  if(view.connection.status!=='connected'||view.catalog.stale||!model||model.provider!=='ollama'||model.local!==true||
    model.available!==true||model.manualSelectionAllowed!==true)
    fail('UNAVAILABLE','This exact local Ollama model is not currently available and selectable in OpenClaw.');
  const configPath=owner.transport.target?.configPath;let config;
  try {
    if(!path.isAbsolute(configPath||''))throw new Error();
    const stat=fs.lstatSync(configPath);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4000000||stat.mode&0o077||
      typeof process.getuid==='function'&&stat.uid!==process.getuid())throw new Error();
    const descriptor=fs.openSync(configPath,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try{const opened=fs.fstatSync(descriptor);if(opened.ino!==stat.ino||opened.dev!==stat.dev||opened.size>4000000)throw new Error();config=JSON.parse(fs.readFileSync(descriptor,'utf8'));}
    finally{fs.closeSync(descriptor);}
  }catch{fail('CONFIG','The bound native OpenClaw configuration could not be read safely. No local model request was made.');}
  const provider=config?.models?.providers?.ollama,nativeModel=modelRef.slice('ollama/'.length);
  const matches=Array.isArray(provider?.models)?provider.models.filter(row=>row?.id===nativeModel):[];
  if(matches.length!==1||(matches[0].api??provider?.api)!=='ollama'||
    provider.headers&&Object.keys(provider.headers).length||matches[0].headers&&Object.keys(matches[0].headers).length)
    fail('UNAVAILABLE','The configured model does not expose the supported plain local Ollama API.');
  const endpoint=(matches[0].baseUrl??provider.baseUrl);
  if(typeof endpoint!=='string'||!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/?$/.test(endpoint)||
    Number(endpoint.replace(/\/$/,'').split(':').pop())>65535)
    fail('UNAVAILABLE','GCB local checks require the existing explicit 127.0.0.1 Ollama endpoint. Remote URLs and proxies are unsupported.');
  if(gateway()!==owner)fail('STALE','The OpenClaw connection changed during verification.');
  owner.assertCurrent(generation);
  return {metadataFingerprint:model.metadataFingerprint,connectionGeneration:generation,configPath,url:owner.transport.target?.url,
    endpoint:endpoint.replace(/\/$/,''),nativeModel};
}
module.exports = { authorizeProfileTarget, authorizeLocalProfileTarget };
