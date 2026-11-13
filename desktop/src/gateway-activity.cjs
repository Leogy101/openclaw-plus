'use strict';
const { ReadError } = require('./gateway-cli.cjs');

const TTL = 15000;
const FRESH_MS = 45000;
const PAGE_SIZE = 100;
const MAX_EVENTS = 500;
const MAX_CONTEXTS = 8;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const array = value => Array.isArray(value) ? value : [];
const id = (value, max = 1024) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value);
const fail = (code, message) => { throw new ReadError(code, message); };

function validate(input) {
  if (!object(input) || Object.keys(input).some(key => !['key','agentId','sessionId','cursor'].includes(key)) ||
      ['key','agentId','sessionId'].some(key => !id(input[key])) ||
      input.cursor !== undefined && !id(input.cursor, 8192)) {
    fail('INVALID', 'Select an exact session to inspect its activity.');
  }
  return { ...input };
}
const identity = row => JSON.stringify([row.agentId, row.key, row.sessionId]);
const context = input => ({ key: input.key, agentId: input.agentId, sessionId: input.sessionId });
const historyParams = input => ({ sessionKey: input.key, agentId: input.agentId, limit: 1, maxBytes: 32768, toolResultMaxChars: 1 });
function sameSession(row, input) {
  return object(row) && row.sessionId === input.sessionId && (row.agentId === undefined || row.agentId === input.agentId) &&
    (row.key === undefined || row.key === input.key);
}
function sameLifecycle(before, after) {
  return before.lifecycleRevision === after.lifecycleRevision;
}
function historyMatches(history, row) {
  return object(history) && history.sessionId === row.sessionId && !history.windowReset &&
    (history.sessionKey === undefined || history.sessionKey === row.key) &&
    (!history.sessionInfo || sameSession(history.sessionInfo, row)) &&
    (row.lifecycleRevision === undefined ? history.sessionInfo?.lifecycleRevision === undefined :
      history.sessionInfo?.lifecycleRevision === row.lifecycleRevision);
}
function permitsRun(row, runId) {
  if (!object(row) || row.hasActiveRun === false) return false;
  // Exact IDs are a complete set when present. Omission means unavailable;
  // an authoritative history run can still identify one active owner.
  return Array.isArray(row.activeRunIds) ? row.activeRunIds.includes(runId) :
    row.activeRunIds === undefined && row.hasActiveRun === true;
}
function scopedRun(history, row) {
  const run = history?.inFlightRun;
  return historyMatches(history, row) && id(run?.runId, 512) &&
    (run.sessionKey === undefined || run.sessionKey === row.key) &&
    (run.sessionId === undefined || run.sessionId === row.sessionId) &&
    (run.agentId === undefined || run.agentId === row.agentId) &&
    permitsRun(row, run.runId) && permitsRun(history.sessionInfo, run.runId) ? run : null;
}
function scopedEvents(history, row) {
  const run = scopedRun(history, row);
  if (!run) return [];
  return array(run.events).slice(-50).filter(event => object(event) && event.runId === run.runId &&
    (event.sessionKey === undefined || event.sessionKey === row.key) &&
    (event.sessionId === undefined || event.sessionId === row.sessionId) &&
    (event.agentId === undefined || event.agentId === row.agentId)).map(event => ({
      ...event, sessionKey: row.key, agentId: row.agentId, sessionId: row.sessionId,
  }));
}
function boundedAudit(result) {
  if (!object(result) || !Array.isArray(result.events)) return null;
  return { events: result.events.filter(object).slice(0, PAGE_SIZE), available: true,
    ...(id(result.nextCursor, 8192) ? { nextCursor: result.nextCursor } : {}) };
}

class ActivityService {
  constructor(base, { projectReader } = {}) {
    this.base = base;
    this.projectReader = projectReader;
    this.cache = new Map();
    this.pending = new Map();
    this.views = new Map();
  }
  async read(params) {
    const input = validate(params), generation = this.base.generation;
    const key = JSON.stringify([generation, input.agentId, input.key, input.sessionId]);
    const pendingKey = JSON.stringify([key, input.cursor]);
    let snapshot;
    if (this.pending.has(pendingKey)) snapshot = await this.pending.get(pendingKey);
    else if (!input.cursor && this.cache.get(key)?.observedAt + TTL > Date.now()) snapshot = this.cache.get(key);
    else {
      const promise = input.cursor ? this.more(input, key, generation) : this.collect(input, generation);
      this.pending.set(pendingKey, promise);
      try {
        snapshot = await promise;
        this.base.assertCurrent(generation);
        if (this.cache.size >= MAX_CONTEXTS && !this.cache.has(key)) {
          const oldest = this.cache.keys().next().value;
          this.cache.delete(oldest); this.views.delete(oldest);
        }
        this.cache.set(key, snapshot);
      } finally { if (this.pending.get(pendingKey) === promise) this.pending.delete(pendingKey); }
    }
    this.base.assertCurrent(generation);
    const lifecycleRevision = snapshot.sessions.find(row => sameSession(row, input))?.lifecycleRevision;
    const previous = this.views.get(key);
    const view = await this.present(snapshot, previous?.lifecycleRevision === lifecycleRevision ? previous?.view : undefined);
    this.base.assertCurrent(generation);
    this.views.set(key, { lifecycleRevision, view });
    return view;
  }
  async present(snapshot, previous) {
    const { buildActivity } = await import('../shared/activity-model.mjs');
    return buildActivity(snapshot, { now: Date.now(), previous });
  }
  async describe(input, generation) {
    const result = await this.base.read('sessions.describe', { key: input.key, agentId: input.agentId }, 0);
    this.base.assertCurrent(generation);
    if (!sameSession(result?.session, input)) fail('SESSION_CHANGED', 'This session changed or is no longer accessible. Select it again.');
    return { ...result.session, ...context(input) };
  }
  async more(input, key, generation) {
    const previous = this.cache.get(key);
    if (!previous || previous.audit.nextCursor !== input.cursor) fail('STALE', 'Refresh activity before loading an older page.');
    const page = boundedAudit(await this.base.read('audit.activity.list', {
      agentId: input.agentId, sessionKey: input.key, limit: PAGE_SIZE, cursor: input.cursor,
    }, TTL));
    this.base.assertCurrent(generation);
    if (this.cache.get(key) !== previous) fail('STALE', 'Activity refreshed while loading older events. Try again.');
    if (!page) fail('UNAVAILABLE', 'OpenClaw did not return an activity page.');
    const seen = new Set(), events = [...previous.audit.events, ...page.events].filter(event => {
      if (!id(event.eventId) || seen.has(event.eventId)) return false;
      seen.add(event.eventId); return true;
    });
    const limited = events.length >= MAX_EVENTS;
    return { ...previous, audit: { ...page, events: events.slice(0, MAX_EVENTS), ...(limited ? { nextCursor: undefined } : {}) },
      limitations: [...previous.limitations, ...(limited ? ['Timeline is limited to 500 retained events. Older activity remains in OpenClaw.'] : [])] };
  }
  async collect(input, generation) {
    const observedAt = Date.now();
    const before = await this.describe(input, generation), limitations = [];
    const requests = {
      agents: () => this.base.read('agents.list', {}, 60000),
      active: () => this.base.read('sessions.list', { activeOnly: true, limit: 100, archived: 'all', includeGlobal: false, includeUnknown: false }, TTL),
      children: () => this.base.read('sessions.list', { spawnedBy: input.key, archived: 'all', limit: 100, includeDerivedTitles: true, includeGlobal: false, includeUnknown: false }, TTL),
      processes: () => this.base.read('sessions.processes.list', { key: input.key, agentId: input.agentId }, 0),
      history: () => this.base.read('chat.history', historyParams(input), 0),
      card: () => this.base.read('progressCard.get', { sessionKey: input.key, agentId: input.agentId }, 0),
      audit: () => this.base.read('audit.activity.list', { agentId: input.agentId, sessionKey: input.key, limit: PAGE_SIZE }, TTL),
      jobs: () => this.base.read('cron.list', { includeDisabled: true, limit: 100, offset: 0, compact: false, includeDeliveryPreviews: false }, 30000),
      occurrences: () => this.base.read('cron.runs', { scope: 'all', limit: 50, sortDir: 'desc' }, 30000),
      ...(this.projectReader ? { project: () => this.projectReader() } : {}),
    };
    const names = Object.keys(requests);
    const results = await Promise.allSettled(names.map(name => Promise.resolve().then(requests[name])));
    this.base.assertCurrent(generation);
    const data = {};
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') data[names[index]] = result.value;
      else limitations.push(`${names[index]} evidence is unavailable for this snapshot.`);
    });
    if (data.history && !historyMatches(data.history, before)) fail('SESSION_CHANGED', 'Conversation activity belongs to another session lifecycle. Refresh this session.');
    if (data.processes && data.processes.sessionId !== input.sessionId) fail('SESSION_CHANGED', 'The process owner changed. Refresh this session.');
    if (data.card?.card?.sessionKey !== undefined && data.card.card.sessionKey !== input.key) fail('SESSION_CHANGED', 'The task checklist belongs to another session.');

    const children = array(data.children?.sessions).filter(row => object(row) && id(row.key) && row.key !== input.key).slice(0, 100).map(row => ({ ...row }));
    const active = array(data.active?.sessions).filter(row => object(row) &&
      !(row.key === input.key && row.agentId === input.agentId && row.sessionId !== input.sessionId)).slice(0, 100);
    const processes = [], liveEvents = [];
    const addProcesses = (result, row) => {
      if (result?.sessionId !== row.sessionId || !Array.isArray(result.processes)) return false;
      processes.push(...result.processes.filter(object).slice(0, 50).map(process => ({ ...process,
        sessionKey: row.key, sessionId: row.sessionId, agentId: row.agentId })));
      return !result.truncated;
    };
    let processCoverage = addProcesses(data.processes, before);
    const eligible = children.filter(row => id(row.agentId) && id(row.sessionId) && row.hasActiveRun === true);
    // Three child reads total, irrespective of roster size: history+process for the first, history for the second.
    const enrichments = eligible.slice(0, 2).flatMap((row, index) => [
      { row, kind: 'history', read: () => this.base.read('chat.history', historyParams(row), 0) },
      ...(index === 0 ? [{ row, kind: 'processes', read: () => this.base.read('sessions.processes.list', { key: row.key, agentId: row.agentId }, 0) }] : []),
    ]);
    const enrichmentReads = enrichments.map(item => Promise.resolve().then(item.read));
    if (children.length) enrichmentReads.push(this.base.read('audit.activity.list', { limit: PAGE_SIZE }, TTL));
    const allEnriched = await Promise.allSettled(enrichmentReads);
    const enriched = allEnriched.slice(0, enrichments.length);
    const relatedAudit = children.length ? allEnriched.at(-1) : undefined;
    this.base.assertCurrent(generation);
    enriched.forEach((result, index) => {
      const item = enrichments[index];
      if (result.status !== 'fulfilled') { limitations.push('Some delegated-session activity could not be read.'); processCoverage = false; return; }
      if (item.kind === 'processes') { if (!addProcesses(result.value, item.row)) processCoverage = false; }
      else if (historyMatches(result.value, item.row)) {
        const info = result.value.sessionInfo || {}, bound = context(item.row);
        // The list row can be cached; the same-lifecycle history observation
        // replaces its runtime projection before correlating the current run.
        Object.assign(item.row, info, bound, { hasActiveRun: info.hasActiveRun, activeRunIds: info.activeRunIds });
        const run = scopedRun(result.value, item.row), events = scopedEvents(result.value, item.row);
        if (run && info.activeRunIds === undefined) item.row.observedRunIds = [run.runId];
        liveEvents.push(...events);
      }
      else limitations.push('Delegated activity changed lifecycle and was omitted.');
    });
    if (children.length) {
      // Idle child sessions can still own background processes; this bounded adapter does not claim full coverage.
      processCoverage = false;
      limitations.push('Delegated details are sampled: at most three child history/process reads per refresh; other child processes and deeper descendants may be omitted.');
    }
    const selectedRun = scopedRun(data.history, before);
    liveEvents.push(...scopedEvents(data.history, before));
    const approvalCandidates = new Map(), ambiguousApprovals = new Set();
    for (const event of liveEvents) {
      const detail = event.data?.result?.details;
      const approvalId = event.stream === 'item' && event.data?.status === 'blocked' ? event.data.approvalId :
        detail?.status === 'approval-pending' ? detail.approvalId : undefined;
      if (!id(approvalId, 2048)) continue;
      const previous = approvalCandidates.get(approvalId);
      if (previous && JSON.stringify([previous.agentId, previous.sessionId, previous.runId]) !== JSON.stringify([event.agentId, event.sessionId, event.runId])) ambiguousApprovals.add(approvalId);
      else approvalCandidates.set(approvalId, event);
    }
    const candidates = [...approvalCandidates].filter(([approvalId]) => !ambiguousApprovals.has(approvalId));
    const approvalResults = await Promise.allSettled(candidates.slice(0, 4).map(([approvalId]) => this.base.read('approval.get', { id: approvalId }, TTL)));
    this.base.assertCurrent(generation);
    const approvals = [];
    approvalResults.forEach((result, index) => {
      const [approvalId, event] = candidates[index], approval = result.status === 'fulfilled' ? result.value?.approval : null;
      if (!object(approval) || approval.id !== approvalId || !['pending','allowed','denied','expired','cancelled'].includes(approval.status) ||
          !Number.isFinite(approval.expiresAtMs) || (approval.sourceSessionKey !== undefined && approval.sourceSessionKey !== event.sessionKey) ||
          (approval.presentation?.agentId !== undefined && approval.presentation.agentId !== event.agentId)) {
        limitations.push('A runtime approval reference could not be verified against its current owner record.'); return;
      }
      approvals.push({ id: approvalId, approvalId, status: approval.status,
        ...(Number.isFinite(approval.createdAtMs) ? { createdAtMs: approval.createdAtMs, createdAt: approval.createdAtMs } : {}),
        expiresAtMs: approval.expiresAtMs, expiresAt: approval.expiresAtMs,
        agentId: event.agentId, sessionKey: event.sessionKey, sessionId: event.sessionId, runId: event.runId });
    });
    if (candidates.length > 4 || ambiguousApprovals.size) limitations.push('Approval verification is limited to four unambiguous current-runtime references per refresh.');
    const after = await this.describe(input, generation);
    if (!sameLifecycle(before, after)) fail('SESSION_CHANGED', 'This conversation changed lifecycle while activity was loading. Refresh it.');
    const selectedRunCurrent = selectedRun && permitsRun(after, selectedRun.runId);
    if (selectedRunCurrent && after.activeRunIds === undefined) after.observedRunIds = [selectedRun.runId];
    const currentEvents = liveEvents.filter(event => event.agentId !== input.agentId || event.sessionKey !== input.key ||
      selectedRunCurrent && selectedRun.runId === event.runId);
    const currentApprovals = approvals.filter(approval => currentEvents.some(event => event.agentId === approval.agentId &&
      event.sessionId === approval.sessionId && event.runId === approval.runId));
    const rows = new Map();
    for (const row of [...active, ...children, after]) {
      if (id(row.key) && id(row.agentId) && id(row.sessionId)) rows.set(identity(row), row);
    }
    const audit = boundedAudit(data.audit) || { events: [], available: false };
    if (children.length) {
      const relatedPage = relatedAudit?.status === 'fulfilled' ? boundedAudit(relatedAudit.value) : null;
      if (relatedPage) {
        const seen = new Set();
        audit.events = [...audit.events, ...relatedPage.events].filter(event => {
          if (!id(event.eventId) || seen.has(event.eventId)) return false;
          seen.add(event.eventId); return true;
        }).slice(0, PAGE_SIZE * 2);
      } else limitations.push('The recent audit window for related child sessions is unavailable.');
      limitations.push('Child audit history uses only the latest 100 gateway events; older-page navigation covers the selected session only.');
    }
    const childrenComplete = Array.isArray(data.children?.sessions) && !data.children.hasMore && children.length < 100;
    const activeComplete = Array.isArray(data.active?.sessions) && !data.active.hasMore && active.length < 100;
    if (!childrenComplete) limitations.push('Related sessions are unavailable or bounded; this is not a complete descendant inventory.');
    if (!activeComplete) limitations.push('The active-session roster is unavailable or bounded; agent badges may be incomplete.');
    if (data.jobs?.hasMore || data.occurrences?.hasMore) limitations.push('Automation jobs and recent occurrences are bounded; older records remain in OpenClaw.');
    limitations.push('Audit history is metadata-only, best effort and retention-limited. Missing events do not prove inactivity.',
      'Process observations cover OpenClaw-registered commands, not every script on the Mac. Finished records may expire.',
      'Current tool snapshots are bounded; absent tool details do not prove a run is idle.');
    const card = data.card?.card;
    const cardValid = object(card) && Number.isSafeInteger(card.revision) && card.revision >= 1 && Number.isSafeInteger(card.updatedAt);
    if (card !== undefined && card !== null && !cardValid) limitations.push('The task checklist receipt was unsupported and was omitted.');
    const { normalizeRunStatus } = await import('../shared/run-status.mjs');
    const runStatus = normalizeRunStatus(data.history ? { ...data.history, sessionInfo: after,
      inFlightRun: selectedRunCurrent ? selectedRun : undefined } : null,
    { context: context(input), observedAt });
    if (data.history?.inFlightRun && !selectedRunCurrent && runStatus.state === 'active') {
      // The final row can prove aggregate activity without proving the sampled
      // owner. Preserve that distinction instead of reviving rejected details.
      runStatus.detail = 'OpenClaw reports an active response; sampled run details could not be confirmed for the current session.';
    }
    return {
      context: context(input), observedAt, freshUntil: observedAt + FRESH_MS, runStatus,
      agents: array(data.agents?.agents).filter(object).slice(0, 200).map(agent => ({ id: agent.id, name: agent.name || agent.identity?.name || agent.id })),
      sessions: [...rows.values()], processes, liveEvents: currentEvents, audit, approvals: currentApprovals,
      jobs: array(data.jobs?.jobs).filter(object).slice(0, 100),
      occurrences: array(data.occurrences?.entries).filter(object).slice(0, 50),
      cards: cardValid ? [{ ...card, sessionKey: input.key, agentId: input.agentId, sessionId: input.sessionId }] : [],
      coverage: { session: true, children: childrenComplete, processes: processCoverage, activeSessions: activeComplete,
        audit: audit.available, automations: Array.isArray(data.jobs?.jobs) && Array.isArray(data.occurrences?.entries) && !data.jobs.hasMore && !data.occurrences.hasMore },
      limitations: [...new Set(limitations)], ...(data.project !== undefined ? { project: data.project } : {}),
    };
  }
}

module.exports = { ActivityService };
