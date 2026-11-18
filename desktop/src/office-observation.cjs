'use strict';
const { createHash } = require('node:crypto');

const SESSION_LIMIT = 60, HISTORY_LIMIT = 4, MESSAGE_LIMIT = 24, EVENT_LIMIT = 100;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value && !/[\x00-\x1f\x7f]/u.test(value);
const timestamp = (value, now) => {
  const time = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/u.test(value) && value.length <= 40 ? Date.parse(value) : value;
  return Number.isSafeInteger(time) && time > 0 && time <= now ? time : null;
};
const eventId = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
const parentKey = row => row.parentSessionKey || row.spawnedBy;
const excludedConversation = row => Boolean(parentKey(row) || row.parentSessionId || row.controlOwnerSessionKey || row.isBackground === true ||
  ['cron','heartbeat','subagent','acp','group','channel','global'].includes(row.classification) ||
  ['group','global'].includes(row.kind) || ['group','channel'].includes(row.chatType) ||
  /:(?:cron|subagent|heartbeat):/u.test(row.key));
const directConversation = row => !excludedConversation(row) && (row.kind === 'direct' || row.chatType === 'direct' || ['main','direct'].includes(row.classification));

function runState(row) {
  const ids = row.activeRunIds;
  if (ids !== undefined && (!Array.isArray(ids) || ids.length > 100 || ids.some(value => !id(value)) || new Set(ids).size !== ids.length)) return 'unknown';
  if (row.hasActiveRun === true) return ids?.length === 0 || row.status === 'queued' ? 'unknown' : 'working';
  // Full native rows omit the false descendant aggregate when no subagent exists.
  const descendantsQuiet = row.hasActiveSubagentRun === false || row.hasActiveSubagentRun === undefined &&
    row.rowMode === undefined && !['global','unknown'].includes(row.key) && Array.isArray(ids) && ids.length === 0;
  if (row.hasActiveRun === false && !ids?.length && descendantsQuiet) return 'idle';
  return 'unknown';
}

function historyMatches(history, row) {
  const info = history?.sessionInfo;
  return object(history) && Array.isArray(history.messages) && history.sessionId === row.sessionId && !history.windowReset &&
    (history.sessionKey === undefined || history.sessionKey === row.key) &&
    (info === undefined || object(info) && (info.sessionId === undefined || info.sessionId === row.sessionId) &&
      (info.key === undefined || info.key === row.key) && (info.agentId === undefined || info.agentId === row.agentId)) &&
    (row.lifecycleRevision === undefined || info?.lifecycleRevision === row.lifecycleRevision);
}

// Read-only, bounded observation. Text, task descriptions and session paths never leave this module.
async function readOffice(gateway, normalizeNativeMessage) {
  const generation = gateway.generation;
  const settled = await Promise.allSettled([
    gateway.read('agents.list', {}, 60000),
    gateway.read('sessions.list', { limit: SESSION_LIMIT, offset: 0, archived: 'all', includeGlobal: false, includeUnknown: false, includeDerivedTitles: false }, 15000),
    gateway.read('sessions.list', { activeOnly: true, limit: SESSION_LIMIT, offset: 0, archived: 'all', includeGlobal: false, includeUnknown: false, includeDerivedTitles: false }, 15000),
  ]);
  gateway.assertCurrent(generation);
  const receivedAt = Date.now();
  const roster = settled[0].status === 'fulfilled' ? settled[0].value : null;
  const listing = settled[1].status === 'fulfilled' ? settled[1].value : null;
  const active = settled[2].status === 'fulfilled' ? settled[2].value : null;
  const sampledAt = typeof listing?.ts === 'number' ? timestamp(listing.ts, receivedAt) : null;
  const activeAt = typeof active?.ts === 'number' ? timestamp(active.ts, receivedAt) : null;
  const observedAt = Math.max(sampledAt || 0, activeAt || 0) || receivedAt;
  const listFresh = listing?.ts === undefined || sampledAt !== null && receivedAt - sampledAt <= 45000;
  const activeFresh = activeAt !== null && receivedAt - activeAt <= 45000;
  let limited = !Array.isArray(roster?.agents) || !Array.isArray(listing?.sessions) || listing?.hasMore !== false || !listFresh || !activeFresh || !Array.isArray(active?.sessions);
  const rawAgents = Array.isArray(roster?.agents) ? roster.agents.slice(0, 100) : [];
  if (roster?.agents?.length > 100 || listing?.sessions?.length > SESSION_LIMIT) limited = true;
  const agents = [], agentIds = new Set();
  for (const entry of rawAgents) {
    if (!object(entry) || !id(entry.id) || rawAgents.filter(other => other?.id === entry.id).length !== 1) { limited = true; continue; }
    const name = entry.name || entry.identity?.name || entry.id;
    agents.push({ id: entry.id, name: typeof name === 'string' ? name.replace(/[\x00-\x1f\x7f]/gu, ' ').slice(0, 200) : entry.id, state: 'unknown' });
    agentIds.add(entry.id);
  }
  const ambiguousAgents = new Set();
  const boundedRows = result => {
    const raw = Array.isArray(result?.sessions) ? result.sessions.slice(0, SESSION_LIMIT) : [];
    if (result?.sessions?.length > SESSION_LIMIT) limited = true;
    return raw.filter(row => {
      const valid = object(row) && [row.key,row.sessionId,row.agentId].every(id) && agentIds.has(row.agentId) &&
        raw.filter(other => other?.key === row.key).length === 1 &&
        (row.snapshotAt === undefined || timestamp(row.snapshotAt, receivedAt) !== null);
      if (!valid) { limited = true; if (id(row?.agentId)) ambiguousAgents.add(row.agentId); }
      return valid;
    });
  };
  const recentRows = boundedRows(listing), activeRows = boundedRows(active);
  const byKey = new Map(recentRows.map(row => [row.key,row]));
  for (const row of activeRows) {
    const previous = byKey.get(row.key);
    if (previous && (previous.sessionId !== row.sessionId || previous.agentId !== row.agentId ||
      previous.lifecycleRevision !== undefined && row.lifecycleRevision !== undefined && previous.lifecycleRevision !== row.lifecycleRevision)) {
      ambiguousAgents.add(previous.agentId); ambiguousAgents.add(row.agentId); byKey.delete(row.key); limited = true;
    } else byKey.set(row.key, previous ? {...previous,...row} : row);
  }
  for (const [key,row] of byKey) if (ambiguousAgents.has(row.agentId)) byKey.delete(key);
  const rows = [...byKey.values()];
  const activeComplete = activeFresh && active?.hasMore === false && Array.isArray(active.sessions) && active.sessions.length <= SESSION_LIMIT &&
    activeRows.length === active.sessions.length && Number.isSafeInteger(active.totalCount) && active.totalCount === activeRows.length;
  if (!activeComplete || listing?.totalCount !== undefined && (!Number.isSafeInteger(listing.totalCount) || listing.totalCount > recentRows.length)) limited = true;
  const freshRow = row => row.snapshotAt === undefined || receivedAt - row.snapshotAt <= 45000;
  if (rows.some(row => !freshRow(row))) limited = true;
  for (const agent of agents) {
    const current = activeRows.filter(row => row.agentId === agent.id);
    const currentStates = current.map(row => activeFresh && freshRow(row) ? runState(row) : 'unknown');
    const recentStates = recentRows.filter(row => row.agentId === agent.id).map(row => listFresh && freshRow(row) ? runState(row) : 'unknown');
    const states = activeComplete || current.length ? currentStates : recentStates;
    // Idle means only "No active turn observed" in this bounded subset.
    agent.state = ambiguousAgents.has(agent.id) ? 'unknown' : states.includes('working') ? 'working' :
      (activeComplete || states.length > 0) && states.every(state => state === 'idle') ? 'idle' : 'unknown';
    if (agent.state === 'unknown') limited = true;
  }
  const events = [];
  for (const child of rows) {
    if (!parentKey(child)) continue;
    const parent = byKey.get(parentKey(child)), at = timestamp(child.startedAt, receivedAt);
    if (!parent || child.parentSessionId !== parent.sessionId || parent.agentId === child.agentId || at === null ||
      child.parentSessionKey && child.spawnedBy && child.parentSessionKey !== child.spawnedBy) { limited = true; continue; }
    events.push({ id: eventId('delegation', parent.sessionId, child.sessionId, at), kind: 'delegation', from: parent.agentId, to: child.agentId, at });
  }
  const coordinator = agentIds.has('main') ? 'main' : agentIds.has(roster?.defaultId) ? roster.defaultId : null;
  const recent = [...rows].sort((a,b) => (timestamp(b.updatedAt, receivedAt) || 0) - (timestamp(a.updatedAt, receivedAt) || 0));
  const preferred = recent.find(row => row.agentId === coordinator && directConversation(row)) || recent.find(row => row.agentId === coordinator && !excludedConversation(row));
  const candidates = preferred ? [preferred] : [];
  // Cover likely recipients across agents before taking another conversation for one agent.
  const recipientOrder = [...recent.filter(row => !excludedConversation(row)), ...recent.filter(excludedConversation)];
  for (const row of recipientOrder) if (!candidates.some(other => other.agentId === row.agentId)) candidates.push(row);
  for (const row of recent) if (!candidates.includes(row)) candidates.push(row);
  const selected = candidates.slice(0, HISTORY_LIMIT);
  if (candidates.length > HISTORY_LIMIT) limited = true;
  const histories = await Promise.allSettled(selected.map(row => gateway.read('chat.history', {
    sessionKey: row.key, agentId: row.agentId, limit: MESSAGE_LIMIT, maxBytes: 32768, maxChars: 1, toolResultMaxChars: 1,
  }, 10000)));
  gateway.assertCurrent(generation);
  const historiesReceivedAt = Date.now();
  for (let index = 0; index < selected.length; index++) {
    const row = selected[index], result = histories[index];
    if (result.status !== 'fulfilled' || !historyMatches(result.value, row)) { limited = true; continue; }
    const history = result.value;
    if (history.hasMore === true || history.messages.length > MESSAGE_LIMIT) limited = true;
    const messages = history.messages.slice(-MESSAGE_LIMIT).filter(object).map(message => ({ message, native: normalizeNativeMessage(message) }));
    for (let cursor = 0; cursor < messages.length; cursor++) {
      const { message, native } = messages[cursor], at = timestamp(message.timestamp, historiesReceivedAt);
      if (!native || native.imported || at === null || message.__openclaw?.reason === 'oversized') continue;
      if (messages.filter(entry => entry.native?.id === native.id || entry.native?.sequence === native.sequence).length !== 1) { limited = true; continue; }
      const provenance = message.provenance;
      if (message.role === 'user' && native.provenance === 'inter_session' && ['sessions_send','subagent_announce'].includes(provenance?.sourceTool)) {
        const source = byKey.get(provenance.sourceSessionKey);
        const sourceParent = source && parentKey(source) ? byKey.get(parentKey(source)) : null;
        const start = source && timestamp(source.startedAt, receivedAt);
        // Native sends commonly omit originSessionId. In that case this proves only
        // an agent-to-agent receipt after the observed source start, not run completion.
        const sourceMatches = source && (provenance.originSessionId !== undefined ? provenance.originSessionId === source.sessionId : start !== null && start <= at) &&
          (!parentKey(source) || sourceParent && id(source.parentSessionId) && sourceParent.sessionId === source.parentSessionId &&
            !(source.parentSessionKey && source.spawnedBy && source.parentSessionKey !== source.spawnedBy));
        if (sourceMatches && source.agentId !== row.agentId) {
          events.push({ id: eventId('handoff', row.sessionId, native.id), kind: 'handoff', from: source.agentId, to: row.agentId, at });
        } else limited = true;
      }
      if (row.agentId !== coordinator || excludedConversation(row) || native.terminal !== 'successful' || !id(native.runId) ||
        native.provenance !== undefined && native.provenance !== 'external_user') continue;
      // A terminal turn is not automatically a report to the user: internal wakes and
      // inter-session replies must not be animated as an owner-facing final response.
      const previous = messages.slice(0, cursor).filter(entry => entry.message.role === 'user').at(-1);
      const user = previous?.native;
      if (!user || user.imported || user.sequence >= native.sequence ||
        messages.filter(entry => entry.native?.id === user.id || entry.native?.sequence === user.sequence).length !== 1 ||
        timestamp(previous.message.timestamp, historiesReceivedAt) === null || timestamp(previous.message.timestamp, historiesReceivedAt) > at ||
        !(user.provenance === 'external_user' || user.provenance === undefined && directConversation(row)) ||
        native.replyToId !== undefined && native.replyToId !== user.id ||
        user.runId !== undefined && user.runId !== native.runId ||
        messages.some(entry => entry.native?.runId === native.runId && ['inter_session','internal_system','other'].includes(entry.native?.provenance))) { limited = true; continue; }
      events.push({ id: eventId('report', row.sessionId, native.runId), kind: 'report', from: row.agentId, to: null, at });
    }
  }
  const unique = [...new Map(events.map(event => [event.id,event])).values()].sort((a,b) => a.at - b.at);
  if (unique.length > EVENT_LIMIT) limited = true;
  return { observedAt, agents, events: unique.slice(-EVENT_LIMIT), limited };
}

module.exports = { readOffice };
