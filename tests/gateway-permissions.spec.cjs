'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { PermissionService } = require('../desktop/src/gateway-permissions.cjs');
const { ReadError } = require('../desktop/src/gateway-cli.cjs');
const selected = { key: 'agent:main:main', agentId: 'main', sessionId: 'physical-main' };
const change = permissionMode => ({ ...selected, expectedPermissionMode: 'guarded', expectedLifecycleRevision: 'life-1', permissionMode });
function fixture({ read, write, isBusy = () => false } = {}) {
  const calls = [], state = { ...selected, lifecycleRevision: 'life-1', permissionMode: 'guarded', hasActiveRun: false };
  let reads = 0;
  const base = {
    generation: 0,
    assertCurrent(generation) { if (generation !== this.generation) throw new ReadError('STALE', 'Connection changed'); },
    invalidate() { this.generation++; },
    async read(method, params, ttl) {
      calls.push({ method, params, ttl }); reads++;
      if (read) return read({ method, params, state, reads, base });
      return { session: { ...state } };
    },
    transport: { async write(method, params) {
      calls.push({ method, params, write: true });
      if (write) return write({ method, params, state, base });
      if (params.permissionMode === null) delete state.permissionMode; else state.permissionMode = params.permissionMode;
      return { ok: true, key: state.key, entry: { ...state } };
    } },
  };
  return { base, state, calls, service: new PermissionService(base, { isBusy }) };
}
const writes = fixture => fixture.calls.filter(call => call.write);

test('permission options are read-only, scoped and include honest Default and native mode descriptions', async () => {
  const f = fixture(); delete f.state.permissionMode;
  const result = await f.service.handle('permissionOptions', selected);
  assert.equal(result.current, null); assert.equal(result.pending, false); assert.equal(result.lifecycleRevision, 'life-1');
  assert.equal(result.requiresAdminForFull, true); assert.equal(result.hasActiveRun, false);
  assert.deepEqual(result.choices.map(choice => choice.value), [null, 'read-only', 'guarded', 'workspace', 'full']);
  assert.match(result.choices[0].description, /can allow full access/); assert.match(result.choices[3].description, /LLM review/);
  assert.deepEqual(f.calls, [{ method: 'sessions.describe', params: { key: selected.key, agentId: 'main' }, ttl: 0 }]);
  result.choices[0].description = 'Caller mutation';
  assert.notEqual((await f.service.handle('permissionOptions', selected)).choices[0].description, 'Caller mutation');
});

test('explicit permission change sends only exact native CAS fields and returns a fresh authoritative snapshot', async () => {
  const f = fixture(); f.state.hasActiveRun = true;
  const result = await f.service.handle('setPermissions', change('workspace'));
  assert.deepEqual(writes(f), [{ method: 'sessions.patch', write: true, params: {
    key: selected.key, agentId: 'main', expectedSessionId: 'physical-main', expectedLifecycleRevision: 'life-1', expectedPermissionMode: 'guarded', permissionMode: 'workspace',
  } }]);
  assert.equal(result.current, 'workspace'); assert.equal(result.pending, false); assert.equal(result.hasActiveRun, true);
  assert.equal(f.calls.filter(call => call.method === 'sessions.describe').length, 2);
  assert.ok(f.calls.filter(call => !call.write).every(call => call.ttl === 0));
});

test('Full is an explicit native mode; clearing it sends null rather than inventing a restrictive default', async () => {
  const f = fixture();
  const full = await f.service.handle('setPermissions', change('full'));
  assert.equal(full.current, 'full'); assert.equal(full.requiresAdminForFull, true);
  const cleared = await f.service.handle('setPermissions', { ...change(null), expectedPermissionMode: 'full' });
  assert.equal(cleared.current, null); assert.equal(writes(f).at(-1).params.permissionMode, null); assert.equal(writes(f).at(-1).params.expectedPermissionMode, 'full');
  assert.equal(Object.hasOwn(f.state, 'permissionMode'), false);
});

test('choosing the observed mode again does not dispatch a policy mutation', async () => {
  const f = fixture(); const result = await f.service.handle('setPermissions', change('guarded'));
  assert.equal(result.current, 'guarded'); assert.equal(result.pending, false); assert.equal(writes(f).length, 0);
});

test('malformed, incomplete and retired-field requests are rejected before reads or writes', async () => {
  const invalid = [null, [], {}, { ...change('full'), expectedPermissionMode: undefined }, { ...change('full'), expectedLifecycleRevision: '' },
    { ...change('root') }, { ...change('full'), expectedPermissionMode: 'root' }, { ...change('full'), sessionId: '' },
    { ...change('full'), agentId: 'main\n' }, { ...change('full'), key: 'x'.repeat(1025) }, { ...change('full'), execAsk: null },
    { ...change('full'), execSecurity: 'full' }, { ...change('full'), sandboxMode: 'off' }, { ...change('full'), nativeRuntimeConsent: 'unrequested' }];
  for (const input of invalid) { const f = fixture(); await assert.rejects(f.service.handle('setPermissions', input), { code: 'INVALID' }); assert.equal(f.calls.length, 0); }
  const f = fixture(); await assert.rejects(f.service.handle('permissionOptions', change('full')), { code: 'INVALID' });
  await assert.rejects(f.service.handle('config.patch', selected), { code: 'INVALID' }); assert.equal(f.calls.length, 0);
});

test('physical, agent, key, lifecycle and observed-mode conflicts never reach sessions.patch', async () => {
  for (const [field, value, code] of [['sessionId', 'replacement', 'SESSION_CHANGED'], ['agentId', 'builder', 'SESSION_CHANGED'], ['key', 'agent:main:other', 'SESSION_CHANGED'], ['lifecycleRevision', 'life-2', 'CONFLICT'], ['permissionMode', 'read-only', 'CONFLICT']]) {
    const f = fixture(); f.state[field] = value;
    await assert.rejects(f.service.handle('setPermissions', change('full')), { code }); assert.equal(writes(f).length, 0);
  }
});

test('malformed present revision or unsupported telemetry cannot become a writable permission snapshot', async () => {
  for (const patch of [{ lifecycleRevision: undefined }, { lifecycleRevision: 'life\n2' }, { permissionMode: 'future-mode' }, { permissionModePending: 'false' }, { hasActiveRun: undefined }]) {
    const f = fixture(); Object.assign(f.state, patch);
    await assert.rejects(f.service.handle('setPermissions', change('full')), { code: 'UNAVAILABLE' }); assert.equal(writes(f).length, 0);
  }
});

test('native omitted revision remains omitted while physical identity and permission-mode CAS remain mandatory', async () => {
  const f = fixture(); delete f.state.lifecycleRevision;
  const options = await f.service.handle('permissionOptions', selected);
  assert.equal(Object.hasOwn(options, 'lifecycleRevision'), false);
  const input = change('workspace'); delete input.expectedLifecycleRevision;
  const result = await f.service.handle('setPermissions', input);
  assert.equal(result.current, 'workspace'); assert.equal(Object.hasOwn(result, 'lifecycleRevision'), false);
  assert.deepEqual(writes(f)[0].params, { key: selected.key, agentId: 'main', expectedSessionId: selected.sessionId, expectedPermissionMode: 'guarded', permissionMode: 'workspace' });
});

test('a revision appearing or disappearing after review conflicts; appearing after dispatch remains uncertain', async () => {
  const absent = change('full'); delete absent.expectedLifecycleRevision;
  const hasRevision = fixture(); await assert.rejects(hasRevision.service.handle('setPermissions', absent), { code: 'CONFLICT' }); assert.equal(writes(hasRevision).length, 0);
  const lostRevision = fixture(); delete lostRevision.state.lifecycleRevision;
  await assert.rejects(lostRevision.service.handle('setPermissions', change('full')), { code: 'CONFLICT' }); assert.equal(writes(lostRevision).length, 0);
  const appeared = fixture({ read: ({ state, reads }) => { if (reads > 1) state.lifecycleRevision = 'newly-reported'; return { session: { ...state } }; } });
  delete appeared.state.lifecycleRevision;
  await assert.rejects(appeared.service.handle('setPermissions', absent), { code: 'UNCERTAIN', uncertain: true }); assert.equal(writes(appeared).length, 1);
  const malformed = fixture(); await assert.rejects(malformed.service.handle('setPermissions', { ...absent, expectedLifecycleRevision: undefined }), { code: 'INVALID' }); assert.equal(malformed.calls.length, 0);
});

test('native pending state and a local busy operation block mutation without hiding the current mode', async () => {
  for (const source of ['native', 'local']) {
    const f = fixture({ isBusy: () => source === 'local' }); if (source === 'native') f.state.permissionModePending = true;
    const options = await f.service.handle('permissionOptions', selected); assert.equal(options.pending, true); assert.equal(options.current, 'guarded');
    await assert.rejects(f.service.handle('setPermissions', change('full')), { code: 'BUSY' }); assert.equal(writes(f).length, 0);
  }
});

test('busy or connection changes during the review read stop before dispatch', async () => {
  let busy = false;
  const local = fixture({ isBusy: () => busy, read: ({ state }) => { busy = true; return { session: { ...state } }; } });
  await assert.rejects(local.service.handle('setPermissions', change('full')), { code: 'BUSY' }); assert.equal(writes(local).length, 0);
  const changed = fixture({ read: ({ state, base }) => { base.invalidate(); return { session: { ...state } }; } });
  await assert.rejects(changed.service.handle('setPermissions', change('full')), { code: 'STALE' }); assert.equal(writes(changed).length, 0);
});

test('concurrent application is blocked and options expose local pending until the first change settles', async () => {
  let release;
  const f = fixture({ write: async ({ state, params }) => { await new Promise(resolve => release = resolve); state.permissionMode = params.permissionMode; return { ok: true, key: state.key, entry: { ...state } }; } });
  const first = f.service.handle('setPermissions', change('workspace'));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(typeof release, 'function');
  await assert.rejects(f.service.handle('setPermissions', change('full')), { code: 'BUSY' });
  assert.equal((await f.service.handle('permissionOptions', selected)).pending, true);
  release(); assert.equal((await first).pending, false); assert.equal(writes(f).length, 1);
});

test('persisted-then-failed application is uncertain, invalidated and reconciled only by a fresh read', async () => {
  const f = fixture({ write: ({ state, params }) => { state.permissionMode = params.permissionMode; throw new ReadError('UNAVAILABLE', 'Saved policy could not be applied to the active runtime'); } });
  await assert.rejects(f.service.handle('setPermissions', change('full')), { code: 'UNCERTAIN', uncertain: true });
  assert.equal(f.service.writing, false); assert.equal(writes(f).length, 1); assert.ok(f.base.generation > 0);
  assert.equal((await f.service.handle('permissionOptions', selected)).current, 'full'); assert.equal(writes(f).length, 1);
});

test('dispatched timeouts, rejections and generation changes are never claimed as a confirmed no-op or retried', async () => {
  for (const code of ['TIMEOUT', 'ACCESS', 'DENIED', 'CONFLICT', 'INVALID', 'UNAVAILABLE']) {
    const f = fixture({ write: () => { throw new ReadError(code, 'Fixture failure'); } });
    await assert.rejects(f.service.handle('setPermissions', change('full')), { code: 'UNCERTAIN', uncertain: true }); assert.equal(writes(f).length, 1); assert.equal(f.service.writing, false);
  }
  const f = fixture({ write: ({ state, params, base }) => { state.permissionMode = params.permissionMode; base.invalidate(); return { ok: true, key: state.key, entry: { ...state } }; } });
  await assert.rejects(f.service.handle('setPermissions', change('full')), { code: 'UNCERTAIN', uncertain: true }); assert.equal(writes(f).length, 1);
});

test('wrong reply identity or mode is uncertain even when the request may have been saved', async () => {
  for (const variant of ['missing', 'key', 'session', 'mode', 'lifecycle', 'ok']) {
    const f = fixture({ write: ({ state, params }) => {
      state.permissionMode = params.permissionMode; const reply = { ok: true, key: state.key, entry: { ...state } };
      if (variant === 'missing') return {};
      if (variant === 'key') reply.key = 'other'; if (variant === 'session') reply.entry.sessionId = 'other';
      if (variant === 'mode') reply.entry.permissionMode = 'read-only'; if (variant === 'lifecycle') reply.entry.lifecycleRevision = 'other';
      if (variant === 'ok') reply.ok = false; return reply;
    } });
    await assert.rejects(f.service.handle('setPermissions', change('full')), { code: 'UNCERTAIN', uncertain: true }); assert.equal(writes(f).length, 1);
  }
});

test('post-write failure, replacement, mode disagreement or continued native pending remains uncertain', async () => {
  for (const variant of ['unavailable', 'session', 'lifecycle', 'mode', 'pending', 'generation']) {
    const f = fixture({ read: ({ state, reads, base }) => {
      if (reads > 1) {
        if (variant === 'unavailable') throw new ReadError('UNAVAILABLE', 'Read unavailable');
        if (variant === 'session') state.sessionId = 'other'; if (variant === 'lifecycle') state.lifecycleRevision = 'life-2';
        if (variant === 'mode') state.permissionMode = 'read-only'; if (variant === 'pending') state.permissionModePending = true;
        if (variant === 'generation') base.invalidate();
      }
      return { session: { ...state } };
    } });
    await assert.rejects(f.service.handle('setPermissions', change('full')), { code: 'UNCERTAIN', uncertain: true }); assert.equal(writes(f).length, 1); assert.equal(f.service.writing, false);
  }
});
