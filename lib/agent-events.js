const DEFAULT_DEDUPE_MS = 10_000;
const DEDUPE_WINDOWS = Object.freeze({
  agent_stopped: 10_000,
  waiting_attention: 120_000,
  session_ended: 30_000,
  process_exited: 30_000,
  failed: 30_000,
});

const EVENT_STATE = Object.freeze({
  Stop: 'agent_stopped',
  agent_stop: 'agent_stopped',
  agent_stopped: 'agent_stopped',
  command_complete: 'agent_stopped',
  bell: 'agent_stopped',
  SessionEnd: 'session_ended',
  session_end: 'session_ended',
  session_ended: 'session_ended',
  PermissionRequest: 'waiting_attention',
  permission_wait: 'waiting_attention',
  waiting_attention: 'waiting_attention',
  Notification: 'waiting_attention',
  notification: 'waiting_attention',
  StopFailure: 'failed',
  stop_failure: 'failed',
  failed: 'failed',
  process_exit: 'process_exited',
  process_exited: 'process_exited',
});

const STATE_PRIORITY = Object.freeze({
  session_ended: 50,
  failed: 40,
  waiting_attention: 30,
  agent_stopped: 20,
  process_exited: 10,
});

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function parseWindowIndex(value) {
  if (Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value);
  return null;
}

export function normalizeAgentEvent(input) {
  const raw = asObject(input);
  const tmuxInfo = asObject(raw.tmux || raw.pane || raw.window);
  const hookEventName = firstString(raw.hook_event_name, raw.hookEventName);
  const event = firstString(raw.event, hookEventName, raw.type);
  const state = EVENT_STATE[event] || EVENT_STATE[hookEventName] || EVENT_STATE[firstString(raw.state)] || 'waiting_attention';
  const source = firstString(raw.agent, raw.source, raw.cli, 'agent');
  const session = firstString(raw.session, raw.tmux_session, raw.tmuxSession, tmuxInfo.session, tmuxInfo.tmux_session);
  const windowId = firstString(raw.windowId, raw.window_id, tmuxInfo.windowId, tmuxInfo.window_id);
  const windowIndex = parseWindowIndex(raw.windowIndex ?? raw.window_index ?? tmuxInfo.windowIndex ?? tmuxInfo.window_index);
  const paneId = firstString(raw.paneId, raw.pane_id, tmuxInfo.paneId, tmuxInfo.pane_id);
  const sessionId = firstString(raw.session_id, raw.sessionId);
  const cwd = firstString(raw.cwd);
  const tty = firstString(raw.tty, raw.TTY);
  const command = firstString(raw.prevCommand, raw.command, raw.tool_name, raw.name);
  const reason = firstString(raw.reason, raw.stopReason, raw.message, raw.closeReason);

  return {
    source,
    event: event || state,
    state,
    session,
    windowId,
    windowIndex,
    windowName: firstString(raw.windowName, raw.window_name, tmuxInfo.windowName, tmuxInfo.window_name),
    paneId,
    sessionId,
    cwd,
    tty,
    command,
    reason,
    hookEventName,
    notificationType: firstString(raw.notificationType),
    priority: STATE_PRIORITY[state] || 0,
    timestamp: Date.now(),
  };
}

export function agentEventLocationKey(event) {
  return event.paneId || event.windowId || (
    event.session && event.windowIndex !== null ? `${event.session}:${event.windowIndex}` : ''
  ) || event.sessionId || event.tty || event.cwd || 'unknown';
}

export function agentEventDedupeKey(event) {
  return `${event.state}:${agentEventLocationKey(event)}`;
}

export class AgentEventService {
  constructor({ notificationStore = null, now = () => Date.now() } = {}) {
    this.notificationStore = notificationStore;
    this._now = now;
    this._seen = new Map();
    this._seenLocations = new Map();
  }

  ingest(input, { notify = true } = {}) {
    const event = normalizeAgentEvent(input);
    const now = this._now();
    event.timestamp = now;
    const key = agentEventDedupeKey(event);
    const locationKey = agentEventLocationKey(event);
    const ttl = DEDUPE_WINDOWS[event.state] || DEFAULT_DEDUPE_MS;
    this._prune(now);

    const previous = this._seen.get(key);
    if (previous && now - previous.timestamp < ttl) {
      previous.timestamp = now;
      previous.sources.add(event.source);
      previous.priority = Math.max(previous.priority, event.priority);
      this._seenLocations.set(locationKey, previous);
      return { event, duplicate: true, notification: null };
    }

    const previousLocation = this._seenLocations.get(locationKey);
    if (previousLocation && now - previousLocation.timestamp < ttl && previousLocation.priority >= event.priority) {
      previousLocation.timestamp = now;
      previousLocation.sources.add(event.source);
      return { event, duplicate: true, notification: null };
    }

    const seen = { timestamp: now, sources: new Set([event.source]), priority: event.priority };
    this._seen.set(key, seen);
    this._seenLocations.set(locationKey, seen);

    let notification = null;
    if (notify && this.notificationStore) {
      notification = this.notificationStore.add({
        type: event.notificationType || 'agent-event',
        state: event.state,
        source: event.source,
        event: event.event,
        session: event.session || event.sessionId || event.cwd || event.source,
        windowIndex: event.windowIndex ?? '',
        windowId: event.windowId,
        windowName: event.windowName,
        prevCommand: event.command,
        paneId: event.paneId,
        reason: event.reason,
      });
    }

    return { event, duplicate: false, notification };
  }

  _prune(now) {
    const maxTtl = Math.max(...Object.values(DEDUPE_WINDOWS), DEFAULT_DEDUPE_MS);
    for (const [key, value] of this._seen.entries()) {
      if (now - value.timestamp > maxTtl) this._seen.delete(key);
    }
    for (const [key, value] of this._seenLocations.entries()) {
      if (now - value.timestamp > maxTtl) this._seenLocations.delete(key);
    }
  }
}
