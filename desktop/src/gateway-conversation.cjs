'use strict';
const { createHash, randomUUID } = require('node:crypto');
const { ReadError } = require('./gateway-cli.cjs');
const { sessionRow } = require('./gateway-service.cjs');
const { assertSession: checkSession } = require('./composer-rpc.cjs');
function assertSession(row,input,sending=false) {
  try { return checkSession(row,input,sending); }
  catch(error) { throw new ReadError(error.code,error.message); }
}

const OPERATIONS = new Set(['plan', 'send', 'abort', 'createConversation']);
const MAX_REQUESTS = 128;
const own = (value, key) => Object.hasOwn(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message) => { throw new ReadError(code, message); };

function identifier(value, max = 1024) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value);
}
function validate(operation, input) {
  const extra = { plan: [], send: ['message', 'requestId', 'expectedLeafEntryId', 'attachmentIds', 'replyToId'], abort: ['runId'] };
  if (!OPERATIONS.has(operation) || !object(input)) fail('INVALID', 'Invalid conversation action.');
  if (operation === 'createConversation') {
    if (Object.keys(input).some(key => !['agentId','requestId'].includes(key)) ||
        typeof input.agentId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(input.agentId) ||
        typeof input.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.requestId)) {
      fail('INVALID', 'Choose an agent before starting a conversation.');
    }
    return { agentId: input.agentId, requestId: input.requestId };
  }
  const fields = ['key', 'agentId', 'sessionId', ...extra[operation]];
  if (Object.keys(input).some(key => !fields.includes(key)) ||
      ['key', 'agentId', 'sessionId'].some(key => !identifier(input[key]))) {
    fail('INVALID', 'Select an exact agent session before continuing.');
  }
  if (operation === 'send') {
    if (input.replyToId !== undefined && (!identifier(input.replyToId,512) || input.replyToId.trim() !== input.replyToId)) {
      fail('INVALID', 'Invalid question reply target.');
    }
    if (input.attachmentIds !== undefined && (!Array.isArray(input.attachmentIds) || input.attachmentIds.length > 4 ||
        input.attachmentIds.some(value => !identifier(value,128)) || new Set(input.attachmentIds).size !== input.attachmentIds.length)) fail('INVALID','Choose at most four valid attachments.');
    if (typeof input.message !== 'string' || !input.message.trim() && !input.attachmentIds?.length || Buffer.byteLength(input.message, 'utf8') > 16384) {
      fail('INVALID', 'Enter a message of at most 16 KiB.');
    }
    if (typeof input.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.requestId)) {
      fail('INVALID', 'The message needs a valid submission identity.');
    }
    if (own(input, 'expectedLeafEntryId') && input.expectedLeafEntryId !== undefined &&
        input.expectedLeafEntryId !== null && !identifier(input.expectedLeafEntryId)) {
      fail('INVALID', 'Invalid conversation branch identity.');
    }
  }
  if (operation === 'abort' && !identifier(input.runId, 512)) fail('INVALID', 'Select the exact run to stop.');
  // Clone across the async boundary; a caller cannot alter the accepted request later.
  return { ...input, ...(input.attachmentIds ? { attachmentIds: [...input.attachmentIds] } : {}) };
}

function sameLifecycle(before, after) {
  if (before.lifecycleRevision !== undefined && before.lifecycleRevision !== after.lifecycleRevision) {
    fail('SESSION_CHANGED', 'This conversation changed. Refresh it before continuing.');
  }
}

function normalizeSteps(steps) {
  if (!Array.isArray(steps) || steps.length > 50 || steps.some(step => !object(step) ||
      typeof step.step !== 'string' || !step.step.trim() || Buffer.byteLength(step.step, 'utf8') > 512 ||
      !['pending', 'in_progress', 'completed'].includes(step.status)) ||
      steps.filter(step => step.status === 'in_progress').length > 1) {
    fail('UNAVAILABLE', 'OpenClaw returned an unsupported task checklist.');
  }
  return steps.map(({ step, status }) => ({ step, status }));
}

function normalizeCard(result) {
  if (!object(result) || !own(result, 'card')) fail('UNAVAILABLE', 'OpenClaw did not return a progress card.');
  if (result.card === null) return { card: null };
  const card = result.card;
  if (!object(card) || !Number.isSafeInteger(card.revision) || card.revision < 1 || !Number.isSafeInteger(card.updatedAt)) {
    fail('UNAVAILABLE', 'OpenClaw returned an unsupported progress card.');
  }
  const normalized = { source: 'progress-card', revision: card.revision, updatedAt: card.updatedAt };
  if (card.markdown !== undefined) {
    if (typeof card.markdown !== 'string' || Buffer.byteLength(card.markdown, 'utf8') > 8192) {
      fail('UNAVAILABLE', 'OpenClaw returned an unsupported progress note.');
    }
    normalized.markdown = card.markdown;
  }
  if (card.steps !== undefined) {
    normalized.steps = normalizeSteps(card.steps);
  }
  return { card: normalized };
}

function normalizeActivePlan(history, currentSession) {
  const run = history.inFlightRun;
  if (!object(run) || run.plan === undefined || run.plan === null) return { card: null };
  if (!identifier(run.runId, 512) || !object(run.plan)) fail('UNAVAILABLE', 'OpenClaw returned an unsupported active-run plan.');
  // An exact idle/nonmember observation supersedes an older in-flight snapshot.
  for (const observation of [history.sessionInfo, currentSession]) {
    if (observation?.hasActiveRun === false || Array.isArray(observation?.activeRunIds) &&
        !observation.activeRunIds.includes(run.runId)) return { card: null };
  }
  const card = { source: 'active-run', runId: run.runId, steps: normalizeSteps(run.plan.steps) };
  if (run.plan.explanation !== undefined) {
    if (typeof run.plan.explanation !== 'string' || Buffer.byteLength(run.plan.explanation, 'utf8') > 8192) {
      fail('UNAVAILABLE', 'OpenClaw returned an unsupported active-run note.');
    }
    card.markdown = run.plan.explanation;
  }
  if (run.plan.updatedAt !== undefined) {
    if (!Number.isSafeInteger(run.plan.updatedAt)) fail('UNAVAILABLE', 'OpenClaw returned an unsupported plan timestamp.');
    card.updatedAt = run.plan.updatedAt;
  }
  // A run's startedAt is not a plan update time. No synthetic revision or timestamp.
  return { card };
}

function normalizeSendReceipt(reply, requestId) {
  if (!object(reply)) fail('UNCERTAIN', 'OpenClaw returned an unrecognized message receipt.');
  // Typed Stop uses the abort response shape, not the ordinary message ACK.
  if (reply.status === undefined && reply.ok === true && typeof reply.aborted === 'boolean' &&
      Array.isArray(reply.runIds) && reply.runIds.length <= 1000 && reply.runIds.every(id => identifier(id, 512))) {
    const result = { status: 'stopped', aborted: reply.aborted, runIds: [...reply.runIds] };
    if (typeof reply.warning === 'string') result.warning = reply.warning.slice(0, 2000);
    return result;
  }
  // Control admission is not proof of a started turn. Never manufacture a run ID.
  if (reply.status === 'accepted' && (reply.runId === undefined || identifier(reply.runId, 512))) {
    return { status: 'accepted', ...(reply.runId === undefined ? {} : { runId: reply.runId }) };
  }
  if (reply.runId !== requestId || !['started', 'in_flight', 'ok', 'aborted'].includes(reply.status)) {
    fail('UNCERTAIN', 'OpenClaw returned an unrecognized message receipt.');
  }
  return { runId: reply.runId, status: reply.status };
}
const copyReceipt = receipt => ({ ...receipt, ...(receipt.runIds ? { runIds: [...receipt.runIds] } : {}) });

class ConversationActions {
  constructor(baseGatewayService, { attachments } = {}) {
    this.base = baseGatewayService;
    this.attachments = attachments;
    // Submission receipts are transport bookkeeping, never a task/progress authority.
    this.submissions = new Map();
    this.creations = new Map();
  }
  hasPendingFor(input) {
    const context = JSON.stringify([input.key,input.agentId,input.sessionId]);
    return [...this.submissions.values()].some(record => record.context === context && !record.result && (record.pending || record.params));
  }
  async handle(operation, params) {
    const input = validate(operation, params);
    if (operation === 'send') return this.send(input);
    if (operation === 'abort') return this.abort(input);
    if (operation === 'createConversation') return this.createConversation(input);
    return this.plan(input);
  }
  readFresh(method, params, foreground = false) {
    const pending=this.base.read(method,params,0);
    // Promote a matching queued read, including one already shared with polling.
    // Running reads keep their worker; authentication and freshness checks are unchanged.
    if(foreground)this.base.transport.prioritize?.(method,params);
    return pending;
  }
  async describe(input, generation, foreground = false) {
    const result = await this.readFresh('sessions.describe', { key: input.key, agentId: input.agentId }, foreground);
    this.base.assertCurrent(generation);
    return assertSession(result?.session,input);
  }
  async createConversation({ agentId, requestId }) {
    const target = this.base.transport.target;
    const connection = JSON.stringify([target?.url, target?.configPath]);
    let record = this.creations.get(requestId);
    if (record && (record.agentId !== agentId || record.connection !== connection)) {
      fail('INVALID', 'This request belongs to a different agent or connection.');
    }
    if (record?.pending) return record.pending;
    if (record?.result) return { ...record.result };
    if (!record) {
      if (this.creations.size >= MAX_REQUESTS) {
        const settled = [...this.creations].find(([, value]) => value.result && !value.pending);
        if (!settled) fail('BUSY', 'Too many conversation requests await confirmation.');
        this.creations.delete(settled[0]);
      }
      // An omitted or reusable key can select an existing session. Generate the
      // key in the main process and issue at most one uncertain write for it.
      record = { key: `agent:${agentId}:dashboard:${randomUUID()}`, agentId, connection };
      this.creations.set(requestId, record);
    }
    const pending = this.createOrFindConversation(record);
    record.pending = pending;
    try { return await pending; }
    catch (error) {
      if (!record.uncertain) this.creations.delete(requestId);
      throw error;
    } finally { record.pending = undefined; }
  }
  async createOrFindConversation(record) {
    const { key, agentId } = record;
    const generation = this.base.generation;
    if (!record.uncertain) {
      try {
        const roster = await this.readFresh('agents.list', {}, true);
        this.base.assertCurrent(generation);
        if (!Array.isArray(roster?.agents) || !roster.agents.some(agent => agent?.id === agentId)) {
          fail('ACCESS', 'This agent is unavailable. Refresh the agent list and choose again.');
        }
      } catch (error) {
        const failure = error instanceof ReadError
          ? new ReadError(error.code, error.message)
          : new ReadError('UNAVAILABLE', 'The current agent list could not be verified.');
        failure.preflight = true;
        throw failure;
      }
    }
    try {
      let row;
      if (record.uncertain) {
        // A missing or hidden row does not prove the original write failed.
        // Check the exact generated key without attempting creation again.
        const result = await this.readFresh('sessions.describe', { key, agentId }, true);
        row = result?.session;
      } else {
        const result = await this.base.transport.write('sessions.create', { key, agentId });
        if (result?.ok === true && result.key === key && result.runStarted === false &&
            object(result.entry) && result.entry.sessionId === result.sessionId &&
            (result.entry.key === undefined || result.entry.key === key) &&
            (result.agentId === undefined || result.agentId === agentId) &&
            (result.entry?.agentId === undefined || result.entry.agentId === agentId)) {
          row = { ...result.entry, key, agentId };
        }
      }
      this.base.assertCurrent(generation);
      if (!row || row.key !== key || row.agentId !== agentId || row.archived === true ||
          !identifier(row.sessionId) || row.sessionId.trim() !== row.sessionId) {
        fail('UNCERTAIN', 'OpenClaw did not return a matching new conversation.');
      }
      record.result = sessionRow(row);
      record.uncertain = false;
      return { ...record.result };
    } catch (error) {
      if (!record.uncertain) {
        if (error.code === 'INVALID') fail('INVALID', 'OpenClaw could not create this conversation. Try New Session in original OpenClaw.');
        if (['BUSY','CLOSED'].includes(error.code)) error.preflight = true;
        if (['ACCESS','DENIED','CONFLICT','BUSY','CLOSED','UNSUPPORTED'].includes(error.code)) throw error;
      }
      record.uncertain = true;
      const unknown = new ReadError('UNCERTAIN', 'OpenClaw did not confirm the new conversation. Use Check again to look for it.');
      unknown.uncertain = true;
      throw unknown;
    }
  }
  async plan(input) {
    const generation = this.base.generation;
    const before = await this.describe(input, generation);
    const result = await this.base.read('progressCard.get', { sessionKey: input.key, agentId: input.agentId }, 0);
    this.base.assertCurrent(generation);
    if (result?.card === null) {
      const history = await this.base.read('chat.history', { sessionKey: input.key, agentId: input.agentId,
        limit: 1, maxBytes: 32768, toolResultMaxChars: 1 }, 0);
      this.base.assertCurrent(generation);
      if (history?.sessionId !== input.sessionId || history.windowReset) {
        fail('SESSION_CHANGED', 'This conversation changed. Refresh its task progress.');
      }
      if (history.sessionInfo?.lifecycleRevision !== undefined) sameLifecycle(before, history.sessionInfo);
      const after = await this.describe(input, generation);
      sameLifecycle(before, after);
      return normalizeActivePlan(history, after);
    }
    sameLifecycle(before, await this.describe(input, generation));
    return normalizeCard(result);
  }
  async send(input) {
    const signature = createHash('sha256').update(JSON.stringify([
      input.key, input.agentId, input.sessionId, input.message,
      input.expectedLeafEntryId === undefined ? { unknown: true } : input.expectedLeafEntryId,
      input.attachmentIds || [], input.replyToId ?? null,
    ])).digest('hex');
    let record = this.submissions.get(input.requestId);
    if (record && record.signature !== signature) fail('INVALID', 'This submission identity already belongs to a different message or session.');
    if (record?.pending) return record.pending;
    if (record?.result) return copyReceipt(record.result);
    if (!record) {
      if (this.submissions.size >= MAX_REQUESTS) {
        const settled = [...this.submissions].find(([, value]) => value.result && !value.pending);
        if (!settled) fail('BUSY', 'Too many messages have unconfirmed delivery. Reconcile them before sending another.');
        this.submissions.delete(settled[0]);
      }
      record = { signature, context: JSON.stringify([input.key,input.agentId,input.sessionId]) };
      this.submissions.set(input.requestId, record);
    }
    const wasUncertain = record.uncertain === true;
    const pending = this.sendBound(input, record);
    record.pending = pending;
    try { return await pending; }
    catch (error) {
      if (error.code === 'UNCERTAIN' || wasUncertain) {
        record.uncertain = true;
        if (error.code !== 'UNCERTAIN') {
          const uncertain = new ReadError('UNCERTAIN', 'The earlier send remains unconfirmed. Its original message and attachments are retained; refresh before retrying this same submission.');
          uncertain.requestId = input.requestId;
          throw uncertain;
        }
      } else {
        this.attachments?.settle(input.attachmentIds,input.requestId,false);
        record.params = undefined;
        // A definite rejection has no outcome to reconcile. Do not let failed
        // preflights fill the bounded receipt store and permanently block sends.
        if (this.submissions.get(input.requestId) === record) this.submissions.delete(input.requestId);
      }
      throw error;
    }
    finally { if (record.pending === pending) record.pending = undefined; }
  }
  async sendBound(input, record) {
    const generation = this.base.generation;
    // The standard known-leaf path performs the same fresh identity/archive check
    // inside the existing short-lived helper, reusing one SDK initialization.
    const checked=input.expectedLeafEntryId!==undefined&&this.base.transport.supportsCheckedSend===true&&typeof this.base.transport.sendChecked==='function';
    const before=checked?undefined:await this.describe(input,generation,true);
    if(before)assertSession(before,input,true);
    if (!record.params) {
      let leaf = input.expectedLeafEntryId;
      if (leaf === undefined) {
        const history = await this.readFresh('chat.history', { sessionKey: input.key, agentId: input.agentId,
          limit: 1, maxBytes: 32768, toolResultMaxChars: 1 }, true);
        this.base.assertCurrent(generation);
        if (history?.sessionId !== input.sessionId || history.windowReset) {
          fail('SESSION_CHANGED', 'This conversation changed. Refresh it before sending.');
        }
        leaf = history.sessionInfo?.activeLeafEntryId;
        if (leaf === undefined) leaf = history.activeLeafEntryId;
        sameLifecycle(before, await this.describe(input, generation, true));
      }
      if (leaf !== null && !identifier(leaf)) fail('BRANCH_UNKNOWN', 'The current conversation branch is unavailable. Refresh before sending.');
      if (input.attachmentIds?.length && !this.attachments) fail('UNAVAILABLE','Attachments are unavailable in this client.');
      const attachments = input.attachmentIds?.length ? this.attachments.snapshot(input,input.attachmentIds,input.requestId) : undefined;
      record.params = { sessionKey: input.key, agentId: input.agentId, sessionId: input.sessionId,
        message: input.message, idempotencyKey: input.requestId, expectedLeafEntryId: leaf,
        ...(input.replyToId !== undefined ? { replyToId: input.replyToId } : {}),
        ...(attachments?.length ? { attachments } : {}) };
    }
    this.base.assertCurrent(generation);
    try {
      const reply = await (checked?this.base.transport.sendChecked({ ...record.params }):this.base.transport.write('chat.send', { ...record.params }));
      this.base.assertCurrent(generation);
      record.result = normalizeSendReceipt(reply, input.requestId);
      record.uncertain = false;
      this.attachments?.settle(input.attachmentIds,input.requestId,true);
      record.params = undefined; // Confirmed sends retain only a signature and tiny receipt, not media bytes.
      this.base.invalidate();
      return copyReceipt(record.result);
    } catch (error) {
      this.base.invalidate();
      if (['INVALID', 'DENIED', 'ACCESS', 'CONFLICT'].includes(error.code)||checked&&error.preflight===true) throw error;
      const uncertain = new ReadError('UNCERTAIN', 'Message delivery is unconfirmed. Refresh the conversation; retry only this same submission identity.');
      uncertain.requestId = input.requestId;
      throw uncertain;
    }
  }
  async abort(input) {
    const generation = this.base.generation;
    const row = await this.describe(input, generation, true);
    if (Array.isArray(row.activeRunIds)) {
      if (row.activeRunIds.some(id => !identifier(id, 512))) fail('UNAVAILABLE', 'OpenClaw returned an unsupported active-run list.');
      if (!row.activeRunIds.includes(input.runId)) fail('RUN_CHANGED', 'This run is no longer in the current active set. Refresh its status.');
    } else if (row.hasActiveRun === false) {
      fail('RUN_CHANGED', 'This session no longer reports an active run. Refresh its status.');
    }
    this.base.assertCurrent(generation);
    try {
      const reply = await this.base.transport.write('chat.abort', { sessionKey: input.key, agentId: input.agentId, runId: input.runId });
      this.base.assertCurrent(generation);
      if (!object(reply) || reply.ok !== true || typeof reply.aborted !== 'boolean' || !Array.isArray(reply.runIds) ||
          reply.runIds.length > 1000 || reply.runIds.some(id => !identifier(id, 512))) {
        fail('UNCERTAIN', 'OpenClaw returned an unrecognized stop receipt.');
      }
      const result = { ok: true, aborted: reply.aborted, runIds: [...reply.runIds] };
      if (typeof reply.warning === 'string') result.warning = reply.warning.slice(0, 2000);
      this.base.invalidate();
      return result;
    } catch (error) {
      this.base.invalidate();
      if (['INVALID', 'DENIED', 'ACCESS', 'CONFLICT'].includes(error.code)) throw error;
      fail('UNCERTAIN', 'Stopping may already have taken effect. Refresh the exact run before trying Stop again.');
    }
  }
}

module.exports = { ConversationActions, OPERATIONS };
