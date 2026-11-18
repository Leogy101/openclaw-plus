import { createOfficeScene } from './office-scene.mjs';
import { BOSS_NAME, OFFICE_CAST } from '../shared/office-cast.mjs';

const FRESH_MS = 45_000;
const MAX_QUEUE = 10;
const labels = { working: 'Working', idle: 'No active turn observed', unknown: 'Activity unknown' };
const eventLabels = { delegation: 'Task delegated', handoff: 'Handoff recorded', report: 'Final reply recorded' };
const eventIcons = {
  delegation: '<path d="M4 12h15m-6-6 6 6-6 6M4 5v14"/>',
  handoff: '<path d="M4 8h15m-4-4 4 4-4 4M20 16H5m4-4-4 4 4 4"/>',
  report: '<path d="M6 3h9l4 4v14H6zM14 3v5h5M9 12h7m-7 4h7"/>',
};

function officeSnapshot(result) {
  const observed = new Map(result.agents.map(agent => [agent.id, agent.state]));
  const reported = new Set(OFFICE_CAST.filter(agent => observed.has(agent.id)).map(agent => agent.id));
  return {
    ...result,
    agents: OFFICE_CAST.map(agent => ({ ...agent, state: observed.get(agent.id) ?? 'unknown' })),
    events: result.events.filter(event => {
      if (!reported.has(event.from)) return false;
      if (event.kind === 'report') return event.from === 'main' && event.to === null;
      return ['delegation', 'handoff'].includes(event.kind) && event.from !== event.to && reported.has(event.to);
    }),
  };
}

export function createOfficeView({ container, read, connected }) {
  container.innerHTML = `<section class="office-page" aria-labelledby="office-title">
    <header class="office-heading">
      <div><h2 id="office-title">GlauxOS Office</h2></div>
      <span class="office-connection" role="status" data-state="loading">Connecting</span>
    </header>
    <figure class="office-stage" aria-label="Pixel art office with two private rooms, three shared desks, a coffee station and a water cooler">
      <canvas class="office-canvas" aria-hidden="true"></canvas>
      <figcaption class="office-status" data-kind="none" data-animating="false" aria-live="polite" aria-atomic="true">
        <span class="office-event-icon" aria-hidden="true"><svg viewBox="0 0 24 24"></svg></span>
        <span class="office-event-copy"><strong></strong><p></p></span>
        <time hidden></time>
      </figcaption>
    </figure>
    <ul class="office-roster" aria-label="Office roster"></ul>
    <p class="office-note">The office follows recent OpenClaw sessions. Recorded handoffs and final replies appear as visits between offices.</p>
  </section>`;
  const connection = container.querySelector('.office-connection');
  const status = container.querySelector('.office-status');
  const roster = container.querySelector('.office-roster');
  const canvas = container.querySelector('.office-canvas');
  const scene = createOfficeScene(canvas);
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  let online = connected;
  let closed = false;
  let busy = false;
  let failed = false;
  let epoch = 0;
  let since = Date.now();
  let snapshot = null;
  let lastEvent = null;
  let current = null;
  let agents = [];
  let frame = 0;
  let expiry = 0;
  let lastDraw = 0;
  const queue = [];
  const seen = new Map();

  function fresh() {
    return online && !failed && snapshot && Date.now() < snapshot.observedAt + FRESH_MS;
  }

  function discardMotion() {
    current = null;
    queue.length = 0;
    cancelAnimationFrame(frame);
    frame = 0;
  }

  function paint(timeMs = performance.now()) {
    scene.draw({ agents, event: current?.event, elapsedMs: current ? timeMs - current.started : 0, timeMs, reducedMotion: motion.matches,
      theme: document.documentElement.dataset.theme });
  }

  function showEvent() {
    const event = current?.event ?? lastEvent;
    const kind = event?.kind || 'none';
    const from = agents.find(agent => agent.id === event?.from);
    const to = agents.find(agent => agent.id === event?.to);
    const route = from && (to || kind === 'report') ? `${from.name} → ${to?.name || BOSS_NAME}` : '';
    const title = route || (fresh() ? 'Watching the office' : 'Office activity unavailable');
    const detail = route ? eventLabels[kind] : fresh() ? 'Waiting for a recorded handoff or final reply.' : 'Activity appears when OpenClaw supplies a current observation.';
    const key = JSON.stringify([kind, title, detail, event?.at, Boolean(current)]);
    if (status.dataset.eventKey === key) return;
    status.dataset.eventKey = key;
    status.dataset.kind = route ? kind : 'none';
    status.dataset.animating = String(Boolean(current));
    status.querySelector('svg').innerHTML = route ? eventIcons[kind] : '<path d="M3 12h5l2-5 4 10 2-5h5"/>';
    status.querySelector('strong').textContent = title;
    status.querySelector('p').textContent = detail;
    const time = status.querySelector('time');
    time.hidden = !route;
    time.textContent = route ? timeFormat.format(event.at) : '';
    time.dateTime = route ? new Date(event.at).toISOString() : '';
  }

  function render() {
    const live = Boolean(fresh());
    agents = (snapshot?.agents || OFFICE_CAST).map(agent => live ? agent : { ...agent, state: 'unknown' });
    const state = !online ? 'offline' : live ? 'live' : failed || snapshot ? 'stale' : 'loading';
    const label = { offline: 'Disconnected', live: 'Live observation', stale: 'Observation unavailable', loading: 'Reading activity' }[state];
    connection.dataset.state = state;
    if (connection.textContent !== label) connection.textContent = label;
    const rows = JSON.stringify(agents);
    if (roster.dataset.rows !== rows) {
      roster.dataset.rows = rows;
      const cast = [{ name: BOSS_NAME, state: 'owner' }, ...agents];
      roster.replaceChildren(...cast.map(person => {
        const row = document.createElement('li');
        row.className = person.state === 'owner' ? 'office-owner' : 'office-agent';
        row.dataset.state = person.state;
        const name = document.createElement('strong');
        name.textContent = person.name;
        const summary = document.createElement('span');
        summary.textContent = person.state === 'owner' ? 'Private office' : labels[person.state];
        row.append(name, summary);
        return row;
      }));
    }
    container.querySelector('.office-note').textContent = snapshot?.limited
      ? 'OpenClaw returned a partial view. Some active turns or handoffs may be outside the sampled sessions.'
      : 'The office follows recent OpenClaw sessions. Recorded handoffs and final replies appear as visits between offices.';
    showEvent();
    paint();
  }

  function tick(now) {
    frame = 0;
    if (closed || document.hidden || !fresh()) return;
    if (current && now - current.started >= current.duration) current = null;
    if (!current && queue.length) {
      const event = queue.shift();
      lastEvent = event;
      current = { event, started: now, duration: motion.matches ? 2200 : scene.duration(event, agents, now) };
    }
    showEvent();
    if (now - lastDraw >= 65) {
      lastDraw = now;
      paint(now);
    }
    if (current || queue.length || !motion.matches && agents.some(agent => agent.state === 'working' || agent.state === 'idle')) frame = requestAnimationFrame(tick);
    else paint();
  }

  function redraw() {
    clearTimeout(expiry);
    if (!fresh()) discardMotion();
    render();
    if (fresh()) {
      if (!frame && !document.hidden) frame = requestAnimationFrame(tick);
      expiry = setTimeout(redraw, Math.max(1, snapshot.observedAt + FRESH_MS - Date.now()));
    }
  }

  async function refresh() {
    if (closed || !online || busy || document.hidden) return;
    const generation = epoch;
    busy = true;
    try {
      const result = await read();
      if (generation !== epoch || closed) return;
      failed = false;
      snapshot = officeSnapshot(result);
      const events = snapshot.events.sort((a, b) => a.at - b.at);
      if (!lastEvent && events.length) lastEvent = events.at(-1);
      const now = Date.now();
      for (const [id, at] of seen) if (at <= now - 2 * FRESH_MS) seen.delete(id);
      for (const event of events) {
        if (seen.has(event.id)) continue;
        seen.set(event.id, event.at);
        if (event.at > since && event.at > now - FRESH_MS && fresh()) queue.push(event);
      }
      if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
    } catch {
      if (generation === epoch && !closed) failed = true;
    } finally {
      if (generation === epoch && !closed) {
        busy = false;
        redraw();
      }
    }
  }

  function setConnected(value) {
    if (online === value) return;
    online = value;
    resetObservation();
    if (online) refresh();
  }

  function resetObservation() {
    epoch++;
    busy = false;
    failed = true;
    since = Date.now();
    discardMotion();
    redraw();
  }

  function onVisibility() {
    resetObservation();
    if (!document.hidden) refresh();
  }

  const resize = new ResizeObserver(() => paint());
  resize.observe(canvas.parentElement);
  document.addEventListener('visibilitychange', onVisibility);
  motion.addEventListener('change', redraw);
  redraw();
  refresh();

  return {
    refresh,
    setConnected,
    themeChanged: redraw,
    close() {
      closed = true;
      clearTimeout(expiry);
      discardMotion();
      resize.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      motion.removeEventListener('change', redraw);
    },
  };
}
