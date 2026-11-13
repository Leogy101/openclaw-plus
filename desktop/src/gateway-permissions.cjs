'use strict';
const { ReadError } = require('./gateway-cli.cjs');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 1024 && !/[\x00-\x1f\x7f]/u.test(value);
const MODES = new Set(['read-only', 'guarded', 'workspace', 'full']);
const validMode = value => value === null || MODES.has(value);
const fail = (code, message) => { throw new ReadError(code, message); };
const uncertain = () => {
  const error = new ReadError('UNCERTAIN', 'The permission change may already have been saved. Refresh permissions to confirm the current session state before trying again.');
  error.uncertain = true;
  throw error;
};
// Installed OpenClaw docs/gateway/permission-modes.md. These describe native
// session policy, not a separate sandbox or a guarantee about external harnesses.
const CHOICES = [
  { value: null, label: 'Default', description: 'Inherit configured policy. This can allow full access; it does not guarantee restricted execution.' },
  { value: 'read-only', label: 'Read only', description: 'OpenClaw-managed tools can read within the session root; managed mutation tools and exec are denied. Native runtime controls still apply.' },
  { value: 'guarded', label: 'Guarded', description: 'Read and write within the session root. Exec uses the allowlist fast path, then human review for escalation.' },
  { value: 'workspace', label: 'Workspace', description: 'Read and write within the session root. Exec escalation uses LLM review, which can allow, deny or ask a human.' },
  { value: 'full', label: 'Full access', description: 'Broad filesystem and exec access without permission-mode approval prompts. Independent sandbox and tool restrictions still apply. Requires administrator scope.' },
];

function validate(operation, input) {
  const changing = operation === 'setPermissions';
  const fields = ['key', 'agentId', 'sessionId', ...(changing ? ['expectedPermissionMode', 'expectedLifecycleRevision', 'permissionMode'] : [])];
  if (!['permissionOptions', 'setPermissions'].includes(operation) || !object(input) || Object.keys(input).some(key => !fields.includes(key)) ||
      ['key', 'agentId', 'sessionId'].some(key => !identifier(input[key]))) fail('INVALID', 'Select an exact session before reviewing its permissions.');
  if (changing && (!Object.hasOwn(input, 'expectedPermissionMode') || !validMode(input.expectedPermissionMode) ||
      Object.hasOwn(input, 'expectedLifecycleRevision') && !identifier(input.expectedLifecycleRevision) || !Object.hasOwn(input, 'permissionMode') || !validMode(input.permissionMode))) {
    fail('INVALID', 'Review the current permission mode and session revision before applying a change.');
  }
  return { key: input.key, agentId: input.agentId, sessionId: input.sessionId };
}

class PermissionService {
  constructor(base, { isBusy = () => false } = {}) { this.base = base; this.isBusy = isBusy; this.writing = false; }
  async describe(selected, generation) {
    const result = await this.base.read('sessions.describe', { key: selected.key, agentId: selected.agentId }, 0);
    this.base.assertCurrent(generation);
    const row = result?.session;
    if (!object(row) || row.sessionId !== selected.sessionId || row.key !== undefined && row.key !== selected.key ||
        row.agentId !== undefined && row.agentId !== selected.agentId) fail('SESSION_CHANGED', 'This conversation changed. Select it again before changing permissions.');
    if (Object.hasOwn(row, 'lifecycleRevision') && !identifier(row.lifecycleRevision)) fail('UNAVAILABLE', 'OpenClaw returned an unsupported session revision. Refresh permissions before changing them.');
    if (row.permissionMode !== undefined && !validMode(row.permissionMode) ||
        row.permissionModePending !== undefined && typeof row.permissionModePending !== 'boolean' || typeof row.hasActiveRun !== 'boolean') {
      fail('UNAVAILABLE', 'OpenClaw did not provide a supported permission snapshot. Refresh permissions in the original interface.');
    }
    return row;
  }
  present(row, selected, ownWrite = false) {
    return { current: row.permissionMode ?? null, pending: row.permissionModePending === true || (!ownWrite && this.writing) || Boolean(this.isBusy(selected)),
      ...(row.lifecycleRevision !== undefined ? { lifecycleRevision: row.lifecycleRevision } : {}), hasActiveRun: row.hasActiveRun, choices: CHOICES.map(choice => ({ ...choice })), requiresAdminForFull: true };
  }
  async handle(operation, input) {
    const selected = validate(operation, input);
    if (operation === 'permissionOptions') return this.present(await this.describe(selected, this.base.generation), selected);
    if (this.writing || this.isBusy(selected)) fail('BUSY', 'Finish or reconcile the pending session change before changing permissions.');
    this.writing = true;
    let dispatched = false;
    try {
      const generation = this.base.generation;
      const row = await this.describe(selected, generation);
      if (row.lifecycleRevision !== input.expectedLifecycleRevision || (row.permissionMode ?? null) !== input.expectedPermissionMode) {
        fail('CONFLICT', 'The session permissions changed after review. Refresh and review the current mode before applying a change.');
      }
      if (row.permissionModePending === true || this.isBusy(selected)) fail('BUSY', 'A session permission change or another operation is still pending. Refresh before changing permissions.');
      if ((row.permissionMode ?? null) === input.permissionMode) return this.present(row, selected, true);
      this.base.assertCurrent(generation);
      dispatched = true;
      const reply = await this.base.transport.write('sessions.patch', {
        key: selected.key, agentId: selected.agentId, expectedSessionId: selected.sessionId,
        ...(input.expectedLifecycleRevision !== undefined ? { expectedLifecycleRevision: input.expectedLifecycleRevision } : {}), expectedPermissionMode: input.expectedPermissionMode, permissionMode: input.permissionMode,
      });
      this.base.assertCurrent(generation);
      if (reply?.ok !== true || reply.key !== selected.key || reply.entry?.sessionId !== selected.sessionId ||
          (reply.entry?.permissionMode ?? null) !== input.permissionMode ||
          reply.entry?.lifecycleRevision !== undefined && reply.entry.lifecycleRevision !== input.expectedLifecycleRevision) uncertain();
      this.base.invalidate();
      const refreshed = await this.describe(selected, this.base.generation);
      if (refreshed.lifecycleRevision !== input.expectedLifecycleRevision || (refreshed.permissionMode ?? null) !== input.permissionMode || refreshed.permissionModePending === true) uncertain();
      return this.present(refreshed, selected, true);
    } catch (error) {
      if (!dispatched) throw error;
      // Live policy application may fail after persistence. Never report a
      // dispatched error as proof that nothing changed, and never retry here.
      this.base.invalidate();
      uncertain();
    } finally { this.writing = false; }
  }
}
module.exports = { PermissionService, validate };
