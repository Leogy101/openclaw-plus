'use strict';
const { ReadError } = require('./gateway-cli.cjs');
const { attachmentContext } = require('./attachments.cjs');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const str = (value, max = 1024) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value);
const fail = (code, message) => { throw new ReadError(code, message); };
const levels = value => Array.isArray(value) ? value.filter(item => object(item) && str(item.id,80) && str(item.label,120)).slice(0,20).map(({id,label}) => ({id,label})) : [];
class ComposerActions {
  constructor(base, { isBusy = () => false } = {}) { this.base = base; this.isBusy = isBusy; this.writing = false; }
  async handle(operation, input) {
    const fields = ['key','agentId','sessionId', ...(operation === 'setComposer' ? ['model','thinkingLevel'] : [])];
    if (!['composerOptions','setComposer'].includes(operation) || !object(input) || Object.keys(input).some(key => !fields.includes(key))) fail('INVALID','Invalid composer settings request.');
    const selected = attachmentContext(input);
    if (operation === 'composerOptions') return this.options(selected);
    const patch = {};
    for (const field of ['model','thinkingLevel']) if (Object.hasOwn(input,field)) {
      if (input[field] !== null && !str(input[field],field === 'model' ? 512 : 80)) fail('INVALID','Choose an advertised model or reasoning level.');
      patch[field] = input[field];
    }
    if (!Object.keys(patch).length) fail('INVALID','Choose a model or reasoning level first.');
    if (this.writing || this.isBusy(selected)) fail('BUSY','Finish or reconcile the pending change before changing this session’s model.');
    this.writing = true;
    try {
      const generation = this.base.generation;
      const current = await this.options(selected, true);
      if (Object.hasOwn(patch,'model') && current.modelSelectionLocked) fail('INVALID','OpenClaw has locked model selection for this session.');
      const chosen = patch.model === undefined ? current.models.find(model => model.value === current.current.model) :
        patch.model === null ? null : current.models.find(model => model.value === patch.model);
      if (typeof patch.model === 'string' && (!chosen || chosen.available === false || chosen.manualSelectionAllowed === false)) fail('INVALID','That model is not currently available for this session.');
      if (typeof patch.thinkingLevel === 'string') {
        const allowed = chosen?.thinkingLevels || current.thinkingLevels;
        if (!allowed.some(level => level.id === patch.thinkingLevel)) fail('INVALID','That reasoning level is not advertised for the selected model.');
      }
      const row = await this.describe(selected, generation);
      if (row.lifecycleRevision !== current.lifecycleRevision || this.isBusy(selected)) fail('STALE','The session changed while its settings were being reviewed. Refresh the controls.');
      const params = { key: selected.key, agentId: selected.agentId, expectedSessionId: selected.sessionId,
        ...(str(row.lifecycleRevision) ? { expectedLifecycleRevision: row.lifecycleRevision } : {}), ...patch };
      let reply;
      try {
        reply = await this.base.transport.write('sessions.patch',params);
        this.base.assertCurrent(generation);
        if (reply?.ok !== true || reply.key !== selected.key || reply.entry?.sessionId !== selected.sessionId) fail('UNCERTAIN','The model change was not confirmed. Refresh its current settings before trying again.');
      } catch (error) {
        this.base.invalidate();
        if (['INVALID','ACCESS','DENIED','CONFLICT'].includes(error.code)) throw error;
        fail('UNCERTAIN','The model change may already have applied. Refresh its current settings before trying again.');
      }
      this.base.invalidate();
      try { return await this.options(selected, true); }
      catch { fail('UNCERTAIN','OpenClaw accepted the change, but the current model could not be reread. Refresh the controls.'); }
    } finally { this.writing = false; }
  }
  async describe(selected, generation) {
    const result = await this.base.read('sessions.describe',{key:selected.key,agentId:selected.agentId},0);
    this.base.assertCurrent(generation);
    const row = result?.session;
    if (!object(row) || row.sessionId !== selected.sessionId || row.agentId !== undefined && row.agentId !== selected.agentId || row.key !== undefined && row.key !== selected.key) fail('SESSION_CHANGED','This session changed. Select it again before changing its model.');
    return row;
  }
  async options(selected, fresh = false) {
    const generation = this.base.generation, before = await this.describe(selected,generation);
    const catalog = await this.base.read('models.list',{agentId:selected.agentId,sessionKey:selected.key,view:'default',preparedOnly:true,includeDetails:true},fresh ? 0 : 60000);
    this.base.assertCurrent(generation);
    const after = await this.describe(selected,generation);
    if (before.lifecycleRevision !== after.lifecycleRevision) fail('SESSION_CHANGED','The session changed while model options were loading. Refresh the controls.');
    const models = (Array.isArray(catalog?.models) ? catalog.models : []).filter(item => object(item) && str(item.id,512) && str(item.provider,128)).slice(0,1000).map(item => ({
      value: `${item.provider}/${item.id}`, label: str(item.name,200) ? item.name : item.id,
      ...(typeof item.available === 'boolean' ? { available:item.available } : {}),
      ...(typeof item.manualSelectionAllowed === 'boolean' ? { manualSelectionAllowed:item.manualSelectionAllowed } : {}),
      thinkingLevels: levels(item.thinkingLevels), thinkingDefault: str(item.thinkingDefault,80) ? item.thinkingDefault : null,
      input: Array.isArray(item.input) ? item.input.filter(value => ['text','image','audio','video','document'].includes(value)) : [],
    }));
    return { models, current: { model: str(after.modelProvider,128) && str(after.model,512) ? `${after.modelProvider}/${after.model}` : null,
      thinkingLevel: str(after.thinkingLevel,80) ? after.thinkingLevel : str(after.thinkingDefault,80) ? after.thinkingDefault : null },
      thinkingLevels: levels(after.thinkingLevels), modelSelectionLocked: after.modelSelectionLocked === true,
      lifecycleRevision: after.lifecycleRevision, sessionModelRevision: after.sessionModelRevision,
      limitations: [...(!models.length ? ['Prepared model choices are unavailable. Use the original interface to configure providers.'] : []),
        'Model and reasoning changes apply to this session. OpenClaw controls availability and runtime support.'] };
  }
}
module.exports = { ComposerActions };
