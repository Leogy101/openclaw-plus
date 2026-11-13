'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ActivityService } = require('../desktop/src/gateway-activity.cjs');
const { ReadError } = require('../desktop/src/gateway-cli.cjs');

const selected = { key: 'agent:main:main', agentId: 'main', sessionId: 'physical-1' };
const row = { ...selected, lifecycleRevision: 'life-1', hasActiveRun: true, activeRunIds: ['run-1'],
  goal: { id: 'goal-1', status: 'blocked', lastStatusNote: 'Fixture reported blocker.' } };
const event = { runId: 'run-1', seq: 1, ts: 1000, stream: 'tool',
  data: { phase: 'start', toolCallId: 'call-1', name: 'exec', args: { command: 'npm test' } } };
const auditEvent = { schemaVersion: 1, redaction: 'metadata_only', eventId: 'audit-1', sequence: 1, eventType: 'tool_action', runId: 'run-1',
  agentId: selected.agentId, sessionKey: selected.key, sessionId: selected.sessionId,
  toolName: 'exec', action: 'tool.action.started', status: 'started', occurredAt: 1000 };
function fixture({ respond, projectReader } = {}) {
  const calls = [];
  const base = {
    generation: 0,
    assertCurrent(generation) { if (generation !== this.generation) throw new ReadError('STALE', 'Connection changed.'); },
    async read(method, params, ttl) {
      calls.push({ method, params, ttl });
      const defaults = () => {
        if (method === 'sessions.describe') return { session: structuredClone(row) };
        if (method === 'agents.list') return { agents: [{ id: 'main', identity: { name: 'Coordinator' } }] };
        if (method === 'sessions.list') return { sessions: params.activeOnly ? [structuredClone(row)] : [], hasMore: false };
        if (method === 'sessions.processes.list') return { sessionId: selected.sessionId, processes: [{ processId: 'p1', instanceId: 'instance1', name: 'npm run', status: 'running' }], truncated: false };
        if (method === 'chat.history') return { sessionId: selected.sessionId, sessionInfo: structuredClone(row), inFlightRun: { runId: 'run-1', events: [structuredClone(event)] } };
        if (method === 'progressCard.get') return { card: { sessionKey: selected.key, revision: 2, updatedAt: 1234, steps: [] } };
        if (method === 'audit.activity.list') return { events: [structuredClone(auditEvent)], nextCursor: 'older-1' };
        if (method === 'cron.list') return { jobs: [{ id: 'job-1', state: { runningAtMs: 1000 } }], hasMore: false };
        if (method === 'cron.runs') return { entries: [{ jobId: 'job-1', runId: 'cron-run-1', action: 'finished', status: 'ok', completionStatus: 'succeeded' }], hasMore: false };
        throw new Error('Unexpected read: ' + method);
      };
      return respond ? respond(method, params, defaults) : defaults();
    },
  };
  const service = new ActivityService(base, { projectReader });
  // Inspect the adapter input independently of the platform-independent model owned by another module.
  service.present = async snapshot => snapshot;
  return { service, base, calls };
}
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }

test('snapshot uses supported bounded reads, exact identity, native goal and raw evidence', async () => {
  const project = { available: true, fields: [{ path: 'checkpoint', value: 'fixture' }] };
  const { service, calls } = fixture({ projectReader: async () => project });
  const result = await service.read(selected);
  assert.deepEqual(result.context, selected);
  assert.equal(result.sessions.find(s => s.key === selected.key).goal.status, 'blocked');
  assert.equal(result.liveEvents[0].data.args.command, 'npm test');
  assert.equal(result.liveEvents[0].sessionId, selected.sessionId);
  assert.equal(result.processes[0].name, 'npm run');
  assert.equal(result.cards[0].revision, 2);
  assert.equal(result.cards[0].sessionId, selected.sessionId);
  assert.deepEqual(result.project, project);
  assert.equal(result.freshUntil - result.observedAt, 45000);
  assert.equal(calls[0].method, 'sessions.describe');
  assert.equal(calls.at(-1).method, 'sessions.describe');
  assert.deepEqual(calls.find(c => c.method === 'chat.history').params,
    { sessionKey: selected.key, agentId: 'main', limit: 1, maxBytes: 32768, toolResultMaxChars: 1 });
  assert.deepEqual(calls.find(c => c.method === 'audit.activity.list').params,
    { agentId: selected.agentId, sessionKey: selected.key, limit: 100 });
  assert.equal(calls.filter(c => c.method === 'audit.activity.list').length, 1);
  assert.deepEqual(calls.find(c => c.method === 'cron.list').params,
    { includeDisabled: true, limit: 100, offset: 0, compact: false, includeDeliveryPreviews: false });
  assert.deepEqual(result.coverage, { session: true, children: true, processes: true, activeSessions: true, audit: true, automations: true });
});

test('concurrent requests coalesce and 15-second cache remains exact to physical identity', async () => {
  const gate = deferred();
  const { service, calls } = fixture({ respond: async (method, params, defaults) => {
    if (method === 'agents.list') await gate.promise;
    return defaults();
  } });
  const first = service.read(selected), second = service.read({ ...selected });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(c => c.method === 'agents.list').length, 1);
  gate.resolve();
  assert.deepEqual(await first, await second);
  const count = calls.length;
  await service.read(selected);
  assert.equal(calls.length, count);
  await assert.rejects(service.read({ ...selected, sessionId: 'another-physical-session' }), { code: 'SESSION_CHANGED' });
  assert.equal(calls.length, count + 1);
});

test('expired snapshots refresh and previous model view is passed only within exact context', async t => {
  const originalNow = Date.now;
  let now = 100000;
  Date.now = () => now;
  t.after(() => { Date.now = originalNow; });
  const { service, calls } = fixture();
  const previousValues = [];
  service.present = async (snapshot, previous) => { previousValues.push(previous); return { marker: snapshot.observedAt }; };
  assert.deepEqual(await service.read(selected), { marker: 100000 });
  const count = calls.length;
  now += 14000;
  await service.read(selected);
  assert.equal(calls.length, count);
  now += 1001;
  assert.deepEqual(await service.read(selected), { marker: 115001 });
  assert.ok(calls.length > count);
  assert.equal(previousValues[0], undefined);
  assert.deepEqual(previousValues[2], { marker: 100000 });
});

test('older audit pages use only an issued cursor, deduplicate and preserve original freshness', async () => {
  const { service, calls } = fixture({ respond: (method, params, defaults) => method === 'audit.activity.list' && params.cursor ?
    { events: [auditEvent, { ...auditEvent, eventId: 'audit-0', sequence: 0 }], nextCursor: 'older-2' } : defaults() });
  const first = await service.read(selected), count = calls.length;
  const next = await service.read({ ...selected, cursor: first.audit.nextCursor });
  assert.equal(calls.length, count + 1);
  assert.equal(calls.at(-1).method, 'audit.activity.list');
  assert.deepEqual(calls.at(-1).params, { agentId: selected.agentId, sessionKey: selected.key, limit: 100, cursor: 'older-1' });
  assert.equal(next.audit.events.length, 2);
  assert.equal(next.observedAt, first.observedAt);
  assert.equal(next.freshUntil, first.freshUntil);
  assert.equal(next.audit.nextCursor, 'older-2');
  await assert.rejects(service.read({ ...selected, cursor: 'unissued-cursor' }), { code: 'STALE' });
  assert.equal(calls.length, count + 1);
});

test('initial or mid-read physical replacement and clear lifecycle reject the entire snapshot', async () => {
  for (const replacement of [{ ...row, sessionId: 'physical-2' }, { ...row, lifecycleRevision: 'life-2' }]) {
    let descriptions = 0;
    const { service } = fixture({ respond: (method, params, defaults) => method === 'sessions.describe' ?
      { session: ++descriptions === 1 ? row : replacement } : defaults() });
    await assert.rejects(service.read(selected), { code: 'SESSION_CHANGED' });
    assert.equal(service.cache.size, 0);
  }
  const initial = fixture({ respond: (method, params, defaults) => method === 'sessions.describe' ? { session: null } : defaults() });
  await assert.rejects(initial.service.read(selected), { code: 'SESSION_CHANGED' });
  assert.equal(initial.calls.length, 1);
});

test('history/process/card mismatches cannot be attributed to the selected session', async () => {
  for (const [target, result] of [
    ['chat.history', { sessionId: 'wrong', sessionInfo: row }],
    ['chat.history', { sessionId: row.sessionId, sessionInfo: { ...row, lifecycleRevision: 'old-life' } }],
    ['sessions.processes.list', { sessionId: 'wrong', processes: [] }],
    ['progressCard.get', { card: { sessionKey: 'agent:researcher:main' } }],
  ]) {
    const { service } = fixture({ respond: (method, params, defaults) => method === target ? result : defaults() });
    await assert.rejects(service.read(selected), { code: 'SESSION_CHANGED' });
  }
});

test('an exact current history run supplies positive evidence when the complete active ID set is unavailable', async () => {
  const withoutIds = () => { const copy = structuredClone(row); delete copy.activeRunIds; return copy; };
  const { service, calls } = fixture({ respond: (method, params, defaults) => {
    if (method === 'sessions.describe') return { session: withoutIds() };
    if (method === 'chat.history') return { ...defaults(), sessionInfo: withoutIds(),
      inFlightRun: { runId: 'run-1', startedAt: 1000, events: [event,
        { runId: 'run-1', seq: 2, stream: 'usage', ts: 2000, data: { outputTokens: 0 } }] } };
    return defaults();
  } });
  const snapshot = await service.read(selected), session = snapshot.sessions.find(item => item.key === selected.key);
  assert.equal(snapshot.liveEvents.length, 2);
  assert.equal(snapshot.liveEvents[0].runId, 'run-1');
  assert.equal(snapshot.liveEvents[0].data.args.command, 'npm test');
  assert.equal(session.hasActiveRun, true);
  assert.equal(session.activeRunIds, undefined, 'one observed run is not a fabricated complete active set');
  assert.deepEqual(session.observedRunIds, ['run-1']);
  assert.equal(snapshot.runStatus.state, 'active');
  assert.equal(snapshot.runStatus.runId, 'run-1');
  assert.equal(snapshot.runStatus.startedAt, 1000);
  assert.equal(snapshot.runStatus.outputTokens, 0);
  assert.equal(snapshot.runStatus.observedAt, snapshot.observedAt);
  assert.equal(calls.filter(item => item.method === 'sessions.describe').length, 2);
  assert.equal(calls.filter(item => item.method === 'chat.history').length, 1);
});

test('explicit idle, conflicting or invalid active IDs at any selected read boundary reject current run evidence', async () => {
  for (const stage of ['before', 'history', 'after']) for (const conflict of [
    { activeRunIds: [] }, { activeRunIds: ['another-run'] }, { activeRunIds: null },
    { hasActiveRun: false }, { hasActiveRun: undefined, activeRunIds: undefined },
  ]) {
    let descriptions = 0;
    const { service } = fixture({ respond: (method, params, defaults) => {
      if (method === 'sessions.describe') {
        const boundary = ++descriptions === 1 ? 'before' : 'after';
        return { session: { ...row, ...(stage === boundary ? conflict : {}) } };
      }
      if (method === 'chat.history' && stage === 'history') return { ...defaults(), sessionInfo: { ...row, ...conflict } };
      return defaults();
    } });
    const snapshot = await service.read(selected);
    assert.deepEqual(snapshot.liveEvents, [], `${stage}: ${JSON.stringify(conflict)}`);
    assert.equal(snapshot.sessions.find(item => item.key === selected.key).observedRunIds, undefined);
    assert.equal(snapshot.runStatus.runId, undefined, 'contradictory evidence cannot carry an exact live owner');
    assert.equal(snapshot.runStatus.startedAt, undefined);
    assert.equal(snapshot.runStatus.outputTokens, undefined);
    if (snapshot.runStatus.state === 'active') assert.match(snapshot.runStatus.detail, /could not be confirmed/);
  }
});

test('the current footer uses final idle telemetry and remains unknown when history was unavailable', async () => {
  for (const unavailable of [false, true]) {
    let descriptions = 0;
    const { service } = fixture({ respond: (method, params, defaults) => {
      if (method === 'sessions.describe' && ++descriptions > 1) return { session: { ...row, hasActiveRun: false, activeRunIds: [] } };
      if (method === 'chat.history' && unavailable) throw new Error('fixture history unavailable');
      return defaults();
    } });
    const snapshot = await service.read(selected);
    assert.equal(snapshot.runStatus.state, unavailable ? 'unknown' : 'idle');
    assert.equal(snapshot.runStatus.runId, undefined);
    assert.deepEqual(snapshot.liveEvents, []);
  }
});

test('only events from the authoritative current history run and exact session owner survive', async () => {
  for (const activeRunIds of [[], ['another-run']]) {
    const { service } = fixture({ respond: (method, params, defaults) => method === 'sessions.describe' ?
      { session: { ...row, activeRunIds } } : defaults() });
    assert.deepEqual((await service.read(selected)).liveEvents, []);
  }
  const { service } = fixture({ respond: (method, params, defaults) => method === 'chat.history' ?
    { ...defaults(), inFlightRun: { runId: 'run-1', events: [event, { ...event, runId: 'other' }, { ...event, agentId: 'researcher' },
      { ...event, sessionKey: 'other' }, { ...event, sessionId: 'another-physical-session' }] } } : defaults() });
  assert.equal((await service.read(selected)).liveEvents.length, 1);
});

test('explicit foreign in-flight ownership never becomes current events, partial identity or footer details', async () => {
  for (const conflict of [{ sessionKey: 'agent:researcher:main' }, { sessionId: 'another-physical-session' }, { agentId: 'researcher' }]) {
    const { service, calls } = fixture({ respond: (method, params, defaults) => {
      if (method === 'sessions.describe') { const result = defaults(); delete result.session.activeRunIds; return result; }
      if (method === 'chat.history') {
        const result = defaults(); delete result.sessionInfo.activeRunIds;
        return { ...result, inFlightRun: { ...result.inFlightRun, ...conflict } };
      }
      return defaults();
    } });
    const snapshot = await service.read(selected);
    assert.deepEqual(snapshot.liveEvents, []);
    assert.equal(snapshot.sessions.find(item => item.key === selected.key).observedRunIds, undefined);
    assert.equal(snapshot.runStatus.state, 'active', 'fresh final direct activity is still an independent aggregate fact');
    assert.equal(snapshot.runStatus.runId, undefined);
    assert.equal(snapshot.runStatus.tool, undefined);
    assert.match(snapshot.runStatus.detail, /could not be confirmed/);
    assert.equal(calls.filter(item => item.method === 'sessions.describe').length, 2);
    assert.equal(calls.filter(item => item.method === 'chat.history').length, 1);
  }
});

test('a same-lifecycle child history run can identify activity without claiming the complete active set', async () => {
  const child = { key: 'agent:builder:child', agentId: 'builder', sessionId: 'child-physical',
    lifecycleRevision: 'child-life', parentSessionKey: selected.key, hasActiveRun: true };
  const { service } = fixture({ respond: (method, params, defaults) => {
    if (method === 'sessions.list' && params.spawnedBy) return { sessions: [child] };
    if (method === 'chat.history' && params.agentId === 'builder') return { sessionKey: child.key,
      sessionId: child.sessionId, sessionInfo: child, inFlightRun: { runId: 'child-run', events: [{ ...event, runId: 'child-run' }] } };
    if (method === 'sessions.processes.list' && params.agentId === 'builder') return { sessionId: child.sessionId, processes: [] };
    return defaults();
  } });
  const snapshot = await service.read(selected), observed = snapshot.sessions.find(item => item.sessionId === child.sessionId);
  assert.deepEqual(observed.observedRunIds, ['child-run']);
  assert.equal(observed.activeRunIds, undefined);
  assert.equal(snapshot.liveEvents.find(item => item.sessionId === child.sessionId).runId, 'child-run');
});

test('optional source failures preserve current session and disclose partial coverage without raw errors', async () => {
  const missing = new Set(['sessions.processes.list', 'audit.activity.list', 'cron.runs', 'sessions.list']);
  const { service } = fixture({ respond: (method, params, defaults) => {
    if (missing.has(method)) throw new Error('private-token-do-not-show');
    return defaults();
  } });
  const result = await service.read(selected);
  assert.equal(result.coverage.session, true);
  for (const field of ['children','processes','activeSessions','audit','automations']) assert.equal(result.coverage[field], false);
  assert.equal(result.audit.available, false);
  assert.equal(result.processes.length, 0);
  assert.ok(!JSON.stringify(result).includes('private-token-do-not-show'));
});

test('child detail fanout is capped at three reads and partial process scope is explicit', async () => {
  const children = Array.from({ length: 5 }, (_, i) => ({ key: `agent:builder:child-${i}`, agentId: 'builder', sessionId: `child-physical-${i}`,
    lifecycleRevision: `child-life-${i}`, parentSessionKey: selected.key, hasActiveRun: true, activeRunIds: [`child-run-${i}`] }));
  const { service, calls } = fixture({ respond: (method, params, defaults) => {
    if (method === 'sessions.list' && params.spawnedBy) return { sessions: children };
    const child = children.find(row => row.key === (params.sessionKey || params.key));
    if (child && method === 'chat.history') return { sessionId: child.sessionId, sessionInfo: child,
      inFlightRun: { runId: child.activeRunIds[0], events: [{ ...event, runId: child.activeRunIds[0] }] } };
    if (child && method === 'sessions.processes.list') return { sessionId: child.sessionId, processes: [], truncated: false };
    return defaults();
  } });
  const result = await service.read(selected);
  const enrichment = calls.filter(c => ['chat.history','sessions.processes.list'].includes(c.method) && c.params.agentId === 'builder');
  assert.equal(enrichment.length, 3);
  assert.equal(result.liveEvents.length, 3);
  assert.equal(result.sessions.length, 6);
  assert.equal(result.coverage.processes, false);
  assert.ok(result.limitations.some(text => text.includes('at most three')));
});

test('connection invalidation during reads cannot publish or cache the old snapshot', async () => {
  let base;
  const fixtureResult = fixture({ respond: (method, params, defaults) => {
    if (method === 'audit.activity.list') base.generation++;
    return defaults();
  } });
  base = fixtureResult.base;
  await assert.rejects(fixtureResult.service.read(selected), { code: 'STALE' });
  assert.equal(fixtureResult.service.cache.size, 0);
});

test('input allowlist rejects malformed identities and arbitrary RPC options before reads', async () => {
  const { service, calls } = fixture();
  for (const input of [null, [], {}, { ...selected, agentId: '' }, { ...selected, sessionId: 'x\n' },
    { ...selected, cursor: '' }, { ...selected, cursor: 'x'.repeat(8193) }, { ...selected, method: 'chat.send' }]) {
    await assert.rejects(service.read(input), { code: 'INVALID' });
  }
  assert.equal(calls.length, 0);
});

test('current runtime approval references read only four canonical records and expose no presentation secrets', async () => {
  const approvalEvents = Array.from({ length: 6 }, (_, i) => ({ ...event, seq: i + 1, stream: 'item',
    data: { itemId: `item-${i}`, phase: 'end', kind: 'tool', status: 'blocked', approvalId: `approval-${i}` } }));
  const { service, calls } = fixture({ respond: (method, params, defaults) => {
    if (method === 'chat.history') return { ...defaults(), inFlightRun: { runId: 'run-1', events: approvalEvents } };
    if (method === 'approval.get') return { approval: { id: params.id, status: params.id === 'approval-1' ? 'allowed' : 'pending',
      createdAtMs: 1000, expiresAtMs: Date.now() + 60000, sourceSessionKey: params.id === 'approval-2' ? 'another-session' : selected.key,
      presentation: { agentId: 'main', commandText: 'private-command', env: { SECRET: 'fixture-secret' } } } };
    return defaults();
  } });
  const result = await service.read(selected);
  assert.equal(calls.filter(c => c.method === 'approval.get').length, 4);
  assert.equal(result.approvals.length, 3);
  assert.ok(result.approvals.some(a => a.status === 'allowed'));
  assert.ok(result.approvals.every(a => a.runId === 'run-1' && a.sessionId === selected.sessionId));
  assert.ok(!JSON.stringify(result.approvals).includes('private-command'));
  assert.ok(!JSON.stringify(result.approvals).includes('fixture-secret'));
  assert.ok(result.limitations.some(text => text.includes('four')));
});

test('approval verification failures or a run ending before final identity check never become pending approval truth', async () => {
  for (const mode of ['unavailable', 'run-ended']) {
    let descriptions = 0;
    const { service } = fixture({ respond: (method, params, defaults) => {
      if (method === 'sessions.describe' && ++descriptions > 1 && mode === 'run-ended') return { session: { ...row, hasActiveRun: false, activeRunIds: [] } };
      if (method === 'chat.history') return { ...defaults(), inFlightRun: { runId: 'run-1', events: [{ ...event,
        data: { phase: 'result', toolCallId: 'call-1', result: { details: { status: 'approval-pending', approvalId: 'approval-1' } } } }] } };
      if (method === 'approval.get') {
        if (mode === 'unavailable') throw new Error('Not authorized.');
        return { approval: { id: 'approval-1', status: 'pending', expiresAtMs: Date.now() + 60000 } };
      }
      return defaults();
    } });
    assert.deepEqual((await service.read(selected)).approvals, []);
  }
});

test('a selected lifecycle change between refreshes clears previous model enrichment', async t => {
  const originalNow = Date.now;
  let now = 100000, lifecycleRevision = 'life-1';
  Date.now = () => now; t.after(() => { Date.now = originalNow; });
  const { service } = fixture({ respond: (method, params, defaults) => {
    if (method === 'sessions.describe') return { session: { ...row, lifecycleRevision } };
    if (method === 'chat.history') return { ...defaults(), sessionInfo: { ...row, lifecycleRevision } };
    return defaults();
  } });
  const previous = [];
  service.present = async (snapshot, old) => { previous.push(old); return { marker: lifecycleRevision }; };
  await service.read(selected);
  lifecycleRevision = 'life-2'; now += 15001;
  await service.read(selected);
  assert.deepEqual(previous, [undefined, undefined]);
});

test('child history refreshes activity identities in session rows without modifying cached gateway rows', async () => {
  const child = { key: 'agent:builder:child', agentId: 'builder', sessionId: 'child-physical', parentSessionKey: selected.key,
    lifecycleRevision: 'child-life', hasActiveRun: true, activeRunIds: ['previous-run'] };
  const { service } = fixture({ respond: (method, params, defaults) => {
    if (method === 'sessions.list' && params.spawnedBy) return { sessions: [child] };
    if (params.agentId === 'builder' && method === 'chat.history') return { sessionId: child.sessionId,
      sessionInfo: { ...child, activeRunIds: ['current-run'] }, inFlightRun: { runId: 'current-run', events: [{ ...event, runId: 'current-run' }] } };
    if (params.agentId === 'builder' && method === 'sessions.processes.list') return { sessionId: child.sessionId, processes: [] };
    return defaults();
  } });
  const result = await service.read(selected);
  assert.deepEqual(result.sessions.find(s => s.agentId === 'builder').activeRunIds, ['current-run']);
  assert.ok(result.liveEvents.some(event => event.runId === 'current-run'));
  assert.deepEqual(child.activeRunIds, ['previous-run']);
});

test('the default adapter invokes the shared model and never returns raw command arguments', async () => {
  const { service } = fixture({ respond: (method, params, defaults) => {
    if (method === 'chat.history') return { ...defaults(), inFlightRun: { runId: 'run-1', events: [{ ...event,
      data: { ...event.data, args: { command: 'node --test fixture.spec.cjs' } } }] } };
    return defaults();
  } });
  delete service.present;
  const view = await service.read(selected);
  assert.ok(view.summary);
  assert.ok(view.timeline.items.some(item => item.classification === 'engineering'));
  assert.equal(view.liveEvents, undefined);
  assert.ok(!JSON.stringify(view).includes('fixture.spec.cjs'));
});

test('related audit uses one global window, deduplicates and preserves selected-session pagination', async () => {
  const child = { key: 'agent:builder:child', agentId: 'builder', sessionId: 'child-physical', parentSessionKey: selected.key,
    hasActiveRun: false, activeRunIds: [] };
  const childEvent = { ...auditEvent, eventId: 'child-event', agentId: child.agentId, sessionKey: child.key, sessionId: child.sessionId };
  const { service, calls } = fixture({ respond: (method, params, defaults) => {
    if (method === 'sessions.list' && params.spawnedBy) return { sessions: [child] };
    if (method === 'audit.activity.list' && !params.sessionKey) return { events: [auditEvent, childEvent], nextCursor: 'global-cursor-never-paged' };
    if (method === 'audit.activity.list' && params.cursor) return { events: [{ ...auditEvent, eventId: 'older-root' }] };
    return defaults();
  } });
  const first = await service.read(selected);
  assert.equal(calls.filter(c => c.method === 'audit.activity.list').length, 2);
  assert.deepEqual(first.audit.events.map(event => event.eventId), ['audit-1', 'child-event']);
  assert.equal(first.audit.nextCursor, 'older-1');
  assert.ok(first.limitations.some(text => text.includes('selected session only')));
  const count = calls.length;
  const next = await service.read({ ...selected, cursor: first.audit.nextCursor });
  assert.equal(calls.length, count + 1);
  assert.equal(calls.at(-1).params.sessionKey, selected.key);
  assert.deepEqual(next.audit.events.map(event => event.eventId), ['audit-1', 'child-event', 'older-root']);
});
