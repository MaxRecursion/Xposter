/**
 * Per-run SSE channel — broadcasts agent progress to the dashboard's
 * live-stream pane. Keeps a small ring buffer so a late subscriber sees
 * recent history rather than only future events.
 */

export interface AgentSseMessage {
  ts: number;          // unix seconds
  kind: 'tool_use' | 'tool_denied' | 'tool_result' | 'assistant_text' | 'status' | 'end';
  text: string;
}

type Subscriber = (msg: AgentSseMessage) => void;

export interface RunChannel {
  runId: string;
  buffer: AgentSseMessage[];
  subscribers: Set<Subscriber>;
  closed: boolean;
  broadcast: (msg: AgentSseMessage) => void;
  subscribe: (cb: Subscriber) => () => void;
  close: () => void;
}

const RING_LIMIT = 200;
const _channels = new Map<string, RunChannel>();

export function getOrCreateChannel(runId: string): RunChannel {
  const existing = _channels.get(runId);
  if (existing) return existing;

  const subscribers = new Set<Subscriber>();
  const buffer: AgentSseMessage[] = [];

  const channel: RunChannel = {
    runId,
    buffer,
    subscribers,
    closed: false,
    broadcast(msg: AgentSseMessage) {
      if (channel.closed) return;
      buffer.push(msg);
      if (buffer.length > RING_LIMIT) buffer.splice(0, buffer.length - RING_LIMIT);
      for (const cb of subscribers) {
        try { cb(msg); } catch { /* ignore subscriber errors */ }
      }
    },
    subscribe(cb: Subscriber) {
      subscribers.add(cb);
      // Replay history first
      for (const msg of buffer) {
        try { cb(msg); } catch { /* ignore */ }
      }
      return () => { subscribers.delete(cb); };
    },
    close() {
      if (channel.closed) return;
      channel.broadcast({ ts: Math.floor(Date.now() / 1000), kind: 'end', text: 'run finished' });
      channel.closed = true;
      // Keep channel around for late subscribers for 60s, then drop it
      setTimeout(() => { _channels.delete(runId); }, 60_000).unref?.();
    },
  };

  _channels.set(runId, channel);
  return channel;
}

export function listActiveRunChannels(): string[] {
  return Array.from(_channels.keys());
}
