// Portable display/identity logic. This module grants no execution authority.
export const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const boundedString = (value, max = 512) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value);
const bool = value => typeof value === 'boolean' ? value : null;
const positive = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const optional = (value, max) => boundedString(value, max) ? value : null;

export function canonicalIdentity(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalIdentity).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalIdentity(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

export function normalizeCapabilities(raw) {
  const methods = raw?.features?.methods ?? raw?.methods;
  const capabilities = raw?.features?.capabilities ?? raw?.capabilities;
  const has = (collection, key) => Array.isArray(collection) ? collection.includes(key) : isRecord(collection) && collection[key] === true;
  return {
    modelsList: has(methods, 'models.list'),
    publishedModelCatalog: has(capabilities, 'published-model-catalog') || capabilities?.publishedModelCatalog === true,
    sessionScopedModelCatalog: has(capabilities, 'session-scoped-model-catalog') || capabilities?.sessionScopedModelCatalog === true,
    modelSelectionPolicy: has(raw?.clientCaps, 'model-selection-policy') || capabilities?.modelSelectionPolicy === true,
  };
}

export function modelMetadata(model) {
  return { provider: model.provider, modelId: model.id, modelRef: model.modelRef,
    runtimeId: model.runtimeId, reasoning: model.reasoning, thinkingLevels: model.thinkingLevels,
    thinkingDefault: model.thinkingDefault, input: model.input, supportsTools: model.supportsTools,
    contextWindow: model.contextWindow, local: model.local };
}

export function normalizeCatalog(raw) {
  if (!isRecord(raw) || !Array.isArray(raw.models)) throw new Error('Unsupported native model catalog.');
  const models = [], seen = new Map(), ambiguous = new Set(), limitations = [];
  let invalid = 0;
  for (const item of raw.models.slice(0, 1000)) {
    if (!isRecord(item) || !boundedString(item.provider, 128) || item.provider.includes('/') || !boundedString(item.id, 512)) { invalid++; continue; }
    const levels = Array.isArray(item.thinkingLevels) ? item.thinkingLevels.filter(level => isRecord(level) && boundedString(level.id, 80) && boundedString(level.label, 120)).slice(0, 20).map(({id,label}) => ({id,label})) : [];
    const uniqueLevels = levels.filter((level, index) => levels.findIndex(other => other.id === level.id) === index);
    const model = { modelRef: `${item.provider}/${item.id}`, provider: item.provider, id: item.id,
      name: optional(item.name, 200) ?? item.id, available: bool(item.available),
      manualSelectionAllowed: bool(item.manualSelectionAllowed),
      unavailableReason: ['missing-auth', 'auth-failed', 'cooldown'].includes(item.unavailableReason) ? item.unavailableReason : null,
      unavailableUntil: positive(item.unavailableUntil), thinkingLevels: uniqueLevels,
      thinkingDefault: optional(item.thinkingDefault, 80), reasoning: bool(item.reasoning),
      input: Array.isArray(item.input) ? [...new Set(item.input.filter(value => ['text','image','audio','video','document'].includes(value)))] : [],
      runtimeId: optional(item.agentRuntime?.id, 80), local: bool(item.local),
      contextWindow: positive(item.contextWindow), supportsTools: bool(item.supportsTools), apiKeySupported: bool(item.apiKeySupported) };
    if (seen.has(model.modelRef)) {
      if (canonicalIdentity(seen.get(model.modelRef)) !== canonicalIdentity(model)) ambiguous.add(model.modelRef);
    } else { seen.set(model.modelRef, model); models.push(model); }
  }
  if (raw.models.length > 1000) limitations.push('The native catalog exceeds this view’s 1,000-model limit. Use the original interface for the complete inventory.');
  if (invalid) limitations.push('Unsupported model rows were omitted; no identifiers or capabilities were guessed.');
  if (ambiguous.size) limitations.push('Conflicting rows for the same model reference were omitted. Refresh or review the original interface.');
  if (raw.refreshFailed === true) limitations.push('Native discovery did not complete successfully. Published rows may be retained from an earlier inventory.');
  const retained = models.filter(model => !ambiguous.has(model.modelRef));
  const providerIds = [...new Set(retained.map(model => model.provider))];
  const providers = providerIds.map(id => {
    const rows = retained.filter(model => model.provider === id);
    const outcome = Array.isArray(raw.providerOutcomes) ? raw.providerOutcomes.find(item => isRecord(item) && item.provider === id) : null;
    return { id, name: id, modelCount: rows.length,
      availability: rows.some(row => row.available === true) ? 'available' : rows.every(row => row.available === false) ? 'unavailable' : 'unknown',
      authStatus: 'not-checked', apiKeySupported: rows.some(row => row.apiKeySupported === true) ? true : rows.every(row => row.apiKeySupported === false) ? false : null,
      discoveryStatus: ['ready','auth-rejected','unavailable'].includes(outcome?.status) ? outcome.status : null,
      pending: Array.isArray(raw.pendingProviders) && raw.pendingProviders.includes(id) };
  });
  return { models: retained, providers, limitations,
    discoveryIncomplete: raw.refreshFailed === true || Array.isArray(raw.pendingProviders) && raw.pendingProviders.length > 0 };
}

export function qualificationIdentity({ provider, modelId, reasoning = null, environmentId = null, role = null,
  runtimeId = null, toolPolicyDigest = null, suiteRevision = null }) {
  return canonicalIdentity({ provider, modelId, reasoning, environmentId, role, runtimeId, toolPolicyDigest, suiteRevision });
}

// Evidence is an explicit pure-function input for future callers/tests. The M2
// production service supplies neither evidence nor an admission and cannot load them.
export function classifyRegistration(registration, { model = null, connected = false, now = Date.now(),
  scope = null, evidence = null, admission = null } = {}) {
  const base = { registered: true, qualification: 'pending', admission: 'not-approved', execution: 'unavailable', routing: 'preview-only' };
  if (!connected || !model) return { ...base, status: 'stale', reason: 'Native availability has not been verified for this reference.' };
  if (model.modelRef !== registration.modelRef || model.provider !== registration.provider || model.id !== registration.modelId || model.metadataFingerprint !== registration.metadataFingerprint) {
    return { ...base, status: 'stale', reason: 'The advertised model configuration changed. Existing references do not qualify the new configuration.' };
  }
  if (model.available === false || model.manualSelectionAllowed === false) return { ...base, status: 'blocked', reason: 'Native availability or selection policy currently blocks this model. The local reference grants no permission.' };
  const validVariant = boundedString(registration.provider, 128) && !registration.provider.includes('/') &&
    boundedString(registration.modelId, 512) && registration.modelRef === `${registration.provider}/${registration.modelId}` &&
    boundedString(registration.runtimeId, 80) && model.runtimeId === registration.runtimeId &&
    (registration.reasoning === null || boundedString(registration.reasoning, 80));
  const validScope = validVariant && isRecord(scope) && ['coding','review','research','planning'].includes(scope.role) &&
    ['environmentId','toolPolicyDigest','suiteRevision'].every(key => boundedString(scope[key], 256)) &&
    ['provider','modelId','reasoning','runtimeId'].every(key => !Object.hasOwn(scope, key) || scope[key] === registration[key]);
  const identity = validScope ? qualificationIdentity({ provider: registration.provider, modelId: registration.modelId,
    reasoning: registration.reasoning, runtimeId: registration.runtimeId, role: scope.role,
    environmentId: scope.environmentId, toolPolicyDigest: scope.toolPolicyDigest, suiteRevision: scope.suiteRevision }) : null;
  if (!evidence) return { ...base, status: scope ? 'qualification-pending' : 'registered', reason: 'Local reference saved. Qualification checks and live admission are not available in this stage.' };
  if (!identity || evidence.identity !== identity || !boundedString(evidence.id, 256) || !Number.isFinite(evidence.expiresAt) || evidence.expiresAt <= now) return { ...base, status: 'stale', reason: 'Evidence does not match the exact current variant or has expired.' };
  if (evidence.status === 'failed') return { ...base, status: 'failed', qualification: 'failed', reason: 'The matching checks failed.' };
  if (evidence.status !== 'passed' || evidence.complete !== true) return { ...base, status: 'qualification-pending', reason: 'Complete matching evidence is required.' };
  const qualified = { ...base, status: 'qualified', qualification: 'passed', reason: 'Matching evidence passed; owner admission remains separate.' };
  if (admission?.approved === true && admission.identity === identity && admission.evidenceId === evidence.id &&
      Number.isFinite(admission.expiresAt) && admission.expiresAt > now) return { ...qualified, status: 'approved', admission: 'approved', reason: 'Matching owner admission recorded; execution still requires its native enforcement boundary.' };
  return qualified;
}
